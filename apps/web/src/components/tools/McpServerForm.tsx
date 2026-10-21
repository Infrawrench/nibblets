import { useState } from "react";
import { Plus, X } from "lucide-react";
import { MASKED, McpServerDef } from "@nibblets/protocol";
import { z } from "zod";
import { Button } from "../ui/Button.tsx";
import { FieldRow, Input, Textarea } from "../ui/Field.tsx";
import { Segmented } from "../ui/Segmented.tsx";

type Pair = { key: string; value: string };

const toPairs = (record: Record<string, string>): Pair[] =>
  Object.entries(record).map(([key, value]) => ({ key, value }));

const toRecord = (pairs: Pair[]): Record<string, string> =>
  Object.fromEntries(pairs.filter((p) => p.key.trim()).map((p) => [p.key.trim(), p.value]));

/**
 * Header or env rows. Values are secrets: they're typed into password
 * fields, and a stored one shows as `MASKED`, which keeps it if untouched.
 */
function KeyValues({
  pairs,
  onChange,
  keyPlaceholder,
}: {
  pairs: Pair[];
  onChange: (pairs: Pair[]) => void;
  keyPlaceholder: string;
}) {
  const set = (i: number, patch: Partial<Pair>) =>
    onChange(pairs.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  return (
    <div className="flex flex-col gap-1">
      {pairs.map((p, i) => (
        <div key={i} className="flex items-center gap-1">
          <Input
            value={p.key}
            placeholder={keyPlaceholder}
            onChange={(e) => set(i, { key: e.target.value })}
            className="w-40 font-mono text-xs"
          />
          <Input
            type="password"
            value={p.value}
            placeholder="value"
            onFocus={() => p.value === MASKED && set(i, { value: "" })}
            onChange={(e) => set(i, { value: e.target.value })}
            className="font-mono text-xs"
          />
          <Button
            size="icon"
            variant="ghost"
            title="Remove"
            onClick={() => onChange(pairs.filter((_, j) => j !== i))}
          >
            <X />
          </Button>
        </div>
      ))}
      <Button
        size="sm"
        variant="ghost"
        className="self-start"
        onClick={() => onChange([...pairs, { key: "", value: "" }])}
      >
        <Plus />
        Add
      </Button>
    </div>
  );
}

/** Splits a command line into words, honouring simple quotes. */
export function splitArgs(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
}

const joinArgs = (args: string[]) => args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");

/** Adds or edits one of a nibblet's own MCP servers. */
export function McpServerForm({
  initial,
  taken,
  onSave,
  onCancel,
}: {
  initial: McpServerDef | null;
  /** Names already used by its other servers. */
  taken: string[];
  onSave: (server: McpServerDef) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [type, setType] = useState<McpServerDef["type"]>(initial?.type ?? "stdio");
  const [url, setUrl] = useState(initial?.type === "http" ? initial.url : "");
  const [command, setCommand] = useState(
    initial?.type === "stdio" ? joinArgs([initial.command, ...initial.args]) : "",
  );
  const [pairs, setPairs] = useState<Pair[]>(
    initial ? toPairs(initial.type === "http" ? initial.headers : initial.env) : [],
  );
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    const [cmd = "", ...args] = splitArgs(command);
    const candidate =
      type === "http"
        ? { name, type, url: url.trim(), headers: toRecord(pairs) }
        : { name, type, command: cmd, args, env: toRecord(pairs) };
    const parsed = McpServerDef.safeParse(candidate);
    if (!parsed.success) return setError(z.prettifyError(parsed.error));
    if (taken.includes(parsed.data.name)) return setError("Another server already has that name");
    onSave(parsed.data);
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-2.5">
      <FieldRow label="Name" hint="Lowercase, like github or web-search.">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value.toLowerCase())}
          placeholder="github"
        />
      </FieldRow>
      <FieldRow
        label="Kind"
        hint={
          type === "http"
            ? "An MCP server on the web, reached over HTTP."
            : "A command the nibblet runs in its own container, over stdio."
        }
      >
        <Segmented
          value={type}
          onChange={setType}
          options={[
            {
              value: "stdio",
              label: "Local command",
              title: "Runs inside the nibblet's container",
            },
            { value: "http", label: "HTTP", title: "A streamable HTTP MCP server" },
          ]}
        />
      </FieldRow>
      {type === "http" ? (
        <>
          <FieldRow label="URL" hint="Its streamable HTTP endpoint, usually ending in /mcp.">
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://mcp.linear.app/mcp"
            />
          </FieldRow>
          <FieldRow label="Headers" top hint="Values are kept secret.">
            <KeyValues pairs={pairs} onChange={setPairs} keyPlaceholder="authorization" />
          </FieldRow>
        </>
      ) : (
        <>
          <FieldRow label="Command" hint="Runs inside the nibblet's container.">
            <Input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="npx -y @modelcontextprotocol/server-everything"
              className="font-mono text-xs"
            />
          </FieldRow>
          <FieldRow label="Environment" top hint="Values are kept secret.">
            <KeyValues pairs={pairs} onChange={setPairs} keyPlaceholder="API_KEY" />
          </FieldRow>
        </>
      )}
      {error ? <p className="text-xs whitespace-pre-wrap text-danger">{error}</p> : null}
      <div className="flex justify-end gap-1.5">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" onClick={save}>
          {initial ? "Save server" : "Add server"}
        </Button>
      </div>
    </div>
  );
}

/** Pastes a Claude-style `{"mcpServers": …}` snippet. */
export function McpImportBox({
  onImport,
  onCancel,
}: {
  onImport: (text: string) => string[];
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-2.5">
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'{"mcpServers": {"github": {"command": "npx", "args": ["-y", "…"]}}}'}
        className="min-h-24 font-mono text-xs"
      />
      {errors.length ? (
        <p className="text-xs whitespace-pre-wrap text-danger">{errors.join("\n")}</p>
      ) : null}
      <div className="flex justify-end gap-1.5">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!text.trim()} onClick={() => setErrors(onImport(text))}>
          Import
        </Button>
      </div>
    </div>
  );
}
