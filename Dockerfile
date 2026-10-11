# Relay runs on plain ws inside the container; the host terminates TLS at the
# edge and forwards to $PORT. The relay already answers GET /health.
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY relay/ ./relay/
EXPOSE 8787
CMD ["node", "relay/server.js"]
