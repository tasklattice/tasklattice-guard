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
{{- $specs = append $specs (dict "name" (include (printf "tali-guard.bootstrap%sSecretName" $role) $) "legacyName" (printf "%s-bootstrap-%s" $base (lower $role)) "kind" "account" "email" $account.email "displayName" $account.name "minLength" $.Values.controller.auth.minLoginLength "localDefault" $account.localDefault "emailKey" $account.emailKey "nameKey" $account.nameKey "credentialKey" $account.credentialKey "digestKey" $account.digestKey) -}}
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
{{- if not (kindIs "invalid" $value) -}}
{{- $_ := set $labels $key $value -}}
{{- end -}}
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
{{- with .Values.controller.endpointContextStorage -}}
{{- if or (gt (int64 .maxRowsPerPool) (int64 .maxRowsGlobal)) (gt (int64 .maxPayloadBytesPerContext) (int64 .maxPayloadBytesPerPool)) (gt (int64 .maxPayloadBytesPerPool) (int64 .maxPayloadBytesGlobal)) -}}
{{- fail "controller.endpointContextStorage requires context <= pool <= global budgets" -}}
{{- end -}}
{{- end -}}
{{- include "tali-guard.validateAdmission" . -}}
{{- $poolAuth := .Values.security.poolAuthentication -}}
{{- if and $poolAuth.scopedTelemetry (not $poolAuth.enabled) -}}
{{- fail "security.poolAuthentication.scopedTelemetry requires enabled=true" -}}
{{- end -}}
{{- if $poolAuth.telemetryProgress -}}
{{- if or (not $poolAuth.enabled) (not $poolAuth.scopedTelemetry) -}}
{{- fail "security.poolAuthentication.telemetryProgress requires enabled=true and scopedTelemetry=true" -}}
{{- end -}}
{{- if not .Values.runner.telemetryProgress.persistence.enabled -}}
{{- fail "security.poolAuthentication.telemetryProgress requires runner.telemetryProgress.persistence.enabled=true; an ephemeral WAL cannot preserve Runner identity" -}}
{{- end -}}
{{- else if .Values.runner.telemetryProgress.persistence.enabled -}}
{{- fail "runner.telemetryProgress.persistence.enabled requires security.poolAuthentication.telemetryProgress=true" -}}
{{- end -}}
{{- if $poolAuth.enabled -}}
{{- if or (not $poolAuth.controllerSecret) (not $poolAuth.controllerKey) -}}
{{- fail "security.poolAuthentication requires controllerSecret and controllerKey" -}}
{{- end -}}
{{- $names := list "default" -}}
{{- range .Values.runner.pools -}}{{- $names = append $names .name -}}{{- end -}}
{{- $seen := dict -}}
{{- range $names -}}
{{- $ref := get $poolAuth.runnerSecrets . -}}
{{- if or (not $ref) (not $ref.name) (not $ref.key) -}}
{{- fail (printf "security.poolAuthentication.runnerSecrets must provide name and key for Runner pool %s" .) -}}
{{- end -}}
{{- $identity := printf "%s/%s" $ref.name $ref.key -}}
{{- if or (hasKey $seen $identity) (and (eq $ref.name $poolAuth.controllerSecret) (eq $ref.key $poolAuth.controllerKey)) -}}
{{- fail "each Runner pool must use a distinct Secret key, separate from the Controller token map key" -}}
{{- end -}}
{{- $_ := set $seen $identity true -}}
{{- end -}}
{{- range $name, $_ := $poolAuth.runnerSecrets -}}
{{- if not (has $name $names) -}}
{{- fail (printf "security.poolAuthentication.runnerSecrets contains unknown chart pool %s" $name) -}}
{{- end -}}
{{- end -}}
{{- else if or $poolAuth.controllerSecret (not (empty $poolAuth.runnerSecrets)) -}}
{{- fail "security.poolAuthentication references require enabled=true" -}}
{{- end -}}
{{- $httpAuth := .Values.security.runnerHttpAuthentication -}}
{{- if $httpAuth.enabled -}}
{{- if not $poolAuth.enabled -}}{{- fail "security.runnerHttpAuthentication requires security.poolAuthentication.enabled=true" -}}{{- end -}}
{{- if or (not $httpAuth.controllerSecret) (not $httpAuth.controllerKey) -}}
{{- fail "security.runnerHttpAuthentication requires controllerSecret and controllerKey" -}}
{{- end -}}
{{- $names := list "default" -}}
{{- range .Values.runner.pools -}}{{- $names = append $names .name -}}{{- end -}}
{{- $reserved := dict -}}
{{- $_ := set $reserved (printf "%s/%s" (include "tali-guard.controlSecretName" .) .Values.security.controlSecret.runnerTokenKey) true -}}
{{- $_ := set $reserved (printf "%s/%s" $poolAuth.controllerSecret $poolAuth.controllerKey) true -}}
{{- range $poolAuth.runnerSecrets -}}{{- $_ := set $reserved (printf "%s/%s" .name .key) true -}}{{- end -}}
{{- $mapIdentity := printf "%s/%s" $httpAuth.controllerSecret $httpAuth.controllerKey -}}
{{- if hasKey $reserved $mapIdentity -}}{{- fail "Controller HTTP map must use a separate Secret key from Runner control and legacy credentials" -}}{{- end -}}
{{- $_ := set $reserved $mapIdentity true -}}
{{- range $names -}}
{{- $ref := get $httpAuth.runnerSecrets . -}}
{{- if or (not $ref) (not $ref.name) (not $ref.key) -}}
{{- fail (printf "security.runnerHttpAuthentication.runnerSecrets must provide name and key for Runner pool %s" .) -}}
{{- end -}}
{{- $identity := printf "%s/%s" $ref.name $ref.key -}}
{{- if hasKey $reserved $identity -}}{{- fail "each Runner HTTP credential must use a distinct Secret key, separate from control and map credentials" -}}{{- end -}}
{{- $_ := set $reserved $identity true -}}
{{- end -}}
{{- range $name, $_ := $httpAuth.runnerSecrets -}}
{{- if not (has $name $names) -}}{{- fail (printf "security.runnerHttpAuthentication.runnerSecrets contains unknown chart pool %s" $name) -}}{{- end -}}
{{- end -}}
{{- else if or $httpAuth.controllerSecret (not (empty $httpAuth.runnerSecrets)) -}}
{{- fail "security.runnerHttpAuthentication references require enabled=true" -}}
{{- end -}}
{{- if lt (int .Values.runner.default.replicaCount) 1 }}
{{- fail "runner.default.replicaCount must be at least 1; GuardRails 0 is the mandatory baseline Runner pool" }}
{{- end }}

