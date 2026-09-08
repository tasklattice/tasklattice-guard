import hashlib
import json
from types import SimpleNamespace

import pytest

from scripts import verify_relay_stream_image as preflight


def test_old_image_fails_before_any_live_access(monkeypatch, tmp_path):
    (tmp_path / 'streaming.py').write_text('# expected protected stream\n')
    monkeypatch.setattr(preflight, 'OVERLAY', tmp_path)
    calls = []

    def run(args, **kwargs):
        calls.append(args)
        if args[1:3] == ['image', 'inspect']:
            return SimpleNamespace(stdout='sha256:synthetic', returncode=0)
        return SimpleNamespace(stdout='', returncode=1)

    monkeypatch.setattr(preflight.subprocess, 'run', run)
    with pytest.raises(ValueError, match='no live calls permitted'):
        preflight.verify('old:dev')
    assert len(calls) == 2
    assert '--network=none' in calls[1]
    assert '--pull=never' in calls[1]
    assert 'sha256:synthetic' in calls[1]


@pytest.mark.parametrize('matches', [True, False])
def test_baked_hash_must_match_all_overlay_files(monkeypatch, tmp_path, matches):
    source = b'# protected stream\n'
    (tmp_path / 'streaming.py').write_bytes(source)
    monkeypatch.setattr(preflight, 'OVERLAY', tmp_path)
    expected = {'streaming.py': hashlib.sha256(source).hexdigest()}

    def run(args, **kwargs):
        if args[1:3] == ['image', 'inspect']:
            return SimpleNamespace(stdout='sha256:verified', returncode=0)
        return SimpleNamespace(stdout=json.dumps(expected if matches else {'streaming.py': 'stale'}), returncode=0)

    monkeypatch.setattr(preflight.subprocess, 'run', run)
    if matches:
        assert preflight.verify('new:test') == {'image': 'sha256:verified', 'files': expected}
    else:
        with pytest.raises(ValueError, match='differs'):
            preflight.verify('new:test')
