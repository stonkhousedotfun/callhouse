# ---------------------------------------------------------------------------------------------
# @callhouse/notifier  →  user notifications: wallet-signed subscriptions, Telegram, Web Push, email.
#
# Modelled on relay/Dockerfile; read that header first. notifier/README.md is the package.
#
# Railway builds it with the REPO ROOT as the build context, like every image in this repository:
# pnpm-lock.yaml and pnpm-workspace.yaml live at the root and the install must be workspace-aware.
# `dockerfilePath` in notifier/railway.json therefore reads `notifier/Dockerfile`, relative to a
# service Root Directory of the repo root.
#
# THE LAYERING IS THE POINT: manifests → install → sources → build → prune.
#
# WHAT IS DIFFERENT FROM relay/Dockerfile, and why:
#   - migrations/ is copied and shipped. The SQL files are read at boot (src/db.ts resolves
#     ../migrations from dist/), and the build asserts they reached /out.
#   - Still Alpine with no toolchain: pg (without pg-native), web-push, nodemailer, viem and hono
#     are all plain JavaScript. PGlite, the test database, is a dev dependency and is pruned.
#   - State lives in Postgres (schema "notifier" on DATABASE_URL), not on a volume.
#
# DELIBERATELY ABSENT:
#   - No DATABASE_URL, NOTIFIER_DATA_KEY, TELEGRAM_BOT_TOKEN, VAPID_PRIVATE_KEY or SMTP_URL as an
#     ARG. They are credentials and RUNTIME variables, read by config.ts at boot. A build ARG is
#     written into image metadata and the build log.
#   - No `corepack prepare`. `packageManager` in the root package.json pins pnpm.
#   - No HEALTHCHECK instruction. Railway owns it (notifier/railway.json → /health).
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
COPY notifier/package.json ./notifier/
COPY relay/package.json ./relay/
COPY keeper/package.json ./keeper/
COPY web/package.json ./web/
COPY indexer/package.json ./indexer/

# `--filter <pkg>...` = this package plus its dependencies. --frozen-lockfile still holds.
# Without the filter the install would try to compile keeper's better-sqlite3 on Alpine.
RUN pnpm install --frozen-lockfile --filter @callhouse/notifier...

# ---- sources, last ----
COPY notifier/tsconfig.json ./notifier/
COPY notifier/migrations ./notifier/migrations
COPY notifier/src ./notifier/src

WORKDIR /app/notifier
RUN pnpm run build

# A self-contained production tree: dist/, migrations/ and the runtime dependencies, no dev
# dependencies, no workspace symlinks. The compiled *.test.js files and testing.js ride along in
# dist/ and are never imported by index.js.
RUN pnpm --filter @callhouse/notifier deploy --prod /out

# Assert the tree boots as far as configuration, the way `node dist/index.js` will, with an empty
# environment: that must print the config error (and exit 1) — not "Cannot find module". And the
# migrations must be where db.ts looks for them.
RUN test -f /out/dist/index.js \
 && test -f /out/migrations/001_init.sql \
 && { (cd /out && env -i /usr/local/bin/node dist/index.js 2>&1 || true) | grep -q "Notifier configuration is not usable"; } \
 || { echo "BUILD ERROR: /out is missing dist/index.js or migrations/, or it does not reach config validation."; exit 1; }


# =============================================================================================
# runner — the shipped image. No pnpm, no compiler, no TypeScript build step, no dev dependencies.
# =============================================================================================
FROM base AS runner

ENV NODE_ENV=production
# A default only. Railway injects $PORT and src/config.ts reads it.
ENV PORT=8791

COPY --from=builder --chown=node:node /out ./

USER node

EXPOSE 8791

# Exec form: node is PID 1 and receives Railway's SIGTERM directly, so the worker and the bot stop
# and an in-flight send finishes before the process exits (index.ts). A shell form would swallow
# the signal.
CMD ["node", "dist/index.js"]
