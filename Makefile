# Compatibility aliases. Use the root package.json npm scripts for new workflows.
# Command-line Make variables are exported to the npm helpers.
.EXPORT_ALL_VARIABLES:
.PHONY: sync proto-generate proto-check test test-control-plane test-data-plane test-e2e test-contracts controller-dev controller-build controller-run runner-run images helm-package helm-lint helm-template helm-install helm-install-debug helm-status helm-test helm-uninstall

sync:
	npm run sync

proto-generate:
	npm run proto:generate

proto-check:
	npm run proto:check

test:
	npm run test

test-control-plane:
	npm run test:control-plane

test-data-plane:
	npm run test:data-plane

test-e2e:
	npm run test:e2e

test-contracts:
	npm run test:contracts

controller-dev:
	npm run dev:controller

controller-build:
	npm run build

controller-run:
	npm run start

runner-run:
	npm run dev:runner

images:
	npm run images:build:dev

helm-package:
	npm run helm:package

helm-lint:
	npm run helm:lint

helm-template:
	npm run helm:template

helm-install:
	npm run helm:deploy:dev

helm-install-debug:
	npm run helm:deploy:dev:debug

helm-status:
	npm run helm:status

helm-test:
	npm run helm:test

helm-uninstall:
	npm run helm:delete:dev
