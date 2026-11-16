# Laya model delivery

The Models repository produces evaluated Laya bundles. Guard assembles each
approved model into a candidate Runner image. The Runner continues to use its
local System One executor, the existing model bindings and the configured
GuardRail Decision path.

## Build a candidate

Use the `model-lock.json` from the Models release. In a Guard checkout that
includes the candidate build support, run `npm run generate`, put the lock at
`deploy/runner-model-bundle/model-lock.json`, then run:

```sh
bash scripts/build-runner-model-candidate.sh tali-guard-runner:laya-candidate
```

The script pulls the OCI model payload by SHA-256. The Docker build validates
the lock and payload before copying it into the candidate image. The smoke
test starts the non-root Runner model in a read-only, network-disabled
container. The same procedure is available through the manual **Runner
model candidate** workflow. Supply the JSON lock as its input. The workflow
exports the tested image and lock for each supported architecture.

## Roll out or roll back

For an authorized rollout, retain the previously verified Runner image digest
and its Controller model checkpoint revision. Pin the candidate Runner image
with `runner.image.repository` and `runner.image.digest` in Helm. Set
`runner.builtinLayaCheckpointRevision` to the first 40 characters of the lock's
`artifactSha256`. Controller uses that revision in the existing capability
validation and desired state. A Runner with a different model revision rejects
the binding, so validate and roll out the matching Controller setting and
Runner image together.

The model, tokenizer, calibration and thresholds are part of that image.
Roll back by restoring the previous image digest and corresponding
`runner.builtinLayaCheckpointRevision`. For the upstream native checkpoint,
restore the empty Helm override so Controller uses its pinned upstream
revision. Validate the built-in capability before moving traffic.

## Verify the loaded decision model

Runner startup logs `runner_builtin_laya_loaded`. Compare the log with
`guard_runner_builtin_laya_info`, the candidate lock and the image digest from
the deployment. A Scan with `X-Guard-Evidence: evaluations-v1` includes the
Runner version, model version, calibration version, threshold policy version,
artifact SHA-256 and the actual thresholds for the evaluated Laya stage.
Decision telemetry carries the same identity. Use the GuardRail Release and
Runner build fields to correlate the request with its serving deployment.

The candidate build is separate from the normal tagged Guard release. The
standard native bundle remains available through the existing Docker target.
