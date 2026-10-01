"""Policy source packages: explicit file ownership, ordering and portable archives."""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path, PurePosixPath
import stat
import tempfile
from typing import Any, Iterator, Literal
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

from pydantic import Field, TypeAdapter, model_validator

from .declarative import (
    ExecutionDefinition, ParameterDefinition, PolicyDefinition, PolicyMetadata,
    RuleDefinition, StrictModel, TestDefinition, parse_yaml,
)

MAX_FILE_BYTES = 2_000_000
MAX_PACKAGE_BYTES = 32_000_000
MAX_PACKAGE_FILES = 4096


class TestSettings(StrictModel):
    parameters: dict[str, str] = Field(default_factory=dict)


class PolicyManifest(StrictModel):
    schema_version: Literal[2]
    kind: Literal["Policy"]
    metadata: PolicyMetadata
    parameters: list[ParameterDefinition] = Field(default_factory=list)
    execution: ExecutionDefinition = Field(default_factory=ExecutionDefinition)
    rules: list[str] = Field(min_length=1)
    tests: list[str] = Field(min_length=1)
    resources: list[str] = Field(default_factory=list)
    documents: list[str] = Field(default_factory=list)
    testing: TestSettings = Field(default_factory=TestSettings)
    history: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def files_and_parameters(self) -> PolicyManifest:
        paths = [*self.rules, *self.tests, *self.resources, *self.documents]
        if len(paths) != len(set(paths)):
            raise ValueError("Package file references must be unique")
        for path in paths:
            safe_path(path)
            if path in {"policy.yaml", "manifest.json"}:
                raise ValueError(f"Reserved package path: {path}")
        for path in self.history:
            if not path.startswith("history/"):
                raise ValueError("Historical versions must live under history/")
            safe_path(path)
        if self.metadata.source == "custom" and self.history:
            raise ValueError("Imported packages contain exactly one Policy version")
        unknown = self.testing.parameters.keys() - {p.name for p in self.parameters}
        if unknown:
            raise ValueError(f"Unknown test parameters: {sorted(unknown)}")
        return self


def safe_path(value: str) -> PurePosixPath:
    path = PurePosixPath(value)
    if not value or "\\" in value or ":" in value or path.is_absolute() or any(p in {"", ".", ".."} for p in value.split("/")):
        raise ValueError(f"Unsafe package path: {value}")
    return path


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


@dataclass(frozen=True)
class PolicyPackage:
    root: Path
    manifest: PolicyManifest
    definition: PolicyDefinition
    files: dict[str, bytes]

    @property
    def checksum(self) -> str:
        return digest(json.dumps({p: digest(data) for p, data in sorted(self.files.items())}, sort_keys=True).encode())


def load_package(root: Path) -> PolicyPackage:
    if not root.is_dir() or root.is_symlink():
        raise ValueError("A Policy must be a directory containing policy.yaml")
    root = root.resolve()
    files: dict[str, bytes] = {}

    def read(relative: str) -> bytes:
        path = root / safe_path(relative)
        if any(part.is_symlink() for part in (path, *path.parents)) or not path.resolve().is_relative_to(root):
            raise ValueError(f"Package references cannot follow symlinks: {relative}")
        if not path.is_file() or path.stat().st_size > MAX_FILE_BYTES:
            raise ValueError(f"Missing or oversized package file: {relative}")
        files[relative] = path.read_bytes()
        return files[relative]

    manifest = PolicyManifest.model_validate(parse_yaml(read("policy.yaml").decode()))
    if 1 + sum(len(paths) for paths in (manifest.rules, manifest.tests, manifest.resources, manifest.documents)) > MAX_PACKAGE_FILES:
        raise ValueError("Policy package exceeds file limit")
    for relative in [*manifest.rules, *manifest.tests, *manifest.resources, *manifest.documents]:
        read(relative)
    actual = set()
    for path in root.rglob("*"):
        relative = path.relative_to(root).as_posix()
        if path.is_symlink():
            raise ValueError(f"Package cannot contain symlinks: {relative}")
        if any(relative == h or relative.startswith(h + "/") for h in manifest.history):
            continue
        if path.is_file():
            actual.add(relative)
    if actual != files.keys():
        raise ValueError(f"Unlisted package files: {sorted(actual - files.keys())}")
    if len(files) > MAX_PACKAGE_FILES or sum(map(len, files.values())) > MAX_PACKAGE_BYTES:
        raise ValueError("Policy package exceeds size limits")

    resolved_nodes = 0

    def resolve(value: Any, stack: tuple[str, ...] = (), depth: int = 0) -> Any:
        nonlocal resolved_nodes
        resolved_nodes += 1
        if resolved_nodes > 200_000 or depth > 64:
            raise ValueError("Expanded package resources exceed limits")
        if isinstance(value, dict):
            if "$ref" in value:
                if set(value) != {"$ref"} or value["$ref"] not in manifest.resources:
                    raise ValueError("Resource references must name a declared package resource")
                name = value["$ref"]
                if name in stack:
                    raise ValueError(f"Cyclic package resource: {name}")
                raw = files[name].decode()
                content = parse_yaml(raw) if Path(name).suffix in {".yaml", ".yml", ".json"} else raw
                return resolve(content, (*stack, name), depth + 1)
            return {key: resolve(item, stack, depth + 1) for key, item in value.items()}
        if isinstance(value, list):
            return [resolve(item, stack, depth + 1) for item in value]
        return value

    rules = []
    for relative in manifest.rules:
        rule = resolve(parse_yaml(files[relative].decode()))
        RuleDefinition.model_validate(rule)  # One Rule object per file, never an implicit list.
        rules.append(rule)
    tests = []
    for relative in manifest.tests:
        cases = resolve(parse_yaml(files[relative].decode()))
        TypeAdapter(list[TestDefinition]).validate_python(cases)
        tests.extend(cases)
    definition = PolicyDefinition.model_validate({
        **manifest.model_dump(exclude_unset=True, exclude={"resources", "documents", "testing", "history"}),
        "schema_version": 1, "rules": rules, "tests": tests,
    })
    return PolicyPackage(root, manifest, definition, files)


