{{/* Normalize optional runtime settings for each entry point before use. */}}
{{- define "tali-guard.defaults" -}}
{{- $values := mergeOverwrite (.Files.Get "files/runtime-defaults.yaml" | fromYaml) .Values -}}
{{- $_ := set . "Values" $values -}}
{{- if not .Values.controller.trustedOrigins -}}
{{- $origins := list -}}
{{- range (include "tali-guard.publicUrls" . | fromJsonArray) -}}
{{- $url := urlParse . -}}
{{- $origins = append $origins (printf "%s://%s" $url.scheme $url.host) -}}
{{- end -}}
{{- $_ := set .Values.controller "trustedOrigins" (uniq $origins) -}}
{{- end -}}
{{- include "tali-guard.securityDefaults" . -}}
{{- end }}

{{/* Retain string compatibility; the first URL is the canonical auth base URL. */}}
{{- define "tali-guard.publicUrls" -}}
{{- if kindIs "string" .Values.controller.publicUrl -}}
{{- toJson (list .Values.controller.publicUrl) -}}
{{- else -}}
{{- toJson .Values.controller.publicUrl -}}
{{- end -}}
{{- end }}

{{- define "tali-guard.primaryPublicUrl" -}}
{{- first (include "tali-guard.publicUrls" . | fromJsonArray) -}}
{{- end }}

{{- define "tali-guard.ingressHosts" -}}
{{- if .Values.ingress.host -}}
{{- toJson (list .Values.ingress.host) -}}
{{- else -}}
{{- $hosts := list -}}
{{- range (include "tali-guard.publicUrls" . | fromJsonArray) -}}
{{- $url := urlParse . -}}
{{- $hosts = append $hosts (regexReplaceAll ":[0-9]+$" $url.host "") -}}
{{- end -}}
{{- toJson (uniq $hosts) -}}
{{- end -}}
{{- end }}

{{/* Keep credential internals out of the public values file while accepting
     existingSecret/key-name overrides from older or advanced installations. */}}
{{- define "tali-guard.securityDefaults" -}}
{{- $security := mergeOverwrite (.Files.Get "files/security-defaults.yaml" | fromYaml) (default (dict) .Values.security) -}}
{{- if $security.controlTls.existingSecret -}}
{{- $_ := set $security.controlTls "autoGenerate" false -}}
{{- end -}}
{{- $_ := set .Values "security" $security -}}
{{- end }}

