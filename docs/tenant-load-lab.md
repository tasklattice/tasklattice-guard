# Standalone Project demo and acceptance tools

These Node 24 tools run outside Guard Controller and Guard Runner. They consume
operator-supplied gateway addresses, Runner addresses and existing Project
credentials. The current console uses Projects and OIDC/Keycloak; it has no
Tenant Load Lab page, tenant login selector or resource-sharing scenario.

Create Projects, memberships, published Guardrails, Routers, Endpoints and Runner
allocations through the current product workflow first. Follow the
[Project and SSO guide](document/en/admin/03-platform-access.mdx),
[Helm installation](../charts/tali-guard/README.md) and
[gateway integration guide](gateway-integration.md). These tools do not provision
or edit that configuration.

## External request path

```text
Standalone generator or acceptance process
  → configured OpenAI-compatible gateway + its credential
  → real Guard Input check on the Project's Runner
  → application generation model
  → real Guard Output check
  → gateway completion
```

The gateway must already have the Guard provider configured for Input and Output
checks. The generator calls Chat Completions; it does not issue Guard callbacks
itself, implement SSO or serve a model. An independent fake model can replace
application generation for a controlled experiment. Protection, routing,
authentication and telemetry still use the configured Guard deployment.

## Run a bounded traffic comparison

[scripts/tenant-load-lab.mjs](../scripts/tenant-load-lab.mjs) compares three client
bindings named `tenantA`, `tenantB` and `tenantC`. These are retained **demo
aliases**, not account identities or Project IDs. Map each alias to the gateway
credential and Runner address for an existing Project. The configured `groupId`
and `poolId` describe your experiment; they do not assign resources or grant
access.

Store the configuration outside tracked source, for example
`.local-secrets/external-demo/load.json`, with permissions `0600`:

```json
{
  "runnerBaseUrl": "http://runner-default.guard.svc:8000",
  "peakRps": 60,
  "tenants": [
    {
      "id": "tenantA",
      "name": "Project A client",
      "gatewayBaseUrl": "https://gateway-a.example.test/v1",
      "gatewayApiKey": "PRIVATE_GATEWAY_KEY_A",
      "model": "guarded-model",
      "groupId": "shared-experiment",
      "poolId": "default"
    },
    {
      "id": "tenantB",
      "name": "Project B client",
      "gatewayBaseUrl": "https://gateway-b.example.test/v1",
      "gatewayApiKey": "PRIVATE_GATEWAY_KEY_B",
      "model": "guarded-model",
      "groupId": "shared-experiment",
      "poolId": "default"
    },
    {
      "id": "tenantC",
      "name": "Project C client",
      "gatewayBaseUrl": "https://gateway-c.example.test/v1",
      "gatewayApiKey": "PRIVATE_GATEWAY_KEY_C",
      "model": "guarded-model",
      "runnerBaseUrl": "http://runner-project-c.guard.svc:8000",
      "groupId": "separate-experiment",
      "poolId": "project-c"
    }
  ]
}
```

Replace all example addresses, models, pool labels and credentials with your
own bindings. The three gateway bindings must be distinct. Add a top-level or
per-client `runnerMetricsToken` if Runner metrics require authentication.
Optional `modelStatusUrl` and `modelStatusToken` read the independent model's
bounded `/state` diagnostics; without them model diagnostics are unavailable.

```sh
TENANT_LOAD_LAB_CONFIG=.local-secrets/external-demo/load.json \
  node scripts/tenant-load-lab.mjs
```

The default bind is `127.0.0.1:38110`. Starting the process only starts monitoring;
it sends no gateway load until a control request starts it. Operate it from the
same host or an operator-controlled private connection:

```sh
curl -sS http://127.0.0.1:38110/state
curl -sS -X POST http://127.0.0.1:38110/control \
  -H 'content-type: application/json' -d '{"action":"start"}'
curl -sS -X POST http://127.0.0.1:38110/control \
  -H 'content-type: application/json' \
  -d '{"action":"peak","tenantId":"tenantA","durationSeconds":30}'
curl -sS -X POST http://127.0.0.1:38110/control \
  -H 'content-type: application/json' -d '{"action":"stop"}'
```

The direct `/state` and `/control` endpoints have no user authentication. Keep
them on loopback or a private operator network. `TENANT_LOAD_LAB_HOST` and
`TENANT_LOAD_LAB_PORT` change the bind explicitly. The `tenantId` control field
selects a demo alias only; no Controller Project selection is performed.

`release` ends a peak early, `reset` stops traffic and clears the generator's
measurements, and `mode` selects `shared` or `quota`. Stop/reset cancels local
requests; already accepted gateway/model work can take time to settle.

| Mode | Generator admission |
| --- | --- |
| `shared` | Queued arrivals use the configured global and group bounds. |
| `quota` | Client round-robin with at most four in-flight pipelines and ten starts/sec per alias. |

Both modes cap the process at 64 in-flight pipelines, 120 starts/sec and 32 queued
records per alias. Multiple configured groups reserve generator slots for each
other group. These are client-tool limits, not Runner permits or CPU reservations.
Baseline load defaults to 3–5 pipelines/sec per alias, initially four. Configure
`baselineMinRps`, `baselineMaxRps` and `baselineInitialRps` together to change it;
each accepts 0.25–20 and minimum ≤ initial ≤ maximum. Peaks last 15–60 seconds
and `peakRps` is bounded to 12–80.

## Interpret the state

Successful completion latency includes the client queue and uses a rolling
15-second window. Offered and completed rates cover the preceding second. All
non-2xx responses, timeouts, malformed completions and dropped arrivals count as
errors. Successful latency alone can hide a failing or saturated pipeline.

