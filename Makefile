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
NVIDIA_JAILBREAK_NIM_BASE_URL ?= https://ai.api.nvidia.com
NVIDIA_JAILBREAK_NIM_SERVER_ENDPOINT ?= /v1/security/nvidia/nemoguard-jailbreak-detect
PLAYGROUND_CHAT_BASE_URL ?= https://api.deepseek.com
PLAYGROUND_CHAT_MODEL ?= deepseek-v4-flash

.PHONY: sync test web-dev web-build run image helm-package helm-lint helm-template helm-install helm-test helm-uninstall deploy-local

sync:
	uv sync --all-extras --frozen
	cd web && npm ci

test:
	uv run python -m pytest -q
	cd web && npm run typecheck && npm run build

web-dev:
	cd web && npm run dev

web-build:
	cd web && npm run build

run:
	uv run $(LOCAL_ENV_FILE) python -m uvicorn app.main:app --host 0.0.0.0 --port $(PORT)

image: helm-package
	docker build --tag $(DEV_IMAGE) .

helm-package:
	TASKLATTICE_GUARD_IMAGE_REPOSITORY=$(DEV_IMAGE_REPOSITORY) bash scripts/package-runtime-chart.sh $(DEV_CHART_VERSION)

helm-lint:
	helm lint $(HELM_CHART) --strict

helm-template:
	helm template $(HELM_RELEASE) $(HELM_CHART) --namespace $(DEV_NAMESPACE)

helm-install: image helm-lint
	@set -eu; \
		helm_args="--set-string image.tag=dev --set service.port=$(SERVICE_PORT) --set-string runtime.publicBaseUrl=$(RUNTIME_PUBLIC_BASE_URL)"; \
		provider_configured=false; \
		if [ -f .env ]; then \
			if grep -Eq '^NVAPI_API_KEY=.+$$' .env; then \
				provider_configured=true; \
					helm_args="$$helm_args \
					--set-string evaluators.nvidia.baseUrl=$(NVIDIA_BASE_URL) \
					--set-string evaluators.nvidia.contentSafetyModel=$(NVIDIA_CONTENT_SAFETY_MODEL) \
					--set-string evaluators.nvidia.topicControlModel=$(NVIDIA_TOPIC_CONTROL_MODEL) \
					--set-string evaluators.nvidia.existingSecret=$(LOCAL_PROVIDER_SECRET) \
					--set-string evaluators.nvidia.secretKey=NVAPI_API_KEY \
					--set-string evaluators.jailbreakDetection.nimBaseUrl=$(NVIDIA_JAILBREAK_NIM_BASE_URL) \
					--set-string evaluators.jailbreakDetection.serverEndpoint=$(NVIDIA_JAILBREAK_NIM_SERVER_ENDPOINT)"; \
				echo "Configuring NVIDIA Guardrail runtime evaluators from .env: content_safety=$(NVIDIA_CONTENT_SAFETY_MODEL) topic_control=$(NVIDIA_TOPIC_CONTROL_MODEL) jailbreak_detection=enabled"; \
			fi; \
			if grep -Eq '^DEEPSEEK_API_KEY=.+$$' .env; then \
				provider_configured=true; \
				helm_args="$$helm_args \
					--set-string playgroundChat.baseUrl=$(PLAYGROUND_CHAT_BASE_URL) \
					--set-string playgroundChat.model=$(PLAYGROUND_CHAT_MODEL) \
					--set-string playgroundChat.existingSecret=$(LOCAL_PROVIDER_SECRET) \
					--set-string playgroundChat.secretKey=DEEPSEEK_API_KEY \
					--set-string controlPlaneAgent.deepseek.baseUrl=$(PLAYGROUND_CHAT_BASE_URL) \
					--set-string controlPlaneAgent.deepseek.model=$(PLAYGROUND_CHAT_MODEL) \
					--set-string controlPlaneAgent.deepseek.existingSecret=$(LOCAL_PROVIDER_SECRET) \
					--set-string controlPlaneAgent.deepseek.secretKey=DEEPSEEK_API_KEY"; \
				echo "Configuring Playground chat model from .env: provider=DeepSeek"; \
				echo "Configuring control-plane authoring model from .env: provider=DeepSeek capabilities=intent_translation,compliance_document_analysis"; \
			fi; \
			if [ "$$provider_configured" = true ]; then \
				kubectl create namespace $(DEV_NAMESPACE) --dry-run=client -o yaml | kubectl apply -f - >/dev/null; \
				kubectl --namespace $(DEV_NAMESPACE) create secret generic $(LOCAL_PROVIDER_SECRET) \
					--from-env-file=.env \
					--dry-run=client \
					-o yaml | kubectl apply -f - >/dev/null; \
				echo "Updated Kubernetes provider Secret from .env"; \
			fi; \
		fi; \
		helm upgrade --install $(HELM_RELEASE) $(HELM_CHART) \
			--namespace $(DEV_NAMESPACE) \
			--create-namespace \
			$$helm_args \
			--wait \
			--timeout $(HELM_TIMEOUT)
	kubectl --namespace $(DEV_NAMESPACE) rollout restart deployment/$(HELM_WORKLOAD)
	kubectl --namespace $(DEV_NAMESPACE) rollout status deployment/$(HELM_WORKLOAD) --timeout=$(HELM_TIMEOUT)

helm-test:
	helm test $(HELM_RELEASE) --namespace $(DEV_NAMESPACE)

helm-uninstall:
	helm uninstall $(HELM_RELEASE) --namespace $(DEV_NAMESPACE)

deploy-local: helm-install
