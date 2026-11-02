# Model Configuration

The Default Guardrail requires validated `jailbreak.input`, `content_safety.input`,
and `content_safety.output` model bindings, followed by its local checks. Missing
bindings prevent preparation; model failures fail closed. Provider connectivity,
model callability, assignment to a protection check, and full Default validation
are separate steps. See [Default requirements](guardrail-policies.md).

## Providers, Models, and Guardrail Catalog

The Helm install command does not read model configuration or credentials from
`.env` and does not create Provider Secrets. Runtime model configuration has four
separate UI owners:

| Settings page | Responsibility |
| --- | --- |
| Health | Global Controller, baseline Guardrail, Runner convergence, and active model-binding readiness |
| Providers | Endpoint, encrypted credential, discovery, connectivity, and Provider-scoped TLS policy |
| Models | Registered inventory plus one real callability check per physical model |
| Guardrail Catalog | Rail-specific model assignment, behavioral validation, Save, and activation |

A callable model is not automatically used by a Rail. The active Guardrail
Catalog revision maps a stable binding such as `content_safety.input`,
`content_safety.output`, or `jailbreak.input` to one registered model. One model
may serve multiple bindings when its explicit protocol profile supports each
contract. Input and Output assignments remain independent.

DeepSeek Providers are control-plane-only. Controller rejects DeepSeek as a
Data Plane assignment and projects only models referenced by active Data Plane
bindings—and only their credentials—to Runner. Data Plane Rails must use a
purpose-built or bounded low-parameter model. This boundary is enforced by the
API and desired-state protocol, not only by filtering a browser dropdown.

The current executable Rail surface is Input and Output. Retrieval, Dialog, and
Execution are reserved manifest values for later expansion; adding them extends
the shared binding manifest without changing Provider, Model, Policy, or
Guardrail ownership.

## NVIDIA Content Safety response compatibility

The `tali.nemotron-safety-guard-v3.v1` profile uses the `User Safety` field for
input and `Response Safety` for output. It accepts `safe` / `unsafe` and the
observed, unambiguous aliases `safe rating` / `unsafe rating`, with outer
whitespace and case normalized. The model's original output remains in native
evidence. Ambiguous text such as `safe or unsafe rating`, a missing field, or
invalid JSON remains an execution error and follows fail-closed handling.
This compatibility rule does not change model prompts or probability thresholds.

NVIDIA's `Manipulation` category maps to the existing `TALI-SOCIAL-HARM` parent
with partial mapping quality. An explicit unsafe verdict in this category is
a model match, not an abstention caused by a missing taxonomy mapping. Category
mapping never turns a native safe verdict into a block.

For benchmark comparison, human prompt-safety labels (for example Aegis test)
belong to `content_safety.input`. They are not jailbreak-attempt labels, PII
redaction spans, or proof of a successful multi-turn attack. Keep original
labels, exclude unavailable text explicitly, and report uncertainty-based
blocks separately from explicit matches.

## Dedicated JailbreakDetect or a chat-based judge

`nvidia/nemoguard-jailbreak-detect` is an additional implementation of the existing
`tali.guard.jailbreak.v1` capability, alongside an OpenAI-compatible chat judge and
Qwen3Guard. It does not add a new scenario, modify Policies, or recompile Guardrail
artifacts when the selected detector changes.

- **NVIDIA hosted:** use the existing NVIDIA NIM Provider
  (`https://integrate.api.nvidia.com/v1`). Discovery includes JailbreakDetect as a
  supported endpoint candidate even when it is absent from the chat catalog.
  Registration makes an actual call; a catalog entry does not prove availability.
  Only this exact public NVIDIA origin is mapped to the official security API.
- **Self-hosted NIM:** register a Provider using its full
  `https://your-nim-host/v1/classify` URL. Discovery checks that classifier directly;
  a Chat Completions or `/models` endpoint is not required. Custom gateway prefixes
  remain intact and never redirect to NVIDIA's public service.
