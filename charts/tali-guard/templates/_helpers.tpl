{{/* Normalize optional runtime settings for each entry point before use. */}}
{{- define "tali-guard.defaults" -}}
{{- $values := mergeOverwrite (.Files.Get "files/runtime-defaults.yaml" | fromYaml) .Values -}}
{{- $_ := set . "Values" $values -}}
{{- include "tali-guard.securityDefaults" . -}}
{{- end }}

{{/* Match browser Origin serialization: lowercase host and omit default ports. */}}
{{- define "tali-guard.sharedPublicUrl" -}}
{{- if .Values.publicUrl -}}
{{- $url := urlParse .Values.publicUrl -}}
{{- $host := lower $url.host -}}
{{- if eq $url.scheme "https" -}}
{{- $host = regexReplaceAll ":443$" $host "" -}}
{{- else -}}
{{- $host = regexReplaceAll ":80$" $host "" -}}
{{- end -}}
{{- printf "%s://%s" $url.scheme $host -}}
{{- end -}}
{{- end }}

{{/* Shared URL takes precedence over legacy Controller-only URLs. */}}
{{- define "tali-guard.publicUrls" -}}
{{- if .Values.publicUrl -}}
{{- toJson (list (include "tali-guard.sharedPublicUrl" .)) -}}
{{- else if kindIs "string" .Values.controller.publicUrl -}}
{{- toJson (list .Values.controller.publicUrl) -}}
{{- else -}}
{{- toJson .Values.controller.publicUrl -}}
{{- end -}}
{{- end }}

{{- define "tali-guard.primaryPublicUrl" -}}
{{- first (include "tali-guard.publicUrls" . | fromJsonArray) -}}
{{- end }}

{{/* Always trust the shared UI origin; preserve legacy override semantics
     when publicUrl is empty. Compute without caching derived values in .Values. */}}
{{- define "tali-guard.trustedOrigins" -}}
{{- $origins := list -}}
{{- if or .Values.publicUrl (not .Values.controller.trustedOrigins) -}}
{{- range (include "tali-guard.publicUrls" . | fromJsonArray) -}}
{{- $url := urlParse . -}}
{{- $origins = append $origins (printf "%s://%s" $url.scheme $url.host) -}}
{{- end -}}
{{- end -}}
{{- $origins = concat $origins (default (list) .Values.controller.trustedOrigins) -}}
{{- toJson (uniq $origins) -}}
{{- end }}

{{/* Public advertising only. Internal calls never use this URL. */}}
{{- define "tali-guard.runtimePublicUrl" -}}
{{- if .Values.runner.publicUrl -}}
{{- .Values.runner.publicUrl -}}
{{- else if .Values.publicUrl -}}
{{- include "tali-guard.sharedPublicUrl" . -}}
{{- else -}}
{{- $ui := urlParse (include "tali-guard.primaryPublicUrl" .) -}}
{{- $host := regexReplaceAll ":[0-9]+$" $ui.host "" -}}
{{/* Local LoadBalancer ports are separate; there is no shared ingress. Do not
     infer a public runtime address for non-local or NodePort installations. */}}
{{- if and .Values.runner.service.public.enabled (eq .Values.runner.service.public.type "LoadBalancer") (eq $ui.scheme "http") (has $host (list "localhost" "127.0.0.1" "[::1]")) -}}
{{- printf "http://%s:%v" $host .Values.runner.service.public.port -}}
{{- end -}}
{{- end -}}
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

{{/* Stable names distinct from resources managed by earlier Helm releases. */}}
{{- define "tali-guard.managedSecretName" -}}
{{- if le (len .) 58 -}}
{{- printf "%s-init" . -}}
{{- else -}}
{{- printf "%s-%s-init" (. | trunc 44 | trimSuffix "-") (. | sha256sum | trunc 12) -}}
{{- end -}}
{{- end }}

