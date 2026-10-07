# Use a pinned tasklattice-litellm-guard release, replacing only its TaskLattice
# Guard Provider with a working copy. Build with a tasklattice-litellm-guard
# checkout as context, never the Guard repository.
ARG LITELLM_BASE=ghcr.io/tasklattice/tali-litellm:1.87.0-guard.1
FROM ${LITELLM_BASE}
USER root
COPY litellm/v1.87.0/overlay/litellm/proxy/guardrails/guardrail_hooks/tasklattice_guard /app/litellm/proxy/guardrails/guardrail_hooks/tasklattice_guard
COPY litellm/v1.87.0/tests /tmp/tasklattice-guard-tests
RUN LITELLM_LOCAL_MODEL_COST_MAP=True PYTHONPATH=/app python -m unittest discover -s /tmp/tasklattice-guard-tests
USER 65532:65532
