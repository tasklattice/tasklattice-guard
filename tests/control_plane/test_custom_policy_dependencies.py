"""Policy source declarations must be checked by the production compiler entry."""
from copy import deepcopy

import pytest

from runner import generated as protocol
from runner.compiler import DefaultRunnerCompiler
from runner.protocol_codec import plan_to_proto
from runner.toolkit.compiler.domain import PlanCompilationError


def custom_plan(source, references=()):
    return {
        "guardrail_id": "dependency-contract", "guardrail_version": "20260906-100000.001Z",
        "compiler_version": "test", "safety_level": "balanced",
        "output_delivery": "full_buffered", "steps": [], "modules": [],
        "policy_versions": [{
            "policy_id": "custom", "version": "1", "name": "Custom", "source": "custom",
            "colang_version": "2.x", "checksum": "test",
            "sources": [{"path": "main.co", "content": source}],
            "rail_bindings": [{"rail_type": "input", "flow_name": "check",
                "execution_mode": "detect", "on_unsafe": "reject"}],
            "action_references": [{"name": name, "version": "1.0.0"} for name in references],
        }],
        "policy_bindings": [{"policy_id": "custom", "policy_version": "1", "enabled_rails": ["input"]}],
    }


def compile_plan(plan):
    return DefaultRunnerCompiler().compile(protocol.CompileRequest(
        compile_id="dependencies", guardrail_id=plan["guardrail_id"],
        guardrail_version=plan["guardrail_version"], generation=1,
        plan=plan_to_proto(plan), runtime_profile="auto"))


@pytest.mark.parametrize("operation", ["await", "start"])
@pytest.mark.parametrize("nested", [False, True])
def test_compile_rejects_unreferenced_action_even_in_uncovered_branch(operation, nested):
    source = (f"flow check $text\n  if False\n    {operation} GuardCustomerIdentifierAction(text=$text)\n"
        if nested else f"flow check $text\n  {operation} GuardCustomerIdentifierAction(text=$text)\n")
    with pytest.raises(PlanCompilationError, match="unreferenced Action.*GuardCustomerIdentifierAction"):
        compile_plan(custom_plan(source))


@pytest.mark.parametrize("nested", [False, True])
@pytest.mark.parametrize("statement", [
    'send StartGuardCustomerIdentifierAction(text=$text)',
    'send Notice() and StartGuardCustomerIdentifierAction(text=$text)',
    'send (Notice() or StartGuardCustomerIdentifierAction(text=$text))',
])
def test_action_start_event_requires_policy_owned_dependency(nested, statement):
    source = (f"flow check $text\n  if False\n    {statement}\n" if nested
              else f"flow check $text\n  {statement}\n")
    with pytest.raises(PlanCompilationError, match="unreferenced Action.*GuardCustomerIdentifierAction"):
        compile_plan(custom_plan(source))


def test_declared_action_start_event_is_not_disabled():
    artifact = compile_plan(custom_plan(
        'flow check $text\n  send StartGuardCustomerIdentifierAction(text=$text)\n',
        ["GuardCustomerIdentifierAction"],
    ))
    from runner.protocol_codec import artifact_content
    manifest = artifact_content(artifact)["dependencyManifest"]
    assert ["action", "GuardCustomerIdentifierAction", "1.0.0"] in manifest


def test_observing_action_start_event_does_not_invoke_it():
    assert compile_plan(custom_plan(
        'flow check $text\n  match StartGuardCustomerIdentifierAction()\n',
    )).checksum


@pytest.mark.parametrize("phase", ["input", "output"])
async def test_declared_event_action_must_be_available_before_validation(phase):
    from runner.protocol_codec import validation_test_to_proto
    from runner.validator import DefaultRunnerValidator

    plan = custom_plan(
        'flow check $text\n  if False\n    send StartExternalReviewAction(text=$text)\n',
        ["ExternalReviewAction"],
    )
    plan["policy_versions"][0]["rail_bindings"][0]["rail_type"] = phase
    plan["policy_bindings"][0]["enabled_rails"] = [phase]
    request = protocol.ValidationRequest(
        run_id="event-dependency", guardrail_id=plan["guardrail_id"],
        candidate_version=plan["guardrail_version"], source_draft_revision=1,
        plan=plan_to_proto(plan), runtime_profile="auto",
        test_cases=[validation_test_to_proto({"id": "benign", "name": "Uncovered event branch",
            "phase": phase, "content": "ordinary", "expectedDecision": "allow", "required": True})],
    )
    with pytest.raises(PlanCompilationError, match="providers are unavailable.*ExternalReviewAction"):
        await DefaultRunnerValidator(DefaultRunnerCompiler()).validate(request)


@pytest.mark.parametrize("call", ["await missing", "await missing()", "activate missing", "start missing"])
def test_compile_rejects_undefined_flow_without_requiring_parentheses(call):
    with pytest.raises(PlanCompilationError, match="undefined Flow.*missing"):
        compile_plan(custom_plan(f"flow check $text\n  {call}\n"))


