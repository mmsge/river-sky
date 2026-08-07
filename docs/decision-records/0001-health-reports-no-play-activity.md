# 0001 — `/health` reports counts, never when anyone last played

- **Status:** Accepted
- **Date:** 2026-08-07
- **Contributors:** Claude (agent decision — no human input on the technical
  choice)
- **Topics:** privacy, observability, health, ops

## Context

Every service on the box now answers `/healthz`, `/version` and `/health`
(hetzner-server ADR 0022; full spec in that repo's
`docs/health-and-version-contract.md`). `/health` is **public** — no basic-auth,
no allowlist — and the contract's recipe for a substantive check is largely
built on **ages**: `age_seconds` since a background job last ran, since an
upstream last succeeded, since the newest row landed. `padletid` and
`markescence` are the box's models and both do exactly that.

River Sky has no upstreams and no timers, so the obvious way to copy that shape
is the freshest row in the store: *"seconds since the newest snapshot"*. Every
snapshot is written by a person editing a character at a table. That number is
therefore a public, continuously updated statement of **when somebody last
played** — and on a service with one table's worth of players, "somebody" is a
person. The same class of leak `lesesalen` refused in its ADR 0015, arriving
through the one endpoint whose entire purpose is to be read by strangers.

The rest of the app is careful about this: `robots.txt` keeps the application
pages out of indexes precisely because campaigns and characters are private.
An ops endpoint that quietly re-published the activity pattern would undo that.

## Decision

`/health` publishes a **closed set of four check names, none of them time-based
on user activity**: `database`, `storage`, `state`, `render`.

- `database` runs a real query (`COUNT(*)` over `snapshots`), reports
  `latency_ms` and one bare row count. A cardinal, not a per-table breakdown —
  a breakdown describes the schema.
- `storage` is whether the bind-mounted data directory is still writable: a
  status, never the path. `error`, not `degraded`, because reads keep working
  from SQLite's page cache while every autosave silently fails — that is data
  loss wearing a green tick.
- `state` is the integrity of the pointers `/api/character` depends on: an
  active character, an active branch under it, a snapshot on that branch. Break
  any of them and the API serves nothing while the process is perfectly alive.
  Reports the character count, and **no timestamps**.
- `render` is whether all eight HTML pages made it into the boot-time page cache.

Failure `detail` comes from the contract's fixed vocabulary
(`unavailable` / `not found` / …) or is a plain count — never `err.message`,
which for `node:sqlite` quotes the database path.

## Consequences

- A table that has not played in six months looks identical to one that played
  an hour ago. That is the point, and it costs us nothing operationally: a stale
  database is not a fault here, unlike a stale poller in `markescence`.
- The four checks are still substantive, so `/health` is not `/healthz` with
  extra steps — the contract requires at least one real check and this clears
  that bar without the privacy cost.
- **The tell that this decision is being undone:** an `age_seconds` field on any
  check in this repo, or a query in `/health` that touches `created_at`,
  `started_at` or `ended_at`. All three mean the endpoint has started publishing
  when people play. Counts stay; clocks do not.
