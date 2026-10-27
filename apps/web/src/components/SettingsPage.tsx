import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Copy, Link2, XCircle } from "lucide-react";
import type { CredentialStatus } from "@nibblets/protocol";
import type { ServerConnection } from "../lib/connection.ts";
import { AccountSection, RemoteAccessSection } from "./RemoteAccess.tsx";
import { TailnetKeysSection } from "./TailnetKeysSection.tsx";
import { BankSection } from "./bank/BankSection.tsx";
import { AppLinksSection } from "./applinks/AppLinksSection.tsx";
import { keys, useServers } from "../lib/servers.tsx";
import { clockTime, relativeTime } from "../lib/time.ts";
import { Button } from "./ui/Button.tsx";
import { OnePasswordSettings } from "./onepassword/OnePasswordSection.tsx";
import { FieldRow, Input, SectionHeading, Textarea } from "./ui/Field.tsx";
import { Segmented } from "./ui/Segmented.tsx";
import { MobileBack } from "./MobileBack.tsx";
import { NotificationsSection } from "./NotificationsSection.tsx";
import { UpdatesSection } from "./UpdatesSection.tsx";
import { MachinesSection } from "./MachinesSection.tsx";
import { hostToolSummary } from "./tools/NibbletTools.tsx";

export function SettingsPage() {
  const { all, central, systems } = useServers();
  const [selected, setSelected] = useState<string | null>(null);
  const connection = all.find((c) => c.id === selected) ?? all[0] ?? null;
  return (
    <div className="safe-top min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[40rem] flex-col gap-2 px-5 pt-6 safe-bottom-10 max-sm:px-4">
        <h1 className="flex items-center gap-1 text-lg font-semibold">
          <MobileBack />
          Settings
        </h1>
        {central ? <AccountSection /> : null}
        {connection ? (
          central || all.length > 1 ? (
            // A box per server, its picker on the border, so it's clear what
            // changes with the server and what's the account's.
            <fieldset className="mt-3 flex min-w-0 flex-col gap-2 rounded-lg border border-line px-4 pb-4 max-sm:px-3">
              <legend className="-ml-1.5 px-1.5">
                <Segmented
                  value={connection.id}
                  onChange={setSelected}
                  options={all.map((c) => ({
                    value: c.id,
                    label: systems.find((s) => s.id === c.id)?.name ?? c.id,
                  }))}
                />
              </legend>
              <ServerSettings connection={connection} />
            </fieldset>
          ) : (
            <ServerSettings connection={connection} />
          )
        ) : (
          <p className="text-sm text-dim">None of your servers can be reached right now.</p>
        )}
        {central ? <NotificationsSection /> : null}
      </div>
    </div>
  );
}

/** Everything in Settings that's one server's, for the one picked. */
function ServerSettings({ connection }: { connection: ServerConnection }) {
  return (
    <>
      <ServerSection connection={connection} />
      <SystemPromptSection connection={connection} />
      <UpdatesSection connection={connection} />
      <CredentialsSection connection={connection} />
      <HostToolsSection connection={connection} />
      <MachinesSection connection={connection} />
      <OnePasswordSettings connection={connection} />
      <AppLinksSection connection={connection} />
      <BankSection connection={connection} />
      <RemoteAccessSection connection={connection} />
      <TailnetKeysSection connection={connection} />
      <PairingSection connection={connection} />
    </>
  );
}

function ServerSection({ connection }: { connection: ServerConnection }) {
  const qc = useQueryClient();
  const info = useQuery({
    queryKey: keys.info(connection.id),
    queryFn: () => connection.client.system.info({}),
  });
  const [name, setName] = useState("");
  useEffect(() => {
    if (info.data) setName(info.data.name);
  }, [info.data]);
  return (
    <>
      <SectionHeading>Server</SectionHeading>
      <FieldRow label="Name" hint="Shown when you look at nibblets from several servers.">
        <div className="flex gap-1.5">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
          <Button
            disabled={!name.trim() || name === info.data?.name}
            onClick={async () => {
              await connection.client.system.rename({ name: name.trim() });
              void qc.invalidateQueries({ queryKey: keys.info(connection.id) });
              void qc.invalidateQueries({ queryKey: keys.centralServers() });
            }}
          >
            Rename
          </Button>
        </div>
      </FieldRow>
      <FieldRow label="Version">
        <span className="text-sm text-dim">{info.data?.version ?? "…"}</span>
      </FieldRow>
    </>
  );
}