{{- define "tali-guard.bootstrapSecretSpecs" -}}
{{- $specs := list -}}
{{- $base := include "tali-guard.fullname" . -}}
{{- if .Values.security.bootstrap.enabled -}}
{{- if .Values.postgresql.enabled -}}
{{- $specs = append $specs (dict "name" (include "tali-guard.databaseSecretName" .) "legacyName" (include "tali-guard.postgresqlName" .) "kind" "database" "host" (include "tali-guard.postgresqlName" .) "username" .Values.postgresql.auth.username "database" .Values.postgresql.auth.database "urlKey" .Values.database.secretKey "credentialKey" (default "" .Values.postgresql.auth.credentialKey)) -}}
{{- end -}}
{{- range $role, $account := dict "Admin" .Values.security.bootstrapAdmin "User" .Values.security.bootstrapUser -}}
{{- if and (or (eq $role "Admin") $account.enabled) (not $account.existingSecret) -}}
{{- $specs = append $specs (dict "name" (include (printf "tali-guard.bootstrap%sSecretName" $role) $) "legacyName" (printf "%s-bootstrap-%s" $base (lower $role)) "kind" "account" "username" $account.username "displayName" $account.name "usernameKey" $account.usernameKey "nameKey" $account.nameKey "credentialKey" $account.credentialKey) -}}
{{- end -}}
{{- end -}}
{{- if not .Values.security.artifactSigning.existingSecret -}}
{{- $specs = append $specs (dict "name" (include "tali-guard.artifactSigningSecretName" .) "legacyName" (printf "%s-artifact-signing" $base | trunc 63 | trimSuffix "-") "kind" "ed25519" "privateKey" .Values.security.artifactSigning.privateKeyKey "publicKey" .Values.security.artifactSigning.publicKeyKey) -}}
{{- end -}}
{{- if not .Values.security.controlSecret.existingSecret -}}
{{- $specs = append $specs (dict "name" (include "tali-guard.controlSecretName" .) "legacyName" (printf "%s-control" $base | trunc 63 | trimSuffix "-") "kind" "tokens" "keys" (list .Values.security.controlSecret.runnerTokenKey .Values.security.controlSecret.betterAuthSecretKey)) -}}
{{- end -}}
{{- if not .Values.security.metrics.existingSecret -}}
{{- $specs = append $specs (dict "name" (include "tali-guard.metricsSecretName" .) "legacyName" (printf "%s-metrics" $base | trunc 63 | trimSuffix "-") "kind" "tokens" "keys" (list .Values.security.metrics.tokenKey)) -}}
{{- end -}}
{{- if not .Values.security.runtimeLogs.existingSecret -}}
{{- $specs = append $specs (dict "name" (include "tali-guard.runtimeLogSecretName" .) "legacyName" (printf "%s-runtime-logs" $base | trunc 63 | trimSuffix "-") "kind" "encryption" "keys" (list .Values.security.runtimeLogs.encryptionKeyKey)) -}}
{{- end -}}
{{- end -}}
{{- if and .Values.security.controlTls.enabled .Values.security.controlTls.autoGenerate (not .Values.security.controlTls.existingSecret) -}}
{{- $controller := include "tali-guard.controllerName" . -}}
{{- $dns := list $controller (printf "%s.%s" $controller .Release.Namespace) (printf "%s.%s.svc" $controller .Release.Namespace) (printf "%s.%s.svc.cluster.local" $controller .Release.Namespace) -}}
{{- $specs = append $specs (dict "name" (include "tali-guard.controlTlsSecretName" .) "legacyName" (printf "%s-control-tls" $base | trunc 63 | trimSuffix "-") "kind" "mtls" "serverDnsNames" $dns "runnerName" (include "tali-guard.defaultRunnerName" .) "caKey" .Values.security.controlTls.caKey "caPrivateKeyKey" .Values.security.controlTls.caPrivateKeyKey "serverCertificateKey" .Values.security.controlTls.controllerCertificateKey "serverPrivateKeyKey" .Values.security.controlTls.controllerPrivateKeyKey "clientCertificateKey" .Values.security.controlTls.runnerCertificateKey "clientPrivateKeyKey" .Values.security.controlTls.runnerPrivateKeyKey) -}}
{{- end -}}
{{- toJson $specs -}}
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

{{/* Build one label map so custom ServiceMonitor labels cannot replace chart identity. */}}
{{- define "tali-guard.serviceMonitorLabels" -}}
{{- $labels := include "tali-guard.commonLabels" .root | fromYaml -}}
{{- $_ := set $labels "app.kubernetes.io/component" .component -}}
{{- range $key, $value := .root.Values.observability.serviceMonitor.labels -}}
{{- if hasKey $labels $key -}}
{{- fail (printf "observability.serviceMonitor.labels: label %q is reserved by the chart and cannot be overridden" $key) -}}
{{- end -}}
{{- $_ := set $labels $key $value -}}
{{- end -}}
{{- toYaml $labels -}}
{{- end }}

{{- define "tali-guard.controlSecretName" -}}
{{- default (include "tali-guard.managedSecretName" (printf "%s-control" (include "tali-guard.fullname" .))) .Values.security.controlSecret.existingSecret }}
{{- end }}

{{- define "tali-guard.metricsSecretName" -}}
{{- default (include "tali-guard.managedSecretName" (printf "%s-metrics" (include "tali-guard.fullname" .))) .Values.security.metrics.existingSecret }}
{{- end }}

{{- define "tali-guard.runtimeLogSecretName" -}}
{{- default (include "tali-guard.managedSecretName" (printf "%s-runtime-logs" (include "tali-guard.fullname" .))) .Values.security.runtimeLogs.existingSecret }}
{{- end }}

{{- define "tali-guard.databaseSecretName" -}}
{{- if .Values.database.existingSecret -}}
{{- .Values.database.existingSecret -}}
{{- else if .Values.postgresql.enabled -}}
{{- include "tali-guard.managedSecretName" (include "tali-guard.postgresqlName" .) -}}
{{- else -}}
{{- printf "%s-database" (include "tali-guard.fullname" .) -}}
{{- end -}}
{{- end }}

