# Rank Mode: Single Execution Mode for Guardrails

Status: proposed implementation specification for review. No runtime code has been changed.


## 0. Implementation status (2026-11-05)

Deployed to the OrbStack `tali` release and verified with the CLI:

- Default Guardrail local-only: 748/748 passed, 0 model invocations, p95 793 ms.
- All local Policy package suites: 1150 passed, 18 not run.
- Every step reads `previous_output`; the executed order is the authored Policy
  order and the Rule order inside each Policy.
- A candidate currently covers a contiguous run of Rules with the same action.
  The content-filter Action applies those Rules sequentially, so continuous
  Transform and later-Block semantics are preserved, but the trace has one
  Action entry per run rather than one per Rule.
- Independent Allow/Block candidates in the same content version share a
  parallel segment. A Transform-capable candidate is a segment barrier; later
  candidates read the rewritten content. A model Policy authored after a local
  Transform receives the redacted content (covered by
  `test_default_model_runtime.py`).
- Trace evidence carries `rank`, `policyRank`, `ruleRank` and
  `view=previous_output`. Disabled Rules retained in `ruleOrder` keep their
  rank slot; enabled candidates do not renumber around them.
- Custom Colang flows are rejected at compilation. They have no expandable Rule
  rank; declarative Rules must be used instead.
- Streaming still uses the existing buffered/incremental delivery decision; the
  dedicated Rank Mode streaming adapter is not yet separate from that path.

## 1. Purpose

Rank Mode is the only execution mode for Guardrail checks.

It replaces the current local-first scheduler. The scheduler has one name: `local-first`; there is no V1/V2 distinction, no legacy execution mode and no silent fallback to a different decision model.

The goals, in order:

1. **Correctness**: the final decision is a deterministic function of normalized candidate outcomes and declared rank.
2. **Continuous redaction**: multiple Transform outcomes accumulate in rank order.
3. **Performance**: independent Allow/Block checks run concurrently where semantics allow; Transform is a content-version barrier.
4. **Observability**: every decision explains every candidate, every transform, every block, every cancellation and every failure.
5. **Operability**: a failed report identifies the rank and the corrective action.

## 2. Decision model

The platform keeps NeMo's three native outcomes:

```text
Allow
Transform
Block
```

- `Allow` records the check and continues.
- `Transform` rewrites the current content and continues with the new content.
- `Block` stops the phase immediately.

Final phase decision:

```text
if any candidate returned Block:
    final = Block
elif any candidate returned Transform and the content changed:
    final = Transform
else:
    final = Allow
```

Transform is not normalized to Allow. A test expecting Transform that receives Block must fail. A test expecting Block that receives Transform/Allow must fail.

**Contract B is the chosen product contract.** Priority is the execution sequence, not a winner-take-all choice:

- a Transform modifies content and later candidates continue on the new content;
- a later Block can therefore block content that was already transformed;
- a Transform never overrides a Block;
- Contract A (first decisive result wins, later candidates never run) is not supported.

## 3. Reuse boundary with NeMo Guardrails

Reuse NeMo `RailOutcome` and its three decisions as the per-candidate execution result.

Do **not** reuse NeMo's rail ordering for candidates:

- `_transforms_first()` moves all rewriting rails ahead of judging rails.
- NeMo parallel mode disables execution when any rewriting rail is present.
- NeMo ordering is not our `(policyRank, ruleRank)`.

Rank Mode therefore owns the orchestrator:

```text
Rank orchestrator: order candidates, apply transforms, stop on block
NeMo: execute one candidate/action and return RailOutcome
```

Do not pass a ranked candidate list to the NeMo rail manager and assume that NeMo preserves our order.

## 4. Candidate model

For each phase, build candidates from the Guardrail's enabled Policies and Rules.

