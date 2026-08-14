# =============================================================================
# Multi-stage build.
#
# Every stage here exists for a reason worth knowing:
#
#   deps     installs node_modules ONCE, cached on lockfile content alone. Edit
#            application code a hundred times and this layer is never rebuilt.
#   builder  compiles. Needs devDependencies; the final image must not ship them.
#   runner   the shipped image: production deps only, non-root, no compilers,
#            no package manager caches, no source maps for the build toolchain.
#
# LAYER ORDER IS THE WHOLE GAME. Copy the lockfile before the source, because
# Docker invalidates every layer after the first one that changed. Copy source
# first and every single build reinstalls the internet.
# =============================================================================

ARG NODE_VERSION=22.23.2-alpine

# Corepack ships bundled with Node, but the bundled version tracks whatever
# was current when that Node image was built — and Corepack < 0.31.0 has a
# real bug (nodejs/corepack#612) verifying packages against npm's rotated
# registry signing key, failing every `corepack enable`-triggered pnpm
# fetch with "Cannot find matching keyid" the instant npm re-signs a
# package with its new key. Pin Corepack explicitly, the same way
# package.json's "packageManager" field pins pnpm explicitly, instead of
# trusting whatever a given Node base image happened to bundle.
ARG COREPACK_VERSION=0.35.0

# ------------------------------------------------------------------ 1. deps
FROM node:${NODE_VERSION} AS deps
ARG COREPACK_VERSION
RUN npm install -g corepack@${COREPACK_VERSION} && corepack enable
WORKDIR /app

# Only the files that determine the dependency graph. Nothing else.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/santimpay/package.json ./packages/santimpay/
COPY apps/web/package.json ./apps/web/

# --frozen-lockfile makes CI fail on an out-of-date lockfile instead of
# silently resolving different versions than the ones you tested.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile

# ---------------------------------------------------------------- 2. builder
FROM node:${NODE_VERSION} AS builder
ARG COREPACK_VERSION
RUN npm install -g corepack@${COREPACK_VERSION} && corepack enable
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/santimpay/node_modules ./packages/santimpay/node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY . .

# generate-webhook-fixtures.ts embeds the SDK vendor's own published
# testbed-only example private key (see its own "never production" comment)
# purely to pre-sign k6 load-test fixtures — real and intentional, but a
# vulnerability scanner has no way to distinguish it from a leaked
# production secret, and it has no reason to be inside a shipped image
# anyway: per infra/load-testing/k6/webhook-burst.js's own usage comment,
# it's run via `pnpm exec tsx scripts/...` from wherever k6 itself runs, not
# from inside the deployed container. Unlike create-admin.ts (kubectl exec'd
# into the running pod per infra/k8s/README.md — must stay) or
# chaos-checkout-atomicity.ts, nothing documented ever runs this one there.
#
# Deleted HERE, in the builder stage, not in the runner stage after COPY
# --from=builder: Docker layers are additive, so a `RUN rm` in a LATER layer
# only hides the file from the final merged view — its bytes still sit in
# an earlier layer's history, which is exactly what a secrets scanner reads
# (confirmed the hard way: it kept finding the key after the runner-stage rm).
# Deleting it here means the runner's own COPY --from=builder never receives
# the file at all, so no runner-stage layer — past or present — contains it.
RUN rm ./apps/web/scripts/generate-webhook-fixtures.ts

ENV NEXT_TELEMETRY_DISABLED=1

# The SDK is a workspace dependency; it must be compiled before the app.
RUN pnpm --filter @santim/santimpay build

# Prisma's client is generated code, not a published artifact — it must be
# generated inside the image for the image's platform and OpenSSL version.
RUN pnpm --filter @santim/web exec prisma generate

# DATABASE_URL is required by the Prisma schema parser at build time but no
# connection is made. A dummy value keeps build-time and runtime secrets apart.
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" \
    pnpm --filter @santim/web build

# ----------------------------------------------------------------- 3. runner
FROM node:${NODE_VERSION} AS runner
ARG COREPACK_VERSION
RUN npm install -g corepack@${COREPACK_VERSION} && corepack enable
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000

# Run as a non-root user. A container escape is far less interesting to an
# attacker when the process inside was never root to begin with. Alpine's
# `node` image already ships uid 1000 `node` — use it rather than inventing one.
RUN apk add --no-cache tini && chown -R node:node /app

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=builder --chown=node:node /app/packages/santimpay ./packages/santimpay
COPY --from=builder --chown=node:node /app/apps/web ./apps/web

USER node
EXPOSE 3000

# tini as PID 1. Node is not designed to reap zombies or forward signals as
# PID 1, so without an init your SIGTERM never reaches the app and every deploy
# ends in a 30-second SIGKILL — which is exactly a dropped in-flight payment.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["pnpm", "--filter", "@santim/web", "start"]
