from __future__ import annotations

import hashlib
import importlib.metadata
import json
from dataclasses import asdict, replace
from typing import Any

import yaml

from runner.toolkit.compiler.nemo_compiler import NeMoConfigCompiler
from runner.toolkit.nemo.builtin_policies import prompt_catalog_yaml

from . import generated as protocol
from .config import RunnerSettings
from .protocol_codec import (
    action_bindings_to_proto,
    artifact_content,
    dependencies_to_proto,
    plan_from_proto,
    plan_to_proto,
    prompts_to_proto,
)
from .serialization import plan_from_dict


class DefaultRunnerCompiler:
    """The authoritative NeMo compiler hosted by the mandatory Default Runner."""

    def __init__(self, settings: RunnerSettings | None = None) -> None:
        del settings
        self._compiler = NeMoConfigCompiler(
            builtin_prompts_yaml=prompt_catalog_yaml(),
        )
        self._nemo_version = importlib.metadata.version("nemoguardrails")

    def compile(self, request: protocol.CompileRequest) -> protocol.Artifact:
        payload = plan_from_proto(request.plan)
        payload.update({
            "guardrail_id": request.guardrail_id,
            "guardrail_version": request.guardrail_version,
            "compiler_version": payload.get("compiler_version") or "tasklattice-controller-plan-v5-rule-order",
        })
        plan = plan_from_dict(payload)
        snapshot = self._compiler.compile(plan)
        if request.runtime_profile not in {"", "auto", snapshot.runtime_profile}:
            raise ValueError(
                f"Plan requires {snapshot.runtime_profile}; requested {request.runtime_profile}."
            )
        prompts = (yaml.safe_load(snapshot.prompts_yaml) or {}).get("prompts", [])
        action_bindings = [asdict(item) for item in snapshot.action_bindings]
        dependencies = [list(item) for item in snapshot.dependency_manifest]
        artifact = protocol.Artifact(
            guardrail_id=request.guardrail_id,
            guardrail_version=request.guardrail_version,
            generation=request.generation,
            compiler_version=snapshot.compiler_version,
            nemo_version=self._nemo_version,
            runtime_profile=snapshot.runtime_profile,
            plan=plan_to_proto(payload),
            config_yaml=snapshot.config_yaml,
            colang_content=snapshot.colang_content,
            prompts=prompts_to_proto(prompts),
            action_bindings=action_bindings_to_proto(action_bindings),
            dependency_manifest=dependencies_to_proto(dependencies),
        )
        artifact.checksum = hashlib.sha256(
            _stable_json(artifact_content(artifact)).encode()
        ).hexdigest()
        return artifact


def _stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
