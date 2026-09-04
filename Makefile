CONTROLLER_REPOSITORY ?= ghcr.io/tasklattice/tali-guard-controller
RUNNER_REPOSITORY ?= ghcr.io/tasklattice/tali-guard-runner
CONTROLLER_IMAGE ?= $(CONTROLLER_REPOSITORY):dev
RUNNER_IMAGE ?= $(RUNNER_REPOSITORY):dev
DEV_CHART_VERSION ?= 0.0.0-dev

HELM_CHART := charts/tali-guard
HELM_DEV_VALUES ?= $(HELM_CHART)/values-dev.yaml
HELM_DEBUG_VALUES ?= $(HELM_CHART)/values-debug.yaml
HELM_VALUES_ARGS ?= --values $(HELM_DEV_VALUES)
HELM_RELEASE ?= tali-guard
HELM_NAMESPACE ?= tali
HELM_CONTEXT ?= orbstack
HELM_TIMEOUT ?= 5m
HELM_ROLLOUT_REVISION ?= $(shell date -u +%Y%m%d%H%M%S)
HELM_REQUIRED_VALUES := --set database.url=postgresql://guard:guard@postgres:5432/guard --set security.artifactSigning.existingSecret=guard-artifact-signing --set security.controlTls.existingSecret=guard-control-tls --set security.bootstrapAdmin.existingSecret=guard-bootstrap-admin --set runner.callContextRedisUrl=redis://redis:6379/0

.PHONY: helm-package

.PHONY: sync proto-generate proto-check test test-control-plane test-data-plane test-e2e test-contracts \
	controller-dev controller-build controller-run runner-run images \
	helm-install helm-install-debug helm-lint helm-template helm-status helm-test helm-uninstall

sync:
	uv sync --all-extras --frozen
	cd controller && npm ci

proto-generate:
	.venv/bin/python scripts/generate_control_protocol.py

proto-check:
	.venv/bin/python scripts/generate_control_protocol.py --check

test-control-plane:
	.venv/bin/python scripts/generate_test_artifacts.py --check
	.venv/bin/python -m pytest -q -m control_plane
	cd controller && npm run test:control-plane

test-data-plane:
	.venv/bin/python -m pytest -q -m data_plane

test-e2e:
	.venv/bin/python -m pytest -q -m e2e

test-contracts:
	$(MAKE) proto-check
	.venv/bin/python -m pytest -q -m contract
	$(MAKE) helm-lint
	helm template $(HELM_RELEASE) $(HELM_CHART) --values $(HELM_DEV_VALUES) >/dev/null
	jq empty $(HELM_CHART)/grafana/dashboards/tasklattice-guard-overview.json
	jq empty $(HELM_CHART)/grafana/dashboards/tasklattice-guard-troubleshooting.json
	helm template $(HELM_RELEASE) $(HELM_CHART) --values $(HELM_DEV_VALUES) \
		--set observability.serviceMonitor.enabled=true \
		--set observability.prometheusRule.enabled=true \
		--set observability.grafanaDashboard.enabled=true >/dev/null
	helm template $(HELM_RELEASE) $(HELM_CHART) --values $(HELM_DEV_VALUES) \
		--values $(HELM_DEBUG_VALUES) >/dev/null

test: test-contracts test-control-plane test-data-plane test-e2e
	cd controller && npm run typecheck
	cd controller && npm run build

controller-dev:
	cd controller && npm run dev

controller-build:
	cd controller && npm run build

controller-run:
	cd controller && npm run start

runner-run:
	.venv/bin/uvicorn runner.main:app --host 0.0.0.0 --port 8091

images: helm-package
	docker build -f Dockerfile.controller -t $(CONTROLLER_IMAGE) .
	docker build -f Dockerfile.runner -t $(RUNNER_IMAGE) .

helm-package:
	TALI_GUARD_CONTROLLER_IMAGE_REPOSITORY=$(CONTROLLER_REPOSITORY) \
		TALI_GUARD_RUNNER_IMAGE_REPOSITORY=$(RUNNER_REPOSITORY) \
		bash scripts/package-runtime-chart.sh $(DEV_CHART_VERSION)

helm-lint:
	helm lint $(HELM_CHART) --strict $(HELM_REQUIRED_VALUES)
	helm lint $(HELM_CHART) --strict --values $(HELM_DEV_VALUES)
	helm lint $(HELM_CHART) --strict --values $(HELM_DEV_VALUES) \
		--set observability.serviceMonitor.enabled=true \
		--set observability.prometheusRule.enabled=true \
		--set observability.grafanaDashboard.enabled=true
	helm lint $(HELM_CHART) --strict --values $(HELM_DEV_VALUES) \
		--values $(HELM_DEBUG_VALUES)

helm-template:
	helm template $(HELM_RELEASE) $(HELM_CHART) --namespace $(HELM_NAMESPACE) --values $(HELM_DEV_VALUES)

# Rebuilds the moving :dev tags and changes a Helm-managed Pod annotation so
# Controller and every Runner pool always roll to the latest local image.
# Model inventory, credentials, and capability assignments are managed in the UI.
# One deployment entry point: upgrade if present, install if absent.
helm-install: images
	@bash scripts/helm-upgrade.sh "$(HELM_RELEASE)" "$(HELM_CHART)" "$(HELM_CONTEXT)" "$(HELM_NAMESPACE)" \
			$(HELM_VALUES_ARGS) \
			--set controller.image.repository=$(CONTROLLER_REPOSITORY) \
			--set-string controller.image.tag=dev \
			--set runner.image.repository=$(RUNNER_REPOSITORY) \
			--set-string runner.image.tag=dev \
			--set-string rolloutRevision=$(HELM_ROLLOUT_REVISION) \
			--wait \
			--timeout $(HELM_TIMEOUT)

# Reuses the self-contained development environment and adds full tracing,
# profiling, Prometheus rules, and Grafana dashboards as an orthogonal overlay.
helm-install-debug:
	$(MAKE) helm-install HELM_VALUES_ARGS="--values $(HELM_DEV_VALUES) --values $(HELM_DEBUG_VALUES)"

helm-status:
	helm status $(HELM_RELEASE) --kube-context $(HELM_CONTEXT) --namespace $(HELM_NAMESPACE)
	kubectl --context $(HELM_CONTEXT) --namespace $(HELM_NAMESPACE) get pods,deploy,statefulset,service \
		--selector app.kubernetes.io/part-of=tasklattice-guard

helm-test:
	helm test $(HELM_RELEASE) --kube-context $(HELM_CONTEXT) --namespace $(HELM_NAMESPACE) --logs

helm-uninstall:
	helm uninstall $(HELM_RELEASE) --kube-context $(HELM_CONTEXT) --namespace $(HELM_NAMESPACE)
