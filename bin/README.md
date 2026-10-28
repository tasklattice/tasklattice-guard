# guardctl(1) — TaskLattice Guard command-line manual

## Name

`guardctl` — inspect and configure TaskLattice Guard through its Controller API.

`bin/guardctl` is an executable file. This manual lives alongside it in `bin/`.
The repository launcher runs the TypeScript CLI; the Runner image ships a
compiled executable with the same commands.

## Synopsis

Run these examples from the repository root:

```sh
# Open the interactive inspection and package shell.
bin/guardctl --url=http://localhost:38081

# Execute a configuration workflow and exit.
bin/guardctl platform help
bin/guardctl platform register-model [OPTIONS]
bin/guardctl platform bind [OPTIONS]
bin/guardctl tenant help
bin/guardctl tenant provision [OPTIONS]
bin/guardctl tenant test --guardrail-id ID [--version VERSION] [--local-only]
bin/guardctl tenant test-status --run-id ID [--detail]
bin/guardctl tenant test-cancel --run-id ID
```

Only `platform` and `tenant` are one-shot command families. Enter `show`,
`export`, and `import` inside the interactive shell, or pipe them on stdin.
For one-shot commands, put `--url` after the subcommand; both `--url URL`
and `--url=URL` work. To launch the interactive shell, use `--url=URL`.

## Asynchronous Guardrail tests

These commands call the same Controller routes as the UI. Use the tenant
credentials described below (`GUARD_TENANT_TOKEN` with `guardrails:write`, or
`GUARD_TENANT_USERNAME` and `GUARD_TENANT_PASSWORD`):

```sh
# Submit once; the JSON response contains the immutable run ID.
bin/guardctl tenant test --guardrail-id GUARDRAIL_ID --url=https://guard.example.com

# Inspect that exact ID, or stop it without deleting the report.
bin/guardctl tenant test-status --run-id RUN_ID --url=https://guard.example.com
bin/guardctl tenant test-cancel --run-id RUN_ID --url=https://guard.example.com
```

`test` returns immediately after submission. `--version` tests a frozen version;
omit it to test the current draft. `--local-only` explicitly skips model rules;
it does not disable them in the published Guardrail. Do not repeat `test` to poll:
each submission creates a new run. `test-status` is read-only and may use a
read-only token. It reads a lightweight summary by default, without downloading
all case traces while polling. Add `--detail` for the complete report (HTTP
compression is negotiated automatically):

```sh
bin/guardctl tenant test-status --run-id RUN_ID --detail --url=https://guard.example.com > report.json
```

