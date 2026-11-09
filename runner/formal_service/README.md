# Reference formal proof service

A standalone authenticated HTTP implementation of `tali.automated-reasoning.v1`, using [Z3](https://z3prover.github.io/papers/programmingz3.html). It performs real constraint solving and returns rule evidence and counterexamples. It imports no Runner or Controller runtime state.

Install: `uv sync --extra formal --extra test`. Set a local `FORMAL_SERVICE_API_KEY` and optionally `FORMAL_SERVICE_POLICIES` to an absolute JSON catalog path. Start:

```sh
.venv/bin/uvicorn runner.formal_service.app:create_app --factory --host 127.0.0.1 --port 8093
```

Register `http://127.0.0.1:8093/evaluate` as the Provider URL and select `tali.automated-reasoning.v1` for its Model. The service accepts a bearer credential, authenticated `GET /evaluate` readiness, and `POST /evaluate` with `{policy: {id, version}, query_content, guard_content, confidence_threshold}`. Readiness is connectivity evidence only; the Controller requires valid and invalid proof examples through the Runner before saving the binding.

`policies.json` supplies `warranty-duration@1`: `warranty_years == 1`, domain `[0,100]`. Catalogs consist of versioned policies, bounded integer variables, and named rules with `variable`, `operator` (`eq/ne/lt/le/gt/ge`) and integer `value`. Change the version when changing a policy; restart to load a new catalog. The service keeps the loaded catalog fixed for its lifetime and returns a canonical policy digest with each solver response. Distribute this catalog separately from Guardrail packages, which carry the external policy reference.

The response must be completely translatable. The sample English grammar accepts `The warranty lasts one year.` (also numeric durations and the documented one/two/three/five/ten words). For general bounded integer claims, use:

```json
{"claims":[{"variable":"warranty_years","operator":"eq","value":1}]}
```

Unknown variables, additional prose, extra JSON fields, and unsupported grammar return `no_translations`. The query is required context and is never silently converted to a logical premise. The service does not use an LLM to guess meanings or prove arbitrary natural language.

For consistent policy constraints P and the conjunction of claims C:

- `P AND NOT C` unsatisfiable → `valid`, with supporting rule evidence.
- `P AND C` unsatisfiable → `invalid`, with contradictory rule evidence and a policy-consistent counterexample.
- Both satisfiable → `satisfiable`, not a proof of validity.
- Inconsistent P → `impossible`; solver timeout/unknown → `too_complex`.

Only complete deterministic translations get confidence 1. Each request has its own Z3 context, bounded variables/claims, a 2 second solver timeout and a resource limit. This is a reference service for explicit integer policies; deployment hardening and additional translation domains are separate work.

Tests: `.venv/bin/pytest tests/data_plane/test_formal_service.py tests/control_plane/test_studio_formal_context.py tests/control_plane/test_capability_validation.py`.

For OrbStack, build `Dockerfile.formal-proof` as `tali-formal-proof:policy-studio-20261012`, create a `formal-proof-credential` Secret containing `api-key`, and apply `runner/formal_service/kubernetes.yaml` in the desired namespace. It exposes only a ClusterIP Service; use `http://policy-formal-proof.<namespace>.svc.cluster.local:8093/evaluate` as the Provider URL. The image contains only FastAPI, Uvicorn, Z3 and the portable proof catalog. It is deployed independently of the Guard Controller/Runner chart.

Current regression coverage is in `tests/control_plane/test_studio_formal_context.py`, `tests/data_plane/test_formal_service.py`, and the Controller Policy publication/package PostgreSQL suites. The dated local Policy Studio acceptance harness has been retired; validate external proof-service connectivity using the setup above.
