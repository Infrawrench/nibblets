import { Outlet, createRootRoute, useRouterState } from "@tanstack/react-router";
import { Sidebar } from "../components/Sidebar.tsx";
import { cn } from "../lib/cn.ts";

export const Route = createRootRoute({
  component: function Root() {
    const path = useRouterState({ select: (s) => s.location.pathname });
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
      </div>
    );
  },
});
