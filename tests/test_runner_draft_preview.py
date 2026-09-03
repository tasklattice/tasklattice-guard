from __future__ import annotations

import pytest

from runner.compiler import DefaultRunnerCompiler
from runner.draft_preview import DraftPreviewRuntime
from runner.toolkit.nemo.action_registry import action_providers
from runner.toolkit.nemo.actions import local_action_providers
from runner.toolkit.runtime.contracts import ProtectionRequest, RequestContext


PLAN = {
    "guardrail_id": "guardrail-draft",
    "guardrail_version": 4,
    "compiler_version": "tasklattice-controller-plan-v3",
    "safety_level": "balanced",
    "output_delivery": "full_buffered",
    "steps": [{
        "id": "secrets:exact",
        "capability": "secrets",
        "contract_ref": "tali.guard.secrets.exact.v1",
        "phases": ["input", "output"],
        "on_unsafe": "reject",
        "trigger": {"type": "always", "verdicts": []},
        "parameters": [],
    }],
    "modules": [{
        "id": "data_protection:input",
        "module": "data_protection",
        "phase": "input",
        "step_ids": ["secrets:exact"],
        "depends_on": [],
        "input_view": "original",
        "required_for_release": True,
        "timeout_ms": 750,
        "failure_mode": "fail_closed",
    }, {
        "id": "data_protection:output",
        "module": "data_protection",
        "phase": "output",
        "step_ids": ["secrets:exact"],
        "depends_on": [],
        "input_view": "original",
        "required_for_release": True,
        "timeout_ms": 750,
        "failure_mode": "fail_closed",
    }],
    "reasoning_policies": [],
    "policy_versions": [],
    "policy_bindings": [],
}


@pytest.mark.asyncio
async def test_draft_preview_compiles_real_runtime_and_rejects_identity_reuse() -> None:
    previews = DraftPreviewRuntime(
        DefaultRunnerCompiler(),
        action_providers(*local_action_providers()),
        ttl_seconds=900,
    )
    try:
        prepared = await previews.prepare(
            preview_id="preview-1",
            guardrail_id="guardrail-draft",
            draft_revision=7,
            candidate_version=4,
            plan=PLAN,
            runtime_profile="auto",
        )
        decision = await previews.evaluate(
            ProtectionRequest(
                phase="input",
                texts=("Summarize the quarterly report.",),
                context=RequestContext(protocol="playground"),
                call_id="draft-call-1",
            ),
            preview_id="preview-1",
            guardrail_id="guardrail-draft",
            draft_revision=7,
            candidate_version=4,
            plan=PLAN,
            runtime_profile="auto",
        )

        assert prepared["draft_revision"] == 7
        assert prepared["ttl_seconds"] == 900
        assert decision.decision == "allow"
        assert decision.guardrail_id == "guardrail-draft"
        assert decision.guardrail_version == 4
        with pytest.raises(ValueError, match="identity"):
            await previews.prepare(
                preview_id="preview-1",
                guardrail_id="guardrail-draft",
                draft_revision=8,
                candidate_version=4,
                plan=PLAN,
                runtime_profile="auto",
            )
    finally:
        await previews.shutdown()
