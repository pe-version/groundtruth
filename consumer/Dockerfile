# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy root workspace files
COPY package.json ./
COPY tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/shared/tsconfig.json packages/shared/
COPY packages/shared/src/ packages/shared/src/
COPY consumer/package.json consumer/
COPY consumer/tsconfig.json consumer/

RUN npm install --workspace=@direze/shared --workspace=direze-consumer

COPY consumer/src/ consumer/src/
RUN npm run build --workspace=@direze/shared && npm run build --workspace=direze-consumer

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine

RUN apk add --no-cache tini
WORKDIR /app

COPY --from=builder /app/package.json ./
COPY --from=builder /app/packages/shared/package.json packages/shared/
COPY --from=builder /app/packages/shared/dist/ packages/shared/dist/
COPY --from=builder /app/consumer/package.json consumer/
COPY --from=builder /app/consumer/dist/ consumer/dist/
COPY --from=builder /app/node_modules/ node_modules/
COPY --from=builder /app/packages/shared/node_modules/ packages/shared/node_modules/
COPY --from=builder /app/consumer/node_modules/ consumer/node_modules/

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "consumer/dist/index.js"]