```json
{
  "rank": [3, 1],
  "policy_id": "local-credentials",
  "policy_version": "1.0.0",
  "rule_id": "credential/password",
  "phase": "input",
  "declared_action": "transform",
  "execution": "local",
  "capability": "builtin_content_filter",
  "contract_ref": "tali.guard.content-filter.rules.v1",
  "failure_mode": "fail_closed",
  "on_unknown": "block",
  "content_view": "segment"
}
```

### 4.1 Rank assignment

```text
policyRank = index in the Guardrail's ordered policyBindings
ruleRank = index in the effective Rule order for that Policy and phase
```

Effective Rule order:

1. Validate the full `ruleOrder` against the Policy's complete Rule set: every ID must exist and no ID may repeat.
2. Reject unknown or duplicate IDs; a disabled Rule ID is valid and must not be rejected.
3. Assign positions from the validated full order, including disabled Rules.
4. Append Rules not present in the explicit order in Policy definition order.
5. Then filter out disabled Rules and Rules that do not apply to the phase.
6. Keep the assigned positions; do not renumber after filtering.

The editor keeps a disabled Rule in its ordering slot, so rejecting disabled IDs would make a legal reorder-then-disable sequence fail compilation.

Use a two-part rank `(policyRank, ruleRank)`. Ranks may have gaps after filtering; a phase candidate set is sparse. If a wire format requires an integer, define a validated `MAX_RULES_PER_POLICY` and reject overflow; do not use an undocumented stride.

Use a two-part rank `(policyRank, ruleRank)`. If a wire format requires an integer, define a validated `MAX_RULES_PER_POLICY` and reject overflow; do not use an undocumented stride.

### 4.2 Phase filtering

Phase filtering happens after rank assignment. Filtering must not renumber candidates. A phase candidate set may be sparse.

### 4.3 Segment content snapshot and candidate input

Every segment owns an immutable input snapshot:

```text
SegmentInput {
    phase
    content
    content_version
    messages            # user/bot message context rewritten to match content
    content_blocks      # offsets/blocks belonging to this content version
    request_context
}
```

Candidate execution MUST receive this snapshot. It must not use the old
`content_view = "original"` path, which re-reads the original phase request and
would make a later Block inspect pre-redaction content.

Rank Mode additions:

- `content_view = "segment"` is the only view for local content-filter and
  model evaluator candidates;
- after a Transform commits, the orchestrator builds a new `SegmentInput`:
  - rewritten `content`;
  - updated `messages` (user or bot message);
  - updated `content_blocks` and offsets;
  - incremented `content_version`;
- the next segment receives that new snapshot;
- candidates return an independent `CandidateOutcome`; they do **not** mutate
  shared `current_text` or `proposed_action`;
- only the orchestrator commits official content and official decision;
- diagnostic candidates receive a copy; their Transform cannot mutate the
  official snapshot or output.

File-level consequence: `runner/toolkit/nemo/runtime.py` must add the
`segment` content view and stop preferring the original request for Rank Mode
candidates. The existing `original` read path remains only for non-Rank legacy
internals that are removed in the greenfield cutover.

## 5. Candidate normalization

Normalize every raw result before applying the ordered loop.

| Raw result | Configuration | Normalized candidate outcome |
|---|---|---|
| matched(block) | — | decisive Block, `evidence_kind = matched` |
| matched(transform) | — | decisive Transform, `evidence_kind = matched` |
| matched(allow) | — | observational Allow, `evidence_kind = matched`; never terminates |
| not_matched | — | observational Allow, `evidence_kind = observed` |
| unknown | `on_unknown = allow` | observational Allow, `evidence_kind = unknown_fallback` |
| unknown | `on_unknown = transform` | decisive Transform with a concrete rewrite; Block if no rewrite exists |
| unknown | `on_unknown = block` | decisive Block, `evidence_kind = unknown_fallback` |
| error/timeout | `failure_mode = fail_open` | observational Allow, `evidence_kind = execution_error` |
| error/timeout | `failure_mode = fail_closed` | decisive Block, `evidence_kind = execution_error` |
| skipped/cancelled | — | no outcome; record reason |

