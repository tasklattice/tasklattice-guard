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
- Blue identifies create, edit, and publish operations. Test actions use the shared
  yellow `testing` button variant. Keep adjacent actions at the same Carbon size.
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
Signing keys and internal tokens survive repeated runs. Bootstrap usernames and
passwords reset to `admin` / `password` and `user` / `password`; Controller
initialization overwrites these accounts and revokes their previous sessions.
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

Controller runs database migrations and creates missing bootstrap accounts.
`dev:setup` initializes `admin` / `password` with the admin role and `user` /
`password` with the user role, using separate salted Better Auth hashes.
Existing passwords and roles are not reset.
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
All Guard development commands use `charts/tali-guard/values-dev-uat.yaml`.
The default release/context/namespace remain `tali-guard` / `orbstack` / `tali`,
with UI/runtime ports 38081/38082. The debug command uses this same file plus
telemetry flags; its backend defaults can be changed with `HELM_OTLP_ENDPOINT`,
`HELM_PYROSCOPE_ADDRESS` and `HELM_MONITORING_RELEASE`. Additional flags after
`--` reach Helm as separate arguments. Make targets remain compatibility aliases
only; new workflows should use npm. Legacy `HELM_VALUES_ARGS` is replaced by
explicit arguments after `--`.

## LiteLLM integration stack

