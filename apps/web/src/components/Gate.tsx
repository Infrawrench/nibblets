import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { RpcError, defaultHamsterLook } from "@nibblet/protocol";
import type { ServerConnection } from "../lib/connection.ts";
import { keys } from "../lib/servers.tsx";
import { Hamster } from "./hamster/Hamster.tsx";
import { Button } from "./ui/Button.tsx";
import { useOffline } from "../lib/offline-context.tsx";

/** Shows the app once this server accepts our sign-in, and a pairing screen when it doesn't. */
export function Gate({ local, children }: { local: ServerConnection; children: ReactNode }) {
  const offline = useOffline();
  const info = useQuery({
    queryKey: keys.info("local"),
    queryFn: () => local.client.system.info({}),
    networkMode: "always",
    retry: (count, err) => !(err instanceof RpcError && err.code === "unauthorized") && count < 2,
  });
  if (info.isPending && offline.vault?.unlocked && offline.payload.conversations.length > 0)
    return children;
  if (
    (info.error ?? info.failureReason) instanceof TypeError &&
    offline.vault?.unlocked &&
    offline.payload.conversations.length > 0
  )
    return children;
  if (info.isPending) {
    return (
      <div className="flex h-full items-center justify-center text-faint">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }
  if (info.isError) {
    if (
      info.error instanceof TypeError &&
      offline.vault?.unlocked &&
      offline.payload.conversations.length > 0
    )
      return children;
    const unauthorised = info.error instanceof RpcError && info.error.code === "unauthorized";
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <Hamster
          look={{ ...defaultHamsterLook, eyes: "wide", background: "slate" }}
          size={88}
          status={unauthorised ? "idle" : "error"}
        />
        <h1 className="text-base font-semibold">
          {unauthorised ? "Who goes there?" : "Can't reach the server"}
        </h1>
        <p className="max-w-sm text-sm text-dim">
          {unauthorised
            ? "Open the pairing link from your nibblet server to sign in. The desktop app opens it for you, and Settings → Pair a device on any signed-in device makes a new one."
            : info.error.message}
        </p>
        {!unauthorised ? <Button onClick={() => void info.refetch()}>Try again</Button> : null}
      </div>
    );
  }
  return children;
}
