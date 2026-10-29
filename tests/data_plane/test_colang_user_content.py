"""Untrusted transcripts traverse real Colang in previously signed artifacts."""
import asyncio
import json
from functools import wraps

import pytest
from nemoguardrails import Guardrails, RailsConfig

from runner.evaluation_evidence import evaluation_evidence
from runner.toolkit.nemo.colang_logging import configure_user_action_logging
from runner.toolkit.nemo.runtime import NeMoActionBridge
from runner.toolkit.runtime.contracts import ProtectionRequest, RequestContext
from runner.toolkit.runtime.service import GuardrailRuntimeService
from tests.data_plane.test_artifact_execution import _runtime
from tests.data_plane.test_custom_symbol_artifact import FIXTURE


TRANSCRIPTS = (
    'def example():\n    """A quoted docstring."""\n    return "ordinary"',
    "def example():\n    '''A second docstring.'''\n    return 'ordinary'",
    'JSON: {"value": "a \\\"quoted\\\" string", "path": "C:\\\\temp"}',
    'Literal expressions: {$text} {1 + 1} {{nested}} $tasklattice_phase',
    'Quotes: """ and \'\'\'; braces: { }; trailing backslash: \\',
    'Unicode: 姓名🙂\r\nTab:\tvalue\nMultiline ```python\n"""literal"""\n```',
)


def test_core_log_metadata_is_instance_scoped_and_custom_metadata_is_untouched():
    config = RailsConfig.from_content(
        yaml_content='colang_version: "2.x"\nmodels: []',
        colang_content='import core\n@meta(user_action="custom description")\n'
        'flow custom\n  pass\n\nflow main\n  user said something\n',
    )
    original = next(flow for flow in config.flows if flow.name == 'user said something')
    custom = next(flow for flow in config.flows if flow.name == 'custom')
    configure_user_action_logging(config)
    current = next(flow for flow in config.flows if flow.name == original.name)
    assert current is not original
    assert any(d.parameters.get('user_action') is True for d in current.decorators)
    assert any(isinstance(d.parameters.get('user_action'), str) for d in original.decorators)
    assert next(flow for flow in config.flows if flow.name == 'custom') is custom
    assert current.elements == original.elements


@pytest.mark.parametrize('phase', ['input', 'output'])
async def test_frozen_artifact_checks_quoted_content_without_rewriting_it(tmp_path, monkeypatch, phase, caplog):
    seen = []
    original = NeMoActionBridge.record_owned_policy

    @wraps(original)
    async def observe(self, *args, **kwargs):
        seen.append(kwargs['text'])
        return await original(self, *args, **kwargs)

    monkeypatch.setattr(NeMoActionBridge, 'record_owned_policy', observe)
    store, _registry, engine = _runtime(tmp_path, FIXTURE)
    runtime = GuardrailRuntimeService(engine, store)

    async def evaluate(text):
        return await runtime.evaluate(ProtectionRequest(
            phase=phase, texts=(text,),
            context=RequestContext(protocol='litellm', endpoint_id='fixture-endpoint'),
        ))

    try:
        results = await asyncio.gather(*(evaluate(text) for text in TRANSCRIPTS))
        for text, result in zip(TRANSCRIPTS, results, strict=True):
            assert result.decision == 'allow', result.reason
            assert not result.usage.fail_closed
            assert result.usage.model_invocations == 0
            assert (result.texts or (text,)) == (text,)
            # Both real Policy Actions must receive every original character.
            assert seen.count(text) == 2
            assert json.loads(evaluation_evidence(result))['execution']['status'] == 'complete'
        blocked = await evaluate('check')
        assert blocked.decision == 'block' and not blocked.usage.fail_closed
        assert [f.policy_id for f in blocked.findings if f.verdict == 'matched'] == ['policy-a', 'policy_a']
        assert 'ColangValueError' not in caplog.text
        assert 'SyntaxError' not in caplog.text
    finally:
        await engine.shutdown()


async def test_runtime_exception_reports_only_safe_error_type(tmp_path, monkeypatch):
    store, _registry, engine = _runtime(tmp_path, FIXTURE)
    runtime = GuardrailRuntimeService(engine, store)

    async def broken_runtime(*args, **kwargs):
        raise ValueError('private-request-content-must-not-be-returned')

    monkeypatch.setattr(Guardrails, 'generate_async', broken_runtime)
    try:
        result = await runtime.evaluate(ProtectionRequest(
            phase='input', texts=('ordinary',),
            context=RequestContext(protocol='litellm', endpoint_id='fixture-endpoint'),
        ))
        assert result.decision == 'block' and result.usage.fail_closed
        assert result.coverage.required_modules_completed == 0
        assert json.loads(evaluation_evidence(result))['execution'] == {
            'status': 'error', 'failClosed': True, 'errorTypes': ['ValueError'],
        }
        assert 'private-request-content' not in str(result)
    finally:
        await engine.shutdown()
