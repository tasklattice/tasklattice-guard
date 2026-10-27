# Frozen pre-v16 signed Artifact

These files are copied byte for byte from commit `1df5c899`, before the
explicit-view execution contract, at `tests/fixtures/artifacts/local-secrets-v1`.
Do not regenerate them with the current compiler or rewrite their signature.

The stored plan identifies `tasklattice-controller-plan-v3`; its NeMo compiler
is `tasklattice-nemo-config-v27-staged-checks`. Its Action binding has no
`evaluation_view`. The Ed25519 signature and content checksum are valid:
`0e3ba069d8507b667523dae40c42a4dd272232cea98389e10fe813cc4fe6c2b2`.

Upgrade tests must reject it before runtime preparation, state persistence or
request execution. It is intentionally outside the regenerated Artifact set.
