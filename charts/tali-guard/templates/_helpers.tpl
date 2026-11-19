{{/* Every Runner-based workload shares the same pinned image. */}}
{{- define "tali-guard.runnerImage" -}}
{{- with .Values.runner.image.digest -}}
{{- if not (regexMatch "^sha256:[0-9a-f]{64}$" .) -}}
{{- fail "runner.image.digest must be a SHA-256 OCI digest" -}}
{{- end -}}
{{- printf "%s@%s" $.Values.runner.image.repository . -}}
{{- else -}}
{{- printf "%s:%s" .Values.runner.image.repository (default .Chart.AppVersion .Values.runner.image.tag) -}}
{{- end -}}
{{- end }}

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

{{/* Shared URL takes precedence over Controller UI/auth URLs. */}}
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

{{/* Always trust the shared UI origin; apply the Controller trusted-origin overrides
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
{{- $specs = append $specs (dict "name" (include "tali-guard.databaseSecretName" .) "kind" "database" "host" (include "tali-guard.postgresqlName" .) "username" .Values.postgresql.auth.username "database" .Values.postgresql.auth.database "urlKey" .Values.database.secretKey "credentialKey" (default "" .Values.postgresql.auth.credentialKey)) -}}
{{- end -}}
{{- range $role, $account := dict "Admin" .Values.security.bootstrapAdmin "User" .Values.security.bootstrapUser -}}
{{- if and (or (eq $role "Admin") $account.enabled) (not $account.existingSecret) -}}
{{- $specs = append $specs (dict "name" (include (printf "tali-guard.bootstrap%sSecretName" $role) $) "kind" "account" "username" $account.username "usernameKey" $account.usernameKey "credentialKey" $account.credentialKey) -}}
{{- end -}}
{{- end -}}
{{- if .Values.keycloak.enabled -}}
{{- $specs = append $specs (dict "name" (printf "%s-keycloak" $base) "kind" "tokens" "keys" (list "admin-password" "client-secret")) -}}
{{- end -}}
{{- if not .Values.security.artifactSigning.existingSecret -}}
{{- $specs = append $specs (dict "name" (include "tali-guard.artifactSigningSecretName" .) "kind" "ed25519" "privateKey" .Values.security.artifactSigning.privateKeyKey "publicKey" .Values.security.artifactSigning.publicKeyKey) -}}
{{- end -}}
{{- if not .Values.security.controlSecret.existingSecret -}}
{{- $specs = append $specs (dict "name" (include "tali-guard.controlSecretName" .) "kind" "tokens" "keys" (list .Values.security.controlSecret.betterAuthSecretKey)) -}}
{{- end -}}
{{- $runnerAuth := include "tali-guard.runnerAuthRefs" . | fromJson -}}
{{- if $runnerAuth.managed -}}
{{- $specs = append $specs (dict "name" (include "tali-guard.runnerAuthSecretName" .) "kind" "runnerAuth") -}}
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
{{- if (index .Values "litellm-provider").enabled -}}
{{- $specs = concat $specs (include "tali-guard.litellm.bootstrapSecretSpecs" . | fromJsonArray) -}}
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
runner-default
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

{{- define "tali-guard.runnerAuthSecretName" -}}
{{- include "tali-guard.managedSecretName" (printf "%s-runner-auth" (include "tali-guard.fullname" .)) -}}
{{- end }}

{{- define "tali-guard.runnerAuthRefs" -}}
{{- $secret := include "tali-guard.runnerAuthSecretName" . -}}
{{- $roles := dict
    "control" (dict "setting" "poolAuthentication" "mapKey" "pool-tokens.json" "tokenKey" "runner-control-token")
    "http" (dict "setting" "runnerHttpAuthentication" "mapKey" "pool-http-tokens.json" "tokenKey" "controller-http-token") -}}
{{- $refs := dict "managed" false -}}
{{- $used := dict (printf "%s/%s" (include "tali-guard.controlSecretName" .) .Values.security.controlSecret.betterAuthSecretKey) true -}}
{{- range $role, $defaults := $roles -}}
{{- $config := get $.Values.security $defaults.setting -}}
{{- $setting := printf "security.%s" $defaults.setting -}}
{{- if not (kindIs "map" $config) -}}{{- fail (printf "%s must be an object" $setting) -}}{{- end -}}
{{- $controller := dict "name" $secret "key" $defaults.mapKey -}}
{{- $runner := dict "name" $secret "key" $defaults.tokenKey -}}
{{- if or $config.controllerSecret $config.controllerKey $config.runnerSecrets -}}
{{- if or (not $config.controllerSecret) (not (kindIs "map" $config.runnerSecrets)) -}}
{{- fail (printf "%s requires controllerSecret and runnerSecrets.default" $setting) -}}
{{- end -}}
{{- $defaultRunner := get $config.runnerSecrets "default" -}}
{{- if or (ne (len $config.runnerSecrets) 1) (not (kindIs "map" $defaultRunner)) (not $defaultRunner.name) (not $defaultRunner.key) -}}
{{- fail (printf "%s.runnerSecrets must provide name and key for only the default Runner pool" $setting) -}}
{{- end -}}
{{- $controller = dict "name" $config.controllerSecret "key" (default $defaults.mapKey $config.controllerKey) -}}
{{- $runner = $defaultRunner -}}
{{- else -}}
{{- $_ := set $refs "managed" true -}}
{{- end -}}
{{- range $ref := list $controller $runner -}}
{{- $identity := printf "%s/%s" $ref.name $ref.key -}}
{{- if hasKey $used $identity -}}
{{- fail "Runner authentication and Better Auth require distinct Secret keys for each credential and map" -}}
{{- end -}}
{{- $_ := set $used $identity true -}}
{{- end -}}
{{- $_ := set $refs $role (dict "controller" $controller "runner" $runner) -}}
{{- end -}}
{{- toJson $refs -}}
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
{{- if and (index .Values "litellm-provider").enabled (not .Values.security.bootstrap.enabled) -}}
{{- fail "litellm-provider.enabled requires security.bootstrap.enabled" -}}
{{- end -}}
{{- if hasKey .Values.controller "endpointContextStorage" -}}
{{- $storage := .Values.controller.endpointContextStorage -}}
{{- include "tali-guard.featureObject" (dict "name" "controller.endpointContextStorage" "value" $storage "fields" (list "maxRowsPerPool" "maxRowsGlobal" "maxPayloadBytesPerContext" "maxPayloadBytesPerPool" "maxPayloadBytesGlobal")) -}}
{{- range $name := list "maxRowsPerPool" "maxRowsGlobal" "maxPayloadBytesPerContext" "maxPayloadBytesPerPool" "maxPayloadBytesGlobal" -}}
{{- $maximum := 2147483647 -}}{{- if has $name (list "maxRowsPerPool" "maxRowsGlobal") -}}{{- $maximum = 1000000 -}}{{- end -}}
{{- include "tali-guard.featureNumber" (dict "name" (printf "controller.endpointContextStorage.%s" $name) "value" (get $storage $name) "minimum" 1 "maximum" $maximum "integer" true) -}}
{{- end -}}
{{- with $storage -}}
{{- if or (gt (int64 .maxRowsPerPool) (int64 .maxRowsGlobal)) (gt (int64 .maxPayloadBytesPerContext) (int64 .maxPayloadBytesPerPool)) (gt (int64 .maxPayloadBytesPerPool) (int64 .maxPayloadBytesGlobal)) -}}
{{- fail "controller.endpointContextStorage requires context <= pool <= global budgets" -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- $runnerAuth := include "tali-guard.runnerAuthRefs" . | fromJson -}}
{{- if lt (int .Values.runner.default.replicaCount) 1 }}
{{- fail "runner.default.replicaCount must be at least 1; runner-default is the mandatory baseline Runner pool" }}
{{- end }}

{{- if and .Values.postgresql.enabled .Values.database.existingSecret -}}
{{- fail "postgresql.enabled cannot be combined with database.existingSecret" -}}
{{- end -}}
{{- if not (or .Values.postgresql.enabled .Values.database.existingSecret) -}}
{{- fail "enable postgresql or set database.existingSecret; Controller requires PostgreSQL" -}}
{{- end -}}
{{- if not .Values.security.bootstrap.enabled -}}
{{- if $runnerAuth.managed -}}
{{- fail "enable security.bootstrap or provide external Secrets for both Runner authentication roles" -}}
{{- end -}}
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
{{- fail "shared Redis is required when runner-default has more than one replica; enable redis or set runner.callContextRedisUrl" }}
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
  NODE_ENV: {{ ternary "development" "production" .Values.keycloak.enabled }}
  CONTROLLER_DATABASE_STATEMENT_TIMEOUT_MS: {{ .Values.controller.databaseTimeouts.statementMs | quote }}
  CONTROLLER_DATABASE_LOCK_TIMEOUT_MS: {{ .Values.controller.databaseTimeouts.lockMs | quote }}
  CONTROLLER_DATABASE_IDLE_TRANSACTION_TIMEOUT_MS: {{ .Values.controller.databaseTimeouts.idleTransactionMs | quote }}
  CONTROLLER_RUNNER_SYNC_CONCURRENCY: {{ .Values.controller.runnerSyncConcurrency | quote }}
  CONTROLLER_DEBUG_ERRORS: {{ .Values.controller.debugErrors | default false | quote }}
  CONTROLLER_GRPC_TRANSPORT: {{ ternary "mtls" "plaintext" .Values.security.controlTls.enabled | quote }}
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
  {{- $sso := .Values.controller.sso | default dict }}
  {{- if .Values.keycloak.enabled }}
  CONTROLLER_SSO_ENABLED: "true"
  CONTROLLER_SSO_ISSUER: {{ printf "http://localhost:%v/realms/tali" .Values.keycloak.port | quote }}
  CONTROLLER_SSO_CLIENT_ID: tasklattice-guard
  CONTROLLER_SSO_DISPLAY_NAME: Keycloak
  CONTROLLER_SSO_GROUP_CLAIM: groups
  {{- else }}
  CONTROLLER_SSO_ENABLED: {{ $sso.enabled | default false | quote }}
  {{- if $sso.enabled }}
  CONTROLLER_SSO_ISSUER: {{ required "controller.sso.issuer is required" $sso.issuer | quote }}
  CONTROLLER_SSO_CLIENT_ID: {{ required "controller.sso.clientId is required" $sso.clientId | quote }}
  CONTROLLER_SSO_DISPLAY_NAME: {{ $sso.displayName | default "Company SSO" | quote }}
  CONTROLLER_SSO_GROUP_CLAIM: {{ $sso.groupClaim | default "groups" | quote }}
  CONTROLLER_SSO_ALLOWED_EMAIL_DOMAINS: {{ $sso.allowedEmailDomains | default list | join "," | quote }}
  {{- end }}
  {{- end }}
  CONTROLLER_MIN_LOGIN_LENGTH: {{ .Values.controller.auth.minLoginLength | quote }}
  {{- with .Values.controller.trustedProxyCidrs }}
  CONTROLLER_TRUSTED_PROXY_CIDRS: {{ join "," . | quote }}
  {{- end }}
{{- end }}

{{/* Validate only supported security feature objects; general platform metadata remains pass-through. */}}
{{- define "tali-guard.featureObject" -}}
{{- if not (kindIs "map" .value) -}}{{- fail (printf "%s must be an object" .name) -}}{{- end -}}
{{- $name := .name -}}{{- $value := .value -}}
{{- range .fields -}}{{- if not (hasKey $value .) -}}{{- fail (printf "%s requires %s" $name .) -}}{{- end -}}{{- end -}}
{{- $fields := .fields -}}
{{- range $key, $_ := $value -}}{{- if not (has $key $fields) -}}{{- fail (printf "%s contains unsupported field %s" $name $key) -}}{{- end -}}{{- end -}}
{{- end -}}

{{- define "tali-guard.featureNumber" -}}
{{- $value := .value -}}
{{- if not (or (kindIs "float64" $value) (kindIs "float32" $value) (kindIs "int" $value) (kindIs "int64" $value) (typeIs "json.Number" $value)) -}}
{{- fail (printf "%s must be a number" .name) -}}{{- end -}}
{{- $number := float64 $value -}}
{{- if or (lt $number (float64 .minimum)) (gt $number (float64 .maximum)) (and .integer (ne $number (floor $number))) -}}
{{- fail (printf "%s is outside its supported numeric bounds" .name) -}}{{- end -}}
{{- end -}}
