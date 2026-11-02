# Password and encoded-key formats — 1.0.0

This local PII Policy detects credential exposure without model calls. Version
1.0.0 remains available as an immutable package for existing Guardrails.

## Changes

- Password assignments exclude explicit UI text keys, unquoted object/member
  references, callbacks, constants and complete placeholders. Common camel-case password fields and `:=` assignments are supported.
  Explicit SQL positions also accept short quoted literals.
- A `key` field cannot start inside `public-key` or `sealing-public-key`.
  A public key or placeholder never exempts another literal in the same request.
- Opt-in SQL password and command-line password Rules cover `IDENTIFIED BY`,
  plugin-qualified `IDENTIFIED WITH … BY`, PostgreSQL `PASSWORD`, long password
  options, OpenSSL `pass:` sources and attached MySQL `-p` values. Interactive
  prompts, environment references and file-based password sources are excluded.
- Opt-in NKEY Seed detection uses the uppercase Base32 seed prefixes and length
  from the [NATS NKEY format](https://github.com/nats-io/nkeys/blob/main/strkey.go).
  Public NKEYs are not seeds. This checks exposed format, not CRC or key validity.
- Opt-in Base64 private-key detection recognizes one encoded PEM layer,
  including bounded line wrapping. Private-key header identity is case sensitive;
  encoded public keys and certificates are excluded. It does not recursively
  decode arbitrary input or prove a key is valid.

## Boundaries and testing

These are text-only exposure heuristics, not a programming-language parser or
credential validator. Some unquoted words and quoted UI strings are ambiguous
without their original file context. The Policy receives request text only.
Public cryptographic test vectors, malformed example private keys, ChangeToken
and nonce labels need separate scope review; no dataset labels or per-value
allowlists are changed. A credential in a test file is not automatically safe.

Select the four new Rules explicitly in existing bindings. The example in
`docs/examples/credentials-local.json` selects all current non-alias Rules.
Regression fixtures use synthetic literals for input and output, including
negative examples and a benign field followed by a real-looking secret.
