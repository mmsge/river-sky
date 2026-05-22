IMAGE     = daggerheart
CONTAINER = daggerheart
PORT      = 4000

.PHONY: deploy build run stop logs status ssh

# Pull latest code, rebuild image, restart container
deploy:
	git pull --ff-only
	$(MAKE) build
	$(MAKE) run

build:
	podman build -t $(IMAGE) .

run:
	-podman stop $(CONTAINER) 2>/dev/null; podman rm $(CONTAINER) 2>/dev/null; true
	mkdir -p db
	podman run -d \
		--name $(CONTAINER) \
		--restart=always \
		-p $(PORT):4000 \
		--env-file .env \
		-v ./db:/app/db:Z \
		$(IMAGE)

stop:
	podman stop $(CONTAINER)
	podman rm $(CONTAINER)

logs:
	podman logs -f $(CONTAINER)

status:
	podman ps --filter name=$(CONTAINER)

ssh:
	ssh -t ap-mcp 'cd /var/www/daggerheart-app/river-sky && exec $$SHELL'
