import { hostname } from "node:os";
import { z } from "zod";

const Env = z.object({
  PORT: z.coerce.number().int().default(8420),
  DATABASE_URL: z.string().default("postgres://nibblet:nibblet@localhost:5432/nibblet"),
  /** Signs in the desktop app and the first pairing link. */
  NIBBLET_OWNER_TOKEN: z.string().min(16),
  /** How runners and tool calls reach this server from inside the Docker network. */
  NIBBLET_INTERNAL_URL: z.string().default("http://server:8420"),
  /** How people reach this server, for pairing links. The tunnel URL wins when there is one. */
  NIBBLET_PUBLIC_URL: z.string().default("http://127.0.0.1:8420"),
  NIBBLET_NETWORK: z.string().default("nibblet"),
  NIBBLET_RUNNER_IMAGE: z.string().default("nibblet/runner:dev"),
  CREDPROXY_URL: z.string().default("http://credproxy:8787"),
  CREDPROXY_KEY: z.string().min(16),
  CREDPROXY_ADMIN_KEY: z.string().min(16),
  /** `local` (in-process model), `ollama:<url>` or `tei:<url>`. */
  NIBBLET_EMBEDDINGS: z.string().default("local"),
  NIBBLET_DATA_DIR: z.string().default("/data"),
  NIBBLET_WEB_DIST: z.string().optional(),
  DOCKER_SOCKET: z.string().optional(),
  /** The host MCP bridge (desktop app or `packages/host-mcp` CLI). Empty turns host tools off. */
  HOST_MCP_URL: z.string().default(""),
  HOST_MCP_TOKEN: z.string().default(""),
  /**
   * The host's SSH agent socket as the Docker engine sees it. Docker Desktop
   * and OrbStack forward it at /run/host-services/ssh-auth.sock; on Linux it's
   * the host's $SSH_AUTH_SOCK. Empty turns SSH key sharing off.
   */
  HOST_SSH_AUTH_SOCK: z.string().default(""),
  /** How long a gated tool call waits for the user before it's declined. */
  NIBBLET_APPROVAL_TIMEOUT_MINUTES: z.coerce.number().positive().default(30),
  /** Nibblets Connect, where this server can be linked to an account. */
  NIBBLET_CENTRAL_URL: z.url().default("https://app.nibblets.dev"),
  /** The machine's own name and OS; inside Docker the container can't see them. */
  NIBBLET_HOST_NAME: z.string().default(hostname()),
  NIBBLET_HOST_PLATFORM: z.enum(["darwin", "linux", "win32", "other"]).default("other"),
  /** Comma-separated addresses this server answers on from the local network, if any. */
  NIBBLET_LAN_URLS: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((u) => u.trim())
        .filter(Boolean),
    ),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Bad environment:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
