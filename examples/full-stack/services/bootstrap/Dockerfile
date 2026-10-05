# syntax=docker/dockerfile:1
# Base image pinned by digest (tag: node:22-alpine). Dependabot's docker
# ecosystem keeps the digest current.
# Build context: this directory. No dependencies, so a single stage suffices.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node bootstrap.mjs ./
# /config is a shared volume: the DIDs written here are read by the other services.
RUN mkdir -p /config && chown node:node /config
ENV OUT_DIR=/config
USER node
CMD ["node", "bootstrap.mjs"]
