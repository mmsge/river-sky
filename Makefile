.PHONY: deploy build run stop logs status ssh

# Pull latest code, rebuild image, restart container
deploy:
	git pull --ff-only
	./scripts/generate-page-dates.sh || echo "WARN: page-dates generation failed, falling back to boot-time dates"
	docker compose up -d --build

build:
	docker compose build

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
