# Nibblets

Self-hosted, always-on agents, each one a hamster you dress up yourself. They're like Grok Bot or ChatGPT dots, but they run on your own machines and use the Claude and ChatGPT subscriptions you already have.

A nibblet is a thread that never really ends. It runs in its own Docker container on the Claude Agent SDK, Codex, or OpenCode. It wakes on a heartbeat and on schedules it sets for itself, and it remembers things in Postgres with pgvector rather than on its own disk. It can spawn sub-agents, which are child nibblets, and it has a Chromium browser you can watch and take over.

## Running it

On a Linux server or VM, one command sets up Docker or Podman, your agents, and the stack, then links it to Nibblets Connect:

```sh
curl -fsSL https://nibblets.dev/install.sh | bash
```

Run it again to update or to sign in to another agent.

On a Mac, the desktop app (`apps/desktop`) does all of this for you: it checks Docker, finds your Claude and Codex logins, starts the stack, and opens the UI signed in.

By hand, from the repo:

```sh
docker build -f docker/runner.Dockerfile -t nibblet/runner:dev .
cp docker/.env.example docker/.env   # then fill in the secrets
docker compose -f docker/compose.yaml -p nibblet up -d --build
docker compose -p nibblet exec server node apps/server/src/cli.ts pair
```

Open the link it prints. To reach it from anywhere, press Connect in Settings → Remote access and approve the code on [Nibblets Connect](https://app.nibblets.dev), signed in to your account: every server you connect shows up there.

## How it fits together

See [ARCHITECTURE.md](ARCHITECTURE.md). In short:

- **server**: the API, the UI, the scheduler and heartbeats, the nibblet tools (over MCP), and Docker orchestration
- **db**: Postgres with pgvector, which holds every durable thing
- **credproxy**: holds your subscription credentials and injects them into harness traffic, so containers never see a real token
- **one runner container per nibblet**: its harness, plus OpenComputerUse driving Chromium on a headless Wayland display
- **tunnel**: `cloudflared`, run when the server is linked to Nibblets Connect
- **Nibblets Connect** (`apps/connect`): the central service on Cloudflare Workers where you sign in and see every server

To see nibblets from several machines in one place, connect each server to your account and sign in to Nibblets Connect. The desktop app can also skip running a server and just show Nibblets Connect.

## Developing

```sh
corepack enable
pnpm install
pnpm typecheck
pnpm test
pnpm format
```

The server and runner run TypeScript directly on Node 24, with no build step. The web UI is Vite: `pnpm --filter @nibblet/web dev` proxies the API to a server on `:8420`.

Harnesses are plugins (`packages/harness-*`) that implement `HarnessPlugin` from `@nibblet/harness`. Credential sources in the proxy and embedding backends in the server follow the same pattern.

## Licence

GPL-2.0. See [LICENSE](LICENSE).
