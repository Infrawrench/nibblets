import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { CheckCircle2, Loader2 } from "lucide-react";
import { z } from "zod";
import { Button } from "../components/ui/Button.tsx";
import { desktopSignInLink } from "../lib/central.ts";
import { useServers } from "../lib/servers.tsx";

/**
 * Signing the desktop app in from the browser. The app opens this page with a
 * challenge (the hash of a secret it keeps) and a state; once signed in here,
 * the page leaves a sign-in for it and hands back the handle through the
 * app's own `nibblets:` link. Only the app with the secret can collect it.
 */
export const Route = createFileRoute("/desktop-sign-in")({
  validateSearch: z.object({
    state: z
      .string()
      .regex(/^[\w-]{16,100}$/)
      .catch(""),
    challenge: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .catch(""),
  }),
  component: function DesktopSignInPage() {
    const { state, challenge } = Route.useSearch();
    const { central } = useServers();
    const [link, setLink] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
      if (!central || !state || !challenge) return;
      let cancelled = false;
      void central.api
        .desktopSignIn(challenge)
        .then(({ handle }) => {
          if (cancelled) return;
          const next = desktopSignInLink(state, handle);
          setLink(next);
          window.location.href = next;
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        });
      return () => {
        cancelled = true;
      };
    }, [central, state, challenge]);

    if (!state || !challenge) {
      return (
        <Centred>
          <p className="max-w-xs text-sm text-dim">
            This page signs in the Nibblets app. Open it from the app's sign-in page.
          </p>
        </Centred>
      );
    }
    if (error) {
      return (
        <Centred>
          <p className="max-w-xs text-sm text-danger">{error}</p>
        </Centred>
      );
    }
    if (!link) {
      return (
        <Centred>
          <Loader2 className="size-5 animate-spin text-faint" />
        </Centred>
      );
    }
    return (
      <Centred>
        <CheckCircle2 className="size-8 text-ok" />
        <h1 className="text-base font-semibold">Signed in</h1>
        <p className="max-w-xs text-sm text-dim">
          Back to the Nibblets app to carry on. You can close this tab.
        </p>
        <Button onClick={() => (window.location.href = link)}>Open Nibblets</Button>
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
