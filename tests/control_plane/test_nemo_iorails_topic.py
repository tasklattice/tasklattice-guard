from __future__ import annotations

import asyncio
import json
import threading
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from nemoguardrails.actions.rail_outcome import RailOutcome
from nemoguardrails.exceptions import LLMCallException
from nemoguardrails.rails.llm.options import RailsResult, RailStatus
from nemoguardrails.types import LLMResponse

from runner import generated as protocol
from runner.compiler import DefaultRunnerCompiler
from runner.control_client import RunnerControlClient
from runner.toolkit.compiler.nemo_compiler import NeMoConfigCompiler
from runner.toolkit.nemo.actions.strict_topic_safety import (
    install_strict_topic_safety_action,
)
from runner.toolkit.nemo.native_models import (
    NativeRailModel,
    TOPIC_CONTROL_PROFILE,
    materialize_model_configs,
    native_rail_models,
)
from runner.toolkit.nemo.runtime import NeMoRuntime
from runner.toolkit.nemo.registry import NeMoRuntimeRegistry
from runner.toolkit.runtime.contracts import (
    EngineRequest,
    EvaluationTrigger,
    GuardrailPlanModule,
    GuardrailPlanSnapshot,
    GuardrailPlanStep,
)


def _native_model() -> NativeRailModel:
    return NativeRailModel(
        type="topic_control",
        profile_ref=TOPIC_CONTROL_PROFILE,
        runtime_id="topic-runtime",
        model="nvidia/llama-3.1-nemoguard-8b-topic-control",
        base_url="http://topic.example/v1",
        api_key="leased-secret",
        timeout_seconds=12,
        max_tokens=16,
    )


def _compiler() -> NeMoConfigCompiler:
    return NeMoConfigCompiler(models=(_native_model().compiler_config(),))


class _ControlStore:
    generation = 0

    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.native_models = ()

    def apply(self, desired_state, *, providers=None, native_models=None):
        if self.fail:
            raise RuntimeError("provider prewarm failed")
        self.native_models = native_models
        self.generation = desired_state.generation

    def observability_counts(self):
        return 0, 0, 0


class _ControlMetrics:
    def __getattr__(self, _name):
        return lambda *_args, **_kwargs: None

    def heartbeat(self):
        return protocol.RunnerLoad(max_concurrency=8)


def _plan(*steps: GuardrailPlanStep) -> GuardrailPlanSnapshot:
    phases = tuple(dict.fromkeys(phase for step in steps for phase in step.phases))
    return GuardrailPlanSnapshot(
        guardrail_id="topic-guard",
        guardrail_version="20260904-010000.001Z",
        compiler_version="test-plan-v1",
        safety_level="balanced",
        output_delivery="full_buffered",
        steps=steps,
        modules=tuple(
            GuardrailPlanModule(
                id=f"interaction_safety:{phase}",
                module="interaction_safety",
                phase=phase,
                step_ids=tuple(step.id for step in steps if phase in step.phases),
                timeout_ms=30_000,
            )
            for phase in phases
        ),
    )


def _semantic_input(
    *,
    trigger: EvaluationTrigger = EvaluationTrigger(),
) -> GuardrailPlanStep:
    return GuardrailPlanStep(
        id="topic:semantic:input",
        capability="topic_control",
        contract_ref="tali.guard.topic-control.semantic.v1",
        phases=("input",),
        on_unsafe="reject",
        trigger=trigger,
        parameters=(
            ("purpose", "Support product questions"),
            ("allowed_topics", "Product support"),
            ("restricted_topics", "Political campaigning"),
        ),
    )


def test_pure_dedicated_topic_input_compiles_to_valid_iorails_manifest() -> None:
    snapshot = _compiler().compile(_plan(_semantic_input()))

    assert snapshot.runtime_profile == "iorails_native"
    assert snapshot.runtime_engine == "iorails"
    assert snapshot.action_bindings == ()
    assert snapshot.required_models == ("topic_control",)
    assert (
        "model",
        "topic_control",
        TOPIC_CONTROL_PROFILE,
    ) in snapshot.dependency_manifest
    assert "topic safety check input $model=topic_control" in snapshot.config_yaml
    assert "leased-secret" not in snapshot.config_yaml

    runtime_yaml = materialize_model_configs(
        snapshot.config_yaml,
        snapshot.required_models,
        (_native_model(),),
    )
    assert "nvidia/llama-3.1-nemoguard-8b-topic-control" in runtime_yaml
    assert "leased-secret" in runtime_yaml