{{- define "tali-guard.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Every Controller-based workload shares the same image and runtime tools. */}}
{{- define "tali-guard.controllerImage" -}}
{{- printf "%s:%s" .Values.controller.image.repository (default .Chart.AppVersion .Values.controller.image.tag) -}}
{{- end }}

{{- define "tali-guard.bootstrapSecretSpecs" -}}
{{- $specs := list -}}
{{- if .Values.security.bootstrap.enabled -}}
{{- if not .Values.security.artifactSigning.existingSecret -}}
{{- $specs = append $specs (dict "name" (include "tali-guard.artifactSigningSecretName" .) "kind" "ed25519" "privateKey" .Values.security.artifactSigning.privateKeyKey "publicKey" .Values.security.artifactSigning.publicKeyKey) -}}
{{- end -}}
{{- if not .Values.security.controlSecret.existingSecret -}}
{{- $specs = append $specs (dict "name" (include "tali-guard.controlSecretName" .) "kind" "tokens" "keys" (list .Values.security.controlSecret.runnerTokenKey .Values.security.controlSecret.betterAuthSecretKey)) -}}
{{- end -}}
{{- if not .Values.security.metrics.existingSecret -}}
{{- $specs = append $specs (dict "name" (include "tali-guard.metricsSecretName" .) "kind" "tokens" "keys" (list .Values.security.metrics.tokenKey)) -}}
{{- end -}}
{{- if not .Values.security.runtimeLogs.existingSecret -}}
{{- $specs = append $specs (dict "name" (include "tali-guard.runtimeLogSecretName" .) "kind" "encryption" "keys" (list .Values.security.runtimeLogs.encryptionKeyKey)) -}}
{{- end -}}
{{- end -}}
{{- if and .Values.security.controlTls.enabled .Values.security.controlTls.autoGenerate (not .Values.security.controlTls.existingSecret) -}}
{{- $controller := include "tali-guard.controllerName" . -}}
{{- $dns := list $controller (printf "%s.%s" $controller .Release.Namespace) (printf "%s.%s.svc" $controller .Release.Namespace) (printf "%s.%s.svc.cluster.local" $controller .Release.Namespace) -}}
{{- $specs = append $specs (dict "name" (include "tali-guard.controlTlsSecretName" .) "kind" "mtls" "serverDnsNames" $dns "runnerName" (include "tali-guard.defaultRunnerName" .) "caKey" .Values.security.controlTls.caKey "caPrivateKeyKey" .Values.security.controlTls.caPrivateKeyKey "serverCertificateKey" .Values.security.controlTls.controllerCertificateKey "serverPrivateKeyKey" .Values.security.controlTls.controllerPrivateKeyKey "clientCertificateKey" .Values.security.controlTls.runnerCertificateKey "clientPrivateKeyKey" .Values.security.controlTls.runnerPrivateKeyKey) -}}
{{- end -}}
{{- toJson $specs -}}
{{- end -}}

{{- define "tali-guard.retainedBootstrapSecret" -}}
{{- $existing := lookup "v1" "Secret" .root.Release.Namespace .name -}}
{{- if $existing -}}
{{- $annotations := default (dict) $existing.metadata.annotations -}}
{{- if and (eq (get $annotations "meta.helm.sh/release-name") .root.Release.Name) (eq (get $annotations "meta.helm.sh/release-namespace") .root.Release.Namespace) }}
---
apiVersion: v1
kind: Secret
metadata:
  name: {{ .name }}
  annotations:
    helm.sh/resource-policy: keep
  labels:
    {{- include "tali-guard.commonLabels" .root | nindent 4 }}
type: Opaque
data:
  {{- toYaml $existing.data | nindent 2 }}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "tali-guard.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name (include "tali-guard.name" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "tali-guard.controllerName" -}}
{{- printf "%s-controller" (include "tali-guard.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "tali-guard.defaultRunnerName" -}}
{{- printf "%s-runner" (include "tali-guard.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "tali-guard.runtimeName" -}}
{{- printf "%s-runtime" (include "tali-guard.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "tali-guard.defaultRuntimeServiceUrl" -}}
{{- printf "http://%s.%s.svc.cluster.local:%v" (include "tali-guard.runtimeName" .) .Release.Namespace 8091 }}
{{- end }}

{{- define "tali-guard.postgresqlName" -}}
{{- printf "%s-postgresql" (include "tali-guard.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "tali-guard.redisName" -}}
{{- printf "%s-redis" (include "tali-guard.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "tali-guard.callContextRedisUrl" -}}
{{- if .Values.runner.callContextRedisUrl -}}
{{- .Values.runner.callContextRedisUrl -}}
{{- else if .Values.redis.enabled -}}
{{- printf "redis://%s:%v/0" (include "tali-guard.redisName" .) 6379 -}}
{{- end -}}
{{- end }}

{{- define "tali-guard.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "tali-guard.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "tali-guard.commonLabels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "tali-guard.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: tasklattice-guard
{{- end }}

{{- define "tali-guard.controlSecretName" -}}
{{- default (printf "%s-control" (include "tali-guard.fullname" .)) .Values.security.controlSecret.existingSecret }}
{{- end }}

{{- define "tali-guard.metricsSecretName" -}}
{{- default (printf "%s-metrics" (include "tali-guard.fullname" .)) .Values.security.metrics.existingSecret }}
{{- end }}

{{- define "tali-guard.runtimeLogSecretName" -}}
{{- default (printf "%s-runtime-logs" (include "tali-guard.fullname" .)) .Values.security.runtimeLogs.existingSecret }}
{{- end }}

{{- define "tali-guard.databaseSecretName" -}}
{{- if .Values.database.existingSecret -}}
{{- .Values.database.existingSecret -}}
{{- else if .Values.postgresql.enabled -}}
{{- include "tali-guard.postgresqlName" . -}}
{{- else -}}
{{- printf "%s-database" (include "tali-guard.fullname" .) -}}
{{- end -}}
{{- end }}

{{- define "tali-guard.bootstrapAdminSecretName" -}}
{{- default (printf "%s-bootstrap-admin" (include "tali-guard.fullname" .)) .Values.security.bootstrapAdmin.existingSecret }}
{{- end }}

{{- define "tali-guard.artifactSigningSecretName" -}}
{{- default (printf "%s-artifact-signing" (include "tali-guard.fullname" .)) .Values.security.artifactSigning.existingSecret }}
{{- end }}

{{- define "tali-guard.controlTlsSecretName" -}}
{{- default (printf "%s-control-tls" (include "tali-guard.fullname" .)) .Values.security.controlTls.existingSecret }}
{{- end }}

{{- define "tali-guard.customCaSecretName" -}}
{{- .Values.security.customCa.existingSecret }}
{{- end }}

{{- define "tali-guard.validateValues" -}}
{{- if lt (int .Values.runner.default.replicaCount) 1 }}
{{- fail "runner.default.replicaCount must be at least 1; GuardRails 0 is the mandatory baseline Runner pool" }}
{{- end }}
{{- if and .Values.database.url .Values.database.existingSecret }}
{{- fail "set either database.url or database.existingSecret, not both" }}
{{- end }}
{{- if and .Values.postgresql.enabled (or .Values.database.url .Values.database.existingSecret) }}
{{- fail "postgresql.enabled cannot be combined with database.url or database.existingSecret" }}
{{- end }}
{{- if not (or .Values.postgresql.enabled .Values.database.url .Values.database.existingSecret) }}
{{- fail "enable postgresql or set database.url/database.existingSecret; Controller requires PostgreSQL" }}
{{- end }}
{{- if and .Values.postgresql.enabled (not .Values.postgresql.auth.password) }}
{{- fail "postgresql.auth.password is required when the development PostgreSQL dependency is enabled" }}
{{- end }}
{{- if and .Values.security.bootstrapAdmin.existingSecret (or .Values.security.bootstrapAdmin.email .Values.security.bootstrapAdmin.password .Values.security.bootstrapAdmin.passwordHash) }}
{{- fail "bootstrapAdmin existingSecret cannot be combined with inline credentials" }}
{{- end }}
{{- if not (or .Values.security.bootstrapAdmin.existingSecret (and .Values.security.bootstrapAdmin.email (or .Values.security.bootstrapAdmin.password .Values.security.bootstrapAdmin.passwordHash))) }}
{{- fail "configure bootstrapAdmin existingSecret or an email with password/passwordHash" }}
{{- end }}
{{- if .Values.controller.auth.allowLocalDefaultCredentials }}
{{- range (include "tali-guard.publicUrls" . | fromJsonArray) }}
{{- if not (regexMatch "^http://(localhost|127\\.0\\.0\\.1)(:[0-9]+)?/?$" .) }}
{{- fail "allowLocalDefaultCredentials requires loopback Controller publicUrl entries" }}
{{- end }}
{{- end }}
{{- end }}
{{- if and .Values.security.bootstrapAdmin.password .Values.security.bootstrapAdmin.passwordHash }}
{{- fail "bootstrapAdmin password and passwordHash are mutually exclusive" }}
{{- end }}
{{- $usesLocalDefault := and .Values.controller.auth.allowLocalDefaultCredentials (eq .Values.security.bootstrapAdmin.email "admin@tasklattice.local") (eq .Values.security.bootstrapAdmin.password "admin") }}
{{- if and (not .Values.security.bootstrapAdmin.existingSecret) .Values.security.bootstrapAdmin.password (lt (len .Values.security.bootstrapAdmin.password) (int .Values.controller.auth.minPasswordLength)) (not $usesLocalDefault) }}
{{- fail (printf "bootstrapAdmin inline password must contain at least %v characters" .Values.controller.auth.minPasswordLength) }}
{{- end }}
{{- if and .Values.security.artifactSigning.existingSecret (or .Values.security.artifactSigning.privateKey .Values.security.artifactSigning.publicKey) }}
{{- fail "artifactSigning existingSecret cannot be combined with inline keys" }}
{{- end }}
{{- if not (or .Values.security.bootstrap.enabled .Values.security.artifactSigning.existingSecret (and .Values.security.artifactSigning.privateKey .Values.security.artifactSigning.publicKey)) }}
{{- fail "enable security.bootstrap or configure artifactSigning existingSecret or an inline Ed25519 private/public key pair" }}
{{- end }}
{{- if and .Values.security.bootstrap.enabled (or .Values.security.artifactSigning.privateKey .Values.security.artifactSigning.publicKey) }}
{{- fail "security.bootstrap cannot be combined with inline signing keys; use existingSecret to supply a key pair" }}
{{- end }}
{{- if and .Values.security.controlTls.enabled .Values.security.controlTls.existingSecret .Values.security.controlTls.autoGenerate }}
{{- fail "controlTls existingSecret cannot be combined with autoGenerate=true" }}
{{- end }}
{{- if and .Values.security.controlTls.enabled (not (or .Values.security.controlTls.existingSecret .Values.security.controlTls.autoGenerate)) }}
{{- fail "configure controlTls existingSecret or set autoGenerate=true for in-cluster initialization" }}
{{- end }}
{{- if and .Values.redis.enabled .Values.runner.callContextRedisUrl }}
{{- fail "set either redis.enabled=true or runner.callContextRedisUrl, not both" }}
{{- end }}
{{- if and (gt (int .Values.runner.default.replicaCount) 1) (not (or .Values.redis.enabled .Values.runner.callContextRedisUrl)) }}
{{- fail "shared Redis is required when GuardRails 0 has more than one replica; enable redis or set runner.callContextRedisUrl" }}
{{- end }}
{{- range .Values.runner.pools }}
{{- if and (gt (int .replicaCount) 1) (not (or $.Values.redis.enabled $.Values.runner.callContextRedisUrl)) }}
{{- fail (printf "shared Redis is required when Runner pool %s has more than one replica" .name) }}
{{- end }}
{{- end }}
{{- end }}

{{/* Non-sensitive Controller configuration; credentials are owned by Namespace. */}}
{{- define "tali-guard.controllerConfig" -}}
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ printf "%s-controller-config" (include "tali-guard.fullname" .) | trunc 63 | trimSuffix "-" }}
  namespace: {{ .Release.Namespace }}
  annotations:
    meta.helm.sh/release-name: {{ .Release.Name | quote }}
    meta.helm.sh/release-namespace: {{ .Release.Namespace | quote }}
  labels:
    {{- include "tali-guard.commonLabels" . | nindent 4 }}
data:
  NODE_ENV: production
  CONTROLLER_GRPC_TRANSPORT: {{ ternary "mtls" "plaintext" .Values.security.controlTls.enabled | quote }}
  CONTROLLER_PUBLIC_URL: {{ include "tali-guard.primaryPublicUrl" . | quote }}
  CONTROLLER_RUNTIME_SERVICE_URL: {{ include "tali-guard.defaultRuntimeServiceUrl" . | quote }}
  BETTER_AUTH_TRUSTED_ORIGINS: {{ join "," .Values.controller.trustedOrigins | quote }}
  BETTER_AUTH_MIN_PASSWORD_LENGTH: {{ .Values.controller.auth.minPasswordLength | quote }}
  CONTROLLER_ALLOW_LOCAL_DEFAULT_CREDENTIALS: {{ .Values.controller.auth.allowLocalDefaultCredentials | quote }}
{{- end }}
