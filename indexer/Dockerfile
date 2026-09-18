# ---------------------------------------------------------------------------------------------
# @callhouse/indexer  →  the Ponder indexer and the public read API (/v1/*), one process.
#
# WHY THIS FILE EXISTS: Railway builds this package with the REPO ROOT as the build context, not
# indexer/. pnpm-lock.yaml and pnpm-workspace.yaml live at the root and the install must be
# workspace-aware, so a Dockerfile that could only see indexer/ would have nothing correct to
# install from. `dockerfilePath` in indexer/railway.json therefore reads `indexer/Dockerfile`,
# relative to a service Root Directory of the repo root. ops/deploy.md ("indexer") documents every
# Railway-side setting this file assumes; if you change one, change it there too.
#
# THE LAYERING IS THE POINT: manifests → install → sources → prune. Copy the sources before the
# install and every handler edit reinstalls node_modules from scratch.
#
# THERE IS NO COMPILE STEP, and that is Ponder's design, not an omission. `ponder start` loads
# ponder.config.ts, ponder.schema.ts, src/**/*.ts and src/api/index.ts at boot through vite-node,
# which transpiles with esbuild and does NOT type-check. CI's `pnpm --filter @callhouse/indexer
# typecheck` is the type gate; the image ships the TypeScript sources as they are.
#
# WHAT IS DIFFERENT FROM keeper/Dockerfile, and why:
#   - The SAME builder toolchain as the keeper (python3 make g++), for a reason that is not the
#     indexer's own. Nothing Ponder runs is native: `pg` is pure JavaScript, PGlite is WebAssembly,
#     and esbuild takes a prebuilt per-platform binary from an optional dependency. But Ponder
#     depends on drizzle-orm, drizzle-orm declares better-sqlite3 as an optional PEER, and the
#     workspace-wide lockfile resolves that peer to the keeper's better-sqlite3@13 — so even a
#     filtered `--filter @callhouse/indexer...` install runs its `node-gyp rebuild`, and without
#     Python it dies with "Could not find any Python installation to use" (observed on the first
#     build of this file). `--ignore-scripts` was the alternative and is worse: it would also skip
#     esbuild's postinstall, and the next dependency whose install script matters would fail at
#     runtime instead of here. The toolchain stays in the builder; the runner never sees it.
#   - No volume. The state is Postgres (DATABASE_URL). A container restart loses nothing; see
#     ops/deploy.md "indexer" for what a REDEPLOY does, which is a different question.
#   - A shell in CMD, deliberately, and `exec` so it is gone before Ponder runs. See the CMD note.
#
# DELIBERATELY ABSENT:
#   - No `pnpm start` in CMD. pnpm would sit at PID 1 between Railway's SIGTERM and Ponder, and
#     Ponder's shutdown (close the HTTP server, release the schema lock, stop the heartbeat) would
#     not run. Ponder's own bin is invoked with node directly.
#   - No --hostname. Unset, Node listens on `::` when IPv6 exists (which also accepts IPv4) and on
#     `0.0.0.0` when it does not. Pinning 0.0.0.0 would make the service unreachable over Railway's
#     IPv6 private network (`indexer.railway.internal`) while changing nothing for the public edge.
#   - No port flag. Ponder reads $PORT itself and it wins over `--port`; Railway injects it.
#   - No DATABASE_URL or RPC URL as an ARG. Everything the indexer reads is a RUNTIME variable; a
#     build ARG is written into image metadata and the build log. (There is no secret at all any
#     more: the HMAC-guarded Overcall relay route went with the registry.)
#   - No HEALTHCHECK instruction. Railway owns it (indexer/railway.json → /ready).
#   - No `.env`. The root .dockerignore refuses every .env* into every build context, and Ponder's
#     own `dotenv.config({ path: ".env.local" })` therefore finds nothing in the image.
# ---------------------------------------------------------------------------------------------

# =============================================================================================
# base — shared by builder and runner so the Node version is stated once. Ponder 0.17 exits at
# boot on anything below Node 22.
# =============================================================================================
FROM node:22-bookworm-slim AS base
WORKDIR /app


# =============================================================================================
# builder
# =============================================================================================
FROM base AS builder

# better-sqlite3's install script (reached through drizzle-orm's optional peer — see the header)
# needs python3 and make even when its prebuilt binary matches, and g++ when it does not.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# The version comes from `packageManager` in the root package.json, read by corepack the moment
# pnpm is first invoked below. Nothing here names a version, so nothing here can disagree.
RUN corepack enable

