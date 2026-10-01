"""Authoring bootstrap, package transfer and real Controller/Runner behavior."""
from __future__ import annotations

from copy import deepcopy
from dataclasses import replace
import json
from pathlib import Path
import shutil
import subprocess

import pytest
import yaml

from runner.toolkit.policy_library.declarative import PolicyDefinition, compile_policy, parse_yaml
from scripts import policy_sources as sources
from runner.toolkit.policy_library.package import load_package, open_package
from runner.toolkit.policy_library.regression import run_packages, test_parameters as parameters_for_test

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def example():
    return load_package(ROOT / "policies/examples/customer-information").definition.model_dump(exclude_unset=True)


def definition(value):
    return PolicyDefinition.model_validate(value)


@pytest.fixture
def isolated_catalog(tmp_path, monkeypatch):
    source = tmp_path / "policies"
    assets = tmp_path / "assets"
    shutil.copytree(ROOT / "policies", source)
    shutil.copytree(ROOT / "runner/toolkit/policy_library/assets", assets)
    monkeypatch.setattr(sources, "SOURCE", source)
    monkeypatch.setattr(sources, "ASSETS", assets)
    return source, assets


def test_all_bundled_sources_bootstrap_the_current_runtime_catalog():
    output = sources.build()
    for path, raw in output.items():
        assert json.loads(path.read_text()) == json.loads(raw), f"Generated asset drift: {path}"
    manifest = yaml.safe_load((sources.SOURCE / "catalog.yaml").read_text())
    for collection in manifest["collections"]:
        if collection["asset"] == "custom_policies.json":
            continue
        compiled = json.loads(output[sources.ASSETS / collection["asset"]])
        assert len(compiled) == len(collection["policies"])
        for item, relative in zip(compiled, collection["policies"], strict=True):
            declared = load_package(sources.source_path(relative)).definition
            assert item["source"] == "built_in"
            assert len(item["rules"]) == len(declared.rules)
            assert len(item["test_cases"]) == len(declared.tests)


@pytest.mark.parametrize("mutate, message", [
    (lambda p: p.update(unknown=True), "Extra inputs"),
    (lambda p: p["rules"][0].update(form="regex"), "Extra inputs"),
    (lambda p: p["rules"][0]["detector"].update(ref="text/regex-pattern"), "detector/version unavailable"),
    (lambda p: p["rules"][0]["detector"]["parameters"].update(keywords=[]), "unknown detector parameters"),
    (lambda p: p["rules"].append(deepcopy(p["rules"][0])), "Rule IDs must be unique"),
    (lambda p: p["rules"][0].update(stages=["retrieval"]), "input"),
    (lambda p: p["rules"][0].update(risk_level="urgent"), "critical"),
    (lambda p: p["rules"][0]["on_match"].update(action="execute"), "Input should be"),
    (lambda p: p["rules"][0]["detector"].update(version="99"), "detector/version unavailable"),
    (lambda p: p["rules"][0]["detector"]["parameters"].update(expression="["), "unterminated"),
    (lambda p: p["rules"][0]["detector"]["parameters"].update(expression=5), "invalid expression"),
    (lambda p: p["rules"][0]["detector"]["parameters"].update(context_max_gap_words=True), "invalid context_max_gap_words"),
    (lambda p: p["rules"][0]["detector"]["parameters"].update(script="exec"), "unknown detector parameters"),
    (lambda p: p["rules"][0]["metadata"].update(taxonomy_ids=["TALI-NONEXISTENT"]), "unknown TALI Taxonomy"),
    (lambda p: p["tests"][0].update(covered_rule_ids=["missing"]), "unknown Rules"),
    (lambda p: p["tests"][0].update(kind="scenario"), "requires an acceptance test"),
    (lambda p: p["tests"][0].update(phase="input"), "unsupported Rule stage"),
    (lambda p: p["rules"][0].update(runtime_adapter={"binding_id": "platform", "implementation_rule_id": "id"}), "built-in provenance"),
    (lambda p: p["metadata"].update(compliance={}), "compliance review"),
    (lambda p: p["metadata"].update(id="builtin-secrets"), "platform-native Policy ID"),
    (lambda p: p["rules"][0]["on_match"].update(action="block"), "does not accept replacement"),
    (lambda p: p["rules"][0]["detector"].update(ref="model/grounding", parameters={}), "model-backed detector registration"),
])
def test_invalid_or_unimplemented_definitions_fail_before_import(example, mutate, message):
    mutate(example)
    with pytest.raises((ValueError, TypeError), match=message):
        compile_policy(definition(example), sources.registry())


