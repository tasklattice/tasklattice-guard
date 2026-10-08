"""Offline Artifact compilation from a frozen plan and explicit target capabilities."""
from __future__ import annotations

import importlib.metadata
from dataclasses import asdict

import yaml

from .nemo_compiler import NeMoConfigCompiler
from runner import generated as protocol
from runner.protocol_codec import (
    action_bindings_to_proto, artifact_digest, dependencies_to_proto,
    plan_from_proto, plan_to_proto, prompts_to_proto,
)
from runner.serialization import plan_from_dict


class ArtifactCompiler:
    """No Runner configuration, credentials, Controller connection or Policy catalog."""

    def __init__(self, *, builtin_prompts_yaml: str, model_types: tuple[str, ...] = ()) -> None:
        self._compiler = NeMoConfigCompiler(
            models=tuple({"type": name, "engine": "openai", "model": f"__tasklattice_runtime__:{name}"}
                         for name in dict.fromkeys(model_types)),
            builtin_prompts_yaml=builtin_prompts_yaml,
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
        artifact.checksum = artifact_digest(artifact)
        return artifact
