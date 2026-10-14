#!/usr/bin/env sh
# Starts the nibblet stack from this checkout. The desktop app does the same
# for you on a Mac; this is for servers and for working on nibblet itself.
#
# First run writes docker/.env with fresh secrets and docker/compose.creds.yaml
# with whichever subscription logins this machine has, then prints a link to
# sign in with.
set -eu
cd "$(dirname "$0")"

secret() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

# Fills in whichever secrets are missing, so the installer can write its own lines first.
touch .env
chmod 600 .env
for key in POSTGRES_PASSWORD CREDPROXY_KEY CREDPROXY_ADMIN_KEY NIBBLET_OWNER_TOKEN; do
  grep -q "^$key=." .env || echo "$key=$(secret)" >> .env
done

claude="${CLAUDE_CREDENTIALS_HOST_FILE:-$HOME/.claude/.credentials.json}"
codex="${CODEX_AUTH_HOST_FILE:-$HOME/.codex/auth.json}"

{
  echo "# Written by docker/up.sh. Mounts the logins this machine has."
  echo "services:"
  echo "  credproxy:"
  echo "    volumes:"
  found=0
  if [ -f "$claude" ]; then
    echo "      - $claude:/creds/claude/.credentials.json"
    found=1
  fi
  if [ -f "$codex" ]; then
    echo "      - $codex:/creds/codex/auth.json"
    found=1
  fi
  [ "$found" = 1 ] || echo "      []"
} > compose.creds.yaml

[ -f "$claude" ] || echo "No Claude login at $claude. Run 'claude' and sign in (on a Mac, use the desktop app: Claude Code keeps its login in the keychain)."
[ -f "$codex" ] || echo "No Codex login at $codex. Run 'codex login' to use your ChatGPT subscription."

if ! grep -q '^HOST_SSH_AUTH_SOCK=' .env; then
  # Docker Desktop and OrbStack forward the host's SSH agent at this path.
  if [ "$(uname)" = Darwin ]; then
    echo "HOST_SSH_AUTH_SOCK=/run/host-services/ssh-auth.sock" >> .env
  else
    echo "HOST_SSH_AUTH_SOCK=${SSH_AUTH_SOCK:-}" >> .env
  fi
fi

# Who this machine is, for Nibblets Connect (the server container can't tell).
grep -q '^NIBBLET_HOST_NAME=' .env || echo "NIBBLET_HOST_NAME=$(uname -n | cut -d. -f1)" >> .env
grep -q '^NIBBLET_HOST_PLATFORM=' .env || case "$(uname)" in
  Darwin) echo "NIBBLET_HOST_PLATFORM=darwin" >> .env ;;
  Linux) echo "NIBBLET_HOST_PLATFORM=linux" >> .env ;;
  *) echo "NIBBLET_HOST_PLATFORM=other" >> .env ;;
esac

# Docker's compose plugin, or the standalone binary (which also drives Podman's socket).
if docker compose version >/dev/null 2>&1; then
  compose() { docker compose -f compose.yaml -f compose.creds.yaml "$@"; }
else
  compose() { docker-compose -f compose.yaml -f compose.creds.yaml "$@"; }
fi

compose --profile build build runner
compose up -d --build
echo "Waiting for the server..."
i=0
until compose exec -T server node -e "fetch('http://127.0.0.1:8420/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null; do
  i=$((i + 1))
  [ "$i" -lt 60 ] || { echo "The server didn't come up; see 'docker compose -f docker/compose.yaml logs server'."; exit 1; }
  sleep 2
done
compose exec -T server node apps/server/src/cli.ts pair
if ! grep -q '^HOST_MCP_TOKEN=.' .env; then
  tok=$(secret)
  echo
  echo "To let nibblets use this machine's MCP servers and CLI logins, run the host bridge:"
  echo "  node packages/host-mcp/src/cli.ts --port 8789 --token $tok"
  echo "then add these to docker/.env and rerun this script:"
  echo "  HOST_MCP_URL=http://host.docker.internal:8789"
  echo "  HOST_MCP_TOKEN=$tok"
  echo "On Linux, add --host 172.17.0.1 (the Docker bridge) to the bridge command."
fi