Only Block and Transform are decisive. A matched Allow is real evidence but does not stop or decide the phase.

This makes Laya `unknown` distinguishable from a real match while preserving its configured decision.

## 6. Ordered phase algorithm

```text
run_phase(candidates, initial_content):
    initial = initial_content
    content = initial_content
    content_version = 0
    transform_seen = false
    evidence = []

    for candidate in candidates ordered by rank:
        outcome = execute(candidate, content)

        evidence.append(outcome)

        if outcome.decision == Block:
            return Block(
                content=content,
                content_version=content_version,
                blocking_candidate=outcome,
                evidence=evidence,
            )

        if outcome.decision == Transform:
            transform_seen = true
            content = outcome.rewritten_text
            content_version += 1
            continue

        # Allow: continue

    net_changed = content != initial

    return Transform(
        content=content,
        content_version=content_version,
        transforms=evidence.transforms,
        net_changed=true,
        evidence=evidence,
    ) if net_changed else Allow(
        content=initial,
        content_version=content_version,
        transforms=evidence.transforms,
        net_changed=false,
        evidence=evidence,
    )
```

Consequences:

- Multiple transforms accumulate in rank order: password, phone, API key can all be redacted.
- A higher-priority Block stops before lower transforms.
- A lower-priority Block after transforms evaluates the transformed content and can block it.
- Allow never stops the loop.
- The final action is Transform only when the final official content differs from the initial content. A transform that rewrites nothing, or a later transform that restores the original text, yields final Allow while retaining `transforms` evidence and `net_changed = false`.

### 6.1 Resolver and scheduler are separate

The resolver is pure:

```text
resolve_official(ordered_outcomes, initial_content) -> decision + content
```

It never cancels, starts or stops a candidate. It applies the outcomes it is given in rank order and returns the official decision.

The scheduler owns execution and evidence collection.

**Online execution**

- Stops scheduling new candidates after the first official Block.
- Cancels candidates with greater rank that cannot affect the official decision.
- Reports `not_executed` and `cancelled` honestly.
- Official decision is the prefix up to that Block.

**Full validation**

- Produces the same official decision as online execution for the same candidate outcomes.
- If no Block occurs, it runs every executable candidate and transforms accumulate normally.
- If a Block occurs at rank `k`, the official decision is fixed at that Block. The official content is frozen at the Block's content version.
- Full validation may continue lower-ranked candidates in **diagnostic mode**:
  - diagnostics evaluate a copy of the frozen official content;
  - a diagnostic Transform may update only the diagnostic copy, never official content or output;
  - every post-Block result is marked `diagnosticOnly = true`;
  - diagnostic results cannot change the official decision or the stored output.
- Alternatively, a deployment may disable post-Block diagnostics; the report then marks lower-ranked candidates `not_reached_after_block`. It must not claim they were executed.

This resolves the conflict between “run everything for evidence” and “Block stops the phase”. The resolver decides; the scheduler chooses online vs full-validation collection.

## 7. Execution segments and parallelism

Transform is a content-version barrier. A candidate after a transform must inspect the new content.

Parallelism is allowed only between transforms.

### 7.1 Execution segments

Split the phase candidate sequence into segments:

```text
segment 0: non-transform candidates before the first transform-capable candidate
transform candidate T1
segment 1: non-transform candidates before T2
transform candidate T2
...
```

A candidate is transform-capable when:

- its declared action is Transform; or
- its unknown fallback may be Transform; or
- a reviewed override may produce Transform.

Conservative rule: if a candidate may transform, close the current segment and execute it at the barrier.

### 7.2 Segment execution

Within a segment:

- Start local and model candidates concurrently, bounded by the local and model semaphores.
- Results are committed by rank, not arrival time.
- If a candidate returns Block:
  - wait for any unresolved candidate with a smaller rank; it cannot be cancelled because it could outrank the Block;
  - once all smaller ranks are resolved and the Block is still the official first Block, cancel candidates with greater rank;
  - do not start later segments.
