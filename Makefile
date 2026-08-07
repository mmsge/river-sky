PORT = 4000

.PHONY: deploy build verify run stop logs status ssh

# Pull latest code, rebuild image, restart container.
# Both generators run on the CHECKOUT and BEFORE the build: .git is
# dockerignored, so this is the only place those facts exist.
# generate-build-info.sh must run before `--build` or the image would carry a
# stale SHA — which is the whole point of /version (hetzner-server ADR 0022).
deploy:
	git pull --ff-only
	./scripts/generate-page-dates.sh || echo "WARN: page-dates generation failed, falling back to boot-time dates"
	./scripts/generate-build-info.sh || echo "WARN: build-info generation failed — /version will report source=unknown"
	docker compose up -d --build

build:
	./scripts/generate-page-dates.sh || echo "WARN: page-dates generation failed, falling back to boot-time dates"
	./scripts/generate-build-info.sh || echo "WARN: build-info generation failed — /version will report source=unknown"
	docker compose build

# Build, boot and smoke-test the ops contract. All three endpoints, not just
# /healthz — the box's audit probes /version and /health too, and `-f` makes a
# 404 or a 5xx fail the target. /healthz is byte-compared against "ok" because
# container healthchecks do the same.
verify: build
	docker compose up -d
	@sleep 3
	@curl -fsS http://127.0.0.1:$(PORT)/healthz | grep -qx ok && echo "  /healthz OK" || (echo "  /healthz FAILED"; exit 1)
	@curl -fsS http://127.0.0.1:$(PORT)/version | grep -q '"service"' && echo "  /version OK" || (echo "  /version FAILED"; exit 1)
	@curl -fsS http://127.0.0.1:$(PORT)/health  | grep -q '"checks"'  && echo "  /health  OK" || (echo "  /health  FAILED"; exit 1)

run:
	docker compose up -d

stop:
	docker compose down

logs:
	docker compose logs -f

status:
	docker compose ps

ssh:
	ssh -t msge 'cd /srv/rpg && exec $$SHELL'

# ── Jump to a service (run on the server) ─────────────────────────────────────
.PHONY: msge markescence skjenelangs bot hetzner

msge:
	cd /srv/msge && exec $$SHELL

markescence:
	cd /srv/markescence && exec $$SHELL

skjenelangs:
	cd /srv/skjenelangs && exec $$SHELL

bot:
	cd /srv/bot && exec $$SHELL

hetzner:
	cd /root/hetzner-server && exec $$SHELL
