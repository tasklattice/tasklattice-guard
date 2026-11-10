# Generated Artifact fixtures

Generated payloads in the subdirectories are not committed. They are output of
[`scripts/generate_test_artifacts.py`](../../../scripts/generate_test_artifacts.py),
which compiles a frozen plan, signs it with the test-only Ed25519 key and writes
three files:

| File | Purpose |
| --- | --- |
| `desired-state.pb.b64` | The signed `DesiredState` exactly as a Runner receives it |
| `public-key.pem` | The verification key, so the Runner needs no private key |
| `manifest.json` | Fixture identity, checksum and expected scan decisions |

The inputs are source, not the output: plan construction (including Controller
Plan builders under `controller/server/domain`), the NeMo compiler under
`runner/toolkit/compiler`, and the Policy Library assets. Committing the base64
blob would add an unreviewable diff to every Policy or NeMo upgrade while telling
a reviewer nothing.

## Regenerating

Pytest regenerates everything before the first test, and Vitest does so before
collecting Controller tests. Both write only changed files:

```bash
npm run fixtures:generate   # write now, without running tests
npm run fixtures:check      # write, then prove a second generation is byte-identical
```

`fixtures:check` is the reproducibility gate; CI runs it once in the Control
plane job. Ordinary test runs skip it and rely on the session-level generation.
