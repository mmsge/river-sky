---
name: Feature / new service
about: A new feature, or a brand-new service scaffolded from this skeleton
title: 'feat: '
labels: enhancement
---

## Summary

<!-- What does this feature add, and why? One or two sentences. -->

## Changes

<!-- Bullet the notable changes; keep it to what matters. -->
-

## Deploy impact

<!-- How does this land on the box (/srv/rpg, reverse-proxied by central Caddy)?
     Tick what applies, delete the rest. -->
- [ ] No box-side action needed — a normal `make deploy` rebuild is enough
- [ ] Needs a redeploy: `cd /srv/rpg && make deploy` (or `make remote-deploy`)
- [ ] New/changed env var or secret — update `.env` on the box (see `.env.example`)
- [ ] New service / port / domain — that is **central ingress**: register it in
      [`mmsge/hetzner-server`](https://github.com/mmsge/hetzner-server) (`make add-subdomain`,
      Caddyfile + service registry). Do **not** add Caddy/TLS/routing to this repo.
- [ ] Memory footprint fits `mem_limit` (box is 3.7 GB / 2 vCPU)?

## Verification

<!-- How did you test this? e.g. `make verify` output, `curl -sI https://rpg.msge.no`,
     manual steps, screenshots. Anything that shows it actually works. -->

## Web standards & discoverability

<!-- New pages/services must stay good web citizens (see hetzner-server/NEW-SERVICE.md).
     Tick what applies; delete lines that don't. -->
- [ ] `robots.txt` + `sitemap.xml` served at the root — absolute `https://` URLs,
      correct content-types, baked into the image, reachable even if auth-gated
- [ ] `robots.txt` matches the privacy posture (public `Allow: /` vs private `Disallow: /`)
- [ ] Structured data / Open Graph / canonical / `<html lang>` added where applicable
- [ ] Feeds, `llms.txt`, `.well-known/*`, manifest updated if relevant

## Decision record (ADR)

<!-- Did this encode a non-obvious decision worth recording? If so, add
     `docs/decision-records/NNNN-*.md` and update the README index. -->
- [ ] N/A — no trap or alternative worth recording
- [ ] ADR added: `docs/decision-records/NNNN-...md` (README index updated)

## Attribution

<!-- Mirrors the ADR Contributors rule — keep the one line that applies: -->
<!-- - Markus asked & decided: <what he chose> -->
<!-- - Agent decided on its own (no human input on the technical choice) -->
<!-- - Both: Markus (asked & decided: <choice>) + agent (proposed/implemented) -->

## Checklist

- [ ] `/healthz` route and the Compose `healthcheck:` block are intact
- [ ] `mem_limit` set; port bound to `172.18.0.1:PORT` or `0.0.0.0:PORT` — never `127.0.0.1`
- [ ] Compose project name pinned (`name: rpg`)
- [ ] Central ingress untouched here (TLS/routing/domain live in `mmsge/hetzner-server`)
