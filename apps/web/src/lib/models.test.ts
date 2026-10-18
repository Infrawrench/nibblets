import { harnesses, type CredentialStatus, type HarnessModels } from "@nibblet/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createConnection } from "./connection.ts";
import { useModels, type ModelCatalogue } from "./models.ts";
import { keys } from "./servers.tsx";

const unavailableKimi: HarnessModels = {
  harness: "kimi",
  state: "unavailable",
  detail: "Kimi Code isn't signed in on the host",
  models: [...harnesses.kimi.models],
};

function catalogue(credentials: CredentialStatus[], kimi: HarnessModels | null): ModelCatalogue {
  const client = new QueryClient();
  const connection = createConnection(
    "test",
    () => "",
    () => null,
  );
  client.setQueryData(keys.info(connection.id), { credentials });
  if (kimi) client.setQueryData(["harness-models", connection.id, "kimi"], kimi);
  client.setQueryData(["harness-models", connection.id, "opencode"], {
    harness: "opencode",
    state: "unavailable",
    detail: "OpenCode isn't signed in on the host",
    models: [],
  });
  let result: ModelCatalogue | undefined;
  function ReadModels() {
    result = useModels(connection);
    return null;
  }
  try {
    renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(ReadModels)));
    if (!result) throw new Error("Models did not render");
    return result;
  } finally {
    connection.live.close();
    client.clear();
  }
}

describe("useModels", () => {
  it("offers unavailable Kimi with its warning while defaulting to signed-in Codex", () => {
    const models = catalogue(
      [
        {
          provider: "openai",
          source: "file",
          ok: true,
          detail: "",
          plan: null,
          expiresAt: null,
          limitedUntil: null,
        },
      ],
      unavailableKimi,
    );
    expect(models.offered).toEqual(["codex", "kimi"]);
    expect(models.forHarness("kimi")).toEqual({
      models: harnesses.kimi.models,
      loading: false,
      unavailable: unavailableKimi.detail,
    });
    expect(models.defaultChoice()).toEqual({ harness: "codex", model: "gpt-5.6-terra" });
  });

  it("preserves the all-harness fallback and Claude default without credentials", () => {
    const models = catalogue([], unavailableKimi);
    expect(models.offered).toEqual(["claude", "codex", "deepseek", "kimi", "opencode"]);
    expect(models.defaultChoice()).toEqual({ harness: "claude", model: "claude-opus-5-5" });
  });

  it("defaults to K3 when Kimi is the only ready harness", () => {
    const models = catalogue([], { ...unavailableKimi, state: "ready", detail: null });
    expect(models.offered).toEqual(["kimi"]);
    expect(models.defaultChoice()).toEqual({ harness: "kimi", model: "kimi-code/k3" });
  });

  it("keeps pending Kimi offered without choosing it as the default", () => {
    const models = catalogue([], null);
    expect(models.offered).toEqual(["claude", "codex", "deepseek", "kimi", "opencode"]);
    expect(models.forHarness("kimi")).toEqual({ models: [], loading: true, unavailable: null });
    expect(models.defaultChoice()).toEqual({ harness: "claude", model: "claude-opus-5-5" });
  });
});