/** Extra text for every nibblet's system prompt on this server. */
function SystemPromptSection({ connection }: { connection: ServerConnection }) {
  const qc = useQueryClient();
  const saved = useQuery({
    queryKey: keys.systemPrompt(connection.id),
    queryFn: () => connection.client.system.systemPrompt({}),
  });
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (saved.data) setText(saved.data.text);
  }, [saved.data]);
  const dirty = saved.data !== undefined && text !== saved.data.text;
  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);
    try {
      await connection.client.system.setSystemPrompt({ text });
      await qc.invalidateQueries({ queryKey: keys.systemPrompt(connection.id) });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <SectionHeading>System prompt</SectionHeading>
      <FieldRow
        label="Add to it"
        top
        hint="Every nibblet on this server is told this, from its next turn. Its own instructions stay its own."
      >
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void save();
            }
          }}
          placeholder="I live in Berlin. Write in British English."
          maxLength={20_000}
          disabled={!saved.data}
          className="min-h-24"
        />
      </FieldRow>
      {dirty || error ? (
        <div className="flex flex-wrap items-center justify-end gap-1.5 sm:pl-[7.75rem]">
          {error ? (
            <span className="mr-auto text-xs text-danger">Couldn't save: {error}</span>
          ) : (
            <span className="mr-auto text-xs text-faint">Unsaved changes</span>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setText(saved.data?.text ?? "");
              setError(null);
            }}
            disabled={saving}
          >
            Undo
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!dirty || saving}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      ) : null}
    </>
  );
}

const providerNames: Record<CredentialStatus["provider"], string> = {
  anthropic: "Claude",
  openai: "ChatGPT",
  deepseek: "DeepSeek API",
};

/** Claude and ChatGPT can be an API key instead of a subscription. */
const keyNames: Partial<Record<CredentialStatus["provider"], string>> = {
  anthropic: "Anthropic API",
  openai: "OpenAI API",
};

const providerName = (c: CredentialStatus) =>
  (c.source === "env" ? keyNames[c.provider] : undefined) ?? providerNames[c.provider];

/** DeepSeek is an optional extra, so it's only listed once its key is set. */
const listed = (c: CredentialStatus) => c.provider !== "deepseek" || c.source !== "none";

