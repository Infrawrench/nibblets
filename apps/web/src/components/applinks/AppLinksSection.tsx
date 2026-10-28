import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Link2, Unlink } from "lucide-react";
import type { AppLink, AppLinkAttempt, AppLinkKind, LiveMessage } from "@nibblets/protocol";
import type { ServerConnection } from "../../lib/connection.ts";
import { approvalPage, outcomeText } from "../../lib/appLinks.ts";
import { keys } from "../../lib/servers.tsx";
import { relativeTime } from "../../lib/time.ts";
import { Button } from "../ui/Button.tsx";
import { FieldRow, Input, SectionHeading } from "../ui/Field.tsx";

/** The server's app links and the plugins it has, for Settings and a nibblet's settings. */
export function useAppLinks(connection: ServerConnection) {
  const plugins = useQuery({
    queryKey: keys.appLinkPlugins(connection.id),
    queryFn: () => connection.client.appLinks.plugins({}),
    staleTime: Infinity,
  });
  const links = useQuery({
    queryKey: keys.appLinks(connection.id),
    queryFn: () => connection.client.appLinks.list({}),
  });
  return { plugins, links };
}

/** A plugin's logo, from the server. */
export function AppIcon({ kind, size = 24 }: { kind: AppLinkKind | undefined; size?: number }) {
  if (!kind)
    return <span className="shrink-0 rounded bg-deep" style={{ width: size, height: size }} />;
  return <img src={kind.icon} alt="" width={size} height={size} className="shrink-0 rounded" />;
}

/**
 * Settings → Linked apps: linking this server to other apps once, so its
 * nibblets can each be given an identity of their own there. Every app is
 * a plugin on the server, which says what it's called, what it needs, and
 * what it may grant; nothing here knows one from another.
 */
export function AppLinksSection({ connection }: { connection: ServerConnection }) {
  const { plugins, links } = useAppLinks(connection);
  const kinds = plugins.data ?? [];
  if (kinds.length === 0) return null;
  const list = links.data?.links ?? [];
  return (
    <>
      <SectionHeading>Linked apps</SectionHeading>
      <p className="text-xs text-faint">
        Link this server to an app once, approving it there. Then turn the app on for a nibblet in
        its settings, and tick what it may do: it gets its own identity in the app, and its
        credentials stay on this server and in its container's guard.
      </p>
      {kinds.map((kind) => (
        <PluginRow
          key={kind.id}
          connection={connection}
          kind={kind}
          links={list.filter((l) => l.plugin === kind.id)}
          attempts={(links.data?.attempts ?? []).filter((a) => a.plugin === kind.id)}
        />
      ))}
    </>
  );
}

