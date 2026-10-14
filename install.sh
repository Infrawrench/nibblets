#!/usr/bin/env bash
# Sets up Nibblets on a Linux server or VM: Docker or Podman, the agents your nibblets
# run on (Claude Code, Codex, OpenCode), this repo, the stack, and a link to
# Nibblets Connect so you can reach it from anywhere.
#
#   curl -fsSL https://nibblets.dev/install.sh | bash
#
# Safe to run again: it updates the checkout and restarts the stack.
#
# Settings, as environment variables:
#   NIBBLETS_DIR     where the repo goes (default ~/nibblets)
#   NIBBLETS_REPO    what to clone (default the GitHub repo)
#   NIBBLETS_VERSION which release, like 0.2.0, or a branch, like main
#                    (default the latest release, or main before there is one)
#   NIBBLETS_YES=1   answer yes to every question
#
# Copyright (C) 2026 Infrawrench. Licensed under the GNU GPL, version 2.

set -euo pipefail

REPO="${NIBBLETS_REPO:-https://github.com/Infrawrench/nibblets.git}"
# NIBBLETS_BRANCH is the older name for NIBBLETS_VERSION.
WANT="${NIBBLETS_VERSION:-${NIBBLETS_BRANCH:-}}"
GITHUB_REPO="Infrawrench/nibblets"
REF=""
DIR="${NIBBLETS_DIR:-$HOME/nibblets}"
YES="${NIBBLETS_YES:-0}"
TOOLS="$HOME/.local/share/nibblets"
CENTRAL="https://app.nibblets.dev"
BRIDGE_PORT=8789
LOG="$TOOLS/install.log"

export PATH="$HOME/.local/bin:$HOME/.opencode/bin:$TOOLS/node/bin:$TOOLS/bin:$PATH"

# Looks

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$'\e[1m' D=$'\e[2m' R=$'\e[0m'
  PINK=$'\e[38;5;211m' PEACH=$'\e[38;5;216m' GREEN=$'\e[38;5;114m'
  YELLOW=$'\e[38;5;221m' RED=$'\e[38;5;203m' BLUE=$'\e[38;5;111m'
else
  B="" D="" R="" PINK="" PEACH="" GREEN="" YELLOW="" RED="" BLUE=""
fi

banner() {
  printf '\n'
  printf '%s\n' \
    "${PEACH}         .--.     .--.${R}" \
    "${PEACH}        (    '---'    )${R}" \
    "${PEACH}         \\   ${R}${B}o   o${R}${PEACH}   /${R}" \
    "${PEACH}        ( ${PINK}=${R}${PEACH}    ${PINK}v${R}${PEACH}    ${PINK}=${R}${PEACH} )${R}      ${D}hello from your hamsters${R}" \
    "${PEACH}         '.__     __.'${R}" \
    "${PEACH}             \"\"\"\"\"${R}" \
    ""
  printf '%s\n' \
    "${PINK}${B}   _   _  _  _      _      _        _${R}" \
    "${PINK}${B}  | \\ | |(_)| |__  | |__  | |  ___ | |_  ___${R}" \
    "${PINK}${B}  |  \\| || || '_ \\ | '_ \\ | | / _ \\| __|/ __|${R}" \
    "${PINK}${B}  | |\\  || || |_) || |_) || ||  __/| |_ \\__ \\${R}" \
    "${PINK}${B}  |_| \\_||_||_.__/ |_.__/ |_| \\___| \\__||___/${R}" \
    "" \
    "  ${D}Always-on agents that live on your own machines.${R}" \
    ""
}

STEP=0
step() {
  STEP=$((STEP + 1))
  printf '\n%s\n' "${B}${BLUE}  ── $STEP · $1 ──${R}"
}
say() { printf '  %s\n' "$*"; }
ok() { printf '  %s %s\n' "${GREEN}✔${R}" "$*"; }
warn() { printf '  %s %s\n' "${YELLOW}⚠${R}" "$*"; }
fail() {
  printf '\n  %s %s\n' "${RED}✖${R}" "$*" >&2
  exit 1
}
hint() { printf '    %s\n' "${D}$*${R}"; }

