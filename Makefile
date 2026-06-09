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

# Backbone port. Override per-invocation when 4317 collides locally (it is
# also the standard OTLP/gRPC OpenTelemetry-collector port):
#   make backbone PORT=4747       # terminal 1
#   make seed demo PORT=4747      # terminal 2 — CAUCUS_URL follows PORT
PORT ?= 4317
CAUCUS_URL ?= http://127.0.0.1:$(PORT)

# Channel for `make watch` (CAU-67). Empty ⇒ the demo channel; a name tails
# that channel; '*' multiplexes every channel:
#   make watch CHANNEL=dogfood PORT=4747
#   make watch CHANNEL='*' PORT=4747
CHANNEL ?=

.DEFAULT_GOAL := help

.PHONY: help install build lint typecheck test integration check clean \
        backbone seed demo demo-loop watch

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

backbone: ## Boot the shared backbone with the demo seed tokens (Ctrl-C to stop; PORT=<p> to move it)
	CAUCUS_TOKENS="$(DEMO_TOKENS)" PORT=$(PORT) pnpm backbone:dev

seed: ## Seed the war-room demo channel (idempotent; backbone must be running)
	CAUCUS_URL=$(CAUCUS_URL) pnpm demo:seed

demo: ## Run the scripted four-beat war-room demo (backbone must be running)
	CAUCUS_URL=$(CAUCUS_URL) pnpm demo:run

demo-loop: ## Seed plus the seatbelt loop beat (duplicate post visibly rejected)
	CAUCUS_URL=$(CAUCUS_URL) pnpm demo:seed -- --loop

watch: ## Live IRC-style tail of a channel (CHANNEL=<name>, or CHANNEL='*' for all; default demo channel)
	CAUCUS_URL=$(CAUCUS_URL) CAUCUS_CHANNEL=$(CHANNEL) pnpm demo:watch