- In full-validation mode, the scheduler may collect post-Block diagnostics under the rules in section 6.1.
- If all segment candidates are Allow, continue to the transform barrier.

At a transform barrier:

- Execute the transform candidate(s) sequentially.
- Apply the rewrite and increment `content_version`.
- Invalidate speculative results computed against the old content version.
- Start the next segment with the new content.

### 7.3 Scheduling policy

Scheduling is runtime tuning, not a product-semantic choice:

- Default: start all candidates in a segment with a bounded model speculative budget.
- Cost-sensitive deployments may configure local-first within a segment.
- Cancellation cannot un-send model requests; speculative waste is measured and reported.

Local-first must not skip model candidates after a local Transform. Under Contract B, Transform is not terminal: only a Block can stop the phase. “Local-first” may skip model work only after a decisive Block, never after a Transform.

NeMo's `_run_rails_parallel` is not used for transform-capable candidates.

## 8. NeMo candidate executors

Rank Mode needs one outcome per candidate, not one outcome for a bundle of rules.

### 8.1 Local content-filter candidates

- Execute one Rule (or one explicit Rule group) with `BuiltinContentFilter` against the current content.
- Return Allow/Transform/Block plus findings, spans and replacement.
- Apply the rewrite before the next candidate.
- Do not bundle multiple ranked Rules into one opaque action for the Rank Mode path.

### 8.2 Model evaluator candidates

- Invoke the existing model evaluator through its action provider.
- Normalize capability result to Allow/Transform/Block.
- Record model call ID, provider, retries and latency.
- Model candidates run concurrently only inside a segment.

### 8.3 Atomic native/custom candidates

Native/custom Colang Flows cannot guarantee internal Rule rank. Rank Mode v1 rejects them at compilation with `unsupported_rank_mode_flow`.

A Flow must be expanded into Rule candidates before it can participate in Rank Mode. There is no atomic Flow candidate and no “runs at this rank but is internally unranked” exception.

## 9. Streaming

NeMo declares Transform outcomes non-streaming. Rank Mode supports both delivery paths, but their treatment of Transform differs:

### 9.1 Full-buffered

- Transform is applied normally.
- Final decision and transformed content are available before delivery.

### 9.2 Streaming output

Streaming capability is a property of the whole enabled check set, not of the final action.

Rank Mode MUST preserve the existing incremental-check contract
(`runner/toolkit/runtime/streaming.py`): a response may be released
incrementally only when every required evaluator supports incremental
inspection. Grounding, formal reasoning and other checks that need the complete
response force full buffering even if all configured actions are Block.

Therefore:

- If the plan contains a Transform-capable candidate: full buffer until the
  phase completes, apply transforms in rank order, then emit the transformed
  output. A Block emits no content.
- If all candidates are Allow/Block but any candidate is not incremental-safe:
  full buffer. A Block emits no content.
- If all candidates are Allow/Block and all are incremental-safe: stream deltas
  using the existing delivery contract. A Block terminates the stream.
- The existing streaming path must drive checks in Rank Mode order, not NeMo
  rail order.

Evidence must report:

```text
delivery = streamed | buffered_transform | buffered_non_incremental
streamEligible = true | false
nonIncrementalCandidates = [...]
```

This is not “streaming Transform”; it is buffered redaction inside a streaming request. A later reduced-buffer/windowed implementation must preserve the same decision and output semantics before replacing the full buffer.

## 10. Observable evidence

### 10.1 Candidate result

```json
{
  "rank": [3, 1],
  "policyId": "local-credentials",
  "policyVersion": "1.0.0",
  "ruleId": "credential/password",
  "phase": "input",
  "execution": "local",
  "rawOutcome": "matched",
  "decision": "transform",
  "evidenceKind": "matched",
  "contentVersionIn": 1,
  "contentVersionOut": 2,
  "rewrites": [{ "target": "user_message", "before": "...", "after": "..." }],
  "startedAt": "...",
  "durationMs": 8,
  "modelCallId": null,
  "provider": null,
  "model": null,
  "retries": 0,
  "errorClass": null,
  "failureMode": "fail_closed",
  "onUnknown": "block",
  "cancelledReason": null,
  "status": "matched"
}
```

