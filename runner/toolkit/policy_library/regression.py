"""Run package-owned expectations through the real Controller -> NeMo pipeline."""
from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

from .declarative import compile_policy
from .materialization import materialize_test_text
from .package import PolicyPackage, detector_dependencies

ROOT = Path(__file__).resolve().parents[3]


def test_parameters(package: PolicyPackage, overrides: dict[str, str]) -> dict[str, str]:
    if not isinstance(overrides, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in overrides.items()):
        raise ValueError("Test parameters must be a JSON object of string values")
    declared = package.definition.parameters
    unknown = overrides.keys() - {p.name for p in declared}
    if unknown:
        raise ValueError(f"Unknown test parameters: {sorted(unknown)}")
    values = {p.name: p.default for p in declared if p.default is not None}
    values.update(package.manifest.testing.parameters)
    values.update(overrides)
    missing = [p.name for p in declared if p.required and not values.get(p.name)]
    if missing:
        raise ValueError(f"Missing synthetic test parameters for {package.definition.metadata.id}: {missing}")
    return values


async def run_packages(packages: list[PolicyPackage], registry: dict, assets: Path, overrides: dict[str, str] | None = None) -> dict:
    from runner.compiler import DefaultRunnerCompiler
    from runner.draft_preview import DraftPreviewRuntime
    from runner.toolkit.nemo.action_registry import action_providers
    from runner.toolkit.nemo.actions.content_filter import ContentFilterActionProvider
    from runner.toolkit.runtime.contracts import ProtectionRequest, RequestContext

    report = {"schema_version": 1, "engine": "controller-plan+nemo-runtime", "policies": [], "summary": {"passed": 0, "failed": 0, "not_run": 0}}
    jobs = []
    for package in packages:
        definition = package.definition
        compiled = compile_policy(definition, registry)
        result = {"id": definition.metadata.id, "version": definition.metadata.version, "source_sha256": package.checksum,
                  "detectors": detector_dependencies(package, registry), "cases": []}
        report["policies"].append(result)
        if any(rule["implementation"]["execution"] != "local" for rule in compiled["rules"]):
            result["cases"] = [{"id": case.id, "status": "not_run", "reason": "requires configured model evaluation"} for case in definition.tests]
            report["summary"]["not_run"] += len(result["cases"])
            continue
        values = test_parameters(package, overrides if overrides is not None else {})
        groups = {}
        for case in definition.tests:
            selected = tuple(rule.id for rule in definition.rules if case.scope == "policy" or rule.id in case.covered_rule_ids)
            groups.setdefault(selected, []).append(case)
        for selected, cases in groups.items():
            jobs.append((package, compiled, values, result, selected, cases))
    if not jobs:
        return report

    with tempfile.TemporaryDirectory(prefix="guard-policy-regression-") as temporary:
        directory = Path(temporary) / "assets"
        shutil.copytree(assets, directory)
        # One current definition per ID. Sources under test replace generated
        # catalog definitions; the package is the authority for this run.
        from .loader import _ASSET_PATHS
        for path in (*_ASSET_PATHS, Path("legacy_topic_policies.json")):
            (directory / path.name).write_text("[]")
        for name, origin in (("builtin_policies.json", "built_in"), ("custom_policies.json", "custom")):
            (directory / name).write_text(json.dumps(list({compiled["id"]: compiled for _, compiled, _, _, _, _ in jobs if compiled["source"] == origin}.values())))
        payload = {"assets": str(directory), "jobs": [{"id": p.definition.metadata.id, "parameters": values, "rules": selected} for p, _, values, _, selected, _ in jobs]}
        compiled_plans = subprocess.run(
            ["node", "--import", "tsx", str(ROOT / "scripts/policy-regression-plans.mjs")],
            input=json.dumps(payload), cwd=ROOT / "controller", text=True, capture_output=True,
        )
        if compiled_plans.returncode:
            raise ValueError(f"Controller plan compilation failed: {compiled_plans.stderr.strip()}")
        plans = json.loads(compiled_plans.stdout)

    for (package, _, values, result, _, cases), plan in zip(jobs, plans, strict=True):
        runtime = DraftPreviewRuntime(DefaultRunnerCompiler(), action_providers(ContentFilterActionProvider()))
        identity = dict(preview_id=package.checksum, guardrail_id=plan["guardrail_id"], draft_revision=1,
                        candidate_version=plan["guardrail_version"], plan=plan, runtime_profile="auto")
        completed = 0
        try:
            descriptor = await runtime.prepare(**identity)
            result["compiler_version"] = descriptor["compiler_version"]
            result["runtime_profile"] = descriptor["runtime_profile"]
            for test in cases:
                started = time.monotonic()
                case = {"id": test.id, "phase": test.phase, "scope": test.scope, "status": "passed"}
                try:
                    text = materialize_test_text(test.content, tuple(test.parameter_names), values)
                    decision = await runtime.evaluate(ProtectionRequest(phase=test.phase, texts=(text,), context=RequestContext(protocol="policy-regression")), **identity)
                    matched = list(dict.fromkeys(f.rule_id for f in decision.findings if f.policy_id == package.definition.metadata.id))
                    expected = decision.decision != "allow" if test.expected_decision == "intervene" else decision.decision == test.expected_decision
                    if not decision.usage or decision.usage.fail_closed:
                        raise ValueError(f"Execution failed: {decision.reason}")
                    if not expected:
                        raise ValueError(f"Expected {test.expected_decision}, got {decision.decision}: {decision.reason}")
                    if test.expected_text is not None and decision.texts != (test.expected_text,):
                        raise ValueError("Replacement text did not match")
                    if test.expected_matched_rules is not None and matched != test.expected_matched_rules:
                        raise ValueError(f"Expected Rules {test.expected_matched_rules}, got {matched}")
                    if test.kind == "rule_acceptance" and not all(any(id == rule or id.startswith(rule + "/") for id in matched) for rule in test.covered_rule_ids):
                        raise ValueError(f"Acceptance did not detect declared Rules {test.covered_rule_ids}; got {matched}")
                    if decision.usage.model_invocations:
                        raise ValueError("Local Policy unexpectedly invoked a model")
                except Exception as error:
                    case.update(status="failed", reason=str(error))
                case["duration_ms"] = round((time.monotonic() - started) * 1000)
                result["cases"].append(case)
                report["summary"][case["status"]] += 1
                completed += 1
        except Exception as error:
            remaining = cases[completed:]
            result["cases"].extend({"id": case.id, "status": "failed", "reason": str(error)} for case in remaining)
            report["summary"]["failed"] += len(remaining)
        finally:
            await runtime.shutdown()
    return report
