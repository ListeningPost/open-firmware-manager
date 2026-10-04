# syntax=docker/dockerfile:1
# Base image pinned by digest (tag: node:22-alpine). Dependabot's docker
# ecosystem keeps the digest current.
# Build context: repository root (docker build -f examples/full-stack/services/walkthrough/Dockerfile .)
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS build
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc tsconfig.base.json ./
COPY packages/core/package.json packages/core/tsconfig.json ./packages/core/
COPY packages/core/src ./packages/core/src
COPY packages/atproto-lite/package.json packages/atproto-lite/tsconfig.json ./packages/atproto-lite/
COPY packages/atproto-lite/src ./packages/atproto-lite/src
COPY packages/host/package.json packages/host/tsconfig.json ./packages/host/
COPY packages/host/src ./packages/host/src
COPY examples/full-stack/services/walkthrough/package.json examples/full-stack/services/walkthrough/server.js ./examples/full-stack/services/walkthrough/
RUN pnpm install --frozen-lockfile --filter "@open-firmware/example-walkthrough..."
RUN pnpm --filter "@open-firmware/example-walkthrough..." --if-present run build
# Drop devDependencies so the runtime stage carries production deps only.
RUN find . -name node_modules -prune -exec rm -rf {} + \
 && pnpm install --frozen-lockfile --prod --offline --filter "@open-firmware/example-walkthrough..."

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app /app
WORKDIR /app/examples/full-stack/services/walkthrough
ENV PORT=8099
EXPOSE 8099
USER node
CMD ["node", "server.js"]