@pytest.mark.parametrize("adapter", [{"detector": "unregistered"}, {"execution": "platform"}])
def test_invalid_local_detector_returns_error_instead_of_silent_allow(example, adapter):
    from runner.toolkit.policy_library.loader import _policy
    from runner.toolkit.nemo.actions.content_filter import BuiltinContentFilter

    compiled = _policy(compile_policy(definition(example), sources.registry()))
    rule = compiled.rules[0]
    invalid = replace(compiled, rules=(replace(rule, implementation=replace(rule.implementation, **adapter)),))
    result = BuiltinContentFilter().evaluate(
        text="CUS-123456", phase="output", policies=[compiled.id], definitions={compiled.id: invalid},
    )
    assert result.verdict == "error"
    assert "Rule" in result.reason
    assert result.content == "CUS-123456"
    assert not result.findings


def test_compiled_rules_keep_versioned_detector_identity_without_form_taxonomy(example):
    compiled = compile_policy(definition(example), sources.registry())
    assert [rule["detector"] for rule in compiled["rules"]] == [
        {"ref": "text/regex", "version": "1.0.0"}, {"ref": "text/keyword", "version": "1.0.0"},
    ]
    for rule in compiled["rules"]:
        assert "form" not in rule
        assert "form" not in rule["implementation"]
        assert rule["implementation"]["execution"] == "local"
        assert rule["implementation"]["action_name"] == "GuardContentFilterAction"


@pytest.mark.parametrize("raw", [
    "schema_version: 1\nschema_version: 1\n",
    "rules: &rules [*rules]\n",
    "!!python/object/apply:os.system ['invalid']",
    "1: invalid-key\n",
])
def test_unsafe_or_ambiguous_yaml_is_rejected(raw):
    with pytest.raises((ValueError, yaml.YAMLError)):
        parse_yaml(raw)


async def test_example_checks_text_and_rule_identity_not_only_decisions(tmp_path):
    root = tmp_path / "example"
    shutil.copytree(ROOT / "policies/examples/customer-information", root)
    package = load_package(root)
    report = await run_packages([package], sources.registry(), sources.ASSETS)
    assert report["summary"] == {"passed": 4, "failed": 0, "not_run": 0}
    file = root / "tests/acceptance.yaml"
    cases = yaml.safe_load(file.read_text())
    cases[0]["expected_text"] = "incorrect mask"
    file.write_text(yaml.safe_dump(cases, allow_unicode=True))
    report = await run_packages([load_package(root)], sources.registry(), sources.ASSETS)
    assert report["summary"]["failed"] == 1
    assert "Replacement text" in report["policies"][0]["cases"][0]["reason"]


def test_redaction_feeds_the_next_rule_and_rejection_short_circuits(example):
    # The second Rule looks for the original customer ID. It should only block
    # when placed first, since redaction changes the next Rule's input.
    example["rules"][1]["detector"]["parameters"]["keywords"] = [["CUS-123456", "high"]]
    example["tests"][1]["content"] = "CUS-123456"
    compiled = compile_policy(definition(example), sources.registry())
    from runner.toolkit.policy_library.loader import _policy
    from runner.toolkit.nemo.actions.content_filter import BuiltinContentFilter
    spec = _policy(compiled)
    args = dict(text="CUS-123456", phase="output", policies=[spec.id], definitions={spec.id: spec})
    engine = BuiltinContentFilter()
    transformed = engine.evaluate(**args)
    assert transformed.content == "[客户编号已隐藏]"
    assert [f.rule_id for f in transformed.findings] == ["customer-id"]
    blocked = engine.evaluate(**args, rule_order={spec.id: ["internal-secret", "customer-id"]})
    assert blocked.content == "CUS-123456"
    assert [f.recommended_action for f in blocked.findings] == ["block"]
    observed = engine.evaluate(**args, policy_rule_actions={spec.id: {"customer-id": "allow"}})
    assert [f.recommended_action for f in observed.findings] == ["allow", "block"]


