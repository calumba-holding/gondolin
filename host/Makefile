.PHONY: build typecheck lint test format clean

PNPM ?= pnpm

build:
	@$(PNPM) run build

typecheck:
	@$(PNPM) exec tsc -p tsconfig.json --noEmit

lint: typecheck

format:
	@echo "No formatter configured for host"

test:
	@$(PNPM) run test:ws

clean:
	@rm -rf dist