# Questions come from the terminal, even when this script arrives on stdin.
INTERACTIVE=0
if [ "$YES" != 1 ] && { : </dev/tty; } 2>/dev/null; then INTERACTIVE=1; fi

ask() {
  if [ "$INTERACTIVE" != 1 ]; then return 0; fi
  local reply
  printf '  %s %s %s ' "${PINK}?${R}" "$1" "${D}[Y/n]${R}"
  read -r reply </dev/tty || reply=""
  case "$reply" in [nN]*) return 1 ;; *) return 0 ;; esac
}

key() {
  local k
  IFS= read -rsn1 k </dev/tty || k=""
  printf '%s' "$k"
}

FRAMES=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏)
TICK=0
FRAME=""
# Sets FRAME, rather than printing it, so the count survives (no subshell).
next_frame() {
  TICK=$(((TICK + 1) % ${#FRAMES[@]}))
  FRAME=${FRAMES[TICK]}
}

# Runs a long command with a spinner and its latest line, keeping the full
# output in the log. Prints the tail of the log if it fails.
spin() {
  local label="$1"
  shift
  printf '\n==> %s\n' "$label" >>"$LOG"
  "$@" >>"$LOG" 2>&1 </dev/null &
  local pid=$! i=0 start=$SECONDS width last
  width=$(($(tput cols 2>/dev/null || echo 80) - ${#label} - 16))
  ((width > 10)) || width=10
  if [ -t 1 ]; then
    while kill -0 "$pid" 2>/dev/null; do
      last=$(tail -n 1 "$LOG" 2>/dev/null | sed 's/\x1b\[[0-9;]*[A-Za-z]//g' | tr -d '\r\033' | cut -c1-"$width")
      next_frame
      printf '\r\033[K  %s %s %s %s' "${PINK}${FRAME}${R}" "$label" "${D}$((SECONDS - start))s${R}" "${D}${last}${R}"
      sleep 0.15
    done
    printf '\r\033[K'
  fi
  if wait "$pid"; then
    ok "$label ${D}($((SECONDS - start))s)${R}"
  else
    printf '  %s %s\n\n' "${RED}✖${R}" "$label"
    tail -n 25 "$LOG" | tr -d '\r' | grep -v '^[[:space:]]*$' | sed 's/^/    /'
    fail "That didn't work. The whole log is in $LOG"
  fi
}

# The machine

SUDO=""
need_root() {
  if [ "$(id -u)" = 0 ]; then return; fi
  command -v sudo >/dev/null || fail "This needs root for installing packages, and sudo isn't here."
  SUDO="sudo"
  if ! sudo -n true 2>/dev/null; then
    say "🔐 Installing system packages needs your password for sudo."
    # shellcheck disable=SC2024 # The password prompt reads the terminal, not sudo.
    sudo -v </dev/tty || fail "sudo didn't work."
  fi
}

PM=""
detect_pm() {
  for pm in apt-get dnf yum pacman zypper apk; do
    if command -v "$pm" >/dev/null; then
      PM=$pm
      return
    fi
  done
}

pkg_install() {
  case "$PM" in
    apt-get) $SUDO env DEBIAN_FRONTEND=noninteractive apt-get update -qq && $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" ;;
    dnf | yum) $SUDO "$PM" install -y -q "$@" ;;
    pacman) $SUDO pacman -Sy --noconfirm --needed "$@" ;;
    zypper) $SUDO zypper -q install -y "$@" ;;
    apk) $SUDO apk add -q "$@" ;;
    *) return 1 ;;
  esac
}

