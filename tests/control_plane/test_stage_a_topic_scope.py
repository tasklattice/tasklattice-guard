"""Compile two Topic scopes and execute their actual NeMo prompts via TCP Mock.

No live NVIDIA calls, Provider activation or alteration of captured responses.
"""
from dataclasses import replace

import httpx
import pytest

from runner.toolkit.compiler.nemo_compiler import NeMoConfigCompiler
from runner.toolkit.nemo.registry import NeMoRuntimeRegistry
from runner.toolkit.nemo.runtime import NeMoRuntime
from runner.toolkit.runtime.contracts import EngineRequest
from scripts.mock_topic_control import MODEL, create_app
from tests.control_plane.test_nemo_iorails_topic import _native_model, _plan, _semantic_input
from tests.data_plane.test_stream_safety_network import tcp_server


@pytest.mark.parametrize('scope,expected', [('Product support','allow'),('Cooking and recipes only','block')])
async def test_compiled_scope_changes_same_input_decision_through_mock(scope,expected):
    async with tcp_server(create_app()) as url:
        model=replace(_native_model(),base_url=url+'/v1',model=MODEL,api_key='synthetic-local',timeout_seconds=2)
        step=replace(_semantic_input(),parameters=(('topic_mode','allowlist'),('allowed_topics',scope)))
        plan=_plan(step)
        config=NeMoConfigCompiler(models=(model.compiler_config(),)).compile(plan)
        assert scope in config.config_yaml
        assert config.runtime_profile=='iorails_native'
        assert ('Cooking and recipes only' if scope=='Product support' else 'Product support') not in config.config_yaml
        config=replace(config,dependency_manifest=(*config.dependency_manifest,
            ('evaluation_contract','tali.guard.topic-control.semantic.v1','required')))

        class Store:
            def plan(self,*_): return plan
            def nemo_config(self,*_): return config
            def active_plan_keys(self): return ((plan.guardrail_id,plan.guardrail_version),)

        registry=NeMoRuntimeRegistry(Store(),{},native_models=(model,),max_concurrency_per_guardrail=1)
        runtime=NeMoRuntime(registry)
        try:
            result=await runtime.evaluate(EngineRequest(phase='input',
                text='How can I reset my product password?',plan=plan))
            assert result.decision==expected
            assert result.usage.model_invocations==1
            assert result.usage.fail_closed is False
            async with httpx.AsyncClient(trust_env=False) as client:
                health=(await client.get(url+'/health')).json()
            assert health['matched']==1 and health['unmatched']==0 and health['external_calls']==0
        finally:
            await runtime.shutdown()
