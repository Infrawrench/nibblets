import { useQuery } from "@tanstack/react-query";
import { HarnessId, harnesses, type ModelOption } from "@nibblet/protocol";
import type { ServerConnection } from "./connection.ts";
import { keys } from "./servers.tsx";

export interface HarnessModelState {
  models: readonly ModelOption[];
  loading: boolean;
  /** Why there's no list, when there isn't one. */
  unavailable: string | null;
}

export interface ModelCatalogue {
  forHarness(harness: HarnessId): HarnessModelState;
  find(harness: HarnessId, model: string): ModelOption | undefined;
  /** The harnesses this server can run: Claude and Codex only once their subscription is added. */
  offered: readonly HarnessId[];
  /** What a new nibblet starts on: the first offered harness's default model. */
  defaultChoice(): { harness: HarnessId; model: string } | null;
}

/** Which subscription each fixed-list harness bills to. */
const subscription: Partial<Record<HarnessId, "anthropic" | "openai">> = {
  claude: "anthropic",
  codex: "openai",
};

/**
 * Every harness's models on one server: the fixed lists for Claude and
 * Codex, and OpenCode's live list, which depends on what the server's host
 * is signed in to.
 */
export function useModels(connection: ServerConnection | null | undefined): ModelCatalogue {
  const opencode = useQuery({
    queryKey: ["harness-models", connection?.id ?? "none", "opencode"],
    queryFn: () => {
      if (!connection) throw new Error("No server");
      return connection.client.harnesses.models({ harness: "opencode" });
    },
    enabled: Boolean(connection),
    staleTime: 60_000,
  });
  const info = useQuery({
    queryKey: keys.info(connection?.id ?? "none"),
    queryFn: () => {
      if (!connection) throw new Error("No server");
      return connection.client.system.info({});
    },
    enabled: Boolean(connection),
    staleTime: 60_000,
  });

  const forHarness = (harness: HarnessId): HarnessModelState => {
    if (!harnesses[harness].dynamicModels) {
      return { models: harnesses[harness].models, loading: false, unavailable: null };
    }
    if (opencode.isPending) return { models: [], loading: true, unavailable: null };
    if (opencode.error) return { models: [], loading: false, unavailable: opencode.error.message };
    const data = opencode.data;
    return {
      models: data?.models ?? [],
      loading: false,
      unavailable: data?.state === "unavailable" ? (data.detail ?? "Unavailable") : null,
    };
  };

  // Until the server says otherwise, everything is on offer.
  const signedIn = (harness: HarnessId) => {
    const provider = subscription[harness];
    if (!provider) return opencode.isPending || forHarness(harness).models.length > 0;
    const credential = info.data?.credentials.find((c) => c.provider === provider);
    return !info.data || (credential !== undefined && credential.source !== "none");
  };
  const ready = HarnessId.options.filter(signedIn);
  // With nothing signed in, hiding everything would leave nothing to pick.
  const offered = ready.length > 0 ? ready : HarnessId.options;

  return {
    forHarness,
    find: (harness, model) => forHarness(harness).models.find((m) => m.id === model),
    offered,
    defaultChoice: () => {
      for (const harness of offered) {
        const model = harnesses[harness].defaultModel || forHarness(harness).models[0]?.id;
        if (model) return { harness, model };
      }
      return null;
    },
  };
}

/** A model's name, or failing that its id with OpenCode's `provider/` prefix dropped. */
export function modelLabel(model: ModelOption | undefined, id: string): string {
  if (model) return model.label;
  const slash = id.indexOf("/");
  return slash >= 0 ? id.slice(slash + 1) : id;
}
