# TaskLattice Guard

TaskLattice Guard checks prompts and model responses for AI applications and
gateways. It returns an allow, block, or text replacement decision for the
caller to apply.

- Detect sensitive data, prompt injection, harmful content, and off-topic
  requests with local Rules and model-backed checks.
- Build Guardrails from versioned Policies, test them, and publish immutable
  versions.
- Match requests by their attributes and split traffic across versions with
  weighted routing.

## Quick start

Enable Kubernetes in OrbStack and have Docker, Node.js 24+, uv, and Helm
available. From the repository root, run the following commands.

```sh
docker pull postgres:17-alpine
docker pull redis:7.4-alpine
npm run sync
npm run helm:deploy:dev
```

Sign in as `user` with the local development password `password` and try the
published **Default** Guardrail in **Playground**. Default uses local Rules.
[Local console](http://localhost:38081).

For model-backed checks, assign the Runner's built-in English Laya model for CPU
inference or connect an external Provider. [Model configuration](docs/document/en/admin/02-platform-models.mdx).

## Integrate an application

Bind an Endpoint to a Router whose Route Targets point to published Guardrail
versions. Use the Endpoint URL and credential to check input before calling the
model and output before delivering the response. The integration applies the
returned decision. [Gateway integration guide](docs/gateway-integration.md).

## Command line

`guardctl` uses the Controller management API. Use `platform` to configure
Models and capability bindings. Use `project` to test and publish Guardrails
or provision a Guardrail with an Endpoint and Router. The interactive shell
supports resource inspection and Guardrail package import and export.
[CLI manual](bin/README.md) and [configuration examples](docs/guardctl-configuration.md).

## Documentation

- [Guardrail lifecycle and testing](docs/document/en/overview/03-term-guardrail.mdx)
- [Kubernetes deployment](charts/tali-guard/README.md) and [operations](docs/operations.md)
- [Development and tests](docs/development.md) and [architecture](docs/architecture.md#components-and-ownership)
