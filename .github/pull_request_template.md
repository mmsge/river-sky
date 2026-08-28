## Summary

<!-- What does this PR change, and why? One or two sentences a human or agent can
     follow without reading the diff. -->

## Changes

<!-- Bullet the notable changes; keep it to what matters. -->
-

## Deploy impact

<!-- How does this land on the box (/srv/rpg, reverse-proxied by central Caddy)?
     Tick what applies, delete the rest. -->
- [ ] No box-side action needed — a normal `make deploy` rebuild is enough
- [ ] Needs a redeploy: `cd /srv/rpg && make deploy` (or `make remote-deploy`)
- [ ] New/changed env var or secret — update `.env` on the box (see `.env.example`)
- [ ] Port or domain change — that is **central ingress**: open a matching PR in
      [`mmsge/naustet-server`](https://github.com/mmsge/naustet-server) (Caddyfile +
      service registry). Do **not** add Caddy/TLS/routing to this repo.
- [ ] Memory footprint changed — still comfortably within `mem_limit` (box is 3.7 GB / 2 vCPU)?

## Verification

<!-- How did you test this? e.g. `make verify` output, `curl -sI https://rpg.msge.no`,
     manual steps, screenshots. Anything that shows it actually works — static/Podman
     services differ from the Node/Python norm, so describe what fits. -->

## Decision record (ADR)

<!-- Did this PR encode a non-obvious decision, or fix a hard-to-re-derive incident
     (an ntfy/gzip-style footgun)? If so, add `docs/decision-records/NNNN-*.md` and
     update the README index. Otherwise tick N/A. -->
- [ ] N/A — routine change, no trap or alternative worth recording
- [ ] ADR added: `docs/decision-records/NNNN-...md` (README index updated)

## Attribution

<!-- Mirrors the ADR Contributors rule — make it obvious who drove the decision.
     Keep the one line that applies, delete the others: -->
<!-- - Markus asked & decided: <what he chose> -->
<!-- - Agent decided on its own (no human input on the technical choice) -->
<!-- - Both: Markus (asked & decided: <choice>) + agent (proposed/implemented) -->

## Checklist

- [ ] `/healthz` route and the Compose `healthcheck:` block are intact
- [ ] `mem_limit` set; port bound to `172.18.0.1:PORT` or `0.0.0.0:PORT` — never `127.0.0.1`
- [ ] Compose project name still pinned (`name: rpg`) so a dir rename can't orphan volumes
- [ ] Central ingress untouched here (TLS/routing/domain live in `mmsge/naustet-server`)
- [ ] `robots.txt` + `sitemap.xml` still served — absolute URLs, correct content-types,
      baked into the image, reachable even if the app is auth-gated
