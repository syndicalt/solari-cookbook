# NOAPI — one command, one key.
#
#   make doctor        cheapest real launch + clean dispose (needs SOLARI_API_KEY)
#   make demo          vendor-close across browser + sandbox + desktop
#   make demo-offline  portal + fixtures only, no Solari (curl-driven)
#   make demo-flaky    forced desktop focus-miss, then rewind
#   make test          node:test unit + contract tests
#   make coverage      tests with V8 coverage report
#   make typecheck     tsc --noEmit (TypeScript strict)

SHELL := /bin/bash
NODE  := node

.PHONY: install doctor portal demo demo-offline demo-flaky test coverage typecheck lint clean

install:
	npm install

doctor:
	$(NODE) src/cli.ts doctor

portal:
	$(NODE) apps/portal/server.ts

demo:
	./scripts/demo-live.sh

demo-flaky:
	NOAPI_FORCE_FOCUS_MISS=1 ./scripts/demo-live.sh

demo-offline:
	./scripts/offline-close.sh

test:
	$(NODE) --test 'tests/**/*.test.ts'

coverage:
	$(NODE) --test --experimental-test-coverage 'tests/**/*.test.ts'

typecheck:
	npx tsc --noEmit

lint: typecheck
	@grep -rn 'commands\.run("[^"]* ' src/ && { echo "FAIL: sandbox commands are argv — use run(name, { args }) or sh -c"; exit 1; } || true
	@echo "lint ok"

clean:
	rm -rf artifacts/* recordings/*