The gateway completion does not provide reliable policy-decision, block-phase,
transformation or per-stage timing evidence. Those fields are unavailable;
zero-valued internal counters must not be interpreted as proof that Guard allowed
all requests. Check actual Runner telemetry for protection outcomes.

Occupancy is generator in-flight pipelines divided by four reference slots,
capped at 100%; it is not Project CPU usage. Runner process gauges are aggregated
once per configured pool, with unavailable scrapes represented as missing data.
A shared host can still contend across dedicated pools. Model diagnostics belong
to the external service's own sample window. History retains at most 180 samples.

## Verify existing Projects

[scripts/verify-local-multitenancy.mjs](../scripts/verify-local-multitenancy.mjs)
is a separate serial acceptance runner for two to eight actual Project IDs.
Unlike the generator, it uses current management APIs to check supplied
Project-bound identities, direct-ID resource isolation and denied administrator
controls. It then sends a gateway request for each Project and waits for paired
Input/Output telemetry on the configured Endpoint, Router and Guardrail version.
The Project that owns the pair must be able to read both event details. For
every other Project, the filtered list must be empty and both event detail
requests must return HTTP 404.

Use existing business-user access tokens with read permissions for identity,
resources and runtime evidence, or existing browser sessions that select the
configured Project. The tool performs no login. A minimal private configuration
for two Projects is:

```json
{
  "controllerBaseUrl": "https://guard.example.test",
  "projects": [
    {
      "id": "PROJECT_A_ID",
      "auth": { "bearerToken": "PRIVATE_PROJECT_A_TOKEN" },
      "runnerBaseUrl": "https://runner-a.example.test",
      "gateway": {
        "baseUrl": "https://gateway-a.example.test/v1",
        "apiKey": "PRIVATE_GATEWAY_KEY_A",
        "model": "guarded-model"
      },
      "resources": {
        "endpointId": "PROJECT_A_ENDPOINT_ID",
        "routerId": "PROJECT_A_ROUTER_ID",
        "guardrailId": "PROJECT_A_GUARDRAIL_ID",
        "guardrailVersion": "PUBLISHED_VERSION"
      }
    },
    {
      "id": "PROJECT_B_ID",
      "auth": { "bearerToken": "PRIVATE_PROJECT_B_TOKEN" },
      "runnerBaseUrl": "https://runner-b.example.test",
      "gateway": {
        "baseUrl": "https://gateway-b.example.test/v1",
        "apiKey": "PRIVATE_GATEWAY_KEY_B",
        "model": "guarded-model"
      },
      "resources": {
        "endpointId": "PROJECT_B_ENDPOINT_ID",
        "routerId": "PROJECT_B_ROUTER_ID",
        "guardrailId": "PROJECT_B_GUARDRAIL_ID",
        "guardrailVersion": "PUBLISHED_VERSION"
      }
    }
  ]
}
```

```sh
node scripts/verify-local-multitenancy.mjs \
  --config .local-secrets/external-demo/acceptance.json \
  --execute --result .tasklattice-recovery/project-acceptance.json
```

`--execute` is required because the check sends real application traffic and
creates telemetry. It does not change resources, policies, membership or
allocation. Keep test resources quiet and clocks synchronized so paired telemetry
can be attributed to this serial run. Use harmless `requestText` accepted by the
configured Guardrail; the default is `Hello.`.

Optional settings extend the evidence:

- `administratorAuth` uses the same token-or-session shape for current allocation
  and public Model-policy reads (`platform`, `scoped` or `blocked`). Optional
  per-Project `expectedGroupId` and `expectedPoolId` assert operator expectations.
- `modelStatus: { "url": "https://model.example.test/state", "token": "PRIVATE_MODEL_TOKEN" }`
  checks an idle external model's `completed`/`active` counters for dispatch.
- Per-Project `resources.endpointCredential` enables Endpoint verification and
  wrong-Runner credential checks where different Runner origins are configured.

The result records requested capabilities and missing optional evidence. A pass
without model diagnostics does not prove model dispatch. This serial run does
not prove performance isolation, failover or infrastructure capacity. Results
are written privately and configured credentials are redacted.

## Optional Kubernetes helper tools

The [external manifest renderer](../deploy/local-k8s/README.md) reads private
operator gateway/Runner bindings and a standalone generator manifest template.
It writes private manifests for review; it does not install Guard or provision
Projects. Guard's supported Helm chart remains [charts/tali-guard](../charts/tali-guard/README.md).

On macOS, [local-k8s-access.mjs](../scripts/local-k8s-access.mjs) can maintain a
loopback `kubectl port-forward` to an explicitly selected existing Service:

```sh
GUARD_K8S_ACCESS_SERVICE=my-controller \
GUARD_K8S_ACCESS_NAMESPACE=guard \
GUARD_K8S_ACCESS_KUBECONFIG=/private/operator/kubeconfig \
  node scripts/local-k8s-access.mjs install
```

Use the same environment with `status` or `uninstall`. The default namespace is
`default`, kubeconfig is `~/.kube/config`, local port is 38081 and target port is
8080. `GUARD_K8S_ACCESS_SERVICE` is required. This helper runs a network bridge,
not an application process.

The [5 November deployment record](local-k8s-runtime-2026-11-05.md) describes a
historical pre-Project-refactor runtime and its screenshots. It is not validation
of this rebased source or instructions for current console provisioning.

## Test the external tooling

Run the local script regressions without a configured deployment:

```sh
node --test scripts/tenant-load-lab.test.mjs \
  scripts/local-k8s-access.test.mjs \
  scripts/render-local-k8s-external.test.mjs \
  scripts/verify-local-multitenancy.test.mjs
```

These tests use local fixtures or fake transports. They do not substitute for an
explicit acceptance run against the operator's current Project deployment.
