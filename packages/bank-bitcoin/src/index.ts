import {
  BankError,
  bytesHex,
  defineBankFactory,
  defineBankPlugin,
  deriveWalletKey,
  hexBytes,
  oneAtATime,
  requireEnv,
  walletSpent,
  type BankDeps,
  type BankEnv,
  type BankPlugin,
  type CardRef,
  type CardUsage,
} from "@nibblet/bank";
import type { CardSecret } from "@nibblet/protocol";
import { hex } from "@scure/base";
import { NETWORK, p2wpkh, selectUTXO, TEST_NETWORK, Transaction, WIF } from "@scure/btc-signer";
import { pubECDSA } from "@scure/btc-signer/utils.js";
import { z } from "zod";

/**
 * Bitcoin, as wallets that work like cards. The treasury is one native
 * segwit (P2WPKH) key on the server. Each card is a fresh wallet, its key
 * derived from the treasury's and the card's id, funded with exactly the
 * card's limit, so the nibblet can't spend more than that whatever it does.
 * Killing the card sweeps what's left back to the treasury. A single-use
 * wallet is swept once it has sent anything. The chain is read and written
 * through an Esplora API (mempool.space's by default).
 *
 * Settings: `BITCOIN_TREASURY_KEY` (hex or WIF), `BITCOIN_NETWORK`
 * (`mainnet`, `testnet`, `signet` or `regtest`; required, so a test key
 * can't end up on mainnet by default), and optionally `BITCOIN_ESPLORA_URL`
 * (required for regtest) and `BITCOIN_FEE_RATE` (sat/vB, instead of asking
 * Esplora).
 */

const Network = z.enum(["mainnet", "testnet", "signet", "regtest"]);
type Network = z.infer<typeof Network>;

type BtcNetwork = typeof NETWORK;

const NETWORKS: Record<Network, BtcNetwork> = {
  mainnet: NETWORK,
  testnet: TEST_NETWORK,
  signet: TEST_NETWORK,
  regtest: { ...TEST_NETWORK, bech32: "bcrt" },
};

const ESPLORA: Record<Network, string | null> = {
  mainnet: "https://mempool.space/api",
  testnet: "https://mempool.space/testnet4/api",
  signet: "https://mempool.space/signet/api",
  regtest: null,
};

/** Below this a card's wallet would cost more to use than it holds. */
export const MIN_CARD_SATS = 5_000n;
/** Outputs smaller than this aren't relayed. */
const DUST_SATS = 546n;
/** When Esplora has no estimate (regtest, say). */
const FALLBACK_FEE_RATE = 2n;

const Utxos = z.array(
  z.object({
    txid: z.string().regex(/^[0-9a-f]{64}$/),
    vout: z.int().min(0),
    value: z.int().min(0),
  }),
);
const Stats = z.object({ funded_txo_sum: z.number(), spent_txo_sum: z.number() });
const AddressInfo = z.object({ chain_stats: Stats, mempool_stats: Stats });
const FeeEstimates = z.record(z.string(), z.number());

/** The parts of Esplora's API a wallet needs. */
export class Esplora {
  private readonly base: string;
  private readonly fetch: typeof globalThis.fetch;

  constructor(base: string, fetch: typeof globalThis.fetch) {
    this.base = base.replace(/\/+$/, "");
    this.fetch = fetch;
  }

  async utxos(address: string) {
    return Utxos.parse(await this.json(`/address/${address}/utxo`));
  }

  /** Confirmed and unconfirmed together: what's come in, and what's gone out. */
  async totals(address: string): Promise<{ funded: bigint; spent: bigint }> {
    const { chain_stats: c, mempool_stats: m } = AddressInfo.parse(
      await this.json(`/address/${address}`),
    );
    return {
      funded: BigInt(c.funded_txo_sum + m.funded_txo_sum),
      spent: BigInt(c.spent_txo_sum + m.spent_txo_sum),
    };
  }

