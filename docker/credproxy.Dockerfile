# The credential proxy. Small: protocol types, Hono, zod.
FROM node:24-bookworm-slim
# Lets the server find this image's old builds to tidy up (Orchestrator.pruneImages).
LABEL nibblet.image=credproxy
RUN corepack enable && corepack prepare pnpm@12.11.2 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/protocol ./packages/protocol
COPY apps/credproxy ./apps/credproxy
RUN pnpm install --prod --frozen-lockfile --filter @nibblet/credproxy...
ENV NODE_ENV=production
EXPOSE 8787
# Root, so it can write back to credential files bind-mounted from the host
# whatever uid owns them there.
CMD ["node", "apps/credproxy/src/main.ts"]
