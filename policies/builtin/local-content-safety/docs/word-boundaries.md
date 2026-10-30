# Local Content Safety 1.0.0

Gender terms alone no longer count as discrimination. The gender Rule requires explicit inferiority or exclusion language in the same sentence. Request-wide exception phrases were removed so an unrelated mention of equality cannot bypass a later discriminatory sentence. This is a bounded phrase detector, not a semantic discrimination classifier.

The toxic-language Rule no longer blocks solely on ambiguous topic, fiction, relationship or anatomy terms. Explicit abusive phrases, slurs and sexual acts remain in the local list. No benchmark IDs, labels or request-wide allowlist are used. Semantic cases proceed to subsequent configured Policies; this change does not certify them safe.

Removed standalone terms: `adult content`, `adult material`, `arousal`, `aroused`, `arousing`, `bound`, `tied up`, `breasts`, `erotic`, `escort`, `escorts`, `escorting`, `explicit`, `fantasize`, `fantasizing`, `fantasy`, `fantasies`, `kinky`, `lust`, `lustful`, `naked`, `nude`, `nudity`, `orgasm`, `orgasms`, `orgasmic`, `roleplay`, `role play`, `roleplaying`, `seduce`, `seductive`, `seduction`, `seduce`, `seducing`, `sensual`, `sensuality`, `sexual`, `sexually`, `vulva`.

Upstream provenance remains the pinned LiteLLM import, revision `ead62528e607b9d8e61273def638799c9c3a69ba`. These are reviewed TaskLattice policy changes, not an unchanged upstream copy. The importer writes review material only and must not overwrite canonical packages.

Published artifacts already contain frozen Rule definitions. Updating this catalog does not rewrite those artifacts. New Guardrail drafts must explicitly select 1.0.0 and complete validation and publication. JEV model, prompt, probability thresholds and conservative unknown blocking remain unchanged.

Racial and child identifiers use complete word boundaries: `roma` does not identify `romance`, and `kid` does not identify `skid`. Explicit phrase predicates and the remaining policy ordering are retained.

The violence Rule separates concrete enabling phrases from bare topic names. Bare violence topics now continue to semantic evaluation, and request-wide historical/prevention exceptions cannot bypass concrete planning phrases. Removed standalone topic triggers: `school shooting`, `mass shooting`, `serial killer`, `hired hitman`, `assassinate`, `terrorism`, `terrorist attack`, `human trafficking`, `rape`, `sexual assault`, `contract killer`, `school shooter`, `mass shooter`, `child trafficking`, `sex trafficking`, `domestic terrorism`, `lone wolf attack`, `active shooter`, `mass casualty`, `vehicular attack`, `vehicle ramming`, `knife attack`, `stabbing spree`, `murder spree`, `killing spree`, `rampage shooting`, `workplace shooting`, `public shooting`, `mass murder`, `mass killing`, `massacre`, `genocide`, `ethnic cleansing`, `war crimes`, `crimes against humanity`, `honor killing`, `vigilante justice`, `lynch mob`, `mob violence`, `gang violence`, `organized crime`, `mafia hit`, `gang hit`, `drive by shooting`, `execution style`, `murder`, `kill`, `assassin`, `hitman`, `kidnap`, `attack`, `violence`, `weapon`, `shooting`, `terrorist`, `crime`.

Explicit threats to a target and instructions to construct dangerous weapons remain local matches. Regression cases cover these separately from harmless topic mentions. Broader or euphemistic risks still require semantic evaluation.