check_machine() {
  step "🔍 Looking at this machine"
  [ "$(uname -s)" = Linux ] || fail "This installer is for Linux. On a Mac, use the Nibblets desktop app."
  case "$(uname -m)" in
    x86_64 | amd64) ARCH=x64 ;;
    aarch64 | arm64) ARCH=arm64 ;;
    *) fail "Nibblets runs on x86-64 and ARM64; this is $(uname -m)." ;;
  esac
  local distro="Linux"
  # shellcheck disable=SC1091
  if [ -r /etc/os-release ]; then distro=$(. /etc/os-release && echo "${PRETTY_NAME:-Linux}"); fi
  ok "$distro on $(uname -m)"
  detect_pm
  local missing=()
  for tool in git curl tar gzip; do command -v "$tool" >/dev/null || missing+=("$tool"); done
  if ((${#missing[@]})); then
    [ -n "$PM" ] || fail "Please install ${missing[*]}, then run this again."
    need_root
    spin "Installing ${missing[*]}" pkg_install "${missing[@]}" ca-certificates
  fi
  ok "git and curl are here"
}

env_set() {
  local file="$DIR/docker/.env"
  touch "$file" && chmod 600 "$file"
  if grep -q "^$1=" "$file"; then
    sed -i "s|^$1=.*|$1=$2|" "$file"
  else
    echo "$1=$2" >>"$file"
  fi
}
env_get() { { grep "^$1=" "$DIR/docker/.env" 2>/dev/null || true; } | head -n1 | cut -d= -f2-; }

# The container engine: Docker, or Podman through its Docker-compatible socket.

ENGINE=""
PODMAN_SOCK=/run/podman/podman.sock
DOCKER=(docker)

engine_access() {
  if [ "$ENGINE" = podman ]; then
    # Rootful Podman, like Docker Engine; its socket belongs to root.
    if [ "$(id -u)" = 0 ]; then
      DOCKER=(env)
    else
      need_root
      DOCKER=(sudo env "HOME=$HOME" "PATH=$PATH")
    fi
    DOCKER+=("DOCKER_HOST=unix://$PODMAN_SOCK" "DOCKER_SOCKET=$PODMAN_SOCK")
  elif docker info >/dev/null 2>&1; then
    DOCKER=(docker)
  elif command -v sg >/dev/null && sg docker -c "docker info" >/dev/null 2>&1; then
    # Just added to the group; this shell doesn't know yet.
    DOCKER=(sg docker -c)
  else
    need_root
    DOCKER=(sudo env "HOME=$HOME" "PATH=$PATH")
  fi
}

# Runs a command line with whatever access to the engine this shell has.
with_docker() {
  if [ "${DOCKER[0]}" = sg ]; then
    sg docker -c "$*"
  elif [ "${DOCKER[0]}" = docker ]; then
    bash -c "$*"
  else
    "${DOCKER[@]}" bash -c "$*"
  fi
}

# How to run the engine's own CLI by hand, for the hints at the end.
engine_cli() {
  if [ "$ENGINE" = podman ] && [ "$(id -u)" != 0 ]; then echo "sudo podman"; else echo "$ENGINE"; fi
}

choose_engine() {
  if command -v docker >/dev/null && ! docker --version 2>/dev/null | grep -qi podman; then
    ENGINE=docker
    return
  fi
  if command -v podman >/dev/null; then
    ENGINE=podman
    return
  fi
  ENGINE=docker
  if [ "$INTERACTIVE" = 1 ]; then
    say "Neither is installed yet. Which would you like?"
    printf '\n   %s  🐳 Docker Engine %s\n' "${B}${PINK}[1]${R}" "${D}(the usual choice)${R}"
    printf '   %s  🦭 Podman %s\n\n' "${B}${PINK}[2]${R}" "${D}(daemonless, from your distro)${R}"
    local k
    while true; do
      k=$(key)
      case "$k" in
        1 | "") break ;;
        2) ENGINE=podman && break ;;
        q | Q) exit 0 ;;
      esac
    done
  fi
  need_root
  if [ "$ENGINE" = docker ]; then
    spin "Downloading Docker's installer" curl -fsSL https://get.docker.com -o "$TOOLS/get-docker.sh"
    spin "Installing Docker Engine" $SUDO sh "$TOOLS/get-docker.sh"
  else
    [ -n "$PM" ] || fail "Please install Podman, then run this again."
    spin "Installing Podman" pkg_install podman
  fi
}

# Podman brings no compose of its own that handles everything here, so this
# fetches Docker's, which works against Podman's socket.
compose_for_podman() {
  if command -v docker-compose >/dev/null || docker compose version >/dev/null 2>&1; then return; fi
  local arch file url want
  arch=$(uname -m)
  [ "$arch" = arm64 ] && arch=aarch64
  file="docker-compose-linux-$arch"
  url="https://github.com/docker/compose/releases/latest/download/$file"
  mkdir -p "$TOOLS/bin"
  spin "Downloading Docker Compose" curl -fsSL "$url" -o "$TOOLS/bin/$file"
  want=$(curl -fsSL "$url.sha256" | cut -d' ' -f1)
  [ "$(sha256sum "$TOOLS/bin/$file" | cut -d' ' -f1)" = "$want" ] || fail "Docker Compose didn't match its checksum."
  mv "$TOOLS/bin/$file" "$TOOLS/bin/docker-compose"
  chmod +x "$TOOLS/bin/docker-compose"
  hash -r
}

