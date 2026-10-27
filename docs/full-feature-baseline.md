# Full-feature baseline

Select **Full-feature baseline** in **Create Guardrail → Name & Profile**.
The Profile creates a normal editable draft with the benchmark-family protections enabled.
Continue to review and create, or remove unwanted Policies and Rules first.
You can also remove protections after creation and save the revised draft.
The source `full-feature-baseline@2.0.0` remains visible on the Guardrail.

## Built-in choices and upgrades

The creation list contains Default, Full-feature baseline, Bank,
Securities & brokerage and Internet platform support. Default is the local
configuration used during deployment; Full-feature baseline adds model checks
and the other benchmark-family protections. Bank and the industry templates offer
smaller local selections for their use cases.

Migration 0052 retires the other built-in choices by disabling their discovery
records. Existing Guardrails own their copied bindings, tests and published
snapshots: retirement neither rewrites them nor prevents editing, testing or
publication. Retired definitions remain stored for provenance. User-owned
Profile records are preserved, so installations with custom Profiles may show
additional choices. Display renames preserve Profile IDs and versions.

## Included configuration

Version 2.0.0 contains **14 Policies and 127 selected Rules**. It retains the
original `pii-context-20261023` Policy pins and adds the missing protection
families. Every Policy below is enabled when the Profile is selected.

| Policy | Version | Rules | Direction |
| --- | --- | ---: | --- |
| Credentials | 4.2.0 | 18 | Input and output |
| Payment data | 4.0.0 | 4 | Input and output |
| Government identifiers | 4.0.0 | 23 | Input and output |
| Passports | 4.0.0 | 9 | Input and output |
| Contact data | 4.3.0 | 19 | Input and output |
| Network addresses | 4.0.0 | 2 | Input and output |
| Strict Jailbreak Protection | 1.0.0 | 1 | Input |
| Model Content Safety | 1.0.0 | 1 | Input and output |
| Local Injection Protection | 4.0.0 | 40 | Input and output |
| Indirect prompt injection | 1.0.1 | 1 | Input |
| Memory instruction poisoning | 1.0.1 | 1 | Input |
| PII Protection: exact and semantic | 1.1.0 | 1 | Input and output |
| Personal Data Use Boundaries | 4.0.0 | 6 | Input and output |
| Model Topic Control: denylist | 2.0.0 | 1 | Input |

Output delivery remains `full_buffered`. Jailbreak retains `on_unknown=block`.
Model Content Safety now checks responses as well as requests. The network
selection remains IPv4 and IPv6; URL detection is not selected.

Topic Control enables only `topic/denylist`, with six prefilled task categories:
violent crime, illegal weapon instructions, fraud/credential theft/data
exfiltration, unauthorized malware/exploitation, child sexual exploitation,
and encouragement or instructions for suicide/self-harm. The allowlist is
not selected and the mode is permissive, so no business domain must be filled
before creation. Review these defaults for your application.

The corresponding protection families are:

| Evaluation family | Enabled protection |
| --- | --- |
| Deepset Eval | Content safety, jailbreak, injection and harmful-task denylist |
| AdvBench | Strict jailbreak and content safety |
| TDC red teaming | Jailbreak, content safety and injection |
| HarmBench | Input/output content safety and harmful-task denylist |
| PromptInject | Local direct injection and external-content injection |
| PII / Mendeley | Exact identifiers, semantic PII and data-use boundaries |
| DBS Secrets | Credentials, payment data, injection/exfiltration patterns |
| Memory poisoning | Memory instruction poisoning |

This mapping describes configured protection, not a benchmark score or a
claim of complete PII/PHI coverage. Multi-turn attacks require a caller that
preserves conversation history. External-content and memory checks require
`retrieved_content` or `tool_output` provenance; memory source-query evidence
must accompany the actual memory candidate when applicable. Enabling a Policy
does not insert Guard automatically into an Agent's retrieval or memory path.

The 106 original expectation overlays remain assertions for regression, not
proof that the expanded chain passes them. New protections can change a
composition's outcome. Cases retain their original required status and real
failure evidence; no assertions are weakened to manufacture a passing result.

## Configure models once

A platform administrator assigns compatible models and applies all six bindings:

- `jailbreak.input`
- `content_safety.input` and `content_safety.output`
- `pii_semantic.input` and `pii_semantic.output`
- `topic_control.input`

Each capability and direction is independent. An input Content Safety binding
does not satisfy output Content Safety, PII, Jailbreak or Topic Control. One
compatible model may serve multiple bindings, but each binding must be assigned
and applied. The Profile stores no concrete model ID, provider URL or secret.

An active model with failed or missing capability-test evidence can still run
Guardrail tests; its test warning remains visible. Tests wait for a compiler
Runner to acknowledge the current model configuration. During synchronization,
environment checks remain pending instead of reporting a missing dependency.

Every Guardrail created from this Profile reuses those platform assignments.
Selected dependencies and their current readiness are shown in creation.
Missing assignments allow creation, editing and publication. Publication compiles
without model calls; untested, running and failed tests do not block it. Runner
compatibility is checked separately. Set up the assignments before testing model
behavior or routing traffic to these protections. Deleting a test report never
revokes publication.

## Pins and updates

The Profile and each Policy reference are versioned. A later catalog head does
not replace a pin, and later Profile edits do not modify existing Guardrails.
An unavailable pinned version disables only that Profile, with a reason.
Creating a draft records the source Profile ID and version for provenance.
Platform model revisions remain managed by the existing model configuration
and validation process; a Profile does not freeze a particular model provider.

Replacing a selection copies the Profile's bindings and global settings.
Adding a Profile preserves existing settings and same-version binding options.
Undo restores the previous bindings, settings and source metadata together.

## Deleting protections and validating again

Some benchmark expectations describe interactions between Policies. Five
Contact data overlays, for example, expect Government identifier matches.
Removing Government identifiers removes these five inherited overlays while
retaining the Contact Cases and their original Policy assertions. Overlays
whose source Case disappears after deselecting a Rule or Rail are also removed.

This reconciliation applies only to unchanged inherited overlays from the source
Profile or previous saved draft. Newly authored invalid references and stale
Policy-version expectations still require explicit review. Cases are never
marked passed or excluded merely because a protection was removed. A changed
composition may produce different results, so rerun validation before publishing.

The canonical seed is `controller/shared/full-feature-baseline.ts`. Migration
0053 upgrades an untouched built-in 1.0.0 definition to 2.0.0, preserving its
disabled state. It leaves edited and user-owned Profile records unchanged and
is safe to replay. Fresh databases reach the same definition through the
migration journal. Discovery still contains the five curated built-in choices.

Guardrails previously created from 1.0.0 keep their original draft, source
version, tests and signed Artifacts. They are not silently expanded; select
2.0.0 when creating a new Guardrail to get the added protections. Subsequent
edits of old Guardrails reconcile inherited assertions against their previous
saved draft, even though discovery now exposes the new Profile version.

Deleting model Policies removes their dependency requirements; disabling one
Rail removes only that directional binding. Deleting Topic Control removes its
six generated denylist cases. Removing all four model-backed Policies leaves
a local-only selection; the external-content and memory context requirements
still apply to their remaining Policies.
