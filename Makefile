# Caucus — make targets (CAU-57).
#
# Thin delegation over the pnpm scripts: package.json stays the single source
# of truth for what each command DOES; this file only makes them discoverable
# and `make`-shaped. Never put logic here — add/change the pnpm script instead.
#
# Demo tokens come from examples/war-room-demo/seed.config.mjs and are
# throwaway (see SECURITY.md — never reuse them outside the demo).

SHELL := /bin/sh

# The seed identities (must match examples/war-room-demo/seed.config.mjs).
DEMO_TOKENS := tok-alice:sess-alice:alice,tok-bob:sess-bob:bob,tok-carol:sess-carol:carol

.DEFAULT_GOAL := help

.PHONY: help install build lint typecheck test integration check clean \
        backbone seed demo demo-loop

help: ## List available targets
	@grep -E '^[a-z][a-z-]*:.*##' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*##[ ]*"}; {printf "  \033[1m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Install workspace dependencies (pnpm install)
	pnpm install

build: ## Build all packages (tsc --build)
	pnpm build

lint: ## Lint the repo (eslint)
	pnpm lint

typecheck: ## Typecheck sources AND test files
	pnpm typecheck

test: ## Anchor check + unit tests with the coverage gate
	pnpm test

integration: ## Cross-package integration scenarios (real subprocesses)
	pnpm test:integration

check: lint typecheck test build integration ## The full local gate, in CI order

clean: ## Remove build output (tsc --build --clean)
	pnpm clean

backbone: ## Boot the shared backbone with the demo seed tokens (Ctrl-C to stop)
	CAUCUS_TOKENS="$(DEMO_TOKENS)" pnpm backbone:dev

seed: ## Seed the war-room demo channel (idempotent; backbone must be running)
	pnpm demo:seed

demo: ## Run the scripted four-beat war-room demo (backbone must be running)
	pnpm demo:run

demo-loop: ## Seed plus the seatbelt loop beat (duplicate post visibly rejected)
	pnpm demo:seed -- --loop