setup_engine() {
  step "🐳 Containers"
  say "Each nibblet lives in its own little container. Docker and Podman both work."
  choose_engine
  local version
  if [ "$ENGINE" = podman ]; then
    if ! command -v systemctl >/dev/null || [ ! -d /run/systemd/system ]; then
      fail "Podman needs systemd here for its API socket. Start 'podman system service --time=0 unix://$PODMAN_SOCK' and set DOCKER_HOST yourself."
    fi
    need_root
    $SUDO systemctl is-active --quiet podman.socket || spin "Starting Podman's API socket" $SUDO systemctl enable --now podman.socket
    compose_for_podman
    engine_access
    version=$(with_docker "podman --version" | awk '{print $NF}')
    env_set DOCKER_SOCKET "$PODMAN_SOCK"
    ok "Podman $version is ready 🦭"
    return
  fi
  if command -v systemctl >/dev/null && ! $SUDO systemctl is-active --quiet docker 2>/dev/null; then
    need_root
    spin "Starting Docker" $SUDO systemctl enable --now docker
  fi
  if [ "$(id -u)" != 0 ] && ! id -nG "$(id -un)" | tr ' ' '\n' | grep -qx docker; then
    need_root
    $SUDO usermod -aG docker "$(id -un)"
    ok "Added you to the docker group ${D}(new logins pick it up)${R}"
  fi
  engine_access
  version=$(with_docker "docker version --format '{{.Server.Version}}'" 2>/dev/null) ||
    fail "Docker is installed but isn't answering. Try 'sudo systemctl start docker'."
  if ! with_docker "docker compose version" >/dev/null 2>&1; then
    need_root
    spin "Installing Docker Compose" pkg_install docker-compose-plugin
  fi
  ok "Docker $version is running"
}

# Node, for the host bridge (it shares this machine's logins and MCP servers
# with nibblets) and for installing Codex.

node_ok() { command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 24 ] 2>/dev/null; }

setup_node() {
  if node_ok; then return; fi
  local base="https://nodejs.org/dist/latest-v24.x" file
  file=$(curl -fsSL "$base/SHASUMS256.txt" | awk -v a="linux-$ARCH.tar.gz" '$2 ~ a"$" {print $2; exit}')
  [ -n "$file" ] || fail "Couldn't find a Node.js 24 download for linux-$ARCH."
  spin "Downloading Node.js (${file%.tar.gz})" curl -fsSL "$base/$file" -o "$TOOLS/$file"
  local want
  want=$(curl -fsSL "$base/SHASUMS256.txt" | awk -v f="$file" '$2 == f {print $1}')
  [ "$(sha256sum "$TOOLS/$file" | cut -d' ' -f1)" = "$want" ] || fail "Node.js didn't match its checksum."
  rm -rf "$TOOLS/node" && mkdir -p "$TOOLS/node"
  tar -xzf "$TOOLS/$file" -C "$TOOLS/node" --strip-components=1
  rm -f "$TOOLS/$file"
  hash -r
  # So Codex, which runs on Node, works in new shells too.
  if ! grep -qs "$TOOLS/node/bin" "$HOME/.profile"; then
    # shellcheck disable=SC2016 # $HOME and $PATH are for the profile to expand.
    printf '\n# Added by the Nibblets installer\nexport PATH="$HOME/.local/bin:%s:$PATH"\n' "$TOOLS/node/bin" >>"$HOME/.profile"
  fi
  ok "Node.js $(node -v) ${D}(in $TOOLS/node, added to ~/.profile)${R}"
}

# The agents, as plugins: a name, how to tell it's installed and signed in,
# and how to install it and sign in.

AGENTS=(claude codex opencode)

