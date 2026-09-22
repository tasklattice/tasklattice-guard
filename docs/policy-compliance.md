# Policy sources and compliance documentation

The Policy inspector's **Sources & Compliance** tab is read-only. It explains
provenance, relevant official references, representative Rule coverage,
limitations and review status. It is not a compliance certification, legal
opinion or runtime enforcement mechanism.

## Coverage and component model

All 69 built-in Policies receive version-bound documentation. The catalog factory
in `controller/server/policy-catalog/compliance.ts` centralizes shared provenance,
license language and authoritative references instead of duplicating prose in each
large Policy JSON object. Explicit asset metadata takes precedence; the detailed
Australia PII mapping remains embedded in `builtin_policies.json`.

The factory chooses a reviewed source context from the Policy ID, source collection
and declared category:

- pinned LiteLLM source for the 22 imported local content filters;
- NVIDIA NeMo documentation for model-capability and configurable runtime contracts;
- official EUR-Lex, OAIC, PDPC, MAS and UAE sources for jurisdictional Policies;
- official NIST, OWASP, PCI SSC and ASIC references for relevant technical contexts.

These are contextual references unless a provision is explicitly identified. A
reference is never presented as proof that the Policy implements every requirement.
Each reference and coverage entry points to real Rule IDs; catalog loading fails on
unknown IDs or a Policy-version mismatch.

Customer-authored Policies receive explicit workspace provenance, owner attribution,
limitations and a pending-review record. Because the current editor has no source
metadata fields, they correctly state that no external source/license/legal mapping
has been declared rather than inventing one.

## Authoring rules

The schema is `controller/shared/policy-compliance.ts`.

- Bind documentation to the exact `policy_version`; historical surfaces retain their
  own documentation.
- Supply English and Chinese prose.
- Use official HTTPS links and identify the publisher and provision/context.
- Keep uncertainty explicit. A catalog version is not upstream attribution.
- Reference existing Rule IDs in `references` and `coverage`.
- Separate technical detection from legal scope, governance and compliance conclusions.
- `reviewed` means engineering reviewed provenance, link target and technical scope;
  the UI explicitly says this is not certification. Legal conclusions still require
  qualified independent review.
- `pending` requires null reviewer/date. `reviewed` requires an ISO date and reviewer.
- Re-check changing official URLs and contents during future Policy reviews.

External references use a shared component with blue text, underline, external-link
icon, a visible **External link / 站外链接** label, `_blank`, and
`rel="noopener noreferrer"`. Customer Policies with no external reference show a
specific explanatory state.

## Performance and validation

The catalog and source templates are built once and cached by the Controller service.
The inspector component is memoized, builds its Rule-name index once, and renders only
the selected Policy tab. Shared source text compresses efficiently; a regression test
caps the gzip overhead for all built-in compliance metadata at 45 KB.

Tests require 69/69 built-in Policies to have bilingual, version-bound documentation,
at least one HTTPS source and valid Rule references. They also cover custom provenance,
unsafe links, missing/stale metadata, Chinese rendering and external-link semantics.
Run Policy catalog/component tests, type checking, OpenAPI generation and the build.
Browser QA covers English/Chinese on desktop, tab order, long text, links, empty states
and existing-tab navigation. Phone/mobile acceptance remains out of scope under the
[desktop-only design contract](protection-productization.md#platform-scope-desktop-only).
