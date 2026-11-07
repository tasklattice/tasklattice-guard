# Standalone demo tools and upstream rebase — 7 November 2026

The demo and acceptance tools consume an existing Project-based deployment.
Project ownership, Keycloak/OIDC access, Runner allocation and the consolidated
Guard Helm chart follow upstream. The retired tenant load-lab console, its
Controller proxy and the old tenant/sharing provisioning script remain removed.

## External tools

- The gateway load generator runs as a separate Node process. A/B/C are local
  experiment labels whose gateway credentials and Runner origins are supplied
  by the operator; they do not select product Project identities.
- The Project verifier consumes existing Project-bound tokens or sessions,
  resource identities and gateway bindings. It performs read-only management
  checks and creates runtime traffic for the configured acceptance scenario.
  It does not sign in users, create fixtures or change deployment configuration.
- The optional manifest renderer uses explicit Runner service bindings and
  private operator inputs. Generated manifests and credentials stay outside Git.
- The macOS access helper requires an explicit Controller Service and uses the
  operator's kubeconfig. Its loopback bridge is independent of application code.

The [tool guide](tenant-load-lab.md) describes inputs and execution. The
[5 November runbook](local-k8s-runtime-2026-11-05.md) and its screenshots record
the earlier deployment; they do not prove a deployment of this rebased source.
Raw runtime/Kubernetes reports remain in ignored
`.tasklattice-recovery/local-k8s-evidence-2026-11-05/`.

## History and validation

The pre-rebase workspace was saved in three commits and preserved locally at
`codex/backup-multi-tenant-v2-20261106`. The initial rebase onto `bdd33605`
resolved intentional upstream file removals. The final rebase completed onto `f960f907`,
including the catalog and Profile changes published during the pause.

Validation on the final rebased source:

| Check | Result |
| --- | --- |
| Standalone access, renderer, gateway generator and Project verifier | 59 tests passed; none skipped |
| Changed Markdown relative file links | 10 files checked; no broken links |
| Required protocol, Policy and Profile generation | Passed; no tracked file changes |
| UI/server/CLI typecheck | Passed |
| Production UI/server/CLI build | Passed |
| OpenAPI schema and permission contract | 28 tests passed; 175 operations and 497 schemas |

The verifier regressions include cross-Project direct reads, optional
administrator boundaries, credential validation on the correct Runner before
foreign-Runner rejection, and paired call evidence across different Runner
replicas. Failure reports redact configured tokens and session-cookie secrets.

The branch has no product runtime changes relative to the upstream target.
No live cluster, database migration or deployment is part of this source
integration; the verification tests use controlled transports and loopback
fixtures rather than the operator's deployment.

The final patch and staged changes pass `git diff --check`; the rebase has no
unresolved index entries. Local runtime reports and generated build output are
excluded from these commits.
