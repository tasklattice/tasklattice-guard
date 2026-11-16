"""Model bundle v1. Keep this module identical in the Guard and Models repositories."""

from __future__ import annotations

import hashlib
import json
import math
import re
import threading
from dataclasses import dataclass
from importlib.metadata import version
from pathlib import Path
from typing import Any

MANIFEST = "model-manifest.json"
SHA = r"[0-9a-f]{64}"
VERSION = r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}"
GRAPH = "model.onnx"
TOKENIZER = "tokenizer/tokenizer.json"
ASSETS = frozenset(
    {
        GRAPH,
        TOKENIZER,
        "tokenizer/tokenizer_config.json",
        "encoder/config.json",
        "rl_agent_config.json",
        "calibration.json",
        "thresholds.json",
        "LICENSE",
    }
)
INPUTS = {
    "input_ids": "int64",
    "attention_mask": "int64",
    "marker_pos": "int64",
    "marker_mask": "bool",
    "qtype": "int64",
}
OUTPUTS = {"logits": "float", "act_logits": "float"}
RUNTIME = {
    "layaVersion": "0.3.22",
    "transformersVersion": "4.57.6",
    "onnxRuntimeVersion": "1.28.0",
    "torchVersion": "2.6.0",
    "opset": 17,
    "maxLen": 1024,
    "headMaxLen": 512,
    "language": "en",
    "inputSchema": INPUTS,
    "outputSchema": OUTPUTS,
    "labelMapping": {"0": "no", "1": "yes"},
    "preprocessing": "laya-system-one",
    "postprocessing": "laya-noul",
}
CATEGORIES = frozenset(
    {
        "content_safety",
        "jailbreak",
        "prompt_injection",
        "memory_poisoning",
        "pii",
        "credential_leakage",
        "topic_control",
    }
)
OCI_REFERENCE = r"ghcr\.io/[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*@sha256:[0-9a-f]{64}"


def json_digest(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(
            value,
            sort_keys=True,
            ensure_ascii=False,
            separators=(",", ":"),
            allow_nan=False,
        ).encode()
    ).hexdigest()


def file_digest(path: Path) -> str:
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def _object(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_bytes())
    if not isinstance(value, dict):
        raise TypeError(f"{path.name} must contain a JSON object.")
    return value


def _matches(value: Any, pattern: str) -> bool:
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def _number(value: Any, low: float, high: float) -> bool:
    return type(value) in (int, float) and math.isfinite(value) and low <= value <= high


def load_lock(path: Path) -> dict[str, Any]:
    value = _object(path)
    if (
        set(value)
        != {
            "schemaVersion",
            "image",
            "manifestSha256",
            "modelVersion",
            "artifactSha256",
        }
        or value["schemaVersion"] != "1.0"
        or not _matches(value["image"], OCI_REFERENCE)
        or not _matches(value["modelVersion"], VERSION)
        or not all(_matches(value[key], SHA) for key in ("manifestSha256", "artifactSha256"))
    ):
        raise ValueError("Invalid Runner model bundle lock.")
    return value


def validate_policy(policy: dict[str, Any]) -> None:
    overrides = policy.get("categories")
    if (
        set(policy) != {"schemaVersion", "version", "default", "categories"}
        or policy["schemaVersion"] != "1.0"
        or not _matches(policy["version"], VERSION)
        or not isinstance(overrides, dict)
        or not set(overrides) <= CATEGORIES
    ):
        raise ValueError("Invalid threshold policy.")
    for pair in [policy["default"], *overrides.values()]:
        if (
            not isinstance(pair, dict)
            or set(pair) != {"allow", "block"}
            or not all(_number(value, 0, 1) for value in pair.values())
            or pair["allow"] >= pair["block"]
        ):
            raise ValueError("Expected 0 <= allow < block <= 1 in threshold policy.")


def validate_calibration(calibration: dict[str, Any]) -> None:
    values = calibration.get("temperature")
    if (
        set(calibration)
        != {
            "version",
            "calibrationVersion",
            "method",
            "temperature",
            "temperature_by_options",
        }
        or calibration["version"] != 1
        or not _matches(calibration["calibrationVersion"], VERSION)
        or calibration["method"] != "temperature_scaling"
        or not isinstance(values, list)
        or len(values) != 3
        or not all(_number(value, 0.5, 5) for value in values)
        or calibration["temperature_by_options"] != {}
    ):
        raise ValueError("Invalid temperature calibration.")


@dataclass(frozen=True)
class Bundle:
    manifest: dict[str, Any]
    calibration: dict[str, Any]
    thresholds: dict[str, Any]

    @property
    def identity(self) -> dict[str, str]:
        keys = (
            "modelVersion",
            "calibrationVersion",
            "thresholdPolicyVersion",
            "artifactSha256",
        )
        return {key: self.manifest[key] for key in keys}


