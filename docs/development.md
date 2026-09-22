# Development Guide

Run TaskLattice Guard from source, execute its test suites, and update generated
contracts. For a complete local Kubernetes installation, use the
[Helm guide](../charts/tali-guard/README.md#orbstacklocal-installation).

## UI platform scope

The Controller console targets **desktop browsers only**. Future features and
fixes do not require phone/mobile layout compatibility, touch-specific interaction
support, mobile screenshots or mobile regression acceptance. See the
[design contract](protection-productization.md#platform-scope-desktop-only).

Continue verifying desktop primary/error/recovery paths, keyboard accessibility,
focus, browser zoom and layout at desktop window sizes. Existing mobile styles
and historical tests may remain; this is a scope change, not a request to remove
working code. Feature-specific QA instructions must follow this desktop-only scope.

## Run from source

Requirements: Python 3.13, uv, Node.js 24+, npm, and PostgreSQL.

Run commands from the repository root. The root `package.json` is the command
entry point, following Relay's `dev:*`, `test:*`, `images:*`, and `helm:*` naming.
Controller keeps its own lockfile; `npm run sync` installs both Python and
Controller dependencies without restructuring their dependency trees.

```bash
npm run sync
npm run dev:setup
```

`dev:setup` creates or completes the ignored root `.env`, generates local
Ed25519 keys under `.local-secrets/`, and generates random internal tokens.
Existing credentials and signing keys are preserved across repeated runs.
It does not start PostgreSQL or connect to Kubernetes. Configure a reachable
PostgreSQL database in `CONTROLLER_DATABASE_URL` before starting Controller.
The default is `postgresql://guard:guard@localhost:5432/guard`.

Start each service in a separate terminal:

```bash
npm run dev          # Controller watch mode; alias of dev:controller
npm run dev:runner   # Runner
npm run dev:ui       # Vite UI on port 8092
```

These development commands automatically load the root `.env`; exported shell
variables take precedence. No `source .env` is required. Controller-specific
file paths resolve from `controller/`; Runner paths resolve from the repository
root. The setup command writes absolute paths for generated keys.

Open [the development UI](http://localhost:8092); Vite proxies API requests to
Controller on port 8080. Set `CONTROLLER_DEV_PROXY` in `.env` for another backend.
Alternatively build and start Controller with the static UI:

```bash
npm run build       # Controller UI + server
npm start
```

Controller runs database migrations and creates the bootstrap administrator
only if absent. New local accounts initialized by `dev:setup` use `admin` /
`password`, stored as a salted Better Auth hash. Existing accounts are not reset.
For a complete local Kubernetes stack, use `npm run helm:deploy:dev` instead;
that deployment initializes credentials inside Kubernetes independently.

| Task | Root command |
| --- | --- |
| Build both development images | `npm run images:build:dev` |
| Deploy local Helm release | `npm run helm:deploy:dev` |
| Deploy with performance diagnostics | `npm run helm:deploy:dev:debug` |
| Render local chart | `npm run helm:template` |
| Inspect / test release | `npm run helm:status` / `npm run helm:test` |
| Uninstall release | `npm run helm:delete:dev` |
| Package chart | `npm run helm:package -- 0.2.5` |

Helm commands accept `HELM_CONTEXT`, `HELM_NAMESPACE`, `HELM_RELEASE`,
`HELM_DEV_VALUES`, and `HELM_TIMEOUT` as environment variables. For example:
`HELM_NAMESPACE=guard-dev npm run helm:deploy:dev -- --values ./values-local.yaml`.
The default context/namespace are `orbstack` / `tali`. Additional flags after
`--` reach Helm as separate arguments. Make targets remain compatibility aliases
only; new workflows should use npm. Legacy `HELM_VALUES_ARGS` is replaced by
explicit arguments after `--`.

## Tests and generated contracts

The root [package.json](../package.json) separates `test:control-plane`,
`test:data-plane`, `test:e2e` (Controller/Runner communication), and
`test:contracts`. The aggregate command also tests the CLI helpers, typechecks,
and builds Controller:

```bash
npm test
```

In addition to development dependencies, the contract checks require Helm and
jq. Database/Redis integration tests are opt-in and are skipped unless their
environment variables are set to dedicated test services:

| Variable | Tests |
| --- | --- |
| `GUARD_TEST_POSTGRES_URL` | PostgreSQL model configuration, tokens, Policy publication, routing, and migration tests |
| `TEST_DATABASE_URL` | PostgreSQL runtime-observability tests |
| `GUARD_TEST_REDIS_URL` | Real Redis stream and replica tests; use an isolated loopback Redis |

A successful run without these settings does not cover those integration tests.
See [CI](../.github/workflows/ci.yml) for the automated job configuration.

Controller/Runner gRPC messages are defined under
`proto/tasklattice/guard/control/v1/`. After changing a protocol file, regenerate
the checked-in Python and TypeScript bindings and verify them with:

```bash
npm run proto:generate
npm run proto:check
```

The gRPC envelopes use typed business messages, with explicitly documented
opaque text and JSON diagnostic fields. Telemetry, credential resolution, and
Playground also use separate HTTP APIs. See
[the control protocol](architecture.md#control-protocol) for contract
ownership and extension rules.

## Controller API reference

The Controller serves a code-generated OpenAPI 3.1 contract at `/api/openapi.json`,
a browsable reference at `/api/docs`, and a compact agent index at `/api/llms.txt`.
Use `?module=routers` or `?operationId=postRoutersByIdPublish` on the JSON endpoint
to retrieve a complete subset with its referenced schemas and token permissions.

Run `npm run openapi:generate --prefix controller` after API changes and commit
[the generated contract](../controller/openapi/controller.openapi.json). CI and server
builds run `npm run openapi:check --prefix controller` to reject stale documents.
See [the API contract conventions](api-contract.md)
for product tags, resource paths, authentication, idempotency, and retry behavior.

The Controller API manages configuration and accounts. Applications and gateways
use the separate [Runner integration protocol](gateway-integration.md) for
Input, Output, and streaming checks.
