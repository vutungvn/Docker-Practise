# ShopFast API - one image for every environment (config comes from env vars at runtime)
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
# Found by the image scan gate: the base image ships npm/yarn with 22 HIGH/CRITICAL CVEs in their bundled
# packages, and an outdated OpenSSL. The app runs `node` directly, so the package managers are removed
# and OS packages are patched.
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn*
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY package.json ./

USER node
EXPOSE 3000

HEALTHCHECK --interval=5s --timeout=2s --start-period=20s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3000/ready || exit 1

CMD ["node", "dist/main.js"]
