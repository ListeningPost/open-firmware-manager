FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json ./
COPY packages/core/package.json packages/core/tsconfig.json packages/core/vitest.config.ts ./packages/core/
COPY packages/core/src ./packages/core/src
COPY packages/atproto-lite/package.json packages/atproto-lite/tsconfig.json ./packages/atproto-lite/
COPY packages/atproto-lite/src ./packages/atproto-lite/src
COPY packages/host/package.json packages/host/tsconfig.json ./packages/host/
COPY packages/host/src ./packages/host/src
COPY examples/full-stack/services/walkthrough/package.json ./examples/full-stack/services/walkthrough/
RUN pnpm install --filter @open-firmware/example-walkthrough...
RUN pnpm --filter @open-firmware/core build \
 && pnpm --filter @open-firmware/atproto-lite build \
 && pnpm --filter @open-firmware/host build
COPY examples/full-stack/services/walkthrough/server.js ./examples/full-stack/services/walkthrough/

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app /app
WORKDIR /app/examples/full-stack/services/walkthrough
ENV PORT=8099
EXPOSE 8099
CMD ["node", "server.js"]
