# syntax=docker/dockerfile:1
# Base image pinned by digest (tag: node:22-alpine). Dependabot's docker
# ecosystem keeps the digest current.
# Build context: repository root (docker build -f apps/server/Dockerfile .)
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS build
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc tsconfig.base.json ./
COPY packages/iot/package.json packages/iot/tsconfig.json ./packages/iot/
COPY packages/iot/src ./packages/iot/src
COPY apps/server/package.json apps/server/tsconfig.json ./apps/server/
COPY apps/server/src ./apps/server/src
RUN pnpm install --frozen-lockfile --filter "@open-firmware/server..."
RUN pnpm --filter "@open-firmware/server..." --if-present run build
# Drop devDependencies so the runtime stage carries production deps only.
RUN find . -name node_modules -prune -exec rm -rf {} + \
 && pnpm install --frozen-lockfile --prod --offline --filter "@open-firmware/server..."

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app /app
# /data is the default DATA_FILE location; owned by the runtime user so a
# fresh named volume mounted there is writable.
RUN mkdir -p /data && chown node:node /data
WORKDIR /app/apps/server
ENV PORT=8787
ENV DATA_FILE=/data/control-store.json
EXPOSE 8787
USER node
CMD ["node", "dist/index.js"]
