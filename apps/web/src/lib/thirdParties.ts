import { useQuery } from "@tanstack/react-query";
import {
  isWebUrl,
  type ThirdParty,
  type ThirdPartyKind,
  type ThirdPartyList,
  type ThirdPartyMessage,
} from "@nibblets/protocol";
import type { ThirdPartiesApi } from "./central.ts";
import { keys, useServers } from "./servers.tsx";

/*
 * Third parties in the UI: other companies' agents connected to the
 * account in Nibblets Connect, listed beside the nibblets. Only in central
 * mode, since Connect is what holds their credentials and talks to them.
 */

/** How often the list (and so the sidebar) asks what each one is up to. */
const LIST_EVERY_MS = 30_000;

/** Connect's third-party API, when signed in to Connect; null on a server of its own. */
export function useThirdPartiesApi(): ThirdPartiesApi | null {
  return useServers().central?.api.thirdParties ?? null;
}

/** The connected third parties and what Connect offers, kept fresh for the sidebar. */
export function useThirdParties(options: { every?: number } = {}) {
  const api = useThirdPartiesApi();
  return useQuery({
    queryKey: keys.thirdParties(),
    queryFn: (): Promise<ThirdPartyList> => {
      if (!api) throw new Error("Third parties are only in Nibblets Connect");
      return api.list();
    },
    enabled: api !== null,
    refetchInterval: options.every ?? LIST_EVERY_MS,
  });
}

/** A connected third party with the plugin that describes it, for rows and pages. */
export interface Connected {
  party: ThirdParty;
  kind: ThirdPartyKind;
}

/** Each connected third party with its kind; one whose plugin Connect dropped is left out. */
export function connected(list: ThirdPartyList | undefined): Connected[] {
  if (!list) return [];
  return list.parties.flatMap((party) => {
    const kind = list.kinds.find((k) => k.id === party.plugin);
    return kind ? [{ party, kind }] : [];
  });
}

/** What the sidebar says beside it, and in what tone. */
export function partyStatus(party: ThirdParty): {
  text: string;
  tone: "warning" | "working" | "danger" | "faint";
} | null {
  if (party.state === "revoked") return { text: "Reconnect", tone: "danger" };
  if (!party.activity) return party.problem ? { text: "Not answering", tone: "faint" } : null;
  if (party.activity.waiting > 0) {
    return { text: `${party.activity.waiting} to review`, tone: "warning" };
  }
  if (party.activity.working) return { text: "Working", tone: "working" };
  return null;
}

/** An id for a message, so sending it again (a retry) sends it once. */
export function newClientId(): string {
  return `web-${crypto.randomUUID()}`;
}

/** Sent from here and not in the conversation yet. */
export interface Outgoing {
  clientId: string;
  text: string;
  sentAt: number;
  failed: string | null;
}

/**
 * Which messages sent from here the conversation doesn't show yet: one is
 * there once a message from the person with its text turns up no earlier
 * than a minute before it was sent (clocks differ).
 */
export function stillOutgoing(
  outbox: readonly Outgoing[],
  thread: readonly ThirdPartyMessage[],
): Outgoing[] {
  const arrived = thread.filter((m) => m.role === "person");
  return outbox.filter(
    (o) =>
      o.failed !== null ||
      !arrived.some((m) => m.text.trim() === o.text && Date.parse(m.at) >= o.sentAt - 60_000),
  );
}

/** How long after the person's last message a reply is still looked for often. */
const REPLY_WITHIN_MS = 10 * 60_000;

/**
 * Whether the person spoke last, lately enough that a reply is likely on its
 * way: it can be a while before the third party says it's working on it.
 */
export function awaitingReply(thread: readonly ThirdPartyMessage[], now: number): boolean {
  const last = thread.at(-1);
  return last?.role === "person" && now - Date.parse(last.at) < REPLY_WITHIN_MS;
}

/**
 * Goes to the third party's site to sign in; it sends the person back to
 * Connect, on the new third party's page. In the desktop app the page opens
 * in the browser instead, and the window's list catches up.
 */
export async function signInTo(api: ThirdPartiesApi, plugin: string): Promise<void> {
  const url = await api.signIn(plugin);
  if (!isWebUrl(url)) throw new Error("Connect sent an address that isn't a web page");
  window.location.assign(url);
}
