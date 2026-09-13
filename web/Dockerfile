# ---------------------------------------------------------------------------------------------
# @callhouse/web  →  app.callhouse.xyz  (the dapp. Every route unchanged by the domain split.)
#
# WHY THIS FILE EXISTS: Railway builds this package with the REPO ROOT as the build context, not
# web/. pnpm-lock.yaml and pnpm-workspace.yaml live at the root and the install must be
# workspace-aware, so a Dockerfile that could only see web/ would have nothing correct to install
# from. `dockerfilePath` in web/railway.json therefore reads `web/Dockerfile`, relative to a
# service Root Directory of the repo root. ops/deploy.md documents every Railway-side setting this
# file assumes; if you change one, change it there too.
#
# THE LAYERING IS THE POINT: manifests → install → sources → build. Copy the sources before the
# install and every one-line copy edit reinstalls node_modules from scratch.
#
# DELIBERATELY ABSENT:
#   - No unfiltered `pnpm install`. The workspace contains keeper/, whose better-sqlite3
#     dependency is a native addon: an unfiltered install tries to node-gyp it and dies on
#     node:22-alpine with "Could not find any Python installation to use". Installing python3
#     and build-base to compile a database driver into a web image would be absurd, so the
#     install is filtered to this package and its dependencies instead. Every workspace
#     member's package.json is still copied in — see the manifest block below for why.
#   - No OVERCALL_API_BASE build ARG. It is server-side and read per request. See the runner.
#   - No `next start`. The standalone output ships its own server; `next start` would need the
#     full node_modules tree this image deliberately does not carry.
#   - No HEALTHCHECK instruction. Railway owns the healthcheck (web/railway.json).
#   - No secrets of any kind. There is no signing key anywhere in this product's frontend.
# ---------------------------------------------------------------------------------------------

# =============================================================================================
# base — shared by builder and runner so the Node version is stated once.
# =============================================================================================
FROM node:22-alpine AS base
# Alpine ships musl; libc6-compat is the glibc shim Next's optional native bits expect.
RUN apk add --no-cache libc6-compat
WORKDIR /app


# =============================================================================================
# builder
# =============================================================================================
FROM base AS builder

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9 --activate

# ---- manifests first. This layer changes only when a dependency changes. ----
# Every workspace member's package.json is required, not just web's: `--frozen-lockfile` compares
# the lockfile's importer set against the workspace, and a missing member fails the install with
# "lockfile is not up to date" even though its code never enters this image.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json ./web/
COPY keeper/package.json ./keeper/
COPY indexer/package.json ./indexer/

# `--filter <pkg>...` (trailing ellipsis) = this package plus its dependencies, and nothing
# else in the workspace. --frozen-lockfile still holds: pnpm resolves against the shared
# lockfile and fails if it is stale, it just declines to fetch importers this image will
# never run. Drop the filter and the build dies compiling keeper's better-sqlite3.
RUN pnpm install --frozen-lockfile --filter @callhouse/web...

# =============================================================================================
# BUILD-TIME CONFIGURATION. READ THIS BEFORE CHANGING A VARIABLE IN THE RAILWAY UI.
#
# Every NEXT_PUBLIC_* value below is INLINED INTO THE JAVASCRIPT by `next build`. It is not read
# at runtime. Two consequences, both of which have cost people a day:
#
#   1. A Railway service variable reaches a Dockerfile build ONLY if the Dockerfile declares it as
#      an ARG. An undeclared variable is silently absent during the build, the compiled-in
#      fallback (or an empty string) ships in its place, and the container then starts, passes its
#      healthcheck and serves the wrong configuration. So every variable this package reads has an
#      ARG + ENV pair here, and this list must be kept in step with web/.env.example.
#   2. Changing one of these on Railway requires a REBUILD, not a restart. A restart re-runs the
#      same JavaScript with the same values already baked in.
#
# The failure mode this block exists to prevent: NEXT_PUBLIC_VAULT absent at build time, so the UI
# renders "not configured" — or, worse, set to the wrong address, and a depositor signs an
# approve() against a contract that is not ours.
#
# BLANK DEFAULTS ARE NOT UNIFORMLY SAFE, and the split below is deliberate:
#   - lib/contracts.ts does `value?.trim()` and falls back when the result is empty, so a blank
#     address ARG lands on the recon-confirmed default. The addresses are therefore NOT duplicated
#     here — lib/contracts.ts and ops/addresses.json own them, and one copy cannot drift.
#   - lib/chain.ts uses `??`, which does NOT treat "" as missing. A blank NEXT_PUBLIC_CHAIN_ID
#     compiles to Number("") === 0 and a blank RPC compiles to an empty URL, both silently. Those
#     variables carry defaults here that mirror lib/chain.ts exactly. Keep the two in sync.
#
# This block sits AFTER the install on purpose: an address change must not invalidate the
# node_modules layer.
# =============================================================================================

# ---- required. No default: the vault does not exist until we deploy it, and inventing an
#      address would be worse than rendering "not configured". ----
ARG NEXT_PUBLIC_VAULT=""
ENV NEXT_PUBLIC_VAULT=$NEXT_PUBLIC_VAULT

