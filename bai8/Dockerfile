# ShopFast API. Build one image per release:
#   docker build --build-arg APP_VERSION=v1 -t shopfast-bai8:v1 .
#   docker build --build-arg APP_VERSION=v2 -t shopfast-bai8:v2 .
ARG NODE_VERSION=20-alpine

FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:${NODE_VERSION} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:${NODE_VERSION} AS runtime
ARG APP_VERSION=v1
ENV NODE_ENV=production \
    PORT=3000 \
    APP_VERSION=${APP_VERSION}
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY package.json ./

USER node
EXPOSE 3000

HEALTHCHECK --interval=5s --timeout=2s --start-period=60s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3000/ready || exit 1

CMD ["node", "dist/main.js"]
