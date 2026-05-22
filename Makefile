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
