# ---------------------------------------------------------------------------------------------
# @callhouse/relay  →  keeper alerts (generic JSON webhook) → Discord and/or Telegram.
#
# WHY THIS FILE EXISTS: the keeper POSTs its own JSON shape to ALERT_WEBHOOK, and neither Discord
# nor Telegram accepts that shape — a raw Discord webhook URL answers 400 to every alert, forever,
# and nobody sees anything. This service is the translation, with a shared token in front of it.
# ops/alerts.md "Transport" is the contract; relay/README.md is the package.
#
# Railway builds it with the REPO ROOT as the build context, like every image in this repository:
# pnpm-lock.yaml and pnpm-workspace.yaml live at the root and the install must be workspace-aware.
# `dockerfilePath` in relay/railway.json therefore reads `relay/Dockerfile`, relative to a service
# Root Directory of the repo root. ops/deploy.md ("relay") documents the Railway side.
#
# THE LAYERING IS THE POINT: manifests → install → sources → build → prune.
#
# WHAT IS DIFFERENT FROM keeper/Dockerfile, and why:
#   - Alpine, and no toolchain. The production tree is one dependency, zod, which is plain
#     JavaScript. Nothing is compiled on install, so there is no glibc binary to match.
#   - No volume. The relay keeps no state: an alert is delivered or refused within one request.
#     The keeper's SQLite `alerts` table is the record.
#
# DELIBERATELY ABSENT:
#   - No RELAY_TOKEN, DISCORD_WEBHOOK_URL or TELEGRAM_BOT_TOKEN as an ARG. All three are
#     credentials and all three are RUNTIME variables, read by config.ts at boot. A build ARG is
#     written into image metadata and the build log.
#   - No `corepack prepare`. `packageManager` in the root package.json pins pnpm.
#   - No HEALTHCHECK instruction. Railway owns it (relay/railway.json → /health).
#   - No `.env`. The root .dockerignore refuses every .env* into every build context.
# ---------------------------------------------------------------------------------------------

# =============================================================================================
# base — shared by builder and runner so the Node version is stated once.
# =============================================================================================
FROM node:22-alpine AS base
WORKDIR /app


# =============================================================================================
# builder
# =============================================================================================
FROM base AS builder

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

# ---- manifests first. This layer changes only when a dependency changes. ----
# Every workspace member's package.json is copied so this image's workspace matches the
# lockfile's importer set exactly.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY relay/package.json ./relay/
COPY keeper/package.json ./keeper/
COPY web/package.json ./web/
COPY indexer/package.json ./indexer/

# `--filter <pkg>...` = this package plus its dependencies. --frozen-lockfile still holds.
# Without the filter the install would try to compile keeper's better-sqlite3 on Alpine.
RUN pnpm install --frozen-lockfile --filter @callhouse/relay...

# ---- sources, last ----
COPY relay/tsconfig.json ./relay/
COPY relay/src ./relay/src

WORKDIR /app/relay
RUN pnpm run build

# A self-contained production tree: dist/ plus zod, no dev dependencies, no workspace symlinks.
# The compiled *.test.js files ride along in dist/ and are never imported by index.js.
RUN pnpm --filter @callhouse/relay deploy --prod /out

# Assert the tree boots as far as configuration, the way `node dist/index.js` will, with an empty
# environment: that must print the config error (and exit 1) — not "Cannot find module".
RUN test -f /out/dist/index.js \
 && { (cd /out && env -i /usr/local/bin/node dist/index.js 2>&1 || true) | grep -q "Relay configuration is not usable"; } \
 || { echo "BUILD ERROR: /out/dist/index.js is missing, or it does not reach config validation."; exit 1; }


# =============================================================================================
# runner — the shipped image. No pnpm, no compiler, no TypeScript sources, no dev dependencies.
# =============================================================================================
FROM base AS runner

ENV NODE_ENV=production
# A default only. Railway injects $PORT and config.ts reads it.
ENV PORT=8080

COPY --from=builder --chown=node:node /out ./

USER node

EXPOSE 8080

# Exec form: node is PID 1 and receives Railway's SIGTERM directly, so an in-flight delivery
# finishes before the process exits (index.ts). A shell form would swallow the signal.
CMD ["node", "dist/index.js"]