agent_name() {
  case "$1" in
    claude) echo "Claude Code" ;;
    codex) echo "Codex" ;;
    opencode) echo "OpenCode" ;;
  esac
}
agent_blurb() {
  case "$1" in
    claude) echo "your Claude subscription" ;;
    codex) echo "your ChatGPT subscription" ;;
    opencode) echo "API keys, Copilot, and more" ;;
  esac
}
agent_emoji() {
  case "$1" in
    claude) echo "🧡" ;;
    codex) echo "💚" ;;
    opencode) echo "💙" ;;
  esac
}
agent_installed() { command -v "$1" >/dev/null; }
agent_signed_in() {
  case "$1" in
    claude) [ -s "$HOME/.claude/.credentials.json" ] ;;
    codex) [ -s "$HOME/.codex/auth.json" ] ;;
    opencode) [ -s "${XDG_DATA_HOME:-$HOME/.local/share}/opencode/auth.json" ] ;;
  esac
}
agent_install() {
  case "$1" in
    claude) curl -fsSL https://claude.ai/install.sh | bash ;;
    codex) setup_node && npm install -g --prefix "$HOME/.local" @openai/codex ;;
    opencode) curl -fsSL https://opencode.ai/install | bash ;;
  esac
}
agent_login() {
  case "$1" in
    claude) claude auth login ;;
    # Device codes, because a browser elsewhere can't reach this machine's localhost.
    codex) codex login --device-auth || {
      hint "If that didn't work, turn on device code sign-in in ChatGPT's security settings,"
      hint "or forward the port: ssh -L 1455:localhost:1455 this-machine, then run 'codex login'."
      return 1
    } ;;
    opencode) opencode auth login ;;
  esac
}

any_signed_in() {
  for a in "${AGENTS[@]}"; do agent_signed_in "$a" && return 0; done
  return 1
}

draw_agents() {
  local i=0 a name state colour
  printf '\n  %s\n' "${B}🐹 Your agents${R} ${D}(each nibblet runs on one; you need at least one)${R}"
  printf '  %s\n' "${D}──────────────────────────────────────────────────────────────${R}"
  for a in "${AGENTS[@]}"; do
    i=$((i + 1))
    name=$(agent_name "$a")
    if agent_signed_in "$a"; then
      state="✔ signed in" colour=$GREEN
    elif agent_installed "$a"; then
      state="◐ needs signing in" colour=$YELLOW
    else
      state="○ not installed" colour=$D
    fi
    # Padded by hand: printf counts bytes, and the symbols are three each.
    printf '   %s  %s  %s%s%s%s%s\n' "${B}${PINK}[$i]${R}" "$(agent_emoji "$a")" "$name" \
      "$(printf '%*s' $((13 - ${#name})) '')" "$colour$state$R" \
      "$(printf '%*s' $((20 - ${#state})) '')" "${D}$(agent_blurb "$a")${R}"
  done
  printf '  %s\n' "${D}──────────────────────────────────────────────────────────────${R}"
}

setup_agents() {
  step "🤖 Agents"
  if [ "$INTERACTIVE" != 1 ]; then
    draw_agents
    any_signed_in || warn "No agent is signed in. Run this again in a terminal to set one up."
    return
  fi
  while true; do
    draw_agents
    if any_signed_in; then
      printf '\n  %s\n' "Press ${B}1${R}-${B}${#AGENTS[@]}${R} to set up another, or ${B}Enter${R} to carry on. ${D}q quits.${R}"
    else
      printf '\n  %s\n' "Press ${B}1${R}-${B}${#AGENTS[@]}${R} to install one and sign in. ${D}q quits.${R}"
    fi
    local k
    k=$(key)
    case "$k" in
      q | Q) printf '\n'; say "👋 Bye for now. Run this again whenever you like."; exit 0 ;;
      "")
        if any_signed_in; then return; fi
        warn "Sign in to at least one first. ${D}(Or press s to skip; nibblets won't run until you do.)${R}"
        ;;
      s | S) any_signed_in || { warn "Skipping. Run this again to add an agent later."; return; } ;;
      [1-9])
        local a="${AGENTS[$((k - 1))]:-}"
        [ -n "$a" ] || continue
        local name
        name=$(agent_name "$a")
        printf '\n'
        # Ctrl-C stops the install or sign-in and comes back here, rather than quitting.
        trap 'printf "\n"' INT
        if ! agent_installed "$a"; then
          say "📦 Installing $name…"
          if agent_install "$a" </dev/tty; then
            hash -r
            ok "$name installed"
          else
            warn "$name didn't install."
          fi
        fi
        if agent_installed "$a"; then
          say "🔑 Signing in to $name. Follow along below; open the link on any device."
          printf '\n'
          if agent_login "$a" </dev/tty && agent_signed_in "$a"; then
            printf '\n'
            ok "$name is ready 🎉"
          else
            printf '\n'
            warn "$name isn't signed in yet. Press $k to try again."
          fi
        fi
        trap - INT
        ;;
    esac
  done
}

