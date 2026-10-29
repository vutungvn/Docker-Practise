# ShopFast - production image (multi-stage, alpine, non-root, no baked secrets)
# Build:  docker build -t shopfast:after .
# Run:    docker run -d -p 3000:3000 --env-file .env shopfast:after

ARG NODE_VERSION=20-alpine

# ---------- Stage 1: production dependencies only ----------
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
# Copy only the manifests so this layer stays cached until dependencies change.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# ---------- Stage 2: compile TypeScript ----------
FROM node:${NODE_VERSION} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund
# Source changes only invalidate the layers from here down.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- Stage 3: runtime ----------
FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app

# Files stay owned by root (read-only for the app user); the process runs as "node".
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3000/health || exit 1

# Run node directly (not npm / ts-node-dev) so SIGTERM reaches the app.
CMD ["node", "dist/main.js"]
