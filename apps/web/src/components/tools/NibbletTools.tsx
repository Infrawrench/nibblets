import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronRight,
  FileJson,
  Pencil,
  Plus,
  Server,
  ShieldAlert,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import {
  looksRisky,
  RISKY_TOOL_PATTERNS,
  type McpServerDef,
  type ToolRule,
} from "@nibblets/protocol";
import type { ServerConnection } from "../../lib/connection.ts";
import { importMcpJson, upsertServers } from "../../lib/mcpImport.ts";
import { keys } from "../../lib/servers.tsx";
import { cn } from "../../lib/cn.ts";
import { Button } from "../ui/Button.tsx";
import { Input, SectionHeading } from "../ui/Field.tsx";
import { McpImportBox, McpServerForm } from "./McpServerForm.tsx";

export interface ToolsValue {
  hostTools: string[];
  cliCredentials: string[];
  mcpServers: McpServerDef[];
  toolApprovals: ToolRule[];
}

/**
 * Rules to suggest when a server is first turned on: its risky-looking tools
 * by name when they're known, otherwise the risky patterns themselves.
 */
export function suggestedRules(server: string, tools: readonly string[] | null): ToolRule[] {
  const names = tools ? tools.filter(looksRisky) : [...RISKY_TOOL_PATTERNS];
  return names.map((tool) => ({ server, tool }));
}

const withoutServer = (rules: ToolRule[], server: string) =>
  rules.filter((r) => r.server !== server);

export function Check({
  checked,
  onChange,
  disabled,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label
      className={cn(
        "flex min-h-7 items-center gap-2 rounded-md px-1.5 hover:bg-hover",
        disabled && "opacity-50",
      )}
    >
      <input
        type="checkbox"
        className="size-3.5 accent-[var(--color-accent)]"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="flex min-w-0 flex-1 items-center gap-2 text-sm">{children}</span>
    </label>
  );
}

const toggle = (list: string[], item: string, on: boolean) =>
  on ? [...new Set([...list, item])] : list.filter((x) => x !== item);

/** Host MCP servers are ticked one by one: a nibblet sees none of them by default. */
function HostTools({ connection, value, onChange }: SectionProps) {
  const { data } = useQuery({
    queryKey: keys.hostTools(connection.id),
    queryFn: () => connection.client.hostTools.list({}),
  });
  if (!data) return <p className="px-1.5 text-xs text-faint">Looking for host tools…</p>;
  if (!data.connected) {
    return (
      <p className="px-1.5 text-xs text-faint">
        {data.detail ?? "The host bridge isn't connected."}
      </p>
    );
  }
  if (data.servers.length === 0) {
    return (
      <p className="px-1.5 text-xs text-faint">
        No MCP servers on the host. Add some to ~/.nibblet/host-mcp.json, or set them up in Claude
        Code or Claude Desktop.
      </p>
    );
  }
  return (
    <div className="flex flex-col">
      {data.servers.map((s) => (
        <Check
          key={s.name}
          checked={value.hostTools.includes(s.name)}
          onChange={(on) =>
            onChange({
              ...value,
              hostTools: toggle(value.hostTools, s.name, on),
              // Turning a server on suggests approval for its risky tools; off forgets its rules.
              toolApprovals: on
                ? [
                    ...withoutServer(value.toolApprovals, `host_${s.name}`),
                    ...suggestedRules(
                      `host_${s.name}`,
                      s.status === "ready" ? s.tools.map((t) => t.name) : null,
                    ),
                  ]
                : withoutServer(value.toolApprovals, `host_${s.name}`),
            })
          }
        >
          <span className="font-medium">{s.name}</span>
          <span className="truncate text-xs text-faint">{hostToolSummary(s)}</span>
        </Check>
      ))}
    </div>
  );
}

/** Host CLI logins: shown only when the host has the CLI, ticked only when it's signed in. */
function CliLogins({ connection, value, onChange }: SectionProps) {
  const { data } = useQuery({
    queryKey: keys.clis(connection.id),
    queryFn: () => connection.client.clis.list({}),
  });
  const installed = data?.clis.filter((c) => c.installed) ?? [];
  if (!data?.connected || installed.length === 0) return null;
  return (
    <>
      <SectionHeading>CLI logins</SectionHeading>
      <div className="flex flex-col">
        {installed.map((c) =>
          c.signedIn ? (
            <Check
              key={c.id}
              checked={value.cliCredentials.includes(c.id)}
              onChange={(on) =>
                onChange({ ...value, cliCredentials: toggle(value.cliCredentials, c.id, on) })
              }
            >
              <Terminal className="size-3.5 text-dim" />
              <span>
                {c.label}{" "}
                <span className="text-dim">
                  {c.id === "ssh"
                    ? `· let it use ${c.account ?? "your keys"} (keys stay on this machine)`
                    : `· share login as ${c.account ?? "you"}`}
                </span>
              </span>
            </Check>
          ) : (
            <p key={c.id} className="flex min-h-7 items-center gap-2 px-1.5 text-xs text-faint">
              <Terminal className="size-3.5" />
              {c.label} is signed out. {c.detail ?? ""}
            </p>
          ),
        )}
      </div>
    </>
  );
}

