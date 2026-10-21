import { loadBankPlugins, type BankPluginFactory, type LoadedBanks } from "@nibblet/bank";
import { bitcoin } from "@nibblet/bank-bitcoin";
import { ethereum } from "@nibblet/bank-ethereum";
import { slash } from "@nibblet/bank-slash";

/**
 * Every bank plugin the server knows. Each turns itself on when its settings
 * are in the environment (see the server's environment in `docker/compose.yaml`), and stays off otherwise.
 */
export const BANK_PLUGINS: readonly BankPluginFactory[] = [slash, bitcoin, ethereum];

export function loadBanks(env: NodeJS.ProcessEnv = process.env): LoadedBanks {
  const loaded = loadBankPlugins(BANK_PLUGINS, env, {
    fetch: globalThis.fetch,
    log: (message) => console.warn(`bank: ${message}`),
  });
  for (const plugin of loaded.plugins.values()) console.log(`bank: ${plugin.label} is set up`);
  for (const [id, problem] of loaded.errors) console.warn(`bank: ${id} isn't set up: ${problem}`);
  return loaded;
}
