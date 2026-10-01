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


def collections() -> list[dict]:
    manifest = parse_yaml((SOURCE / "catalog.yaml").read_text())
    if manifest.get("schema_version") != 2:
        raise ValueError("Catalog requires directory packages (schema_version: 2)")
    items = manifest["collections"]
    assets = [item["asset"] for item in items]
    if len(assets) != len(set(assets)) or assets[-1:] != ["custom_policies.json"]:
        raise ValueError("Catalog assets must be unique, with custom_policies.json last")
    return items


def package_paths() -> list[tuple[str, Path]]:
    result = []
    for collection in collections():
        asset = collection["asset"]
        if Path(asset).name != asset or not asset.endswith(".json"):
            raise ValueError("Invalid catalog asset name")
        paths = [source_path(relative) for relative in collection["policies"]]
        if asset == "custom_policies.json":
            paths = sorted(path.parent for path in (SOURCE / "custom").glob("*/policy.yaml"))
        result.extend((asset, path) for path in paths)
    declared = {path.resolve() for _, path in result}
    if len(declared) != len(result):
        raise ValueError("Duplicate Policy package path")
    discovered = {path.parent.resolve() for path in (SOURCE / "builtin").rglob("policy.yaml")}
    listed_builtin = {path.resolve() for asset, path in result if asset != "custom_policies.json"}
    if discovered != listed_builtin:
        raise ValueError("Built-in packages and catalog metadata differ")
    return result


def build() -> dict[Path, str]:
    detectors = registry()
    compiled = {item["asset"]: [] for item in collections()}
    identities = set()
    current_ids = set()
    for asset, path in package_paths():
        package = load_package(path)
        definition = package.definition
        custom = asset == "custom_policies.json"
        if (definition.metadata.source == "custom") != custom:
            raise ValueError(f"Package {path} has an invalid origin")
        if custom and definition.metadata.id in current_ids:
            raise ValueError("Custom Policies cannot replace bundled Policy IDs")
        identity = (definition.metadata.id, definition.metadata.version)
        if identity in identities:
            raise ValueError(f"Duplicate Policy identity {identity}")
        identities.add(identity)
        historical = asset == "legacy_topic_policies.json"
        if not historical:
            if path.name != definition.metadata.id or definition.metadata.id in current_ids:
                raise ValueError("Each current Policy must have one directory named after its ID")
            current_ids.add(definition.metadata.id)
        compiled[asset].append(compile_policy(definition, detectors))
    output = {ASSETS / name: json.dumps(items, ensure_ascii=False, indent=2) + "\n" for name, items in compiled.items()}
    output[ASSETS / "detectors.generated.json"] = json.dumps(detectors, ensure_ascii=False, indent=2) + "\n"
    schemas = {"policy": PolicyManifest.model_json_schema(), "rule": RuleDefinition.model_json_schema(), "tests": TypeAdapter(list[TestDefinition]).json_schema()}
    # The package loader resolves declared resources before validating cases.
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
    bundled_ids = {load_package(path).definition.metadata.id for asset, path in package_paths() if asset != "custom_policies.json"}
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
        packages = [load_package(path) for asset, path in package_paths() if asset != "legacy_topic_policies.json"]
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