{{- if .Values.networkPolicy.runnerIsolation.enabled -}}
{{- if not .Values.networkPolicy.enabled -}}{{- fail "networkPolicy.runnerIsolation requires networkPolicy.enabled=true" -}}{{- end -}}
{{- $names := list "default" -}}
{{- range .Values.runner.pools -}}{{- $names = append $names .name -}}{{- end -}}
{{- range $name, $_ := .Values.networkPolicy.runnerIsolation.poolEgress -}}
{{- if not (has $name $names) -}}{{- fail (printf "networkPolicy.runnerIsolation.poolEgress contains unknown chart pool %s" $name) -}}{{- end -}}
{{- end -}}
{{- end -}}
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
{{- if and $account.existingSecret (or $account.email $account.localDefault) -}}
{{- fail (printf "bootstrap%s existingSecret cannot be combined with account initialization" $role) -}}
{{- end -}}
{{- if not (or $account.existingSecret $account.email) -}}
{{- fail (printf "configure bootstrap%s existingSecret or email for in-cluster initialization" $role) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- if and .Values.security.bootstrapUser.enabled .Values.security.bootstrapUser.email (eq (lower .Values.security.bootstrapUser.email) (lower .Values.security.bootstrapAdmin.email)) -}}
{{- fail "bootstrapAdmin and bootstrapUser must have different email addresses" -}}
{{- end -}}
{{- if or .Values.security.bootstrapAdmin.localDefault (and .Values.security.bootstrapUser.enabled .Values.security.bootstrapUser.localDefault) -}}
{{- range (include "tali-guard.publicUrls" . | fromJsonArray) -}}
{{- if not (regexMatch "^http://(localhost|127\\.0\\.0\\.1|\\[::1\\])(:[0-9]+)?/?$" .) -}}
{{- fail "bootstrap account localDefault requires loopback Controller publicUrl entries" -}}
{{- end -}}
{{- end -}}
{{- end -}}
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
  CONTROLLER_RUNNER_SCOPED_TELEMETRY: {{ .Values.security.poolAuthentication.scopedTelemetry | quote }}
  CONTROLLER_RUNNER_TELEMETRY_PROGRESS: {{ .Values.security.poolAuthentication.telemetryProgress | quote }}
  {{- with .Values.controller.endpointContextStorage }}
  CONTROLLER_ENDPOINT_CONTEXT_MAX_ROWS_PER_POOL: {{ .maxRowsPerPool | int64 | quote }}
  CONTROLLER_ENDPOINT_CONTEXT_MAX_ROWS_GLOBAL: {{ .maxRowsGlobal | int64 | quote }}
  CONTROLLER_ENDPOINT_CONTEXT_MAX_PAYLOAD_BYTES_PER_CONTEXT: {{ .maxPayloadBytesPerContext | int64 | quote }}
  CONTROLLER_ENDPOINT_CONTEXT_MAX_PAYLOAD_BYTES_PER_POOL: {{ .maxPayloadBytesPerPool | int64 | quote }}
  CONTROLLER_ENDPOINT_CONTEXT_MAX_PAYLOAD_BYTES_GLOBAL: {{ .maxPayloadBytesGlobal | int64 | quote }}
  {{- end }}
  CONTROLLER_PUBLIC_URL: {{ include "tali-guard.primaryPublicUrl" . | quote }}
  CONTROLLER_RUNTIME_SERVICE_URL: {{ include "tali-guard.defaultRuntimeServiceUrl" . | quote }}
  CONTROLLER_RUNTIME_PUBLIC_URL: {{ include "tali-guard.runtimePublicUrl" . | quote }}
  BETTER_AUTH_TRUSTED_ORIGINS: {{ include "tali-guard.trustedOrigins" . | fromJsonArray | join "," | quote }}
  CONTROLLER_MIN_LOGIN_LENGTH: {{ .Values.controller.auth.minLoginLength | quote }}
{{- end }}