`test-cancel` is idempotent and changes only queued/running Guardrail tests.
Passed/failed reports are returned unchanged. The cancelled state records the
stop request; an offline Runner may not have acknowledged cleanup yet.
`test-status` includes `cancellation.requestedAt` and `cancellation.acknowledgedAt`;
the latter stays null until cleanup is acknowledged. The Controller retries delivery to the default pool ordinal-0 Runner, never another
ordinal/pool. Publication and traffic are unaffected. Both Controller and Runner
must support the cancellation protocol. See [task lifecycle and Runner logs](../docs/operations.md#test-task-lifecycle-and-cancellation).

## Description: how the pieces fit

Guard has a management plane and a runtime. `guardctl` talks to the management
plane. It configures which protection the runtime executes; Veritas sends the
test traffic to the runtime and produces Reports.

```text
PLATFORM ACCOUNT                         TENANT ACCOUNT
Provider: connection + credential        Default Guardrail
    │                                        │ duplicate
Model: model name + protocol profile     Editable Guardrail copy
    │                                        │ patch + validate + publish
Binding: capability + direction          Published Guardrail version
    │                                        ▲
    │                                  Router: route → version
    │                                        ▲
    │                                  Endpoint: adapter + credential
    │                                        ▲
    └────────── Runner executes checks ────────┘
                                             ▲
                                       Veritas Target
                                             │
                                       Testing → Report
```

| Object | What it controls |
| --- | --- |
| Provider | The external model service URL and its credential. |
| Model | A model identifier, protocol profile, timeout, and token limit. |
| Binding | The Model used for a capability and direction, such as `content_safety.input`. |
| Policy | The checks, rules, and actions selected in a Guardrail. |
| Guardrail | A composition of Policies; publishing creates a version the runtime can load. |
| Router | Routes Endpoint traffic to a specific published Guardrail version. |
| Endpoint | The callable runtime integration, with a LiteLLM or F5 adapter and its own credential. |
| Veritas Target | Veritas's configuration for calling that Endpoint. |

Model registration alone does not enable a check. The binding must be active,
the Guardrail must include the corresponding Policy and direction, and the
active Router must point to that Guardrail version.

Bindings are currently **platform-wide**. Changing `content_safety.input`
affects every Guardrail that uses input Content Safety. A separate Router or
Guardrail does not give it a private model binding. Output uses its separate
binding, `content_safety.output`.

## Installation and help

The repository launcher needs Node.js and the Controller dependencies. Use
Node.js 24 to match the shipped CLI runtime.

```sh
npm ci --prefix controller
bin/guardctl platform help
```

To build the standalone bundle:

```sh
npm run build:cli --prefix controller
node controller/dist-cli/guardctl.cjs platform help
```

Inside the standard deployment's Runner container:

```sh
kubectl -n tali exec -it tali-guard-runner-0 -- guardctl
```

The container supplies the Controller URL through `GUARD_URL`, but does not
automatically supply management credentials. A deployed image contains the CLI
from its build; rebuild and deploy it to pick up source changes.

## Authentication and URLs

Configuration workflows use separate credentials for each account type:

| Workflow | Token authentication | Session authentication |
| --- | --- | --- |
| `platform …` | `GUARD_PLATFORM_TOKEN` | `GUARD_PLATFORM_EMAIL` + `GUARD_PLATFORM_PASSWORD` |
| `tenant …` | `GUARD_TENANT_TOKEN` | `GUARD_TENANT_EMAIL` + `GUARD_TENANT_PASSWORD` |

A token takes precedence over email/password for its plane. Tenant commands do
not fall back to platform credentials. The Controller enforces the account's
role and token permissions.

Supply credentials in the process environment or a private `--env-file`.
Environment values override file values. A file template is:

```dotenv
GUARD_PLATFORM_EMAIL=your-platform-account@example.com
GUARD_PLATFORM_PASSWORD=replace-with-platform-password
GUARD_TENANT_EMAIL=your-tenant-account@example.com
GUARD_TENANT_PASSWORD=replace-with-tenant-password
MODEL_GUARDRAILS_NVIDIA_API_KEY_ENV_VAR=replace-with-provider-key
MODEL_GUARDRAILS_JEV_API_KEY_ENV_VAR=replace-with-provider-key
```

For example, save this locally as `.local-secrets/guardctl.env`, replace the
placeholders, and restrict its permissions to `0600`. `.local-secrets/` is
ignored by Git. Do not pass passwords or Provider keys as command arguments.
`--key-env` takes the **name** of an environment variable, not its value.

For configuration commands, URL precedence is:

1. `--url` on the command.
2. `GUARD_PLATFORM_URL` or `GUARD_TENANT_URL`, for the selected plane.
3. The CLI's normal URL resolution: process `GUARD_URL`, process
   `CONTROLLER_PUBLIC_URL`, local `.env` discovery, then `http://localhost:8080`.

Use an HTTP(S) Controller origin without a path, query, fragment, or embedded
credentials. The local deployment normally uses Controller port `38081` and
Runner port `38082`. Management commands use the Controller port.

## Command reference

### platform register-model

Create or reuse a Provider and Model. This does not activate a binding.

```text
guardctl platform register-model
  --provider-name NAME --provider-kind KIND --provider-url URL
  --model MODEL_NAME --profile PROFILE_ID --key-env ENV_NAME
  [--timeout-seconds N] [--max-tokens N] [--refresh-credential]
  [--url URL] [--env-file FILE]
```

| Option | Meaning |
| --- | --- |
| `--provider-name` | Provider name used for lookup. Ambiguous names are rejected. |
| `--provider-kind` | Provider protocol kind, for example `typesafe` or `custom-openai-compatible`. |
| `--provider-url` | Upstream model service base URL. |
| `--model` | Exact upstream model identifier. |
| `--profile` | Guard protocol profile that constructs and parses model requests. |
| `--key-env` | Provider key environment-variable name; required when creating or refreshing credentials. |
| `--timeout-seconds` | Positive integer; default `30`. |
| `--max-tokens` | Positive integer; default `512`. |
| `--refresh-credential` | Explicitly update an existing Provider's credential. |

Matching definitions are reused without rotating credentials. A different
connection or conflicting existing Model settings cause an error. The JSON
result contains `providerId`, `modelId`, `model`, `profile`, and `reused`.

### platform bind

Validate a candidate, save one binding, apply it, and wait for activation.

```text
guardctl platform bind
  --binding CAPABILITY.DIRECTION --model-id MODEL_ID --state FILE
  [--validation-id ID | --revalidate] [--wait-seconds N]
  [--url URL] [--env-file FILE]
```

| Option | Meaning |
| --- | --- |
| `--binding` | One capability/direction, for example `content_safety.input` or `jailbreak.input`. |
| `--model-id` | Registered Model ID returned by `register-model`. |
| `--state` | Private operation journal, saved before mutations. |
| `--validation-id` | Reuse a current candidate-validation receipt for this account, binding, and Model. |
| `--revalidate` | Run new candidate probes instead of using the cached receipt. |
| `--wait-seconds` | Activation polling deadline; default `300`. |

Candidate validation makes real model calls. The CLI requires a passing probe;
the API checks receipt identity, expiry, compatibility, and configuration
revisions. Only the named binding is applied. The JSON result includes the
active revision and `previousModelId`, which can be used to restore a previous
Model with a new binding operation/state file. A null previous ID means the
binding was originally unassigned; this command currently requires a Model ID
and does not provide an unassign operation.

The CLI waits for activation before returning success. Do not compare models
by switching the global binding while a Veritas Run is still executing.

### tenant provision

Duplicate a source Guardrail, patch the copy, validate and publish it, then
create or reuse a dedicated Endpoint/Router and apply its reviewed route.

```text
guardctl tenant provision
  --name NAME --patch FILE --state FILE --emergency-reason TEXT
  [--source GUARDRAIL_ID] [--adapter ADAPTER]
  [--endpoint-id ID] [--router-id ID] [--replace-change-id ID]
  [--wait-seconds N] [--url URL] [--env-file FILE]
```

| Option | Meaning |
| --- | --- |
| `--name` | Name for the copy and newly created Endpoint/Router. |
| `--source` | Source Guardrail; default `guardrail-default`. Copies its pinned draft revision. |
| `--patch` | JSON file containing `draftConfig` and optional `runtimeProfile`. |
| `--state` | Private journal used to resume and retain resource identities. |
| `--adapter` | `litellm-generic-guardrail` (default) or `f5-scan`. |
| `--endpoint-id` | Reuse an existing Endpoint of the selected adapter without rotating its key. |
| `--router-id` | Reuse a Router dedicated to that Endpoint. |
| `--replace-change-id` | Withdraw this exact pending request before preparing the replacement. |
| `--emergency-reason` | Required audit reason for direct Emergency apply; no interactive confirmation. |
| `--wait-seconds` | Deadline for each validation/publication/rollout polling phase; default `300`. |

`draftConfig` fields are merged at the top level with the copied configuration.
Arrays, including `policyBindings`, are **replaced in full**, not appended.
The source Guardrail remains unchanged. Validation must pass and compilation
must be ready before routing is applied. Emergency apply uses the normal API
audit path and waits for an active rollout.

The result contains the Guardrail ID/version, validation ID, Endpoint ID,
Router ID/revision, change-request ID, and state-file path. Newly created
Endpoint credentials are saved only in the private state file. Reusing an
Endpoint does not retrieve its existing credential.

## Walkthrough: NVIDIA input Content Safety

This creates an isolated model-backed input check from a Default copy. It is
the configuration pattern used for the Content Safety comparison; it does not
retain all Default protections in the copy. To deploy a broader policy set,
edit the patch's complete `policyBindings` list accordingly.

### 1. Register or reuse the platform Model

```sh
bin/guardctl platform register-model \
  --url http://localhost:38081 --env-file .local-secrets/guardctl.env \
  --provider-name 'NVIDIA NIM' --provider-kind custom-openai-compatible \
  --provider-url https://integrate.api.nvidia.com/v1 \
  --model nvidia/llama-3.1-nemotron-safety-guard-8b-v3 \
  --profile tali.nemotron-safety-guard-v3.v1 \
  --timeout-seconds 30 --max-tokens 512 \
  --key-env MODEL_GUARDRAILS_NVIDIA_API_KEY_ENV_VAR
```

Record the returned `modelId` as `NVIDIA_MODEL_ID` in your shell. This is an
identifier, not a credential.

### 2. Activate the input binding

```sh
bin/guardctl platform bind \
  --url http://localhost:38081 --env-file .local-secrets/guardctl.env \
  --binding content_safety.input --model-id "$NVIDIA_MODEL_ID" \
  --state .local-secrets/nvidia-content-input.json
```

This leaves output and unrelated bindings unchanged.

### 3. Create and publish the tenant's test path

```sh
bin/guardctl tenant provision \
  --url http://localhost:38081 --env-file .local-secrets/guardctl.env \
  --name 'Content Safety comparison' --source guardrail-default \
  --patch docs/examples/content-safety-input.json \
  --state .local-secrets/content-safety-endpoint.json \
  --adapter litellm-generic-guardrail \
  --emergency-reason 'Authorized local Content Safety verification'
```

The [example patch](../docs/examples/content-safety-input.json) enables only
`builtin-content-safety` / `model/content-safety` on input, with a block action.

### 4. Connect Veritas and verify evidence

For the returned Endpoint ID, configure a Veritas Target with the matching
adapter and runtime URL:

| Adapter | Runtime URL path, appended to `http://localhost:38082` |
| --- | --- |
| LiteLLM | `/runtime/v1/endpoints/ENDPOINT_ID/beta/litellm_basic_guardrail_api` |
| F5 Scan | `/runtime/v1/endpoints/ENDPOINT_ID/backend/v1/scans` |

Load the private state's `endpoint.credential` into the Veritas server process
environment, and point the Target's `apiKeyEnv` to that variable name. For an
existing Endpoint, use its existing credential. Provider keys belong to Guard;
Veritas needs the Endpoint credential.

Start a small Veritas test and verify the returned route/version and model
execution evidence. A working HTTP response alone does not prove that the
intended Policy and Model ran. Reproducing benchmark results also requires the
same model/profile, Policy/version, original samples, expected labels, scorer,
and execution settings. A published configuration does not guarantee a fixed
accuracy across different datasets or provider model revisions.

For the equivalent JEV setup and model-switching examples, see
[API configuration with guardctl](../docs/guardctl-configuration.md).

## Interactive inspection

```sh
bin/guardctl --url=http://localhost:38081
```

Then enter commands at the prompt:

```text
read
show identity
show models
show model-configuration
show guardrails
show endpoints
show routers
show runners --pool default
show telemetry-events --endpoint ENDPOINT_ID --limit 20
show telemetry-event EVENT_ID
exit
```

`read` prompts for a PAT or uses process `GUARD_ACCESS_TOKEN`. `enable` prompts
for an administrator email/password. Credential prompts hide input. `disable`
clears the privileged session; `connect URL` changes the server and clears
active credentials. Authentication does not grant permissions beyond those
enforced by the Controller.

| Command | Purpose |
| --- | --- |
| `help` | Show commands and configuration usage. |
| `show` | List all inspection resources and supported filters. |
| `show RESOURCE [ID]` | Inspect a collection or resource. |
| `show … --detail` / `d` | Show all table rows / repeat the last inspection in detail. |
| `show … --output /absolute/file.json` | Export the returned JSON, including rows hidden by the table preview. |
| `show router-revisions ROUTER_ID [REVISION]` | Inspect published routing history. |
| `show route-distribution ROUTER_ID --window 24h` | Inspect observed routing distribution. |
| `show test-runs --guardrail GUARDRAIL_ID` | Inspect Guard validation jobs. |
| `show audit-events --limit 20` | Inspect configuration audit records. |
| `export GUARDRAIL_ID --versions=VERSION --out=/absolute/release.guardrail.zip` | Download selected published versions. |
| `import /absolute/release.guardrail.zip --versions=VERSION` | Preview an import; interactive sessions can then ask to confirm. |
| `import /absolute/release.guardrail.zip --versions=VERSION --confirm` | Confirm import explicitly. |

Package import and traffic publication are separate operations. Importing a
package does not activate an Endpoint route. See the package documentation for
restoring a deleted Guardrail; this CLI can require `--restore-deleted` there.

The repository launcher changes directory to `controller` for the legacy
interactive shell. Use absolute paths for interactive import/export and JSON
output. Configuration commands resolve `--env-file`, `--patch`, and `--state`
relative to the directory from which you invoked `bin/guardctl`.

For scripted inspection, supply `GUARD_ACCESS_TOKEN` in the process environment:

```sh
bin/guardctl --url=http://localhost:38081 <<'COMMANDS'
show model-configuration
show routers --output /tmp/guard-routers.json
exit
COMMANDS
```

The displayed table shows at most 20 rows by default. `--detail` removes that
display limit; it does not fetch subsequent pages from a paginated API.
Telemetry filters include `--cursor` and `--limit` for pagination.

## State, output, and exit status

One-shot commands return one JSON result on stdout after success. Failures
print an error on stderr and exit with status `1`; success exits with `0`.
The interactive shell also prints banners and tables. Piped inspection HTTP
failures set a nonzero status; not every legacy usage message is an error code.

State files retain operation identities, source configuration, validation and
publication references, original model assignments, and any newly created
Endpoint credential. They are written with mode `0600` and a `.lock` prevents
concurrent use of the same state file.

Repeat the same command and state file to resume. A completed tenant workflow
verifies the existing resources without creating another copy or Emergency
apply. Use a new state for a different requested configuration. Saved original
bindings are recovery information; the CLI does not automatically restore
them when a later Veritas Run finishes.

If an Endpoint/Router create response is lost, inspect existing resources before
retrying. Those creates are not server-idempotent. Reuse a known resource ID in
a new reviewed operation rather than rotating credentials or deleting objects.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Missing `GUARD_PLATFORM_*` or `GUARD_TENANT_*` | Supply credentials for the selected command family; check `--env-file`. |
| HTTP `401` / `403` | Check account, role, token permissions, and Controller URL. |
| Provider connection/model settings differ | Reuse the matching configuration or choose another Provider/Model identity; the CLI does not silently overwrite it. |
| Candidate receipt expired | Use `--revalidate`. Cached expired receipts refresh automatically; explicit expired receipts are rejected. |
| Candidate probe did not pass | Inspect model/protocol/credential and the validation report before retrying. No binding was applied by that failed step. |
| Guardrail validation failed | Inspect `show test-runs --guardrail ID`. Publication and routing stop at this stage. |
| State belongs to another request | Resume with the original arguments or use a new state file. |
| Another Router change is pending | Inspect it; use its exact `--replace-change-id` only when replacing that request is intended. |
| Activation or rollout timeout | Inspect `show model-configuration`, `show routers ID`, and `show runners`; resume the same operation after resolving the failure. |
| Existing `.lock` after interruption | Confirm no process is using the journal before removing a stale lock. |
| Target responds but no intended model call | Check active binding, enabled Policy/direction, published Guardrail version, Router snapshot, and per-request telemetry. |

## Files and further reading

| Path | Purpose |
| --- | --- |
| [`guardctl`](guardctl) | Repository executable launcher. |
| [`controller/src/cli/guardctl.ts`](../controller/src/cli/guardctl.ts) | Interactive shell and dispatch. |
| [`controller/src/cli/configure.ts`](../controller/src/cli/configure.ts) | Platform and tenant configuration workflows. |
| [`controller/src/cli/configure.test.ts`](../controller/src/cli/configure.test.ts) | Workflow, authentication, validation, and resume tests. |
| [`controller/scripts/build-guardctl.mjs`](../controller/scripts/build-guardctl.mjs) | Standalone bundle build. |
| [`docs/guardctl-configuration.md`](../docs/guardctl-configuration.md) | Additional model and tenant configuration examples. |
| [`docs/ops-cli-proposal.md`](../docs/ops-cli-proposal.md) | Shipped-image usage and the broader CLI design proposal. |
| [`docs/api-contract.md`](../docs/api-contract.md) | Controller API contract and generation workflow; the running Controller serves `/api/openapi.json`. |