function OwnServers({ value, onChange }: Omit<SectionProps, "connection">) {
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [importing, setImporting] = useState(false);
  const servers = value.mcpServers;
  // New servers get the risky patterns suggested; removed ones lose their rules.
  const set = (mcpServers: McpServerDef[]) => {
    const before = new Set(servers.map((s) => s.name));
    const after = new Set(mcpServers.map((s) => s.name));
    let toolApprovals = value.toolApprovals.filter(
      (r) => after.has(r.server) || !before.has(r.server),
    );
    for (const s of mcpServers) {
      if (!before.has(s.name)) toolApprovals = [...toolApprovals, ...suggestedRules(s.name, null)];
    }
    onChange({ ...value, mcpServers, toolApprovals });
  };

  return (
    <div className="flex flex-col gap-1.5">
      {servers.map((s) =>
        editing === s.name ? (
          <McpServerForm
            key={s.name}
            initial={s}
            taken={servers.filter((x) => x.name !== s.name).map((x) => x.name)}
            onCancel={() => setEditing(null)}
            onSave={(next) => {
              set(servers.map((x) => (x.name === s.name ? next : x)));
              setEditing(null);
            }}
          />
        ) : (
          <div
            key={s.name}
            className="flex min-h-8 items-center gap-2 rounded-md border border-line px-2"
          >
            {s.type === "http" ? (
              <Server className="size-3.5 text-dim" />
            ) : (
              <Terminal className="size-3.5 text-dim" />
            )}
            <span className="text-sm font-medium">{s.name}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-2xs text-faint">
              {s.type === "http" ? s.url : [s.command, ...s.args].join(" ")}
            </span>
            <Button size="icon" variant="ghost" title="Edit" onClick={() => setEditing(s.name)}>
              <Pencil />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              title="Remove"
              onClick={() => set(servers.filter((x) => x !== s))}
            >
              <Trash2 />
            </Button>
          </div>
        ),
      )}
      {editing === "new" ? (
        <McpServerForm
          initial={null}
          taken={servers.map((x) => x.name)}
          onCancel={() => setEditing(null)}
          onSave={(next) => {
            set([...servers, next]);
            setEditing(null);
          }}
        />
      ) : null}
      {importing ? (
        <McpImportBox
          onCancel={() => setImporting(false)}
          onImport={(text) => {
            const { servers: found, errors } = importMcpJson(text);
            if (found.length) set(upsertServers(servers, found));
            if (!errors.length) setImporting(false);
            return errors;
          }}
        />
      ) : null}
      {editing === null && !importing ? (
        <div className="flex gap-1">
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus />
            Add MCP server
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setImporting(true)}>
            <FileJson />
            Paste JSON
          </Button>
        </div>
      ) : null}
    </div>
  );
}

interface SectionProps {
  connection: ServerConnection;
  value: ToolsValue;
  onChange: (value: ToolsValue) => void;
  /** Whether the nibblet has a browser, which can be gated too. */
  browser?: boolean;
}

/**
 * What a nibblet can reach beyond its own tools: host MCP servers and CLI
 * logins it's been allowed, and MCP servers added to it alone. Everything
 * here is off until chosen.
 */
export function NibbletTools(props: SectionProps) {
  return (
    <div className="flex flex-col gap-1">
      <SectionHeading>Host MCP servers</SectionHeading>
      <HostTools {...props} />
      <CliLogins {...props} />
      <SectionHeading>Its own MCP servers</SectionHeading>
      <OwnServers value={props.value} onChange={props.onChange} />
      <SectionHeading>Ask before using</SectionHeading>
      <ApprovalRules {...props} />
    </div>
  );
}

/** One line about a host MCP server: why it's broken, or what it offers. */
export function hostToolSummary(s: {
  status: string;
  detail: string | null;
  tools: unknown[];
  source: string;
}): string {
  if (s.status === "error") return `Not working: ${s.detail ?? "unknown error"}`;
  if (s.status === "idle") return `Starts when first used · from ${s.source}`;
  return `${s.tools.length} tool${s.tools.length === 1 ? "" : "s"} · from ${s.source}`;
}

interface Gateable {
  /** The name the harness sees, which rules are written against. */
  id: string;
  label: string;
  /** Its tools, when known (a host server reports them once it has run). */
  tools: string[] | null;
}

