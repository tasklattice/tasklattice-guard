"""Zero-model smoke, runnable via stdin in the deployed Runner image.

Uses a separate in-process preview runtime; never changes the served artifact,
Controller state, credentials, or model assignments.
"""
import asyncio
import json

from runner.compiler import DefaultRunnerCompiler
from runner.draft_preview import DraftPreviewRuntime
from runner.toolkit.compiler.nemo_compiler import NEMO_COMPILER_VERSION
from runner.toolkit.nemo.action_registry import action_providers
from runner.toolkit.runtime.contracts import ProtectionRequest, RequestContext


async def main():
    assert NEMO_COMPILER_VERSION == "tasklattice-nemo-config-v21-dynamic-flow-targets"
    checked = 0
    runtime = DraftPreviewRuntime(DefaultRunnerCompiler(), action_providers())
    try:
        for phase in ("input", "output"):
            for target in ('$target', '{"target": "inspect text"}["target"]', '"{$target}"'):
                source = f'''flow check $text
  $target = "inspect text"
  send StartFlow(flow_id={target}, flow_instance_uid=uid(), text=$text)
  match FlowFinished(flow_id={target})

flow inspect text $text
  $r = await GuardRecordPolicyAction(flow_name="check", safe=False, text=$text)
'''
                plan = {
                    "guardrail_id": "dynamic-flow-smoke", "guardrail_version": "20260908-100000.001Z",
                    "compiler_version": "smoke", "safety_level": "balanced",
                    "output_delivery": "full_buffered", "steps": [], "modules": [],
                    "policy_versions": [{
                        "policy_id": "custom", "version": "1", "name": "Custom", "source": "custom",
                        "colang_version": "2.x", "checksum": "smoke",
                        "sources": [{"path": "main.co", "content": source}],
                        "rail_bindings": [{"rail_type": phase, "flow_name": "check",
                            "execution_mode": "detect", "on_unsafe": "reject", "timeout_ms": 2000}],
                        "action_references": [{"name": "GuardRecordPolicyAction", "version": "1.0.0"}],
                    }],
                    "policy_bindings": [{"policy_id": "custom", "policy_version": "1", "enabled_rails": [phase]}],
                }
                result = await runtime.evaluate(
                    ProtectionRequest(phase=phase, texts=("check",), context=RequestContext(protocol="test")),
                    preview_id=f"dynamic-flow-smoke-{checked}", guardrail_id=plan["guardrail_id"],
                    draft_revision=1, candidate_version=plan["guardrail_version"], plan=plan, runtime_profile="auto")
                assert result.decision == "block" and not result.usage.fail_closed, result.reason
                assert result.usage.model_invocations == 0
                assert any(item.policy_id == "custom" for item in result.findings)
                checked += 1
    finally:
        await runtime.shutdown()
    print(json.dumps({"compiler": NEMO_COMPILER_VERSION, "checked": checked,
        "model_invocations": 0, "scope": "isolated in-process Input/Output dynamic Flow smoke"}))


if __name__ == "__main__":
    asyncio.run(main())
