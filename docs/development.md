# Development Guide

Run TaskLattice Guard from source, execute its test suites, and update generated
contracts. For a complete local Kubernetes installation, use the
[Helm guide](../charts/tali-guard/README.md#orbstacklocal-installation).

## Run from source

Requirements: Python 3.13, uv, Node.js 24, npm, PostgreSQL, and OpenSSL.

```bash
make sync
openssl genpkey -algorithm ED25519 -out /tmp/guard-private.pem
openssl pkey -in /tmp/guard-private.pem -pubout -out /tmp/guard-public.pem
```

Copy [`.env.example`](../.env.example) to `.env` if you do not already have a
local configuration, then configure a local PostgreSQL database matching
`CONTROLLER_DATABASE_URL`. Replace the secret placeholders;
`CONTROLLER_RUNNER_TOKEN` and `GUARD_CONTROLLER_TOKEN` must have the same value.
Use shell-compatible quoting for values containing spaces, for example
`CONTROLLER_BOOTSTRAP_ADMIN_NAME="Local Administrator"`.

The Make targets do not automatically load `.env`. From the repository root,
load it in each backend terminal before starting the process.

Controller terminal:

```bash
set -a
. ./.env
set +a
make controller-dev
```

Runner terminal:

```bash
set -a
. ./.env
set +a
make runner-run
```

Start the UI in a third terminal:

```bash
npm run dev:ui --prefix controller
```

Open [the development UI](http://localhost:8092); Vite proxies API requests to Controller on port
8080. Alternatively, run `npm run build:ui --prefix controller` and use
[Controller's static UI](http://localhost:8080).

Controller runs database migrations and idempotently creates the bootstrap
administrator through Better Auth. With the example local configuration, sign
in as `admin` / `admin`; the corresponding internal Better Auth email is
`admin@tasklattice.local`.

## Tests and generated contracts

The [Makefile](../Makefile) separates `test-control-plane`, `test-data-plane`,
`test-e2e` (Controller/Runner communication), and `test-contracts`. The aggregate
target also typechecks and builds Controller:

```bash
make test
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
make proto-generate
make proto-check
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
