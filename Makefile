.PHONY: dev test build up down logs shell

dev:
	npm run dev

test:
	npm test

build:
	cd client && npm run build

up:
	docker compose up -d

down:
	docker compose down

logs:
	docker compose logs -f

shell:
	docker exec -it krusch-companion sh
