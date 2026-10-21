import { harnesses, type CredentialStatus, type HarnessModels } from "@nibblets/protocol";
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
  models: [],
};

const readyKimi: HarnessModels = {
  harness: "kimi",
  state: "ready",
  detail: null,
  models: [...harnesses.kimi.models],
};

const openai: CredentialStatus = {
  provider: "openai",
  source: "file",
  ok: true,
  detail: "",
  plan: null,
  expiresAt: null,
  limitedUntil: null,
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
  it("leaves out unavailable Kimi, keeping its warning, and defaults to signed-in Codex", () => {
    const models = catalogue([openai], unavailableKimi);
    expect(models.offered).toEqual(["codex"]);
    expect(models.forHarness("kimi")).toEqual({
      models: [],
      loading: false,
      unavailable: unavailableKimi.detail,
    });
    expect(models.defaultChoice()).toEqual({ harness: "codex", model: "gpt-5.6-terra" });
  });

  it("offers Kimi alongside Codex once the host is signed in to it", () => {
    const models = catalogue([openai], readyKimi);
    expect(models.offered).toEqual(["codex", "kimi"]);
    expect(models.defaultChoice()).toEqual({ harness: "codex", model: "gpt-5.6-terra" });
  });

  it("preserves the all-harness fallback and Claude default without credentials", () => {
    const models = catalogue([], unavailableKimi);
    expect(models.offered).toEqual(["claude", "codex", "deepseek", "kimi", "opencode"]);
    expect(models.defaultChoice()).toEqual({ harness: "claude", model: "claude-opus-5-5" });
  });

  it("defaults to K3 when Kimi is the only ready harness", () => {
    const models = catalogue([], readyKimi);
    expect(models.offered).toEqual(["kimi"]);
    expect(models.defaultChoice()).toEqual({ harness: "kimi", model: "kimi-code/k3" });
  });

  it("doesn't start on Kimi while its list is still loading", () => {
    const models = catalogue([], null);
    expect(models.offered).toEqual(["claude", "codex", "deepseek", "kimi", "opencode"]);
    expect(models.forHarness("kimi")).toEqual({ models: [], loading: true, unavailable: null });
    expect(models.defaultChoice()).toEqual({ harness: "claude", model: "claude-opus-5-5" });
  });
});
