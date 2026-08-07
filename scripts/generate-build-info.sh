#!/bin/sh
# Derive this build's git identity into ./build-info.json, so the app can serve it
# at /version. Box-wide convention: naustet-server ADR 0022 (contract in
# naustet-server/docs/health-and-version-contract.md).
#
# Runs on the CHECKOUT (make deploy) — the image has no .git, and the box has no
# Node/Python outside containers, so this is pure git + POSIX sh. The Dockerfile
# picks the file up with the optional-copy glob `COPY build-info.jso[n] ./`, which
# is a no-op when it's missing; the app then reports {"source": "unknown"}.
#
# THE POINT: this runs BEFORE the image build, so the SHA is baked into the IMAGE.
# A `git pull` that isn't followed by a rebuild leaves the container serving the
# old sha — which is exactly the drift a checkout-based deploy badge cannot see.
#
# Two details that look cosmetic and are not:
#   - commit_time is the COMMITTER date (%cI), not the author date (%aI) that
#     generate-page-dates.sh uses. Page dates describe content; this describes an
#     image, and after a rebase an author date can be months older than the code.
#   - `dirty` records uncommitted changes at build time. An image built from a
#     dirty tree is not the commit it claims to be.
#
# COPY build-info.json LAST in the Dockerfile: `built_at` changes every deploy, so
# an early COPY busts the layer cache for every step after it (npm ci, pip install).
# Unlike page-dates, a shallow clone is fine here — only HEAD is read.
set -eu
cd "$(dirname "$0")/.."

SLUG=rpg

commit=$(git rev-parse HEAD 2>/dev/null || true)
if [ -z "$commit" ]; then
  echo "WARN: no git HEAD here — skipping build-info (/version will report source=unknown)" >&2
  exit 0
fi
short=$(printf '%s' "$commit" | cut -c1-7)
commit_time=$(git log -1 --format=%cI 2>/dev/null || true)

# Detached HEAD reports the literal "HEAD"; treat that as "no branch".
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)
[ "$branch" = "HEAD" ] && branch=""

if [ -n "$(git status --porcelain 2>/dev/null || true)" ]; then dirty=true; else dirty=false; fi

# origin remote -> owner/repo. Strip a trailing slash and the .git suffix, turn the
# scp-style colon into a slash, then take the last two segments. Handles
# https://github.com/o/r.git, git@github.com:o/r.git, and the ssh-alias remotes the
# box uses for per-repo deploy keys (git@github-<label>:o/r.git).
url=$(git config --get remote.origin.url 2>/dev/null || true)
repo=""
case "$url" in
  *github*)
    u=${url%/}; u=${u%.git}
    repo=$(printf '%s' "$u" | tr ':' '/' | awk -F/ 'NF>=2 {printf "%s/%s", $(NF-1), $NF}')
    ;;
esac

built_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

jv() { if [ -n "${1:-}" ]; then printf '"%s"' "$1"; else printf 'null'; fi; }

{
  printf '{\n'
  printf '  "service": %s,\n'      "$(jv "$SLUG")"
  printf '  "commit": %s,\n'       "$(jv "$commit")"
  printf '  "commit_short": %s,\n' "$(jv "$short")"
  printf '  "branch": %s,\n'       "$(jv "$branch")"
  printf '  "commit_time": %s,\n'  "$(jv "$commit_time")"
  printf '  "repo": %s,\n'         "$(jv "$repo")"
  printf '  "dirty": %s,\n'        "$dirty"
  printf '  "built_at": %s\n'      "$(jv "$built_at")"
  printf '}\n'
} > build-info.json
echo "Wrote build-info.json ($short${branch:+ on $branch})"
