# Policy sources and compliance documentation

The Policy inspector's **Sources & Compliance** tab is read-only. It explains provenance,
relevant official references, selected Rule coverage, limitations and review status.
It is not a compliance certification, legal opinion or runtime enforcement mechanism.

## Authoring

Built-in catalog assets may contain an optional `compliance` object conforming to
`controller/shared/policy-compliance.ts`. The first documented asset is
`advanced-au-pii-protection` in `runner/toolkit/policy_library/assets/builtin_policies.json`.

- Embed documentation in the asset/version itself; do not attach latest documentation
  by Policy ID when reading a historical version.
- Set `policy_version` to the exact asset version. The catalog rejects mismatches.
- Supply English and Chinese prose. Keep official document titles and URLs intact.
- Explain provenance and license uncertainty explicitly. A matching version number
  is not sufficient evidence of upstream attribution.
- Use official HTTPS reference links and identify the provision or describe the
  reference as contextual, not a clause-level compliance mapping.
- Reference existing Rule IDs in `references` and `coverage`. Missing IDs fail catalog loading.
- Describe limitations and distinguish technical detection from legal obligations.
- Leave review `status` as `pending`, with null reviewer/date, until a formal review
  occurs. `reviewed` requires a reviewer and ISO date; it still does not mean certified.
- Official `latest` URLs may change. Re-review references before relying on their contents.

Missing documentation produces an explicit empty state. A version mismatch in a
received payload also produces an empty state rather than misleading historical content.
Custom-policy authoring of this metadata is not included in this first release.

## Validation

Run the Policy catalog, Policy detail and compliance component tests, type checking,
and the build. Regenerate the OpenAPI document when the API contract changes.
Browser QA covers English/Chinese on desktop, tab order, long text, external
links, the empty state and unchanged navigation between the existing tabs.
Phone/mobile compatibility and mobile acceptance are out of scope under the
[desktop-only design contract](protection-productization.md#platform-scope-desktop-only).