### 10.2 Phase decision

```json
{
  "decision": "transform",
  "contentVersion": 2,
  "transforms": [
    { "rank": [3, 1], "policyId": "local-credentials", "ruleId": "credential/password" },
    { "rank": [8, 0], "policyId": "local-contact-data", "ruleId": "pattern/phone" }
  ],
  "block": null,
  "unknownFallbacks": [],
  "executionErrors": [],
  "cancelled": [],
  "segments": [
    { "index": 0, "candidates": 4, "parallel": true },
    { "index": 1, "candidates": 2, "parallel": true }
  ],
  "scheduler": "rank-mode-v1",
  "executionMode": "online"
}
```

### 10.3 Reports

The Testing Report and runtime event must show:

- final decision;
- every transform in rank order and the output content;
- the blocking candidate and rank;
- unknown fallbacks and their configured action;
- execution errors and failure mode;
- cancelled/not executed candidates with reasons;
- content version transitions;
- online vs full-validation evidence;
- delivery mode for streaming (`streamed` or `buffered_transform`).

## 11. Metrics

```text
guard_runner_candidate_total{execution,decision,evidence_kind,status}
guard_runner_candidate_duration_seconds{execution,decision}
guard_runner_model_calls_total{provider,outcome}
guard_runner_model_calls_speculative_total
guard_runner_candidates_cancelled_total{reason}
guard_runner_transform_total{policy}
guard_runner_unknown_fallbacks_total{on_unknown}
guard_runner_execution_errors_total{failure_mode}
guard_runner_content_versions_total
guard_runner_phase_duration_seconds{phase,delivery}
guard_runner_scheduler_fallback_total
```

## 12. Troubleshooting

| Symptom | Check | Fix |
|---|---|---|
| Expected Transform, got Block | Blocking candidate rank; transforms before it | Reorder or change the Block Rule; do not shadow-pass |
| Expected Block, got Transform/Allow | All candidates; unknown/errors | Fix detector, action, on_unknown or failure mode |
| Missing a redaction | Transform sequence; contentVersion; later candidate status | Ensure candidate ran after the correct transform |
| Streaming Transform ignored | `delivery` and buffer evidence | Use buffered transform; fix adapter |
| Model called unnecessarily | Segment/speculative evidence; cancellation timing | Configure local-first or reduce speculative budget |
| Slow mixed phase | Segment barriers; model durations | Cache/dedupe; reduce transform-capable candidates |
| Nondeterministic | Sequential replay with same outcomes | Fix scheduler; isolate model nondeterminism |
| Native Flow not ranked | Compilation rejected | Expand the Flow or use a supported candidate type |

## 13. Correctness tests

1. Multiple transforms accumulate.
2. Block before a Transform stops.
3. Block after a Transform changes the final decision to Block.
4. Allow never stops Transform/Block.
5. Unknown `on_unknown` block/allow/transform.
6. Fail-closed/fail-open errors.
7. Transform order and content versions.
8. Segment parallelism preserves decision and output.
9. Cancellation never cancels a smaller rank.
10. Online and full validation agree on the official decision and output for equivalent candidate outcomes.
11. Online execution sets are not required to match across runs, but every cancellation must be causally valid and no smaller-rank candidate may be lost.
12. Full-validation post-Block diagnostics use the frozen Block content version; diagnostic transforms never change the official decision or output.
13. A disabled Rule retained in `ruleOrder` does not fail compilation.
14. Transform expectation versus Block actual fails with evidence.
15. Streaming buffered transform produces the same output as full-buffered.

## 14. Implementation plan

### Phase 1: sequential Rank Mode

- Add candidate/rank structure to the plan.
- Implement normalization and ordered executor.
- Use it in validation first.
- Add candidate evidence to validation reports.
- Keep execution sequential; no parallel segments.
- Tests 1-7, 10-11.

