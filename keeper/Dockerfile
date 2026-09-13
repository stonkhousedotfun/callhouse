# ---------------------------------------------------------------------------------------------
# @callhouse/keeper  →  the weekly roll, one process, one vault.
#
# WHY THIS FILE EXISTS: Railway builds this package with the REPO ROOT as the build context, not
# keeper/. pnpm-lock.yaml and pnpm-workspace.yaml live at the root and the install must be
# workspace-aware, so a Dockerfile that could only see keeper/ would have nothing correct to
# install from. `dockerfilePath` in keeper/railway.json therefore reads `keeper/Dockerfile`,
# relative to a service Root Directory of the repo root. ops/deploy.md ("keeper") documents every
# Railway-side setting this file assumes; if you change one, change it there too.
#
# THE LAYERING IS THE POINT: manifests → install → sources → build → prune. Copy the sources
# before the install and every one-line edit reinstalls, and recompiles, better-sqlite3.
#
# WHAT IS DIFFERENT FROM web/Dockerfile, and why:
#   - Debian slim, not Alpine. better-sqlite3 is a native addon. Version 13 ships prebuilt
#     binaries inside its tarball (prebuilds/linux-x64.node, linux-arm64, linuxmusl-*), but its
#     install script still runs `node-gyp rebuild`, which needs python3 and make just to write
#     its stamp files, and g++ is what it falls back to when no prebuilt matches the platform.
#     The three packages are cheap on bookworm-slim and the result is a glibc tree that matches
#     the runtime image byte for byte.
#   - The builder installs that toolchain; the runner does NOT. The `.node` binary is carried
#     across inside the pruned production tree that `pnpm deploy --prod` writes.
#   - The runner has a writable volume. The keeper's memory of what it has already done is a
#     SQLite file at KEEPER_DB_PATH; lose it and the keeper still reconciles from chain on boot,
#     but the cycle tape it serves from /cycles is gone. Mount /data.
#
# DELIBERATELY ABSENT:
#   - No `corepack prepare pnpm@9`. The root package.json carries `packageManager`, so corepack
#     resolves the SAME pnpm the lockfile was written by, here and on every developer machine.
#     An unpinned corepack resolved pnpm 12 in the first version of this file and the install
#     died with ERR_PNPM_IGNORED_BUILDS before better-sqlite3 was ever compiled.
#   - No `pnpm install --no-frozen-lockfile`. The lockfile is the reproducibility contract; an
#     install that is allowed to rewrite it is a different tree every build.
#   - No KEEPER_PK anywhere, and no ARG for it. The hot key is a RUNTIME variable read by
#     config.ts at boot. A build ARG is written into the image's layer metadata and readable
#     by anyone who can pull the image or inspect the build log.
#   - No HEALTHCHECK instruction. Railway owns the healthcheck (keeper/railway.json → /health).
#     For plain docker, `curl -sf localhost:8787/health` is the same probe.
#   - No `.env`. The root .dockerignore refuses every .env* into every build context.
# ---------------------------------------------------------------------------------------------

# =============================================================================================
# base — shared by builder and runner so the Node version is stated once.
# =============================================================================================
FROM node:22-bookworm-slim AS base
WORKDIR /app


# =============================================================================================
# builder
# =============================================================================================
FROM base AS builder

# better-sqlite3 compiles with node-gyp when no prebuilt binary matches. These three are the
# whole toolchain it needs. They live in the builder only; the runner never sees them.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# The version comes from `packageManager` in the root package.json, read by corepack the moment
# pnpm is first invoked below. Nothing here names a version, so nothing here can disagree.
RUN corepack enable

# ---- manifests first. This layer changes only when a dependency changes. ----
# Every workspace member's package.json is required, not just keeper's: `--frozen-lockfile`
# compares the lockfile's importer set against the workspace, and a missing member fails the
# install with "lockfile is not up to date" even though its code never enters this image.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY keeper/package.json ./keeper/
COPY web/package.json ./web/
COPY indexer/package.json ./indexer/

# `--filter <pkg>...` (trailing ellipsis) = this package plus its dependencies, and nothing
# else in the workspace. --frozen-lockfile still holds: pnpm resolves against the shared
# lockfile and fails if it is stale, it just declines to fetch importers this image will
# never run. This is where better-sqlite3 is compiled.
RUN pnpm install --frozen-lockfile --filter @callhouse/keeper...

# ---- sources, last ----
COPY keeper/tsconfig.json ./keeper/
COPY keeper/src ./keeper/src

WORKDIR /app/keeper
RUN pnpm run build

# A self-contained production tree: keeper's own files plus ONLY its production dependencies,
# with the compiled better-sqlite3 binary in place and no workspace symlinks pointing back into
# /app/node_modules/.pnpm. This is what the runner copies, so the runner needs neither pnpm nor
# a build toolchain. The test files under dist/ are harmless and never imported by index.js.
RUN pnpm --filter @callhouse/keeper deploy --prod /out

# Assert the tree is complete by LOADING the addon from it, the way index.js will. A missing
# binary otherwise surfaces at first boot as "Could not locate the bindings file", which reads
# like a broken image rather than a missing build step. The db is in-memory: nothing is written.
RUN test -f /out/dist/index.js \
 && (cd /out && node -e "new (require('better-sqlite3'))(':memory:').prepare('select 1').get()") \
 || { echo "BUILD ERROR: /out is missing dist/index.js, or better-sqlite3 does not load from it."; \
      echo "Check that pnpm install ran with python3/make/g++ present and that pnpm deploy kept prebuilds/."; \
      exit 1; }


# =============================================================================================
# runner — the shipped image. No pnpm, no compiler, no source tree, no dev dependencies.
# =============================================================================================
FROM base AS runner

ENV NODE_ENV=production

# The database is the keeper's memory of what it has already done. Mount a volume at /data.
# KEEPER_DB_PATH is a default only: Railway service variables win over it.
ENV KEEPER_DB_PATH=/data/keeper.db
# Health server. Railway probes $PORT, so ops/deploy.md sets PORT=8787 on the service to match.
ENV KEEPER_PORT=8787

# The stock image's unprivileged user. The volume mount at /data must be writable by it.
RUN mkdir -p /data && chown node:node /data

COPY --from=builder --chown=node:node /out ./

USER node

VOLUME ["/data"]
EXPOSE 8787

# Exec form: node is PID 1 and receives Railway's SIGTERM directly, which index.ts turns into
# "finish the in-flight tick, close SQLite, exit 0". A shell form would put /bin/sh at PID 1,
# swallow the signal, and turn every redeploy into a 30-second kill mid-transaction.
CMD ["node", "dist/index.js"]
