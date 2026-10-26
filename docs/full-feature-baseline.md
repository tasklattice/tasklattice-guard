# Full-feature baseline

Select **Full-feature baseline** in **Create Guardrail → Name & Profile**.
The Profile copies the benchmark configuration into a normal editable draft.
Continue to review and create, or remove unwanted Policies and Rules first.
You can also remove protections after creation and save the revised draft.
The source `full-feature-baseline@1.0.0` remains visible on the Guardrail.

## Included configuration

The Profile freezes the reviewed `pii-context-20261023` benchmark configuration:

| Policy | Version | Rules | Direction |
| --- | --- | ---: | --- |
| Credentials | 4.2.0 | 18 | Input and output |
| Payment data | 4.0.0 | 4 | Input and output |
| Government identifiers | 4.0.0 | 23 | Input and output |
| Passports | 4.0.0 | 9 | Input and output |
| Contact data | 4.3.0 | 19 | Input and output |
| Network addresses | 4.0.0 | 2 | Input and output |
| Strict Jailbreak Protection | 1.0.0 | 1 | Input |
| Model Content Safety | 1.0.0 | 1 | Input |

Policy order, explicit Rule order, actions, parameters, and all 106 reviewed
expectation overlays are retained. Output delivery is `full_buffered`, safety
level is `balanced`, and the topic lists are empty. The network selection
contains IPv4 and IPv6; URL detection is not selected. Content safety is enabled
only on input, matching the benchmark.

The benchmark's installation-specific jailbreak Policy is packaged as
`builtin-jailbreak-strict@1.0.0`. Its `on_unknown=block` behavior is included;
users do not need to create or publish a custom Policy on each installation.

“Full-feature” describes this benchmark scope. It does not mean all catalog
Policies are enabled, or that all sensitive data and attacks will be detected.
Detection quality and latency still depend on the models, content and chosen
protections. This template does not inherit the benchmark's execution evidence.

## Configure models once

A platform administrator configures, validates and activates these assignments:

- `jailbreak.input`: a compatible Jailbreak detection model.
- `content_safety.input`: a compatible Content Safety model.

Every Guardrail created from this Profile reuses those platform assignments.
The Profile stores no provider credentials, URLs or installation-specific model
IDs. Selected dependencies and their current readiness are shown in creation.
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

The canonical seed is `controller/shared/full-feature-baseline.ts`; migration
0049 installs the same definition. A seed regression checks that they agree.
The migration preserves any existing or disabled row rather than overwriting
an installation's customization.