### Phase 2: execution segments

- Add local/model bounded pools.
- Add segment splitting at transform-capable candidates.
- Add rank-ordered commit and cancellation.
- Add sequential fallback using the same semantics.
- Tests 8-9.

### Phase 3: delivery and operations

- Add streaming buffer for Transform.
- Add metrics, dashboards, UI explain view.
- Add speculative budget configuration and benchmarks.
- Tests 12.

### Phase 4: greenfield cutover

The project is still in development and has no historical compatibility target.

- Rename the current scheduler to `local-first`; no V1/V2 suffix.
- Compile every development Guardrail once with Rank Mode.
- Reject unsupported native/custom Flow plans instead of keeping them as atomic
  candidates.
- Delete the old execution path; do not build artifact migration or dual-mode
  compatibility.
- Recreate development Guardrails/test data as needed; there are no released
  artifacts to protect.

## 15. File-level work

- `controller/server/domain/guardrail-plan.ts` / `controller/server/domain/execution-plan.ts`: emit candidate ranks; replace the `local-first-v2` label with `local-first`.
- `runner/toolkit/compiler`: stop emitting the old local-first schedule for new plans; validate candidate ranks.
- `runner/toolkit/runtime/ranked.py` (new): normalizer, ranker, segment executor, ordered decision.
- `runner/validator.py`: call Rank Mode for validation; attach candidate evidence.
- `runner/toolkit/nemo/actions/content_filter.py`: expose per-Rule outcomes and transforms for Rank Mode; retain only for non-ranked legacy internals if needed.
- `runner/toolkit/nemo/runtime.py`: per-candidate action execution; `segment` content view; streaming buffered/incremental adapter.
- `runner/toolkit/runtime/streaming.py`: preserve incremental-check eligibility; Rank Mode ordering.
- `proto/.../runner_control.proto`: candidate evidence, transform sequence, block rank, execution mode.
- `controller/server/services/report-results.ts`: persist candidate evidence.
- `controller/src/components/guardrail-testing*`: Why-this-decision view.
- Tests: unit resolver, integration validation, streaming, PostgreSQL report.

## 16. Non-goals

- No second execution mode. Sequential execution is a debug/fallback implementation of Rank Mode, not a different decision model.
- No NeMo rail ordering for candidate priority.
- No parallel Transform execution.
- No atomic native/custom Flow candidates; unsupported Flows are rejected.
- No promise of zero speculative model calls with parallel execution.
- No silent normalization of Transform to Allow.
- No legacy artifact migration; the project is greenfield.

## 17. Review checklist

- [ ] Rank assignment is unique, validated and stable across phases.
- [ ] A disabled Rule retained in `ruleOrder` is accepted and keeps its position.
- [ ] Matched Allow is observational; only Block/Transform are decisive.
- [ ] Transform is continuous and content-versioned.
- [ ] Block stops official execution; later candidates are not presented as executed.
- [ ] Unknown and errors normalize before the ordered loop.
- [ ] Resolver is pure; scheduler owns cancellation and online/full-validation collection.
- [ ] Full-validation post-Block diagnostics use frozen content and never mutate the official result.
- [ ] Segment parallelism cannot change decision or output.
- [ ] Cancellation never loses a smaller-rank candidate.
- [ ] Streaming Transform is buffered, not silently dropped.
- [ ] Every decision reports candidate ranks, transforms, block, unknown, errors and delivery mode.
- [ ] Candidate input uses the segment snapshot; no `original` request re-read after a Transform.
- [ ] Candidate executors do not mutate shared official state; diagnostics are isolated.
- [ ] Streaming eligibility preserves non-incremental checks; Transform is buffered.
- [ ] Final action is Allow when transforms net to no content change.
- [ ] Current scheduler is named `local-first`; there is no V1/V2 compatibility path.
- [ ] Native/custom Flow plans are rejected unless expanded to candidates.
