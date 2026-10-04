# syntax=docker/dockerfile:1
# Base image pinned by digest (tag: node:22-alpine). Dependabot's docker
# ecosystem keeps the digest current.
# Build context: repository root (docker build -f examples/full-stack/services/sidekar/Dockerfile .)
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS build
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc tsconfig.base.json ./
COPY packages/core/package.json packages/core/tsconfig.json ./packages/core/
COPY packages/core/src ./packages/core/src
COPY packages/atproto-lite/package.json packages/atproto-lite/tsconfig.json ./packages/atproto-lite/
COPY packages/atproto-lite/src ./packages/atproto-lite/src
COPY packages/client/package.json packages/client/tsconfig.json ./packages/client/
COPY packages/client/src ./packages/client/src
COPY packages/sidekar/package.json packages/sidekar/tsconfig.json ./packages/sidekar/
COPY packages/sidekar/src ./packages/sidekar/src
RUN pnpm install --frozen-lockfile --filter "@open-firmware/sidekar..."
RUN pnpm --filter "@open-firmware/sidekar..." --if-present run build
# Drop devDependencies so the runtime stage carries production deps only.
RUN find . -name node_modules -prune -exec rm -rf {} + \
 && pnpm install --frozen-lockfile --prod --offline --filter "@open-firmware/sidekar..."

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app /app
# Writable paths used by the full-stack example: the state/work dir and the
# shared /site volume. Owned by the runtime user so fresh named volumes
# mounted there are writable.
RUN mkdir -p /var/lib/sidekar /site && chown node:node /var/lib/sidekar /site
WORKDIR /app/packages/sidekar
ENV WORK_DIR=/var/lib/sidekar
ENV STATE_FILE=/var/lib/sidekar/state.json
USER node
CMD ["node", "dist/cli.js"]
