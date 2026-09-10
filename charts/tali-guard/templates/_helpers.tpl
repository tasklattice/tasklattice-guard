{{- define "tali-guard.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

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
{{- printf "http://%s.%s.svc.cluster.local:%v" (include "tali-guard.runtimeName" .) .Release.Namespace .Values.runner.service.port }}
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
{{- printf "redis://%s:%v/0" (include "tali-guard.redisName" .) .Values.redis.service.port -}}
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
{{- if ne (int .Values.controller.replicaCount) 1 }}
{{- fail "controller.replicaCount must be 1 in this release; Runner pools provide the horizontal data-plane scale" }}
{{- end }}
{{- if lt (int .Values.runner.default.replicaCount) 2 }}
{{- fail "runner.default.replicaCount must be at least 2 so GuardRails 0 can keep one Runner available during rolling updates" }}
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
{{- if and .Values.security.bootstrapAdmin.existingSecret (or .Values.security.bootstrapAdmin.email .Values.security.bootstrapAdmin.password) }}
{{- fail "bootstrapAdmin existingSecret cannot be combined with inline email/password" }}
{{- end }}
{{- if not (or .Values.security.bootstrapAdmin.existingSecret (and .Values.security.bootstrapAdmin.email .Values.security.bootstrapAdmin.password)) }}
{{- fail "configure bootstrapAdmin existingSecret or inline email/password" }}
{{- end }}
{{- if and .Values.controller.auth.allowLocalDefaultCredentials (not (regexMatch "^http://(localhost|127\\.0\\.0\\.1)(:[0-9]+)?/?$" .Values.controller.publicUrl)) }}
{{- fail "allowLocalDefaultCredentials requires a loopback Controller publicUrl" }}
{{- end }}
{{- $usesLocalDefault := and .Values.controller.auth.allowLocalDefaultCredentials (eq .Values.security.bootstrapAdmin.email "admin@tasklattice.local") (eq .Values.security.bootstrapAdmin.password "admin") }}
{{- if and (not .Values.security.bootstrapAdmin.existingSecret) (lt (len .Values.security.bootstrapAdmin.password) (int .Values.controller.auth.minPasswordLength)) (not $usesLocalDefault) }}
{{- fail (printf "bootstrapAdmin inline password must contain at least %v characters" .Values.controller.auth.minPasswordLength) }}
{{- end }}
{{- if and .Values.security.artifactSigning.existingSecret (or .Values.security.artifactSigning.privateKey .Values.security.artifactSigning.publicKey) }}
{{- fail "artifactSigning existingSecret cannot be combined with inline keys" }}
{{- end }}
{{- if not (or .Values.security.artifactSigning.existingSecret (and .Values.security.artifactSigning.privateKey .Values.security.artifactSigning.publicKey)) }}
{{- fail "configure artifactSigning existingSecret or an inline Ed25519 private/public key pair" }}
{{- end }}
{{- if and .Values.security.controlTls.existingSecret .Values.security.controlTls.autoGenerate }}
{{- fail "controlTls existingSecret cannot be combined with autoGenerate=true" }}
{{- end }}
{{- if not (or .Values.security.controlTls.existingSecret .Values.security.controlTls.autoGenerate) }}
{{- fail "configure controlTls existingSecret or set autoGenerate=true for development" }}
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