def test_import_export_round_trip_and_version_guard(isolated_catalog):
    source, assets = isolated_catalog
    original = source / "examples/customer-information"
    archive = source.parent / "exported.zip"
    sources.export_policy(original, archive)
    imported = sources.import_policy(archive)
    assert load_package(imported).files == load_package(original).files
    assert json.loads((assets / "custom_policies.json").read_text())[0]["source"] == "custom"
    with pytest.raises(ValueError, match="already imported"):
        sources.import_policy(archive)
    file = original / "policy.yaml"
    changed = yaml.safe_load(file.read_text())
    changed["metadata"]["name"] = "Updated name"
    file.write_text(yaml.safe_dump(changed, allow_unicode=True))
    before = load_package(imported).checksum
    with pytest.raises(ValueError, match="require a new version"):
        sources.import_policy(original, replace=True)
    assert load_package(imported).checksum == before
    changed["metadata"]["version"] = "1.1.0"
    file.write_text(yaml.safe_dump(changed, allow_unicode=True))
    sources.import_policy(original, replace=True)
    assert load_package(imported).definition.metadata.version == "1.1.0"
    with pytest.raises(ValueError, match="Export destination exists"):
        sources.export_policy(imported, archive)


def test_custom_packages_cannot_replace_bundled_or_transport_secret_defaults(isolated_catalog, example):
    source, _ = isolated_catalog
    file = source / "examples/customer-information/policy.yaml"
    manifest = yaml.safe_load(file.read_text())
    manifest["metadata"]["id"] = "local-contact-data"
    file.write_text(yaml.safe_dump(manifest, allow_unicode=True))
    with pytest.raises(ValueError, match="bundled Policy ID"):
        sources.import_policy(file.parent)
    example["metadata"]["id"] = "customer-information"
    example["parameters"] = [{"name": "api_key", "kind": "secret", "required": True, "default": "do-not-transport"}]
    with pytest.raises(ValueError, match="Secret parameter defaults"):
        definition(example)


@pytest.mark.parametrize("values", [{"unknown": "value"}, {"value": 1}, []])
def test_test_values_must_be_declared_string_parameters(example, values):
    with pytest.raises(ValueError, match="test parameters|Test parameters"):
        parameters_for_test(load_package(ROOT / "policies/examples/customer-information"), values)


async def test_imported_yaml_compiles_in_controller_and_executes_without_runtime_catalog(isolated_catalog, monkeypatch):
    source, assets = isolated_catalog
    sources.import_policy(source / "examples/customer-information")
    script = '''
      import { PolicyCatalog } from "./server/policy-catalog/catalog.ts";
      import { buildGuardrailPlan } from "./server/domain/guardrail-plan.ts";
      const policies = PolicyCatalog.load(process.argv[1]).list();
      const policy = policies.find(p => p.id === "customer-information");
      console.log(JSON.stringify(buildGuardrailPlan({
        guardrailId: "declarative", guardrailVersion: "20260930-010000.001Z", policies,
        draft: { allowedTopics: [], restrictedTopics: [], safetyLevel: "balanced", outputDelivery: "full_buffered",
          policyBindings: [{ policyId: policy.id, policyVersion: policy.version, action: null, parameterValues: {},
            enabledRuleIds: policy.rules.map(r => r.id), ruleOrder: policy.rules.map(r => r.id), ruleActions: {},
            enabledRails: ["output"], reasoningPolicy: null }] }
      })));
    '''
    result = subprocess.run(["node", "--import", "tsx", "--input-type=module", "-e", script, str(assets)], cwd=ROOT / "controller", capture_output=True, text=True, check=True)
    plan = json.loads(result.stdout)
    from runner.toolkit.nemo.actions import content_filter
    from runner.compiler import DefaultRunnerCompiler
    from runner.draft_preview import DraftPreviewRuntime
    from runner.toolkit.nemo.action_registry import action_providers
    from runner.toolkit.runtime.contracts import ProtectionRequest, RequestContext

    def unavailable(_):
        raise AssertionError("Published Rules must come from the pinned plan, not the mutable catalog")

    monkeypatch.setattr(content_filter, "policy", unavailable)
    runtime = DraftPreviewRuntime(
        DefaultRunnerCompiler(),
        action_providers(content_filter.ContentFilterActionProvider()),
    )
    try:
        for text, expected, output in [("普通订单回复", "allow", None), ("CUS-123456", "transform", "[客户编号已隐藏]"), ("INTERNAL_SECRET", "block", None)]:
            decision = await runtime.evaluate(ProtectionRequest(phase="output", texts=(text,), context=RequestContext(protocol="test")),
                preview_id="declarative", guardrail_id=plan["guardrail_id"], draft_revision=1,
                candidate_version=plan["guardrail_version"], plan=plan, runtime_profile="auto")
            assert not decision.usage.fail_closed, decision.reason
            assert decision.decision == expected
            assert decision.usage.model_invocations == 0
            if output:
                assert decision.texts == (output,)
                assert [(f.policy_id, f.rule_id, f.risk_severity) for f in decision.findings] == [("customer-information", "customer-id", "medium")]
    finally:
        await runtime.shutdown()


