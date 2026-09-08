#!/usr/bin/env python3
"""Generate deterministic signed artifacts consumed by Runner-only tests.

The fixture private key is deliberately test-only. Data-plane tests receive
only the checked-in public key and serialized DesiredState, exactly like a
Runner that has no Controller database or compiler in its hot path.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from runner import generated as protocol
from runner.compiler import DefaultRunnerCompiler
from runner.toolkit.nemo.native_models import NativeRailModel
from runner.protocol_codec import (
    integration_verification_to_proto,
    plan_to_proto,
    traffic_scope_to_proto,
)


ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "tests" / "fixtures" / "artifacts"
FIXTURE_NAME = "local-secrets-v1"
ORDERED_FIXTURE_NAME = "ordered-local-v1"
DEFAULT_FIXTURE_NAME = "default-local-v1"
JAILBREAK_FIXTURE_NAME = "jailbreak-v1"
TOPIC_FIXTURE_NAME = "topic-control-native-v1"
PHRASE_FIXTURE_NAME = "configured-phrases-v1"
CUSTOM_SYMBOL_FIXTURE_NAME = "custom-symbol-ownership-v1"
CUSTOM_FLOW_EVENT_FIXTURE_NAME = "custom-flow-events-v1"
CUSTOM_DYNAMIC_FLOW_FIXTURE_NAME = "custom-dynamic-flow-events-v1"
CUSTOM_PARAMETER_FIXTURE_NAME = "custom-literal-parameters-v1"
STREAM_SAFETY_FIXTURES = {
    f"stream-safety-{mode}-v1": mode for mode in ("window_buffered", "interruptible", "full_buffered")
}
STREAM_SAFETY_FIXTURES['content-safety-inout-v1'] = 'window_buffered'
PRESET_FIXTURES = {
    f"preset-{name}-v1": name for name in (
        "common-baseline", "banking-assistant", "securities-assistant",
        "internet-customer-support", "singapore-financial-assistant",
    )
}
FIXTURE_NAMES = (FIXTURE_NAME, ORDERED_FIXTURE_NAME, DEFAULT_FIXTURE_NAME, JAILBREAK_FIXTURE_NAME, TOPIC_FIXTURE_NAME, PHRASE_FIXTURE_NAME, CUSTOM_SYMBOL_FIXTURE_NAME, CUSTOM_FLOW_EVENT_FIXTURE_NAME, CUSTOM_DYNAMIC_FLOW_FIXTURE_NAME, CUSTOM_PARAMETER_FIXTURE_NAME, *PRESET_FIXTURES, *STREAM_SAFETY_FIXTURES)
TEST_CREDENTIAL = "fixture-runtime-secret"
_PRIVATE_KEY_BYTES = bytes(range(1, 33))


@dataclass(frozen=True)
class FixtureFiles:
    desired_state: str
    public_key: str
    manifest: str


def _plan() -> dict[str, object]:
    return {
        "guardrail_id": "fixture-secrets",
        "guardrail_version": "20260904-010000.001Z",
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
        "modules": [
            {
                "id": "data_protection:input",
                "module": "data_protection",
                "phase": "input",
                "step_ids": ["secrets:exact"],
                "depends_on": [],
                "input_view": "original",
                "required_for_release": True,
                "timeout_ms": 750,
                "failure_mode": "fail_closed",
            },
            {
                "id": "data_protection:output",
                "module": "data_protection",
                "phase": "output",
                "step_ids": ["secrets:exact"],
                "depends_on": [],
                "input_view": "original",
                "required_for_release": True,
                "timeout_ms": 750,
                "failure_mode": "fail_closed",
            },
        ],
        "reasoning_policies": [],
        "policy_versions": [],
        "policy_bindings": [],
    }


def _ordered_plan() -> dict[str, object]:
    plan = _plan()
    plan["compiler_version"] = "tasklattice-controller-plan-v4-ordered"
    redactions = {
        "id": "local:redactions", "capability": "builtin_content_filter",
        "contract_ref": "tali.guard.content-filter.rules.v1",
        "phases": ["input", "output"], "on_unsafe": "reject",
        "trigger": {"type": "always", "verdicts": []},
        "parameters": [
            ["policy_id", "pattern-matching"], ["policy_version", "1.95.0"],
            ["policy_ids", "pattern-matching"],
            ["enabled_rules_json", json.dumps({"pattern-matching": ["pattern/email", "pattern/generic_api_key"]})],
            ["rule_actions_json", json.dumps({"pattern-matching": {"pattern/email": "redact", "pattern/generic_api_key": "redact"}})],
        ],
    }
    plan["steps"] = [redactions, *plan["steps"]]
    plan["modules"] = [
        {**module, "id": f"local-redactions:{module['phase']}", "step_ids": ["local:redactions"], "input_view": "previous_output"}
        for module in plan["modules"]
    ] + [
        {**module, "depends_on": [f"local-redactions:{module['phase']}"], "input_view": "previous_output"}
        for module in plan["modules"]
    ]
    return plan


def _jailbreak_plan() -> dict[str, object]:
    # The artifact declares only the capability, never a model or transport.
    plan = _plan()
    plan["steps"] = [{
        **plan["steps"][0], "id": "jailbreak:primary", "capability": "jailbreak",
        "contract_ref": "tali.guard.jailbreak.v1", "phases": ["input"],
    }]
    plan["modules"] = [{
        **plan["modules"][0], "id": "interaction_safety:input", "module": "interaction_safety",
        "step_ids": ["jailbreak:primary"], "timeout_ms": 5_000,
    }]
    return plan


def _topic_plan() -> dict[str, object]:
    plan = _jailbreak_plan()
    plan['steps'][0].update(id='topic:semantic:input', capability='topic_control',
        contract_ref='tali.guard.topic-control.semantic.v1',
        parameters=[['topic_mode', 'allowlist'], ['allowed_topics', 'Product support']])
    plan['modules'][0].update(step_ids=['topic:semantic:input'])
    return plan


def _default_plan() -> dict[str, object]:
    # Control-plane generation only. Runner-only tests never import the builder.
    source = """
      import {defaultGuardrailDraft} from './server/domain/defaults.ts';
      import {buildGuardrailPlan} from './server/domain/guardrail-plan.ts';
      import {PolicyCatalog} from './server/policy-catalog/catalog.ts';
      const policies = PolicyCatalog.load('../runner/toolkit/policy_library/assets').list();
      console.log(JSON.stringify(buildGuardrailPlan({guardrailId:'fixture-secrets', guardrailVersion:"20260904-010000.001Z",
        draft:defaultGuardrailDraft(policies), policies})));
    """
    return json.loads(subprocess.run(
        ["node", "--import", "tsx", "--input-type=module", "-e", source],
        cwd=ROOT / "controller", capture_output=True, text=True, check=True, timeout=30,
    ).stdout)


def _phrase_plan() -> dict[str, object]:
    source = """
      import {buildGuardrailPlan} from './server/domain/guardrail-plan.ts';
      import {PolicyCatalog} from './server/policy-catalog/catalog.ts';
      const policies = PolicyCatalog.load('../runner/toolkit/policy_library/assets').list();
      const phrase_entries = JSON.stringify([
        {id:'mask', phrase:'internal-name', action:'redact', replacement:'public-name'},
        {id:'block-original', phrase:'internal-name', action:'reject'},
        {id:'block', phrase:'confidential', action:'reject'},
        {id:'mask-zh', phrase:'内部代号', action:'redact', replacement:'公开名称'},
      ]);
      console.log(JSON.stringify(buildGuardrailPlan({guardrailId:'fixture-secrets', guardrailVersion:'20260904-010000.001Z', policies,
        draft:{allowedTopics:[], restrictedTopics:[], safetyLevel:'balanced', outputDelivery:'full_buffered', policyBindings:[{
          policyId:'configured-phrase-filter', policyVersion:'1.0.0', action:null,
          parameterValues:{phrase_entries}, enabledRuleIds:['configured/phrases'], ruleActions:{}, enabledRails:['input','output'], reasoningPolicy:null,
        }]}})));
    """
    return json.loads(subprocess.run(
        ["node", "--import", "tsx", "--input-type=module", "-e", source],
        cwd=ROOT / "controller", capture_output=True, text=True, check=True, timeout=30,
    ).stdout)


def _preset_payload(preset_id: str) -> dict:
    # Generate once outside the data plane. Frozen fixtures include the reviewed
    # cases so Runner-only tests need neither Controller nor Policy expansion.
    source = """
      import {protectionPresets} from './shared/protection-presets.ts';
      import {expandProtectionPreset} from './server/policy-catalog/presets.ts';
      import {buildGuardrailPlan} from './server/domain/guardrail-plan.ts';
      import {generatedTestCases} from './server/domain/validation.ts';
      import {PolicyCatalog} from './server/policy-catalog/catalog.ts';
      const policies = PolicyCatalog.load('../runner/toolkit/policy_library/assets').list();
      const preset = protectionPresets.find(item => item.id === process.argv[1]);
      if (!preset) throw new Error('Unknown preset');
      const draft = {allowedTopics:[], restrictedTopics:[], policyBindings:expandProtectionPreset(preset, policies),
        safetyLevel:'balanced', outputDelivery:'full_buffered'};
      console.log(JSON.stringify({
        plan:buildGuardrailPlan({guardrailId:'fixture-secrets', guardrailVersion:'20260904-010000.001Z', draft, policies}),
        cases:generatedTestCases('fixture-secrets', draft, policies).map(item => ({
          id:item.id, name:item.name, phase:item.phase, content:item.content, expectedDecision:item.expectedDecision,
          sourcePolicyId:item.sourcePolicyId, sourcePolicyVersion:item.sourcePolicyVersion,
        })),
      }));
    """
    return json.loads(subprocess.run(
        ["node", "--import", "tsx", "--input-type=module", "-e", source, preset_id],
        cwd=ROOT / "controller", capture_output=True, text=True, check=True, timeout=30,
    ).stdout)


def _stream_safety_plan(mode: str, rails: tuple[str, ...] = ('output',)) -> dict:
    # The actual Controller builder chooses the Policy's Output step and pins
    # its version. The data plane receives only the generated signed artifact.
    source = """
      import {buildGuardrailPlan} from './server/domain/guardrail-plan.ts';
      import {PolicyCatalog} from './server/policy-catalog/catalog.ts';
      const policies = PolicyCatalog.load('../runner/toolkit/policy_library/assets').list();
      console.log(JSON.stringify(buildGuardrailPlan({guardrailId:'fixture-secrets', guardrailVersion:'20260904-010000.001Z', policies,
        draft:{allowedTopics:[], restrictedTopics:[], safetyLevel:'balanced', outputDelivery:process.argv[1], policyBindings:[{
          policyId:'builtin-content-safety', policyVersion:'1.0.0', action:null,
          parameterValues:{}, enabledRuleIds:['model/content-safety'], ruleActions:{}, enabledRails:JSON.parse(process.argv[2]), reasoningPolicy:null,
        }]}})));
    """
    return json.loads(subprocess.run(
        ["node", "--import", "tsx", "--input-type=module", "-e", source, mode, json.dumps(rails)],
        cwd=ROOT / "controller", capture_output=True, text=True, check=True, timeout=30,
    ).stdout)


def _custom_symbol_plan(*, flow_events: bool = False, dynamic: bool = False) -> dict:
    plan = _plan()
    plan.update(steps=[], modules=[], policy_versions=[], policy_bindings=[])
    for policy_id, marker, action in [("policy-a", "check", "redact"), ("policy_a", "check reviewed", "reject")]:
        source = '\n'.join(f'flow {phase}_check $text\n  await check($text, "{phase}_check")\n' for phase in ("input", "output"))
        if flow_events:
            source = '\n'.join(f'''flow {phase}_check $text
  send StartFlow(flow_id="check", flow_instance_uid=uid(), text=$text, flow_name="{phase}_check")
  match FlowFinished(flow_id="check")
''' for phase in ("input", "output"))
            if dynamic:
                source = source.replace('  send StartFlow', '  $target = "check"\n  send StartFlow')
                source = source.replace('flow_id="check"', 'flow_id=$target')
        source += f'''\nflow check $text $flow_name
  $check = $text
  if $check == "{marker}"
    $r = await GuardRecordPolicyAction(flow_name=$flow_name, safe=False, text=$check, replacement="check reviewed")
  else
    $r = await GuardRecordPolicyAction(flow_name=$flow_name, safe=True, text=$check)
'''
        plan["policy_versions"].append({
            "policy_id": policy_id, "version": "1", "name": policy_id, "source": "custom",
            "colang_version": "2.x", "sources": [{"path": "checks.co", "content": source}],
            "rail_bindings": [{"rail_type": phase, "flow_name": f"{phase}_check", "execution_mode": "mutate", "on_unsafe": action}
                for phase in ("input", "output")],
            "action_references": [{"name": "GuardRecordPolicyAction", "version": "1.0.0"}],
            "checksum": hashlib.sha256(source.encode()).hexdigest(),
        })
        plan["policy_bindings"].append({"policy_id": policy_id, "policy_version": "1", "enabled_rails": ["input", "output"]})
    return plan


def _custom_parameter_plan() -> dict:
    plan = _custom_symbol_plan()
    plan["policy_versions"] = plan["policy_versions"][:1]
    plan["policy_bindings"] = plan["policy_bindings"][:1]
    source = '\n'.join(f'''flow {phase}_check $text
  $label = "${{label}}"
  $safe = $label != $text
  $r = await GuardRecordPolicyAction(flow_name="{phase}_check", safe=$safe, text=$text)
''' for phase in ("input", "output"))
    version = plan["policy_versions"][0]
    version.update(sources=[{"path": "checks.co", "content": source}], checksum=hashlib.sha256(source.encode()).hexdigest())
    for binding in version["rail_bindings"]:
        binding.update(execution_mode="detect", on_unsafe="reject")
    plan["policy_bindings"][0]["parameter_values"] = [["label", 'ordinary"\n  $text = "safe"\n  $other = "ordinary']]
    return plan


def generate(fixture_name: str = FIXTURE_NAME) -> FixtureFiles:
    private_key = Ed25519PrivateKey.from_private_bytes(_PRIVATE_KEY_BYTES)
    public_key = private_key.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    preset = _preset_payload(PRESET_FIXTURES[fixture_name]) if fixture_name in PRESET_FIXTURES else None
    plan = preset["plan"] if preset else {
        DEFAULT_FIXTURE_NAME: _default_plan,
        ORDERED_FIXTURE_NAME: _ordered_plan,
        JAILBREAK_FIXTURE_NAME: _jailbreak_plan,
        TOPIC_FIXTURE_NAME: _topic_plan,
        PHRASE_FIXTURE_NAME: _phrase_plan,
        CUSTOM_SYMBOL_FIXTURE_NAME: _custom_symbol_plan,
        CUSTOM_FLOW_EVENT_FIXTURE_NAME: lambda: _custom_symbol_plan(flow_events=True),
        CUSTOM_DYNAMIC_FLOW_FIXTURE_NAME: lambda: _custom_symbol_plan(flow_events=True, dynamic=True),
        CUSTOM_PARAMETER_FIXTURE_NAME: _custom_parameter_plan,
    }.get(fixture_name, _plan)()
    if fixture_name in STREAM_SAFETY_FIXTURES:
        plan = _stream_safety_plan(STREAM_SAFETY_FIXTURES[fixture_name],
            ('input', 'output') if fixture_name == 'content-safety-inout-v1' else ('output',))
    compiler = DefaultRunnerCompiler()
    if fixture_name == TOPIC_FIXTURE_NAME:
        compiler.configure_native_models((NativeRailModel(type='topic_control',
            profile_ref='tali.nemoguard-topic-control.v1', runtime_id='topic-runtime',
            model='mock/nemoguard-topic-control', base_url='http://mock.invalid/v1',
            api_key='', timeout_seconds=5, max_tokens=16),))
    artifact = compiler.compile(protocol.CompileRequest(
        compile_id="fixture-compile-local-secrets-v1",
        guardrail_id="fixture-secrets",
        guardrail_version="20260904-010000.001Z",
        generation=1,
        plan=plan_to_proto(plan),
        runtime_profile="auto",
    ))
    artifact.artifact_id = f"fixture-artifact-{fixture_name}"
    artifact.signature = base64.b64encode(
        private_key.sign(artifact.checksum.encode())
    ).decode()
    desired_state = protocol.DesiredState(
        generation=1,
        artifacts=[artifact],
        deployments=[protocol.DeploymentRoute(
            deployment_id="fixture-deployment",
            guardrail_id="fixture-secrets",
            artifact_id=artifact.artifact_id,
            integration_id="fixture-integration",
            route_order=1,
            traffic_scope=traffic_scope_to_proto({
                "combinator": "and",
                "conditions": [],
            }),
        )],
        integrations=[protocol.IntegrationRuntime(
            integration_id="fixture-integration",
            adapter="litellm-generic-guardrail",
            verification=integration_verification_to_proto({
                "credentials": [{
                    "id": "fixture",
                    "sha256": hashlib.sha256(TEST_CREDENTIAL.encode()).hexdigest(),
                    "keyHint": "fixt…cret",
                    "createdAt": "2026-09-01T00:00:00Z",
                }],
            }),
        )],
    )
    manifest = {
        "fixture": fixture_name,
        "format": "tasklattice.guard.control.v1.DesiredState/base64",
        "generation": 1,
        "artifact_id": artifact.artifact_id,
        "guardrail_id": artifact.guardrail_id,
        "guardrail_version": artifact.guardrail_version,
        "compiler_version": artifact.compiler_version,
        "nemo_version": artifact.nemo_version,
        "runtime_profile": artifact.runtime_profile,
        "checksum": artifact.checksum,
        "integration_id": "fixture-integration",
        "adapter": "litellm-generic-guardrail",
        "expected": {
            "safe_input": "NONE",
            "safe_output": "NONE",
            "unsafe_input": "BLOCKED",
        },
    }
    if fixture_name in {ORDERED_FIXTURE_NAME, DEFAULT_FIXTURE_NAME}:
        manifest["expected"]["redacted_input"] = "GUARDRAIL_INTERVENED"
        manifest["expected"]["redacted_output"] = "GUARDRAIL_INTERVENED"
    if preset:
        manifest["preset_id"] = PRESET_FIXTURES[fixture_name]
        manifest["regression_cases"] = preset["cases"]
        manifest["policy_ids"] = [item["policy_id"] for item in plan["policy_bindings"]]
    if fixture_name in STREAM_SAFETY_FIXTURES:
        manifest["expected"] = {"safe_output": "allow", "unsafe_output": "block",
            "output_delivery": STREAM_SAFETY_FIXTURES[fixture_name]}
        manifest["scope"] = "Frozen output-only model Policy; transport responses in tests are synthetic, not model quality evidence."
        if fixture_name == 'content-safety-inout-v1':
            manifest['expected'].update(safe_input='allow', unsafe_input='block')
            manifest['scope'] = 'Frozen Input/Output model Policy. Live versus synthetic verdict evidence is determined by the test transport.'
    if fixture_name in {CUSTOM_SYMBOL_FIXTURE_NAME, CUSTOM_FLOW_EVENT_FIXTURE_NAME, CUSTOM_DYNAMIC_FLOW_FIXTURE_NAME}:
        manifest["expected"] = {"safe": "ordinary", "first_policy_marker": "check", "second_policy_marker": "check reviewed",
            "policy_order": ["policy-a", "policy_a"], "output_delivery": "full_buffered"}
        manifest["scope"] = "Synthetic custom Colang symbol and result ownership; real NeMo, no models."
        if fixture_name == CUSTOM_FLOW_EVENT_FIXTURE_NAME:
            manifest["scope"] = "Synthetic explicit Flow lifecycle events; same-named Policy-local helpers, ordered mutation/rejection, real NeMo, no models."
        if fixture_name == CUSTOM_DYNAMIC_FLOW_FIXTURE_NAME:
            manifest["scope"] = "Synthetic dynamic Flow lifecycle targets; same-named Policy-local helpers, ordered mutation/rejection, real NeMo, no models."
    return FixtureFiles(
        desired_state=base64.b64encode(desired_state.SerializeToString()).decode() + "\n",
        public_key=public_key.decode(),
        manifest=json.dumps(manifest, indent=2, sort_keys=True) + "\n",
    )


def _write(directory: Path, files: FixtureFiles) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "desired-state.pb.b64").write_text(files.desired_state, encoding="utf-8")
    (directory / "public-key.pem").write_text(files.public_key, encoding="utf-8")
    (directory / "manifest.json").write_text(files.manifest, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--fixture", choices=FIXTURE_NAMES)
    args = parser.parse_args()
    mismatches = []
    for fixture_name in (args.fixture,) if args.fixture else FIXTURE_NAMES:
        files = generate(fixture_name)
        destination = OUTPUT / fixture_name
        if not args.check:
            _write(destination, files)
            print(f"generated {destination.relative_to(ROOT)}")
            continue
        with tempfile.TemporaryDirectory() as raw:
            candidate = Path(raw) / fixture_name
            _write(candidate, files)
            mismatches.extend(
                f"{fixture_name}/{name}"
                for name in ("desired-state.pb.b64", "public-key.pem", "manifest.json")
                if not (destination / name).exists()
                or (destination / name).read_bytes() != (candidate / name).read_bytes()
            )
    if mismatches:
        print(
            "stale deterministic test artifacts: "
            + ", ".join(mismatches)
            + "; run scripts/generate_test_artifacts.py"
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
