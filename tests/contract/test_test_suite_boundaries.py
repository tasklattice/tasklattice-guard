from __future__ import annotations

from pathlib import Path
import subprocess
import sys

from conftest import architectural_suite


ROOT = Path(__file__).resolve().parents[2]
TESTS = ROOT / "tests"


def test_data_plane_tests_do_not_compile_or_validate_artifacts() -> None:
    violations: list[str] = []
    for path in sorted(TESTS.rglob("test_*.py")):
        if architectural_suite(path) != "data_plane":
            continue
        source = path.read_text(encoding="utf-8")
        if "runner.compiler" in source or "DefaultRunnerCompiler" in source or "runner.toolkit.compiler.artifact" in source:
            violations.append(f"{path.relative_to(ROOT)} imports the compiler")
        if "runner.validator" in source or "DefaultRunnerValidator" in source:
            violations.append(f"{path.relative_to(ROOT)} imports the validator")

    assert violations == [], "\n".join(violations)


def test_artifact_fixture_contains_no_private_key() -> None:
    # The fixtures are generated, never committed; this guards the generator
    # from ever writing the test-only signing key into the working tree.
    fixture = TESTS / "fixtures" / "artifacts" / "local-secrets-v1"
    assert {path.name for path in fixture.iterdir()} == {
        "desired-state.pb.b64",
        "manifest.json",
        "public-key.pem",
    }
    for path in fixture.iterdir():
        assert "PRIVATE KEY" not in path.read_text(encoding="utf-8")


def test_control_plane_shards_cover_every_case_exactly_once() -> None:
    def collected(shard: str | None = None) -> set[str]:
        args = [sys.executable, "-m", "pytest", "--collect-only", "-q", "-m", "control_plane"]
        if shard is not None:
            args.append(f"--control-plane-shard={shard}")
        result = subprocess.run(args, cwd=ROOT, check=True, capture_output=True, text=True, timeout=60)
        return {line for line in result.stdout.splitlines() if line.startswith("tests/") and "::" in line}

    complete = collected()
    first, second = collected("1/2"), collected("2/2")
    assert complete
    assert first.isdisjoint(second)
    assert first | second == complete
    assert abs(len(first) - len(second)) <= 1
