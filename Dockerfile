# Two-stage build:
#   1. builder: install dev+prod deps, run tsup
#   2. runtime: copy dist + production-only deps
#
# Both stages use the same base image, pinned by DIGEST (security review
# nit 13 / F-07): a tag such as `node:22-slim` is re-pointed upstream
# every few days, so the same Dockerfile would otherwise build a
# different image from one day to the next with nothing in review. The
# digest is the multi-arch index (amd64 / arm64 / …); the tag before it
# is documentation only — Docker resolves the digest. Dependabot
# (.github/dependabot.yml, `docker`) proposes the bump; to refresh it by
# hand: `skopeo inspect --raw docker://node:22-slim | sha256sum`, or
# `docker buildx imagetools inspect node:22-slim` (the "Digest:" line).
# Resolved 2026-10-25: node 22.23.4 on Debian slim.

FROM node:22-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsup.config.ts tsconfig.json ./
# Only the build step's own script: scripts/ may also hold gitignored,
# operator-local live-test files (instance ids, credential plumbing) that
# must never reach an image layer (nit 14; .dockerignore excludes them
# too).
COPY scripts/build-icon.mjs ./scripts/
COPY assets ./assets
COPY src ./src
RUN npm run build

# ─────────────────────────────────────────────────────────────────────────────

FROM node:22-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
WORKDIR /app

# Provenance a registry or an auditor can read off the image. The
# revision is supplied by the build (`--build-arg VCS_REF=$(git rev-parse
# HEAD)`); unset, it says so instead of guessing.
ARG VCS_REF=unknown
LABEL org.opencontainers.image.source="https://github.com/soil-dev/loomiomcp" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.revision="${VCS_REF}"

ENV NODE_ENV=production
ENV PORT=8080

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=builder /app/dist ./dist

USER node

EXPOSE 8080
CMD ["node", "dist/http.js"]
