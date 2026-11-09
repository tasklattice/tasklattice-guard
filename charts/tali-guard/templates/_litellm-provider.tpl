{{/* Optional LiteLLM provider resources belong to the Guard release. */}}
{{- define "tali-guard.litellm.fullname" -}}
{{- printf "%s-litellm" ((include "tali-guard.fullname" .) | trunc 40 | trimSuffix "-") -}}
{{- end }}

{{- define "tali-guard.litellm.componentName" -}}
{{- printf "%s-%s" (include "tali-guard.litellm.fullname" .root) .component -}}
{{- end }}

{{- define "tali-guard.litellm.selectorLabels" -}}
app.kubernetes.io/name: {{ include "tali-guard.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
app.kubernetes.io/group: litellm-provider
{{- end }}

{{- define "tali-guard.litellm.postgresqlName" -}}
{{- include "tali-guard.litellm.componentName" (dict "root" . "component" "postgresql") -}}
{{- end }}

{{- define "tali-guard.litellm.mockModelName" -}}
{{- include "tali-guard.litellm.componentName" (dict "root" . "component" "mock-model") -}}
{{- end }}

{{- define "tali-guard.litellm.runtimeSecretName" -}}
{{- include "tali-guard.managedSecretName" (include "tali-guard.litellm.fullname" .) -}}
{{- end }}
{{- define "tali-guard.litellm.databaseSecretName" -}}
{{- include "tali-guard.managedSecretName" (include "tali-guard.litellm.postgresqlName" .) -}}
{{- end }}
{{- define "tali-guard.litellm.bootstrapSecretSpecs" -}}
{{- $provider := index .Values "litellm-provider" -}}
{{- toJson (list
  (dict "name" (include "tali-guard.litellm.databaseSecretName" .) "kind" "database" "profile" "litellm" "host" (printf "%s.%s.svc.cluster.local" (include "tali-guard.litellm.postgresqlName" .) .Release.Namespace) "username" $provider.postgresql.username "database" $provider.postgresql.database)
  (dict "name" (include "tali-guard.litellm.runtimeSecretName" .) "kind" "litellm" "databaseSecret" (include "tali-guard.litellm.databaseSecretName" .) "username" $provider.ui.username)) -}}
{{- end }}
{{/* A real provider replaces the mock only when every upstream value is set. */}}
{{- define "tali-guard.litellm.upstreamConfigured" -}}
{{- $provider := index .Values "litellm-provider" -}}
{{- if and $provider.model.upstream.apiBase $provider.model.upstream.existingSecret $provider.model.upstream.model -}}true{{- end -}}
{{- end }}

{{- define "tali-guard.litellm.mockEnabled" -}}
{{- $provider := index .Values "litellm-provider" -}}
{{- if and $provider.model.mock.enabled (not (include "tali-guard.litellm.upstreamConfigured" .)) -}}true{{- end -}}
{{- end }}

{{- define "tali-guard.litellm.mockModelUrl" -}}
{{- $provider := index .Values "litellm-provider" -}}
{{- printf "http://%s.%s.svc.cluster.local:%v/v1" (include "tali-guard.litellm.mockModelName" .) .Release.Namespace $provider.model.mock.port -}}
{{- end }}

{{/* LiteLLM proxy configuration. Shape follows tests/fixtures/business-replay/litellm.yaml. */}}
{{- define "tali-guard.litellm.litellmConfig" -}}
{{- $provider := index .Values "litellm-provider" -}}
{{- if and (not (include "tali-guard.litellm.upstreamConfigured" .)) (not $provider.model.mock.enabled) -}}
{{- fail "Set litellm-provider.model.upstream.apiBase, litellm-provider.model.upstream.existingSecret and litellm-provider.model.upstream.model, or keep litellm-provider.model.mock.enabled=true" -}}
{{- end -}}
model_list:
  - model_name: {{ $provider.model.name | quote }}
    litellm_params:
{{- if include "tali-guard.litellm.upstreamConfigured" . }}
      model: {{ printf "openai/%s" $provider.model.upstream.model | quote }}
      api_base: {{ $provider.model.upstream.apiBase | quote }}
      api_key: os.environ/LITELLM_UPSTREAM_API_KEY
{{- else }}
      model: openai/mock-model
      api_base: {{ include "tali-guard.litellm.mockModelUrl" . | quote }}
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
      unreachable_fallback: {{ $provider.guard.unreachableFallback }}
      timeout_seconds: {{ $provider.guard.timeoutSeconds }}
litellm_settings:
  telemetry: false
  num_retries: 0
general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
{{- end }}
