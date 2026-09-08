"""The isolated SSE test gateway must not reopen the previous run's budget."""
import importlib
import json
from pathlib import Path
from types import SimpleNamespace

import pytest


def gateway_module(monkeypatch):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2] / 'scripts'))
    return importlib.import_module('deploy_live_model_gateway')


def test_separate_stream_run_renames_all_resources_without_touching_credentials(monkeypatch):
    module = gateway_module(monkeypatch)
    monkeypatch.setattr('sys.argv', ['gateway', '--name', 'live-stream-model-gateway'])
    marker = 'synthetic-live-model-gateway-credential'
    monkeypatch.setattr(module, 'load_credentials', lambda _: {'deepseek': marker, 'nvidia': marker})
    calls = []

    def run(args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(stdout='')

    monkeypatch.setattr(module.subprocess, 'run', run)
    module.main()
    assert calls[0][0][-5:] == ['deployment', 'live-stream-model-gateway', '--ignore-not-found', '-o', 'name']
    resources = json.loads(calls[1][1]['input'])['items']
    assert all(r['metadata']['name'].startswith('live-stream-model-gateway') for r in resources)
    secret = next(r for r in resources if r['kind'] == 'Secret')
    assert secret['stringData']['keys.env'].count(marker) == 2
    deployment = next(r for r in resources if r['kind'] == 'Deployment')
    spec = deployment['spec']['template']['spec']
    assert spec['automountServiceAccountToken'] is False
    assert spec['volumes'][1]['secret']['secretName'] == secret['metadata']['name']
    assert spec['volumes'][0]['configMap']['name'] == 'live-stream-model-gateway-code'
    service = next(r for r in resources if r['kind'] == 'Service')
    assert service['spec']['selector'] == deployment['spec']['selector']['matchLabels']
    launcher = next(r for r in resources if r['kind'] == 'ConfigMap')['data']['launch.py']
    compile(launcher, '<isolated-launcher>', 'exec')
    assert "Recorder(Path('/records/live.sqlite'), 40)" in launcher
    assert "ROUTES.pop('nvidia/v1/classify')" in launcher
    assert "MODELS['nvidia'] = {'nvidia/llama-3.1-nemotron-safety-guard-8b-v3'}" in launcher


def test_existing_gateway_cannot_be_redeployed_to_reset_budget(monkeypatch):
    module = gateway_module(monkeypatch)
    monkeypatch.setattr('sys.argv', ['gateway', '--name', 'live-stream-model-gateway'])
    calls = []

    def run(args, **kwargs):
        calls.append(args)
        return SimpleNamespace(stdout='deployment.apps/live-stream-model-gateway')

    monkeypatch.setattr(module.subprocess, 'run', run)
    monkeypatch.setattr(module, 'load_credentials', lambda _: pytest.fail('Must not read keys on refused redeploy'))
    with pytest.raises(SystemExit, match='Gateway exists'):
        module.main()
    assert len(calls) == 1


def test_round2_enforces_approved_cap_and_excludes_other_models(monkeypatch):
    module = gateway_module(monkeypatch)
    monkeypatch.setattr('sys.argv', ['gateway', '--name', 'live-stream-model-gateway-round2', '--limit', '30'])
    monkeypatch.setattr(module, 'load_credentials', lambda _: {'deepseek': 'synthetic', 'nvidia': 'synthetic'})
    captured = []

    def run(args, **kwargs):
        if 'input' in kwargs:
            captured.append(json.loads(kwargs['input']))
        return SimpleNamespace(stdout='')

    monkeypatch.setattr(module.subprocess, 'run', run)
    module.main()
    launcher = next(r for r in captured[0]['items'] if r['kind'] == 'ConfigMap')['data']['launch.py']
    compile(launcher, '<round2-launcher>', 'exec')
    assert "Recorder(Path('/records/live.sqlite'), 30)" in launcher
    assert "route.startswith('deepseek/')" in launcher
    assert "ROUTES.pop('nvidia/v1/classify')" in launcher
    assert "MODELS['nvidia'] = {'nvidia/llama-3.1-nemotron-safety-guard-8b-v3'}" in launcher
    monkeypatch.setattr('sys.argv', ['gateway', '--name', 'live-stream-model-gateway-round2', '--limit', '40'])
    with pytest.raises(SystemExit, match='30 detector calls only'):
        module.main()
    assert len(captured) == 1


def test_tali_run_is_explicit_capped_nvidia_only_and_persistent(monkeypatch):
    module = gateway_module(monkeypatch)
    monkeypatch.setattr('sys.argv', ['gateway', '--namespace', 'tali', '--name', 'live-tali-acceptance-20260908', '--limit', '40'])
    monkeypatch.setattr(module, 'load_credentials', lambda _: {'deepseek': 'synthetic', 'nvidia': 'synthetic'})
    calls = []
    def run(args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(stdout='')
    monkeypatch.setattr(module.subprocess, 'run', run)
    module.main()
    assert all(args[args.index('-n') + 1] == 'tali' for args, _ in calls)
    resources = json.loads(calls[-1][1]['input'])['items']
    launcher = next(r for r in resources if r['kind'] == 'ConfigMap')['data']['launch.py']
    assert "route.startswith('deepseek/')" in launcher
    assert "Recorder(Path('/records/live.sqlite'), 40)" in launcher
    pod = next(r for r in resources if r['kind'] == 'Deployment')['spec']['template']['spec']
    assert 'persistentVolumeClaim' in pod['volumes'][-1]
    assert any(r['kind'] == 'PersistentVolumeClaim' for r in resources)
    compile(launcher, '<tali-launcher>', 'exec')
    monkeypatch.setattr('sys.argv', ['gateway', '--namespace', 'tali'])
    with pytest.raises(SystemExit, match='dedicated name'):
        module.main()
