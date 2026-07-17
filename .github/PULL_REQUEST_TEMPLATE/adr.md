---
name: Decision record (ADR)
about: A PR whose main payload is a decision record
title: 'docs(adr): '
labels: documentation, adr
---

## Decision

<!-- One-line statement of what was decided. -->

## New record

<!-- The ADR this PR adds (append-only, next NNNN, README index updated). -->
- Record: `docs/decision-records/NNNN-...md`
- [ ] README index updated
- [ ] `**Topics:**` line added (comma-separated tags) so it surfaces in the pooled
      cross-service view at `adr.msge.no`
- [ ] Supersedes an earlier record? If so, old one marked `Superseded by NNNN`
      (records are immutable — never edit an accepted one)

## Context

<!-- What forced the decision — the incident or the choice between real alternatives.
     Skip routine changes with no trap and no alternative worth remembering. -->

## Attribution (Contributors)

<!-- This is the crux of the ADR policy. Keep the ONE line that is true: -->
<!-- - Markus (asked & decided: <what he chose>) — only if he answered a real question -->
<!-- - <Agent> (agent decision — no human input on the technical choice) -->
<!-- - Markus (asked & decided: <choice>) + <Agent> (proposed/implemented) -->
<!-- Reporting a symptom or saying "fix it" does NOT make Markus a decider. -->

## Scope

- [ ] This decision is about **this service** (correct repo — box/ingress/routing
      decisions belong in `mmsge/hetzner-server` instead)
