# Protection release acceptance

Use this checklist with the evidence ledger in `protection-productization.md`.
Passing a deterministic replay establishes execution correctness, not attack
detection quality. Do not silently reclassify a skipped gate as passed.

Latest completed round: [2026-09-08 expanded tali acceptance](tali-expanded-acceptance-20260908.zh-CN.md).
The user authorized 100 NVIDIA and 100 DeepSeek calls, excluding Topic and
Jailbreak; actual usage was 73 and 13. Its gateway is stopped and its credential
Secret removed. Do not recreate it to reset its ledger or automatically repeat
the completed scripts. Captured NVIDIA responses and DeepSeek completion text
are available for offline regression. Earlier per-round quotas below remain
historical records, not additional current authorization.

Current user scope: desktop only; mobile acceptance is explicitly abandoned.
Further cluster work is limited to the explicitly authorized OrbStack `tali`
namespace. Older isolated-namespace commands in historical reports are not current
authorization. The September 8 bounded live run is finished; do not restart its
gateway or reuse remaining request capacity as authorization for a new run.

Local project images must use the user-required `dev` tag. Do not invent dated,
acceptance or per-round tags. Record the actual image digest plus source state
for evidence; use the existing Makefile rollout mechanism to refresh moving
`dev` images. Third-party base/dependency images keep their explicit versions.

When restoring model configuration, activation/rollback API responses are views
with `active`/`activating`, not bare revision objects. A rejected activation with
the original revision still active needs no rollback. Wait for an in-flight owned
attempt to resolve; refuse to overwrite a different actor's revision. Offline
checks for these decisions live in `tests/control_plane/test_acceptance_restore.py`.

## 1. Freeze the candidate

Record the Guard and Relay source revisions **and dirty changes**, Controller and
Runner image IDs, Relay image ID, compiler identity, Policy versions, artifact
checksum, model revision and effective release. A Git HEAD alone is insufficient
for this currently modified workspace. Only perform the authorized `tali` local
update; a `dev` tag alone is not evidence of which bytes were tested or deployed.

The compiler currently uses
`tasklattice-nemo-config-v18-selected-policy-dependencies`. Historical deployed
reports from before that version do not establish that the current candidate was
deployed. Check the new deployment's actual artifact and runtime identities.

## 2. Local engineering gates

Run `make test` once for the final candidate; use affected gates during fixes.
The plane boundaries and optional Redis/Relay environments are in `testing.md`.
Verify fixture freshness with:

```sh
.venv/bin/python scripts/generate_test_artifacts.py --check
```

Required assertions include Policy/Rule order, local overrides, unchanged pinned
Policy source, no-model Default, all five presets, Input/Output, and complete
versus split-output equivalence where complete buffering is required.

For a **packaged Relay image**, not a source-overlay test:

```sh
GUARD_TEST_RELAY_IMAGE=tali-litellm:dev \
GUARD_TEST_RELAY_BAKED_IMAGE=1 \
  .venv/bin/python -m pytest -q -s tests/e2e/test_relay_stream_delivery.py
```

This requires the existing local image and sibling Relay source. The gate compares
every Python file in the baked TaskLattice integration with that source before
starting the proxy. It never pulls an image and does not mount replacement
integration code. The test config is mounted read-only. A stale image fails even
if a separate source-overlay test passed. This checks the TaskLattice integration,
not every dependency or the reproducibility of the entire base image build.

## 3. Isolated persisted lifecycle and Default replay

Use the recorded candidate in the authorized OrbStack `tali` namespace. Isolate
test records by their regression IDs, not by inventing another namespace.
Deployment is a separate authorized operation, not a side effect of
the commands below. Configure these environment variables without putting
credentials into reports:

`GUARD_REGRESSION_CONTROLLER_URL`, `GUARD_REGRESSION_RUNNER_URL`,
`GUARD_REGRESSION_ORIGIN`, `GUARD_REGRESSION_EMAIL`,
`GUARD_REGRESSION_PASSWORD`, `GUARD_REGRESSION_RUNNER_TOKEN`.

The scripts enforce loopback endpoints. UI origin must match the Controller's
allowed origin. Verify that the selected loopback endpoints target `tali`;
do not reuse historical isolated preview ports without checking their owner.

```sh
GUARD_REGRESSION_ALLOW_WRITES=1 GUARD_REGRESSION_RUN_ID=reviewed-release-id \
  node scripts/regress_protection_lifecycle.mjs
node scripts/regress_default_runtime.mjs
```

