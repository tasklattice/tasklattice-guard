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
FIXTURE_NAMES = (FIXTURE_NAME, ORDERED_FIXTURE_NAME, DEFAULT_FIXTURE_NAME, JAILBREAK_FIXTURE_NAME)
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


def generate(fixture_name: str = FIXTURE_NAME) -> FixtureFiles:
    private_key = Ed25519PrivateKey.from_private_bytes(_PRIVATE_KEY_BYTES)
    public_key = private_key.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    artifact = DefaultRunnerCompiler().compile(protocol.CompileRequest(
        compile_id="fixture-compile-local-secrets-v1",
        guardrail_id="fixture-secrets",
        guardrail_version="20260904-010000.001Z",
        generation=1,
        plan=plan_to_proto({
            DEFAULT_FIXTURE_NAME: _default_plan,
            ORDERED_FIXTURE_NAME: _ordered_plan,
            JAILBREAK_FIXTURE_NAME: _jailbreak_plan,
        }.get(fixture_name, _plan)()),
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
