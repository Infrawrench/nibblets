import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Copy, Link2, Loader2, Plus, Trash2, XCircle } from "lucide-react";
import type { CredentialStatus, TunnelConfig } from "@nibblet/protocol";
import { keys, useServers } from "../lib/servers.tsx";
import { relativeTime } from "../lib/time.ts";
import { Button } from "./ui/Button.tsx";
import { FieldRow, Input, SectionHeading } from "./ui/Field.tsx";
import { Segmented } from "./ui/Segmented.tsx";
import { cn } from "../lib/cn.ts";
import { hostToolSummary } from "./tools/NibbletTools.tsx";

export function SettingsPage() {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[40rem] flex-col gap-2 px-5 py-6">
        <h1 className="text-lg font-semibold">Settings</h1>
        <ServerSection />
        <CredentialsSection />
        <HostToolsSection />
        <TunnelSection />
        <PairingSection />
        <PeersSection />
      </div>
    </div>
  );
}

function ServerSection() {
  const { local } = useServers();
  const qc = useQueryClient();
  const info = useQuery({
    queryKey: keys.info("local"),
    queryFn: () => local.client.system.info({}),
  });
  const [name, setName] = useState("");
  useEffect(() => {
    if (info.data) setName(info.data.name);
  }, [info.data]);
  return (
    <>
      <SectionHeading>This server</SectionHeading>
      <FieldRow label="Name" hint="Shown when you look at nibblets from several servers.">
        <div className="flex gap-1.5">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
          <Button
            disabled={!name.trim() || name === info.data?.name}
            onClick={async () => {
              await local.client.system.rename({ name: name.trim() });
              void qc.invalidateQueries({ queryKey: keys.info("local") });
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

const providerNames: Record<CredentialStatus["provider"], string> = {
  anthropic: "Claude",
  openai: "ChatGPT",
};

function CredentialsSection() {
  const { local } = useServers();
  const info = useQuery({
    queryKey: keys.info("local"),
    queryFn: () => local.client.system.info({}),
  });
  return (
    <>
      <SectionHeading>Subscriptions</SectionHeading>
      <p className="text-xs text-faint">
        Nibblets use this computer's Claude and ChatGPT sign-ins through the credential proxy. Sign
        in with <code className="font-mono">claude</code> or{" "}
        <code className="font-mono">codex login</code> on the host.
      </p>
      {info.data?.credentials.map((c) => (
        <div
          key={c.provider}
          className="flex items-center gap-2.5 rounded-md border border-line bg-surface px-2.5 py-2"
        >
          {c.ok ? (
            <CheckCircle2 className="size-4 text-ok" />
          ) : (
            <XCircle className="size-4 text-danger" />
          )}
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium">
              {providerNames[c.provider]}
              {c.plan ? (
                <span className="ml-1.5 font-normal text-dim capitalize">{c.plan}</span>
              ) : null}
            </span>
            <span className="truncate text-2xs text-faint">
              {c.detail}
              {c.source !== "none" ? ` · from the ${c.source}` : ""}
              {c.expiresAt ? ` · token renews ${relativeTime(c.expiresAt)}` : ""}
            </span>
          </div>
        </div>
      ))}
    </>
  );
}

function TunnelSection() {
  const { local } = useServers();
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: keys.tunnel(),
    queryFn: () => local.client.tunnel.status({}),
    refetchInterval: (q) => (q.state.data?.state === "starting" ? 1500 : false),
  });
  const [mode, setMode] = useState<TunnelConfig["mode"]>("off");
  const [token, setToken] = useState("");
  const [hostname, setHostname] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (status.data) setMode(status.data.mode);
  }, [status.data?.mode]);

  const apply = async () => {
    setBusy(true);
    try {
      const config: TunnelConfig =
        mode === "token"
          ? { mode, token, hostname }
          : mode === "quick"
            ? { mode }
            : { mode: "off" };
      qc.setQueryData(keys.tunnel(), await local.client.tunnel.configure(config));
    } finally {
      setBusy(false);
    }
  };

  const s = status.data;
  return (
    <>
      <SectionHeading>Remote access</SectionHeading>
      <p className="text-xs text-faint">
        A Cloudflare tunnel lets you reach this server, and add it to another one, from anywhere.
      </p>
      <FieldRow label="Tunnel">
        <Segmented
          className="self-start"
          value={mode}
          onChange={setMode}
          options={[
            { value: "off", label: "Off" },
            {
              value: "quick",
              label: "Quick",
              title: "A random trycloudflare.com address. Good for trying it out.",
            },
            { value: "token", label: "Named", title: "A tunnel from your Cloudflare dashboard." },
          ]}
        />
      </FieldRow>
      {mode === "token" ? (
        <>
          <FieldRow
            label="Tunnel token"
            hint="Zero Trust → Networks → Tunnels → your tunnel → the token in its install command."
          >
            <Input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              type="password"
              placeholder="eyJh…"
            />
          </FieldRow>
          <FieldRow label="Hostname" hint="The public hostname you routed to http://server:8420.">
            <Input
              value={hostname}
              onChange={(e) => setHostname(e.target.value)}
              placeholder="nibblets.example.com"
            />
          </FieldRow>
        </>
      ) : null}
      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={busy || (mode === "token" && (!token || !hostname))}
          onClick={() => void apply()}
        >
          {busy ? <Loader2 className="animate-spin" /> : null}
          Apply
        </Button>
        {s ? (
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-dim">
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                s.state === "up"
                  ? "bg-ok"
                  : s.state === "starting"
                    ? "animate-pulse bg-warning"
                    : s.state === "error"
                      ? "bg-danger"
                      : "bg-faint",
              )}
            />
            {s.url ? (
              <a
                href={s.url}
                target="_blank"
                rel="noreferrer"
                className="truncate text-accent underline"
              >
                {s.url}
              </a>
            ) : (
              (s.detail ?? (s.state === "off" ? "Not exposed" : s.state))
            )}
          </span>
        ) : null}
      </div>
    </>
  );
}

