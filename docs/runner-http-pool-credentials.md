# Per-pool internal HTTP credentials

Status: optional implementation with focused automated tests; not deployed by
this change. Tenant groups allocate Runner pools. A credential belongs to a
pool and is shared by its replicas; it is not an individual Runner identity.

## Credential roles

| Direction and purpose | Controller setting | Runner setting |
| --- | --- | --- |
| Legacy compatibility bearer | `CONTROLLER_RUNNER_TOKEN` | `GUARD_CONTROLLER_TOKEN` |
| Runner → Controller control stream and model credential resolution | `CONTROLLER_RUNNER_POOL_TOKENS_JSON` | `GUARD_RUNNER_CONTROL_TOKEN` |
| Controller → Runner internal evaluation, draft preparation and Router path testing | `CONTROLLER_RUNNER_HTTP_TOKENS_JSON` | `GUARD_CONTROLLER_HTTP_TOKEN` |
| Runner → Controller scoped telemetry | pool-token map plus `CONTROLLER_RUNNER_SCOPED_TELEMETRY=true` | pool control token plus `GUARD_RUNNER_SCOPED_TELEMETRY=true` |

Both maps are private flat JSON objects from exact pool IDs to high-entropy
tokens. Each token must contain at least 32 printable ASCII characters without
whitespace (bytes `0x21` through `0x7e`). Non-ASCII characters, lone Unicode
surrogates and control characters are rejected so Node and Python compare the
same exact credential bytes. This restriction applies to the new pool control
and HTTP roles; legacy token validation is unchanged.
Duplicate decoded pool IDs, including escaped equivalents, are rejected.
Tokens must be unique within each map and differ from the legacy bearer. HTTP
tokens must differ from every control token. The HTTP map requires a control
map with exactly the same pool IDs. These checks do not print token values.

The Controller selects the tenant's pool once, then selects that pool's runtime
URL and inbound HTTP token together. A selected pool absent from the HTTP map
fails with `503 runner_http_credential_unavailable`; it does not retry using a
default pool, global bearer or another pool's token. This applies to the
default pool as well as additional pools. If a pool's configured URL points at
another pool's service, it still receives the source pool's token and the
destination rejects it. HTTP credentials do not independently authenticate the
destination service; deployment networking and trusted transport still matter.

A Runner with `GUARD_CONTROLLER_HTTP_TOKEN` accepts only that token for its
internal HTTP API. It rejects the global legacy bearer, its outbound control
token, and other pools' inbound tokens. Runtime Endpoint bearer credentials
remain a separate existing boundary. The new inbound token requires a valid
outbound control token and must differ from it and any supplied legacy token.

## Configuration matrix

All optional flags default to false and both maps default to absent.

| Composition | Control/model auth | Internal Runner HTTP auth | Telemetry auth | Legacy secret delivered to Runner |
| --- | --- | --- | --- | --- |
| Legacy defaults | legacy | legacy | legacy | required |
| Pool control map only | pool control token | legacy | legacy | required |
| Pool control + separate HTTP map | pool control token | own inbound HTTP token | legacy | required |
| Pool control + scoped telemetry, no HTTP map | pool control token | legacy | pool control token | required |
| Pool control + separate HTTP + scoped telemetry | pool control token | own inbound HTTP token | pool control token | may be omitted; chart omits it |

Outside the chart, omitting `GUARD_CONTROLLER_TOKEN` is accepted only when the
Runner has a valid control token, a distinct inbound HTTP token, and scoped
telemetry enabled. Supplying an empty legacy environment variable is an error,
even in that composition. The Controller retains its legacy setting for
compatibility and existing derivations; the complete composition avoids
distributing it to Runners. All Controller and Runner flags must agree.

