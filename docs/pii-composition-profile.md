# PII in a combined Guardrail

PII disclosure and prompt injection are different decisions. An external email
thread can contain valid email addresses without containing an instruction attack.
When both protections are enabled, `transform` is still the correct configured
PII action. An injection-only benchmark's `allow` label does not establish that the
same text is free of personal information.

For the combined regression profile:

- Keep email, telephone, IP, government identifier, payment and credential rules.
- Pin `local-contact-data` to `4.1.0`. Its Brazilian phone expressions require
  standalone word boundaries, preventing partial matches inside Git hashes,
  build identifiers and calendar timestamps. Existing `4.0.0` releases retain
  their original expressions; upgrading requires publication of a new version.
- In `local-network-addresses`, enable `pattern/ipv4` and `pattern/ipv6` only.
  Omit `pattern/url` from `enabledRuleIds` and `ruleOrder`. That rule deliberately
  redacts all HTTP links, including public documentation; it is a general
  disclosure control, not evidence that a URL contains PII. It remains available
  for customers who explicitly require that broader policy.
- Keep credential blocking, including passwords in URLs. Removing generic URL
  redaction must not remove credential detection or exempt URL content from
  other protections.

Use the same rule selection for input and output. Do not allowlist benchmark
domains, case IDs, synthetic email addresses or entire retrieved documents.
Do not change benchmark labels to make publication or comparison pass.

## Reviewing differences

Preserve strict endpoint-action scores. Separately attribute unexpected outcomes
to the actual matched Policy and Rule:

1. A substring of a commit hash detected as a telephone is a rule false match.
2. A public article URL redacted by an all-URLs rule is a profile-scope issue.
3. An email address redacted in a benign injection example is a cross-capability
   label-scope difference. Keep the original score and the PII evidence.
4. A model block, uncertain block or execution error is a separate outcome; do
   not credit it as a PII fix.

Standalone format screening remains bounded. For example, excluding a partial
Brazilian-number match within a UK number does not add UK telephone coverage.
Full-value PII scoring must continue to fail until the complete annotated value
is removed by an appropriate rule.

## Structured fields and complete redaction (4.2.1)

The optional Contact information rules `pattern/structured_username`,
`pattern/structured_address`, `pattern/labelled_person` and
`pattern/international_phone` extend local format coverage. Enable them explicitly
in a dedicated profile; the Default selection does not automatically opt in to
new rules. Run these rules before regional contact formats to prevent a shorter
phone pattern from masking only a suffix.

Regex detectors accept optional `detector_options.capture_group`, naming a
capture in the expression. Validation rejects missing or unknown groups. Only
that group's nonempty span is validated and transformed, preserving JSON/XML
keys, delimiters and labels. Unconfigured regexes retain their original full
match spans; existing published policies remain executable.

Address fields require nearby structured street/postal context or a quoted numeric building field. Version 4.2.1 also recognizes the numeric building field as an anchor, so the general no-intervening-digits constraint does not leave the country unmasked. A standalone
`state: ready` or country name is not enough. Person screening is limited to
explicit labels with bounded capitalized names. Unlabelled names, truncated
address keys, arbitrary dates/times and semantic person recognition remain
outside this local profile. No benchmark strings or case IDs are embedded in
rules, and no model or prompt is added.

For reporting, final-action intervention (Block or Transform) and complete
annotated redaction are different metrics. Blocks from content safety or
credentials count as interventions but do not prove PII detection or successful
sanitization. Complete redaction requires nonempty transformed text and verified
removal of every annotated source span; partial masking and unverifiable output
formats are not successful redaction. Original labels and historical grades are
preserved. Compare versioned offline scores when scorer implementations change.

## Contextual persons and truncated records (4.3.0)

Three further Contact rules are opt-in; existing published 4.2.1 policies remain
available and Default does not silently enable them:

- `pattern/titled_person` requires an honorific followed by at least two
  capitalized name components. Its HTML text view maps matches back to literal
  source spans, preserving markup and attributes, including truncated text nodes.
  Code, scripts, styles and the document head are excluded. A title alone does
  not qualify.
- `pattern/contact_list_person` considers short capitalized scalar entries only
  when the same contiguous, same-indentation list contains both a grouped
  international phone and a nine-digit identifier. It cannot borrow context
  across blank lines, records or nested lists. This is a configurable format
  heuristic, not a claim that all capitalized list items are people; ambiguous
  mixed lists may require a narrower deployment scope.
- `pattern/truncated_address` recovers a quoted street value at the document
  start only when both city and postal fields occur in that same object. It does
  not mask a street name mentioned in ordinary prose.

Keep the existing order of Transform policies and put the new list rule before
telephone redaction within Contact. An earlier government-identifier Transform
can leave a typed `us_ssn` or `us_ssn_no_dash` redaction marker; this also supplies
list context. The marker is a local format cue, not authenticated provenance.
Moving the entire Contact policy ahead of identifiers would let broad regional
phone patterns partially consume identifiers and must not be used. Block checks still run
first under the compiled execution plan; Allow never short-circuits protections.
No model, prompt, name dictionary, benchmark value or case ID is added.
Generic dates and times retain their existing scope and strict benchmark labels.

The generic regex options `text_view: html_text` and `sibling_patterns` are
validated both at authoring and when loading frozen policies. Sibling matching
requires two to four configured patterns, bounds records to 32 entries / 8 KiB,
and does not combine with the HTML view. Existing regex rules are unaffected.