def verify_bundle(
    directory: Path,
    *,
    manifest_sha256: str | None = None,
    model_version: str | None = None,
) -> Bundle:
    directory = directory.resolve(strict=True)
    manifest_path = directory / MANIFEST
    if manifest_path.is_symlink():
        raise ValueError("The model manifest must be a regular bundle file.")
    if manifest_sha256 is not None and file_digest(manifest_path) != manifest_sha256:
        raise ValueError("Model manifest SHA-256 mismatch.")
    manifest = _object(manifest_path)
    if (
        manifest.get("schemaVersion") != "1.0"
        or manifest.get("runtimeContractVersion") != "1.0"
        or manifest.get("modelId") != "laya-guardrails"
        or manifest.get("format") != "onnx"
        or manifest.get("precision") != "int8"
        or manifest.get("runtime") != RUNTIME
        or not _matches(manifest.get("baseModelRevision"), r"[0-9a-f]{40}")
        or not _matches(manifest.get("evaluationRunId"), VERSION)
        or not _matches(manifest.get("modelVersion"), VERSION)
        or (model_version is not None and manifest["modelVersion"] != model_version)
    ):
        raise ValueError("Unsupported model identity or runtime contract.")
    allowed_keys = {
        "schemaVersion",
        "runtimeContractVersion",
        "modelId",
        "modelVersion",
        "baseModelRevision",
        "format",
        "precision",
        "artifactSha256",
        "tokenizerSha256",
        "calibrationVersion",
        "thresholdPolicyVersion",
        "evaluationRunId",
        "runtime",
        "files",
    }
    if set(manifest) != allowed_keys:
        raise ValueError("Unexpected model manifest fields.")
    files = manifest.get("files")
    actual = {p.relative_to(directory).as_posix() for p in directory.rglob("*") if not p.is_dir()}
    if (
        not isinstance(files, dict)
        or set(files) != ASSETS
        or actual != ASSETS | {MANIFEST}
        or any(path.is_symlink() for path in directory.rglob("*"))
    ):
        raise ValueError("Invalid model bundle file list.")
    for name, expected in files.items():
        if not _matches(expected, SHA) or file_digest(directory / name) != expected:
            raise ValueError(f"Model bundle SHA-256 mismatch for {name}.")
    if (
        manifest.get("artifactSha256") != json_digest(files)
        or manifest.get("tokenizerSha256") != files[TOKENIZER]
    ):
        raise ValueError("Model bundle digest or tokenizer identity mismatch.")
    calibration = _object(directory / "calibration.json")
    thresholds = _object(directory / "thresholds.json")
    validate_calibration(calibration)
    validate_policy(thresholds)
    if (
        manifest.get("calibrationVersion") != calibration["calibrationVersion"]
        or manifest.get("thresholdPolicyVersion") != thresholds["version"]
    ):
        raise ValueError("Model bundle calibration or threshold identity mismatch.")
    return Bundle(manifest, calibration, thresholds)


def load_onnx_agent(directory: Path, graph: Path, threads: int):
    """Use Laya's pinned request/response implementation with a bounded CPU session."""
    import onnxruntime as ort
    from laya.onnx_agent import ONNXAgent
    from transformers import AutoTokenizer

    for distribution, key in (
        ("laya", "layaVersion"),
        ("transformers", "transformersVersion"),
        ("onnxruntime", "onnxRuntimeVersion"),
        ("torch", "torchVersion"),
    ):
        installed = version(distribution)
        if distribution == "torch":
            installed = installed.split("+", 1)[0]
        if installed != RUNTIME[key]:
            raise ValueError(f"Incompatible {distribution} version for the Laya ONNX bundle.")
    options = ort.SessionOptions()
    options.intra_op_num_threads = threads
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    session = ort.InferenceSession(
        str(graph), sess_options=options, providers=["CPUExecutionProvider"]
    )
    for actual, expected in (
        (session.get_inputs(), INPUTS),
        (session.get_outputs(), OUTPUTS),
    ):
        if {node.name: node.type for node in actual} != {
            key: f"tensor({value})" for key, value in expected.items()
        }:
            raise ValueError("ONNX tensor schema does not match the Laya runtime.")
        if any(len(node.shape) != (1 if node.name == "qtype" else 2) for node in actual):
            raise ValueError("ONNX tensor rank does not match the Laya runtime.")
        if any(isinstance(node.shape[0], int) for node in actual):
            raise ValueError("ONNX tensors must accept a dynamic question batch.")
    if any(
        isinstance(node.shape[1], int)
        for node in session.get_inputs()
        if node.name in {"input_ids", "attention_mask"}
    ):
        raise ValueError("ONNX state tensors must accept a dynamic token length.")

    # The SDK constructor chooses its own threading and execution providers.
    # Bind the pinned SDK's System One methods to this explicitly configured session.
    agent = ONNXAgent.__new__(ONNXAgent)
    agent.model_id = str(directory)
    agent.cfg = _object(directory / "rl_agent_config.json")
    agent.tok = AutoTokenizer.from_pretrained(str(directory / "tokenizer"), local_files_only=True)
    agent.session = session
    agent.hooks = []
    agent._hooks_mutex = threading.Lock()
    agent.lang_temperatures = {}
    if (directory / "calibration.json").is_file():
        agent.load_calibration(str(directory / "calibration.json"))
    else:
        from laya.calibrate import apply_calibration_payload

        apply_calibration_payload(
            agent,
            {
                "temperature": agent.cfg.get("temperature", [1, 1, 1]),
                "temperature_by_options": agent.cfg.get("temperature_by_options", {}),
            },
        )
    return agent
