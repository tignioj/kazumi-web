# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS hls-build
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential pkg-config patch ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY native/hls ./native/hls
COPY scripts/build-hls.mjs ./scripts/build-hls.mjs
RUN node scripts/build-hls.mjs

FROM golang:1.26-bookworm AS ech-build
WORKDIR /build
COPY native/ech/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/kazumi-ech .

FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY index.html vite.config.js ./
COPY src ./src
COPY shared ./shared
RUN npm run build

FROM node:24-bookworm-slim AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/data
WORKDIR /app
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json LICENSE ./
COPY --chown=node:node server ./server
COPY --chown=node:node shared ./shared
COPY --from=ech-build --chown=node:node /out/kazumi-ech ./bin/kazumi-ech
COPY --from=hls-build --chown=node:node /build/bin/ ./bin/
COPY --chown=node:node native/hls ./native/hls
COPY --chown=node:node scripts/build-hls.mjs ./scripts/build-hls.mjs
COPY --from=ech-build --chown=node:node /usr/local/go/LICENSE ./bin/GO-LICENSE
# Node bundles its own roots; Go's TLS client needs the system CA bundle.
COPY --from=ech-build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --chown=node:node scripts/check-ech.mjs ./scripts/check-ech.mjs
COPY --chown=node:node scripts/update-metadata.mjs ./scripts/update-metadata.mjs
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