{{- define "tali-guard.bootstrapAdminSecretName" -}}
{{- default (include "tali-guard.managedSecretName" (printf "%s-bootstrap-admin" (include "tali-guard.fullname" .))) .Values.security.bootstrapAdmin.existingSecret }}
{{- end }}

{{- define "tali-guard.bootstrapUserSecretName" -}}
{{- default (include "tali-guard.managedSecretName" (printf "%s-bootstrap-user" (include "tali-guard.fullname" .))) .Values.security.bootstrapUser.existingSecret }}
{{- end }}

{{- define "tali-guard.artifactSigningSecretName" -}}
{{- default (include "tali-guard.managedSecretName" (printf "%s-artifact-signing" (include "tali-guard.fullname" .))) .Values.security.artifactSigning.existingSecret }}
{{- end }}

{{- define "tali-guard.controlTlsSecretName" -}}
{{- default (include "tali-guard.managedSecretName" (printf "%s-control-tls" (include "tali-guard.fullname" .))) .Values.security.controlTls.existingSecret }}
{{- end }}

{{- define "tali-guard.customCaSecretName" -}}
{{- .Values.security.customCa.existingSecret }}
{{- end }}

{{- define "tali-guard.validateValues" -}}
{{- if lt (int .Values.runner.default.replicaCount) 1 }}
{{- fail "runner.default.replicaCount must be at least 1; GuardRails 0 is the mandatory baseline Runner pool" }}
{{- end }}
{{- if and .Values.postgresql.enabled .Values.database.existingSecret -}}
{{- fail "postgresql.enabled cannot be combined with database.existingSecret" -}}
{{- end -}}
{{- if not (or .Values.postgresql.enabled .Values.database.existingSecret) -}}
{{- fail "enable postgresql or set database.existingSecret; Controller requires PostgreSQL" -}}
{{- end -}}
{{- if not .Values.security.bootstrap.enabled -}}
{{- if or .Values.postgresql.enabled (not .Values.security.controlSecret.existingSecret) (not .Values.security.metrics.existingSecret) (not .Values.security.runtimeLogs.existingSecret) (not .Values.security.artifactSigning.existingSecret) (not .Values.security.bootstrapAdmin.existingSecret) (and .Values.security.bootstrapUser.enabled (not .Values.security.bootstrapUser.existingSecret)) -}}
{{- fail "enable security.bootstrap or supply every managed Secret through existingSecret" -}}
{{- end -}}
{{- end -}}
{{- range $role, $account := dict "Admin" .Values.security.bootstrapAdmin "User" .Values.security.bootstrapUser -}}
{{- if or (eq $role "Admin") $account.enabled -}}
{{- if and (not $account.existingSecret) (gt (int $.Values.controller.auth.minLoginLength) 8) -}}
{{- fail "managed account initialization uses an 8-character credential; provide external account Secrets for a larger minLoginLength" -}}
{{- end -}}
{{- if and (not $account.existingSecret) (not (regexMatch "^[a-z0-9_.-]{3,64}$" $account.username)) -}}
{{- fail (printf "bootstrap%s requires a username of 3-64 lowercase letters, digits, dots, underscores or hyphens" $role) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- if and .Values.security.bootstrapUser.enabled (eq .Values.security.bootstrapUser.username .Values.security.bootstrapAdmin.username) -}}
{{- fail "bootstrapAdmin and bootstrapUser must have different usernames" -}}
{{- end -}}
{{- if and .Values.security.controlTls.enabled (not (or .Values.security.controlTls.existingSecret .Values.security.controlTls.autoGenerate)) }}
{{- fail "configure controlTls existingSecret or set autoGenerate=true for in-cluster initialization" }}
{{- end }}
{{- if and .Values.redis.enabled .Values.runner.callContextRedisUrl }}
{{- fail "set either redis.enabled=true or runner.callContextRedisUrl, not both" }}
{{- end }}
{{- if and .Values.redis.enabled (ne .Values.redis.maxmemoryPolicy "noeviction") }}
{{- fail "shared call context Redis requires maxmemoryPolicy=noeviction" }}
{{- end }}
{{- if and .Values.redis.enabled (not (regexMatch "^[1-9][0-9]*(kb|mb|gb)?$" (toString .Values.redis.maxmemory))) }}
{{- fail "redis.maxmemory must be a positive Redis memory size, for example 4gb" }}
{{- end }}
{{- if le (int .Values.runner.callContext.ttlSeconds) 0 }}
{{- fail "runner.callContext.ttlSeconds must be positive" }}
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
  CONTROLLER_RUNTIME_PUBLIC_URL: {{ include "tali-guard.runtimePublicUrl" . | quote }}
  BETTER_AUTH_TRUSTED_ORIGINS: {{ include "tali-guard.trustedOrigins" . | fromJsonArray | join "," | quote }}
  CONTROLLER_MIN_LOGIN_LENGTH: {{ .Values.controller.auth.minLoginLength | quote }}
  {{- with .Values.controller.trustedProxyCidrs }}
  CONTROLLER_TRUSTED_PROXY_CIDRS: {{ join "," . | quote }}
  {{- end }}
{{- end }}
