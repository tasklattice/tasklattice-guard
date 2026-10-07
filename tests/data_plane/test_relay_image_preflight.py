import json
from types import SimpleNamespace

import pytest

from scripts import verify_relay_stream_image as preflight

LABELS = {
    preflight.PROTOCOL_LABEL: '1',
    'io.tasklattice.litellm.version': '1.87.0',
    'io.tasklattice.guard.provider-version': '1',
    'org.opencontainers.image.revision': 'abc123',
}


def fake_docker(labels, probe_returncode=0):
    calls = []

    def run(args, **kwargs):
        calls.append(args)
        if args[1:3] == ['image', 'inspect']:
            return SimpleNamespace(stdout=f'sha256:synthetic {json.dumps(labels)}', returncode=0)
        return SimpleNamespace(stdout='', returncode=probe_returncode)
    return run, calls


def test_runner_protocol_constant_is_read_without_importing_the_runner():
    from runner.output_streaming import OUTPUT_STREAM_PROTOCOL_VERSION
    assert preflight.runner_protocol_version() == OUTPUT_STREAM_PROTOCOL_VERSION


@pytest.mark.parametrize('labels', [None, {}, {**LABELS, preflight.PROTOCOL_LABEL: '2'}])
def test_unlabelled_or_mismatched_image_fails_before_running_it(monkeypatch, labels):
    run, calls = fake_docker(labels)
    monkeypatch.setattr(preflight.subprocess, 'run', run)
    with pytest.raises(ValueError, match='no live calls permitted|No live calls permitted'):
        preflight.verify('old:tag')
    assert len(calls) == 1


def test_image_without_streaming_provider_fails_offline(monkeypatch):
    run, calls = fake_docker(LABELS, probe_returncode=1)
    monkeypatch.setattr(preflight.subprocess, 'run', run)
    with pytest.raises(ValueError, match='lacks the protected streaming Provider'):
        preflight.verify('broken:tag')
    assert '--network=none' in calls[1] and '--pull=never' in calls[1] and 'sha256:synthetic' in calls[1]


def test_compatible_image_reports_its_provider_identity(monkeypatch):
    run, _ = fake_docker(LABELS)
    monkeypatch.setattr(preflight.subprocess, 'run', run)
    assert preflight.verify('ghcr.io/tasklattice/tali-litellm:1.87.0-guard.3') == {
        'image': 'sha256:synthetic', 'protocol': 1, 'litellmVersion': '1.87.0', 'providerVersion': '1', 'revision': 'abc123'}
