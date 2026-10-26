# Configure Guard through the existing CLI

Use `bin/guardctl` in the repository, or the compiled `guardctl` executable.
The source is `controller/src/cli/guardctl.ts` with configuration workflows in
`controller/src/cli/configure.ts`. These commands call the same management APIs
as the console. They do not edit the database or Runner state.

```text
platform register-model → Provider + Model
platform bind           → validate candidate → apply one capability/direction
tenant provision        → duplicate Default → patch copy → validate → publish
                        → Endpoint + Router → Emergency apply → wait for rollout
Veritas Target          → Endpoint runtime URL → published Guardrail
```

## Credentials

Use a private environment file (mode `0600`, outside version control) with
`GUARD_PLATFORM_EMAIL` and `GUARD_PLATFORM_PASSWORD` for the platform account,
and `GUARD_TENANT_EMAIL` and `GUARD_TENANT_PASSWORD` for the tenant account.
Alternatively supply `GUARD_PLATFORM_TOKEN` and `GUARD_TENANT_TOKEN` with the
appropriate API permissions. Tenant operations never fall back to platform
credentials. Provider secrets are read by environment-variable name and never
printed. Environment variables override values in `--env-file`.

Examples below use `.local-secrets/guardctl.env`. Add the provider keys there as
`MODEL_GUARDRAILS_JEV_API_KEY_ENV_VAR` and
`MODEL_GUARDRAILS_NVIDIA_API_KEY_ENV_VAR`, or export them into the process.
Use `--url` for the Controller origin; separate `GUARD_PLATFORM_URL` and
`GUARD_TENANT_URL` are also supported.

## Platform: register the models

```sh
bin/guardctl platform register-model \
  --url http://localhost:38081 --env-file .local-secrets/guardctl.env \
  --provider-name 'TypeSafe JEV' --provider-kind typesafe \
  --provider-url https://api.typesafe.ai/v1 \
  --model jev-1.13.0 --profile tali.typesafe-jev.v1 \
  --timeout-seconds 20 --max-tokens 512 \
  --key-env MODEL_GUARDRAILS_JEV_API_KEY_ENV_VAR

bin/guardctl platform register-model \
  --url http://localhost:38081 --env-file .local-secrets/guardctl.env \
  --provider-name 'NVIDIA NIM' --provider-kind custom-openai-compatible \
  --provider-url https://integrate.api.nvidia.com/v1 \
  --model nvidia/llama-3.1-nemotron-safety-guard-8b-v3 \
  --profile tali.nemotron-safety-guard-v3.v1 \
  --timeout-seconds 30 --max-tokens 512 \
  --key-env MODEL_GUARDRAILS_NVIDIA_API_KEY_ENV_VAR
```

The result contains `modelId`. Existing matching definitions are reused. A
different connection or protocol setting is rejected rather than silently
overwriting a shared model. `--refresh-credential` explicitly updates an
existing Provider key.

## Platform: bind a model

Replace `JEV_MODEL_ID` with the returned ID:

```sh
bin/guardctl platform bind \
  --url http://localhost:38081 --env-file .local-secrets/guardctl.env \
  --binding content_safety.input --model-id JEV_MODEL_ID \
  --state .local-secrets/jev-binding.json
```

This performs real safe/unsafe candidate probes, saves the validated assignment,
applies only `content_safety.input`, and waits for activation. The API still
enforces validation and optimistic concurrency. Output and unrelated bindings
remain unchanged. Bindings are **platform-wide**: every Guardrail using this
capability and direction uses the selected model. JEV Content Safety currently
supports input; keep NVIDIA on output.

The state records the original assignments before any write. The JSON result
includes `previousModelId`. After comparison, bind that ID with a **new** state
file (for example `restore-nvidia.json`); this validates and restores only the
selected binding. Do not run tests during activation.

## Tenant: create from a Profile and publish a test Endpoint

```sh
bin/guardctl tenant provision \
  --url http://localhost:38081 --env-file .local-secrets/guardctl.env \
  --name 'HarmBench Content Safety' --profile local-baseline \
  --patch docs/examples/content-safety-input.json \
  --state .local-secrets/harmbench-endpoint.json \
  --adapter litellm-generic-guardrail \
  --emergency-reason 'Authorized local Content Safety model comparison'
```

The example patch keeps only model-backed input Content Safety in the copy.
This isolates model behavior from earlier local or jailbreak checks. For a
different deployment, provide a JSON patch with `draftConfig` and optional
`runtimeProfile`; top-level `draftConfig` fields are merged with the pinned
Profile, while arrays such as `policyBindings` are replaced in full. Use
`--source GUARDRAIL_ID` instead to duplicate an existing draft. Publication
compiles without running tests; compilation errors are retryable using the same
state file. Tests never gate publication. Runtime dependencies still apply.

Use `--adapter f5-scan` for an F5 Endpoint. The result returns the Endpoint,
Guardrail version, Router revision, and rollout status. Connect Veritas to:

- LiteLLM: `http://localhost:38082/runtime/v1/endpoints/ENDPOINT_ID/beta/litellm_basic_guardrail_api`
- F5: `http://localhost:38082/runtime/v1/endpoints/ENDPOINT_ID/backend/v1/scans`

Load `endpoint.credential` from the private state into the environment variable
referenced by the Veritas Target's `apiKeyEnv`. Restart the Veritas process with
that environment if necessary. The CLI never prints the credential. Reusing an
Endpoint does not reveal or rotate its existing credential.

For an existing dedicated test path, pass `--endpoint-id` and `--router-id`.
The Router must contain only that Endpoint. If a different request is pending,
pass its exact `--replace-change-id` to withdraw it before submitting the new
snapshot. Emergency apply always requires a reason and creates the normal API
audit trail; it does not impersonate another approver or skip validation.

## Resume and failure behavior

Repeat the same command and state file to resume after interruption. Profile or source
revision, creation idempotency key, publication, and change-request
identities are retained. A completed operation verifies live state and does not
create another copy. The CLI stops on stale or conflicting changes and returns
a nonzero exit code. It never silently applies a pending request with a different
snapshot. State files are private (`0600`) and protected by a process lock. After
a hard kill, remove a stale `.lock` only after confirming no process is using it.

For non-idempotent API creates whose response was lost, inspect the existing
Endpoint/Router and pass its ID when starting a new reviewed operation. Do not
delete resources or rotate credentials just to retry. Failed model validation
can be retried with `--revalidate` and the same binding state. An expired cached
receipt is refreshed automatically; an explicitly supplied expired
`--validation-id` fails so it cannot be mistaken for the reviewed receipt.

These workflows add no CI configuration. Existing interactive inspection and
package commands continue to work.

For a dedicated input Prompt Injection workload, see the
[strict policy profile](prompt-injection-policy-profile.md), including
uncertainty handling, independent validation, and metric interpretation.