def test_metadata_owns_rule_order_and_rejects_unlisted_files(tmp_path):
    root = tmp_path / "package"
    shutil.copytree(ROOT / "policies/examples/customer-information", root)
    manifest = root / "policy.yaml"
    value = yaml.safe_load(manifest.read_text())
    value["rules"].reverse()
    manifest.write_text(yaml.safe_dump(value, allow_unicode=True))
    assert [r.id for r in load_package(root).definition.rules] == ["internal-secret", "customer-id"]
    (root / "rules/forgotten.yaml").write_text("id: forgotten")
    with pytest.raises(ValueError, match="Unlisted package files"):
        load_package(root)


@pytest.mark.parametrize("relative", ["../escape.yaml", "/tmp/escape.yaml", "rules/../escape.yaml", "rules\\escape.yaml"])
def test_package_references_cannot_escape_their_root(tmp_path, relative):
    root = tmp_path / "package"
    shutil.copytree(ROOT / "policies/examples/customer-information", root)
    file = root / "policy.yaml"
    value = yaml.safe_load(file.read_text())
    value["rules"][0] = relative
    file.write_text(yaml.safe_dump(value))
    with pytest.raises(ValueError, match="Unsafe package path"):
        load_package(root)


def test_rule_files_must_contain_one_rule_and_symlinks_are_rejected(tmp_path):
    root = tmp_path / "package"
    shutil.copytree(ROOT / "policies/examples/customer-information", root)
    file = root / "rules/customer-id.yaml"
    original = file.read_text()
    file.write_text(yaml.safe_dump([yaml.safe_load(original)]))
    with pytest.raises(ValueError):
        load_package(root)
    file.unlink()
    target = tmp_path / "outside.yaml"
    target.write_text(original)
    file.symlink_to(target)
    with pytest.raises(ValueError, match="symlink"):
        load_package(root)


def test_resources_and_test_fixtures_round_trip_with_the_archive(tmp_path):
    root = tmp_path / "package"
    shutil.copytree(ROOT / "policies/examples/customer-information", root)
    manifest_file = root / "policy.yaml"
    manifest = yaml.safe_load(manifest_file.read_text())
    manifest["resources"] = ["fixtures/normal.txt"]
    manifest_file.write_text(yaml.safe_dump(manifest, allow_unicode=True))
    (root / "fixtures").mkdir()
    (root / "fixtures/normal.txt").write_text("普通回复")
    tests = root / "tests/regression.yaml"
    cases = yaml.safe_load(tests.read_text())
    cases[0]["content"] = {"$ref": "fixtures/normal.txt"}
    tests.write_text(yaml.safe_dump(cases, allow_unicode=True))
    archive = tmp_path / "policy.zip"
    sources.export_policy(root, archive)
    with open_package(archive, sources.registry()) as imported:
        assert imported.files == load_package(root).files
        assert next(case for case in imported.definition.tests if case.id == "normal-reply").content == "普通回复"
    # Deterministic packaging produces the same archive bytes.
    other = tmp_path / "other.zip"
    sources.export_policy(root, other)
    assert archive.read_bytes() == other.read_bytes()


@pytest.mark.parametrize("mutation", ["tamper", "traversal", "detector", "duplicate", "symlink"])
def test_archive_integrity_and_dependency_validation(tmp_path, mutation):
    import stat
    from zipfile import ZipFile, ZipInfo
    archive = tmp_path / "original.zip"
    sources.export_policy(ROOT / "policies/examples/customer-information", archive)
    with ZipFile(archive) as source:
        entries = {name: source.read(name) for name in source.namelist()}
    if mutation == "tamper":
        entries["rules/customer-id.yaml"] += b"\n# tampered"
    if mutation == "traversal":
        entries["../escape.yaml"] = b"bad"
    if mutation == "detector":
        manifest = json.loads(entries["manifest.json"])
        manifest["detectors"]["text/regex"]["sha256"] = "wrong"
        entries["manifest.json"] = json.dumps(manifest).encode()
    invalid = tmp_path / "invalid.zip"
    with ZipFile(invalid, "w") as target:
        for name, content in entries.items():
            info = ZipInfo(name)
            if mutation == "symlink" and name == "policy.yaml":
                info.external_attr = (stat.S_IFLNK | 0o777) << 16
            target.writestr(info, content)
        if mutation == "duplicate":
            with pytest.warns(UserWarning):
                target.writestr("policy.yaml", entries["policy.yaml"])
    with pytest.raises(ValueError):
        with open_package(invalid, sources.registry()):
            pass
    assert not (tmp_path / "escape.yaml").exists()


