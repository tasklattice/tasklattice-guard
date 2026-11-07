#!/usr/bin/env python3
"""Build, test and transfer directory-based Policy packages."""
from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
import shutil
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from pydantic import TypeAdapter
from runner.toolkit.policy_library.declarative import RuleDefinition, TestDefinition, compile_policy, parse_yaml
from runner.toolkit.policy_library.package import PolicyManifest, PolicyPackage, export_archive, load_package, open_package
from runner.toolkit.policy_library.rules import RuleRegistry

SOURCE = ROOT / "policies"
ASSETS = ROOT / "runner/toolkit/policy_library/assets"


def registry() -> dict:
    return parse_yaml((SOURCE / "detectors.yaml").read_text())


def source_path(relative: str) -> Path:
    from runner.toolkit.policy_library.package import safe_path
    path = SOURCE / safe_path(relative)
    if not path.resolve().is_relative_to(SOURCE.resolve()):
        raise ValueError(f"Invalid Policy package path {relative}")
    return path


def library_paths() -> list[Path]:
    paths = sorted(path.parent for path in (SOURCE / "library").glob("*/policy.yaml"))
    if not paths:
        raise ValueError("The Policy catalog has no packages")
    return paths


def package_paths() -> list[Path]:
    """Bundled and imported Policy packages compiled into the one catalog."""
    return library_paths() + sorted(path.parent for path in (SOURCE / "custom").glob("*/policy.yaml"))


def build() -> dict[Path, str]:
    detectors = registry()
    rule_registry = RuleRegistry.load(SOURCE / "rules")
    compiled: list[dict] = []
    definitions: dict[str, dict] = {}
    identities: set[tuple[str, str]] = set()
    for path in package_paths():
        package = load_package(path, rule_registry)
        definition = package.definition
        source = "custom" if path.resolve().is_relative_to((SOURCE / "custom").resolve()) else "built_in"
        if definition.metadata.source != source:
            raise ValueError(f"Package {path} has an invalid origin")
        item_source = source
        identity = (definition.metadata.id, definition.metadata.version)
        if identity in identities:
            raise ValueError(f"Duplicate Policy identity {identity}")
        identities.add(identity)
        if path.name != definition.metadata.id:
            raise ValueError("Each Policy must have one directory named after its ID")
        item = compile_policy(definition, detectors)
        item["source"] = item_source
        item["rails"] = sorted({rail for rule in item["rules"] for rail in rule["rails"]})
        item["testing"] = package.manifest.testing.parameters
        authoring = definition.model_dump()
        authoring["metadata"].pop("source", None)
        authoring["metadata"].pop("compliance", None)
        for rule in authoring["rules"]:
            rule.pop("runtime_adapter", None)
        for test in authoring["tests"]:
            if test["context"] is None:
                test.pop("context")
        if package.manifest.testing.parameters:
            authoring["testing"] = {"parameters": package.manifest.testing.parameters}
        item["definition"] = authoring
        compiled.append(item)
        definitions[definition.metadata.id] = authoring
    output = {
        ASSETS / "policies.json": json.dumps(compiled, ensure_ascii=False, indent=2) + "\n",
        ASSETS / "detectors.generated.json": json.dumps(detectors, ensure_ascii=False, indent=2) + "\n",
        ASSETS / "policy-definitions.generated.json": json.dumps(definitions, ensure_ascii=False, indent=2) + "\n",
    }
    schemas = {"policy": PolicyManifest.model_json_schema(), "rule": RuleDefinition.model_json_schema(), "tests": TypeAdapter(list[TestDefinition]).json_schema()}
    for field in ("content", "expected_text"):
        prop = schemas["tests"]["$defs"]["TestDefinition"]["properties"][field]
        schemas["tests"]["$defs"]["TestDefinition"]["properties"][field] = {"anyOf": [prop, {"type": "object", "properties": {"$ref": {"type": "string"}}, "required": ["$ref"], "additionalProperties": False}]}
    for name, schema in schemas.items():
        output[SOURCE / f"schemas/{name}.schema.json"] = json.dumps(schema, ensure_ascii=False, indent=2) + "\n"
    return output


def write_outputs(output: dict[Path, str]) -> None:
    staged: dict[Path, Path] = {}
    previous: dict[Path, bytes | None] = {}
    applied: list[Path] = []
    try:
        # Prepare every file before changing the generated catalog. If a write
        # fails, import_policy can roll back both the source and its artifacts.
        for path, content in output.items():
            if path.exists() and json.loads(path.read_text()) == json.loads(content):
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            previous[path] = path.read_bytes() if path.exists() else None
            with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as temporary:
                staged[path] = Path(temporary.name)
                temporary.write(content.encode())
            staged[path].chmod(0o644)
        for path, temporary in staged.items():
            temporary.replace(path)
            applied.append(path)
    except Exception:
        for path in reversed(applied):
            if previous[path] is None:
                path.unlink(missing_ok=True)
            else:
                path.write_bytes(previous[path])
        raise
    finally:
        for temporary in staged.values():
            temporary.unlink(missing_ok=True)


