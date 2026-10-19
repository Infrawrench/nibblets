// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMockServer } from "../../lib/mock.ts";
import { emptyOfflinePayload } from "../../lib/offline-data.ts";
import { Composer } from "./Composer.tsx";

vi.mock("../../lib/offline-context.tsx", async (original) => ({
  ...(await original<typeof import("../../lib/offline-context.tsx")>()),
  // Nobody has set up offline messages: no vault at all.
  useOffline: () => ({
    vault: null,
    payload: emptyOfflinePayload(),
    error: null,
    mutate: async () => {
      throw new Error("Unlock offline messages first.");
    },
    enqueue: async () => {
      throw new Error("Unlock offline messages first.");
    },
    report: () => undefined,
  }),
}));

let root: Root;
let host: HTMLDivElement;
let qc: QueryClient;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  qc.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("sends to the server while a nibblet works when offline messages are locked", async () => {
  const connection = createMockServer();
  const nibblet = {
    ...(await connection.client.nibblets.list({}))[0]!,
    status: "working" as const,
  };
  const send = vi.spyOn(connection.client.nibblets, "send").mockResolvedValue({ ok: true });
  await act(async () =>
    root.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(Composer, { connection, nibblet, running: true }),
      ),
    ),
  );
  const area = host.querySelector("textarea");
  if (!area) throw new Error("No message box");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      area,
      "and another thing",
    );
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const queue = host.querySelector<HTMLButtonElement>("button[aria-label='Queue send']");
  if (!queue) throw new Error("No queue button");
  await act(async () => queue.click());

  expect(send).toHaveBeenCalledWith({ id: nibblet.id, text: "and another thing", attachments: [] });
  expect(host.querySelector("[role='alert']")).toBeNull();
  expect(area.value).toBe("");
});
