import { useQuery } from "@tanstack/react-query";
import { harnesses, type HarnessId, type ModelOption } from "@nibblet/protocol";
import type { ServerConnection } from "./connection.ts";

export interface HarnessModelState {
  models: readonly ModelOption[];
  loading: boolean;
  /** Why there's no list, when there isn't one. */
  unavailable: string | null;
}

export interface ModelCatalogue {
  forHarness(harness: HarnessId): HarnessModelState;
  find(harness: HarnessId, model: string): ModelOption | undefined;
}

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

  return {
    forHarness,
    find: (harness, model) => forHarness(harness).models.find((m) => m.id === model),
  };
}

/** A model's name, or failing that its id with OpenCode's `provider/` prefix dropped. */
export function modelLabel(model: ModelOption | undefined, id: string): string {
  if (model) return model.label;
  const slash = id.indexOf("/");
  return slash >= 0 ? id.slice(slash + 1) : id;
}
