FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json ./
COPY packages/core/package.json packages/core/tsconfig.json packages/core/vitest.config.ts ./packages/core/
COPY packages/core/src ./packages/core/src
COPY packages/atproto-lite/package.json packages/atproto-lite/tsconfig.json ./packages/atproto-lite/
COPY packages/atproto-lite/src ./packages/atproto-lite/src
COPY packages/client/package.json packages/client/tsconfig.json ./packages/client/
COPY packages/client/src ./packages/client/src
COPY packages/sidekar/package.json packages/sidekar/tsconfig.json ./packages/sidekar/
COPY packages/sidekar/src ./packages/sidekar/src

RUN pnpm install --filter @open-firmware/sidekar...
RUN pnpm --filter @open-firmware/core build \
 && pnpm --filter @open-firmware/atproto-lite build \
 && pnpm --filter @open-firmware/client build \
 && pnpm --filter @open-firmware/sidekar build

FROM node:22-alpine
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY --from=build /app /app
WORKDIR /app/packages/sidekar
ENV NODE_ENV=production
ENV WORK_DIR=/var/lib/sidekar
ENV STATE_FILE=/var/lib/sidekar/state.json
CMD ["node", "dist/cli.js"]