def detector_dependencies(package: PolicyPackage, registry: dict) -> dict:
    result = {}
    for rule in package.definition.rules:
        ref = rule.detector.ref
        adapter = registry["detectors"].get(ref)
        if adapter is None or adapter["version"] != rule.detector.version:
            raise ValueError(f"Unavailable detector {ref}@{rule.detector.version}")
        result[ref] = {"version": rule.detector.version, "sha256": digest(json.dumps(adapter, sort_keys=True).encode())}
    return result


def export_archive(package: PolicyPackage, output: Path, registry: dict, *, replace: bool = False) -> None:
    if package.definition.metadata.source != "custom":
        raise ValueError("Import/export accepts custom Policies only")
    if output.suffix != ".zip":
        raise ValueError("Export destination must use the .zip extension")
    if output.exists() and not replace:
        raise ValueError("Export destination exists; use --replace explicitly")
    if output.resolve().is_relative_to(package.root):
        raise ValueError("Export destination must be outside the source package")
    index = {
        "schema_version": 2, "id": package.definition.metadata.id, "version": package.definition.metadata.version,
        "files": {path: digest(value) for path, value in sorted(package.files.items())},
        "detectors": detector_dependencies(package, registry),
    }
    with tempfile.NamedTemporaryFile(dir=output.parent, suffix=".zip", delete=False) as temporary:
        archive = Path(temporary.name)
    try:
        with ZipFile(archive, "w", compression=ZIP_DEFLATED) as bundle:
            contents = {**package.files, "manifest.json": (json.dumps(index, sort_keys=True, indent=2) + "\n").encode()}
            for name, value in sorted(contents.items()):
                info = ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = ZIP_DEFLATED
                info.external_attr = (stat.S_IFREG | 0o644) << 16
                bundle.writestr(info, value)
        archive.replace(output)
    finally:
        archive.unlink(missing_ok=True)


@contextmanager
def open_package(path: Path, registry: dict) -> Iterator[PolicyPackage]:
    if path.is_dir():
        yield load_package(path)
        return
    if path.suffix != ".zip":
        raise ValueError("Use a Policy directory or a .zip Policy package; flat YAML is no longer supported")
    with tempfile.TemporaryDirectory(prefix="guard-policy-import-") as directory:
        root = Path(directory)
        with ZipFile(path) as bundle:
            entries = bundle.infolist()
            names = [entry.filename for entry in entries]
            if len(entries) > MAX_PACKAGE_FILES + 1 or len(set(names)) != len(names) or sum(e.file_size for e in entries) > MAX_PACKAGE_BYTES:
                raise ValueError("Invalid archive size or duplicate paths")
            for entry in entries:
                safe_path(entry.filename)
                mode = entry.external_attr >> 16
                if entry.is_dir() or stat.S_ISLNK(mode) or (stat.S_IFMT(mode) and not stat.S_ISREG(mode)) or entry.file_size > MAX_FILE_BYTES:
                    raise ValueError("Archive must contain bounded regular files only")
            index = json.loads(bundle.read("manifest.json"))
            if index.get("schema_version") != 2 or set(index.get("files", {})) != set(names) - {"manifest.json"}:
                raise ValueError("Invalid package manifest")
            for name, expected in index["files"].items():
                value = bundle.read(name)
                if digest(value) != expected:
                    raise ValueError(f"Package checksum mismatch: {name}")
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(value)
        package = load_package(root)
        if (index["id"], index["version"]) != (package.definition.metadata.id, package.definition.metadata.version):
            raise ValueError("Package identity does not match manifest")
        if index["detectors"] != detector_dependencies(package, registry):
            raise ValueError("Package detector dependencies differ from the target platform")
        yield package
