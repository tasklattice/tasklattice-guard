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

## Console design language: Carbon

The desktop console uses Carbon's productive UI language. `controller/src/design-system.scss`
imports the installed Carbon g10 theme and maps its semantic tokens to the shared
UI primitives and the existing console shell. `controller/src/styles.css` defines locally
hosted IBM Plex Sans / IBM Plex Mono with Noto Sans SC for Chinese. Keep the
TaskLattice brand and domain terminology.

- Use the g10 canvas, white content layers, neutral separators, and square controls.
  Reserve shadows for overlays, not ordinary content cards.
- Use a 32px regular-weight page title, 14px UI text, the existing 64px shell header, a 252px
  expanded sidebar and 72px collapsed sidebar, and 8px spacing increments. Default controls are 40px; dense controls
  may be 32px. Keep visible keyboard focus and preserve existing accessible names.
- Center button labels and inline icons together, with symmetric inline padding;
  do not reserve trailing-icon space for buttons that use inline children.
- Blue identifies the primary operation. Editing is an operation, not a warning.
  Use warning, danger, and success colors for actual domain states and keep a text
  label alongside status color. Risk severity, requested action, and execution
  status remain separate concepts.
- Shared controls in `controller/src/components/ui` compose native `@carbon/react`
  components: Button, TextInput/TextArea, Dropdown/ComboBox/FilterableMultiSelect,
  Checkbox/Toggle, Tabs, DataTable primitives, OverflowMenu, and notifications.
  Add new controls here rather than adding another component library. Native Select is used for short HTML-form option lists.
- Preserve the existing application shell layout and interaction contracts. The
  brand belongs in the sidebar header and collapses to its icon; the toggle stays
  in the content header, before the breadcrumbs. Keep navigation indentation,
  group spacing, footer links, edge-rail toggle and Ctrl/Cmd+B shortcut. Hovering
  must not expand a collapsed sidebar. Carbon visual migration does not replace
  this shell with Carbon Header/SideNav/Content. Resource forms and
  side-effect confirmations open in the existing right-side, full-height drawers
  (`EntitySheet` / `ConfirmationSheet`), with a scrollable body and fixed actions.
  Do not convert them to centered modals as part of a design-system migration.
  Retain focus trapping/restoration, nested drawers, cancellation, pending-close
  protection, and explicit confirmation before writes. Keep wizard keyboard
  navigation and step-gating behavior. Carbon styles do not override these rules.
  The drawer keeps its proven Radix Dialog behavior with Carbon form controls.
  Dropdowns use floating positioning inside drawers; Escape closes the open
  dropdown before the drawer. Preserve existing interaction test assertions;
  adapting component selectors must not weaken behavior or layout contracts.
- Query Builder, routing diagrams, charts, code/diff editors, and the conversation
  engine remain domain components. Their controls, typography and surfaces share
  the Carbon system; do not replace domain behavior with visual mockups.
- Use the focused `@radix-ui/react-dialog` and `@radix-ui/react-slot` primitives
  for the existing drawer, sidebar and wizard interaction contracts. The umbrella Radix,
  shadcn and Sonner dependencies are removed. Global toasts use the shared Carbon
  notification service.
- Import only used native Carbon component styles, not a second global reset.
  The Security Events toolbar uses `@carbon/react` through `EventFilterToolbar`
  with a white local layer under `.guard-carbon`. Reuse it for matching filters.
  Risk filters are multi-select and URL-backed; filtering happens before cursor
  pagination, while option counts cover the selected time range.
- Check default, focus, selected, disabled, empty, and error/recovery states at
  desktop widths in both languages. Honor reduced-motion preferences.

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

## Catalog-independent Artifact compilation

`runner.toolkit.compiler.artifact.ArtifactCompiler` compiles a frozen
`CompileRequest` without starting a Runner, connecting to Controller, loading
Policy Library, or leasing model credentials. `runner/compiler.py` is the Runner
adapter: it captures the active target model capabilities and delegates to this
compiler. Draft validation, preview, and release use the same compilation path.

The input must contain all selected local Policy definitions and exact versions,
Rule parameters, and programmable Policy source snapshots. A Policy ID alone is
rejected at compilation and runtime loading; there is no catalog fallback. The
result embeds the frozen definitions, generated Colang, prompts, Action bindings,
and dependency manifest under the Artifact checksum. Updating or removing the
authoring Library cannot change that content.

For an offline build, save a `CompileRequest` using the Protobuf JSON format from
`proto/tasklattice/guard/control/v1/artifact.proto`, then run:

```bash
.venv/bin/python -m runner.toolkit.compiler \
  --request compile-request.json --output guardrail.artifact.pb
```

Use `--format json` for an inspectable Protobuf JSON result. `--model-type
topic_control` declares support for the dedicated native topic model without an
endpoint or credential. `--prompts prompts.yml` supplies a pinned template
catalog; omission uses the versioned templates bundled with the compiler.

The output is an **unsigned Artifact**, not an activated deployment. Controller
still owns signing, distribution and route publication. The execution environment
must supply the matching TaskLattice/NeMo runtime and declared model capabilities;
model endpoints, credentials and weights remain deployment concerns. The generic
local detectors, Rule expansion and snapshot decoding live in
`runner/toolkit/policy_runtime/`, independently of the authoring Library.

### Export a published Guardrail

In **Guardrails → row Actions → Export**, download the current published version
as `<guardrail-id>-<version>.artifact.json`. Unpublished draft edits are excluded;
publish a version first if none exists. Downloads do not recompile or query Policy
Library. The signed Artifact contains the frozen Policy implementations, NeMo
configuration, Colang, prompts, bindings, dependency versions, checksum and signature.

The authenticated, read-scoped API also supports explicit historical versions:
`GET /api/v1/guardrails/{id}/versions/{version}/export`. It returns the
`tasklattice.guard.control.v1.Artifact` Protobuf JSON contract as an attachment.
Read it directly with `google.protobuf.json_format.Parse(text, protocol.Artifact())`;
the checksum and signature remain unchanged. Versions without complete Policy
snapshots must be published again before export. No live model configuration,
credentials, model weights, Router assignments or request logs are included.

An export still requires the matching TaskLattice/NeMo runtime and model capabilities.
It does not publish into another Controller; an import workflow and
content-addressed incremental distribution are separate work. Trust the source
Controller's signing public key through a separate trusted channel before loading.

The independence contract tests physically omit `policy_library/` in fresh
processes, reproduce the checked-in Artifacts, and exercise health endpoints and
input/output requests through the real Runner.

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
