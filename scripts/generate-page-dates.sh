#!/bin/sh
# Derive site-level created/modified timestamps from git history into
# page-dates.json, read by server.js at boot.
#
# Runs on the CHECKOUT (make deploy), never in the container — .git is
# dockerignored, so the image can only ever see the generated file. Pure git +
# POSIX sh: the deploy host has no Node outside the containers.
#
# created  = author date of the oldest commit touching the site's source
# modified = author date of the newest such commit
#
# Missing file ⇒ server.js falls back to boot time. Same pattern as msge-no
# (ADR 0004) and hetzner-server (ADR 0015).
set -eu
cd "$(dirname "$0")/.."

OUT=page-dates.json

# The site's served/read source — mirrors the Dockerfile's explicit COPY list.
SRC="package.json package-lock.json server.js robots.txt sitemap.xml \
index.html login.html campaigns.html character.html advisor.html odds.html \
sessions.html mobile.html"

modified=$(git log -1 --format=%aI -- $SRC 2>/dev/null || true)
created=$(git log --format=%aI -- $SRC 2>/dev/null | tail -n 1 || true)

if [ -z "$modified" ] || [ -z "$created" ]; then
  echo "WARN: no git history for site source — skipping $OUT" >&2
  exit 0
fi

printf '{\n  "generated": "%s",\n  "created": "%s",\n  "modified": "%s"\n}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$created" "$modified" > "$OUT"

echo "Wrote $OUT"
