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
HELM_TIMEOUT ?= 180s
HELM_ROLLOUT_REVISION ?= $(shell date -u +%Y%m%d%H%M%S)
LOCAL_PROVIDER_SECRET ?= tali-guard-provider-keys
CONTROL_PLANE_AI_PROVIDER ?= Qwen
CONTROL_PLANE_AI_BASE_URL ?= http://qwen-control.models.svc.cluster.local/v1
CONTROL_PLANE_AI_MODEL ?= Qwen/Qwen3.5-9B
HELM_REQUIRED_VALUES := --set database.url=postgresql://guard:guard@postgres:5432/guard --set security.artifactSigning.existingSecret=guard-artifact-signing --set security.controlTls.existingSecret=guard-control-tls --set security.bootstrapAdmin.existingSecret=guard-bootstrap-admin --set runner.callContextRedisUrl=redis://redis:6379/0

.PHONY: helm-package

.PHONY: sync proto-generate proto-check test controller-dev controller-build controller-run runner-run images \
	helm-lint helm-template helm-install helm-install-debug helm-status helm-test helm-uninstall

sync:
	uv sync --all-extras --frozen
	cd controller && npm ci

proto-generate:
	.venv/bin/python scripts/generate_control_protocol.py

proto-check:
	.venv/bin/python scripts/generate_control_protocol.py --check

