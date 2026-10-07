{{- define "tali-litellm-dev.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end }}

{{- define "tali-litellm-dev.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "tali-litellm-dev.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end }}

{{- define "tali-litellm-dev.componentName" -}}
{{- printf "%s-%s" (include "tali-litellm-dev.fullname" .root) .component | trunc 63 | trimSuffix "-" -}}
{{- end }}

{{- define "tali-litellm-dev.commonLabels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "tali-litellm-dev.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: tasklattice-guard-test
{{- end }}

{{- define "tali-litellm-dev.selectorLabels" -}}
app.kubernetes.io/name: {{ include "tali-litellm-dev.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{- define "tali-litellm-dev.postgresqlName" -}}
{{- include "tali-litellm-dev.componentName" (dict "root" . "component" "postgresql") -}}
{{- end }}

{{- define "tali-litellm-dev.mockModelName" -}}
{{- include "tali-litellm-dev.componentName" (dict "root" . "component" "mock-model") -}}
{{- end }}

{{- define "tali-litellm-dev.databaseUrl" -}}
{{- printf "postgresql://%s:%s@%s.%s.svc.cluster.local:5432/%s" .Values.postgresql.username (urlquery .Values.postgresql.password | replace "+" "%20") (include "tali-litellm-dev.postgresqlName" .) .Release.Namespace .Values.postgresql.database -}}
{{- end }}

{{/* A real provider replaces the mock only when every upstream value is set. */}}
{{- define "tali-litellm-dev.upstreamConfigured" -}}
{{- if and .Values.model.upstream.apiBase .Values.model.upstream.apiKey .Values.model.upstream.model -}}true{{- end -}}
{{- end }}

{{- define "tali-litellm-dev.mockEnabled" -}}
{{- if and .Values.model.mock.enabled (not (include "tali-litellm-dev.upstreamConfigured" .)) -}}true{{- end -}}
{{- end }}

{{- define "tali-litellm-dev.mockModelUrl" -}}
{{- printf "http://%s.%s.svc.cluster.local:%v/v1" (include "tali-litellm-dev.mockModelName" .) .Release.Namespace .Values.model.mock.port -}}
{{- end }}

{{/* LiteLLM proxy configuration. Shape follows tests/fixtures/business-replay/litellm.yaml. */}}
{{- define "tali-litellm-dev.litellmConfig" -}}
{{- if and (not (include "tali-litellm-dev.upstreamConfigured" .)) (not .Values.model.mock.enabled) -}}
{{- fail "Set model.upstream.apiBase, apiKey and model, or keep model.mock.enabled=true" -}}
{{- end -}}
model_list:
  - model_name: {{ .Values.model.name | quote }}
    litellm_params:
{{- if include "tali-litellm-dev.upstreamConfigured" . }}
      model: {{ printf "openai/%s" .Values.model.upstream.model | quote }}
      api_base: {{ .Values.model.upstream.apiBase | quote }}
      api_key: os.environ/LITELLM_UPSTREAM_API_KEY
{{- else }}
      model: openai/mock-model
      api_base: {{ include "tali-litellm-dev.mockModelUrl" . | quote }}
      api_key: mock-model-key
{{- end }}
      num_retries: 0
credential_list:
  - credential_name: tasklattice-guard
    credential_info:
      custom_llm_provider: tasklattice_guard
    credential_values:
      api_key: os.environ/TASKLATTICE_GUARD_API_KEY
guardrails:
  - guardrail_name: tasklattice-guard
    litellm_params:
      guardrail: tasklattice_guard
      mode: [pre_call, post_call]
      api_base: os.environ/TASKLATTICE_GUARD_API_BASE
      credential_name: tasklattice-guard
      default_on: true
      unreachable_fallback: {{ .Values.guard.unreachableFallback }}
      timeout_seconds: {{ .Values.guard.timeoutSeconds }}
litellm_settings:
  telemetry: false
  num_retries: 0
general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
{{- end }}