- Register the model in **Models**, then select it for **Jailbreak detection** in
  **Guardrail Catalog → Input**, validate, save, and activate. The protocol is inferred for the
  canonical model ID; deployment aliases can use the existing protocol settings.
  Any chat model that supports OpenAI-compatible Chat Completions can instead use
  the `tali.openai-compatible-jailbreak.v1` profile and must return `SAFE` or
  `JAILBREAK` for the supplied classification prompt.

The dedicated client sends raw user input as `{"input":"..."}` and strictly
checks the native `jailbreak` boolean and finite `[-1, 1]` `score`. It uses the
service's boolean decision, not an invented local threshold. It does not send
chat prompts, model IDs, or generation parameters. **Models → Test call** checks
the response envelope only; **Guardrail Catalog → Validate** runs both benign and
jailbreak smoke samples. These samples do not constitute a comprehensive accuracy
benchmark. Classification errors remain errors and follow the Guardrail's failure
policy; they never become a safe verdict. This detector is input-only.

Tests are separated by architectural ownership: Controller tests cover registration,
endpoint routing, validation, and assignment; Runner tests load the frozen signed
`jailbreak-v1` artifact and exercise both detectors through the real runtime API
without importing the compiler or contacting external model services. Both sides
also test Provider-scoped self-signed TLS behavior.

