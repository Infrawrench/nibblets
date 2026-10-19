import { BankError, deriveWalletKey } from "@nibblet/bank";
import { hex } from "@scure/base";
import { Address, OutScript, p2wpkh, TEST_NETWORK, Transaction, WIF } from "@scure/btc-signer";
import { pubECDSA } from "@scure/btc-signer/utils.js";
import { describe, expect, it } from "vitest";
import { bitcoin, bitcoinPlugin, Esplora, MIN_CARD_SATS } from "./index.ts";

const regtest = { ...TEST_NETWORK, bech32: "bcrt" };
const treasuryKey = new Uint8Array(32).fill(9);
const treasury = p2wpkh(pubECDSA(treasuryKey), regtest);

interface Coin {
  txid: string;
  vout: number;
  value: number;
  script: string;
  spent: boolean;
}

/**
 * An Esplora over an in-memory UTXO set: broadcasts are parsed, checked to
 * spend coins that exist, and applied.
 */
function fakeChain() {
  const coins: Coin[] = [];
  const broadcasts: Transaction[] = [];
  const scriptOf = (address: string) =>
    hex.encode(OutScript.encode(Address(regtest).decode(address)));
  const fund = (address: string, value: number) =>
    coins.push({
      txid: hex.encode(crypto.getRandomValues(new Uint8Array(32))),
      vout: 0,
      value,
      script: scriptOf(address),
      spent: false,
    });
  const json = (body: unknown) => new Response(JSON.stringify(body));
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname.replace(/^\/api/, "");
    if (path === "/tx" && init?.method === "POST") {
      const tx = Transaction.fromRaw(hex.decode(String(init.body)));
      for (let i = 0; i < tx.inputsLength; i++) {
        const input = tx.getInput(i);
        const txid = input.txid ? hex.encode(input.txid) : "";
        const coin = coins.find((c) => c.txid === txid && c.vout === input.index && !c.spent);
        if (!coin) return new Response("bad-txns-inputs-missingorspent", { status: 400 });
        coin.spent = true;
      }
      for (let i = 0; i < tx.outputsLength; i++) {
        const out = tx.getOutput(i);
        coins.push({
          txid: tx.id,
          vout: i,
          value: Number(out.amount ?? 0n),
          script: out.script ? hex.encode(out.script) : "",
          spent: false,
        });
      }
      broadcasts.push(tx);
      return new Response(tx.id);
    }
    if (path === "/fee-estimates") return json({ "1": 20.5, "3": 10.2, "6": 5 });
    const utxo = /^\/address\/([^/]+)\/utxo$/.exec(path);
    if (utxo?.[1]) {
      const script = scriptOf(utxo[1]);
      return json(
        coins
          .filter((c) => c.script === script && !c.spent)
          .map((c) => ({ txid: c.txid, vout: c.vout, value: c.value, status: {} })),
      );
    }
    const address = /^\/address\/([^/]+)$/.exec(path);
    if (address?.[1]) {
      const mine = coins.filter((c) => c.script === scriptOf(address[1] ?? ""));
      const sum = (list: Coin[]) => list.reduce((s, c) => s + c.value, 0);
      return json({
        chain_stats: { funded_txo_sum: sum(mine), spent_txo_sum: sum(mine.filter((c) => c.spent)) },
        mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 },
      });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch, coins, broadcasts, fund };
}

function setUp() {
  const chain = fakeChain();
  chain.fund(treasury.address ?? "", 1_000_000);
  const plugin = bitcoinPlugin({
    treasuryKey,
    network: "regtest",
    esplora: new Esplora("http://esplora/api", chain.fetch),
  });
  return { chain, plugin };
}

const request = {
  cardId: "card_1",
  nibbletId: "nib_1",
  label: "x",
  kind: "multi_use" as const,
  limit: 100_000n,
};

