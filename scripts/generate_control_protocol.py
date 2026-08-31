#!/usr/bin/env python3
"""Generate both language bindings for the Controller/Runner protocol.

The checked-in ``.proto`` files are the only transport contract. Generated
Python and TypeScript files are committed for reproducible application builds;
``--check`` rejects stale output in CI.
"""

from __future__ import annotations

import argparse
import difflib
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
PROTO_DIR = ROOT / "proto" / "tasklattice" / "guard" / "control" / "v1"
PYTHON_OUTPUT = ROOT / "runner" / "generated"
TYPESCRIPT_OUTPUT = ROOT / "controller" / "server" / "generated" / "control-protocol"
PROTO_FILES = (
    "enforcement_action.proto",
    "common.proto",
    "runtime.proto",
    "evaluation.proto",
    "artifact.proto",
    "routing.proto",
    "integration.proto",
    "validation.proto",
    "runner_control.proto",
)


def _run_generators(temporary: Path) -> tuple[Path, Path]:
    python_dir = temporary / "python"
    typescript_dir = temporary / "typescript"
    python_dir.mkdir()
    typescript_dir.mkdir()

    subprocess.run(
        [
            sys.executable,
            "-m",
            "grpc_tools.protoc",
            "-I",
            str(PROTO_DIR),
            f"--python_out={python_dir}",
            *(str(PROTO_DIR / name) for name in PROTO_FILES),
        ],
        cwd=ROOT,
        check=True,
    )
    subprocess.run(
        [
            sys.executable,
            "-m",
            "grpc_tools.protoc",
            "-I",
            str(PROTO_DIR),
            f"--grpc_python_out={python_dir}",
            str(PROTO_DIR / "runner_control.proto"),
        ],
        cwd=ROOT,
        check=True,
    )

    # grpc_tools emits absolute sibling imports for flat Python output. The
    # bindings live in runner.generated, so imports must remain package-local.
    for path in python_dir.glob("*.py"):
        source = path.read_text(encoding="utf-8")
        source = re.sub(
            r"(?m)^import ([a-z0-9_]+_pb2) as ",
            r"from . import \1 as ",
            source,
        )
        path.write_text(source, encoding="utf-8")

    generator = ROOT / "controller" / "node_modules" / ".bin" / "proto-loader-gen-types"
    if not generator.exists():
        raise RuntimeError("Run `cd controller && npm ci` before generating protocol types.")
    subprocess.run(
        [
            str(generator),
            "--longs",
            "String",
            "--enums",
            "String",
            "--defaults",
            "--arrays",
            "--objects",
            "--oneofs",
            "--includeComments",
            "--grpcLib",
            "@grpc/grpc-js",
            "--importFileExtension",
            ".js",
            "-I",
            ".",
            "-O",
            str(typescript_dir),
            "runner_control.proto",
        ],
        cwd=PROTO_DIR,
        check=True,
    )
    return python_dir, typescript_dir


def _relative_files(directory: Path, suffix: str) -> dict[Path, str]:
    return {
        path.relative_to(directory): path.read_text(encoding="utf-8")
        for path in sorted(directory.rglob(f"*{suffix}"))
    }


def _check_directory(expected_dir: Path, actual_dir: Path, suffix: str) -> bool:
    expected = _relative_files(expected_dir, suffix)
    actual = _relative_files(actual_dir, suffix) if actual_dir.exists() else {}
    valid = True
    for relative in sorted(set(expected) | set(actual)):
        if expected.get(relative) == actual.get(relative):
            continue
        valid = False
        before = (actual.get(relative) or "").splitlines()
        after = (expected.get(relative) or "").splitlines()
        diff = difflib.unified_diff(
            before,
            after,
            fromfile=str((actual_dir / relative).relative_to(ROOT)),
            tofile=f"{(actual_dir / relative).relative_to(ROOT)} (generated)",
            n=2,
            lineterm="",
        )
        print("\n".join(diff))
    return valid


def _replace_generated(expected_dir: Path, actual_dir: Path, suffix: str) -> None:
    actual_dir.mkdir(parents=True, exist_ok=True)
    expected = _relative_files(expected_dir, suffix)
    for current in actual_dir.rglob(f"*{suffix}"):
        if current.relative_to(actual_dir) not in expected:
            current.unlink()
    for relative, content in expected.items():
        target = actual_dir / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    for directory in sorted(
        (item for item in actual_dir.rglob("*") if item.is_dir()),
        reverse=True,
    ):
        if not any(directory.iterdir()):
            directory.rmdir()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    enforcement = ROOT / "scripts" / "generate_enforcement_action_contract.py"
    subprocess.run(
        [sys.executable, str(enforcement), *(('--check',) if args.check else ())],
        cwd=ROOT,
        check=True,
    )
    with tempfile.TemporaryDirectory() as raw:
        python_dir, typescript_dir = _run_generators(Path(raw))
        if args.check:
            return 0 if (
                _check_directory(python_dir, PYTHON_OUTPUT, "_pb2.py")
                and _check_directory(python_dir, PYTHON_OUTPUT, "_pb2_grpc.py")
                and _check_directory(typescript_dir, TYPESCRIPT_OUTPUT, ".ts")
            ) else 1
        _replace_generated(python_dir, PYTHON_OUTPUT, "_pb2.py")
        _replace_generated(python_dir, PYTHON_OUTPUT, "_pb2_grpc.py")
        _replace_generated(typescript_dir, TYPESCRIPT_OUTPUT, ".ts")
    print("generated Controller and Runner control protocol bindings")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