**Scoped telemetry has a deliberate availability limit.** Verified Playground
and [authenticated Endpoint snapshot runtime/cost attribution](endpoint-telemetry-contexts.md)
and routing attribution are supported. Routing and Endpoint events without a matching
archived context remain quarantined to platform visibility. Pool credentials do not authenticate an individual Runner or boot,
so scoped per-Runner watermarks are suppressed. Tenant dashboards omit quarantined
traffic; Router distribution is delayed/unavailable, deletion safety reports
stale telemetry, and database-backed Runner telemetry age is unavailable.
Historical legacy watermarks do not make these checks current. The composition
without a legacy Runner secret is therefore not a production-complete
monitoring mode or a complete load-lab demonstration mode.

## Helm provisioning and rollout

Use existing Kubernetes Secrets provisioned through a secret manager. Do not put
token values in values files. With `default` and `batch` pools, the two
Controller map keys contain the respective JSON maps; each Runner Secret key
contains only its own role's token:

```yaml
security:
  poolAuthentication:
    enabled: true
    scopedTelemetry: false
    controllerSecret: guard-control-map
    controllerKey: pool-tokens.json
    runnerSecrets:
      default: { name: guard-default-control, key: token }
      batch: { name: guard-batch-control, key: token }
  runnerHttpAuthentication:
    enabled: true
    controllerSecret: guard-http-map
    controllerKey: pool-http-tokens.json
    runnerSecrets:
      default: { name: guard-default-http, key: token }
      batch: { name: guard-batch-http, key: token }
```

This example retains legacy telemetry. Setting `scopedTelemetry: true` enables
both Controller and Runner scoped telemetry flags and omits the legacy bearer
from all chart-managed Runner containers when HTTP authentication is also
enabled. Review the visibility limitation above before selecting that mode.

The chart requires exact references for every configured pool, rejects extra
pool references, duplicate role references, missing map references and a Runner
reference to a Controller map key. Inbound HTTP references cannot reuse the
legacy/control references. Secrets may share a Kubernetes object only through
distinct keys. Helm cannot inspect existing Secret contents; Controller and
Runner startup validate the actual values. Externally managed pools require
matching entries in both Controller maps and independent workload provisioning.

1. Provision all map and per-pool role Secrets before changing workloads.
2. Prepare compatible Controller and Runner images and matching map entries for
   all participating pools. Schedule a coordinated maintenance rollout: enabling
   either credential map immediately changes the receiving authentication rule.
3. Restart all relevant workloads with matching settings. Secret-backed
   environment variables do not change inside an already running container.
   Drain/remove old Runner pods that still possess the legacy bearer. Changing
   values alone does not revoke a copied credential or an existing control stream.
4. Verify own-pool success and cross-pool/global/control-token rejection on the
   internal HTTP API, then exercise real tenant dispatch to each selected pool.
   Check the scoped telemetry availability limits when that flag is enabled.
5. Rotate both sides of a role together and restart the affected workloads;
   retain a recovery path for mismatched Secrets. No automatic fallback is used
   when scoped HTTP configuration or authentication fails.

## Evidence and remaining boundaries

- `controller/server/config.test.ts` checks complete maps, role separation,
  malformed values and duplicate/escaped-equivalent keys.
- `controller/server/http/runner-http-pool-routing.test.ts` checks default and
  additional pool selection, unknown pool denial, legacy compatibility and a
  runtime URL mistakenly pointing to a foreign pool.
- `tests/data_plane/test_controller_pool_http_auth.py` builds two real Runner
  ASGI applications through `runner.main.create_app` and verifies evaluation
  and Router path APIs accept only each pool's inbound token. It runs both with
  and without the legacy secret.
- `tests/test_runner_model_config.py` checks partial configuration and the
  complete composition without a legacy secret.
- `tests/contract/test_helm_pool_authentication.py` renders separate Secret
  references, legacy omission and invalid chart configurations.

These tests establish the implemented bearer boundaries, not full workload or
infrastructure isolation. Active data-plane model bindings remain platform-wide;
authorized global provider refs may be available to multiple pools. Existing
shared log-encryption material, metrics configuration and optional Redis have
their own boundaries. A pool token cannot distinguish replicas or compromised
processes within the same pool. Authentication does not fence an old Runner
after reassignment; serving leases and workload/network fencing require their
own verification. TLS, service destination trust, credential revocation and a
coordinated deployed rollout remain operational requirements.
