import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, LoaderCircle, Network } from "lucide-react";
import {
  tailnetHostname,
  TailnetPort,
  type Nibblet,
  type NibbletTailscale,
} from "@nibblets/protocol";
import type { ServerConnection } from "../../lib/connection.ts";
import { keys } from "../../lib/servers.tsx";
import { Button } from "../ui/Button.tsx";
import { FieldRow, Input, SectionHeading } from "../ui/Field.tsx";
import { Switch } from "../ui/Switch.tsx";

const KEYS_URL = "https://login.tailscale.com/admin/settings/keys";

interface Draft {
  /** Empty keeps the saved key. */
  authKey: string;
  hostname: string;
  ports: string;
}

const draftOf = (t: NibbletTailscale | null): Draft => ({
  authKey: "",
  hostname: t?.hostname ?? "",
  ports: t?.ports.join(", ") ?? "",
});

/** The ports typed in, or what's wrong with them. */
export function parsePorts(text: string): { ports: number[] } | { error: string } {
  const ports: number[] = [];
  for (const part of text.split(/[\s,]+/).filter(Boolean)) {
    const parsed = TailnetPort.safeParse(Number(part));
    if (!parsed.success) {
      const issue = parsed.error.issues[0]?.message;
      return { error: `${part}: ${issue && !/expected/i.test(issue) ? issue : "not a port"}` };
    }
    ports.push(parsed.data);
  }
  return { ports };
}

/**
 * Puts one nibblet on the user's tailnet as a machine of its own, with the
 * ports they choose shared there. A sub-agent is on it as its parent's
 * container, so it has nothing to set.
 */
export function TailscaleSection({
  connection,
  nibblet,
}: {
  connection: ServerConnection;
  nibblet: Nibblet;
}) {
  const saved = nibblet.tailscale;
  const [open, setOpen] = useState(saved !== null);
  const [draft, setDraft] = useState<Draft>(() => draftOf(saved));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const oauth = useQuery({
    queryKey: keys.tailnetKeys(connection.id),
    queryFn: () => connection.client.tailscale.keys({}),
  }).data?.oauth;

  useEffect(() => {
    setOpen(saved !== null);
    setDraft(draftOf(saved));
    setError(null);
  }, [nibblet.id, JSON.stringify(saved)]);

  if (nibblet.parentId) return null;

  const update = (tailscale: NibbletTailscale | null) =>
    connection.client.nibblets.update({ id: nibblet.id, tailscale });
  const ports = parsePorts(draft.ports);
  const dirty =
    saved === null ||
    draft.authKey.trim() !== "" ||
    draft.hostname !== saved.hostname ||
    ("ports" in ports && ports.ports.join(",") !== saved.ports.join(","));
  const running = nibblet.status !== "stopped";
  // Its own key comes back masked; one the server makes for it, empty.
  const ownKey = Boolean(saved?.authKey);

  const save = async () => {
    if ("error" in ports) return;
    setSaving(true);
    setError(null);
    try {
      await update({
        authKey: draft.authKey.trim() || saved?.authKey || "",
        hostname: draft.hostname.trim(),
        ports: ports.ports,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (on: boolean) => {
    setError(null);
    if (on || saved === null) {
      setOpen(on);
      if (!on) setDraft(draftOf(null));
      return;
    }
    try {
      await update(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <>
      <SectionHeading>Tailscale</SectionHeading>
      <FieldRow
        label="Tailnet"
        hint="Its own machine on your tailnet, for you to reach what it runs."
      >
        <Switch checked={open} onChange={(on) => void toggle(on)} label="Join a tailnet" />
      </FieldRow>
      {open ? (
        <>
          {saved && nibblet.tailnetNode && running && nibblet.status !== "error" ? (
            <NodeStatus nibblet={nibblet} />
          ) : null}
          <FieldRow label="Auth key">
            <Input
              type="password"
              autoComplete="off"
              value={draft.authKey}
              onChange={(e) => setDraft({ ...draft, authKey: e.target.value })}
              placeholder={
                ownKey
                  ? "Saved. Paste a new one to replace it"
                  : oauth
                    ? "None needed: one's made for it"
                    : "tskey-auth-…"
              }
            />
            <span className="text-xs text-faint">
              {oauth && !ownKey ? (
                <>
                  Your OAuth client in Settings makes one, tagged {oauth.tags.join(", ")}, when it
                  joins. Paste one only to use your own.
                </>
              ) : (
                <>
                  Make one in{" "}
                  <a href={KEYS_URL} target="_blank" rel="noreferrer" className="text-accent">
                    Tailscale's admin console
                  </a>
                  , or set up an OAuth client in Settings to have them made for you. It's only used
                  to join: it stays signed in after that.
                </>
              )}
            </span>
          </FieldRow>
          <FieldRow label="Machine name">
            <Input
              value={draft.hostname}
              onChange={(e) => setDraft({ ...draft, hostname: e.target.value.toLowerCase() })}
              placeholder={tailnetHostname(nibblet.name)}
              maxLength={63}
            />
          </FieldRow>
          <FieldRow
            label="Ports"
            hint="What your tailnet can reach, like 3000, 8080. Nothing else in its container is."
          >
            <Input
              value={draft.ports}
              onChange={(e) => setDraft({ ...draft, ports: e.target.value })}
              placeholder="None"
            />
          </FieldRow>
          {dirty || error || "error" in ports ? (
            <div className="flex flex-wrap items-center justify-end gap-1.5 sm:pl-[7.75rem]">
              <span
                className={`mr-auto text-xs ${error || "error" in ports ? "text-danger" : "text-faint"}`}
              >
                {error
                  ? `Couldn't save: ${error}`
                  : "error" in ports
                    ? ports.error
                    : running
                      ? "Saving restarts its container."
                      : "It joins when it wakes up."}
              </span>
              {saved ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={saving}
                  onClick={() => {
                    setDraft(draftOf(saved));
                    setError(null);
                  }}
                >
                  Undo
                </Button>
              ) : null}
              <Button
                variant="primary"
                size="sm"
                disabled={
                  !dirty ||
                  saving ||
                  "error" in ports ||
                  (!saved && !oauth && !draft.authKey.trim())
                }
                onClick={() => void save()}
              >
                {saving ? "Saving…" : saved ? "Save" : "Join"}
              </Button>
            </div>
          ) : null}
        </>
      ) : error ? (
        <span className="text-xs text-danger sm:pl-[7.75rem]">{error}</span>
      ) : null}
    </>
  );
}

function NodeStatus({ nibblet }: { nibblet: Nibblet }) {
  const node = nibblet.tailnetNode;
  const state = node?.state ?? "starting";
  const where = node ? [node.dnsName, ...node.ips].filter(Boolean).join(" · ") : "";
  return (
    <div className="flex items-start gap-2 rounded-lg border border-line bg-surface p-2.5 text-xs">
      {state === "running" ? (
        <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-ok" />
      ) : state === "starting" ? (
        <LoaderCircle className="mt-0.5 size-3.5 shrink-0 animate-spin text-faint" />
      ) : (
        <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-danger" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-medium">
          {state === "running"
            ? `On ${node?.tailnet ?? "your tailnet"}`
            : state === "starting"
              ? "Joining…"
              : "Not on your tailnet"}
        </span>
        {state === "running" && where ? (
          <span className="flex items-center gap-1 truncate text-dim">
            <Network className="size-3 shrink-0" />
            <span className="truncate select-all">{where}</span>
          </span>
        ) : null}
        {node?.detail ? <span className="text-dim">{node.detail}</span> : null}
      </div>
    </div>
  );
}