def test_mixed_topic_plan_uses_official_input_action_and_custom_output_action() -> None:
    rules = GuardrailPlanStep(
        id="topic:rules:input",
        capability="topic_control",
        contract_ref="tali.guard.topic-control.rules.v1",
        phases=("input",),
        on_unsafe="reject",
    )
    semantic = _semantic_input(
        trigger=EvaluationTrigger(
            type="on_result",
            step_ref=rules.id,
            verdicts=("uncertain",),
        )
    )
    output = GuardrailPlanStep(
        id="topic:semantic:output",
        capability="topic_control",
        contract_ref="tali.guard.topic-control.semantic.v1",
        phases=("output",),
        on_unsafe="reject",
    )

    snapshot = _compiler().compile(_plan(rules, semantic, output))

    assert snapshot.runtime_profile == "llmrails_colang2_programmable"
    assert "import nemoguardrails.library.topic_safety" in snapshot.colang_content
    assert "TopicSafetyCheckInputAction" in snapshot.colang_content
    assert f'binding_id="{semantic.id}"' in snapshot.colang_content
    assert "Support product questions" in snapshot.config_yaml
    assert {binding.id for binding in snapshot.action_bindings} == {
        rules.id,
        output.id,
    }


def test_content_safety_remains_on_the_evidence_preserving_custom_evaluator() -> None:
    content = GuardrailPlanStep(
        id="content:input",
        capability="content_safety",
        contract_ref="tali.guard.content-safety.v1",
        phases=("input",),
        on_unsafe="reject",
    )

    snapshot = _compiler().compile(_plan(content))

    assert snapshot.required_models == ()
    assert snapshot.runtime_profile == "llmrails_colang1_standard"
    assert [binding.id for binding in snapshot.action_bindings] == [content.id]
    assert "topic_control" not in snapshot.config_yaml


def test_only_dedicated_topic_assignment_enables_the_standard_rail_model() -> None:
    configuration = protocol.DataPlaneModelConfiguration(
        revision_id="topic-revision",
        revision=1,
        runtimes=[protocol.ModelRuntime(
            id="topic-runtime",
            base_url="http://topic.example/v1",
            credential_ref="topic-provider",
            model="nvidia/llama-3.1-nemoguard-8b-topic-control",
            profile_ref=TOPIC_CONTROL_PROFILE,
            timeout_seconds=12,
            max_tokens=16,
        )],
        assignments=[protocol.ModelAssignment(
            detector_type="topic_control",
            model_ref="topic-runtime",
            profile_ref=TOPIC_CONTROL_PROFILE,
            contract_refs=["tali.guard.topic-control.semantic.v1"],
        )],
    )

    selected = native_rail_models(
        configuration,
        {"topic-provider": "leased-secret"},
    )
    assert [item.type for item in selected] == ["topic_control"]

    configuration.assignments[0].profile_ref = "tali.taxonomy-judge.v1"
    assert native_rail_models(configuration, {}) == ()

    configuration.assignments[0].profile_ref = TOPIC_CONTROL_PROFILE
    configuration.runtimes[0].skip_tls_verify = True
    assert native_rail_models(configuration, {}) == ()