def validate_import(package: PolicyPackage) -> None:
    if package.definition.metadata.source != "custom":
        raise ValueError("Import/export accepts custom Policies only")
    bundled_ids = {load_package(path).definition.metadata.id for path in library_paths()}
    if package.definition.metadata.id in bundled_ids:
        raise ValueError("Custom Policies cannot claim a bundled Policy ID")
    compile_policy(package.definition, registry())


def import_policy(path: Path, *, replace: bool = False) -> Path:
    with open_package(path, registry()) as package:
        validate_import(package)
        destination = source_path(f"custom/{package.definition.metadata.id}")
        if destination.exists() and not replace:
            raise ValueError("Policy already imported; use --replace explicitly")
        if destination.exists():
            old = load_package(destination)
            if old.definition.metadata.version == package.definition.metadata.version and old.checksum != package.checksum:
                raise ValueError("Changed Policy packages require a new version before replacement")
        destination.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".policy-stage-", dir=destination.parent) as temporary:
            stage = Path(temporary) / "candidate"
            stage.mkdir()
            for name, value in package.files.items():
                target = stage / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(value)
            # Validate again before swapping the directory, retaining exact source files.
            load_package(stage)
            previous = Path(temporary) / "previous"
            if destination.exists():
                destination.rename(previous)
            try:
                stage.rename(destination)
                output = build()
                write_outputs(output)
            except Exception:
                shutil.rmtree(destination, ignore_errors=True)
                if previous.exists():
                    previous.rename(destination)
                raise
        return destination


def export_policy(path: Path, output: Path, *, replace: bool = False) -> None:
    with open_package(path, registry()) as package:
        validate_import(package)
        export_archive(package, output, registry(), replace=replace)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["build", "check", "validate", "test", "import", "export"])
    parser.add_argument("package", nargs="?", type=Path)
    parser.add_argument("--all", action="store_true", help="Regress all current Policy packages")
    parser.add_argument("--output", type=Path, help="Export archive or regression report JSON")
    parser.add_argument("--replace", action="store_true")
    parser.add_argument("--require-all", action="store_true", help="Fail if model-dependent tests are not executed")
    parser.add_argument("--parameters", type=Path, help="JSON object of synthetic test values")
    args = parser.parse_args()
    if args.all and (args.command != "test" or args.package or args.parameters):
        parser.error("--all is only for testing the catalog; it cannot be combined with a package or parameter overrides")
    if args.command in {"build", "check"}:
        output = build()
        stale = [str(path) for path, text in output.items() if not path.exists() or json.loads(path.read_text()) != json.loads(text)]
        if args.command == "check" and stale:
            raise ValueError("Generated Policy assets are stale: " + ", ".join(stale))
        if args.command == "build":
            write_outputs(output)
        print(f"Policy packages {'compiled' if args.command == 'build' else 'current'}: {len(output)} artifacts")
        return
    if args.command == "test" and args.all:
        from runner.toolkit.policy_library.regression import run_packages
        packages = [load_package(path) for path in package_paths()]
        report = asyncio.run(run_packages(packages, registry(), ASSETS))
    else:
        if args.package is None:
            parser.error("A Policy package directory or archive is required")
        if args.command == "import":
            print(f"Imported package: {import_policy(args.package, replace=args.replace)}")
            return
        if args.command == "export":
            if args.output is None:
                parser.error("--output is required for export")
            export_policy(args.package, args.output, replace=args.replace)
            print(f"Exported package: {args.output}")
            return
        with open_package(args.package, registry()) as package:
            compile_policy(package.definition, registry())
            if args.command == "validate":
                print(f"Valid: {package.definition.metadata.id}, {len(package.definition.rules)} Rules, {len(package.definition.tests)} tests")
                return
            from runner.toolkit.policy_library.regression import run_packages
            values = json.loads(args.parameters.read_text()) if args.parameters else {}
            report = asyncio.run(run_packages([package], registry(), ASSETS, values))
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report["summary"], ensure_ascii=False))
    for policy in report["policies"]:
        for case in policy["cases"]:
            if case["status"] == "failed":
                print(f"FAIL {policy['id']}/{case['id']}: {case['reason']}")
    if report["summary"]["failed"] or (args.require_all and report["summary"]["not_run"]):
        raise ValueError("Policy regression did not satisfy the requested gate")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Policy error: {error}", file=sys.stderr)
        sys.exit(1)