function CredentialsSection({ connection }: { connection: ServerConnection }) {
  // Kept live, so signing in again on the host shows up without a reload.
  const info = useQuery({
    queryKey: keys.info(connection.id),
    queryFn: () => connection.client.system.info({}),
    refetchInterval: 5000,
    refetchOnWindowFocus: "always",
  });
  return (
    <>
      <SectionHeading>Subscriptions</SectionHeading>
      <p className="text-xs text-faint">
        Your nibblets run on the Claude and ChatGPT subscriptions you're signed in to on this
        computer, or on API keys set when Nibblets was installed.
      </p>
      {info.data?.credentials.filter(listed).map((c) => (
        <div
          key={c.provider}
          className="flex items-start gap-2.5 rounded-md border border-line bg-surface px-2.5 py-2"
        >
          {c.ok ? (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" />
          ) : (
            <XCircle className="mt-0.5 size-4 shrink-0 text-danger" />
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-sm font-medium">
              {providerName(c)}
              {c.plan ? (
                <span className="ml-1.5 font-normal text-dim">{planLabel(c.plan)}</span>
              ) : null}
            </span>
            <span className="text-xs text-dim">
              {!c.ok
                ? signInHelp[c.provider]
                : c.limitedUntil
                  ? `Connected · usage limit reached, resets at ${clockTime(c.limitedUntil)}`
                  : "Connected"}
            </span>
            <details className="text-2xs text-faint">
              <summary className="cursor-pointer select-none hover:text-dim">Details</summary>
              <div className="mt-1 break-all">
                {c.detail}
                {c.source === "env"
                  ? " · from the server's settings"
                  : c.source !== "none"
                    ? ` · from the ${c.source}`
                    : ""}
                {c.expiresAt ? ` · token renews ${relativeTime(c.expiresAt)}` : ""}
              </div>
            </details>
          </div>
        </div>
      ))}
    </>
  );
}

/** What to do when a subscription isn't connected, in words for anyone. */
const signInHelp: Record<CredentialStatus["provider"], string> = {
  anthropic:
    "Not connected. Sign in to Claude Code on this computer, or add an Anthropic API key, then reopen Nibblets.",
  openai:
    "Not connected. Sign in to Codex with your ChatGPT account, or add an OpenAI API key, then reopen Nibblets.",
  deepseek: "No API key. Set DEEPSEEK_API_KEY in the server's .env, then restart Nibblets.",
};

function planLabel(plan: string): string {
  return `${plan.charAt(0).toUpperCase()}${plan.slice(1)} plan`;
}

function PairingSection({ connection }: { connection: ServerConnection }) {
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);
  return (
    <>
      <SectionHeading>Pair a device</SectionHeading>
      <p className="text-xs text-faint">
        Open this link on a phone or laptop on the same network to sign it in to this server
        directly. It works once.
      </p>
      {link ? (
        <div className="flex items-center gap-1.5">
          <Input
            readOnly
            value={link.url}
            onFocus={(e) => e.currentTarget.select()}
            className="font-mono text-xs"
          />
          <Button
            size="sm"
            onClick={() => {
              void navigator.clipboard.writeText(link.url).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            <Copy />
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={async () => setLink(await connection.client.auth.createPairingLink({}))}
        >
          <Link2 />
          {link ? "New link" : "Create pairing link"}
        </Button>
        {link ? (
          <span className="text-2xs text-faint">Expires {relativeTime(link.expiresAt)}</span>
        ) : null}
      </div>
    </>
  );
}

function StatusRow({ ok, title, detail }: { ok: boolean; title: React.ReactNode; detail: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-md border border-line bg-surface px-2.5 py-2">
      {ok ? (
        <CheckCircle2 className="size-4 text-ok" />
      ) : (
        <XCircle className="size-4 text-danger" />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium">{title}</span>
        <span className="truncate text-2xs text-faint">{detail}</span>
      </div>
    </div>
  );
}

/** The host bridge: MCP servers and CLI logins each nibblet can be given. */
function HostToolsSection({ connection }: { connection: ServerConnection }) {
  const tools = useQuery({
    queryKey: keys.hostTools(connection.id),
    queryFn: () => connection.client.hostTools.list({}),
  });
  const clis = useQuery({
    queryKey: keys.clis(connection.id),
    queryFn: () => connection.client.clis.list({}),
  });
  return (
    <>
      <SectionHeading>Host tools</SectionHeading>
      <p className="text-xs text-faint">
        MCP servers and CLI logins on this computer. Nibblets only get the ones you tick for them.
        Add servers to <code className="font-mono">~/.nibblet/host-mcp.json</code> in the{" "}
        <code className="font-mono">mcpServers</code> format; ones set up in Claude Code or Claude
        Desktop are picked up too.
      </p>
      {tools.data && !tools.data.connected ? (
        <StatusRow ok={false} title="Host bridge" detail={tools.data.detail ?? "Not connected"} />
      ) : null}
      {tools.data?.servers.map((s) => (
        <StatusRow
          key={s.name}
          ok={s.status !== "error"}
          title={
            <>
              {s.name}
              <span className="ml-1.5 font-normal text-dim">{s.transport}</span>
            </>
          }
          detail={hostToolSummary(s)}
        />
      ))}
      {clis.data?.clis
        .filter((c) => c.installed)
        .map((c) => (
          <StatusRow
            key={c.id}
            ok={c.signedIn}
            title={c.label}
            detail={
              !c.signedIn
                ? (c.detail ?? "Signed out")
                : c.id === "ssh"
                  ? `${c.account ?? "Keys"} available to share`
                  : `Signed in as ${c.account ?? "you"}`
            }
          />
        ))}
    </>
  );
}