@pytest.mark.asyncio
async def test_real_iorails_registry_uses_live_model_and_rejects_bad_label() -> None:
    state = {"label": "on-topic", "authorization": "", "requests": 0}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            state["requests"] += 1
            state["authorization"] = self.headers.get("Authorization", "")
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            assert body["model"] == _native_model().model
            payload = json.dumps({
                "choices": [{"message": {"content": state["label"]}}],
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    model = replace(
        _native_model(),
        base_url=f"http://127.0.0.1:{server.server_port}/v1",
    )
    plan = _plan(_semantic_input())
    config = NeMoConfigCompiler(models=(model.compiler_config(),)).compile(plan)

    class Store:
        def plan(self, _guardrail_id, _version):
            return plan

        def nemo_config(self, _guardrail_id, _version):
            return config

        def active_plan_keys(self):
            return ((plan.guardrail_id, plan.guardrail_version),)

    registry = NeMoRuntimeRegistry(
        Store(),
        {},
        native_models=(model,),
        max_concurrency_per_guardrail=2,
    )
    runtime = NeMoRuntime(registry)
    try:
        allowed = await runtime.evaluate(
            EngineRequest(phase="input", text="product help", plan=plan)
        )
        state["label"] = "off-topic"
        blocked = await runtime.evaluate(
            EngineRequest(phase="input", text="politics", plan=plan)
        )
        state["label"] = "maybe"
        malformed = await runtime.evaluate(
            EngineRequest(phase="input", text="unclear", plan=plan)
        )

        assert allowed.decision == "allow"
        assert blocked.decision == "block"
        assert malformed.decision == "block"
        assert malformed.usage.fail_closed
        assert allowed.usage.model_invocations == 1
        assert blocked.usage.model_invocations == 1
        assert malformed.usage.model_invocations == 1
        assert state["requests"] == 3
        assert state["authorization"] == "Bearer leased-secret"
    finally:
        await runtime.shutdown()
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)


def test_iorails_prewarm_rejects_missing_model_and_invalid_manifest() -> None:
    plan = _plan(_semantic_input())
    config = _compiler().compile(plan)

    class Store:
        def __init__(self, selected):
            self.selected = selected

        def plan(self, _guardrail_id, _version):
            return plan

        def nemo_config(self, _guardrail_id, _version):
            return self.selected

        def active_plan_keys(self):
            return ((plan.guardrail_id, plan.guardrail_version),)

    with pytest.raises(ValueError, match="unavailable native model assignments"):
        NeMoRuntimeRegistry(Store(config), {})

    invalid = replace(
        config,
        config_yaml=config.config_yaml.replace(
            "topic safety check input",
            "not a registered standard rail",
        ),
    )
    with pytest.raises(Exception, match="not a registered standard rail|does not exist|Unknown"):
        NeMoRuntimeRegistry(
            Store(invalid),
            {},
            native_models=(_native_model(),),
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("result", "expected_decision", "expected_action", "fail_closed"),
    [
        (RailsResult(status=RailStatus.PASSED, content="hello"), "allow", "pass", False),
        (
            RailsResult(
                status=RailStatus.BLOCKED,
                content="I'm sorry, I can't respond to that.",
                rail="topic safety check input",
            ),
            "block",
            "reject",
            False,
        ),
        (
            RailsResult(
                status=RailStatus.BLOCKED,
                content="I'm sorry, an internal error has occurred.",
                rail="topic safety check input",
            ),
            "block",
            "reject",
            True,
        ),
    ],
)
async def test_iorails_check_async_maps_to_protection_decision(
    result: RailsResult,
    expected_decision: str,
    expected_action: str,
    fail_closed: bool,
) -> None:
    plan = _plan(_semantic_input())
    config = _compiler().compile(plan)

    class Rails:
        def __init__(self) -> None:
            self.calls = []

        async def check_async(self, messages, rail_types):
            self.calls.append((messages, rail_types))
            return result

    rails = Rails()
    instance = SimpleNamespace(
        config=config,
        rails=rails,
        admission=asyncio.BoundedSemaphore(1),
        native_models=(),
        waiting_requests=0,
        active_requests=0,
    )

    class Registry:
        def acquire(self, _plan):
            return instance, False, 0

    decision = await NeMoRuntime(Registry()).evaluate(  # type: ignore[arg-type]
        EngineRequest(phase="input", text="hello", plan=plan)
    )

    assert len(rails.calls) == 1
    assert decision.decision == expected_decision
    assert decision.action == expected_action
    assert decision.usage.runtime_engine == "iorails"
    assert decision.usage.fail_closed is fail_closed
    if not fail_closed:
        assert decision.coverage.status == "complete"


@pytest.mark.asyncio
async def test_official_topic_action_rejects_malformed_model_output() -> None:
    install_strict_topic_safety_action()
    from nemoguardrails.library.topic_safety import actions

    class TaskManager:
        def render_task_prompt(self, *, task):
            return f"Classify {task}."

        def get_stop_tokens(self, *, task):
            return None

        def get_max_tokens(self, *, task):
            return 10

    class Model:
        model_name = "topic-control"
        provider_name = "test"
        provider_url = "http://test"

        async def generate_async(self, *args, **kwargs):
            return LLMResponse(content="probably on-topic")

        async def stream_async(self, *args, **kwargs):
            if False:
                yield None

    with pytest.raises(LLMCallException, match="exactly 'on-topic' or 'off-topic'"):
        await actions.topic_safety_check_input(
            llms={"topic_control": Model()},
            llm_task_manager=TaskManager(),
            model_name="topic_control",
            user_message="hello",
        )

    class ValidModel:
        model_name = "topic-control"
        provider_name = "test"
        provider_url = "http://test"

        async def generate_async(self, *args, **kwargs):
            return LLMResponse(content="off-topic")

        async def stream_async(self, *args, **kwargs):
            if False:
                yield None

    outcome = await actions.topic_safety_check_input(
        llms={"topic_control": ValidModel()},
        llm_task_manager=TaskManager(),
        model_name="topic_control",
        user_message="hello",
    )
    assert isinstance(outcome, RailOutcome)
    assert outcome.is_blocked


@pytest.mark.asyncio
async def test_compiler_switches_native_models_only_after_atomic_apply_succeeds():
    compiler = DefaultRunnerCompiler()
    store = _ControlStore()
    client = RunnerControlClient(
        SimpleNamespace(
            runner_id="runner-0",
            pool_id="default",
            compiler_capable=True,
        ),
        store,  # type: ignore[arg-type]
        _ControlMetrics(),  # type: ignore[arg-type]
        compiler=compiler,
    )
    client._model_credentials = AsyncMock(  # type: ignore[method-assign]
        return_value={"topic-provider": "leased-topic-secret"}
    )

    await client._apply_desired_state(_topic_model_desired_state(generation=14))

    result = await client._outgoing.get()
    assert result.desired_state_result.accepted is True
    assert [model.profile_ref for model in compiler.native_models] == [
        TOPIC_CONTROL_PROFILE
    ]
    assert store.native_models == compiler.native_models


@pytest.mark.asyncio
async def test_compiler_keeps_previous_native_models_when_atomic_apply_fails():
    compiler = DefaultRunnerCompiler()
    store = _ControlStore(fail=True)
    client = RunnerControlClient(
        SimpleNamespace(
            runner_id="runner-0",
            pool_id="default",
            compiler_capable=True,
        ),
        store,  # type: ignore[arg-type]
        _ControlMetrics(),  # type: ignore[arg-type]
        compiler=compiler,
    )
    client._model_credentials = AsyncMock(  # type: ignore[method-assign]
        return_value={"topic-provider": "leased-topic-secret"}
    )

    await client._apply_desired_state(_topic_model_desired_state(generation=15))

    result = await client._outgoing.get()
    assert result.desired_state_result.accepted is False
    assert compiler.native_models == ()


def _topic_model_desired_state(*, generation: int) -> protocol.DesiredState:
    return protocol.DesiredState(
        generation=generation,
        model_configuration=protocol.DataPlaneModelConfiguration(
            revision_id=f"topic-revision-{generation}",
            revision=generation,
            runtimes=[
                protocol.ModelRuntime(
                    id="topic-runtime",
                    base_url="http://topic.mock/v1",
                    credential_ref="topic-provider",
                    model="nvidia/llama-3.1-nemoguard-8b-topic-control",
                    profile_ref=TOPIC_CONTROL_PROFILE,
                    timeout_seconds=20,
                    max_tokens=16,
                )
            ],
            assignments=[
                protocol.ModelAssignment(
                    detector_type="topic_control",
                    model_ref="topic-runtime",
                    profile_ref=TOPIC_CONTROL_PROFILE,
                    contract_refs=["tali.guard.topic-control.semantic.v1"],
                )
            ],
        ),
    )