  /** Sat/vB for confirmation in about three blocks, or null without an estimate. */
  async feeRate(): Promise<bigint | null> {
    const estimates = FeeEstimates.parse(await this.json("/fee-estimates"));
    const rate = estimates["3"] ?? estimates["6"] ?? estimates["1"];
    return rate === undefined ? null : BigInt(Math.max(1, Math.ceil(rate)));
  }

  async broadcast(txHex: string): Promise<string> {
    const res = await this.fetch(`${this.base}/tx`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: txHex,
      signal: AbortSignal.timeout(30_000),
    });
    const text = (await res.text()).trim();
    if (!res.ok)
      throw new BankError(`The Bitcoin network refused the payment: ${text || res.status}`);
    return text;
  }

  private async json(path: string): Promise<unknown> {
    const res = await this.fetch(`${this.base}${path}`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Esplora: HTTP ${res.status} for ${path}`);
    return res.json();
  }
}

export interface BitcoinOptions {
  /** The treasury's private key, 32 bytes. */
  treasuryKey: Uint8Array;
  network: Network;
  esplora: Esplora;
  /** Sat/vB to pay, instead of asking Esplora. */
  feeRate?: bigint;
}

/** About a P2WPKH spend's virtual size: overhead, inputs and outputs. */
function sweepVsize(inputs: number): bigint {
  return BigInt(Math.ceil(10.5 + 68 * inputs + 31));
}

export function bitcoinPlugin(options: BitcoinOptions): BankPlugin {
  const network = NETWORKS[options.network];
  const { esplora } = options;
  const treasury = p2wpkh(pubECDSA(options.treasuryKey), network);
  const treasuryAddress = addressOf(treasury);
  const treasurySends = oneAtATime();

  function wallet(cardId: string) {
    const key = deriveWalletKey(options.treasuryKey, "bitcoin", cardId);
    const payment = p2wpkh(pubECDSA(key), network);
    return { key, payment, address: addressOf(payment) };
  }

  function secret(cardId: string): CardSecret {
    const { key, address } = wallet(cardId);
    return {
      type: "wallet",
      chain: "bitcoin",
      network: options.network,
      address,
      privateKey: bytesHex(key),
      wif: WIF(network).encode(key),
    };
  }

  async function feeRate(): Promise<bigint> {
    return options.feeRate ?? (await esplora.feeRate()) ?? FALLBACK_FEE_RATE;
  }

  async function usage(card: CardRef): Promise<CardUsage> {
    const { funded, spent } = await esplora.totals(wallet(card.id).address);
    const used = spent > 0n;
    return { open: true, spent: walletSpent(card.limit, funded - spent, used), used };
  }

  return defineBankPlugin({
    id: "bitcoin",
    label: options.network === "mainnet" ? "Bitcoin" : `Bitcoin (${options.network})`,
    asset: { code: "BTC", decimals: 8 },

    async balance() {
      const { funded, spent } = await esplora.totals(treasuryAddress);
      return funded - spent;
    },

    issue: (request) =>
      treasurySends(async () => {
        if (request.limit < MIN_CARD_SATS) {
          throw new BankError(
            `A Bitcoin card needs at least ${MIN_CARD_SATS} sats, to cover its fees`,
          );
        }
        const { address } = wallet(request.cardId);
        const coins = (await esplora.utxos(treasuryAddress)).map((u) => ({
          txid: hex.decode(u.txid),
          index: u.vout,
          witnessUtxo: { script: treasury.script, amount: BigInt(u.value) },
        }));
        const selected = selectUTXO(coins, [{ address, amount: request.limit }], "default", {
          feePerByte: await feeRate(),
          changeAddress: treasuryAddress,
          network,
          bip69: true,
          createTx: true,
        });
        if (!selected?.tx) {
          throw new BankError("The Bitcoin treasury doesn't have enough to fund that card");
        }
        selected.tx.sign(options.treasuryKey);
        selected.tx.finalize();
        await esplora.broadcast(selected.tx.hex);
        return { ref: address, display: address, secret: secret(request.cardId) };
      }),

    async find(cardId) {
      const { address } = wallet(cardId);
      const { funded } = await esplora.totals(address);
      return funded > 0n ? { ref: address, display: address } : null;
    },

    async reveal(card) {
      return secret(card.id);
    },

    inspect: usage,

    close: (card) =>
      treasurySends(async () => {
        const before = await usage(card);
        const { key, payment, address } = wallet(card.id);
        const { funded } = await esplora.totals(address);
        // Its funding isn't seen yet, so there's nothing to sweep; try again later.
        if (funded === 0n) return { open: false, spent: 0n, used: false, settled: false };
        const coins = await esplora.utxos(address);
        const total = coins.reduce((sum, u) => sum + BigInt(u.value), 0n);
        const fee = sweepVsize(coins.length) * (await feeRate());
        let returned = 0n;
        if (coins.length > 0 && total - fee >= DUST_SATS) {
          const tx = new Transaction();
          for (const u of coins) {
            tx.addInput({
              txid: hex.decode(u.txid),
              index: u.vout,
              witnessUtxo: { script: payment.script, amount: BigInt(u.value) },
            });
          }
          tx.addOutputAddress(treasuryAddress, total - fee, network);
          tx.sign(key);
          tx.finalize();
          await esplora.broadcast(tx.hex);
          returned = total - fee;
        }
        const spent = returned >= card.limit ? 0n : card.limit - returned;
        return { open: false, spent, used: before.used, settled: true };
      }),
  });
}

function addressOf(payment: { address?: string | undefined }): string {
  if (!payment.address) throw new Error("No address for that key");
  return payment.address;
}

/** A 32-byte key from hex, or from WIF for this network. */
export function parseKey(text: string, network: Network): Uint8Array {
  const trimmed = text.trim();
  const key = /^(0x)?[0-9a-f]{64}$/i.test(trimmed)
    ? hexBytes(trimmed)
    : WIF(NETWORKS[network]).decode(trimmed);
  if (key.length !== 32) throw new Error("BITCOIN_TREASURY_KEY isn't a 32-byte key");
  return key;
}

export const bitcoin = defineBankFactory({
  id: "bitcoin",
  env: ["BITCOIN_TREASURY_KEY", "BITCOIN_NETWORK", "BITCOIN_ESPLORA_URL", "BITCOIN_FEE_RATE"],
  fromEnv(env: BankEnv, deps: BankDeps) {
    if (!env.BITCOIN_TREASURY_KEY?.trim()) return null;
    const network = Network.safeParse(env.BITCOIN_NETWORK?.trim());
    if (!network.success) {
      throw new Error("BITCOIN_NETWORK should be mainnet, testnet, signet or regtest");
    }
    let treasuryKey: Uint8Array;
    try {
      treasuryKey = parseKey(requireEnv(env, "BITCOIN_TREASURY_KEY"), network.data);
    } catch {
      throw new Error(`BITCOIN_TREASURY_KEY isn't a hex or ${network.data} WIF private key`);
    }
    const url = env.BITCOIN_ESPLORA_URL?.trim() || ESPLORA[network.data];
    if (!url) throw new Error(`BITCOIN_ESPLORA_URL is needed for ${network.data}`);
    const rate = env.BITCOIN_FEE_RATE?.trim();
    if (rate && !/^[1-9]\d*$/.test(rate)) {
      throw new Error("BITCOIN_FEE_RATE should be a whole number of sat/vB");
    }
    return bitcoinPlugin({
      treasuryKey,
      network: network.data,
      esplora: new Esplora(url, deps.fetch),
      ...(rate ? { feeRate: BigInt(rate) } : {}),
    });
  },
});
