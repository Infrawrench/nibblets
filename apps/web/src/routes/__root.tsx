import { Outlet, createRootRoute, useRouterState } from "@tanstack/react-router";
import { Sidebar } from "../components/Sidebar.tsx";

export const Route = createRootRoute({
  component: function Root() {
    const path = useRouterState({ select: (s) => s.location.pathname });
    // Pop-out windows (the browser) are just their content.
    if (path.startsWith("/browser/")) return <Outlet />;
    return (
      <div className="flex h-full overflow-hidden">
        <Sidebar />
        <main className="flex min-w-0 flex-1 bg-bg">
          <Outlet />
        </main>
      </div>
    );
  },
});
