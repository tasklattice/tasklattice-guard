# Credential format repair (1.0.0)

This local PII policy blocks recognizable credential literals on input and output. It calls no model and never authenticates a discovered credential against a remote service.

## Changes

- Private-key headers include PKCS#8 (`BEGIN PRIVATE KEY`), encrypted PKCS#8, the existing algorithm-specific/OpenSSH forms, and PGP private blocks. Public keys and certificates remain allowed.
- Password assignments support quoted JSON/YAML fields, qualified environment names, passphrases, numbered confirmation fields, escaped JSON, SQL quote escaping, and values on the following line. Source variable references, function calls, type/enum declarations and complete interpolation/redaction placeholders are excluded. An unrelated placeholder never suppresses another literal credential in the request.
- AWS secret keys now require an explicit secret-key assignment context. A bare 40-character digest or Git commit path is not sufficient evidence.
- Generic credential assignments cover client/shared secrets, API/access tokens, OAuth cookies/query parameters and TOTP secret fields. Bearer values accept base64 punctuation and padding. Slack refresh token prefixes are recognized.
- Five additional opt-in rules cover credential-bearing connection URLs, HTTP Basic Authorization, signed JWT-shaped values, labelled hexadecimal keys, and private JWK members. JWK checks require `kty` and the private `d` member within the same object/fragment, in either order, with bounded matching; public-only JWKs do not match. They do not validate a JWT signature or prove that a credential is live.

The earlier 1.0.0 source package remains immutable under `policies/history/local-credentials/1.0.0`. Existing published artifacts and version-pinned Guardrails retain their old behavior. A new draft must explicitly choose 1.0.0, select the desired rules, validate and publish before its Router can use the change. New rules do not silently join an existing Default selection.

## Scope and interpretation

This is credential-exposure detection. It does not infer whether an arbitrary unlabeled string is a password. Weak/example passwords are still literal credentials: a source dataset may label them benign, but adding sample-specific exemptions would also allow real deployments that use those passwords. Remaining benchmark disagreements must keep their source labels and remain visible in the Report.

Rules operate on the supplied text, without benchmark-category hints. CredData's upstream labels, input text, scorer and frozen cohorts are not changed by this repair. The seed-42 diagnostic cohort is used for development; a separately frozen, text-disjoint seed-43 cohort checks transfer to unseen requests. Neither small balanced cohort estimates full-corpus or historical F5 accuracy. A single repeat does not measure stochastic stability.

## Validation

```sh
npm run policies:build
npm run policies:test -- policies/builtin/local-credentials
npm run policies:check
```

`tests/regression-1.0.0.yaml` uses synthetic positive and negative fixtures for both directions. It runs through the Controller plan and actual NeMo local execution path, including the previous rule aliases. No copied benchmark secret values are committed.

Format references: [JWK private members](https://www.rfc-editor.org/rfc/rfc7518.html#section-6), [Slack token rotation](https://api.slack.com/authentication/rotation).
