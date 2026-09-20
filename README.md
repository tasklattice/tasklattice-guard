# TaskLattice Guard

**Configurable input and output protection for AI applications and gateways.**

TaskLattice Guard helps teams control what reaches their AI models and what
comes back to users. It checks prompts and responses against your policies,
then returns an allow, block, or text-replacement result for your application
or gateway to apply.

It combines a web console for designing, testing, and publishing protection
with a runtime API for checking live traffic—including streamed responses.
Teams can manage different protection configurations for different applications
without embedding policy logic in every gateway.

## What you can do

- **Protect prompts and responses.** Check for sensitive data, prompt injection,
  harmful content, and application-specific restrictions using configurable
  local rules and model-backed checks.
- **Build and test your own protection.** Compose versioned Policies into a
  Guardrail, tune rules and actions, and validate changes before publishing.
- **Route traffic to the right Guardrail.** Match request characteristics such
  as headers or model names, then distribute matching calls across Guardrail
  versions with configurable percentages.
- **Try changes before enforcing them.** Use Playground to inspect behavior,
  or integrate in dry run so your gateway observes results without changing
  the application response.
- **Understand what happened.** Inspect runtime decisions, routing distribution,
  validation results, and publication history in the console.

The included Default Guardrail provides local checks without a detection-model
setup. Model-backed protection can be configured separately. Coverage depends
on the policies you enable and the content you submit; streamed output may
need to be buffered when a policy requires the complete response.

## How it fits into your application

Your application or gateway calls Guard before sending input to a model and
before delivering its output. Guard checks the content; your integration applies
the returned decision.

```text
Your application or AI gateway
  ├─ Check input with Guard → apply the decision → call your model
  └─ Check model output with Guard → apply the decision → deliver to the user
```

Three concepts connect configuration to live traffic:

| Concept | Purpose |
| --- | --- |
| **Guardrail** | The protection to apply: selected Policies, settings, and a published version |
| **Router** | The routing configuration: which requests match each Route and which Guardrail versions receive them |
| **Endpoint** | The runtime integration identity: a base URL and credential, bound to a Router |

A typical workflow is to configure and validate a Guardrail, publish it, create
an Endpoint and bind it to a Router, then review and publish the routing
configuration. Use Playground and the integration guide's verification examples
to check the path before sending application traffic.

Guard has two application components: **Controller** hosts the console and
management API; **Runner**, powered by NVIDIA NeMo Guardrails, executes checks.
Live Endpoint checks call Runner directly. See [architecture](docs/architecture.md)
for the implementation and deployment boundaries.

## Try it locally

With this repository checked out, enable OrbStack Kubernetes and have Docker,
Helm, `kubectl`, and `make` available. From the repository root, run:

```bash
npm run helm:deploy:dev
```

This builds the local images, installs or upgrades the development deployment,
and waits for workload readiness. Open [the console](http://localhost:38081)
and sign in with `admin` / `password`. These credentials belong to the local
profile only; an existing account keeps its password if you have changed it.
The local profile uses Token-authenticated gRPC without mTLS. A chart bootstrap
Job creates internal Secrets, so no External Secrets operator or private key in
Values is required.

Start with the Default Guardrail to explore local protection, then configure
model-backed checks as needed. See the [local installation guide](charts/tali-guard/README.md#orbstacklocal-installation)
for service addresses and deployment status.

Prefer to run the services from source? Follow the
[development guide](docs/development.md). For a shared or production environment,
use the [production deployment guide](charts/tali-guard/README.md#production-installation).

## Documentation

| I want to… | Guide |
| --- | --- |
| Integrate an application or gateway | [Runtime API, streaming, dry run, and verification](docs/gateway-integration.md) |
| Configure protection and validation | [Policies, the Default Guardrail, and execution order](docs/guardrail-policies.md) |
| Connect models for protection checks | [Providers, Models, and Guardrail Catalog](docs/model-configuration.md) |
| Route traffic across Guardrails | [Routes, selectors, and weighted distribution](docs/router-route-weighted-distribution-design.md) |
| Test a Router or Endpoint | [Playground advanced path testing](docs/playground-advanced-mode.md) |
| Publish, restore, or delete versions | [Revision lifecycles](docs/revision-lifecycle.md) |
| Automate management operations | [Controller API conventions](docs/api-contract.md) and [Access Tokens](docs/account-access-tokens.md) |
| Deploy and operate Guard | [Helm deployment](charts/tali-guard/README.md), [operations and security](docs/operations.md), and [observability](observability/README.md) |
| Develop or understand the internals | [Development and tests](docs/development.md) and [architecture](docs/architecture.md) |

A running Controller also serves an interactive API reference at `/api/docs`,
its OpenAPI contract at `/api/openapi.json`, and an agent-oriented index at
`/api/llms.txt`. These describe the management API; application checks use the
separate runtime integration guide above.
