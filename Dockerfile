# syntax=docker/dockerfile:1
#
# ScallopBot container image (linux/amd64 and linux/arm64).
#
#   docker build -t scallopbot .
#   docker compose up -d          # see docker-compose.yml
#
# Everything the bot writes (SQLite memory db, sessions, workspace files,
# ~/.scallopbot skills/approvals, MCP config) lives under /data. Mount a volume
# there to keep it across upgrades.

ARG NODE_VERSION=24

# ── build: compile native modules, the web dashboard and the TypeScript ──────
FROM node:${NODE_VERSION}-slim AS build

# Toolchain for better-sqlite3 / bcrypt when no prebuilt binary matches the arch.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY web/package.json web/package-lock.json ./web/
RUN npm --prefix web ci --no-audit --no-fund

COPY . .
RUN npm run build \
  && npm prune --omit=dev --no-audit --no-fund \
  && npm cache clean --force

# ── runtime ───────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-slim AS runtime

ENV NODE_ENV=production \
    HOME=/data \
    AGENT_WORKSPACE=/data/workspace \
    WEB_UI_ENABLED=true \
    WEB_UI_HOST=0.0.0.0 \
    WEB_UI_PORT=3000

WORKDIR /app

COPY --from=build --chown=root:root /app/package.json /app/package-lock.json ./
COPY --from=build --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/dist ./dist
COPY --from=build --chown=root:root /app/public ./public
COPY --from=build --chown=root:root /app/.env.example ./.env.example

# The app code stays root-owned and read-only; the bot runs as the unprivileged
# `node` user (uid 1000) and only writes to /data.
RUN mkdir -p /data/workspace && chown -R node:node /data
USER node
VOLUME ["/data"]

EXPOSE 3000

# GET / always serves the dashboard shell (no auth needed), so it doubles as a
# liveness probe for the gateway. Fails when WEB_UI_ENABLED=false.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WEB_UI_PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/cli.js", "start"]