function PairingSection() {
  const { local } = useServers();
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);
  return (
    <>
      <SectionHeading>Pair a device</SectionHeading>
      <p className="text-xs text-faint">
        Open this link on a phone or laptop to sign it in, or paste it into another server's "Add a
        server". It works once.
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
          onClick={async () => setLink(await local.client.auth.createPairingLink({}))}
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

function PeersSection() {
  const { local, peers } = useServers();
  const qc = useQueryClient();
  const [link, setLink] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <SectionHeading>Other servers</SectionHeading>
      <p className="text-xs text-faint">
        Show nibblets from your other machines here too. On the other server, open Settings → Pair a
        device, then paste its link below.
      </p>
      {peers.map((p) => (
        <div
          key={p.id}
          className="flex items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-1.5"
        >
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium">{p.name}</span>
            <span className="truncate text-2xs text-faint">{p.url}</span>
          </div>
          <Button
            size="icon"
            variant="ghost"
            title="Remove"
            onClick={async () => {
              await local.client.peers.remove({ id: p.id });
              void qc.invalidateQueries({ queryKey: keys.peers() });
            }}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <form
        className="flex gap-1.5"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await local.client.peers.add({ link: link.trim() });
            setLink("");
            void qc.invalidateQueries({ queryKey: keys.peers() });
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Input
          value={link}
          onChange={(e) => setLink(e.target.value)}
          placeholder="https://other-server.example.com/#pair=…"
          className="font-mono text-xs"
        />
        <Button type="submit" disabled={busy || !link.trim()}>
          {busy ? <Loader2 className="animate-spin" /> : <Plus />}
          Add a server
        </Button>
      </form>
      {error ? <p className="text-xs text-danger">{error}</p> : null}
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
function HostToolsSection() {
  const { local } = useServers();
  const tools = useQuery({
    queryKey: keys.hostTools("local"),
    queryFn: () => local.client.hostTools.list({}),
  });
  const clis = useQuery({
    queryKey: keys.clis("local"),
    queryFn: () => local.client.clis.list({}),
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
            detail={c.signedIn ? `Signed in as ${c.account ?? "you"}` : (c.detail ?? "Signed out")}
          />
        ))}
    </>
  );
}
