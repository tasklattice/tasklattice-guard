# Reviewed Profile composition

`generate_profiles.py` authors the Policy order, the specific-before-generic Rule
order, and version pins. `composition.json` contains the reviewed source-case
contracts shared by the bundled Profiles. The generated Profile version is 1.1.0.
The compiler continues to honor authored Priority; it does not globally move Block
Rules before Transform Rules.

The Default Profile enables all 193 local Rules. Its 746 source cases produce:

- 726 executed composition cases, including 25 explicit expectation overrides.
- 20 composition exclusions, each pinned to Policy version and source case ID,
  with a reason. These are duplicate credit-card/TFN fixtures or ambiguous passport
  formats. Their original Rule acceptance still runs in the isolated Policy suite.

A composition override requires the selected Rule identity, not just an action.
Every Transform override also asserts the entire redacted output. Contextual
passport detection may precede a country-specific pattern; numeric privacy formats
can overlap across jurisdictions. These contracts prove redaction, not ownership,
country, allocation or registration. A change in detector selection or output fails
the contract and needs review. Harmful-content fixtures explicitly expect the
safety Block even when a later keyword Rule also transforms the text.

Exclusions are copied into the ordinary Guardrail test scope on creation and
recorded with reasons in the creation audit event. Publishing freezes that scope;
Profile updates do not rewrite existing Guardrails or historical reports. A user
can subsequently include or exclude cases using the existing test-scope controls.
Import/export includes ordering, expectations and exclusions. Invalid/stale source
references are rejected. Validation never automatically excludes failures.

The Rule fixes in this revision also correct native boundary Evidence identity,
neutral religious/weapon mentions, Brazilian landline fixtures, and ABN candidate
validation. The ABN check follows [ABR's published algorithm](https://abr.business.gov.au/Help/AbnFormat).
Local keyword/regex classifiers remain heuristic; the regression suite is not a
claim of general semantic understanding.

Regenerate and verify from the repository root:

```sh
npm run policies:build
.venv/bin/python scripts/generate_profiles.py
npm run generate:default-baseline
.venv/bin/python -m pytest -q tests/control_plane/test_profile_composition.py
```

The composition regression invokes the actual compiler and Runner validator,
checks the full Default suite, and separately verifies excluded Rules in isolation.
Full-feature uses the same local composition settings; its model-backed checks
still require configured providers and must be validated in the target environment.
