FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
ENV PORT=8080
ENV MESSAGE_FILE=/data/message.txt
EXPOSE 8080
CMD ["node", "server.js"]