{{/* Admission is explicit per pool, with no inheritance or policy provisioning. */}}
{{- define "tali-guard.validateAdmission" -}}
{{- $root := . -}}
{{- $default := dict "name" "default" "tenantAdmission" .Values.runner.default.tenantAdmission "distributedRateAdmission" .Values.runner.default.distributedRateAdmission "groupRateAdmission" .Values.runner.default.groupRateAdmission -}}
{{- $pools := concat (list $default) .Values.runner.pools -}}
{{- $configured := dict -}}
{{- range $pools -}}{{- $_ := set $configured .name . -}}{{- end -}}
{{- range $pool := $pools -}}
{{- $local := $pool.tenantAdmission -}}
{{- $rate := $pool.distributedRateAdmission -}}
{{- $group := $pool.groupRateAdmission -}}
{{- if $local -}}
{{- range $tenant, $_ := $local.tenant_limits -}}
{{- if ne $tenant (trim $tenant) -}}{{- fail (printf "Runner pool %s tenantAdmission tenant IDs must be unpadded" $pool.name) -}}{{- end -}}
{{- end -}}
{{- end -}}
{{- if $group -}}
{{- if $rate -}}{{- fail "groupRateAdmission and distributedRateAdmission cannot be enabled together" -}}{{- end -}}
{{- if not $local -}}{{- fail (printf "Runner pool %s groupRateAdmission requires tenantAdmission" $pool.name) -}}{{- end -}}
{{- if not $root.Values.security.poolAuthentication.enabled -}}{{- fail "groupRateAdmission requires security.poolAuthentication.enabled=true" -}}{{- end -}}
{{- if or $root.Values.redis.enabled (not $root.Values.runner.callContextRedisUrl) -}}{{- fail "groupRateAdmission requires external persistent Redis via runner.callContextRedisUrl" -}}{{- end -}}
{{- if or (ne $group.group_id (trim $group.group_id)) (ne $group.revision (trim $group.revision)) -}}
{{- fail "groupRateAdmission group_id and revision must be unpadded UTF-8 strings <=256 characters" -}}{{- end -}}
{{- if not (hasKey $group.pool_limits $pool.name) -}}{{- fail (printf "groupRateAdmission.pool_limits must contain local pool %s" $pool.name) -}}{{- end -}}
{{- if not (deepEqual (keys $group.pool_limits | sortAlpha) (keys $group.pool_epochs | sortAlpha)) -}}{{- fail "groupRateAdmission.pool_epochs keys must exactly match pool_limits" -}}{{- end -}}
{{- range $tenant, $_ := $local.tenant_limits -}}
{{- if not (hasKey $group.tenant_limits $tenant) -}}{{- fail "groupRateAdmission must include every local tenantAdmission tenant" -}}{{- end -}}
{{- end -}}
{{- $tenantHistory := 0 -}}
{{- range $tenant, $limit := $group.tenant_limits -}}
{{- if or (ne $tenant (trim $tenant)) -}}{{- fail "groupRateAdmission tenant IDs must be unpadded UTF-8 strings <=256 characters" -}}{{- end -}}
{{- $tenantHistory = add $tenantHistory (min (int $limit) (int $group.group_limit)) -}}
{{- end -}}
{{- $poolHistory := 0 -}}
{{- range $name, $limit := $group.pool_limits -}}
{{- if or (ne $name (trim $name)) -}}{{- fail "groupRateAdmission pool IDs must be unpadded UTF-8 strings <=256 characters" -}}{{- end -}}
{{- $poolHistory = add $poolHistory (min (int $limit) (int $group.group_limit)) -}}
{{- if hasKey $configured $name -}}
{{- $peer := get $configured $name -}}
{{- if not (deepEqual $peer.groupRateAdmission $group) -}}{{- fail "all declared groupRateAdmission pools in this chart require the identical complete group policy" -}}{{- end -}}
{{- end -}}
{{- end -}}
{{- if or (gt $tenantHistory 100000) (gt $poolHistory 100000) -}}{{- fail "groupRateAdmission retained tenant and pool histories must each be <=100000 entries" -}}{{- end -}}
{{- end -}}
{{- if $rate -}}
{{- if not $local -}}{{- fail (printf "Runner pool %s distributedRateAdmission requires tenantAdmission" $pool.name) -}}{{- end -}}
{{- if not $root.Values.security.poolAuthentication.enabled -}}{{- fail "distributedRateAdmission requires security.poolAuthentication.enabled=true" -}}{{- end -}}
{{- if or $root.Values.redis.enabled (not $root.Values.runner.callContextRedisUrl) -}}{{- fail "distributedRateAdmission requires external persistent Redis via runner.callContextRedisUrl; bundled ephemeral Redis is unsupported" -}}{{- end -}}
{{- if ne $rate.pool_id $pool.name -}}{{- fail (printf "Runner pool %s distributedRateAdmission.pool_id must match its trusted pool name" $pool.name) -}}{{- end -}}
{{- if ne $rate.revision (trim $rate.revision) -}}{{- fail "distributedRateAdmission revision must be unpadded" -}}{{- end -}}
{{- if not (deepEqual (keys $local.tenant_limits | sortAlpha) (keys $rate.tenant_limits | sortAlpha)) -}}{{- fail (printf "Runner pool %s distributedRateAdmission tenant IDs must match tenantAdmission" $pool.name) -}}{{- end -}}
{{- $history := 0 -}}
{{- range $tenant, $limit := $rate.tenant_limits -}}
{{- if ne $tenant (trim $tenant) -}}{{- fail "distributedRateAdmission tenant IDs must be unpadded" -}}{{- end -}}
{{- $history = add $history (min (int $limit) (int $rate.pool_limit)) -}}
{{- end -}}
{{- if gt $history 100000 -}}{{- fail "distributedRateAdmission retained tenant history must not exceed 100000 entries per pool" -}}{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