# The code and the stack

# What to check out: the release asked for (0.2.0 or v0.2.0), a branch asked
# for, or else the latest release. Before there's a release, main.
resolve_ref() {
  case "$WANT" in
    "") ;;
    v[0-9]*) REF="$WANT" && return ;;
    [0-9]*) REF="v$WANT" && return ;;
    *) REF="$WANT" && return ;;
  esac
  local tag
  tag=$(curl -fsSL -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$GITHUB_REPO/releases/latest" 2>/dev/null |
    sed -n 's/^[[:space:]]*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1 || true)
  REF="${tag:-main}"
}

setup_repo() {
  step "📥 Getting Nibblets"
  resolve_ref
  local what="Nibblets ${REF#v}"
  [ "$REF" = main ] && what="the latest Nibblets (main; there's no release yet)"
  if [ -d "$DIR/.git" ]; then
    # Fetched and checked out rather than pulled, so it works for a tag or a branch.
    spin "Updating to $what" bash -c "git -C '$DIR' fetch --depth 1 origin '$REF' && git -C '$DIR' checkout -q --detach FETCH_HEAD"
  else
    [ ! -e "$DIR" ] || fail "$DIR exists and isn't a Nibblets checkout. Set NIBBLETS_DIR to put it somewhere else."
    spin "Getting $what" git clone --depth 1 --branch "$REF" "$REPO" "$DIR"
  fi
  ok "In $DIR, at $(git -C "$DIR" log -1 --format='%h, %cr')"
}

prepare_bridge() {
  setup_node
  spin "Installing the host bridge's packages" bash -c "cd '$DIR' && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm install --frozen-lockfile --filter '@nibblet/host-mcp...'"
  local token
  token=$(env_get HOST_MCP_TOKEN)
  [ -n "$token" ] || token=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  env_set HOST_MCP_TOKEN "$token"
  env_set HOST_MCP_URL "http://host.docker.internal:$BRIDGE_PORT"
}

start_bridge() {
  # Listens only where the containers see the host, which Docker and Podman put in different places.
  local ip cmd
  ip=$(with_docker "$ENGINE exec nibblet-server-1 node -e \"require('dns').lookup('host.docker.internal',(e,a)=>console.log(a??''))\"" 2>/dev/null | tr -d '\r' || true)
  [ -n "$ip" ] || ip=172.17.0.1
  # --repo lets the server ask it to install new releases here.
  cmd="$(command -v node) $DIR/packages/host-mcp/src/cli.ts --host $ip --port $BRIDGE_PORT --repo $DIR"
  if command -v systemctl >/dev/null && [ -d /run/systemd/system ]; then
    need_root
    $SUDO tee /etc/systemd/system/nibblets-bridge.service >/dev/null <<UNIT
[Unit]
Description=Nibblets host bridge (shares this machine's logins and MCP servers with nibblets)
After=network-online.target docker.service podman.socket

[Service]
User=$(id -un)
Environment=HOME=$HOME
Environment=PATH=$PATH:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=$DIR/docker/.env
ExecStart=$cmd
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
    $SUDO systemctl daemon-reload
    $SUDO systemctl enable nibblets-bridge >/dev/null 2>&1
    spin "Starting the host bridge on $ip" $SUDO systemctl restart nibblets-bridge
  else
    warn "No systemd here, so start the host bridge yourself:"
    hint "HOST_MCP_TOKEN=\$(grep ^HOST_MCP_TOKEN= $DIR/docker/.env | cut -d= -f2) $cmd"
  fi
}

PAIR_LINK=""
start_stack() {
  step "🏗️  Building your hamsters' home"
  say "The first build takes a few minutes. Good time for a cup of tea ☕"
  prepare_bridge
  local start_log=$((0 + $(wc -l <"$LOG")))
  spin "Building and starting the stack" with_docker "cd '$DIR' && sh docker/up.sh"
  PAIR_LINK=$(tail -n +"$start_log" "$LOG" | grep -o 'http[^ ]*#pair=[A-Za-z0-9_-]*' | tail -n1 || true)
  start_bridge
  ok "Nibblets is running on this machine"
}

rpc() {
  curl -fsS -X POST -H "authorization: Bearer $(env_get NIBBLET_OWNER_TOKEN)" \
    -H "content-type: application/json" -d '{}' "http://127.0.0.1:${NIBBLET_PORT:-8420}/api/rpc/$1"
}
# Picks one field out of an RPC reply.
field() {
  node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{let v;try{v=process.argv[1].split(".").reduce((o,k)=>o?.[k],JSON.parse(s).data)}catch{}process.stdout.write(v==null?"":String(v))})' "$1"
}

