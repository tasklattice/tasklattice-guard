# Test architecture

The automated tests follow the same ownership boundary as the product. A
failure should say whether Controller produced the wrong state, Runner failed
to execute valid state, or the two sides could not converge.

| Gate | Command | Owns | Must not do |
| --- | --- | --- | --- |
| Control plane | `make test-control-plane` | Controller API/UI, plan flags, validation, compilation, signing, model configuration and activation | Make a real provider call |
| Data plane | `make test-data-plane` | Artifact verification, prewarm/activation, Runtime API, routing, enforcement, telemetry, last-known-good recovery and mocked model execution | Import the compiler or Validator |
| Communication | `make test-e2e` | Real Runner gRPC client/server stream, authentication, desired-state delivery and ACK/NACK convergence | Depend on an external model or Controller database |
| Contracts | `make test-contracts` | Protobuf generation, cross-language contracts, test-suite boundaries, Helm and release packaging | Exercise product behavior already owned by another gate |

`make test` runs all four gates, followed by Controller typechecking and the
production build.

## Artifact fixtures

Runner execution tests consume
`tests/fixtures/artifacts/local-secrets-v1/desired-state.pb.b64`. It is a
complete serialized `DesiredState` containing a deterministic, signed,
precompiled NeMo artifact plus Deployment and Integration routing. The fixture
contains only its public verification key; the deterministic private key lives
in the generator and is explicitly test-only.

Regenerate the fixture only when the compiler or artifact contract changes:

```bash
.venv/bin/python scripts/generate_test_artifacts.py
.venv/bin/python scripts/generate_test_artifacts.py --check
```

The control-plane gate checks that the committed bytes still match current
compiler output. The data-plane gate never calls the generator: it behaves like
a deployed Runner receiving immutable bytes from Controller. It verifies safe
input/output forwarding, unsafe blocking, authentication, corrupt-generation
rejection, and restart from last-known-good state.

## Model tests

Provider and Model Runtime behavior is tested inside Runner with in-memory
credentials and deterministic mocked provider responses. Tests cover provider
selection, capability/profile compatibility, timeout/error handling and actual
evaluation routing without network access or secrets. Controller tests cover
drafting, validation, activation, credential leasing and multi-Runner
convergence separately.

## Adding or changing a feature

New Python test modules must be placed under `tests/control_plane`,
`tests/data_plane`, `tests/e2e`, or `tests/contract`, or explicitly assigned in
`tests/conftest.py`. Collection fails for unclassified modules. A contract test
also rejects compiler or Validator imports from the data-plane suite.

For a new Guardrail flag, add a control-plane assertion that it survives plan
construction and compilation, then add a data-plane assertion using a refreshed
artifact fixture. For a protocol change, update both generated bindings and add
an ACK/NACK or compatibility assertion. For a model capability, test Controller
validation and Runner execution independently, using a mock response in Runner.
