.PHONY: deploy build run stop logs status ssh

# Pull latest code, rebuild image, restart container
deploy:
	git pull --ff-only
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
	ssh -t msge 'cd /var/www/daggerheart-app/river-sky && exec $$SHELL'

# ── Jump to a service (run on the server) ─────────────────────────────────────
.PHONY: msge markescence skjenelangs bot hetzner

msge:
	cd /var/www/msge-no && exec $$SHELL

markescence:
	cd /var/www/markescence && exec $$SHELL

skjenelangs:
	cd /var/www/skjenelangs.no && exec $$SHELL

bot:
	cd /opt/activitypub-mcp && exec $$SHELL

hetzner:
	cd /root/hetzner-server && exec $$SHELL