# ---- chain. Blank is UNSAFE for these four — see the note above. Mirrors lib/chain.ts. ----
ARG NEXT_PUBLIC_CHAIN_ID="4663"
ENV NEXT_PUBLIC_CHAIN_ID=$NEXT_PUBLIC_CHAIN_ID
ARG NEXT_PUBLIC_RPC_URL="https://rpc.mainnet.chain.robinhood.com"
ENV NEXT_PUBLIC_RPC_URL=$NEXT_PUBLIC_RPC_URL
ARG NEXT_PUBLIC_RPC_URL_2="https://robinhood-rpc.publicnode.com"
ENV NEXT_PUBLIC_RPC_URL_2=$NEXT_PUBLIC_RPC_URL_2
ARG NEXT_PUBLIC_EXPLORER_URL="https://robinhoodchain.blockscout.com"
ENV NEXT_PUBLIC_EXPLORER_URL=$NEXT_PUBLIC_EXPLORER_URL

# ---- indexer. Mirrors lib/api.ts's compiled default, which is a LOCAL address: it must be
#      overridden with the deployed indexer URL or every history panel reads "unavailable".
#      That degrades one figure, it does not break the app — chain reads drive everything a user
#      can act on. ----
ARG NEXT_PUBLIC_API_URL="http://localhost:42069"
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

# ---- third-party addresses. Blank is SAFE and is the intended value: lib/contracts.ts carries
#      explorer-confirmed defaults. Set one only for a fork or a rehearsal deploy. ----
ARG NEXT_PUBLIC_ASSET=""
ENV NEXT_PUBLIC_ASSET=$NEXT_PUBLIC_ASSET
ARG NEXT_PUBLIC_USDG=""
ENV NEXT_PUBLIC_USDG=$NEXT_PUBLIC_USDG
ARG NEXT_PUBLIC_REGISTRY=""
ENV NEXT_PUBLIC_REGISTRY=$NEXT_PUBLIC_REGISTRY
ARG NEXT_PUBLIC_CLEARINGHOUSE=""
ENV NEXT_PUBLIC_CLEARINGHOUSE=$NEXT_PUBLIC_CLEARINGHOUSE
ARG NEXT_PUBLIC_SEAPORT=""
ENV NEXT_PUBLIC_SEAPORT=$NEXT_PUBLIC_SEAPORT

# ---- vault deploy block. Blank is safe (falls back to 0n); setting it makes the /activity log
#      fallback one cheap query instead of a full scan. ----
ARG NEXT_PUBLIC_VAULT_FROM_BLOCK=""
ENV NEXT_PUBLIC_VAULT_FROM_BLOCK=$NEXT_PUBLIC_VAULT_FROM_BLOCK

# ---- the two domains. Used for metadataBase, canonical URLs and the links back to the marketing
#      site. Never for chain access (lib/site.ts says so). ----
ARG NEXT_PUBLIC_SITE_URL="https://callhouse.xyz"
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_APP_URL="https://app.callhouse.xyz"
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

# ---- sources, last ----
COPY scripts ./scripts
COPY web ./web

# `next build` never creates public/, and web/ has none today. An absent directory is a hard COPY
# failure in the runner, so guarantee it exists rather than making the runner conditional.
RUN mkdir -p ./web/public

WORKDIR /app/web
RUN pnpm run build

# The standalone tree mirrors `outputFileTracingRoot`, which web/next.config.mjs pins to the repo
# root — so the entry point is standalone/web/server.js, NOT standalone/server.js. Assert it here:
# if next.config.mjs ever loses `output: 'standalone'`, the runner's COPY fails with a bare
# "not found" and no hint as to the cause.
RUN test -f .next/standalone/web/server.js || { \
      echo "BUILD ERROR: .next/standalone/web/server.js is missing."; \
      echo "web/next.config.mjs must set output:'standalone' AND outputFileTracingRoot to the repo root."; \
      echo "See ops/deploy.md, 'Known sharp edges'."; \
      exit 1; \
    }


# =============================================================================================
# runner — the shipped image. No pnpm, no source tree, no dev dependencies.
# =============================================================================================
FROM base AS runner

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Next's standalone server binds 127.0.0.1 unless HOSTNAME says otherwise. Inside a container that
# means nothing outside the container can reach it, and Railway's healthcheck fails with a timeout
# that looks like a slow boot. This one line is the difference.
ENV HOSTNAME=0.0.0.0
# A default only. Railway injects $PORT at runtime and server.js reads process.env.PORT, so the
# injected value wins; this keeps `docker run` locally on a predictable port.
ENV PORT=3000

# OVERCALL_API_BASE is NOT set here and is NOT a build ARG. app/api/overcall/listings reads it
# per request on the server, so it is a Railway RUNTIME variable: change it and restart, no
# rebuild. It is left unset on purpose — route.ts already defaults to https://overcall.finance,
# and a second copy of that URL is a second thing to get wrong.

RUN addgroup -g 1001 -S nodejs && adduser -u 1001 -S nextjs -G nodejs

# Three copies, and all three are needed:
#   1. standalone  — the server, plus the pruned node_modules it traced. Unpacks to /app/web/… and
#                    /app/node_modules because the tracing root is the repo root.
#   2. .next/static — NOT included in standalone. Without it every hashed JS/CSS asset 404s and
#                     the page renders unstyled and dead.
#   3. public       — served from the package directory, next to server.js.
COPY --from=builder --chown=nextjs:nodejs /app/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/web/.next/static ./web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/web/public ./web/public

USER nextjs

EXPOSE 3000

# Exec form: node is PID 1 and receives Railway's SIGTERM directly. A shell form would put /bin/sh
# at PID 1, swallow the signal, and turn every redeploy into a 30-second kill.
CMD ["node", "web/server.js"]
