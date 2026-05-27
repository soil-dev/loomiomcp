# Two-stage build:
#   1. builder: install dev+prod deps, run tsup
#   2. runtime: copy dist + production-only deps

FROM node:22-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsup.config.ts tsconfig.json ./
COPY scripts ./scripts
COPY assets ./assets
COPY src ./src
RUN npm run build

# ─────────────────────────────────────────────────────────────────────────────

FROM node:22-slim
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=builder /app/dist ./dist

USER node

EXPOSE 8080
CMD ["node", "dist/http.js"]
