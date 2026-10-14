# Stage 1: Build React 19 + Vite PWA Frontend
FROM node:22-slim AS client-builder
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# Stage 2: Standalone Production Server
FROM node:22-slim
WORKDIR /app

# Install build tools for better-sqlite3 native fallback if needed
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/
COPY config.json ./config.json
COPY --from=client-builder /app/client/dist ./client/dist

RUN mkdir -p /app/data /app/data/notes /app/data/backups

ENV NODE_ENV=production
ENV PORT=3004
EXPOSE 3004

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3004/api/health || exit 1

CMD ["node", "src/server.js"]
