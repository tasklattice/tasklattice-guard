from __future__ import annotations

from pathlib import Path

from conftest import architectural_suite


ROOT = Path(__file__).resolve().parents[2]
TESTS = ROOT / "tests"


def test_data_plane_tests_do_not_compile_or_validate_artifacts() -> None:
    violations: list[str] = []
    for path in sorted(TESTS.rglob("test_*.py")):
        if architectural_suite(path) != "data_plane":
            continue
        source = path.read_text(encoding="utf-8")
        if "runner.compiler" in source or "DefaultRunnerCompiler" in source:
            violations.append(f"{path.relative_to(ROOT)} imports the compiler")
        if "runner.validator" in source or "DefaultRunnerValidator" in source:
            violations.append(f"{path.relative_to(ROOT)} imports the validator")

    assert violations == [], "\n".join(violations)


def test_checked_in_artifact_fixture_contains_no_private_key() -> None:
    fixture = TESTS / "fixtures" / "artifacts" / "local-secrets-v1"
    assert {path.name for path in fixture.iterdir()} == {
        "desired-state.pb.b64",
        "manifest.json",
        "public-key.pem",
    }
    for path in fixture.iterdir():
        assert "PRIVATE KEY" not in path.read_text(encoding="utf-8")
