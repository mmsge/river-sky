---
name: Chore / docs
about: Routine maintenance, dependencies, docs, or config
title: 'chore: '
labels: chore
---

## Summary

<!-- What routine change is this — deps bump, docs, config, cleanup — and why? -->

## Changes

-

## Deploy impact

- [ ] None — docs/config only, no rebuild needed
- [ ] Rebuild via `make deploy` picks it up; no other box-side action
- [ ] Touches env/port/routing — if so this isn't really a chore; use the fix or
      feature template and remember port/domain changes go to `mmsge/naustet-server`

## Verification

<!-- Even chores get a sanity check where it makes sense: `make verify`, a build,
     a docs preview. Note what you did (or why none was needed). -->

## Attribution

<!-- Keep the one line that applies: -->
<!-- - Markus asked & decided: <what he chose> -->
<!-- - Agent decided on its own (no human input on the technical choice) -->

## Checklist

- [ ] No behaviour change to `/healthz`, the `healthcheck:` block, `mem_limit`, or the
      port binding (if there is one, this isn't a chore)
- [ ] Central ingress untouched here (TLS/routing/domain live in `mmsge/naustet-server`)
