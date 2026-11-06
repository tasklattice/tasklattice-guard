# Start here: learning the code

Read this guide in order. Start with steps 1–3, then trace one UI request and one
runtime check. You do not need to read the whole `docs/` directory first.

## 1. Keep this picture in mind

```text
Browser UI (React/TypeScript)
       │ management HTTP
       ▼
Controller backend (Node.js/TypeScript) ── PostgreSQL
       ▲
       │ Runner-initiated gRPC: configuration, compilation, acknowledgements
       ▼
Runner (Python/FastAPI + NeMo) ── local execution state / Redis
       ▲
       │ runtime checks
Application or LiteLLM gateway ── application generation model
```

The Controller manages configuration and distributes executable state. The
Runner checks live content. The application/gateway applies the returned
allow/block/replacement decision and calls the generation model. Some Rules
make Runner call detection models; those are distinct from the application
generation model.

Four product terms are enough initially:

| Term | Meaning |
| --- | --- |
| Policy | A reusable definition containing Rules and tests |
| Guardrail | A configured composition of Policies, published as a version |
| Router | Rules selecting a published Guardrail version for a request |
| Endpoint | The integration identity and credential bound to a Router |

Management changes and live checks follow different paths. A live Endpoint
check uses the Runner's synchronized state; it does not fetch its configuration
from the Controller database on every request.

## 2. Understand the folders and TypeScript

`controller/` is the **entire management application**, including both its web
frontend and backend. TypeScript is used for both. Python is used for Runner
execution; there is no current Python Controller hidden in `app/`.

| Location | Runs where / what to read |
| --- | --- |
| [`controller/src/main.tsx`](controller/src/main.tsx) | React browser entry point |
| [`controller/src/app-router.tsx`](controller/src/app-router.tsx) and `src/routes/` | Browser pages and navigation |
| [`controller/src/lib/`](controller/src/lib/) | Browser API clients and supporting logic |
| [`controller/server/index.ts`](controller/server/index.ts) | Node backend entry point: database, services, auth, gRPC and HTTP |
| [`controller/server/http/app.ts`](controller/server/http/app.ts) | Management API routes and middleware |
| `controller/server/services/` and `server/db/` | Backend behavior and persisted state |
| [`controller/shared/`](controller/shared/) | Contracts, validation schemas and types used across the management application; not another service |
| [`controller/src/cli/guardctl.ts`](controller/src/cli/guardctl.ts) | Separate Node management CLI; this part of `src/` is not browser code |
| [`runner/main.py`](runner/main.py) | Python Runner application composition and startup |
| [`runner/toolkit/`](runner/toolkit/) | Compiler, runtime abstractions, NeMo integration and detectors |
| [`policies/`](policies/) | Authorable YAML Policy packages, Rules and tests |
| [`proto/`](proto/) | Controller/Runner protocol definitions |
| `charts/`, `Dockerfile.*`, `scripts/` | Deployment, packaging, developer commands and test helpers |

`.ts` means TypeScript; `.tsx` permits JSX markup for React components. The
extension alone does not tell you whether code runs in a browser or Node: use
the folder and entry point above.

Production builds produce JavaScript:

```text
controller/src/main.tsx → Vite → controller/dist/                  browser assets
controller/server/*.ts → tsc  → controller/dist-server/server/    Node backend
controller/src/cli/    → build-guardctl → dist-cli/guardctl.cjs    Node CLI
```

For example, the backend runs `node dist-server/server/index.js`. Development
uses `tsx` for the server. An import such as `from './config.js'` in a `.ts`
source file is intentional: the project's NodeNext setup uses the JavaScript
extension that exists after compilation. Read `config.ts` in the source tree.

Top-level `controller/vite.config.ts`, `vitest.config.ts` and `drizzle.config.ts`
configure frontend tooling, tests and database migrations. They are not extra
application servers. Files ending `.test.ts` or `.test.tsx` are tests.

Leave `dist/`, `dist-server/`, `dist-cli/`, `node_modules/`, `*.tsbuildinfo`,
generated protocol bindings and OpenAPI JSON until you need their build process.
`.d.ts` files declare types; some are generated and some are handwritten.

To list source files while respecting the repository's ignore rules:

```sh
rg --files controller runner policies proto
```

## 3. Read a small Policy before the execution engine

Open [`policies/examples/customer-information/policy.yaml`](policies/examples/customer-information/policy.yaml),
then its two Rule files and [`tests/acceptance.yaml`](policies/examples/customer-information/tests/acceptance.yaml).
It is small enough to predict the behavior without reading the compiler.

For example, [`rules/customer-id.yaml`](policies/examples/customer-information/rules/customer-id.yaml)
contains this actual Rule excerpt:

```yaml
stages:
- output
detector:
  ref: text/regex
  version: 1.0.0
  parameters:
    expression: \bCUS-\d{6}\b
on_match:
  action: transform
  replacement: '[客户编号已隐藏]'
```

The acceptance example expects `CUS-123456` to be replaced in output. The
second Rule blocks the `INTERNAL_SECRET` marker. This teaches detection,
direction, action and expected results before introducing model configuration.
Both example Rules target output, which also explains why input/output phase matters.

## 4. Follow one UI read from browser to database

Use the Endpoints page. Search for these symbols rather than reading each
large file from top to bottom:

```text
controller/src/routes/endpoints.tsx
  → src/lib/endpoints-api.ts: getEndpoints
  → src/lib/controller-api.ts: listControllerEndpoints / requestController
  → server/http/app.ts: GET /api/v1/endpoints
  → server/services/control-plane.ts: listEndpoints
  → server/db/schema.ts: endpoints
```

The backend route is short:

