import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileJson, Pencil, Plus, Server, Terminal, Trash2 } from "lucide-react";
import type { McpServerDef } from "@nibblet/protocol";
import type { ServerConnection } from "../../lib/connection.ts";
import { importMcpJson, upsertServers } from "../../lib/mcpImport.ts";
import { keys } from "../../lib/servers.tsx";
import { cn } from "../../lib/cn.ts";
import { Button } from "../ui/Button.tsx";
import { SectionHeading } from "../ui/Field.tsx";
import { McpImportBox, McpServerForm } from "./McpServerForm.tsx";

export interface ToolsValue {
  hostTools: string[];
  cliCredentials: string[];
  mcpServers: McpServerDef[];
}

function Check({
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
          onChange={(on) => onChange({ ...value, hostTools: toggle(value.hostTools, s.name, on) })}
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
                {c.label} <span className="text-dim">— share login as {c.account ?? "you"}</span>
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
  const set = (mcpServers: McpServerDef[]) => onChange({ ...value, mcpServers });

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
