import { useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ClerkProvider, SignIn, useAuth } from "@clerk/react";
import { Loader2 } from "lucide-react";
import { defaultHamsterLook } from "@nibblet/protocol";
import { centralApi, loadCentralConfig, type CentralApi } from "../lib/central.ts";
import { CentralServers } from "../lib/servers.tsx";
import { Hamster } from "./hamster/Hamster.tsx";
import { Button } from "./ui/Button.tsx";

/**
 * Nibblets Connect's UI: sign in with Clerk, then every server on the account.
 * Under `wrangler dev` with DEV_AUTH_USER the central service signs requests
 * in itself, so Clerk is skipped.
 */
export function CentralApp({ children }: { children: ReactNode }) {
  const config = useQuery({ queryKey: ["central", "config"], queryFn: loadCentralConfig });
  if (config.isPending) return <Spinner />;
  if (config.isError) {
    return (
      <Message title="Can't reach Nibblets Connect" text={config.error.message}>
        <Button onClick={() => void config.refetch()}>Try again</Button>
      </Message>
    );
  }
  if (config.data.devAuth) return <DevSignedIn>{children}</DevSignedIn>;
  return (
    <ClerkProvider publishableKey={config.data.clerkPublishableKey}>
      <ClerkSignedIn>{children}</ClerkSignedIn>
    </ClerkProvider>
  );
}

function DevSignedIn({ children }: { children: ReactNode }) {
  const api = useMemo(() => centralApi(async () => null), []);
  return <CentralServers api={api}>{children}</CentralServers>;
}

function ClerkSignedIn({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const api = useMemo<CentralApi>(() => centralApi(() => getToken()), [getToken]);
  if (!isLoaded) return <Spinner />;
  if (!isSignedIn) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-5 bg-bg p-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <Hamster look={{ ...defaultHamsterLook, accessory: "party_hat" }} size={72} />
          <h1 className="text-lg font-semibold">Nibblets</h1>
          <p className="max-w-xs text-sm text-dim">
            Sign in to see the nibblets on every computer you've connected.
          </p>
        </div>
        {/* Come back to the page that asked, so a /link?code= approval survives sign-in. */}
        <SignIn
          routing="hash"
          forceRedirectUrl={window.location.pathname + window.location.search}
          signUpForceRedirectUrl={window.location.pathname + window.location.search}
        />
      </div>
    );
  }
  return <CentralServers api={api}>{children}</CentralServers>;
}

function Spinner() {
  return (
    <div className="flex h-full items-center justify-center bg-bg text-faint">
      <Loader2 className="size-5 animate-spin" />
    </div>
  );
}

function Message({ title, text, children }: { title: string; text: string; children?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-bg p-8 text-center">
      <Hamster look={{ ...defaultHamsterLook, eyes: "wide" }} size={80} status="error" />
      <h1 className="text-base font-semibold">{title}</h1>
      <p className="max-w-sm text-sm text-dim">{text}</p>
      {children}
    </div>
  );
}
