DEV_IMAGE_REPOSITORY := ghcr.io/tasklattice/tasklattice-guard
DEV_IMAGE := $(DEV_IMAGE_REPOSITORY):dev
DEV_CHART_VERSION ?= 0.0.0-dev
DEV_NAMESPACE := tali
HELM_RELEASE := tasklattice-guard
HELM_CHART := charts/tasklattice-guard
HELM_WORKLOAD := tali-guard
HELM_TIMEOUT ?= 180s
PORT ?= 8091
SERVICE_PORT ?= 38081
RUNTIME_PUBLIC_BASE_URL ?= http://$(HELM_WORKLOAD).$(DEV_NAMESPACE).svc.cluster.local:$(SERVICE_PORT)
LOCAL_ENV_FILE := $(if $(wildcard .env),--env-file .env,)
LOCAL_PROVIDER_SECRET ?= tasklattice-guard-provider-keys
NVIDIA_BASE_URL ?= https://integrate.api.nvidia.com/v1
NVIDIA_CONTENT_SAFETY_MODEL ?= nvidia/llama-3.1-nemotron-safety-guard-8b-v3
NVIDIA_TOPIC_CONTROL_MODEL ?= nvidia/llama-3.1-nemoguard-8b-topic-control
NVIDIA_JAILBREAK_MODEL ?= nvidia/nvidia-nemotron-nano-9b-v2
NVIDIA_GROUNDING_MODEL ?=
HELM_REQUIRED_VALUES := --set database.url=postgresql://guard:guard@postgres:5432/guard --set security.artifactSigning.existingSecret=guard-artifact-signing --set security.controlTls.existingSecret=guard-control-tls --set security.bootstrapAdmin.existingSecret=guard-bootstrap-admin --set runner.callContextRedisUrl=redis://redis:6379/0

.PHONY: sync test web-dev web-build run image helm-package helm-lint helm-template helm-install helm-test helm-uninstall deploy-local

sync:
	uv sync --all-extras --frozen
	cd controller && npm ci

test:
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

image: helm-package
	docker build --tag $(DEV_IMAGE) .

helm-package:
	TASKLATTICE_GUARD_IMAGE_REPOSITORY=$(DEV_IMAGE_REPOSITORY) bash scripts/package-runtime-chart.sh $(DEV_CHART_VERSION)

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
# .env contains provider credentials, DeepSeek is wired into Controller
# authoring and NVIDIA Guard Models are wired into every Runner pool.
helm-install: images
	@set -eu; \
		helm_args=""; \
		provider_configured=false; \
		nvidia_key=""; \
		control_plane_key=""; \
		automated_reasoning_endpoint=""; \
		if [ -f .env ] && grep -Eq '^NVAPI_API_KEY=.+$$' .env; then \
			nvidia_key=NVAPI_API_KEY; \
		elif [ -f .env ] && grep -Eq '^MODEL_GUARDRAILS_NVIDIA_API_KEY=.+$$' .env; then \
			nvidia_key=MODEL_GUARDRAILS_NVIDIA_API_KEY; \
		fi; \
		if [ -f .env ] && grep -Eq '^DEEPSEEK_API_KEY=.+$$' .env; then \
			control_plane_key=DEEPSEEK_API_KEY; \
		elif [ -f .env ] && grep -Eq '^MODEL_GUARDRAILS_CONTROL_PLANE_AI_API_KEY=.+$$' .env; then \
			control_plane_key=MODEL_GUARDRAILS_CONTROL_PLANE_AI_API_KEY; \
		fi; \
		if [ -n "$$nvidia_key" ]; then \
			provider_configured=true; \
			helm_args="$$helm_args \
				--set-string evaluators.nvidia.provider=$(NVIDIA_PROVIDER) \
				--set-string evaluators.nvidia.baseUrl=$(NVIDIA_BASE_URL) \
				--set-string evaluators.nvidia.contentSafetyModel=$(NVIDIA_CONTENT_SAFETY_MODEL) \
				--set-string evaluators.nvidia.topicControlModel=$(NVIDIA_TOPIC_CONTROL_MODEL) \
				--set-string evaluators.nvidia.jailbreakModel=$(NVIDIA_JAILBREAK_MODEL) \
				--set-string evaluators.nvidia.groundingModel=$(NVIDIA_GROUNDING_MODEL) \
				--set-string evaluators.nvidia.existingSecret=$(LOCAL_PROVIDER_SECRET) \
				--set-string evaluators.nvidia.secretKey=$$nvidia_key"; \
			echo "Configuring NVIDIA Guardrail runtime models from .env: content_safety=$(NVIDIA_CONTENT_SAFETY_MODEL) topic_control=$(NVIDIA_TOPIC_CONTROL_MODEL) jailbreak=$(NVIDIA_JAILBREAK_MODEL)"; \
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
			provider_configured=true; \
			helm_args="$$helm_args \
				--set-string controlPlaneAgent.deepseek.provider=$(CONTROL_PLANE_AI_PROVIDER) \
				--set-string controlPlaneAgent.deepseek.baseUrl=$(CONTROL_PLANE_AI_BASE_URL) \
				--set-string controlPlaneAgent.deepseek.model=$(CONTROL_PLANE_AI_MODEL) \
				--set-string controlPlaneAgent.deepseek.existingSecret=$(LOCAL_PROVIDER_SECRET) \
				--set-string controlPlaneAgent.deepseek.secretKey=$$control_plane_key"; \
			echo "Configuring Controller model from .env: provider=$(CONTROL_PLANE_AI_PROVIDER) model=$(CONTROL_PLANE_AI_MODEL) capabilities=intent_translation,document_analysis,playground"; \
		fi; \
		if [ "$$provider_configured" = true ]; then \
			provider_env=$$(mktemp); \
			trap 'rm -f "$$provider_env"' EXIT; \
			grep -E '^(NVAPI_API_KEY|MODEL_GUARDRAILS_NVIDIA_API_KEY|DEEPSEEK_API_KEY|MODEL_GUARDRAILS_CONTROL_PLANE_AI_API_KEY|MODEL_GUARDRAILS_AUTOMATED_REASONING_API_KEY)=' .env >"$$provider_env"; \
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
