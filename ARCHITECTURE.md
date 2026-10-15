# Architecture

Nibblets are self-hosted, always-on agents, each drawn as a hamster you can dress up. A nibblet is a thread: it runs in its own Docker container on one of three harnesses (Claude Agent SDK, Codex, OpenCode), wakes on a heartbeat and on schedules, keeps its memory outside the container in Postgres with pgvector, and can spawn sub-agents, which are child nibblets.

## Processes

Everything runs in Docker on two networks. `nibblet` has the database, the server and the credential proxy. `nibblet-runners` has the server, the credential proxy and the nibblets' containers, so a nibblet can't reach the database.

| Service        | Image                          | Address on the network | What it does                                                                                                                |
| -------------- | ------------------------------ | ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `server`       | `nibblet/server`               | `server:8420`          | API, web UI, live WebSocket, runner WebSocket, nibblet tools over MCP, scheduler, heartbeats, Docker orchestration, tunnels |
| `db`           | `pgvector/pgvector:0.8.7-pg18` | `db:5432`              | All durable state: nibblets, thread items, schedules, memories (with embeddings), peers, sign-ins                           |
| `credproxy`    | `nibblet/credproxy`            | `credproxy:8787`       | Holds the host's Claude and ChatGPT subscription credentials, refreshes them, and injects them into harness traffic         |
| `tunnel`       | `cloudflare/cloudflared`       | none                   | Started by the server when a tunnel is configured                                                                           |
| `nibblet-<id>` | `nibblet/runner`               | `nibblet-<id>`         | One per running nibblet: the runner, its harness, OpenComputerUse and Chromium                                              |

The server is the only service published on the host (`127.0.0.1:8420`). It mounts the Docker socket to manage the tunnel and runner containers.

## Credentials (`apps/credproxy`)

