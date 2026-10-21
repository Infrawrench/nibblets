import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Loader2, MapPin, Monitor, ShieldAlert } from "lucide-react";
import { z } from "zod";
import { defaultHamsterLook } from "@nibblets/protocol";
import { Hamster } from "../components/hamster/Hamster.tsx";
import { Button } from "../components/ui/Button.tsx";
import { useServers } from "../lib/servers.tsx";
import { relativeTime } from "../lib/time.ts";

/**
 * Approving a server that asked to join the account, like T3 Connect's device
 * code page: check the code matches what the server shows, then approve.
 */
export const Route = createFileRoute("/link")({
  validateSearch: z.object({ code: z.string().default("") }),
  component: function LinkPage() {
    const { code } = Route.useSearch();
    const { central } = useServers();
    const navigate = useNavigate();
    const [done, setDone] = useState<"approved" | "denied" | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [mine, setMine] = useState(false);
    const pending = useQuery({
      queryKey: ["central", "link", code],
      queryFn: () => {
        if (!central) throw new Error("Not signed in to Nibblets Connect");
        return central.api.pendingLink(code);
      },
      enabled: central !== null && code !== "",
      retry: false,
    });

    if (!central) {
      return (
        <Centred>
          <p className="text-sm text-dim">
            Approving a server happens on Nibblets Connect, signed in to your account.
          </p>
        </Centred>
      );
    }
    if (done) {
      return (
        <Centred>
          <CheckCircle2 className="size-8 text-ok" />
          <h1 className="text-base font-semibold">
            {done === "approved" ? "Connected" : "Turned away"}
          </h1>
          <p className="max-w-xs text-sm text-dim">
            {done === "approved"
              ? "It'll appear in your list in a moment, once it checks in."
              : "That server won't be connected to your account."}
          </p>
          <Button onClick={() => void navigate({ to: "/" })}>Done</Button>
        </Centred>
      );
    }
    if (pending.isPending && code) {
      return (
        <Centred>
          <Loader2 className="size-5 animate-spin text-faint" />
        </Centred>
      );
    }
    if (!pending.data) {
      return (
        <Centred>
          <h1 className="text-base font-semibold">That code didn't work</h1>
          <p className="max-w-xs text-sm text-dim">
            {pending.error?.message ?? "Open the link from the server's Settings → Connect."}
          </p>
        </Centred>
      );
    }
    const link = pending.data;
    const decide = async (approve: boolean) => {
      setBusy(true);
      setError(null);
      try {
        if (approve) await central.api.approve(link.code, mine);
        else await central.api.deny(link.code);
        central.refresh();
        setDone(approve ? "approved" : "denied");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    };
    return (
      <Centred>
        <Hamster look={{ ...defaultHamsterLook, accessory: "headphones" }} size={64} />
        <h1 className="text-base font-semibold">Connect this server to your account?</h1>
        <div className="flex w-full max-w-sm flex-col gap-2 rounded-lg border border-line bg-surface p-3 text-left">
          <div className="flex items-center gap-2">
            <Monitor className="size-4 text-faint" />
            <span className="font-medium">{link.name}</span>
            <span className="truncate text-xs text-faint">{link.hostname}</span>
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-xs text-dim">Code</span>
            <span className="font-mono text-lg font-semibold tracking-[0.2em]">{link.code}</span>
          </div>
          <span className="text-2xs text-faint">
            Check it matches the code on the server. Expires {relativeTime(link.expiresAt)}.
          </span>
          {link.location ? (
            <span className="flex items-center gap-1.5 text-2xs text-faint">
              <MapPin className="size-3" />
              Asked from {link.location}
              {link.sameNetwork ? ", on the network you're on now" : ""}
            </span>
          ) : null}
        </div>
        {link.sameNetwork ? null : (
          <div className="flex w-full max-w-sm flex-col gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-left">
            <span className="flex items-center gap-1.5 text-sm font-medium text-warning">
              <ShieldAlert className="size-4" />
              This came from a different network
            </span>
            <span className="text-xs text-dim">
              That's expected for a server or VM somewhere else. But if someone sent you this link,
              don't connect it: their server would see your nibblets' updates and could message your
              devices.
            </span>
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />I
              started this on my own computer just now
            </label>
          </div>
        )}
        <p className="max-w-sm text-xs text-dim">
          Signed in as {central.user.name}. Its nibblets will show up here, and you'll be able to
          use them from anywhere you sign in.
        </p>
        <div className="flex gap-2">
          <Button disabled={busy} onClick={() => void decide(false)}>
            Not mine
          </Button>
          <Button
            variant="primary"
            disabled={busy || (!link.sameNetwork && !mine)}
            onClick={() => void decide(true)}
          >
            {busy ? <Loader2 className="animate-spin" /> : null}
            Connect
          </Button>
        </div>
        {error ? <p className="text-xs text-danger">{error}</p> : null}
      </Centred>
    );
  },
});

function Centred({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 overflow-y-auto p-8 text-center">
      {children}
    </div>
  );
}
