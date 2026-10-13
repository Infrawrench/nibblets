import { Outlet, createRootRoute } from "@tanstack/react-router";
import { Sidebar } from "../components/Sidebar.tsx";

export const Route = createRootRoute({
  component: () => (
    <div className="flex h-full overflow-hidden">
      <Sidebar />
      <main className="flex min-w-0 flex-1 bg-bg">
        <Outlet />
      </main>
    </div>
  ),
});
