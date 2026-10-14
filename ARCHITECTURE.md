# Architecture

Nibblets are self-hosted, always-on agents, each drawn as a hamster you can dress up. A nibblet is a thread: it runs in its own Docker container on one of three harnesses (Claude Agent SDK, Codex, OpenCode), wakes on a heartbeat and on schedules, keeps its memory outside the container in Postgres with pgvector, and can spawn sub-agents, which are child nibblets.

## Processes

Everything runs in Docker on one network, `nibblet`.

| Service        | Image                          | Address on the network | What it does                                                                                                                |
| -------------- | ------------------------------ | ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `server`       | `nibblet/server`               | `server:8420`          | API, web UI, live WebSocket, runner WebSocket, nibblet tools over MCP, scheduler, heartbeats, Docker orchestration, tunnels |
| `db`           | `pgvector/pgvector:0.8.7-pg18` | `db:5432`              | All durable state: nibblets, thread items, schedules, memories (with embeddings), peers, sign-ins                           |
| `credproxy`    | `nibblet/credproxy`            | `credproxy:8787`       | Holds the host's Claude and ChatGPT subscription credentials, refreshes them, and injects them into harness traffic         |
| `tunnel`       | `cloudflare/cloudflared`       | none                   | Started by the server when a tunnel is configured                                                                           |
| `nibblet-<id>` | `nibblet/runner`               | `nibblet-<id>`         | One per running nibblet: the runner, its harness, OpenComputerUse and Chromium                                              |

The server is the only service published on the host (`127.0.0.1:8420`). It mounts the Docker socket to manage the tunnel and runner containers.

## Credentials (`apps/credproxy`)

Runner containers never see a real token. Each gets a base URL on the proxy and `NIBBLET_CREDPROXY_KEY`, a shared secret it sends where the harness would send an API key. The proxy checks the key, swaps in the real credential, and forwards:

| Proxy path                         | Upstream                                  | Injected                                                                                                               |
| ---------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `/anthropic/*`                     | `https://api.anthropic.com/*`             | `Authorization: Bearer <access>`, `anthropic-beta: oauth-2025-04-20` merged with any existing betas; drops `x-api-key` |
| `/openai/*`                        | `https://chatgpt.com/backend-api/codex/*` | `Authorization: Bearer <access>`, `chatgpt-account-id`                                                                 |
| `/openai-auth/oauth/token`         | answered locally                          | Dummy tokens, so a harness that tries to refresh its placeholder login gets a harmless answer                          |
| `GET /status`                      | answered locally (admin key)              | `CredentialStatus[]`                                                                                                   |
| `PUT /admin/credentials/:provider` | answered locally (admin key)              | The desktop app pushes keychain credentials here                                                                       |

Sources, per provider, are plugins: `file` (the host's `~/.claude/.credentials.json` or `~/.codex/auth.json`, bind-mounted read-write at `/creds/claude/.credentials.json` and `/creds/codex/auth.json`) and `keychain` (macOS: the desktop app reads `Claude Code-credentials` from the keychain and pushes it; refreshed tokens are pushed back through the desktop app's bridge). Refresh tokens rotate, so after refreshing the proxy writes the new pair back to its source, so the host's own CLI keeps working.

Refresh endpoints: Anthropic `POST https://platform.claude.com/v1/oauth/token` JSON `{grant_type:"refresh_token", refresh_token, client_id:"9d1c250a-e61b-44d9-88ed-5944d1962f5e"}`; OpenAI `POST https://auth.openai.com/oauth/token` `{grant_type:"refresh_token", refresh_token, client_id:"app_EMoamEEZ73f0CkXaXp7hrann"}`.

## Runner (`apps/runner`)

Started by the server with the `RunnerEnv` variables from `@nibblet/protocol`. It connects to `NIBBLET_SERVER_WS` with `Authorization: Bearer $NIBBLET_TOKEN`, waits for `configure`, opens the harness plugin for `config.harness`, and then runs `turn`s one at a time, streaming `item`s and ending each with `turn_end`. It keeps no durable state: the server sends the system prompt (instructions, relevant memories, a recap of the thread when the harness session is new) with every turn.

Harnesses get two MCP servers:

- `nibblet`: streamable HTTP at `NIBBLET_MCP_URL` with `Authorization: Bearer $NIBBLET_TOKEN`. The tools are below.
- `computer`: OpenComputerUse, when `NIBBLET_BROWSER=1`. One long-lived OCU process per container runs Chromium on a headless Wayland display. Its view socket (port 7900) lets the UI watch and take over; the server proxies it at `/api/nibblets/:id/browser`.

Harness plugins live in `packages/harness-*` and implement `HarnessPlugin` from `@nibblet/harness`, using `TurnWriter` to turn deltas into thread items.

### OpenCode

OpenCode nibblets use the host's own OpenCode account, not the credential proxy. The host bridge reports whether OpenCode is set up (`GET /harness/opencode`: the CLI, OpenCode.app, or a config or login in its XDG directories) and hands over the config and `auth.json` (`GET /harness/opencode/login`, bridge token only).

