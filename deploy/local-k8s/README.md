# Local external-model gateway image

`Dockerfile.litellm` packages the unchanged core Python package from the pinned
TaskLattice LiteLLM image. It uses Python3.13 and the standard
`litellm[proxy]==1.87.0` dependencies, omits the unused optional enterprise
namespace, and precompiles bytecode for non-root, read-only Pod startup. It does
not implement a model or modify Guard hooks. No enterprise feature is enabled.

```sh
docker build -f deploy/local-k8s/Dockerfile.litellm \
  -t tasklattice-litellm-local:k8s-1.87.0-guard.3 .
kind load docker-image tasklattice-litellm-local:k8s-1.87.0-guard.3 --name guard-tenants
node scripts/render-local-k8s-external.mjs
```

The renderer writes Secret-containing manifests only to ignored private runtime
state. It reuses the existing per-tenant upstream configs and credentials and
changes application URLs to Kubernetes Services. It neither applies resources
nor prints credentials. Default local gateways use10m CPU requests,128Mi memory
requests,384Mi memory limits and one worker. The standalone model has its own
image and project in `../tasklattice-fake-llm`.

See `docs/local-k8s-runtime-2026-11-05.md` for the actual deployment inventory,
access bridge, resource budget, validation and remaining limits.
