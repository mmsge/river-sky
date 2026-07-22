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

EXPOSE 4000

CMD ["node", "server.js"]