test:
	$(MAKE) proto-check
	.venv/bin/python -m pytest -q
	cd controller && npm test
	cd controller && npm run typecheck
	cd controller && npm run build
	helm template $(HELM_RELEASE) $(HELM_CHART) --values $(HELM_DEV_VALUES) >/dev/null
	jq empty $(HELM_CHART)/grafana/dashboards/tasklattice-guard-overview.json
	jq empty $(HELM_CHART)/grafana/dashboards/tasklattice-guard-troubleshooting.json
	helm template $(HELM_RELEASE) $(HELM_CHART) --values $(HELM_DEV_VALUES) \
		--set observability.serviceMonitor.enabled=true \
		--set observability.prometheusRule.enabled=true \
		--set observability.grafanaDashboard.enabled=true >/dev/null
	helm template $(HELM_RELEASE) $(HELM_CHART) --values $(HELM_DEV_VALUES) \
		--values $(HELM_DEBUG_VALUES) >/dev/null

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
# Controller and every Runner pool always roll to the latest local image. When
# .env contains provider credentials, the configured control-plane model and
# Model Runtimes and Evaluator Bindings are wired into the data plane.
helm-install: images
	@set -eu; \
		helm_args=""; \
		provider_configured=false; \
		model_credentials=false; \
		control_plane_key=""; \
		control_plane_inline_api_key=""; \
		control_plane_provider="$(CONTROL_PLANE_AI_PROVIDER)"; \
		control_plane_base_url="$(CONTROL_PLANE_AI_BASE_URL)"; \
		control_plane_model="$(CONTROL_PLANE_AI_MODEL)"; \
		automated_reasoning_endpoint=""; \
		if [ -f .env ]; then \
			configured_provider=$$(sed -n 's/^MODEL_GUARDRAILS_CONTROL_PLANE_AI_PROVIDER=//p' .env | tail -n 1); \
			configured_base_url=$$(sed -n 's/^MODEL_GUARDRAILS_CONTROL_PLANE_AI_BASE_URL=//p' .env | tail -n 1); \
			configured_model=$$(sed -n 's/^MODEL_GUARDRAILS_CONTROL_PLANE_AI_MODEL=//p' .env | tail -n 1); \
			[ -z "$$configured_provider" ] || control_plane_provider="$$configured_provider"; \
			[ -z "$$configured_base_url" ] || control_plane_base_url="$$configured_base_url"; \
			[ -z "$$configured_model" ] || control_plane_model="$$configured_model"; \
		fi; \
		if [ -f .env ] && grep -Eq '^(QWEN_GUARD_API_KEY|LLAMA_GUARD_API_KEY|QWEN_CONTROL_API_KEY)=.+$$' .env; then \
			model_credentials=true; \
		fi; \
		if [ -f .env ] && grep -Eq '^MODEL_GUARDRAILS_CONTROL_PLANE_AI_API_KEY=.+$$' .env; then \
			control_plane_key=MODEL_GUARDRAILS_CONTROL_PLANE_AI_API_KEY; \
		elif [ -f .env ] && grep -Eq '^QWEN_CONTROL_API_KEY=.+$$' .env; then \
			control_plane_key=QWEN_CONTROL_API_KEY; \
		elif [ -f .env ] && grep -Eq '^MODEL_GUARDRAILS_CONTROL_PLANE_AI_API_KEY_ENV_VAR=.+$$' .env; then \
			legacy_key_setting=$$(sed -n 's/^MODEL_GUARDRAILS_CONTROL_PLANE_AI_API_KEY_ENV_VAR=//p' .env | tail -n 1); \
			if printf '%s' "$$legacy_key_setting" | grep -Eq '^[A-Za-z_][A-Za-z0-9_]*$$'; then \
				control_plane_key="$$legacy_key_setting"; \
				if ! grep -Eq "^$${control_plane_key}=.+$$" .env; then \
					echo "Control-plane credential $$control_plane_key is missing or empty in .env" >&2; \
					exit 1; \
				fi; \
			else \
				control_plane_key=MODEL_GUARDRAILS_CONTROL_PLANE_AI_API_KEY; \
				control_plane_inline_api_key="$$legacy_key_setting"; \
				echo "Migrating legacy inline control-plane credential from MODEL_GUARDRAILS_CONTROL_PLANE_AI_API_KEY_ENV_VAR"; \
			fi; \
		fi; \
		if [ -f .env ] && grep -Eq '^MODEL_GUARDRAILS_MODEL_RUNTIMES_JSON=\[.+\]$$' .env; then \
			model_runtime_json=$$(sed -n 's/^MODEL_GUARDRAILS_MODEL_RUNTIMES_JSON=//p' .env | tail -n 1); \
			helm_args="$$helm_args --set-json models.runtimes=$$model_runtime_json"; \
			if [ "$$model_credentials" = true ]; then \
				provider_configured=true; \
				helm_args="$$helm_args --set-string models.credentials.existingSecret=$(LOCAL_PROVIDER_SECRET)"; \
			fi; \
			echo "Configuring Model Runtimes from .env"; \
		fi; \
		if [ -f .env ] && grep -Eq '^MODEL_GUARDRAILS_EVALUATOR_BINDINGS_JSON=\[.+\]$$' .env; then \
			evaluator_binding_json=$$(sed -n 's/^MODEL_GUARDRAILS_EVALUATOR_BINDINGS_JSON=//p' .env | tail -n 1); \
			helm_args="$$helm_args --set-json evaluators.bindings=$$evaluator_binding_json"; \
			echo "Configuring Evaluator Bindings from .env"; \
		fi; \
		if [ -f .env ] && grep -Eq '^MODEL_GUARDRAILS_AUTOMATED_REASONING_ENDPOINT_URL=https?://.+' .env \
			&& grep -Eq '^MODEL_GUARDRAILS_AUTOMATED_REASONING_API_KEY=.+' .env; then \
			provider_configured=true; \
			automated_reasoning_endpoint=$$(sed -n 's/^MODEL_GUARDRAILS_AUTOMATED_REASONING_ENDPOINT_URL=//p' .env | tail -n 1); \
			helm_args="$$helm_args \
				--set-string evaluators.automatedReasoning.endpointUrl=$$automated_reasoning_endpoint \
				--set-string evaluators.automatedReasoning.existingSecret=$(LOCAL_PROVIDER_SECRET) \
				--set-string evaluators.automatedReasoning.secretKey=MODEL_GUARDRAILS_AUTOMATED_REASONING_API_KEY"; \
			echo "Configuring Runner Automated Reasoning endpoint from .env"; \
		fi; \
		if [ -n "$$control_plane_key" ]; then \
			if [ -z "$$control_plane_base_url" ] || [ -z "$$control_plane_model" ]; then \
				echo "Control-plane Base URL and Model are required when its credential is configured" >&2; \
				exit 1; \
			fi; \
			provider_configured=true; \
			helm_args="$$helm_args \
				--set-string controlPlaneAgent.provider.name=$$control_plane_provider \
				--set-string controlPlaneAgent.provider.baseUrl=$$control_plane_base_url \
				--set-string controlPlaneAgent.provider.model=$$control_plane_model \
				--set-string controlPlaneAgent.provider.existingSecret=$(LOCAL_PROVIDER_SECRET) \
				--set-string controlPlaneAgent.provider.secretKey=$$control_plane_key"; \
			echo "Configuring Controller model from .env: provider=$$control_plane_provider model=$$control_plane_model capabilities=intent_translation,document_analysis,playground"; \
		fi; \
		if [ "$$provider_configured" = true ]; then \
			provider_env=$$(mktemp); \
			trap 'rm -f "$$provider_env"' EXIT; \
			grep -E '^(QWEN_GUARD_API_KEY|LLAMA_GUARD_API_KEY|QWEN_CONTROL_API_KEY|MODEL_GUARDRAILS_CONTROL_PLANE_AI_API_KEY|MODEL_GUARDRAILS_AUTOMATED_REASONING_API_KEY)=' .env >"$$provider_env" || true; \
			if [ -n "$$control_plane_inline_api_key" ]; then \
				printf '%s=%s\n' "$$control_plane_key" "$$control_plane_inline_api_key" >>"$$provider_env"; \
			elif [ -n "$$control_plane_key" ] && ! grep -Eq "^$${control_plane_key}=" "$$provider_env"; then \
				grep -E "^$${control_plane_key}=" .env >>"$$provider_env"; \
			fi; \
			kubectl --context $(HELM_CONTEXT) create namespace $(HELM_NAMESPACE) --dry-run=client -o yaml \
				| kubectl --context $(HELM_CONTEXT) apply -f - >/dev/null; \
			kubectl --context $(HELM_CONTEXT) --namespace $(HELM_NAMESPACE) create secret generic $(LOCAL_PROVIDER_SECRET) \
				--from-env-file="$$provider_env" --dry-run=client -o yaml \
				| kubectl --context $(HELM_CONTEXT) --namespace $(HELM_NAMESPACE) apply -f - >/dev/null; \
			echo "Updated Kubernetes provider Secret from .env"; \
		fi; \
		helm upgrade --install $(HELM_RELEASE) $(HELM_CHART) \
			--kube-context $(HELM_CONTEXT) \
			--namespace $(HELM_NAMESPACE) \
			--create-namespace \
			$(HELM_VALUES_ARGS) \
			--set controller.image.repository=$(CONTROLLER_REPOSITORY) \
			--set-string controller.image.tag=dev \
			--set runner.image.repository=$(RUNNER_REPOSITORY) \
			--set-string runner.image.tag=dev \
			--set-string rolloutRevision=$(HELM_ROLLOUT_REVISION) \
			$$helm_args \
			--server-side=false \
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
