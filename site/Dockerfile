# ---------------------------------------------------------------------------------------------
# @callhouse/site  →  callhouse.xyz  (the marketing landing: /, /how-it-works, /risks, /legal)
#
# WHY THIS FILE EXISTS: Railway builds this package with the REPO ROOT as the build context, not
# site/. pnpm-lock.yaml and pnpm-workspace.yaml live at the root and the install must be
# workspace-aware, so a Dockerfile that could only see site/ would have nothing correct to install
# from. `dockerfilePath` in site/railway.json therefore reads `site/Dockerfile`, relative to a
# service Root Directory of the repo root. ops/deploy.md documents every Railway-side setting this
# file assumes; if you change one, change it there too.
#
# This is the twin of web/Dockerfile and stays deliberately identical in shape. The one real
# difference is the build-time configuration block: this package reads TWO variables, because it
# has no wallet code and makes no chain reads at all. There is no RPC here, no vault address, no
# indexer URL — nothing to misconfigure into a wrong-contract failure. If this list ever grows
# past the two domain URLs, something has been added to site/ that does not belong there.
#
# DELIBERATELY ABSENT:
#   - No unfiltered `pnpm install`. The workspace contains keeper/, whose better-sqlite3
#     dependency is a native addon: an unfiltered install tries to node-gyp it and dies on
#     node:22-alpine with "Could not find any Python installation to use". Installing python3
#     and build-base to compile a database driver into a web image would be absurd, so the
#     install is filtered to this package and its dependencies instead. Every workspace
#     member's package.json is still copied in — see the manifest block below for why.
#   - No NEXT_PUBLIC_VAULT / RPC / API ARGs. Adding one would mean site/ had started reading the
#     chain. v1 shows no live data: the vault is not deployed, so every live number would be a
#     zero, and a zero on a landing page reads as a broken product rather than as an honest
#     pre-launch state.
#   - No HEALTHCHECK instruction. Railway owns the healthcheck (site/railway.json).
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
# Every workspace member's package.json is required, not just site's: `--frozen-lockfile` compares
# the lockfile's importer set against the workspace, and a missing member fails the install with
# "lockfile is not up to date" even though its code never enters this image.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY site/package.json ./site/
COPY web/package.json ./web/
COPY keeper/package.json ./keeper/
COPY indexer/package.json ./indexer/

# `--filter <pkg>...` (trailing ellipsis) = this package plus its dependencies, and nothing
# else in the workspace. --frozen-lockfile still holds: pnpm resolves against the shared
# lockfile and fails if it is stale, it just declines to fetch importers this image will
# never run. Drop the filter and the build dies compiling keeper's better-sqlite3.
RUN pnpm install --frozen-lockfile --filter @callhouse/site...

# =============================================================================================
# BUILD-TIME CONFIGURATION. READ THIS BEFORE CHANGING A VARIABLE IN THE RAILWAY UI.
#
# Both values below are INLINED INTO THE JAVASCRIPT by `next build`. They are not read at runtime.
#
#   1. A Railway service variable reaches a Dockerfile build ONLY if the Dockerfile declares it as
#      an ARG. An undeclared variable is silently absent during the build and the compiled-in
#      fallback ships instead — the container starts, passes its healthcheck, and links to the
#      wrong host.
#   2. Changing one of these on Railway requires a REBUILD, not a restart.
#
# The failure mode here is milder than web/'s but is still a broken product: every "go do
# something" CTA on this site is an absolute external link to app.callhouse.xyz. Get
# NEXT_PUBLIC_APP_URL wrong and the landing page's only job — handing the reader to the dapp —
# stops working.
#
# Both carry the production defaults, so an unset variable ships a correct site rather than a
# relative metadata base or a link to "undefined". Override them for a preview deploy only.
#
# This block sits AFTER the install on purpose: a URL change must not invalidate the node_modules
# layer.
# =============================================================================================

ARG NEXT_PUBLIC_SITE_URL="https://callhouse.xyz"
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_APP_URL="https://app.callhouse.xyz"
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

# ---- sources, last ----
COPY scripts ./scripts
COPY site ./site

# An absent public/ is a hard COPY failure in the runner, so guarantee it exists rather than
# making the runner conditional.
RUN mkdir -p ./site/public

WORKDIR /app/site
RUN pnpm run build

# The standalone tree mirrors `outputFileTracingRoot`, which site/next.config.mjs pins to the repo
# root — so the entry point is standalone/site/server.js, NOT standalone/server.js. Assert it
# here: if that config loses `output: 'standalone'`, the runner's COPY fails with a bare
# "not found" and no hint as to the cause.
RUN test -f .next/standalone/site/server.js || { \
      echo "BUILD ERROR: .next/standalone/site/server.js is missing."; \
      echo "site/next.config.mjs must set output:'standalone' AND outputFileTracingRoot to the repo root."; \
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

# No runtime variables. This package has no server-side configuration at all — no API proxy, no
# secrets, nothing read per request. web/ has OVERCALL_API_BASE; this one has nothing.

RUN addgroup -g 1001 -S nodejs && adduser -u 1001 -S nextjs -G nodejs

# Three copies, and all three are needed:
#   1. standalone   — the server, plus the pruned node_modules it traced. Unpacks to /app/site/…
#                     and /app/node_modules because the tracing root is the repo root.
#   2. .next/static — NOT included in standalone. Without it every hashed JS/CSS asset 404s and
#                     the page renders unstyled and dead.
#   3. public       — served from the package directory, next to server.js.
COPY --from=builder --chown=nextjs:nodejs /app/site/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/site/.next/static ./site/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/site/public ./site/public

USER nextjs

EXPOSE 3000

# Exec form: node is PID 1 and receives Railway's SIGTERM directly. A shell form would put /bin/sh
# at PID 1, swallow the signal, and turn every redeploy into a 30-second kill.
CMD ["node", "site/server.js"]
