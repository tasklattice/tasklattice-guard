# Optional standalone Kubernetes demo manifests

Guard's supported installation is the current
[Guard Helm chart](../../charts/tali-guard/README.md), including its optional
LiteLLM provider gateway and Keycloak configuration. This directory contains
external demo tooling; it does not add Controller pages, provision Projects,
implement SSO or configure resource sharing.

`Dockerfile.litellm` is an optional pinned image recipe for the external demo. It
packages the core provider source from the recorded TaskLattice LiteLLM image
with Python 3.13 and `litellm[proxy]==1.87.0`, then precompiles bytecode for a
non-root, read-only container. The unused optional enterprise namespace is
omitted. It does not implement a model or modify Guard hooks. The recipe's image
version is explicit; select images compatible with your deployed Guard protocol.

[scripts/render-local-k8s-external.mjs](../../scripts/render-local-k8s-external.mjs)
reads operator inputs and renders application and generator resource Lists.
Runner services are supplied explicitly; it does not infer a Project's placement
from an alias or from an old `runtime-group-demo` service name.

## Private input layout

Set `GUARD_K8S_RUNTIME_DIR` to your private working directory; its default is
`.local-secrets/external-demo`. Supply:

| Input | Contents |
| --- | --- |
| `external-llm/gateways.json` | Exactly `tenantA`, `tenantB`, `tenantC` demo aliases, each with `gatewayApiKey`, `model` and `runnerBaseUrl` for an existing Runner HTTP(S) origin. |
| `external-llm/tenantA.yaml`, `tenantB.yaml`, `tenantC.yaml` | Existing one-model LiteLLM configurations with the default-on Guard provider, `pre_call`/`post_call`, fail-closed handling and environment references for credentials. |
| Matching `tenantA.env`, `tenantB.env`, `tenantC.env` | Distinct gateway master and Endpoint keys plus the external model key. Values must match the gateway map and existing Endpoint bindings. |
| `lab-manifest.json`, or `GUARD_K8S_LAB_MANIFEST` | Operator-supplied generator resource List with a `${prefix}-tenant-lab` Secret containing `config.json` and a matching Deployment. It supplies the standalone generator process/image; no Controller proxy is used. |
| `${GUARD_K8S_FAKE_PROJECT}/.env` | Independent model service's `FAKE_LLM_API_KEY`; the default project path is sibling `../tasklattice-fake-llm`. |

The three aliases are client labels. They are not Project IDs, membership
assignments or permission grants. Create real Project resources and gateway
integration first through the current product workflow. Store credentials and
rendered Secret-bearing files in ignored private directories with restricted
permissions.

```sh
GUARD_K8S_RUNTIME_DIR=.local-secrets/external-demo \
GUARD_K8S_LAB_MANIFEST=/private/operator/generator-template.json \
GUARD_K8S_NAMESPACE=guard-demo \
GUARD_K8S_PREFIX=external-demo \
  node scripts/render-local-k8s-external.mjs
```

The renderer writes `k8s-external/application-manifest.json` and
`k8s-external/lab-manifest.json` under the runtime directory. It rewires only the
supplied external gateway/model/generator bindings and prints output metadata.
It never builds images, applies Kubernetes resources or prints credentials.
Review the rendered files and choose your own cluster/deployment workflow.

Use `--help` for image and resource options. Default external gateway requests
are 10m CPU/128Mi memory, with a 384Mi memory limit and one worker. The separate
model service requires its own image. These settings describe a small synthetic
demo, not a measured capacity recommendation.

See the [standalone tools guide](../../docs/tenant-load-lab.md) for generator
configuration, private controls and Project acceptance checks. The
[5 November record](../../docs/local-k8s-runtime-2026-11-05.md) is historical
pre-rebase evidence, not current deployment instructions.
