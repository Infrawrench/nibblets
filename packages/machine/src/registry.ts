import { GUEST_NAMES, type MachineBackend, type MachineChoice } from "@nibblet/protocol";
import type { ExitListener, MachinePlugin, MachineState } from "./plugin.ts";

/** Asked for a plugin that isn't loaded, or a guest it can't run. */
export class MachineUnavailable extends Error {}

/**
 * The machine plugins this server has loaded, by id. The conductor asks it
 * for a nibblet's own, and it speaks for all of them where the question is
 * about every machine at once (reconciling after a restart, exits).
 */
export class MachineRegistry {
  private readonly plugins = new Map<string, MachinePlugin>();

  constructor(plugins: readonly MachinePlugin[]) {
    for (const plugin of plugins) {
      if (this.plugins.has(plugin.id)) throw new Error(`two machine plugins called ${plugin.id}`);
      this.plugins.set(plugin.id, plugin);
    }
  }

  all(): readonly MachinePlugin[] {
    return [...this.plugins.values()];
  }

  /** The plugin a nibblet's machine comes from. */
  get(choice: Pick<MachineChoice, "backend">): MachinePlugin {
    const plugin = this.plugins.get(choice.backend);
    if (!plugin) throw new MachineUnavailable(`There's no "${choice.backend}" machine plugin here`);
    return plugin;
  }

  /** Every plugin that's here, as the UI shows them; one that can't answer says why. */
  async describe(): Promise<MachineBackend[]> {
    const found = await Promise.all(
      this.all().map((plugin) =>
        plugin.describe().catch((err: unknown): MachineBackend | null => ({
          id: plugin.id,
          name: plugin.name,
          kind: plugin.kind,
          available: false,
          detail: err instanceof Error ? err.message : String(err),
          recommended: false,
          guests: [],
        })),
      ),
    );
    return found.filter((b) => b !== null);
  }

  /**
   * Checks a new nibblet's choice before it's stored: the plugin is here,
   * works, and runs that guest. Its image needn't be ready; Linux's is made
   * on first start.
   */
  async check(choice: MachineChoice): Promise<void> {
    const plugin = this.get(choice);
    const backend = await plugin.describe();
    if (!backend) throw new MachineUnavailable(`${plugin.name} isn't on this server's host`);
    if (!backend.available) {
      throw new MachineUnavailable(backend.detail ?? `${backend.name} isn't available here`);
    }
    if (!backend.guests.some((g) => g.os === choice.guest)) {
      throw new MachineUnavailable(`${backend.name} can't run ${GUEST_NAMES[choice.guest]} here`);
    }
  }

  /**
   * Every nibblet's machine, from every plugin. A plugin that can't be
   * asked (a hypervisor whose host bridge is down) is left out, rather than
   * holding up the rest.
   */
  async machines(): Promise<Map<string, MachineState & { backend: string }>> {
    const out = new Map<string, MachineState & { backend: string }>();
    await Promise.all(
      this.all().map(async (plugin) => {
        const found = await plugin.machines().catch((err: unknown) => {
          console.warn(`couldn't list ${plugin.name}'s machines`, err);
          return new Map<string, MachineState>();
        });
        for (const [id, state] of found) out.set(id, { ...state, backend: plugin.id });
      }),
    );
    return out;
  }

  async watchExits(listener: ExitListener): Promise<void> {
    await Promise.all(this.all().map((plugin) => plugin.watchExits(listener)));
  }
}
