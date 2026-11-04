# LiteLLM Provider development gateway

The optional `litellm-provider` block in [values.yaml](values.yaml) enables a
LiteLLM gateway, its PostgreSQL database and a synthetic model for testing the
`litellm-generic-guardrail` adapter, including protected output streaming.
All resources belong to the `tali-guard` chart and Helm release. The gateway is
disabled by default; there is no separate chart or release to maintain.

```yaml
litellm-provider:
  enabled: true
```

The gateway requires `security.bootstrap.enabled: true` and a Guard Endpoint
Secret with `api-base` and `api-key` keys. The development command creates that
Secret automatically. For a direct Helm deployment, create the Endpoint and
Secret first, then set `litellm-provider.guard.existingSecret`.

## Commands

| Command | Effect |
| --- | --- |
| `npm run helm:deploy:dev-with-litellm` | Build and deploy Guard first, verify the preloaded LiteLLM image, wire an Endpoint/Router, then enable the provider in the same release and run smoke checks |
| `npm run litellm:deploy:dev` | Enable/update the provider in an existing Guard release, preserving its configured values |
| `npm run litellm:smoke` | Check allowed, blocked-output and streaming calls through LiteLLM |
| `npm run litellm:status` | Show Guard release status and provider workloads |
| `npm run litellm:delete:dev` | Set `litellm-provider.enabled=false` in the Guard release; retain Guard and the Endpoint/Router |

All commands use `HELM_RELEASE` (default `tali-guard`), `HELM_NAMESPACE` (`tali`)
and `HELM_CONTEXT` (`orbstack`). Full development deployment uses the existing
`values-dev-uat.yaml` (`HELM_DEV_VALUES` can override it). Add further Helm
settings after `--`. There are no LiteLLM-specific release or values-file
variables. The provider-only enable/disable commands merge the chart defaults,
previous release values and explicit overrides. To keep the provider enabled
when using the ordinary Guard deploy command, save `litellm-provider.enabled`
in your environment values.

Existing installations of the former standalone `tali-litellm-dev` release
must uninstall that development release before enabling this component, to
free its LoadBalancer port. Its ephemeral model/database state is not migrated.

## Image source and compatibility

[tasklattice-litellm-guard](https://github.com/tasklattice/tasklattice-litellm-guard)
publishes `ghcr.io/tasklattice/tali-litellm:<litellm>-guard.<n>` with the Provider
baked in. `litellm-provider.image.tag` in the main `values.yaml` pins the version.
`LITELLM_IMAGE` overrides it for one deployment. Preload the image into local
Docker first; the deployment command never pulls it.

The deploy command runs `scripts/verify_relay_stream_image.py`. The image's
`io.tasklattice.guard.output-stream-protocol` label must match
`OUTPUT_STREAM_PROTOCOL_VERSION` in `runner/output_streaming.py`, and the Provider
must contain the streaming endpoint. `LITELLM_SKIP_IMAGE_VERIFY=1` bypasses this
check; protected streaming requires a compatible image.

The mock model reuses `runner.image`. Credential initialization reuses the
Guard bootstrap Job and `controller.image`; neither has a separate image pin.
The development values use preloaded images for LiteLLM and PostgreSQL as well.

## Endpoint wiring and credentials

`scripts/litellm-dev-wire.mjs` signs in to the Controller with the development
authoring account, verifies the Default Guardrail is published, then finds or
creates Endpoint `litellm-dev` with the `litellm-generic-guardrail` adapter. It
issues a fresh credential, binds a Router with a fallback Route to the active
Default Guardrail version, publishes, and waits for Runner verification.
It writes Secret `tali-guard-litellm-guard` with `api-base` and `api-key` using
`kubectl apply`. Credentials never pass through Helm values or stdout.

By default, `api-base` points to
`http://tali-guard-runtime.<namespace>.svc.cluster.local:8091/runtime/v1/endpoints/<id>`.
Wiring overrides include `GUARD_DEV_CONTROLLER_URL`, `GUARD_DEV_RUNTIME_URL`,
`GUARD_DEV_USER_USERNAME`, `GUARD_DEV_USER_PASSWORD`, `GUARD_DEV_RELEASE_NAME`
(the Guard resource-name prefix) and `LITELLM_GUARD_SECRET`. For further options,
see [the wiring script](../../scripts/litellm-dev-wire.mjs).

The shared pre-install/pre-upgrade/pre-rollback Job initializes the gateway's
database, master, UI and salt credentials. Managed names end in `-init`, and
repeated runs retain infrastructure credentials. Helm renders no Secrets.
The default runtime Secret is `tali-guard-litellm-init`; the smoke command reads
its master key unless `LITELLM_RUNTIME_SECRET` or `LITELLM_DEV_MASTER_KEY` is set.
Use `LITELLM_SKIP_SMOKE=1` to skip automatic smoke checks.

## Ports and model

LiteLLM is at `http://localhost:38083`, with its UI at `/ui`. Read the generated
UI credentials from the runtime Secret. Guard Controller/runtime use 38081/38082.
The optional Keycloak profile also defaults to 38083; set a different
`litellm-provider.service.port` when enabling both, and set `LITELLM_DEV_URL` to
that address for smoke checks.

By default, `files/litellm/mock_openai_model.py` serves synthetic replies without
an external model dependency. User-message tokens select output scenarios:
`[mock:leak-secret]`, `[mock:leak-pii]` and `[mock:long]`. Direct mock calls also
accept `x-mock-response`, `x-mock-chunk-delay-ms`, `x-mock-chunk-size` and
`x-mock-status`; LiteLLM does not forward client headers upstream.

To use a real OpenAI-compatible upstream, set
`litellm-provider.model.upstream.apiBase`, `.existingSecret` and `.model` together.
The referenced Secret contains `api-key` (override with `.apiKeyKey`). The mock
is then omitted and the default alias `guarded-model` routes to the upstream.
The development command accepts equivalent environment overrides:

```bash
LITELLM_UPSTREAM_API_BASE=https://api.openai.com/v1 \
LITELLM_UPSTREAM_SECRET=litellm-provider \
LITELLM_UPSTREAM_MODEL=gpt-4o-mini \
npm run litellm:deploy:dev
```

The configured TaskLattice Guard guardrail runs in `pre_call` and `post_call`
modes with `unreachable_fallback: fail_closed`. Inspect policy decisions under
the `litellm-dev` Endpoint and Router in the Guard console.