The `litellm-generic-guardrail` adapter can be exercised end to end against a
real LiteLLM proxy carrying the TaskLattice Guard Provider. The Provider lives in
[tasklattice-litellm-guard](https://github.com/tasklattice/tasklattice-litellm-guard),
which publishes `ghcr.io/tasklattice/tali-litellm:<litellm>-guard.<n>`; this
repository carries no copy of it. `charts/tali-litellm-dev/values.yaml` pins the
tag, and the deploy command refuses an image whose
`io.tasklattice.guard.output-stream-protocol` label differs from
`OUTPUT_STREAM_PROTOCOL_VERSION` in `runner/output_streaming.py`.

```bash
npm run helm:deploy:dev-with-litellm   # tali-guard + LiteLLM + mock model, then smoke test
npm run litellm:deploy:dev             # LiteLLM only, against an existing tali-guard release
npm run litellm:smoke                  # allowed, blocked-output and streaming calls
npm run litellm:delete:dev
```

The stack is deployed from the test-only chart `charts/tali-litellm-dev`; it is
not part of the product chart and `npm run helm:deploy:dev` never installs it.
See [the chart README](../charts/tali-litellm-dev/README.md) for wiring details,
ports, and switching the synthetic echo model to a real provider.

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
compiler. Draft validation and preview use the same compilation path; a passed
test run returns its exact candidate Artifact, and publishing signs that content
without compiling again.

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

### Promote a Guardrail between environments

UAT authors and tests; production receives released versions, runs their own
test suites unchanged and releases them. The design
is `docs/guardrail-self-contained-promotion-design.zh-CN.md`.

**Export.** **Guardrails → Actions → Export…** (or a version's **Export…**)
selects immutable versions and downloads one `.guardrail.zip`. No source ID,
package signing key, trust file or Runner check is required. Pending imported
versions can be exported immediately, without local reports or release.

Format v4 contains a SHA-256 manifest, frozen Policy definitions, Guardrail
configuration, Artifacts, runtime requirements and Test Cases. Test reports,
credentials and model settings are not included. Legacy v3 packages remain
readable; their source signatures are metadata, not authenticated identities.
Archive limits, file digests and semantic consistency are still validated.

**Import.** **Guardrails → Create Guardrail ▾ → Import Guardrail package**:
choose a file, review versions and confirm import. Policy and Guardrail versions
are imported atomically. Identical versions are skipped, including round trips
back into locally created resources. The same ID/version with different content
is rejected. Source labels do not restrict import, including Default Guardrail
versions. Existing local drafts are preserved. A deleted Guardrail requires
explicit restoration, which clears old operational data and keeps definitions.

Import and export do not change traffic. Imported versions retain the ordinary
Pending → Run tests → Release lifecycle before use; runtime load checks belong
to routing and baseline operations, not file transfer. Artifact signing for
Controller/Runner transport is unchanged and needs no extra package key.

**CLI.** `guardctl` supports `export <guardrail-id> [--versions=a,b] [--out=file]`
and `import <file> [--versions=a,b] [--confirm]` (preview only without `--confirm`).

**Development environment.** `npm run helm:deploy:dev` uses only
`values-dev-uat.yaml`. There is no separate migration target profile or automatic
pair-deployment command; ordinary installations have identical import/export
features without package keys or trust configuration.

`npm run test:promotion` remains an opt-in regression for two explicitly
configured, isolated loopback test deployments. It does not deploy releases,
read cluster Secrets or start database port-forwards. Supply these environment
variables before running it:

- `GUARD_PROMOTION_UAT_URL`, `GUARD_PROMOTION_UAT_RUNNER_URL`, `GUARD_PROMOTION_UAT_DB`, `GUARD_PROMOTION_UAT_USERNAME`
- `GUARD_PROMOTION_PROD_URL`, `GUARD_PROMOTION_PROD_RUNNER_URL`, `GUARD_PROMOTION_PROD_DB`, `GUARD_PROMOTION_PROD_USERNAME`
- `GUARD_PROMOTION_PASSWORD` and the target's `GUARD_PROMOTION_RUNNER_TOKEN`
- Optional `GUARD_PROMOTION_WORKDIR` (default `.local-secrets/promotion`)

Use separate databases and loopback hosts for the two test deployments. This
regression writes test data and must not target production services.

Unit and PostgreSQL coverage:
`GUARD_TEST_POSTGRES_URL=... npx vitest run server/services/guardrail-packages.postgres.test.ts`.

The independence contract tests physically omit `policy_library/` in fresh
processes, reproduce the checked-in Artifacts, and exercise health endpoints and
input/output requests through the real Runner.

## Controller API reference

The Controller serves a code-generated OpenAPI 3.1 contract at `/api/openapi.json`,
a browsable reference at `/api/docs`, and a compact agent index at `/api/llms.txt`.
Use `?module=routers` or `?operationId=postRoutersByIdPublish` on the JSON endpoint
to retrieve a complete subset with its referenced schemas and token permissions.

`controller/openapi/controller.openapi.json` is an ignored build artifact.
Controller development startup and watch restarts, Vitest (including direct
`npx vitest` runs), typechecking, and server builds generate it from the current
source automatically. No database or running Controller is required to generate it.
Use `npm run openapi:generate --prefix controller` to generate it on its own.

CI runs `npm run openapi:check --prefix controller` to generate the contract and
test schema validity, mounted-route coverage, permissions, and filtered references.
It uploads the JSON as `controller-openapi-<commit SHA>` for inspection. Server
builds package the generated JSON in `dist-server/openapi/`; production serves
that artifact without running the generator. The Runner CLI image smoke script
also generates its contract fixture on the host and requires installed Controller
development dependencies (`npm ci --prefix controller`).
See [the API contract conventions](api-contract.md)
for product tags, resource paths, authentication, idempotency, and retry behavior.

The Controller API manages configuration and accounts. Applications and gateways
use the separate [Runner integration protocol](gateway-integration.md) for
Input, Output, and streaming checks.

## Console updates after deployment

Production UI builds embed a unique identity in `index.html` and
`ui-version.json`, including builds from uncommitted workspaces. Both documents
use `Cache-Control: no-store`; hashed `/assets/` files retain immutable caching.
Missing assets and manifests return uncacheable 404 responses instead of SPA HTML.

Open pages check the build identity every 15 seconds while visible, and again
on focus, network recovery, page restoration, or a Vite lazy-import failure.
A changed build reloads the current URL automatically. Temporary network errors
do not indicate an upgrade, and reloads have a per-tab cooldown for rolling
deployments. Development mode continues to use Vite HMR.

Editing drawers, forms, dirty Router/model configuration, focused inputs and
pending mutations defer automatic reloads. Closing or saving the editor allows
the pending update to proceed. Read-only testing reports allow updates so their
rendering logic cannot remain on an older build.

Pages opened before this mechanism was installed must load it once; subsequent
deployments are detected automatically. When adding a full-page editor without
a form, use `usePageUpdateBlocker` for its unsaved state. `SheetContent` protects
drawers by default; use `allowPageUpdates` only for read-only content.
