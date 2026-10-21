FROM node:24-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@12.11.2 --activate
WORKDIR /app

# The web UI is static; build it and keep only dist.
FROM base AS web
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile --filter @nibblets/web...
RUN pnpm --filter @nibblets/web build

# The server runs its TypeScript directly (Node strips the types), so the
# image carries sources and production dependencies, and no build output.
FROM base
# Lets the server find this image's old builds to tidy up (Orchestrator.pruneImages).
LABEL nibblet.image=server
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/server ./apps/server
RUN pnpm install --prod --frozen-lockfile --filter @nibblets/server...
COPY --from=web /app/apps/web/dist ./apps/web/dist
ENV NODE_ENV=production \
    PORT=8420 \
    NIBBLET_DATA_DIR=/data \
    NIBBLET_WEB_DIST=/app/apps/web/dist
VOLUME /data
EXPOSE 8420
CMD ["node", "apps/server/src/main.ts"]
