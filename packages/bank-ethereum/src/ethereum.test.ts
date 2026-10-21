import { BankError, deriveWalletKey } from "@nibblets/bank";
import { custom, isAddress, isHex, parseTransaction, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { ethereum, ethereumPlugin, viemClient, type EvmClient } from "./index.ts";

const treasuryKey = new Uint8Array(32).fill(5);
const treasuryHex: Hex = `0x${Buffer.from(treasuryKey).toString("hex")}`;
const treasury = privateKeyToAccount(treasuryHex).address;
const GWEI = 10n ** 9n;
const ETH = 10n ** 18n;

function address(text: string): Address {
  if (!isAddress(text)) throw new Error(`${text} isn't an address`);
  return text;
}

function hex(text: string): Hex {
  if (!isHex(text)) throw new Error(`${text} isn't hex`);
  return text;
}

/** A chain of plain accounts, with gas at a fixed price. */
class FakeChain implements EvmClient {
  readonly balances = new Map<string, bigint>();
  readonly nonces = new Map<string, number>();
  readonly sent: { from: Address; to: Address; value: bigint }[] = [];
  id = 11155111;
  price = 2n * GWEI;

  async chainId() {
    return this.id;
  }
  async balance(address: Address) {
    return this.balances.get(address) ?? 0n;
  }
  async nonce(address: Address) {
    return this.nonces.get(address) ?? 0;
  }
  async gasPrice() {
    return this.price;
  }
  async transfer(key: Hex, to: Address, value: bigint, gasPrice: bigint) {
    const from = privateKeyToAccount(key).address;
    const cost = value + 21_000n * gasPrice;
    const have = await this.balance(from);
    if (have < cost) throw new Error("insufficient funds");
    this.balances.set(from, have - cost);
    this.balances.set(to, (await this.balance(to)) + value);
    this.nonces.set(from, (await this.nonce(from)) + 1);
    this.sent.push({ from, to, value });
    return hex("0xabc");
  }
}

function setUp(opts: { chainId?: number } = {}) {
  const chain = new FakeChain();
  chain.balances.set(treasury, 10n * ETH);
  return { chain, plugin: ethereumPlugin({ treasuryKey, client: chain, ...opts }) };
}

const request = {
  cardId: "card_1",
  nibbletId: "nib_1",
  label: "x",
  kind: "multi_use" as const,
  limit: ETH / 10n,
};

describe("ethereum", () => {
  it("funds a fresh account with exactly the limit", async () => {
    const { chain, plugin } = setUp();
    const card = await plugin.issue(request);
    const key = hex(
      `0x${Buffer.from(deriveWalletKey(treasuryKey, "ethereum", "card_1")).toString("hex")}`,
    );
    const address = privateKeyToAccount(key).address;
    expect(card).toEqual({
      ref: address,
      display: address,
      secret: {
        type: "wallet",
        chain: "ethereum",
        network: "11155111",
        address,
        privateKey: key,
        wif: null,
      },
    });
    expect(chain.sent).toEqual([{ from: treasury, to: address, value: ETH / 10n }]);
    expect(
      await plugin.reveal({ id: "card_1", ref: address, kind: "multi_use", limit: 1n }),
    ).toEqual(card.secret);
  });

  it("refuses a card the treasury can't fund with its gas", async () => {
    const { plugin } = setUp();
    await expect(plugin.issue({ ...request, limit: 10n * ETH })).rejects.toThrow(
      /doesn't have enough/,
    );
  });

  it("refuses to work on another chain than it was set up for", async () => {
    const { plugin } = setUp({ chainId: 1 });
    await expect(plugin.issue(request)).rejects.toThrow("The RPC is on chain 11155111, not 1");
  });

  it("counts spending once the account has sent, and sweeps the rest back", async () => {
    const { chain, plugin } = setUp();
    const card = await plugin.issue(request);
    const ref = { id: "card_1", ref: card.ref, kind: "multi_use" as const, limit: ETH / 10n };
    expect(await plugin.inspect(ref)).toEqual({ open: true, spent: 0n, used: false });
    // The nibblet pays someone 0.03 ETH, plus gas.
    const key = hex(card.secret.type === "wallet" ? card.secret.privateKey : "");
    const shop = address("0x000000000000000000000000000000000000dEaD");
    await chain.transfer(key, shop, 3n * 10n ** 16n, chain.price);
    const paid = 3n * 10n ** 16n + 21_000n * chain.price;
    expect(await plugin.inspect(ref)).toEqual({ open: true, spent: paid, used: true });

    const before = await chain.balance(treasury);
    const closed = await plugin.close(ref);
    const sweepFee = 21_000n * chain.price;
    expect(await chain.balance(address(card.ref))).toBe(0n);
    expect(await chain.balance(treasury)).toBe(before + ETH / 10n - paid - sweepFee);
    expect(closed).toEqual({ open: false, spent: paid + sweepFee, used: true, settled: true });
  });

  it("leaves dust it can't pay gas to move", async () => {
    const { chain, plugin } = setUp();
    const card = await plugin.issue({ ...request, limit: 1000n });
    const ref = { id: "card_1", ref: card.ref, kind: "multi_use" as const, limit: 1000n };
    const sends = chain.sent.length;
    expect(await plugin.close(ref)).toEqual({
      open: false,
      spent: 1000n,
      used: false,
      settled: true,
    });
    expect(chain.sent.length).toBe(sends);
  });

  it("finds a funded account, and won't settle one whose funding isn't seen", async () => {
    const { chain, plugin } = setUp();
    expect(await plugin.find("card_1")).toBeNull();
    const card = await plugin.issue(request);
    expect(await plugin.find("card_1")).toEqual({ ref: card.ref, display: card.ref });
    const unseen = { id: "card_2", ref: "", kind: "multi_use" as const, limit: ETH / 10n };
    const sends = chain.sent.length;
    expect(await plugin.close(unseen)).toEqual({
      open: false,
      spent: 0n,
      used: false,
      settled: false,
    });
    expect(chain.sent.length).toBe(sends);
  });

  it("refuses with messages that are safe to show", async () => {
    const { plugin } = setUp({ chainId: 1 });
    const err = await plugin.issue(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BankError);
  });

  it("signs real transfers through viem", async () => {
    const raw: Hex[] = [];
    const client = viemClient(
      custom({
        async request({ method, params }: { method: string; params?: unknown }) {
          switch (method) {
            case "eth_chainId":
              return "0xaa36a7";
            case "eth_getTransactionCount":
              return "0x7";
            case "eth_gasPrice":
              return "0x77359400";
            case "eth_getBalance":
              return "0xde0b6b3a7640000";
            case "eth_sendRawTransaction": {
              const [tx] = Array.isArray(params) ? params : [];
              if (typeof tx !== "string") throw new Error("no tx");
              raw.push(hex(tx));
              return "0x1234";
            }
            default:
              throw new Error(`unexpected ${method}`);
          }
        },
      }),
    );
    expect(await client.chainId()).toBe(11155111);
    expect(await client.balance(treasury)).toBe(ETH);
    const to = address("0x000000000000000000000000000000000000dEaD");
    await client.transfer(treasuryHex, to, 12345n, 2n * GWEI);
    const [signed] = raw;
    if (!signed) throw new Error("nothing sent");
    const tx = parseTransaction(signed);
    expect(tx).toMatchObject({
      to: to.toLowerCase(),
      value: 12345n,
      gas: 21000n,
      nonce: 7,
      chainId: 11155111,
    });
    // Signed by the treasury: signing the same transaction again gives the same bytes.
    const { r: _r, s: _s, v: _v, yParity: _y, ...unsigned } = tx;
    expect(await privateKeyToAccount(treasuryHex).signTransaction(unsigned)).toBe(signed);
  });

  it("says where to top it up, and checks the RPC without repeating its URL", async () => {
    const { chain, plugin } = setUp();
    expect(plugin.fundAt).toBe(treasury);
    await expect(plugin.check()).resolves.toBeUndefined();
    await expect(setUp({ chainId: 1 }).plugin.check()).rejects.toThrow(
      "The RPC is on chain 11155111, not 1",
    );
    chain.balance = async () => {
      throw new Error("fetch to https://rpc.example/v2/secret-key failed");
    };
    await expect(plugin.check()).rejects.toThrow(/^Couldn't reach the RPC$/);
  });

  it("turns on from its settings, and refuses wrong ones", () => {
    const deps = { fetch: globalThis.fetch, log: () => {} };
    const base = { ETHEREUM_TREASURY_KEY: treasuryHex, ETHEREUM_RPC_URL: "https://rpc.example" };
    expect(ethereum.fromSettings({}, deps)).toBeNull();
    expect(ethereum.fromSettings(base, deps)?.label).toBe("Ethereum");
    expect(ethereum.fromSettings({ ...base, ETHEREUM_ASSET: "POL" }, deps)?.asset).toEqual({
      code: "POL",
      decimals: 18,
    });
    expect(() => ethereum.fromSettings({ ETHEREUM_TREASURY_KEY: treasuryHex }, deps)).toThrow(
      /RPC URL is needed/,
    );
    expect(() => ethereum.fromSettings({ ...base, ETHEREUM_TREASURY_KEY: "0x12" }, deps)).toThrow(
      /32-byte/,
    );
    expect(() => ethereum.fromSettings({ ...base, ETHEREUM_CHAIN_ID: "main" }, deps)).toThrow(
      /Chain ID should be a number/,
    );
  });
});