describe("bitcoin", () => {
  it("funds a fresh wallet with exactly the limit, from the treasury", async () => {
    const { chain, plugin } = setUp();
    const card = await plugin.issue(request);
    const key = deriveWalletKey(treasuryKey, "bitcoin", "card_1");
    const address = p2wpkh(pubECDSA(key), regtest).address;
    expect(card.ref).toBe(address);
    expect(card.secret).toEqual({
      type: "wallet",
      chain: "bitcoin",
      network: "regtest",
      address,
      privateKey: hex.encode(key),
      wif: WIF(regtest).encode(key),
    });
    const [tx] = chain.broadcasts;
    const outputs = Array.from({ length: tx?.outputsLength ?? 0 }, (_, i) => tx?.getOutput(i));
    const toCard = outputs.find((o) => o?.amount === 100_000n);
    expect(toCard).toBeTruthy();
    // The rest comes back as change, less a fee at the estimated rate.
    const change = outputs.find((o) => o?.amount !== 100_000n)?.amount ?? 0n;
    expect(1_000_000n - 100_000n - change).toBeGreaterThan(0n);
    expect(1_000_000n - 100_000n - change).toBeLessThan(5_000n);
    expect(await plugin.balance()).toBe(change);
  });

  it("gives the same key back for a restarted container", async () => {
    const { plugin } = setUp();
    const card = await plugin.issue(request);
    const ref = { id: "card_1", ref: card.ref, kind: "multi_use" as const, limit: 100_000n };
    expect(await plugin.reveal(ref)).toEqual(card.secret);
  });

  it("refuses a card too small to use, or bigger than the treasury", async () => {
    const { plugin } = setUp();
    await expect(plugin.issue({ ...request, limit: MIN_CARD_SATS - 1n })).rejects.toThrow(
      /at least/,
    );
    await expect(plugin.issue({ ...request, limit: 2_000_000n })).rejects.toThrow(
      /doesn't have enough/,
    );
  });

  it("counts nothing spent until the wallet sends, then what's gone", async () => {
    const { chain, plugin } = setUp();
    const card = await plugin.issue(request);
    const ref = { id: "card_1", ref: card.ref, kind: "single_use" as const, limit: 100_000n };
    expect(await plugin.inspect(ref)).toEqual({ open: true, spent: 0n, used: false });
    // The nibblet pays a shop 30,000 sats, with 70,000 less a fee back as change.
    const funding = chain.coins.find((c) => c.value === 100_000 && !c.spent);
    if (!funding) throw new Error("no funding coin");
    funding.spent = true;
    chain.fund(card.ref, 69_000);
    expect(await plugin.inspect(ref)).toEqual({ open: true, spent: 31_000n, used: true });
  });

  it("sweeps what's left back to the treasury when it's killed", async () => {
    const { chain, plugin } = setUp();
    const card = await plugin.issue(request);
    const ref = { id: "card_1", ref: card.ref, kind: "multi_use" as const, limit: 100_000n };
    const before = await plugin.balance();
    const closed = await plugin.close(ref);
    const sweep = chain.broadcasts.at(-1);
    expect(sweep?.outputsLength).toBe(1);
    expect(sweep?.getOutput(0).script).toEqual(treasury.script);
    const returned = sweep?.getOutput(0).amount ?? 0n;
    expect(returned).toBe(100_000n - 110n * 11n);
    // The sweep's fee is all that went.
    expect(closed).toEqual({ open: false, spent: 100_000n - returned, used: false, settled: true });
    expect(await plugin.balance()).toBe((before ?? 0n) + returned);
    // An empty wallet has nothing to sweep.
    expect(await plugin.close(ref)).toEqual({
      open: false,
      spent: 100_000n,
      used: true,
      settled: true,
    });
  });

  it("finds a wallet once it's been funded, and not before", async () => {
    const { plugin } = setUp();
    expect(await plugin.find("card_1")).toBeNull();
    const card = await plugin.issue(request);
    expect(await plugin.find("card_1")).toEqual({ ref: card.ref, display: card.ref });
  });

  it("won't settle a wallet whose funding isn't seen yet", async () => {
    const { chain, plugin } = setUp();
    const key = deriveWalletKey(treasuryKey, "bitcoin", "card_2");
    const address = p2wpkh(pubECDSA(key), regtest).address ?? "";
    const ref = { id: "card_2", ref: address, kind: "multi_use" as const, limit: 100_000n };
    expect(await plugin.close(ref)).toEqual({
      open: false,
      spent: 0n,
      used: false,
      settled: false,
    });
    // Once it shows up, closing sweeps it.
    chain.fund(address, 100_000);
    expect(await plugin.close(ref)).toMatchObject({ settled: true, used: false });
    expect(chain.broadcasts.at(-1)?.getOutput(0).script).toEqual(treasury.script);
  });

  it("refuses with messages that are safe to show", async () => {
    const { plugin } = setUp();
    const err = await plugin.issue({ ...request, limit: 2_000_000n }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BankError);
  });

  it("turns on from its settings, and refuses wrong ones", () => {
    const deps = { fetch: globalThis.fetch, log: () => {} };
    const key = hex.encode(treasuryKey);
    expect(bitcoin.fromEnv({}, deps)).toBeNull();
    expect(() => bitcoin.fromEnv({ BITCOIN_TREASURY_KEY: key }, deps)).toThrow(/BITCOIN_NETWORK/);
    expect(
      bitcoin.fromEnv({ BITCOIN_TREASURY_KEY: key, BITCOIN_NETWORK: "signet" }, deps)?.label,
    ).toBe("Bitcoin (signet)");
    expect(() =>
      bitcoin.fromEnv({ BITCOIN_TREASURY_KEY: key, BITCOIN_NETWORK: "regtest" }, deps),
    ).toThrow(/BITCOIN_ESPLORA_URL/);
    expect(() =>
      bitcoin.fromEnv({ BITCOIN_TREASURY_KEY: "nope", BITCOIN_NETWORK: "mainnet" }, deps),
    ).toThrow(/isn't a hex or mainnet WIF/);
    const wif = WIF(TEST_NETWORK).encode(treasuryKey);
    expect(
      bitcoin.fromEnv({ BITCOIN_TREASURY_KEY: wif, BITCOIN_NETWORK: "testnet" }, deps)?.id,
    ).toBe("bitcoin");
  });
});
