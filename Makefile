IMAGE     = daggerheart
CONTAINER = daggerheart
PORT      = 4000

.PHONY: deploy build run stop logs status

# Pull latest code, rebuild image, restart container
deploy: build run

build:
	podman build -t $(IMAGE) .

run:
	-podman stop $(CONTAINER) 2>/dev/null; podman rm $(CONTAINER) 2>/dev/null; true
	mkdir -p db
	podman run -d \
		--name $(CONTAINER) \
		--restart=always \
		-p $(PORT):4000 \
		-v ./db:/app/db:Z \
		$(IMAGE)

stop:
	podman stop $(CONTAINER)
	podman rm $(CONTAINER)

logs:
	podman logs -f $(CONTAINER)

status:
	podman ps --filter name=$(CONTAINER)
