# daggerheart-app (river-sky)

## Deployment environment

This service runs on a shared Hetzner VPS (SSH alias `msge`, IP `157.180.66.111`).

| Key | Value |
|-----|-------|
| Server path | `/srv/rpg` |
| GitHub repo | `mmsge/river-sky` |
| Domain | `rpg.msge.no` |
| Host port | `4000` (must be `0.0.0.0:4000`, not `127.0.0.1:4000`) |
| Runtime | Docker Compose |
| Deploy | `make deploy` (pulls latest code, rebuilds image, restarts container) |

## Central ingress — do not manage Caddy here

TLS and routing are handled centrally in **`github.com/mmsge/naustet-server`** — not in this repo.

- The Caddyfile block for this service lives at `naustet-server/Caddyfile`
- Service documentation lives at `naustet-server/services/daggerheart.md`
- To change routing or the domain, edit that repo and run `make reload` on the server

## Other services on the same server

| Service | Domain | Host port |
|---------|--------|-----------|
| skjenelangs.no | skjenelangs.msge.no | 4001 |
| markescence | markescence.msge.no | 4002 |
| **daggerheart (river-sky)** | rpg.msge.no | **4000** |
| activitypub-mcp | bot.skvip.lol | 3000 |

**Port 4000 is reserved for this service.** Do not change it without updating the Caddyfile in `naustet-server`.

## Stack

Node.js + Express, SQLite. The database is bind-mounted at `./db:/app/db` so it survives container restarts.

## Access control

Read-public, write-authenticated — controlled at the application layer via `APP_PASSWORD`.
Requires `.env` on the server at `/srv/rpg/.env` with `APP_PASSWORD=`.
Never commit `.env` to git.
