# syntax=docker/dockerfile:1
# One image: the API, which also serves the built web app (one origin). See the README,
# "Hosting the image". Every setting comes from environment variables; nothing secret is in here.

# Node 26 LTS on Alpine, pinned by tag and by digest (the multi-platform index), so Dependabot
# updates both together (checked 2026-11-01). Named twice: the build stage runs on the build
# machine's own platform, the rest on the target's (linux/amd64 or linux/arm64). Keep both lines
# in step.
FROM node:26.13.0-alpine3.24@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS base
FROM --platform=$BUILDPLATFORM node:26.13.0-alpine3.24@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS build-base

# --- Build: all dependencies, then shared/, backend/ and frontend/. Its output is JavaScript and
#     static files, the same on every platform, so it isn't emulated ---
FROM build-base AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY shared/ shared/
COPY backend/ backend/
COPY frontend/ frontend/
RUN npm run build

# --- Production dependencies only: the backend's and shared's (the web app is static files) ---
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci --omit=dev --workspace=backend --workspace=shared --no-audit --no-fund --ignore-scripts

# --- Assemble only what runs, then check it: the build fails on any source map, type
#     declaration, test, doc, .env or model data, or if the licence terms are missing
#     (deploy/check-image-files.sh; CI checks the finished image again) ---
FROM base AS app
WORKDIR /out
COPY --from=deps /app/node_modules node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/shared/package.json shared/
COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/backend/package.json backend/
COPY --from=build /app/backend/dist backend/dist
COPY --from=build /app/backend/migrations backend/migrations
COPY --from=build /app/frontend/dist frontend/dist
COPY config/oef-mapping.json config/oef-mapping.json
COPY LICENSE LICENSE
COPY deploy/prune-app.sh deploy/check-image-files.sh /tools/
# The frontend workspace link points at nothing in the image.
RUN rm -f node_modules/@simplearchitecture/frontend \
    && sh /tools/prune-app.sh /out \
    && chmod -R go-w /out \
    && sh /tools/check-image-files.sh /out

# --- Runtime ---
FROM base AS runtime
# The project's own licence (the LICENSE file), which has no SPDX identifier.
LABEL org.opencontainers.image.licenses="LicenseRef-SimpleArchitecture"
# npm, npx, corepack and yarn aren't used at runtime: removed, with any vulnerabilities in them.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
    /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
# Production fixes the port (8080) and everything else but the nine settings (README, Settings).
ENV NODE_ENV=production
WORKDIR /app
# Owned by root and read-only to the app user: the app can't change its own code. Nothing is
# written at runtime (models and sessions are in PostgreSQL), so the root file system can be
# read-only.
COPY --from=app /out ./
# The image's own non-root user (uid 1000).
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# The database commands run the same way, e.g. `node backend/dist/db/migrate-cli.js`.
CMD ["node", "backend/dist/server.js"]