/**
 * "Ask me first" for the servers this nibblet can use: every tool on a
 * server, particular tools, or name patterns. A matching call waits in the
 * chat for Approve or Decline.
 */
function ApprovalRules({ connection, value, onChange, browser }: SectionProps) {
  const { data } = useQuery({
    queryKey: keys.hostTools(connection.id),
    queryFn: () => connection.client.hostTools.list({}),
  });
  const servers: Gateable[] = [
    ...value.hostTools.map((name) => {
      const host = data?.servers.find((s) => s.name === name);
      return {
        id: `host_${name}`,
        label: name,
        tools: host?.status === "ready" ? host.tools.map((t) => t.name) : null,
      };
    }),
    ...value.mcpServers.map((s) => ({ id: s.name, label: s.name, tools: null })),
    ...(browser ? [{ id: "computer", label: "Browser", tools: null }] : []),
  ];
  if (servers.length === 0) {
    return (
      <p className="px-1.5 text-xs text-faint">
        Turn on a host server or add one of its own, then choose which of its tools need your OK.
      </p>
    );
  }
  const setRules = (server: string, rules: ToolRule[]) =>
    onChange({
      ...value,
      toolApprovals: [...withoutServer(value.toolApprovals, server), ...rules],
    });
  return (
    <div className="flex flex-col gap-1">
      <p className="px-1.5 text-xs text-faint">
        Calls to these wait for you in the chat. Tools that look like they move money or delete
        things are ticked when a server is turned on; untick them if you trust it.
      </p>
      {servers.map((s) => (
        <ServerRules
          key={s.id}
          server={s}
          rules={value.toolApprovals.filter((r) => r.server === s.id)}
          onChange={(rules) => setRules(s.id, rules)}
        />
      ))}
    </div>
  );
}

function ServerRules({
  server,
  rules,
  onChange,
}: {
  server: Gateable;
  rules: ToolRule[];
  onChange: (rules: ToolRule[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pattern, setPattern] = useState("");
  const everything = rules.some((r) => r.tool === "*");
  const named = new Set(rules.map((r) => r.tool));
  const extra = rules.filter((r) => r.tool !== "*" && !server.tools?.includes(r.tool));
  const summary = everything
    ? "Every tool"
    : rules.length === 0
      ? "Nothing"
      : `${rules.length} ${rules.length === 1 ? "rule" : "rules"}`;
  const add = (tool: string) =>
    onChange(named.has(tool) ? rules : [...rules, { server: server.id, tool }]);
  const remove = (tool: string) => onChange(rules.filter((r) => r.tool !== tool));

  return (
    <div className="rounded-md border border-line">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-8 w-full items-center gap-2 px-2 text-left text-sm hover:bg-hover"
      >
        <ShieldAlert className={cn("size-3.5", rules.length > 0 ? "text-warning" : "text-faint")} />
        <span className="font-medium">{server.label}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-faint">{summary}</span>
        <ChevronRight
          className={cn("size-3.5 text-faint transition-transform", open && "rotate-90")}
        />
      </button>
      {open ? (
        <div className="flex flex-col gap-1 border-t border-line p-1.5">
          <Check checked={everything} onChange={(on) => (on ? add("*") : remove("*"))}>
            Every tool on {server.label}
          </Check>
          {!everything && server.tools
            ? server.tools.map((tool) => (
                <Check
                  key={tool}
                  checked={named.has(tool)}
                  onChange={(on) => (on ? add(tool) : remove(tool))}
                >
                  <span className="font-mono text-xs">{tool}</span>
                  {looksRisky(tool) ? (
                    <span className="text-2xs text-warning">looks risky</span>
                  ) : null}
                </Check>
              ))
            : null}
          {!everything ? (
            <>
              {extra.length > 0 ? (
                <div className="flex flex-wrap gap-1 px-1.5">
                  {extra.map((r) => (
                    <span
                      key={r.tool}
                      className="flex items-center gap-1 rounded bg-deep px-1.5 py-0.5 font-mono text-2xs"
                    >
                      {r.tool}
                      <button
                        type="button"
                        onClick={() => remove(r.tool)}
                        aria-label={`Stop asking for ${r.tool}`}
                        className="text-faint hover:text-text"
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
              <form
                className="flex gap-1 px-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  const t = pattern.trim();
                  if (t) add(t);
                  setPattern("");
                }}
              >
                <Input
                  value={pattern}
                  onChange={(e) => setPattern(e.target.value)}
                  placeholder={
                    server.tools
                      ? "Or a pattern, e.g. send_*"
                      : "A tool name or pattern, e.g. send_*"
                  }
                  className="h-6 flex-1 font-mono text-xs"
                />
                <Button size="sm" type="submit" disabled={!pattern.trim()}>
                  Add
                </Button>
              </form>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
