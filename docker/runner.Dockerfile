# One per running nibblet: the runner, its three harnesses, and a browser
# that OpenComputerUse drives on a headless display.
# Trixie rather than bookworm: the OpenComputerUse release needs glibc 2.39.
FROM node:24-trixie-slim

# Chromium and what it needs to draw text without a desktop; xkb-data and
# libxkbcommon for keymaps under Wayland; Xvfb and the X libraries for
# OpenComputerUse's X11 path; git for agents that clone things.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git openssh-client tini dbus \
      chromium fonts-liberation fonts-dejavu-core fonts-noto-color-emoji \
      xkb-data libxkbcommon0 libxkbcommon-x11-0 xvfb libxtst6 libxext6 libx11-6 \
 && rm -rf /var/lib/apt/lists/*

# The GitHub CLI, from GitHub's own apt repository. Always installed; a
# nibblet only gets a login for it when the user ticks "GitHub CLI".
RUN curl -fsSL -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
      https://cli.github.com/packages/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

ARG OCU_VERSION=0.6.0
ARG TARGETARCH
RUN case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
      amd64) arch=x86_64 ;; \
      arm64) arch=aarch64 ;; \
      *) echo "unsupported architecture" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o /usr/local/bin/opencomputeruse \
      "https://github.com/IAmJSD/OpenComputerUse/releases/download/v${OCU_VERSION}/opencomputeruse-linux-${arch}" \
 && chmod +x /usr/local/bin/opencomputeruse

RUN corepack enable && corepack prepare pnpm@12.11.2 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/protocol ./packages/protocol
COPY packages/harness ./packages/harness
COPY packages/harness-claude ./packages/harness-claude
COPY packages/harness-codex ./packages/harness-codex
COPY packages/harness-opencode ./packages/harness-opencode
COPY apps/runner ./apps/runner
# Installing here, on Linux, pulls the Linux builds of the Claude Code,
# Codex and OpenCode binaries the SDKs spawn.
RUN pnpm install --prod --frozen-lockfile --filter @nibblet/runner...

RUN useradd --create-home --uid 1001 --shell /bin/bash nibblet \
 && mkdir -p /home/nibblet/work \
 && chown -R nibblet:nibblet /home/nibblet
USER nibblet
WORKDIR /home/nibblet/work
ENV NODE_ENV=production \
    NIBBLET_WORKDIR=/home/nibblet/work \
    CHROME_PATH=/usr/bin/chromium
# The browser view, served by OpenComputerUse and proxied by the server.
EXPOSE 7900
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/apps/runner/src/main.ts"]
