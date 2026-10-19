import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { clearOfflineQueries } from "./offline-context.tsx";
import { CentralHttpError, centralApi } from "./central.ts";
import { CentralServers, ServersProvider, useServers, keys } from "./servers.tsx";
import { createMockServer } from "./mock.ts";

function ServerRouteProbe() {
  const servers = useServers();
  return createElement(
    "span",
    null,
    JSON.stringify({
      systems: servers.systems.map((system) => system.name),
      connections: servers.all.length,
      user: servers.central?.user.id,
    }),
  );
}

describe("server provider composition", () => {
  it("supports a populated standalone server provider without an offline vault provider", () => {
    const client = new QueryClient();
    const connection = createMockServer();
    const html = renderToString(
      createElement(
        QueryClientProvider,
        { client },
        createElement(ServersProvider, {
          systems: [
            {
              id: connection.id,
              name: "Standalone host",
              platform: "linux",
              online: true,
              local: true,
              route: null,
              connection,
            },
          ],
          children: createElement(ServerRouteProbe),
        }),
      ),
    );
    expect(html).toContain("Standalone host");
    expect(html).toContain("&quot;connections&quot;:1");
    client.clear();
  });
  it("supports an authenticated populated central route without an offline vault provider", () => {
    const client = new QueryClient();
    client.setQueryData(keys.centralServers(), {
      user: { id: "authenticated-user", name: "Current" },
      servers: [
        {
          id: "host",
          name: "Saved host",
          hostname: "host",
          platform: "linux",
          version: "1",
          nibblets: 1,
          routes: { lan: [], tailscale: null, tunnel: null },
          online: false,
          lastSeenAt: null,
          linkedAt: "2026-10-18T00:00:00.000Z",
        },
      ],
    });
    const html = renderToString(
      createElement(
        QueryClientProvider,
        { client },
        createElement(CentralServers, {
          api: centralApi(async () => null),
          children: createElement(ServerRouteProbe),
        }),
      ),
    );
    expect(html).toContain("Saved host");
    expect(html).toContain("authenticated-user");
    client.clear();
  });
});

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
    "blocks cached child pages when central authorisation fails (stale data: %s)",
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
