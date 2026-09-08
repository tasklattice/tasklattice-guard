"""The authorized round must not call excluded models or reset its budget."""
import json
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest

from scripts.model_response_gateway import Recorder


def test_expanded_budget_is_persistent_and_cannot_be_increased(tmp_path):
    path = tmp_path / 'calls.sqlite'
    recorder = Recorder(path, 100)
    for i in range(100):
        assert recorder.reserve('nvidia/v1/chat/completions', {'case': i}) is not None
    assert Recorder(path, 100).reserve('nvidia/v1/chat/completions', {}) is None
    with pytest.raises(ValueError, match='budget'):
        Recorder(path, 101)


def test_expanded_deployment_uses_tali_dev_persistent_cap_and_safety_only(monkeypatch):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2] / 'scripts'))
    from scripts import deploy_live_model_gateway as deploy
    monkeypatch.setattr(sys, 'argv', ['deploy', '--namespace', 'tali', '--name', 'live-tali-expanded-20260908', '--limit', '100'])
    monkeypatch.setattr(deploy, 'load_credentials', lambda _: {'deepseek': 'synthetic-ds', 'nvidia': 'synthetic-nv'})
    applied = []
    def run(args, **kwargs):
        assert args[:5] == ['kubectl', '--context', 'orbstack', '-n', 'tali']
        if 'input' in kwargs:
            applied.extend(json.loads(kwargs['input'])['items'])
        return SimpleNamespace(stdout='')
    monkeypatch.setattr(deploy.subprocess, 'run', run)
    deploy.main()
    code = next(r for r in applied if r['kind'] == 'ConfigMap')['data']['launch.py']
    assert "Recorder(Path('/records/live.sqlite'), 100)" in code
    assert "MODELS['nvidia'] = {'nvidia/llama-3.1-nemotron-safety-guard-8b-v3'}" in code
    assert "ROUTES.pop('nvidia/v1/classify')" in code
    assert "route.startswith('deepseek/')" in code
    pod = next(r for r in applied if r['kind'] == 'Deployment')['spec']['template']['spec']
    assert all(c['image'].endswith(':dev') for c in pod['containers'])
    assert 'persistentVolumeClaim' in pod['volumes'][-1]
    assert any(r['kind'] == 'PersistentVolumeClaim' for r in applied)
