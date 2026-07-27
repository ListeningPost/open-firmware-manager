FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json ./
COPY packages/iot/package.json packages/iot/tsconfig.json ./packages/iot/
COPY packages/iot/src ./packages/iot/src
COPY apps/server/package.json apps/server/tsconfig.json ./apps/server/
COPY apps/server/src ./apps/server/src
RUN pnpm install --filter @open-firmware/server...
RUN pnpm --filter @open-firmware/iot build && pnpm --filter @open-firmware/server build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app /app
WORKDIR /app/apps/server
ENV PORT=8787
ENV DATA_FILE=/data/control-store.json
EXPOSE 8787
CMD ["node", "dist/index.js"]