LINKED=0
setup_connect() {
  step "🌍 Reaching it from anywhere"
  local status
  status=$(rpc connect.status 2>/dev/null || true)
  if [ "$(printf '%s' "$status" | field state)" = linked ]; then
    ok "Already linked to Nibblets Connect as $(printf '%s' "$status" | field account)"
    LINKED=1
    return
  fi
  say "Nibblets Connect gives this server a private, secure address, and shows"
  say "every server you link in one place: ${BLUE}$CENTRAL${R}"
  ask "Link this server to your account now?" || return 0
  status=$(rpc connect.start) || { warn "Couldn't reach Nibblets Connect. You can link later in Settings."; return 0; }
  local code url
  code=$(printf '%s' "$status" | field code)
  url=$(printf '%s' "$status" | field approveUrl)
  printf '\n  %s\n\n' "Open this on any device, sign in, and approve:"
  printf '      %s\n\n' "${B}${BLUE}$url${R}"
  printf '  %s  %s\n\n' "Your code is" "${B}${PINK}  $code  ${R}"
  local deadline=$((SECONDS + 900)) state
  while [ $SECONDS -lt $deadline ]; do
    state=$(rpc connect.status 2>/dev/null | field state || true)
    if [ "$state" = linked ]; then
      printf '\r\033[K'
      ok "Linked to $(rpc connect.status | field account) 🎉"
      LINKED=1
      return
    fi
    [ "$state" = linking ] || { printf '\r\033[K'; warn "That code isn't waiting any more. You can link later in Settings."; return; }
    if [ -t 1 ]; then
      next_frame
      printf '\r\033[K  %s %s' "${PINK}${FRAME}${R}" "${D}Waiting for you to approve it…${R}"
    fi
    sleep 2
  done
  printf '\r\033[K'
  warn "Still waiting. It'll finish by itself once you approve it."
}

finish() {
  printf '\n%s\n\n' "${B}${GREEN}  ✨ All done! Your nibblets have a home. ✨${R}"
  if [ "$LINKED" = 1 ]; then
    say "🐹 Open ${B}${BLUE}$CENTRAL${R} and make your first nibblet."
    say "📱 It works on your phone too: add it to your Home Screen for notifications."
  else
    say "🐹 To open it from your own computer, forward the port:"
    hint "ssh -L 8420:127.0.0.1:8420 $(id -un)@$(uname -n)"
    if [ -n "$PAIR_LINK" ]; then
      say "   then open this within 15 minutes to sign in:"
      hint "$PAIR_LINK"
    else
      say "   then get a sign-in link with:"
      hint "$(engine_cli) exec nibblet-server-1 node apps/server/src/cli.ts pair"
    fi
  fi
  printf '\n'
  say "${D}🔁 Update or add agents: run this installer again${R}"
  say "${D}📜 Logs: $(engine_cli) logs -f nibblet-server-1${R}"
  printf '\n'
}

main() {
  mkdir -p "$TOOLS"
  : >"$LOG"
  banner
  check_machine
  setup_repo
  setup_engine
  setup_agents
  start_stack
  setup_connect
  finish
}

main "$@"
