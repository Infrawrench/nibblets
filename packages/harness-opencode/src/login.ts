import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { JsonValue, type OpencodeLogin } from "@nibblet/protocol";

/**
 * Turning the host's OpenCode setup into one that works inside a nibblet's
 * container. The config is the user's own, minus its MCP servers (they point
 * at commands on the host, and the nibblet brings its own), with providers
 * on the host's localhost pointed at the host instead.
 */

/** JSONC to JSON: drops comments and trailing commas, leaving strings alone. */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '"') {
      const start = i;
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      out += text.slice(start, ++i);
    } else if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

const LOCALHOST = /^(https?:\/\/)(localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/i;

/** Every string that's a URL on the host's loopback, pointed at the host from Docker. */
export function rewriteLocalhost(value: JsonValue): JsonValue {
  if (typeof value === "string") return value.replace(LOCALHOST, "$1host.docker.internal");
  if (Array.isArray(value)) return value.map(rewriteLocalhost);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewriteLocalhost(v)]));
  }
  return value;
}

/** The host config as an object a container can use, or an empty one if it won't parse. */
export function containerConfig(text: string | null): Record<string, JsonValue> {
  if (!text) return {};
  let parsed: JsonValue;
  try {
    parsed = JsonValue.parse(JSON.parse(stripJsonc(text)));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const { mcp: _hostMcp, $schema: _schema, ...rest } = parsed;
  const rewritten = rewriteLocalhost(rest);
  return rewritten && typeof rewritten === "object" && !Array.isArray(rewritten) ? rewritten : {};
}

export interface OpencodeDirs {
  /** `$XDG_CONFIG_HOME` */
  config: string;
  /** `$XDG_DATA_HOME` */
  data: string;
}

/** Writes the login where OpenCode looks for it under the given XDG directories. */
export async function installLogin(dirs: OpencodeDirs, login: OpencodeLogin): Promise<void> {
  const configDir = path.join(dirs.config, "opencode");
  const dataDir = path.join(dirs.data, "opencode");
  await mkdir(configDir, { recursive: true });
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(configDir, "opencode.json"),
    JSON.stringify(containerConfig(login.config), null, 2),
  );
  if (login.auth) {
    const authFile = path.join(dataDir, "auth.json");
    await writeFile(authFile, login.auth, { mode: 0o600 });
    await chmod(authFile, 0o600);
  }
}

export interface OpencodeModel {
  /** `provider/model`, as OpenCode takes it. */
  id: string;
  provider: string;
  name: string;
}

/**
 * Reads `opencode models --verbose`: each model is a `provider/model` line
 * followed by a pretty-printed JSON object that ends with `}` in column 0.
 */
export function parseModelsVerbose(text: string): OpencodeModel[] {
  const out: OpencodeModel[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const id = lines[i]?.trim() ?? "";
    if (!/^[^\s{}/]+\/\S+$/.test(id) || lines[i + 1]?.trimEnd() !== "{") continue;
    let end = i + 1;
    while (end < lines.length && lines[end]?.trimEnd() !== "}") end++;
    const slash = id.indexOf("/");
    let name = id.slice(slash + 1);
    try {
      const meta = JsonValue.parse(JSON.parse(lines.slice(i + 1, end + 1).join("\n")));
      if (meta && typeof meta === "object" && !Array.isArray(meta) && typeof meta.name === "string")
        name = meta.name;
    } catch {
      // Keep the id as its name.
    }
    out.push({ id, provider: id.slice(0, slash), name });
    i = end;
  }
  return out;
}
