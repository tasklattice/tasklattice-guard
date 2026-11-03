# PR 43 CI repair — 3 November 2026

This records fixes for the three failed jobs in [CI run 41505026465](https://github.com/tasklattice/tasklattice-guard/actions/runs/41505026465), whose head is `abcf90f7`. That original run does not include the repairs recorded here; the updated PR head identifies the published repair revision.

## Causes and changes

- **Control plane:** the public-document navigation mock lacked `loginMockSso`; server telemetry tests mixed jsdom and native Request byte realms; the access-token test expected tenant users to write Runner settings. The fixtures now match the real environment and current RBAC. Production authorization and request validation remain intact.
- **Contracts and deployment:** admission metrics used an embedded JSON heartbeat payload, violating the typed protocol contract. The old field number 7 is reserved and typed diagnostics use field 8. Missing optional scalar values remain distinguishable from zero. The codecs retain the strict snapshot schema, histogram checks, tenant/cardinality limits and 65,536-byte monitoring bound; missing or invalid reports remain unavailable. Lease generation and duration semantics now travel with the generated contract documentation.
- **Controller / Runner communication:** fixtures lacked the explicit legacy `control_token=None` setting and the TypeScript harness did not implement current session, allocation and challenge acknowledgements. The harness now verifies those identities. Tests observe synchronization while the stream is live and fencing after disconnect, and surface Runner task failures directly rather than hiding them behind an acknowledgement timeout.

Protobuf bindings were regenerated with the project script. Older peers omit the new optional diagnostic field; it does not grant serving or quota authority.

## Verification

| Check | Result |
| --- | --- |
| Full Controller CI suite, `npm run test:control-plane --prefix controller -- --maxWorkers=2 --testTimeout=30000 --hookTimeout=30000 --silent` | 2,584 passed, 429 gated/intentional skips; 257 files passed and 57 skipped |
| Full contracts/deployment command, `npm run test:contracts` | Passed: 281 contract tests passed, 7 skipped; developer commands, generated-protocol check, Helm profiles/templates and dashboard JSON passed |
| Full communication command, `npm run test:e2e` | 16 passed, 6 skipped; three require external Relay configuration and three are unrelated optional collection dependencies; no new skips introduced |
| Focused typed snapshot/codec checks | 13 Python protocol/snapshot tests and 24 Controller codec/monitor tests passed; counts overlap broader runs |
| Controller typecheck and production build | UI, server and CLI passed; generated OpenAPI remains 158 operations and 471 schemas |
| Whitespace | `git diff --check` passed |

Local socket tests ran with loopback permission. The gated tests are not counted as executed database or external-service evidence. No production identity, authorization or deployment setting was relaxed to obtain these results. GitHub CI evaluates the repair revision separately from the original failed run.
