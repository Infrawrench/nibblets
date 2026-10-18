import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen.ts";
import { isMockMode, loadToken, redeemPairingLink } from "./lib/auth.ts";
import { createConnection, type ServerConnection } from "./lib/connection.ts";
import { createMockServer } from "./lib/mock.ts";
import { LocalServers } from "./lib/servers.tsx";
import { isCentralMode } from "./lib/central.ts";
import { CentralApp } from "./components/CentralApp.tsx";
import { Gate } from "./components/Gate.tsx";
import { OfflineProvider } from "./lib/offline-context.tsx";
import "./styles.css";

// The desktop app tags its user agent; on a Mac its window has no title bar.
const shell = /NibbletsDesktop\/(\w+)/.exec(navigator.userAgent)?.[1];
if (shell === "darwin") document.documentElement.dataset.shell = "mac";

// Installable, quick to reopen, and able to show notifications. Not in the
// desktop app, which has its own window, nor in development.
if (import.meta.env.PROD && !shell && "serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
}

const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 10_000 } },
});

async function boot(): Promise<void> {
  const root = document.getElementById("root");
  if (!root) throw new Error("No #root");
  const app = <RouterProvider router={router} />;

  if (isCentralMode()) {
    createRoot(root).render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <CentralApp>{app}</CentralApp>
        </QueryClientProvider>
      </StrictMode>,
    );
    return;
  }

  const mock = isMockMode();
  if (!mock) await redeemPairingLink();
  const local: ServerConnection = mock
    ? createMockServer()
    : createConnection("local", () => "", loadToken);
  const principal = `local:${JSON.stringify([window.location.origin, loadToken() ?? "unpaired"])}`;
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <OfflineProvider principal={principal}>
          <Gate local={local}>
            <LocalServers connection={local}>{app}</LocalServers>
          </Gate>
        </OfflineProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}

void boot();
