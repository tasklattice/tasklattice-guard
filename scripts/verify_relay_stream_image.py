"""Offline preflight: require a LiteLLM gateway image whose Guard Provider speaks this Runner's stream protocol.

The Provider is published by github.com/tasklattice/tasklattice-litellm-guard as
ghcr.io/tasklattice/tali-litellm:<litellm>-guard.<n>. Guard carries no copy of its
source; compatibility is the image's advertised output-stream protocol version.
"""
import argparse
import ast
import json
from pathlib import Path
import subprocess

PROTOCOL_LABEL = 'io.tasklattice.guard.output-stream-protocol'
RUNNER_STREAMING = Path(__file__).resolve().parents[1] / 'runner/output_streaming.py'
PROBE = (
    "import importlib.machinery,pathlib; "
    "s=importlib.machinery.PathFinder.find_spec('litellm'); "
    "p=pathlib.Path(s.origin).parent/'proxy/guardrails/guardrail_hooks/tasklattice_guard'; "
    "assert (p/'streaming.py').is_file(), 'Missing protected streaming endpoint'"
)


def runner_protocol_version(path=RUNNER_STREAMING):
    """Read OUTPUT_STREAM_PROTOCOL_VERSION without importing the Runner."""
    for node in ast.parse(path.read_text()).body:
        if isinstance(node, ast.Assign) and any(getattr(t, 'id', None) == 'OUTPUT_STREAM_PROTOCOL_VERSION' for t in node.targets):
            return ast.literal_eval(node.value)
    raise ValueError(f'OUTPUT_STREAM_PROTOCOL_VERSION is not defined in {path}')


def verify(image):
    inspected = subprocess.run(['docker', 'image', 'inspect', image, '--format', '{{.Id}} {{json .Config.Labels}}'],
                               check=True, capture_output=True, text=True, timeout=15).stdout.strip()
    image_id, _, labels_json = inspected.partition(' ')
    assert image_id.startswith('sha256:')
    labels = json.loads(labels_json or 'null') or {}
    expected = runner_protocol_version()
    advertised = labels.get(PROTOCOL_LABEL)
    if advertised != str(expected):
        raise ValueError(f'Image advertises Guard output-stream protocol {advertised or "none"}, this Runner speaks {expected}; '
                         'use a tasklattice-litellm-guard release built for it. No live calls permitted')
    result = subprocess.run(['docker', 'run', '--rm', '--pull=never', '--network=none',
                             '--read-only', '--entrypoint', 'python', image_id, '-c', PROBE],
                            capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise ValueError('Image lacks the protected streaming Provider; no live calls permitted')
    return {'image': image_id, 'protocol': expected,
            'litellmVersion': labels.get('io.tasklattice.litellm.version'),
            'providerVersion': labels.get('io.tasklattice.guard.provider-version'),
            'revision': labels.get('org.opencontainers.image.revision')}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('image')
    args = parser.parse_args()
    try:
        print(json.dumps(verify(args.image)))
    except (ValueError, subprocess.SubprocessError) as error:
        raise SystemExit(str(error)) from None


if __name__ == '__main__':
    main()
