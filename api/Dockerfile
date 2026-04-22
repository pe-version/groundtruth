# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy root workspace files
COPY package.json ./
COPY tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/shared/tsconfig.json packages/shared/
COPY packages/shared/src/ packages/shared/src/
COPY api/package.json api/
COPY api/tsconfig.json api/

RUN npm install --workspace=@groundtruth/shared --workspace=groundtruth-api

COPY api/src/ api/src/
RUN npm run build --workspace=@groundtruth/shared && npm run build --workspace=groundtruth-api

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine

RUN apk add --no-cache tini
WORKDIR /app

COPY --from=builder /app/package.json ./
COPY --from=builder /app/packages/shared/package.json packages/shared/
COPY --from=builder /app/packages/shared/dist/ packages/shared/dist/
COPY --from=builder /app/api/package.json api/
COPY --from=builder /app/api/dist/ api/dist/
COPY --from=builder /app/node_modules/ node_modules/
COPY --from=builder /app/packages/shared/node_modules/ packages/shared/node_modules/
COPY --from=builder /app/api/node_modules/ api/node_modules/

EXPOSE 8080
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "api/dist/index.js"]