@pytest.mark.parametrize("call", ["await GuardCustomerIdentifierAction", "send StartGuardCustomerIdentifierAction"])
def test_action_reference_is_owned_by_policy_not_borrowed_from_another_policy(call):
    plan = custom_plan(f"flow check $text\n  {call}(text=$text)\n")
    other = deepcopy(plan["policy_versions"][0])
    other.update(policy_id="other", sources=[{"path": "other.co", "content": "flow check $text\n  pass\n"}],
        action_references=[{"name": "GuardCustomerIdentifierAction", "version": "1.0.0"}])
    plan["policy_versions"].append(other)
    plan["policy_bindings"].append({"policy_id": "other", "policy_version": "1", "enabled_rails": ["input"]})
    with pytest.raises(PlanCompilationError, match="unreferenced Action"):
        compile_plan(plan)


def test_comments_and_literals_are_not_calls_or_declarations():
    plan = custom_plan('flow check $text\n  # await MissingAction()\n  $s = "await GhostAction()"\n  pass\n')
    assert compile_plan(plan).checksum


def test_local_helper_flow_and_declared_action_compile():
    plan = custom_plan('flow check $text\n  await helper($text)\n\nflow helper $text\n  await GuardCustomerIdentifierAction(text=$text)\n',
        ["GuardCustomerIdentifierAction"])
    assert compile_plan(plan).checksum


def test_compile_checks_duplicate_flow_declarations_across_source_files():
    plan = custom_plan("flow check $text\n  pass\n")
    plan["policy_versions"][0]["sources"].append({"path": "other.co", "content": "flow check $text\n  pass\n"})
    with pytest.raises(PlanCompilationError, match="duplicate Flow"):
        compile_plan(plan)


def test_compile_rejects_process_wide_main_in_custom_source():
    with pytest.raises(PlanCompilationError, match="process-wide main"):
        compile_plan(custom_plan("flow check $text\n  pass\n\nflow main\n  pass\n"))


def test_compile_rejects_missing_bound_flow():
    with pytest.raises(PlanCompilationError, match="Rail bindings for undefined flows: check"):
        compile_plan(custom_plan("flow different $text\n  pass\n"))


def test_compile_rejects_import_outside_the_policy_source_boundary():
    with pytest.raises(PlanCompilationError, match="forbidden import.*llm"):
        compile_plan(custom_plan("import llm\nflow check $text\n  pass\n"))


def test_core_import_and_call_like_documentation_do_not_create_dependencies():
    source = '''import core
flow check $text
  $documentation = """import llm
flow main
  await MissingAction()
"""
  pass
'''
    assert compile_plan(custom_plan(source)).checksum


def test_parameter_expansion_cannot_introduce_undeclared_dependencies():
    plan = custom_plan('flow check $text\n  $label = "${label}"\n  pass\n')
    plan["policy_bindings"][0]["parameter_values"] = [["label",
        'ordinary"\n  await MissingAction()\n  $other = "ordinary']]
    artifact = compile_plan(plan)
    assert '\n  await MissingAction()' not in artifact.colang_content


def test_unused_snapshot_source_is_not_compiled_or_validated():
    plan = custom_plan("flow check $text\n  pass\n")
    unused = deepcopy(plan["policy_versions"][0])
    unused.update(policy_id="unused", sources=[{"path": "unused.co", "content": "flow main\n  pass\n"}])
    plan["policy_versions"].append(unused)
    artifact = compile_plan(plan)
    assert "# Policy unused@" not in artifact.colang_content


def test_unused_snapshot_does_not_add_runtime_dependencies():
    plan = custom_plan("flow check $text\n  pass\n")
    unused = deepcopy(plan["policy_versions"][0])
    unused.update(policy_id="unused", evaluation_contracts=["tali.guard.content-safety.v1"],
        action_references=[{"name": "UnusedRemoteAction", "version": "1.0.0"}],
        prompt_dependencies=["unused-prompt"])
    plan["policy_versions"].append(unused)
    artifact = compile_plan(plan)
    from runner.protocol_codec import artifact_content
    manifest = artifact_content(artifact)["dependencyManifest"]
    assert not any("unused" in str(item).lower() for item in manifest), manifest
    assert not any("tali.guard.content-safety.v1" in str(item) for item in manifest), manifest


def test_missing_literal_parameter_is_an_explicit_compile_error():
    with pytest.raises(PlanCompilationError, match="Missing Policy parameter 'label'"):
        compile_plan(custom_plan('flow check $text\n  $label = "${label}"\n  pass\n'))


def test_parameter_cannot_replace_executable_source():
    plan = custom_plan('flow check $text\n  ${statement}\n')
    plan["policy_bindings"][0]["parameter_values"] = [["statement", "pass"]]
    with pytest.raises(PlanCompilationError, match="inside quoted strings"):
        compile_plan(plan)


def test_parameter_placeholder_in_comment_does_not_require_a_value():
    assert compile_plan(custom_plan('flow check $text\n  # ${comment}\n  pass\n')).checksum
