# Policy sources and compliance documentation

The Policy inspector's **Sources & Compliance** tab is read-only. It separates
implementation provenance from regulatory and industry context, representative
Rule coverage, limitations, and review status. It is not a compliance
certification, legal opinion, or runtime enforcement mechanism.

## Coverage and source model

All 69 built-in Policies receive version-bound documentation from
`controller/server/policy-catalog/compliance.ts`. Explicit asset metadata takes
precedence; the detailed Australia PII mapping remains embedded in
`builtin_policies.json`.

The UI intentionally presents two different concepts:

1. **Implementation lineage** records who maintains the Policy, runtime/configuration
   lineage, third-party attribution, and licensing.
2. **Regulatory and industry context** links only to relevant material from regulators,
   governments, standards bodies, or recognised industry-security organisations.

A software project or runtime dependency is not a compliance authority. LiteLLM and
NeMo therefore do not appear as regulatory/industry references. For the 22 detector
collections containing MIT-licensed seed material, LiteLLM is mentioned only under
implementation lineage and license attribution, with an explicit statement that it is
not the Policy's industry basis, compliance authority, or runtime dependency.

The contextual reference catalog currently uses material from NIST, OWASP, WHO,
UNICEF, EUR-Lex, OAIC, the Australian legislation register, PDPC, IMDA, the UAE
government, PCI SSC, ASIC, the Basel Committee, IATA, and the AI Verify Foundation. Reference prose explains
why the document is relevant and what the technical Policy does **not** implement.
Singapore financial-AI Policies use the current AI Verify Foundation/IMDA governance framework
only as broader Singapore context and explicitly do not present it as a MAS rule or
proof of MAS compliance.

Not every business filter has a legitimate external mapping. Topic filters,
competitor terms, configured phrases, and similar organisation-defined controls show
an explicit “no relevant external reference declared” state instead of receiving an
unrelated framework link. Customer-authored Policies likewise retain workspace
provenance and a pending-review record without invented sources.

## Authoring and review rules

The schema is `controller/shared/policy-compliance.ts`.

- Bind documentation to the exact `policy_version`; historical surfaces retain their
  own documentation.
- Supply English and Chinese prose.
- Keep implementation lineage separate from regulatory/industry context.
- Use official HTTPS links and identify the publisher and provision or context.
- Do not treat a software repository, runtime framework, or model provider as a
  compliance source.
- Do not add an unrelated standard merely to avoid an empty reference list.
- References are contextual unless a provision is explicitly identified. They never
  imply authorship, endorsement, certification, or complete implementation.
- Reference existing Rule IDs in `references` and `coverage`; unknown IDs fail catalog
  loading.
- `reviewed` means engineering reviewed lineage, relevance, link target, and technical
  boundaries. Legal conclusions still require qualified independent review.
- `pending` requires a null reviewer/date; `reviewed` requires an ISO date and reviewer.

External references use blue text, underline, an external-link icon, a visible
**External link / 站外链接** label, `_blank`, and `rel="noopener noreferrer"`.
The section itself states that linked documents are context—not implementation source,
endorsement, or proof of compliance.

## Link review

A plausible URL is not sufficient. Reviewers must open the final redirected target and
confirm that it displays the expected publisher and document. HTTP 404, generic error,
maintenance, search-result, or unrelated replacement pages must not be accepted as
evidence. Bot protection may require desktop-browser verification rather than relying
only on command-line status codes.

The retired MAS FEAT URL
`https://www.mas.gov.sg/publications/monographs-or-information-paper/2018/feat-principles`
is prohibited by a catalog regression test and is no longer emitted. Official links
must be rechecked whenever documentation is reviewed because publishers can move or
replace pages.

## Performance and validation

The catalog and source templates are built once and cached by the Controller service.
The inspector is memoized, builds its Rule-name index once, and renders only the
selected Policy tab. Shared source text compresses efficiently; a regression test caps
the gzip overhead for all built-in compliance metadata at 45 KB.

Tests require 69/69 built-in Policies to have bilingual, version-bound documentation
and valid Rule references. They verify industry mappings, intentional empty mappings,
custom provenance, unsafe links, missing/stale metadata, Chinese rendering, external
link semantics, and the exclusion of software dependencies and the retired MAS URL.
Browser QA is desktop-only under the
[desktop design contract](protection-productization.md#platform-scope-desktop-only).
