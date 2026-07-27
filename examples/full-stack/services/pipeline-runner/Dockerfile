FROM node:22-alpine
WORKDIR /app
COPY package.json runner.mjs ./
ENV POLL_MS=4000
ENV AUTO_ACK=1
CMD ["node", "runner.mjs"]
