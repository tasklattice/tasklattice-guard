"""Materialize the pinned English Laya snapshot as a reproducible image layer."""

import hashlib
import json
import os
import shutil
import sys
import time
from http.client import HTTPException
from pathlib import Path
from urllib.request import urlopen


def sha256(path: Path) -> str:
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def download(url: str, cached: Path, expected: str) -> None:
    if cached.is_file() and sha256(cached) == expected:
        return
    partial = cached.with_suffix(".part")
    for attempt in range(1, 4):
        try:
            with urlopen(f"{url}?download=true&attempt={attempt}", timeout=90) as response, partial.open("wb") as output:
                shutil.copyfileobj(response, output, length=1024 * 1024)
            if sha256(partial) != expected:
                raise ValueError(f"SHA-256 mismatch for {url}")
            partial.replace(cached)
            return
        except (OSError, HTTPException, ValueError) as error:
            if attempt == 3:
                raise
            print(f"Retrying {url} ({type(error).__name__})", file=sys.stderr, flush=True)
            time.sleep(attempt)
        finally:
            partial.unlink(missing_ok=True)


def fetch(manifest_path: Path, destination: Path, cache: Path) -> None:
    manifest = json.loads(manifest_path.read_text())
    source = f"https://huggingface.co/convaiinnovations/laya/resolve/{manifest['revision']}"
    cache.mkdir(parents=True, exist_ok=True)
    for filename, expected in manifest["files"].items():
        target = destination / filename
        target.parent.mkdir(parents=True, exist_ok=True)
        cached = cache / expected
        download(f"{source}/{filename}", cached, expected)
        shutil.copyfile(cached, target)
        print(f"Verified {filename}", flush=True)

    shutil.copyfile(manifest_path, destination / "model-manifest.json")
    shutil.copyfile(manifest_path.with_name("LICENSE"), destination / "LICENSE")
    for path in [*destination.rglob("*"), destination]:
        path.chmod(0o755 if path.is_dir() else 0o644)
        os.utime(path, (0, 0))


if __name__ == "__main__":
    fetch(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]))
