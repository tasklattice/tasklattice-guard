# tali-litellm-dev

Test-only LiteLLM gateway carrying the TaskLattice Guard Provider from
[tasklattice-litellm-guard](https://github.com/tasklattice/tasklattice-litellm-guard).
It exists to exercise the `litellm-generic-guardrail`
adapter, including protected WebSocket output streaming, against a locally
deployed `tali-guard` release. It is **not** part of the product chart and is
never installed by `npm run helm:deploy:dev`.

## Commands

| Command | Effect |
| --- | --- |
| `npm run helm:deploy:dev-with-litellm` | Build and deploy `tali-guard` (same as `helm:deploy:dev`), then pull the pinned LiteLLM image, wire a Guard Endpoint/Router, deploy this chart and run the smoke test |
| `npm run litellm:deploy:dev` | LiteLLM part only; requires a running `tali-guard` release in the same namespace |
| `npm run litellm:smoke` | Non-streaming, blocked-output and streaming calls through LiteLLM |
| `npm run litellm:status` / `npm run litellm:delete:dev` | Release status / uninstall (Guard-side Endpoint and Router are kept for reuse) |

## Image source and Provider compatibility

The image is `ghcr.io/tasklattice/tali-litellm:<litellm>-guard.<n>`, published by
tasklattice-litellm-guard. `values.yaml` pins the exact tag (`image.tag`); that
is the only place to change when adopting a new Provider release. `LITELLM_IMAGE`
overrides it for one run, for example to try a locally built
`ghcr.io/tasklattice/tali-litellm:dev` from a tasklattice-litellm-guard checkout.

Before installing, the deploy command runs `scripts/verify_relay_stream_image.py`.
It requires the image label `io.tasklattice.guard.output-stream-protocol` to equal
`OUTPUT_STREAM_PROTOCOL_VERSION` in `runner/output_streaming.py`, and the baked
Provider to contain the streaming endpoint. An incompatible image is refused
instead of failing at the first streamed completion. `LITELLM_SKIP_IMAGE_VERIFY=1`
installs it anyway; complete (non-streaming) checks then still work, protected
streaming is expected to fail.

## What the wiring script does

`scripts/litellm-dev-wire.mjs` signs in to the Controller with the development
administrator, then idempotently:

1. checks that the Default Guardrail has a published artifact;
2. finds or creates Endpoint `litellm-dev` (adapter `litellm-generic-guardrail`) and
   issues a fresh credential;
3. finds or creates Router `litellm-dev` with one fallback Route pinned to the
   Default Guardrail's active version, binds the Endpoint and publishes;
4. waits until the Runner verifies the Endpoint credential;
5. writes Secret `tali-litellm-dev-guard` (`api-base`, `api-key`) with
   `kubectl apply`. The credential never passes through Helm values or stdout.

`api-base` is the in-cluster Runtime Service URL
`http://tali-guard-runtime.<namespace>.svc.cluster.local:8091/runtime/v1/endpoints/<id>`.

Environment overrides: `GUARD_DEV_CONTROLLER_URL` (default `http://localhost:38081`),
`GUARD_DEV_RUNTIME_URL` (default `http://localhost:38082`), `GUARD_DEV_ADMIN_EMAIL` /
`GUARD_DEV_ADMIN_PASSWORD` (development defaults), `HELM_NAMESPACE`, `HELM_CONTEXT`,
`LITELLM_SKIP_SMOKE=1`.

## Ports

| Port | Service |
| --- | --- |
| 38080 | tali-relay (sibling project) |
| 38081 | Guard Controller |
| 38082 | Guard runtime (public dev Service) |
| 38083 | LiteLLM (this chart) |

## Business model

By default a synthetic OpenAI-compatible echo model
(`files/mock_openai_model.py`, run from the Guard Runner image) answers every
request, so the stack has no external dependency. Scenario tokens in the user
message select canned replies that are harmless on Input but must be handled on
Output: `[mock:leak-secret]` (synthetic cloud access key), `[mock:leak-pii]`
(synthetic e-mail and phone), `[mock:long]` (~2,000 characters for windowed
streaming). When calling the mock directly, headers `x-mock-response`,
`x-mock-chunk-delay-ms`, `x-mock-chunk-size` and `x-mock-status` also apply;
LiteLLM does not forward client headers upstream.

To use a real provider, set all three before deploying:

```bash
LITELLM_UPSTREAM_API_BASE=https://api.openai.com/v1 \
LITELLM_UPSTREAM_API_KEY=sk-... \
LITELLM_UPSTREAM_MODEL=gpt-4o-mini \
npm run litellm:deploy:dev
```

The mock model is then not deployed and `guarded-model` routes to the provider.

## LiteLLM UI

`http://localhost:38083/ui` (admin / password). The TaskLattice Guard guardrail
appears under Guardrails with `mode: pre_call, post_call`,
`unreachable_fallback: fail_closed`. Policy decisions are visible in the Guard
console under the `litellm-dev` Endpoint and Router.
