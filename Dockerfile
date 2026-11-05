# syntax=docker/dockerfile:1.7
#
# Production image for the capture-ledger API.
#
# Build:
#   container build -t capture-ledger:latest .
#
# Run (the API; it does not capture anything itself — Windmill's flow does):
#   container run --rm -p 7070:7070 \
#     -e DATABASE_URL=postgres://capture_ledger:capture_ledger@postgres.capture-ledger:5432/capture_ledger \
#     capture-ledger:latest
#
# capture-ledger no longer speaks gRPC to BrowserHive. Captures are submitted by the
# Windmill flow (capture-scheduler), which reaches BrowserHive on its own; capture-ledger plans the
# crawl, records it and admits the archives.
#
# The migration and seed jobs share this image but not its ENTRYPOINT — see
# `run_job` in scripts/prod-smoke.sh, which drives the whole stack end to end.

ARG NODE_VERSION=26.13.0

# ---------- Deps stage (production dependencies only) ----------
#
# A stage of its own, rather than pruning in place at the end of the builder.
# Two ways that look shorter and are not:
#
#   pnpm deploy --prod   — `deploy` picks one project out of a workspace, and
#                          this repo declares no `packages:`, so there is
#                          nothing to pick: ERR_PNPM_NOTHING_TO_DEPLOY.
#   pnpm install --prod  — in place at the end of the builder. The install
#     (in the builder)     itself finishes in under a second, but committing
#                          that layer hangs silently for tens of minutes: it
#                          rewrites a node_modules that held every dev
#                          dependency. It never errors, so it does not even
#                          look like a failure.
#
# An empty base with only prod dependencies keeps the layer small.
#
# --node-linker=hoisted is REQUIRED. pnpm's default links into a content
# addressable store, and there is no store in the runtime stage — the symlinks
# would dangle.
FROM node:${NODE_VERSION}-bookworm-slim AS deps

WORKDIR /deps

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
RUN npm i -g corepack@0.35.0 && corepack enable && corepack prepare --activate
RUN pnpm install --prod --frozen-lockfile --node-linker=hoisted

# ---------- Builder stage ----------
FROM node:${NODE_VERSION}-bookworm-slim AS builder

WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
RUN npm i -g corepack@0.35.0 && corepack enable && corepack prepare --activate
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/

# No prune here — the deps stage owns the production tree.
RUN pnpm run build

# ---------- Runtime stage ----------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY --from=deps /deps/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

USER node

ENTRYPOINT ["node", "dist/api/server.js"]
