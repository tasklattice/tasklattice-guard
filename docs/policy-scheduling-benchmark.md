# Schedule benchmark: what the compiled order actually saves

The Controller compiles a Guardrail into an execution plan and **reorders**
compiler-owned checks: read-only Block checks first, then serial Transform steps,
then Allow observations. That reordering is only worth keeping if it is free of
semantic change (see
[`policy-composition.md`](./policy-composition.md) and
[`policy-scheduling-optimization-design.zh-CN.md`](./policy-scheduling-optimization-design.zh-CN.md))
and if it actually removes work. This document covers the second half.

Reproduce with:

```sh
.venv/bin/python scripts/benchmark_scheduling.py               # 50 iterations per cell
.venv/bin/python scripts/benchmark_scheduling.py --iterations 100 --json
```

The script compiles plans with the real Controller (`buildGuardrailPlan`) and
executes them with the real Runner and NeMo runtime, offline: no model provider
is contacted and no credentials are read.

## What is measured

| Metric | Why it matters | Trust level |
| --- | --- | --- |
| **Checks executed before the decision** | Every executed check is a potential model call, a potential provider timeout and a potential cost line. This is the product benefit of Block-first. | Deterministic: same plan and input always produce the same number |
| `p50` / `p95` wall clock | Catches a reordering that makes execution *slower* | Local detectors and NeMo dispatch only; dominated by fixed overhead |
| `decision` / matched Rules | Proves the reordering did not change the outcome | Deterministic |

Deliberately **not** measured here: model latency, provider retry behaviour,
token cost, streaming (`window_buffered` / `interruptible`) and custom Colang
plans, which keep their authored order and their own short-circuiting.

## Recorded run (2026-10-27, local, no model provider)

`--iterations 100`, macOS arm64, Python 3.13, local content-filter Rules only.

| scenario | schedule | scope | decision | checks executed | p50 ms | p95 ms |
| --- | --- | --- | --- | --- | --- | --- |
| mixed/blocked | block-first | interventions | block | 1 | 74.3 | 84.8 |
| mixed/blocked | block-first | full | block | 3 | 76.9 | 90.7 |
| mixed/blocked | authored | interventions | block | 2 | 75.2 | 78.5 |
| mixed/blocked | authored | full | block | 3 | 77.6 | 86.4 |
| mixed/allow | block-first | interventions | allow | 3 | 76.4 | 82.7 |
| mixed/allow | block-first | full | allow | 3 | 76.3 | 78.9 |
| mixed/allow | authored | interventions | allow | 3 | 76.0 | 79.0 |
| mixed/allow | authored | full | allow | 3 | 75.8 | 79.7 |
| blocks/blocked | block-first | interventions | block | 1 | 75.3 | 86.9 |
| blocks/blocked | block-first | full | block | 3 | 77.2 | 81.5 |
| blocks/blocked | authored | interventions | block | 1 | 74.7 | 76.9 |
| blocks/blocked | authored | full | block | 3 | 77.1 | 80.5 |

Scenarios:

- `mixed/blocked` — one Policy with a matching Transform Rule, a matching Block
  Rule and a matching Allow Rule on the same token. Worst case for an authored
  order, because the Transform would consume the token before the Block sees it.
- `mixed/allow` — the same Policy on input nothing matches: every check runs.
- `blocks/blocked` — read-only Block Rules only; the order cannot change anything.

## How to read it

1. **The optimisation saves checks, not microseconds.** In `mixed/blocked`,
   Block-first decides after 1 check while the authored order needs 2, and
   `blocks/blocked` confirms that read-only-only plans are unaffected (1 = 1).
   Translate the saved checks into latency with your own provider budget:
   `--assumed-remote-ms` (default 200 ms/check) prints that estimate.
2. **Local wall clock is flat, as intended.** The single-run difference is inside
   the noise of NeMo dispatch, so the reordering adds no measurable overhead on
   the local path.
3. **`full` costs the whole check set.** Requesting complete evidence (Validator,
   Scan API) makes a blocked request execute every reachable check: 1 → 3 here.
   That is the price of an honest report, and it is why the fast path stays the
   production default.
4. **No model-backed numbers exist yet.** A Guardrail with model checks needs a
   provider-backed run (token usage, provider p95, retry behaviour) before the
   latency claim leaves this document. Until then, treat the checks-executed
   column as the defensible statement and everything else as local overhead.

## Limits

- The recorded run is one machine, one iteration count, one plan shape. It is a
  regression reference, not a capacity plan.
- Parallel groups are not exercised here: this script uses serial plans so that
  check counts stay comparable. Concurrency gains need a provider-backed run.
- `full` evidence is structurally limited to `full_buffered` plans without custom
  Colang flows; see the capability matrix in
  [`policy-composition.md`](./policy-composition.md#evidence-capability).
