import { useEffect } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { BrowserPanel } from "../components/panels/BrowserPanel.tsx";
import type { ServerConnection } from "../lib/connection.ts";
import { useNibblets, useServer } from "../lib/servers.tsx";

/** A nibblet's browser in a window of its own, big enough to use. */
export const Route = createFileRoute("/browser/$server/$id")({
  component: function BrowserWindow() {
    const { server, id } = Route.useParams();
    const connection = useServer(server);
    if (!connection) return <Message text="That server isn't connected." />;
    return <Window connection={connection} id={id} />;
  },
});

function Window({ connection, id }: { connection: ServerConnection; id: string }) {
  const nibblets = useNibblets(connection);
  const nibblet = nibblets.data?.find((n) => n.id === id);
  useEffect(() => {
    if (nibblet) document.title = `${nibblet.name}'s browser`;
  }, [nibblet?.name]);
  if (nibblets.isPending) return <div className="h-full bg-bg" />;
  if (!nibblet) return <Message text="This nibblet has gone." />;
  return (
    <div className="h-full bg-bg">
      <BrowserPanel connection={connection} nibblet={nibblet} popout />
    </div>
  );
}

function Message({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center bg-bg text-sm text-dim">{text}</div>
  );
}
