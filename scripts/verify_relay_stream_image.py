"""Offline preflight: require image-baked Guard code to match the Relay overlay."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

OVERLAY = Path(__file__).resolve().parents[2] / 'tasklattice-relay/infra/litellm/v1.87.0/overlay/litellm/proxy/guardrails/guardrail_hooks/tasklattice_guard'
PROBE = (
    "import hashlib,importlib.machinery,json,pathlib; "
    "s=importlib.machinery.PathFinder.find_spec('litellm'); "
    "p=pathlib.Path(s.origin).parent/'proxy/guardrails/guardrail_hooks/tasklattice_guard'; "
    "assert (p/'streaming.py').is_file(), 'Missing protected streaming endpoint'; "
    "print(json.dumps({str(f.relative_to(p)):hashlib.sha256(f.read_bytes()).hexdigest() "
    "for f in sorted(p.rglob('*.py'))},sort_keys=True))"
)


def verify(image):
    if not (OVERLAY / 'streaming.py').is_file():
        raise ValueError('Current sibling Relay streaming overlay is required for verification')
    image_id = subprocess.run(['docker', 'image', 'inspect', image, '--format', '{{.Id}}'],
                              check=True, capture_output=True, text=True, timeout=15).stdout.strip()
    assert image_id.startswith('sha256:')
    result = subprocess.run(['docker', 'run', '--rm', '--pull=never', '--network=none',
                             '--read-only', '--entrypoint', 'python', image_id, '-c', PROBE],
                            capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise ValueError('Relay image lacks the current protected streaming code; no live calls permitted')
    actual = json.loads(result.stdout)
    expected = {str(path.relative_to(OVERLAY)): hashlib.sha256(path.read_bytes()).hexdigest()
                for path in sorted(OVERLAY.rglob('*.py'))}
    if actual != expected:
        raise ValueError('Baked Relay Guard code differs from the sibling overlay; rebuild before live testing')
    return {'image': image_id, 'files': expected}


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
