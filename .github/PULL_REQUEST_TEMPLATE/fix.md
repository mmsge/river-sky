---
name: Fix / incident
about: A bug fix or incident response
title: 'fix: '
labels: bug
---

## Symptom

<!-- What went wrong / what was observed? Error message, broken behaviour, the alert. -->

## Root cause

<!-- Why did it happen? The actual mechanism — especially if it's hard to re-derive
     from the code (the ntfy/gzip-style footgun someone could reintroduce). -->

## Fix

<!-- What this PR changes to resolve it. -->
-

## Deploy impact

<!-- Tick what applies, delete the rest. -->
- [ ] Needs a redeploy: `cd /srv/rpg && make deploy` (or `make remote-deploy`)
- [ ] New/changed env var or secret — update `.env` on the box (see `.env.example`)
- [ ] Port or domain change — that is **central ingress**: open a matching PR in
      [`mmsge/hetzner-server`](https://github.com/mmsge/hetzner-server). Not here.
- [ ] No box-side action beyond the rebuild

## Verification

<!-- How did you confirm the fix? Reproduce-then-fixed steps, `make verify`,
     `curl -sI https://rpg.msge.no`, logs, screenshots. -->

## Decision record (ADR)

<!-- An incident whose root cause is hard to re-derive is exactly when an ADR earns
     its keep — record the symptom, the trap, and the fix so it doesn't recur. -->
- [ ] ADR added: `docs/decision-records/NNNN-...md` (README index updated)
- [ ] N/A — trivial, no footgun worth recording

## Attribution

<!-- Mirrors the ADR Contributors rule — keep the one line that applies: -->
<!-- - Markus asked & decided: <what he chose> -->
<!-- - Agent decided on its own (no human input on the technical choice) -->
<!-- - Both: Markus (asked & decided: <choice>) + agent (proposed/implemented) -->

## Checklist

- [ ] `/healthz` route and the Compose `healthcheck:` block are intact
- [ ] `mem_limit` set; port bound to `172.18.0.1:PORT` or `0.0.0.0:PORT` — never `127.0.0.1`
- [ ] Central ingress untouched here (TLS/routing/domain live in `mmsge/hetzner-server`)
- [ ] `robots.txt` + `sitemap.xml` still served correctly if the fix touched routing/build
