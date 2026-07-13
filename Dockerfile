# syntax=docker/dockerfile:1
#
# Multi-stage build producing a self-contained production image for Distil.
#
#   1. builder  installs every dependency (incl. dev) and runs `npm run build`,
#               which adapter-node turns into a standalone Node server in build/.
#   2. deps     installs production-only dependencies, so the native
#               better-sqlite3 addon is compiled/fetched against the exact same
#               base image (glibc) the runtime stage uses.
#   3. runtime  ships only the build output, the production node_modules, the
#               drizzle/ migrations (applied automatically on first DB access)
#               and the `git` binary simple-git shells out to when syncing KBs.
#
# Node is pinned to the version in .nvmrc.

# --- Stage 1: build the SvelteKit app -----------------------------------------
FROM node:22.23.1-bookworm-slim AS builder
WORKDIR /app

# Toolchain for building the native better-sqlite3 addon when no prebuilt
# binary is available for this platform/arch.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends python3 make g++ \
	&& rm -rf /var/lib/apt/lists/*

# Install against the lockfile first so this layer is cached across source-only
# changes.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# App version injection (roadmap 13.5). `.git` is excluded from the build
# context (see .dockerignore), so svelte.config.js cannot read the commit SHA
# from git during the build. Pass it in as a build-arg instead:
#   docker build --build-arg GIT_SHA=$(git rev-parse --short HEAD) .
# GIT_SHA overrides just the SHA (SemVer still comes from package.json);
# APP_VERSION overrides the whole version string. Both default to empty, in
# which case the SHA degrades to "unknown" and the build still succeeds.
ARG GIT_SHA=""
ARG APP_VERSION=""
ENV GIT_SHA=${GIT_SHA}
ENV APP_VERSION=${APP_VERSION}

RUN npm run build

# --- Stage 2: production-only dependencies ------------------------------------
FROM node:22.23.1-bookworm-slim AS deps
WORKDIR /app

RUN apt-get update \
	&& apt-get install -y --no-install-recommends python3 make g++ \
	&& rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- Stage 3: runtime image ---------------------------------------------------
FROM node:22.23.1-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# simple-git (KB synchronisation) shells out to the git CLI, so it must be
# present in the final image, not just at build time. ca-certificates is
# required too: the slim base ships no root CAs, so cloning over HTTPS fails
# with "server certificate verification failed. CAfile: none" without it.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends git ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

# Production dependencies (with the compiled native addon), the standalone
# server output, the migrations the app applies on boot, and package.json
# (adapter-node reads it, and it pins the module type).
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/build ./build
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/package.json ./package.json

# Persisted application state lives under /app/data: the SQLite database
# (DATABASE_PATH) and each KB's local git clone (data/kb-cache/<id>, resolved
# relative to the working directory). Mount a volume here to keep it across
# container restarts/upgrades.
ENV DATABASE_PATH=/app/data/distil.db
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME ["/app/data"]

# Drop privileges: the `node` base image ships an unprivileged `node` user.
USER node

# adapter-node listens on $PORT (default 3000).
EXPOSE 3000
ENV PORT=3000

CMD ["node", "build"]
