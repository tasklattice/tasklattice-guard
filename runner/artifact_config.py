from __future__ import annotations

from typing import Any, Mapping

import yaml

from runner.toolkit.runtime.contracts import NeMoConfigSnapshot

from . import generated as protocol
from .protocol_codec import (
    action_bindings_from_proto,
    artifact_content,
    dependencies_from_proto,
    plan_from_proto,
    prompts_from_proto,
)
from .serialization import config_from_dict


def config_snapshot_from_artifact(
    artifact: protocol.Artifact,
    *,
    verified_content: Mapping[str, Any] | None = None,
) -> NeMoConfigSnapshot:
    """Restore runtime-only snapshot fields omitted from the wire artifact."""

    content = (
        dict(verified_content)
        if verified_content is not None
        else artifact_content(artifact)
    )
    dependencies = dependencies_from_proto(artifact.dependency_manifest)
    parsed = yaml.safe_load(artifact.config_yaml) or {}
    rails = parsed.get("rails", {}) if isinstance(parsed, dict) else {}
    rail_flows = tuple(
        (phase, str(flow))
        for phase in ("input", "output")
        for flow in (
            rails.get(phase, {}).get("flows", ())
            if isinstance(rails, dict) and isinstance(rails.get(phase), dict)
            else ()
        )
    )
    rail_config = rails.get("config", {}) if isinstance(rails, dict) else {}
    prompts = prompts_from_proto(artifact.prompts)
    plan = content.get("plan") or plan_from_proto(artifact.plan)
    return config_from_dict(
        {
            "guardrail_id": artifact.guardrail_id,
            "guardrail_version": artifact.guardrail_version,
            "compiler_version": artifact.compiler_version,
            "runtime_profile": artifact.runtime_profile,
            "output_delivery": plan.get("output_delivery", "full_buffered"),
            "config_yaml": artifact.config_yaml,
            "colang_content": artifact.colang_content,
            "prompts_yaml": (
                yaml.safe_dump(
                    {"prompts": prompts}, allow_unicode=True, sort_keys=False
                )
                if prompts
                else ""
            ),
            "action_bindings": action_bindings_from_proto(
                artifact.action_bindings
            ),
            "dependency_manifest": dependencies,
            "required_models": sorted(
                {
                    name
                    for kind, name, _version in dependencies
                    if kind == "model"
                }
            ),
            "required_features": (
                ["sensitive_data_detection"]
                if isinstance(rail_config, dict)
                and "sensitive_data_detection" in rail_config
                else []
            ),
            "rail_flows": rail_flows,
            "runtime_engine": (
                "iorails"
                if artifact.runtime_profile == "iorails_native"
                else "llmrails"
            ),
            "colang_version": (
                "2.x"
                if artifact.runtime_profile == "llmrails_colang2_programmable"
                else "1.0"
            ),
        }
    )
