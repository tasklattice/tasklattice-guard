# Start here: learning the code

Read steps 1–3 first, then trace one management request and one runtime check.
This guide follows the current upstream Project and Keycloak model.

## 1. Keep the two application components clear

```text
Browser UI (React/TypeScript)
       │ management HTTP
       ▼
Controller (Node.js/TypeScript) ── PostgreSQL
       │ configuration / compilation / acknowledgements over Runner-initiated gRPC
       ▼
Runner (Python/FastAPI + NeMo) ── executable state / Redis
       ▲
       │ runtime checks
Application or gateway ── application generation model
```

Controller manages identity, Projects, configuration, publication and evidence.
Runner checks live content using synchronized executable state. The application
or gateway applies the returned decision and calls its generation model. Some
protection Rules call detection models; these are separate from application
text generation.

A Policy contains reusable Rules; a Guardrail composes Policies into a version;
a Router selects a published Guardrail version; an Endpoint supplies the runtime
integration identity and credential. A Project owns application resources. A
human User can belong to several Projects through membership.

## 2. Read the folder map

| Source | What runs there |
| --- | --- |
| [controller/src/main.tsx](controller/src/main.tsx), [app-router.tsx](controller/src/app-router.tsx), `src/routes/` | React browser entry and pages |
| [controller/src/lib/](controller/src/lib/) | Browser API clients and Project selection |
| [controller/server/index.ts](controller/server/index.ts) | Node backend startup: database, identity, services, gRPC and HTTP |
| [controller/server/http/app.ts](controller/server/http/app.ts) | Management API and authority middleware |
| `controller/server/services/`, `server/db/` | Backend behavior and PostgreSQL schema |
| [controller/shared/](controller/shared/) | Shared contracts and validation schemas |
| [controller/src/cli/guardctl.ts](controller/src/cli/guardctl.ts) | Node management CLI |
| [runner/main.py](runner/main.py) | Python Runner composition and startup |
| [runner/toolkit/](runner/toolkit/) | Compiler, execution abstractions, NeMo integration and detectors |
| [policies/](policies/) | Authorable Policy YAML, Rules and test cases |
| [proto/](proto/) | Controller/Runner transport contracts |
| `charts/`, `Dockerfile.*`, `scripts/` | Deployment, packaging, developer and test tools |

`controller/` contains both the management frontend and backend. `.tsx` allows
React JSX; `.ts` alone does not identify the runtime. Source imports ending
`.js` are intentional under NodeNext: read the matching `.ts` source.
Production builds emit browser assets, server JavaScript and the separate CLI.
Generated output and `node_modules/` are not the source-reading starting point.

## 3. Start with a small Policy

Read [the customer-information example](policies/examples/customer-information/policy.yaml),
its Rule YAML files and [acceptance cases](policies/examples/customer-information/tests/acceptance.yaml).
Predict the input/output direction, detection, allow/block/transform action and
expected replacement before opening the execution engine.

## 4. Trace one browser read

```text
controller/src/routes/endpoints.tsx
  → src/lib/endpoints-api.ts
  → src/lib/controller-api.ts
  → server/http/app.ts: GET /api/v1/endpoints
  → server/services/control-plane.ts: listEndpoints
  → server/db/schema.ts
```

The service applies `resourceReadPredicate` from
[project-context.ts](controller/server/services/project-context.ts). Browser
Project selection does not by itself grant authority: server-side membership
and account checks constrain resource reads and writes.

## 5. Trace one live check

Read [runner/main.py](runner/main.py), then follow:

```text
runner/api.py: apply_litellm_guardrail
  → Endpoint authentication
  → toolkit/runtime/service.py: GuardrailRuntimeService.evaluate
  → artifact_store.py: ArtifactStore.resolve / routing.py
  → toolkit/nemo/runtime.py: NeMoRuntime.evaluate
  → integration response
```

The LiteLLM callback begins at
`/runtime/v1/endpoints/{endpoint_id}/beta/litellm_basic_guardrail_api`.
Read its tests in [test_runner_api.py](tests/test_runner_api.py) beside the route.
Runner uses synchronized state for ordinary production checks; it does not read
Controller's PostgreSQL database for every check.

## 6. Follow publication and distribution

Continue with `buildGuardrailPlan` in
[guardrail-plan.ts](controller/server/domain/guardrail-plan.ts), publication in
[control-plane.ts](controller/server/services/control-plane.ts), compilation in
[runner/toolkit/compiler/](runner/toolkit/compiler/), and distribution in
[control-server.ts](controller/server/control-channel/control-server.ts) and
[control_client.py](runner/control_client.py).

Publishing freezes and compiles configuration independently of test outcomes.
Model availability, Runner readiness and Router traffic changes remain separate.
See [revision lifecycles](docs/revision-lifecycle.md) and publication regressions.

## 7. Read Projects, identities and placement

Use the [Projects, users and SSO guide](docs/document/en/admin/03-platform-access.mdx),
then [projects.ts](controller/server/services/projects.ts),
[project-context.ts](controller/server/services/project-context.ts),
[project-groups.ts](controller/server/services/project-groups.ts) and
[project-group-routing.ts](controller/server/services/project-group-routing.ts).
See [Project multi-tenancy](docs/multi-tenancy.md) for feature coverage, open
gaps and the deployment acceptance checklist.
Projects own resources; runtime groups and pools allocate execution capacity.
A dedicated Runner uses the canonical immutable Project name in its instance ID.

Administrators create Projects, memberships and Runner connections through the
current console. SSO uses the existing OIDC/Keycloak integration and a dedicated
Guard client; Group Paths synchronize membership at sign-in. Follow the access
guide for required claims, callback URL, roles and revocation behavior. A Project
or pool record does not create its workload. Helm installs the default Runner;
additional Runner workloads are managed separately. The fresh schema baseline
requires reinitializing older development databases.

## Run and test

Use [development and tests](docs/development.md) for source setup, or the
[current Helm installation](charts/tali-guard/README.md#orbstacklocal-installation)
for Kubernetes. [Architecture](docs/architecture.md),
[database diagrams](docs/database-er.md) and
[runtime integration](docs/gateway-integration.md) are focused follow-up reads.

[Standalone external demo tools](docs/tenant-load-lab.md) consume manually
configured Projects, credentials and gateway/Runner addresses. They are separate
operator tools. The [5 November local runbook](docs/local-k8s-runtime-2026-11-05.md)
is a historical pre-rebase deployment record, including its original screenshots;
it does not describe the current console or provisioning workflow.
