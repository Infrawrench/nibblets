import { Outlet, createRootRoute, useRouterState } from "@tanstack/react-router";
import { LocationResponder } from "../components/LocationResponder.tsx";
import { Sidebar } from "../components/Sidebar.tsx";
import { cn } from "../lib/cn.ts";
import { useServers } from "../lib/servers.tsx";

export const Route = createRootRoute({
  component: function Root() {
    const path = useRouterState({ select: (s) => s.location.pathname });
    const { all } = useServers();
    // Pop-out windows (the browser, the apps) are just their content.
    if (path.startsWith("/browser/") || path.startsWith("/apps/")) return <Outlet />;
    // On a phone it's one thing at a time: the list is home, and pages open over it.
    const home = path === "/";
    return (
      <div className="flex h-full overflow-hidden">
        <Sidebar className={home ? "max-md:w-full max-md:border-r-0" : "max-md:hidden"} />
        <main className={cn("flex min-w-0 flex-1 bg-bg", home && "max-md:hidden")}>
          <Outlet />
        </main>
        {/* A nibblet asking where its person is gets an answer from here, or a question. */}
        {all.map((c) => (
          <LocationResponder key={c.id} connection={c} />
        ))}
      </div>
    );
  },
});
