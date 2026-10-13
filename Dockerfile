# Stage 1: Build Frontend
FROM node:22-slim AS client-builder
WORKDIR /app/client
COPY client/package*.json ./
RUN npm install
COPY client/ ./
RUN npm run build

# Stage 2: Production Server
FROM node:22-slim
WORKDIR /app

# Copy monorepo dependencies
COPY lib/ /app/lib/
COPY projects/krusch-cascade-router/ /app/projects/krusch-cascade-router/

WORKDIR /app/projects/krusch-companion
COPY projects/krusch-companion/package*.json ./
RUN npm install --omit=dev

COPY projects/krusch-companion/ ./
COPY --from=client-builder /app/client/dist ./client/dist

ENV NODE_ENV=production
ENV PORT=3004
EXPOSE 3004

CMD ["node", "src/server.js"]