The first command creates/validates/publishes named regression Guardrails for all
five presets. It preserves Default and existing drafts, verifies saved versus
compiled Policy order, signing and Runner convergence, then replays inherited
cases. Reuse the same explicit run ID after inspecting an interrupted run, rather
than creating duplicate jobs. The second requires an already published, reviewed
Default and checks its inherited/legacy cases, exact redactions, unchanged artifact
identity and zero model calls. It does not publish or edit Default. Both create
runtime telemetry; neither is a zero-side-effect health probe.

Keep created regression IDs and validation/artifact IDs as evidence. Do not delete
database records or publish Default automatically to make a failing test pass.

## 4. Final-client 1:1 proxy replay

Use a named published regression Guardrail from step3 and the verified local
Relay image. This stage creates Integration/Deployment records in the `tali`
Controller; records remain for inspection. The temporary proxy and synthetic
upstream services are cleaned up by the script.

```sh
GUARD_REGRESSION_ALLOW_WRITES=1 \
GUARD_REGRESSION_GUARDRAIL_ID=verified-regression-guardrail-id \
GUARD_REGRESSION_PROXY_IMAGE=tali-litellm:dev \
  node scripts/regress_business_proxy.mjs
```

Use the actual ID, not the placeholder. Default selection additionally requires
`GUARD_REGRESSION_ALLOW_DEFAULT=1`. Ports8095/8096/8098 must be available or override
`GUARD_REGRESSION_PROXY_PORT`, `GUARD_REGRESSION_BUSINESS_PORT` and
`GUARD_REGRESSION_TRANSPORT_PORT`. Do not evict existing processes to obtain them.
The authorized Topic Control Mock also uses8098 by default. When retaining it
for this regression, set `GUARD_REGRESSION_TRANSPORT_PORT` to another verified
free loopback port (for example8099); keep the saved Mock Provider URL unchanged.

Here the business-model HTTP/SSE response is deliberately controlled; the local
Policies, Runner, Relay and final client execute for real. Compare actual request
forwarding, exact redacted text, blocked/no-body outcomes, checked-release timing,
model-call evidence, cancellation and incomplete-stream failures. An identical
last verdict alone is not 1:1 evidence. Infrastructure errors must not count as
successful attack detection or normal stream completion.

## 5. Real detector quality: separate, budgeted acceptance

After independent review, supply the holdout schema described in `testing.md`,
an existing `generic-http-guard` Integration, its scoped key, pinned deployment
identities, per-category/direction thresholds and an approved request budget.
Keep benign cases alongside attacks. Do not tune on the final holdout, fabricate
review provenance, or count provider errors as true positives.

```sh
GUARD_HOLDOUT_ALLOW_MODEL_CALLS=1 \
  .venv/bin/python scripts/evaluate_model_holdout.py \
  /absolute/path/to/reviewed-holdout.json --runner https://isolated-runner.example \
  --max-cases 100
```

Set `GUARD_HOLDOUT_INTEGRATION_KEY` separately. Replace the example path, origin
and request cap with approved values. A request cap is not a dollar/token cap:
one request can invoke several detectors and provider retries. This harness uses
real guard-model calls with fixed inputs/outputs; it does **not** generate real
business-model answers or test streaming. A real business-model run needs a
separate approved endpoint/cost and reviewed response set. Do not describe the
fixed-response harness as that missing evaluation.

## Injection and streaming acceptance boundaries

- User-input attacks: exercise Input protections before forwarding to the
  business model; verify blocked inputs cause no business-model call.
- Attacks carried by business-model output: treat that output as untrusted and
  run the explicitly selected Output protections before delivery. An Input-only
  jailbreak detector does not automatically protect Output. Local phrase rules
  can exercise deterministic attack fixtures but do not prove semantic coverage.
- If another agent consumes the result, its Input boundary must check it again.
  Safe rendering and tool authorization are separate controls; Output text checks
  do not authorize tool execution or turn untrusted documents into instructions.
- Use both controlled attack responses (reproducible pipeline checks) and real
  detector responses (quality measurement). Never mock the detector's successful
  verdict and report it as measured attack recall.
- Checked incremental streaming may release an approved prefix before a later
  rejection; it cannot retract that prefix. Full buffering releases nothing until
  the complete answer passes or is transformed. Default's complete-value PII
  redaction uses full buffering, with higher first-content latency.

## Final handoff

Attach terminal results, exact candidate identities, retained regression IDs,
client-byte evidence, skip list, model-quality report and explicitly unresolved
items. Missing target-deployment evidence or approved live-model evaluation is
not a green release gate. Stop before unapproved deployment, external API spend,
or changing the reviewed thresholds to fit the observed results.