# ---- manifests first. This layer changes only when a dependency changes. ----
# Every workspace member's package.json is copied, not just the indexer's, so this image's
# workspace matches the lockfile's importer set exactly.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY indexer/package.json ./indexer/
COPY keeper/package.json ./keeper/
COPY web/package.json ./web/
COPY relay/package.json ./relay/

# `--filter <pkg>...` (trailing ellipsis) = this package plus its dependencies, and nothing
# else in the workspace. --frozen-lockfile still holds: pnpm resolves against the shared
# lockfile and fails if it is stale. The filter keeps web's Next toolchain out of this image.
RUN pnpm install --frozen-lockfile --filter @callhouse/indexer...

# ---- sources, last. Exactly what `ponder start` loads, and nothing else. ----
# ponder-env.d.ts is regenerated by `ponder start` at boot (codegen runs first); it is copied so
# the tree is the same one CI type-checked.
COPY indexer/tsconfig.json indexer/ponder.config.ts indexer/ponder.schema.ts indexer/ponder-env.d.ts ./indexer/
COPY indexer/abis ./indexer/abis
COPY indexer/lib ./indexer/lib
COPY indexer/src ./indexer/src

# A self-contained production tree: the indexer's files plus ONLY its production dependencies
# (ponder, viem, hono and their trees), with no workspace symlinks back into /app/node_modules.
# The *.test.ts files under src/ ride along and are inert: Ponder's file glob ignores *.test.ts,
# and vitest is a dev dependency that is not in /out.
RUN pnpm --filter @callhouse/indexer deploy --prod /out

# Assert the tree can actually start Ponder, rather than finding out at first boot. `--version`
# loads the CLI and its dependency graph without needing a database or an RPC.
RUN test -f /out/ponder.config.ts \
 && test -f /out/src/api/index.ts \
 && test -f /out/lib/v2/cardRegistry.generated.json \
 && (cd /out && node node_modules/ponder/dist/esm/bin/ponder.js --version) \
 || { echo "BUILD ERROR: /out is missing the Ponder sources, or the ponder CLI does not load from it."; \
      echo "Check the COPY lines above and the indexer/* exceptions in the root .dockerignore."; \
      exit 1; }


# =============================================================================================
# runner — the shipped image. No pnpm, no dev dependencies, no other workspace package.
# =============================================================================================
FROM base AS runner

ENV NODE_ENV=production
# A default only, for `docker run`. Railway injects $PORT and Ponder prefers it.
ENV PORT=42069

# Owned by the unprivileged user because `ponder start` writes into its own root at boot:
# ponder-env.d.ts (codegen) and generated/schema.graphql. Neither is state; both are rewritten
# on every start.
COPY --from=builder --chown=node:node /out ./

USER node

EXPOSE 42069

# THE SCHEMA. Ponder refuses to start without one, and on Railway it must change on every deploy:
#   - A schema remembers the build that created it. A redeploy whose code or config differs is
#     refused on the same schema ("previously used by a different Ponder app").
#   - A schema is locked by a heartbeat while its app runs. Railway keeps the old deployment
#     serving until the new one passes its healthcheck, so a new container on the SAME schema
#     waits out the lock, fails, and the deploy never goes healthy.
# RAILWAY_DEPLOYMENT_ID (a UUID Railway injects, 36 characters, under Ponder's 45) gives every
# deploy its own schema. The RPC cache lives in the shared `ponder_sync` schema, so a new
# deployment re-runs the handlers over cached logs instead of re-fetching them from the chain.
# An explicit DATABASE_SCHEMA wins — that is for `docker run` and one-off replays, and should be
# left unset on Railway. With neither set, the shell stops with the message below.
#
# `exec` replaces the shell with node, so node is PID 1 and receives Railway's SIGTERM directly.
# Without `exec` /bin/sh would sit at PID 1, swallow the signal, and every redeploy would end in a
# SIGKILL with the schema lock still held.
CMD ["sh", "-c", "exec node node_modules/ponder/dist/esm/bin/ponder.js start --log-format json --schema \"${DATABASE_SCHEMA:-${RAILWAY_DEPLOYMENT_ID:?set DATABASE_SCHEMA, or run on Railway where RAILWAY_DEPLOYMENT_ID is injected}}\""]