Protocol references: [NVIDIA hosted classification API](https://docs.api.nvidia.com/nim/reference/nvidia-nemoguard-jailbreak-detect-infer)
and [self-hosted NIM request/response examples](https://docs.nvidia.com/nim/nemoguard-jailbreakdetect/latest/getting-started.html).

## TypeSafe Jev for input Content Safety, Jailbreak and Topic Control

Business and company boundaries use the Topic Control Policy's independent
Denylist and Allowlist Rules. Both use the single `topic_control.input` binding
and `tali.guard.topic-control.semantic.v1` contract. Configure allowed tasks,
denied tasks and strict/permissive mode on the Policy binding. The Denylist runs
first and blocks matching tasks even when an allowed task is also present.
Choose a compatible taxonomy judge, NeMoGuard Topic Control model or Jev for this
binding. Company Policy and its separate model binding have been removed;
existing configurations must be recreated using Topic Control.

Register **TypeSafe AI** under **Settings → Providers** with the API base URL
`https://api.typesafe.ai/v1` and your TypeSafe API key. Click **Choose models** to
select a version directly; `jev-1.13.0` is preselected. Discovery is optional:
**Fetch catalog (optional)** retrieves account aliases without discarding your
selection. Pinned versions may be accepted even when absent from `/models`.
You can select `jev-latest` to follow releases or enter another version/alias
manually. Registration always checks the selected IDs with actual calls, including
when discovery fails. TypeSafe registrations use the
`tali.typesafe-jev.v1` profile, including custom model aliases. The retained
`tali.typesafe-jev-topic.v1` profile remains input-topic-only for existing configurations. The native
transport is `typesafe_systemone`: discovery reads `/models` (`models[].name`),
and evaluation posts `model`, `state`, and typed `questions` to `/systemone`.
Chat generation settings such as `max_tokens` are not sent.

Deploy the Controller and Runner with TypeSafe support together with the UI.
An older Controller rejects `kind: "typesafe"` at request validation, before
contacting TypeSafe; skipping discovery does not bypass that schema incompatibility.
The running Controller's `/api/openapi.json` must include `typesafe` in the Provider
kind enum. Keep the Provider → Model → detector binding structure: credentials and
endpoint belong to the Provider, while the version and evaluator profile belong
to the Model, preserving switching and rollback.

Assign the same registered model independently to **Guardrail Catalog → Input → Topic Control**,
**Jailbreak detection**, and **Content Safety**, validate each candidate, save, then activate through the existing revision workflow. Registration
checks callability; each binding validation executes its own benign and off-topic
or unsafe samples through NeMo. The multi-purpose profile supports `tali.guard.topic-control.semantic.v1`,
`tali.guard.jailbreak.v1`, and `tali.guard.content-safety.v1` on input. It does not advertise output or PII.
Content Safety uses its own `unsafe_content` question and the same 23-category taxonomy as the NVIDIA
Safety Guard v3 adapter. Direct harmful requests do not need a jailbreak mechanism to match.
The versioned question and native probability are retained in evidence. Probabilities between 0.1 and 0.9
remain `unknown`; an enforced unknown block is not an explicit model match. These thresholds are
operating points, not a calibrated quality guarantee. NVIDIA remains the default
Content Safety preference. Replacing the input binding does not change output or
other detector assignments.
NVIDIA Topic Control and the chat taxonomy judge remain selectable. Switching a
binding uses the existing revision/rollback mechanism. Old artifacts that explicitly
pin a native NVIDIA `topic_control` model still require that native dependency;
republish them with the current Topic Policy (2.0.0) before switching to Jev.

`TopicJudgeActionProvider` retains the stable NeMo action name and delegates to a
`GuardEvaluator`. `JevTopicEvaluator` and the existing `ChatTopicEvaluator` return
the same `EvaluationResult`; rule actions remain owned by the runtime. Jev asks
whether any requested task matches denied topics and, in strict mode, whether any
substantive task falls outside the union of allowed topics. Split allowlist and
denylist rules keep independent questions and their existing ordering. Context
resolves follow-ups; labels and annotation metadata are never sent as model input.

`JevJailbreakEvaluator` uses the versioned question set `jailbreak-input.v1`.
It checks explicit instruction overrides and indirect attempts to bypass safety
boundaries through fiction, roleplay, research or authority pretexts, translation,
and obfuscation. The judge considers the actual requested output and whether the
framing functions as a bypass. Harmful subject matter alone is not a jailbreak.
Benign roleplay, defensive analysis, quotation/translation without executing an
attack, and changes to the user's own formatting preferences are excluded.
The independent `jailbreak_attempt` and `unsafe_pretext` questions share one native
HTTP request. Either positive answer yields `matched`; both must be negative for
`not_matched`; otherwise the result is `unknown`. Evidence retains both answers.
Both evaluators reuse the same native transport, strict response parser and usage
tracking; neither sends a Chat Completions request or generation parameters.
The dedicated NVIDIA detector and existing chat-based jailbreak judges remain
available on the same Jailbreak binding.

The initial profile uses a lower threshold of **0.1** and an upper threshold of
**0.9**. Any violation probability at or above the upper threshold yields
`matched`; all required probabilities at or below the lower threshold yield
`not_matched`; the remaining cases yield `unknown`. Invalid/missing answers,
authentication failures, rate limits and timeouts yield `error`, never a safe
classification. Calls are bounded by the evaluation deadline; connection setup
failures may retry once within that same deadline (see below). These thresholds
are starting points, not calibrated quality guarantees.
For blocking or transforming Rules, the runtime conservatively blocks a terminal
`unknown` result in enforce mode. An explicitly configured `allow` (observation-only)
Rule records the uncertainty and continues; it must not start blocking on abstention.
Observation-only matches are traced as observations rather than blocked Rails.
Infrastructure errors still follow the configured failure mode, independently of
model uncertainty. Keep these uncertain interventions separate from positive model
detections when interpreting Report recall; a blocked request is not necessarily
a positive JEV classification. Existing failure handling remains unchanged. Trace evidence
stores question revision, requested/returned model, thresholds and raw probabilities
for all successful evaluations; Noul probabilities are not reported as confidence
or severity scores.

Testing clients may opt into structured JEV jailbreak evidence with the request
header `X-Guard-Evidence: evaluations-v1`. LiteLLM and F5 Scan responses include
`X-Guard-Evaluation-Evidence` with schema version 1, the native verdict, actual
JEV intervention, question revision, thresholds and probabilities when available.
The header is capped at 6,000 bytes, signals incomplete evidence, and excludes
input text, free-form reasons and raw provider output. Default response bodies
are unchanged. `unknown` plus an enforced block is a conservative intervention,
not an explicit model match; a monitor verdict does not claim enforcement.
The optional `execution` object reports the final runtime status (`complete`,
`error`, or `bypassed`), `failClosed`, and bounded error types. A provider failure
can produce an HTTP 200 block with `execution.status: error`; Testing clients
must treat this as an execution failure rather than a safety detection. A failed
provider attempt that recovered through fallback does not itself mark the whole
execution failed. Previous responses without this object do not establish status.

For online observation, use the Guardrail's existing **Monitor** mode: it records
Jev findings and `detection_decision` while forwarding the original input, including
when detection fails. **Monitor applies to the entire Guardrail and still waits for
detection**; it is not background dual-model execution alongside an enforced
incumbent. Use an isolated test Guardrail for that workflow. Bypass skips evaluation,
and explicit Playground/version tests continue to evaluate normally.

For an offline comparison that does not change active assignments, replay the same
annotated JSONL through either evaluator from the repository root:

```sh
# TYPESAFE_API_KEY must already be present in the environment.
.venv/bin/python -m scripts.evaluate_topic_control \
  --samples docs/examples/topic-control-lora/examples.jsonl \
  --provider jev --model jev-1.13.0 --include-proposed \
  --output /tmp/topic-jev.json

# Use your existing model's endpoint, ID and credential environment variable.
.venv/bin/python -m scripts.evaluate_topic_control \
  --samples docs/examples/topic-control-lora/examples.jsonl \
  --provider chat --base-url https://your-provider.example/v1 \
  --model your-topic-model --api-key-env TOPIC_MODEL_API_KEY --max-tokens 512 --include-proposed \
  --output /tmp/topic-current.json
```

Output includes dataset hash, per-sample verdicts, false positives/negatives,
unknowns, errors, latency and model usage. Compare matching sample IDs and dataset
hashes; match the current model's configured timeout and completion budget when
replaying chat models. By default only approved input labels are eligible; output and unresolved
labels are skipped. The bundled synthetic examples require `--include-proposed`
and validate plumbing only. Review real Chinese inputs and policy boundary cases
before treating results as quality evidence. `--lower-threshold` and
`--upper-threshold` support offline threshold experiments; they do not change the
activated profile's defaults. Existing result files are not overwritten.

Protocol references: [TypeSafe API](https://docs.typesafe.ai/api),
[models and aliases](https://docs.typesafe.ai/models),
[Noul semantics](https://docs.typesafe.ai/primitives/noul).

## Provider TLS settings

For a trusted Provider using a private CA or self-signed HTTPS certificate,
enable **Skip TLS certificate verification** under **Settings → Providers**.
The switch appears below the HTTPS Base URL during registration; saved Providers
have a **TLS settings** action. It defaults to off and applies only to that
Provider's discovery, detector validation, and Control Plane/Data Plane model
requests. Enabling it skips certificate-chain and hostname checks, not HTTPS
encryption. Changes are persisted and sent to active Runners; test affected models
again in Models and revalidate their bindings in Guardrail Catalog because previous
connection and validation evidence is cleared.
This does not change Controller–Runner mTLS or other Providers' verification.

For model revision activation and rollback, see
[revision lifecycles](revision-lifecycle.md). API clients should follow
[model-binding validation conventions](api-contract.md#validation-credentials-for-model-bindings).

## Generic semantic PII

The `tali.openai-compatible-pii.v1` profile accepts an OpenAI-compatible chat model
for `pii_semantic.input` and `pii_semantic.output`. The adapter asks for one JSON
field, `verdict`, with `pii`, `safe`, or `unknown`. It evaluates the current target
block, treats embedded instructions as data, and validates the response strictly.
Unknown judgments and invalid/provider responses never become positive findings.

PII Protection 1.1.0 first redacts exact identifiers and then checks the remaining
text semantically, including text without identifier keywords. Chinese document
labels alone are not exact PII matches. This also prevents an email match from
skipping a personal name in the same block. A semantic transform replaces the
whole target block with `[PII_REDACTED]`; it does not claim accurate model-generated
character spans. The complete semantic check adds a model call per evaluated
block. Qwen3Guard remains available as an alternative PII profile.

The PII and Company adapters disable optional thinking for hosted NVIDIA
Lightning, as does the Grounding adapter. Other judges retain their validated
reasoning behavior; other model/provider combinations do not receive this option.
Provider rate limits and Guardrail deadlines still apply.

For providers with a small concurrency quota, set the Runner environment variable
`GUARD_VALIDATION_MAX_CONCURRENCY=1` to run test cases sequentially (default: 8).
This changes validation scheduling only, not live traffic admission or detector
timeouts. Report sequential classification results separately from concurrent
availability failures. A blocked request alone is not detection evidence: inspect
the successful model call, detector verdict, and matched Policy/Rule together.

## Model connection recovery and failure evidence

The Safety Model evaluator (including NVIDIA JailbreakDetect) and native JEV
evaluators retry `ConnectError` or `ConnectTimeout` at most once, with 100–200 ms
of jittered backoff. Both attempts and the backoff share the smaller of the
configured model timeout and the remaining Guard evaluation deadline. A retry
never resets that budget, changes the input, or adjusts a model decision.
Cancellation stops the operation and any pending retry.

Certificate-validation failures and permanent DNS errors are not retried.
Neither are read/write failures, HTTP errors (including authentication and rate
limits), or invalid model responses: some of those requests may already have
reached the provider. An exhausted call returns an execution error and follows
the existing Guard failure policy. In enforce/fail-closed mode it blocks, but
Veritas records an execution error rather than a successful attack detection.

Telemetry keeps the logical call ID, final outcome, retries and elapsed backoff;
physical connection attempts equal one plus `retries`. Usage remains unknown
when the provider supplies no usage. Structured `model_connection_failure` and
`model_call_failed` logs retain exception class chains and OS error numbers,
without exception messages, prompts, credentials or request URLs. The shared
error classifier preserves HTTPX's transport/timeout category before traversing
wrapped causes. These changes do not alter prompts, thresholds or model bindings.

Run the permanent connection-recovery regression tests locally:

```sh
.venv/bin/python -m pytest -q tests/data_plane/test_model_connection_recovery.py
```

These tests use simulated NVIDIA and JEV transports without external model calls.
They cover successful recovery, exhausted retries, deadlines, cancellation,
authentication failures, invalid responses, certificate and DNS errors, and
sanitized failure logs. They verify reliability, not model accuracy.

## Global prices and Guardrail usage costs

**Settings → Models → Model prices** manages estimated model costs globally for
one Provider/model pair, shared across all its registered profiles and Guardrails.
This is internal cost accounting, not customer billing.

The bundled catalog derives from LiteLLM's public
[`model_prices_and_context_window.json`](https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json)
and is stored in the repository as `controller/server/catalog/model-prices.json`. The initial
snapshot is version `2026-10-14` with 2,440 supported USD prices. Controller loads
this local snapshot before accepting telemetry, and the production build includes
it. Startup, price lookup and accounting require no external network connection;
there is no scheduled download. The UI shows the loaded version and entry count.
An invalid snapshot retains the last successfully loaded prices. Removed entries
stop applying to new calls; historical revisions remain available.

Administrators can correct an individual model price in **Models → Model prices**
without editing files or restarting. To update the initial catalog for a release,
edit `controller/server/catalog/model-prices.json` (all token rates are USD per million,
request rates USD per thousand), change its `version`, review the diff, and rebuild
or restart Controller. Manual overrides always take precedence. Alternatively,
a maintainer can download the upstream JSON on a connected machine, transfer it,
and run this local-only conversion from `controller/`:

```sh
node --import tsx scripts/update-model-prices.mjs /path/to/model_prices_and_context_window.json 2026-10-14.revision1
```

The generator records the source URL, original file SHA-256 and MIT notice. It
replaces the bundled catalog; review and preserve any intended local corrections.
Never fetch the catalog as part of offline deployment.

Automatic matching requires the provider's actual service hostname and an exact
catalog model key. A custom gateway can explicitly select a LiteLLM catalog entry.
There is no fuzzy match or fallback to another provider's rate. Only supported
standard text token rates are imported; context-length tiers and unsupported
surcharges require manual pricing. Batch, priority and flex rates do not replace
standard synchronous rates.

For unlisted models, administrators can set USD prices per million input,
output and cached input tokens, per thousand calls, or explicitly mark the model
free. Manual rates override LiteLLM and survive catalog updates. Returning to LiteLLM
removes the manual override prospectively. Local deployment costs must be supplied
by the operator; the product does not invent a token price from model size.

The Guardrails list shows **Month cost (USD)** for the current UTC calendar month,
across all versions and runtime/testing calls, with an unaccounted count beside
partial totals. No model calls means USD 0; only unknown calls means Unaccounted.
Click the amount to open **Guardrail → Usage & cost**, which shows call counts, reported token totals, accounted
amounts, unaccounted calls, model breakdowns and daily cost trends. Periods use UTC;
all prices and amounts use USD, with no currency conversion. Runtime
traffic and Guardrail validation/Playground calls can be filtered separately.
Model connection probes and control-plane authoring calls are not attributed to a
Guardrail and are outside these totals. Rules without model calls incur no model
cost. Cost metering is independent of Runtime log capture level.

Token cost = (uncached input tokens × input rate + cached input tokens × cache rate
+ output tokens × output rate) / 1,000,000. Cached tokens are a subset of input;
they are subtracted before pricing the uncached portion. For request pricing,
cost = calls × request rate / 1,000. Missing cache prices do not silently fall
back to an ordinary input price. For example, 1,000 input tokens at USD 0.20/M
and 100 output tokens at USD 0.60/M cost USD 0.00026, without caching.

Each call stores its effective price revision and calculated amount at ingestion.
Pricing changes affect future calls; they do not backfill or reprice history. Missing
prices, missing token usage, unmatched model identity, nonstandard service tiers
or unsupported usage remain **Unaccounted**, never silently zero. Request rates
can account for models that do not report tokens. Failed calls are recorded too;
a token-priced failure without usage remains unaccounted. Amounts are estimates,
not a provider invoice (credits, taxes, discounts and subscription costs are not
inferred). Metering starts with this feature's migration; older Runners without
per-call details report unaccounted usage until upgraded.

Prices and cost records are separate operational tables. They are excluded from
Guardrail version snapshots, release packages and exports, and are never sent to
Runners as Guardrail configuration. Deletion/restoration clears Guardrail cost
records alongside its other operational data; model price revisions remain global.

## Jailbreak abstention handling

A valid classifier `unknown` verdict is distinct from a positive match and from
an execution error. Existing Jailbreak Policies conservatively block unknown
results. A custom `model/classifier` Rule with profile `jailbreak-classification`
can set `on_unknown` to `block` (default) or `allow`, as a literal or a declared
Policy parameter. The Controller validates and freezes the value into each
Guardrail's signed execution plan. Other model capabilities reject this setting.

The portable [example Policy](examples/jailbreak-uncertainty-control.json) defaults
to `block`. Set its Guardrail binding `parameterValues.on_unknown` to `allow`
to observe valid abstentions while continuing to block explicit matches. This
does not change model selection, prompts or probability thresholds. Authentication,
timeout, malformed-response and other execution errors retain fail-closed behavior.
Report evidence retains `unknown`; an observed abstention must never be relabeled
as a model safe verdict or explicit match.

This trades conservative abstention blocking for lower false-positive rates.
Validate attack recall and benign discrimination together with the same frozen
inputs before promoting a configuration beyond its tested scope.
