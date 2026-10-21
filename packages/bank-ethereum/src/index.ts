import {
  BankError,
  bytesHex,
  defineBankFactory,
  defineBankPlugin,
  deriveWalletKey,
  hexBytes,
  defineField,
  oneAtATime,
  optionalSetting,
  requireSetting,
  walletSpent,
  type BankDeps,
  type BankPlugin,
  type BankSettingValues,
  type CardRef,
  type CardUsage,
} from "@nibblets/bank";
import type { CardSecret } from "@nibblets/protocol";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Ether (or an EVM chain's own coin), as wallets that work like cards: the
 * same scheme as Bitcoin. Each card is a fresh account, its key derived from
 * the treasury's and the card's id, funded with exactly the card's limit,
 * and swept back to the treasury when it's killed. Gas comes out of the
 * card's own balance.
 *
 * Settings (see `fields`): the treasury's key (hex) and an RPC URL, and
 * optionally a chain id (checked against the RPC, so a key meant for a
 * testnet isn't used on mainnet by mistake) and the coin's ticker (`ETH` by
 * default; `POL` for Polygon, say).
 */

/** A plain transfer always costs this much gas. */
const TRANSFER_GAS = 21_000n;

/** What a wallet needs from the chain. */
export interface EvmClient {
  chainId(): Promise<number>;
  /** Including what's still pending, so a fresh funding counts. */
  balance(address: Address): Promise<bigint>;
  nonce(address: Address): Promise<number>;
  gasPrice(): Promise<bigint>;
  /** Sends `value` from the account with this key; resolves with the transaction's hash. */
  transfer(key: Hex, to: Address, value: bigint, gasPrice: bigint): Promise<Hex>;
}

/** An EvmClient over a JSON-RPC endpoint, signing locally. */
export function viemClient(transport: Transport): EvmClient {
  const reader = createPublicClient({ transport });
  const writer = createWalletClient({ transport });
  return {
    chainId: () => reader.getChainId(),
    balance: (address) => reader.getBalance({ address, blockTag: "pending" }),
    nonce: (address) => reader.getTransactionCount({ address, blockTag: "pending" }),
    gasPrice: () => reader.getGasPrice(),
    async transfer(key, to, value, gasPrice) {
      const account = privateKeyToAccount(key);
      return writer.sendTransaction({
        account,
        to,
        value,
        gas: TRANSFER_GAS,
        gasPrice,
        nonce: await reader.getTransactionCount({ address: account.address, blockTag: "pending" }),
        chain: null,
      });
    },
  };
}

export interface EthereumOptions {
  treasuryKey: Uint8Array;
  client: EvmClient;
  /** The chain it must be on, if given. */
  chainId?: number;
  asset?: string;
}

function hexKey(bytes: Uint8Array): Hex {
  return `0x${bytesHex(bytes)}`;
}

export function ethereumPlugin(options: EthereumOptions): BankPlugin {
  const { client } = options;
  const treasuryKey = hexKey(options.treasuryKey);
  const treasury = privateKeyToAccount(treasuryKey).address;
  const treasurySends = oneAtATime();
  let checkedChain: Promise<number> | null = null;

  /** The chain id, checked once against the one it was set up for. */
  function chain(): Promise<number> {
    checkedChain ??= client.chainId().then((id) => {
      if (options.chainId !== undefined && id !== options.chainId) {
        throw new BankError(`The RPC is on chain ${id}, not ${options.chainId}`);
      }
      return id;
    });
    // A failed check is tried again next time.
    checkedChain.catch(() => {
      checkedChain = null;
    });
    return checkedChain;
  }

  function wallet(cardId: string) {
    const key = hexKey(deriveWalletKey(options.treasuryKey, "ethereum", cardId));
    return { key, address: privateKeyToAccount(key).address };
  }

  async function secret(cardId: string): Promise<CardSecret> {
    const { key, address } = wallet(cardId);
    return {
      type: "wallet",
      chain: "ethereum",
      network: String(await chain()),
      address,
      privateKey: key,
      wif: null,
    };
  }

  async function usage(card: CardRef): Promise<CardUsage> {
    const { address } = wallet(card.id);
    const [balance, nonce] = await Promise.all([client.balance(address), client.nonce(address)]);
    const used = nonce > 0;
    return { open: true, spent: walletSpent(card.limit, balance, used), used };
  }

  const asset = options.asset ?? "ETH";
  return defineBankPlugin({
    id: "ethereum",
    label: asset === "ETH" ? "Ethereum" : `Ethereum (${asset})`,
    asset: { code: asset, decimals: 18 },
    instrument: "wallet",
    fundAt: treasury,

    async check() {
      try {
        await chain();
        await client.balance(treasury);
      } catch (err) {
        if (err instanceof BankError) throw err;
        // Its own message can carry the RPC URL, and with it the URL's key.
        throw new BankError("Couldn't reach the RPC");
      }
    },

    async balance() {
      await chain();
      return client.balance(treasury);
    },

    issue: (request) =>
      treasurySends(async () => {
        await chain();
        const { address } = wallet(request.cardId);
        const gasPrice = await client.gasPrice();
        const needed = request.limit + TRANSFER_GAS * gasPrice;
        if ((await client.balance(treasury)) < needed) {
          throw new BankError(
            "The Ethereum treasury doesn't have enough to fund that card and its gas",
          );
        }
        await client.transfer(treasuryKey, address, request.limit, gasPrice);
        return { ref: address, display: address, secret: await secret(request.cardId) };
      }),

    async find(cardId) {
      await chain();
      const { address } = wallet(cardId);
      const [balance, nonce] = await Promise.all([client.balance(address), client.nonce(address)]);
      return balance > 0n || nonce > 0 ? { ref: address, display: address } : null;
    },

    reveal: (card) => secret(card.id),

    inspect: usage,

    close: (card) =>
      treasurySends(async () => {
        await chain();
        const before = await usage(card);
        const { key, address } = wallet(card.id);
        const balance = await client.balance(address);
        // Its funding isn't seen yet, so there's nothing to sweep; try again later.
        if (balance === 0n && !before.used) {
          return { open: false, spent: 0n, used: false, settled: false };
        }
        const gasPrice = await client.gasPrice();
        const fee = TRANSFER_GAS * gasPrice;
        let returned = 0n;
        if (balance > fee) {
          await client.transfer(key, treasury, balance - fee, gasPrice);
          returned = balance - fee;
        }
        const spent = returned >= card.limit ? 0n : card.limit - returned;
        return { open: false, spent, used: before.used, settled: true };
      }),
  });
}

const TREASURY_KEY = defineField("ETHEREUM_TREASURY_KEY", "Treasury key", {
  required: true,
  secret: true,
  generate: "private_key",
  lockedByCards: true,
  placeholder: "0x…",
  hint: "The private key of the account cards are funded from. Make a new one and keep a copy somewhere safe: it's the only way to the treasury's coins.",
});
const RPC_URL = defineField("ETHEREUM_RPC_URL", "RPC URL", {
  required: true,
  secret: true,
  placeholder: "https://…",
  hint: "A JSON-RPC endpoint for the chain. Kept secret, since many carry an API key.",
});
const CHAIN_ID = defineField("ETHEREUM_CHAIN_ID", "Chain ID", {
  lockedByCards: true,
  placeholder: "Any",
  hint: "Checked against the RPC before anything is sent: 1 for mainnet, 11155111 for Sepolia.",
});
const ASSET = defineField("ETHEREUM_ASSET", "Coin", {
  lockedByCards: true,
  placeholder: "ETH",
  hint: "The chain's own coin, for another EVM chain: POL for Polygon, say.",
});

export const ethereum = defineBankFactory({
  id: "ethereum",
  name: "Ethereum",
  about:
    "A treasury account on Ethereum or another EVM chain, funding a fresh account for each card.",
  instrument: "wallet",
  fields: [TREASURY_KEY, RPC_URL, CHAIN_ID, ASSET],
  fromSettings(settings: BankSettingValues, deps: BankDeps) {
    if (!optionalSetting(settings, TREASURY_KEY)) return null;
    let treasuryKey: Uint8Array;
    try {
      treasuryKey = hexBytes(requireSetting(settings, TREASURY_KEY));
    } catch {
      throw new Error(`${TREASURY_KEY.label} isn't a hex private key`);
    }
    if (treasuryKey.length !== 32) throw new Error(`${TREASURY_KEY.label} isn't a 32-byte key`);
    const url = requireSetting(settings, RPC_URL);
    if (!/^https?:\/\//.test(url)) throw new Error(`${RPC_URL.label} should be an http(s) URL`);
    const chainId = optionalSetting(settings, CHAIN_ID);
    if (chainId && !/^[1-9]\d*$/.test(chainId)) {
      throw new Error(`${CHAIN_ID.label} should be a number, e.g. 1 or 11155111`);
    }
    const asset = optionalSetting(settings, ASSET);
    if (asset && !/^[A-Z0-9]{2,10}$/.test(asset)) {
      throw new Error(`${ASSET.label} should be a ticker, e.g. ETH`);
    }
    return ethereumPlugin({
      treasuryKey,
      client: viemClient(http(url, { timeout: 30_000, fetchFn: deps.fetch })),
      ...(chainId ? { chainId: Number(chainId) } : {}),
      ...(asset ? { asset } : {}),
    });
  },
});
