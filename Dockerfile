FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY *.html ./
COPY robots.txt sitemap.xml ./
# Optional: git-derived site dates (scripts/generate-page-dates.sh, run by
# `make deploy`). Bracket glob so the build still succeeds when it's absent
# (e.g. a bare `docker compose build`) — server.js falls back to boot time.
COPY page-dates.jso[n] ./

RUN mkdir -p db

# This build's git identity, served at /version (hetzner-server ADR 0022).
# Same bracket glob so a bare `docker compose build` still succeeds — server.js
# then reports {"source": "unknown"} rather than guessing.
#
# Deliberately the LAST COPY (and last layer that can change) in this file:
# `built_at` is rewritten on every deploy, so an earlier COPY would bust the
# cache for `npm ci` and every step after it.
COPY build-info.jso[n] ./

EXPOSE 4000

CMD ["node", "server.js"]