- **The model picker:** `harnesses.models({ harness: "opencode" })` lists whatever OpenCode offers for that login. The server runs `apps/runner/src/opencode-models.ts` in a throwaway runner container with the login on stdin, so the list is exactly what a nibblet will see, and caches it for a minute. The host doesn't need the CLI.
- **On each configure:** the server fetches the login fresh and sends it only over the runner socket. The runner writes it into the container's OpenCode config and data directories.
- **What changes in the container:** the host config's `mcp` section is dropped, because the nibblet brings its own servers. Provider URLs on the host's `localhost` or `127.0.0.1` are pointed at `host.docker.internal`, so a local Ollama still resolves.
- **Not written back:** a provider whose OAuth token refreshes inside the container doesn't write it back to the host.
- **Without a bridge or a login:** OpenCode falls back to Anthropic and OpenAI through the credential proxy.
- **Effort:** OpenCode has no effort setting, so its models carry none and the effort menu is hidden.

## Tools (`/mcp` on the server)

| Tool                                                    | What it does                                                                                                                                              |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory_search`                                         | Semantic search over this nibblet's notes, shared notes, and indexed transcript                                                                           |
| `memory_save`                                           | Saves a note (optionally shared with every nibblet)                                                                                                       |
| `memory_forget`                                         | Deletes a note by id                                                                                                                                      |
| `schedule_create`                                       | Cron or one-shot schedule that sends the nibblet a prompt                                                                                                 |
| `schedule_list` / `schedule_delete`                     |                                                                                                                                                           |
| `instructions_update`                                   | Rewrites the nibblet's own standing instructions as it learns what it's for from the chat                                                                 |
| `heartbeat_set` / `heartbeat_remove` / `heartbeat_list` | The nibblet's own heartbeats: as many as it needs, each named, with its own interval, active hours and checklist. The UI shows them but doesn't edit them |
| `spawn_subagent`                                        | Starts a child nibblet on a task; its final answer comes back as a `subagent` turn                                                                        |
| `subagent_status`                                       | Lists children and their status                                                                                                                           |

A heartbeat or schedule turn whose reply is `NO_REPLY` is stored with `quiet: true` and collapsed in the UI.

## API

The typed contract is `contract` in `packages/protocol/src/contract.ts`. Calls are `POST /api/rpc/<dotted.path>`. Live updates are a WebSocket at `/api/live` pushing `LiveMessage`s. Browsers authenticate with `Authorization: Bearer <token>`; WebSockets take `?ticket=` from `POST /api/ticket`, which lasts 30 seconds, so long-lived tokens never go in URLs.

First run prints, and the desktop app opens, a pairing link `http(s)://host/#pair=<code>`. The UI exchanges the code at `POST /api/pair` for a long-lived token.

## Across machines: Nibblets Connect (`apps/connect`)

Each machine runs its own server. Like T3 Connect, a central service (a Cloudflare Worker with D1, signed in with Clerk) lists every server on an account, without being in the data path:

- A server links with a code approved on the central site, then sends a heartbeat every 30 seconds with its routes: local network (`NIBBLET_LAN_URLS`), Tailscale (`tailscale serve` through the host bridge), and a Cloudflare tunnel (a managed one when the central service has a zone, a quick one otherwise).
- The central UI (the web app built with `build:central`) tries each server's routes in that order with a `/healthz` probe, and talks to the first that answers with a five-minute ES256 token from the central service. Servers verify those tokens against its JWKS.
- The desktop app asks on first run whether to run a server on this computer. If not, it only shows the central UI.
- "Pair a device" still signs a device in to one server directly, on the same network.

See `apps/connect/README.md` for deploying it.

## Host tools (`packages/host-mcp`)

The host bridge runs on the host, in the desktop app (127.0.0.1:8789) or as `node packages/host-mcp/src/cli.ts --port 8789 --token <t> [--host 172.17.0.1]` on servers without it. The server reaches it at `HOST_MCP_URL` with `HOST_MCP_TOKEN`; empty turns it off. Nothing reaches a nibblet unless ticked for it.

- **Host MCP servers**: read in Claude's `mcpServers` format from `~/.nibblet/host-mcp.json`, then Claude Code's `~/.claude.json`, then Claude Desktop's config, with the first definition of a name winning. Each server is started on first use and served at `/mcp/<name>`; `GET /servers` lists them. A nibblet's `hostTools` names the ones it may use. Its runner registers each as `host_<name>` at the server's `/hostmcp/<name>`, which checks the nibblet's token and that list before forwarding.
- **CLI logins**: `CliPlugin`s (`gh` and `ssh` so far) detect whether a CLI is installed and signed in (`GET /clis`) and turn its login into environment variables (`GET /clis/:id/credential`). For each CLI in a nibblet's `cliCredentials`, the server fetches a fresh credential on every configure and sends it only over the runner socket. The runner puts it in the harness's environment and runs the CLI's setup (`gh auth setup-git`). It is never stored, logged, or returned by the API.
- **SSH keys**: the `ssh` plugin shares the host's SSH agent, never a key. It's offered when `ssh-add -l` lists keys. For a nibblet that has it ticked, the server bind-mounts `HOST_SSH_AUTH_SOCK` (`/run/host-services/ssh-auth.sock` on Docker Desktop and OrbStack, the host's `$SSH_AUTH_SOCK` on Linux) at `/run/nibblet/ssh-agent.sock`. Because it's a mount, ticking or unticking it restarts the container. On Linux the socket is usually `0600`, owned by the host user, so the container's `nibblet` user (uid 1001) can't open it unless the uids match.
- **A nibblet's own MCP servers** (`mcpServers`): remote URLs, or commands run inside its container. Header and env values are secrets: the API returns them as `••••`, and an update that sends `••••` back keeps the stored value.