Runner containers never see a Claude or ChatGPT subscription token. (What they can see: an OpenCode login, scoped to the model's own provider, and the CLI logins you tick for a nibblet. See below.) Each gets a base URL on the proxy and `NIBBLET_CREDPROXY_KEY`, a shared secret it sends where the harness would send an API key. The proxy checks the key, swaps in the real credential, and forwards:

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

Harnesses get the `nibblet` MCP server (streamable HTTP at `NIBBLET_MCP_URL` with `Authorization: Bearer $NIBBLET_TOKEN`; the tools are below), plus whatever the guard serves through its gate.

### Inside the container: the guard and the agent

The agent runs whatever a model asks it to, so anything in its reach is in a prompt injection's reach. The container is split so its secrets aren't. The entry (`apps/runner/src/entry.ts`) starts as root, sets things up, and starts two processes under different users:

- **The guard** (uid 1100, `apps/runner/src/guard.ts`) holds the secrets. It runs OpenComputerUse (one Chromium on a headless Wayland display, with its profile in `/home/nibblet/.guard`, and a view socket on port 7900 that the server proxies at `/api/nibblets/:id/browser`), the 1Password MCP server with its service account token, and the nibblet's own MCP servers with their headers and env. All of them sit behind the gate on `127.0.0.1:7810`, which applies the nibblet's "ask me first" rules. The guard fetches its settings from the server's `/guard/:id/*` routes with `NIBBLET_GUARD_TOKEN`, and long-polls the server for approvals, so neither depends on anything the agent can touch.
- **The runner and the harness** (uid 1001, `nibblet`) only know the gate's address. They can't read the guard's environment, memory or home, and they never get the guard's token or the browser's view token.

Neither keeps any capability, and the server sets no-new-privileges, drops every capability the entry doesn't need, and limits processes. Before they start, the entry sets iptables rules: the cloud metadata range (169.254.0.0/16) is blocked, and on `nibblet-runners` only the server and the credential proxy are reachable, not other nibblets or the tunnel. The internet and `host.docker.internal` stay reachable: the first is the point, and OpenCode's local providers (such as Ollama) need the second. Downloads land in `/home/nibblet/Downloads`, which the agent can read.

1Password's `fill_login` never types into whatever the browser shows. It opens the login's own saved address (or a page the agent names on the same site), checks where it landed, and only then fills the username and password.

Harness plugins live in `packages/harness-*` and implement `HarnessPlugin` from `@nibblet/harness`, using `TurnWriter` to turn deltas into thread items.

### OpenCode

OpenCode nibblets use the host's own OpenCode account, not the credential proxy. The host bridge reports whether OpenCode is set up (`GET /harness/opencode`: the CLI, OpenCode.app, or a config or login in its XDG directories) and hands over the config and `auth.json` (`GET /harness/opencode/login`, bridge token only).

- **The model picker:** `harnesses.models({ harness: "opencode" })` lists whatever OpenCode offers for that login. The server runs `apps/runner/src/opencode-models.ts` in a throwaway runner container with the login on stdin, so the list is exactly what a nibblet will see, and caches it for a minute. The host doesn't need the CLI.
- **On each configure:** the server fetches the login fresh, keeps only the entry for the nibblet's model's provider, and sends it only over the runner socket. The runner writes the config into the container, and the login to `/tmp/nibblet-secrets/opencode-auth.json`, with OpenCode's `auth.json` a link to it, so it never lands in the home folder or its snapshots.
- **What changes in the container:** the host config's `mcp` section is dropped, because the nibblet brings its own servers. Provider URLs on the host's `localhost` or `127.0.0.1` are pointed at `host.docker.internal`, so a local Ollama still resolves.
- **Not written back:** a provider whose OAuth token refreshes inside the container doesn't write it back to the host.
- **Without a bridge or a login:** OpenCode falls back to Anthropic and OpenAI through the credential proxy.
- **Effort:** OpenCode has no effort setting, so its models carry none and the effort menu is hidden.

## Tools (`/mcp` on the server)

| Tool                                                    | What it does                                                                                                                                              |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory_search`                                         | Semantic search over this nibblet's notes, shared notes (labelled as another nibblet's), and indexed transcript                                           |
| `memory_save`                                           | Saves a note (optionally shared with every nibblet)                                                                                                       |
| `memory_forget`                                         | Deletes one of this nibblet's own notes, or one it shared                                                                                                 |
| `schedule_create`                                       | Cron or one-shot schedule that sends the nibblet a prompt                                                                                                 |
| `schedule_list` / `schedule_delete`                     |                                                                                                                                                           |
| `instructions_update`                                   | Rewrites the nibblet's own standing instructions as it learns what it's for from the chat                                                                 |
| `heartbeat_set` / `heartbeat_remove` / `heartbeat_list` | The nibblet's own heartbeats: as many as it needs, each named, with its own interval, active hours and checklist. The UI shows them but doesn't edit them |
| `spawn_subagent`                                        | Starts a child nibblet on a task; its final answer comes back as a `subagent` turn                                                                        |
| `subagent_status`                                       | Lists children and their status                                                                                                                           |
| `payment_methods`                                       | The payment accounts it may use, its spending limit and what's left, and its cards                                                                        |
| `card_once` / `card_recurring`                          | A card for one purchase, or one holding the rest of its limit for a subscription; the details go to a file, and the tool returns the path                 |
| `card_delete`                                           | Cancels one of its cards                                                                                                                                  |

A heartbeat or schedule turn whose reply is `NO_REPLY` is stored with `quiet: true` and collapsed in the UI.

## Payments (`apps/server/src/payments`)

Payment accounts live on the server, each with its own credentials (a Mercury API token, say) in `payment_accounts`. The API never returns them, and containers never see them. Providers are plugins that implement `CardProvider` or `CryptoProvider` from `provider.ts` and are listed in `registry.ts`. Cards are one kind with any number of vendors. Crypto is a kind with no providers yet, so it's hidden from the UI and the tools.

Each nibblet has a `PaymentPolicy` (the `payments` column): a spending limit, counted per calendar month (UTC) or over all time, and Allow or Ask for each account. An account that isn't listed is None, which is the default. A card request picks an account the nibblet may use and checks the limit. For Ask it waits for an approval in the thread. It then takes a per-nibblet lock, checks the limit again, and issues the card. The ledger counts every live card's whole limit, plus what closed cards spent in the period, from the provider's transactions (`payment_charges`).

The card's number, expiry and CVC are never stored. The server sends them over the runner socket (`secret_file`), and the runner writes them as `0600` to `/tmp/nibblet-secrets/files/<card>.json`, outside the home folder, so snapshots never hold them. When a runner connects on a new socket (a container that may have restarted), the server reveals its live cards again and rewrites the files.

Every five minutes a watcher brings charges up to date and closes cards that are done:

- A one-time card closes 15 minutes after its first charge, which leaves time for a verification hold followed by the real charge, or when it expires unused (7 days by default).
- A recurring card closes once it has spent its limit, if the nibblet's limit is all time. On a monthly limit, the card's own limit at the bank starts afresh monthly.

If the provider can't cancel a card, it stays open and counted. The exceptions are when its nibblet or account is being deleted.

**Mercury** (`mercury.ts`): Mercury's Vault API only reveals the numbers of agent cards, and agent cards can only be made by a person in the Mercury app. So each account has a card source:

- **create**: `POST /cards` with a Mercury spend limit, then reveal it.
- **pool**: hand out the smallest free agent card whose limit fits, optionally only ones whose nickname matches.
- **auto**: create, and if Mercury won't reveal the new card, cancel it and use the pool, remembering the refusal for a day.

A Read and Write token needs the server's IP address allowed in Mercury.

## API

The typed contract is `contract` in `packages/protocol/src/contract.ts`. Calls are `POST /api/rpc/<dotted.path>`. Live updates are a WebSocket at `/api/live` pushing `LiveMessage`s. Browsers authenticate with `Authorization: Bearer <token>`; WebSockets take `?ticket=` from `POST /api/ticket`, which lasts 30 seconds, so long-lived tokens never go in URLs.

First run prints, and the desktop app opens, a pairing link `http(s)://host/#pair=<code>`. The UI exchanges the code at `POST /api/pair` for a long-lived token.

## Across machines: Nibblets Connect (`apps/connect`)

Each machine runs its own server. Like T3 Connect, a central service (a Cloudflare Worker with D1, signed in with Clerk) lists every server on an account, without being in the data path:

- A server links with a code approved on the central site, then sends a heartbeat every 30 seconds with its routes: local network (`NIBBLET_LAN_URLS`), Tailscale (`tailscale serve` through the host bridge), and a Cloudflare tunnel (a managed one when the central service has a zone, a quick one otherwise).
- Approving a link shows where the server asked from. If that's a different network from yours, you have to tick that you started it yourself, so a code sent by someone else can't quietly add their server to your account. Every device you're signed in on is told when a server is linked.
- The central UI (the web app built with `build:central`) tries each server's routes in that order with a `/healthz` probe, and talks to the first that answers with a five-minute ES256 token from the central service. Servers verify those tokens against its JWKS.
- The desktop app asks on first run whether to run a server on this computer. If not, it only shows the central UI.
- "Pair a device" still signs a device in to one server directly, on the same network.

See `apps/connect/README.md` for deploying it.

## Host tools (`packages/host-mcp`)

The host bridge runs on the host, in the desktop app (127.0.0.1:8789) or as `node packages/host-mcp/src/cli.ts --port 8789 --token <t> [--host 172.17.0.1]` on servers without it. The server reaches it at `HOST_MCP_URL` with `HOST_MCP_TOKEN`; empty turns it off. Nothing reaches a nibblet unless ticked for it.

- **Host MCP servers**: read in Claude's `mcpServers` format from `~/.nibblet/host-mcp.json`, then Claude Code's `~/.claude.json`, then Claude Desktop's config, with the first definition of a name winning. Each server is started on first use and served at `/mcp/<name>`; `GET /servers` lists them. A nibblet's `hostTools` names the ones it may use. Its runner registers each as `host_<name>` at the server's `/hostmcp/<name>`, which checks the nibblet's token and that list before forwarding.
- **CLI logins**: `CliPlugin`s (`gh` and `ssh` so far) detect whether a CLI is installed and signed in (`GET /clis`) and turn its login into environment variables (`GET /clis/:id/credential`). For each CLI in a nibblet's `cliCredentials`, the server fetches a fresh credential on every configure and sends it only over the runner socket. The runner puts it in the harness's environment and runs the CLI's setup (`gh auth setup-git`). It is never stored, logged, or returned by the API.
- **SSH keys**: the `ssh` plugin shares the host's SSH agent, never a key. It's offered when `ssh-add -l` lists keys. For a nibblet that has it ticked, the server bind-mounts `HOST_SSH_AUTH_SOCK` (`/run/host-services/ssh-auth.sock` on Docker Desktop and OrbStack, the host's `$SSH_AUTH_SOCK` on Linux) at `/run/nibblet/ssh-agent.sock`. Because it's a mount, ticking or unticking it restarts the container. On Linux the socket is usually `0600`, owned by the host user, so the container's `nibblet` user (uid 1001) can't open it unless the uids match.
- **A nibblet's own MCP servers** (`mcpServers`): remote URLs, or commands run inside its container by the guard. Header and env values are secrets: the API returns them as `••••`, an update that sends `••••` back keeps the stored value, and only the guard receives them.
- **Host tool approvals**: `/hostmcp/<name>` reads each request before forwarding it, and refuses batches and anything it can't read, so an "ask me first" host tool can't be called without asking.

Shared memories are written to the system prompt only when they're the nibblet's own. Other nibblets' shared notes come back from `memory_search` marked as information, not instructions.