def test_failed_candidate_build_restores_the_imported_package(isolated_catalog, monkeypatch):
    source, assets = isolated_catalog
    original = source / "examples/customer-information"
    imported = sources.import_policy(original)
    previous = load_package(imported).files
    catalog = (assets / "custom_policies.json").read_bytes()
    file = original / "policy.yaml"
    value = yaml.safe_load(file.read_text())
    value["metadata"]["version"] = "2.0.0"
    file.write_text(yaml.safe_dump(value, allow_unicode=True))
    monkeypatch.setattr(sources, "build", lambda: (_ for _ in ()).throw(ValueError("candidate invalid")))
    with pytest.raises(ValueError, match="candidate invalid"):
        sources.import_policy(original, replace=True)
    assert load_package(imported).files == previous
    assert (assets / "custom_policies.json").read_bytes() == catalog


def test_built_in_rules_use_the_same_stage_coverage_gate(example):
    example["metadata"]["source"] = "built_in"
    example["tests"] = [case for case in example["tests"] if "customer-id" not in case["covered_rule_ids"]]
    with pytest.raises(ValueError, match="requires an acceptance test"):
        definition(example)


async def test_model_tests_are_explicitly_not_run_without_a_model_environment():
    package = load_package(ROOT / "policies/builtin/builtin-jailbreak")
    report = await run_packages([package], sources.registry(), sources.ASSETS)
    assert report["summary"] == {"passed": 0, "failed": 0, "not_run": len(package.definition.tests)}
    assert all(case["status"] == "not_run" for case in report["policies"][0]["cases"])


async def test_regression_uses_manifest_order_for_rule_and_policy_scopes(tmp_path):
    root = tmp_path / "package"
    shutil.copytree(ROOT / "policies/examples/customer-information", root)
    file = root / "tests/regression.yaml"
    cases = yaml.safe_load(file.read_text())
    cases[-1]["scope"] = "rule"
    cases[-1]["covered_rule_ids"].reverse()
    file.write_text(yaml.safe_dump(cases, allow_unicode=True))
    report = await run_packages([load_package(root)], sources.registry(), sources.ASSETS)
    assert report["summary"] == {"passed": 4, "failed": 0, "not_run": 0}
    # Manifest order changes actual behavior: reject now stops before redaction.
    file = root / "policy.yaml"
    manifest = yaml.safe_load(file.read_text())
    manifest["rules"].reverse()
    file.write_text(yaml.safe_dump(manifest, allow_unicode=True))
    report = await run_packages([load_package(root)], sources.registry(), sources.ASSETS)
    assert report["summary"]["failed"] == 1
    failure = next(case for case in report["policies"][0]["cases"] if case["status"] == "failed")
    assert failure["id"] == "combined-reply"
    assert "Expected Rules" in failure["reason"]


def test_generated_outputs_are_restored_after_a_partial_write(tmp_path, monkeypatch):
    first, second, third = [tmp_path / f"{name}.json" for name in ("first", "second", "third")]
    first.write_text('{"previous":true}\n')
    replace = Path.replace
    def fail_last(path, target):
        if target == third:
            raise OSError("write failed")
        return replace(path, target)
    monkeypatch.setattr(Path, "replace", fail_last)
    with pytest.raises(OSError, match="write failed"):
        sources.write_outputs({first: '{}', second: '{}', third: '{}'})
    assert first.read_text() == '{"previous":true}\n'
    assert not second.exists()
    assert not third.exists()
    assert list(tmp_path.iterdir()) == [first]


def test_cyclic_resources_are_rejected_before_compilation(tmp_path):
    root = tmp_path / "package"
    shutil.copytree(ROOT / "policies/examples/customer-information", root)
    file = root / "policy.yaml"
    manifest = yaml.safe_load(file.read_text())
    manifest["resources"] = ["resources/cycle.yaml"]
    file.write_text(yaml.safe_dump(manifest, allow_unicode=True))
    (root / "resources").mkdir()
    (root / "resources/cycle.yaml").write_text('$ref: resources/cycle.yaml\n')
    file = root / "rules/customer-id.yaml"
    rule = yaml.safe_load(file.read_text())
    rule["detector"]["parameters"]["expression"] = {"$ref": "resources/cycle.yaml"}
    file.write_text(yaml.safe_dump(rule, allow_unicode=True))
    with pytest.raises(ValueError, match="Cyclic package resource"):
        load_package(root)