function PluginRow({
  connection,
  kind,
  links,
  attempts,
}: {
  connection: ServerConnection;
  kind: AppLinkKind;
  links: readonly AppLink[];
  attempts: readonly AppLinkAttempt[];
}) {
  const qc = useQueryClient();
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The attempt last started here, to say how it ended. */
  const [lastAttempt, setLastAttempt] = useState<string | null>(null);
  const settled = useQuery({
    queryKey: keys.appLinkSettled(connection.id, lastAttempt ?? ""),
    queryFn: (): Extract<LiveMessage, { type: "app_link_settled" }> | null => null,
    enabled: false,
    staleTime: Infinity,
  });
  const ended = lastAttempt ? settled.data : null;
  const said = ended ? outcomeText(ended.outcome, kind.name, ended.detail) : null;

  const link = async () => {
    setError(null);
    setStarting(true);
    // Opened now, while the click still counts, and pointed at the app once there's a code.
    const tab = window.open("about:blank", "_blank");
    try {
      const attempt = await connection.client.appLinks.begin({
        plugin: kind.id,
        settings,
        // Where an app the person signs in to sends them back: this server, as this browser has it.
        serverUrl: connection.base() || window.location.origin,
      });
      setLastAttempt(attempt.id);
      const page = approvalPage(attempt);
      if (tab && page) {
        tab.opener = null;
        tab.location.href = page;
      } else {
        tab?.close();
      }
      void qc.invalidateQueries({ queryKey: keys.appLinks(connection.id) });
    } catch (err) {
      tab?.close();
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border border-line bg-surface px-2.5 py-2">
      <div className="flex items-center gap-2.5">
        <AppIcon kind={kind} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-medium">{kind.name}</span>
          <span className="text-xs text-dim">{kind.description}</span>
        </div>
        {attempts.length === 0 ? (
          <Button size="sm" disabled={starting} onClick={() => void link()}>
            <Link2 />
            {starting ? "Starting…" : links.length > 0 ? "Link another" : "Link"}
          </Button>
        ) : null}
      </div>
      {attempts.map((attempt) => (
        <AttemptRow key={attempt.id} connection={connection} kind={kind} attempt={attempt} />
      ))}
      {links.map((l) => (
        <LinkRow key={l.id} connection={connection} link={l} />
      ))}
      {kind.fields.length > 0 && attempts.length === 0 ? (
        <details className="text-2xs text-faint">
          <summary className="cursor-pointer select-none hover:text-dim">
            Settings for linking
          </summary>
          <div className="mt-1.5 flex flex-col gap-1.5">
            {kind.fields.map((field) => (
              <FieldRow key={field.key} label={field.label} hint={field.hint ?? undefined}>
                <Input
                  value={settings[field.key] ?? ""}
                  placeholder={field.placeholder ?? field.default ?? undefined}
                  onChange={(e) => setSettings({ ...settings, [field.key]: e.target.value })}
                />
              </FieldRow>
            ))}
          </div>
        </details>
      ) : null}
      {said ? <p className="text-xs text-warning">{said}</p> : null}
      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </div>
  );
}

/** A code waiting to be approved in the app, or a sign-in there. */
function AttemptRow({
  connection,
  kind,
  attempt,
}: {
  connection: ServerConnection;
  kind: AppLinkKind;
  attempt: AppLinkAttempt;
}) {
  const url = approvalPage(attempt);
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-line bg-deep px-2.5 py-2">
      {attempt.userCode !== null ? (
        <>
          <span className="text-xs text-dim">
            Approve this code in {kind.name}. Only approve it there if you started it here.
          </span>
          <span className="font-mono text-lg font-semibold tracking-widest">
            {attempt.userCode}
          </span>
        </>
      ) : (
        <span className="text-xs text-dim">
          Sign in to {kind.name} in the tab that opened, and approve Nibblets there. Only approve it
          if you started it here.
        </span>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-accent hover:underline [&_svg]:size-3"
          >
            <ExternalLink />
            Open {kind.name}
          </a>
        ) : null}
        <span className="text-2xs text-faint">
          · waiting · {attempt.userCode !== null ? "the code runs out" : "it runs out"}{" "}
          {relativeTime(attempt.expiresAt)}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          onClick={() => void connection.client.appLinks.cancel({ id: attempt.id })}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

function LinkRow({ connection, link }: { connection: ServerConnection; link: AppLink }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state =
    link.state === "revoked"
      ? { text: link.detail ?? "Revoked in the app", tone: "text-danger" }
      : link.state === "removing"
        ? { text: link.detail ?? "Being unlinked", tone: "text-faint" }
        : { text: `Linked ${relativeTime(link.createdAt)}`, tone: "text-faint" };
  return (
    <div className="flex items-center gap-2.5 border-t border-line pt-2">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm">
          {link.account}
          <span className="ml-1.5 font-mono text-2xs text-faint">{link.name}</span>
        </span>
        <span className={`text-2xs ${state.tone}`}>{state.text}</span>
        {error ? <span className="text-xs text-danger">{error}</span> : null}
      </div>
      {link.state !== "removing" ? (
        <Button
          size="sm"
          variant="danger"
          disabled={busy}
          title="Revokes the link, and every nibblet's identity on it, in the app"
          onBlur={() => setConfirm(false)}
          onClick={async () => {
            if (!confirm) {
              setConfirm(true);
              return;
            }
            setBusy(true);
            setError(null);
            try {
              await connection.client.appLinks.remove({ id: link.id });
              void qc.invalidateQueries({ queryKey: keys.appLinks(connection.id) });
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            } finally {
              setBusy(false);
              setConfirm(false);
            }
          }}
        >
          <Unlink />
          {confirm ? "Really unlink?" : "Unlink"}
        </Button>
      ) : null}
    </div>
  );
}
