import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { clearOfflineQueries } from "./offline-context.tsx";
import { CentralHttpError, centralApi } from "./central.ts";
import { CentralServers, keys } from "./servers.tsx";

describe("offline query lifetime", () => {
  it("clears decrypted caches and rejects late RPC completion after scope disposal", async () => {
    const client = new QueryClient();
    client.setQueryData(["private-existing"], "existing plaintext");
    let complete!: (text: string) => void;
    const loading = client
      .fetchQuery({
        queryKey: ["thread", "local", "chat"],
        queryFn: () =>
          new Promise<string>((resolve) => {
            complete = resolve;
          }),
      })
      .catch(() => undefined);
    clearOfflineQueries(client);
    complete("late plaintext");
    await loading;
    await Promise.resolve();
    expect(client.getQueryCache().getAll()).toHaveLength(0);
    expect(client.getQueryData(["thread", "local", "chat"])).toBeUndefined();
  });
  it.each([false, true])(
    "blocks cached child pages when central authorization fails (stale data: %s)",
    async (stale) => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      if (stale)
        client.setQueryData(keys.centralServers(), {
          user: { id: "current-user", name: "Current" },
          servers: [],
        });
      await client
        .fetchQuery({
          queryKey: keys.centralServers(),
          queryFn: async () => {
            throw new CentralHttpError("Sign in again", 401);
          },
          retry: false,
        })
        .catch(() => undefined);
      const html = renderToString(
        createElement(
          QueryClientProvider,
          { client },
          createElement(CentralServers, {
            api: centralApi(async () => null),
            children: "PRIVATE SAVED CONVERSATION",
          }),
        ),
      );
      expect(html).toContain("Sign in again");
      expect(html).not.toContain("PRIVATE SAVED CONVERSATION");
      client.clear();
    },
  );
});
