# Runner Model Bundle

The bundle is an OCI image that holds model files under `/opt/models/`.
It currently contains the English Laya checkpoint that Runner loads on CPU at
startup. Its locked Hugging Face revision and file hashes live in the
[shared checkpoint manifest](../../controller/shared/builtin-laya-manifest.json).
The Runner image includes the SDK, Transformers and CPU Torch from `uv.lock`.

## Publish and reuse the bundle

The [**Runner Model Bundle** workflow](../../.github/workflows/runner-model-bundle.yml)
runs when bundle inputs change on `main` and can also run on demand. It looks up
the tag derived from the inputs and builds and publishes the AMD64 and ARM64
bundle to `ghcr.io/tasklattice/tali-guard-runner-model-bundle` when the tag is
missing. The workflow verifies the checkpoint files against their SHA-256
digests while building the bundle.

Print the expected GHCR tag for the checked-out bundle inputs.

```sh
GITHUB_REPOSITORY_OWNER=tasklattice bash scripts/runner-model-bundle-ref.sh
```

When adding another model asset, include its manifest in the tag script's inputs
and the workflow's path filters.

Release resolves the published bundle for its source commit and passes the digest
to `Dockerfile.runner` as the `runner_model_bundle` build context. The bundle
must be published before the Runner release can proceed. Both platform builds
verify their published Runner image with offline CPU inference before creating
the multi-platform release tag. A per-platform GHCR build cache carries the
composed model layer and CPU dependencies across releases.

## Test locally

Build the generated contracts with `npm run generate`, then build and smoke-test
the normal Runner image. The default Dockerfile target uses the same checkpoint
lock and caches the download. To reuse a published bundle, pass
`--build-context runner_model_bundle=docker-image://<bundle-image>@sha256:<digest>`.

```sh
docker buildx build --load -f Dockerfile.runner -t tali-guard-runner:laya-dev .
bash scripts/test-runner-laya.sh tali-guard-runner:laya-dev
```

You can also prebuild a local bundle for multiple Runner builds.

```sh
docker buildx build --target runner_model_bundle --load -f Dockerfile.runner \
  -t tali-guard-runner-model-bundle:local .
docker buildx build --load -f Dockerfile.runner -t tali-guard-runner:laya-dev \
  --build-context runner_model_bundle=docker-image://tali-guard-runner-model-bundle:local .
```

Open **Protection Capabilities** and select **Built-in · Laya English** for a
supported rail. For a single-node smoke test, start with one Runner replica,
2 requested CPU cores, 3 GiB requested memory and a 6 GiB memory limit.

Helm exposes the Runner's configured CPU limit, or its request when no limit is
set, as `GUARD_RUNNER_CPU_MILLICORES`. Without a configured budget the Runner
uses its detected cgroup quota and available CPUs. The detected capacity also
caps the configured budget. The Runner divides that budget among active
inference workers and rounds down to a minimum of one Torch thread per worker.
There is one worker by default. Set `GUARD_BUILTIN_LAYA_TORCH_THREADS` to override
the automatic thread count per worker. The selected count is logged at startup.