```ts
app.get("/api/v1/endpoints", authenticated, async (context) => {
  const items = await input.service.listEndpoints();
  return context.json({ items: await Promise.all(items.map(item => withDistribution(item, context))) });
});
```

Notice that the UI client and the backend handler are separate TypeScript code.
The service's database query applies `resourceReadPredicate`, which becomes
important when you reach multi-tenancy.

## 5. Follow one live protection check through Python

First skim the wiring in [`runner/main.py:create_app`](runner/main.py). Then
read this function chain:

```text
runner/api.py: apply_litellm_guardrail
  → authenticate Endpoint and acquire admission permit
  → toolkit/runtime/service.py: GuardrailRuntimeService.evaluate
      → _resolve_call
          → artifact_store.py: ArtifactStore.resolve
              → routing.py: select
      → _evaluate_online / _evaluate_resolved
          → toolkit/nemo/runtime.py: NeMoRuntime.evaluate
  → map the decision back to the integration response
```

Start at the route:
`/runtime/v1/endpoints/{endpoint_id}/beta/litellm_basic_guardrail_api`.
It determines input/output direction, checks the credential, handles admission
rejection, converts the request and calls the runtime. Deeper NeMo/action
implementations can wait until you understand that outer contract.

Read the existing test
[`test_litellm_basic_guardrail_api_normalizes_and_maps_the_runtime_contract`](tests/test_runner_api.py)
beside the route. A narrow local command is:

```sh
.venv/bin/python -m pytest -q tests/test_runner_api.py \
  -k litellm_basic_guardrail_api_normalizes_and_maps_the_runtime_contract
```

## 6. Learn how configuration reaches the Runner

Now return to [`controller/server/index.ts`](controller/server/index.ts), then:

1. `server/domain/guardrail-plan.ts: buildGuardrailPlan` assembles executable configuration.
2. `server/services/control-plane.ts: requestGuardrailPublish` freezes publication inputs and obtains a compiled artifact.
3. `runner/toolkit/compiler/artifact.py: ArtifactCompiler.compile` and `server/domain/artifact-content.ts` explain compilation, digest and signature.
4. `server/control-channel/control-server.ts` and `runner/control_client.py` distribute configuration and process acknowledgements.
5. `runner/artifact_store.py` verifies and activates the state used by step 5.

Publication does not require passing tests. Current code can compile an untested
draft or reuse a compatible frozen candidate, including a failed test candidate.
Publishing a Guardrail also does not automatically switch a Router to that version.
See the publication regression cases in
[`guardrail-publication.postgres.test.ts`](controller/server/services/guardrail-publication.postgres.test.ts).

## 7. Add multi-tenancy after the normal path is clear

Follow [`tenant-context.ts`](controller/server/services/tenant-context.ts) for
trusted request identity and resource filters, then
[`tenant-groups.ts`](controller/server/services/tenant-groups.ts) and
[`tenant-group-routing.ts`](controller/server/services/tenant-group-routing.ts)
for group/pool placement. Continue into control-channel authentication and
[`runner/tenant_admission.py`](runner/tenant_admission.py) for execution admission.
Read related tests alongside these files. Group membership does not grant
access to another tenant's private Endpoints or Routers.

Streaming, lease/fencing protocols, advanced model configuration and report
storage are later branches; they are not prerequisites for understanding one check.

## Which documents to use

Initially use only this guide, the README's product concepts, and
[`docs/gateway-integration.md`](docs/gateway-integration.md) when you want the
runtime request/response details. For the actual running environment, use
[`docs/local-k8s-runtime-2026-11-05.md`](docs/local-k8s-runtime-2026-11-05.md).

`docs/document/` contains the product help articles shown in the portal.
The current lab also has a standalone fake model in sibling
`../tasklattice-fake-llm` and external LiteLLM gateways. They are test/integration
services; read their deployment details after the core flow above.

For deeper code excerpts, use [`project-walkthrough.md`](docs/project-walkthrough.md).
The [multi-tenancy status](docs/multi-tenancy-status.md) is the single current
checkpoint for implemented behavior, remaining milestones and rollout limits.
Other `docs/` files are focused feature or operator references; read them when
you reach the corresponding feature. Superseded deployment and progress reports
have been removed.

## What the cache-only folders were

The old top-level `app/` and `web/` source trees were removed during the
Controller/Runner split in commit `1551ccad` on 21 August 2026. Git ignored their
local generated leftovers, so those directories remained on this checkout.

The 5 November 2026 audit found:

| Location before cleanup | Finding |
| --- | --- |
| `app/` | 67 orphan `.pyc` files, no source, approximately 1.02 MiB |
| `web/` | Only ignored old `node_modules`, approximately 157 MiB; not today's UI |
| `runner/` caches | 147 files with current Python source counterparts; 4 older source-filename remnants |
| `tests/` caches | 192 files with source counterparts; 14 older source-filename remnants |

The obsolete top-level trees and the 18 orphan Runner/test cache files were
removed after checking their source paths and runtime references. The temporary
archive was also removed. Current source, installed dependencies and running
containers were preserved.

`__pycache__` contains generated Python bytecode, not an alternative source
implementation. In this repository's layout, normal Python imports ignore an
orphan cache when its corresponding `.py` file is absent. Current Runner/test
caches often correspond to active code and can be regenerated; their existence
does not indicate unused business logic. An old `pii.pyc` may remain after the
implementation became a `pii/` package, for example.

The actual Runner image copies `runner/`, starts `runner.main:app`, and excludes
host caches from its build context. The Python wheel also packages `runner`.
The `app` in `runner.main:app` is a FastAPI object inside `runner/main.py`,
not the obsolete top-level `app/` package.
The running Kubernetes Pods do not mount this checkout as application source.
