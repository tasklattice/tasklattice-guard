"""Adapters between generated control messages and Runner domain dictionaries.

The transport schema is authoritative. These adapters are the single boundary
where Protobuf enum names and message fields are translated to the lowercase,
snake/camel-case values used by existing runtime domain objects.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from typing import Any

from google.protobuf.descriptor import EnumDescriptor, FieldDescriptor
from google.protobuf.message import Message
from google.protobuf.message_factory import GetMessageClass

from . import generated as protocol


def plan_to_proto(payload: Mapping[str, Any]) -> protocol.GuardrailPlan:
    return _message_from_mapping(protocol.GuardrailPlan, payload)


def plan_from_proto(message: protocol.GuardrailPlan) -> dict[str, Any]:
    result = _message_to_mapping(message)
    for key in ("safety_level", "output_delivery"):
        if result.get(key) == "unspecified":
            raise ValueError(f"Guardrail Plan requires {key}.")
    for step in result.get("steps", ()):
        if not step.get("capability"):
            raise ValueError("Guardrail Plan step requires capability.")
        if not step.get("contract_ref"):
            raise ValueError("Guardrail Plan step requires contract_ref.")
        if step.get("on_unsafe") == "unspecified":
            raise ValueError("Guardrail Plan step requires on_unsafe.")
        trigger = step.get("trigger", {})
        if trigger.get("type") == "unspecified":
            raise ValueError("Guardrail Plan step requires trigger.type.")
    return result


def prompts_to_proto(values: Iterable[Mapping[str, Any]]) -> list[protocol.PromptDefinition]:
    return [_message_from_mapping(protocol.PromptDefinition, value) for value in values]


def prompts_from_proto(values: Iterable[protocol.PromptDefinition]) -> list[dict[str, Any]]:
    return [_message_to_mapping(value) for value in values]


def action_bindings_to_proto(values: Iterable[Mapping[str, Any]]) -> list[protocol.ActionBinding]:
    return [_message_from_mapping(protocol.ActionBinding, value) for value in values]


def action_bindings_from_proto(values: Iterable[protocol.ActionBinding]) -> list[dict[str, Any]]:
    return [_message_to_mapping(value) for value in values]


def dependencies_to_proto(values: Iterable[Iterable[str]]) -> list[protocol.ArtifactDependency]:
    return [_message_from_mapping(protocol.ArtifactDependency, value) for value in values]


def dependencies_from_proto(values: Iterable[protocol.ArtifactDependency]) -> list[list[str]]:
    return [[value.kind, value.name, value.version] for value in values]


def artifact_content(message: protocol.Artifact) -> dict[str, Any]:
    """Return the canonical signed Artifact body shared with Controller."""

    return {
        "guardrailId": message.guardrail_id,
        "guardrailVersion": message.guardrail_version,
        "generation": int(message.generation),
        "compilerVersion": message.compiler_version,
        "nemoVersion": message.nemo_version,
        "runtimeProfile": message.runtime_profile,
        "plan": plan_from_proto(message.plan),
        "configYaml": message.config_yaml,
        "colangContent": message.colang_content,
        "prompts": prompts_from_proto(message.prompts),
        "actionBindings": action_bindings_from_proto(message.action_bindings),
        "dependencyManifest": dependencies_from_proto(message.dependency_manifest),
    }


def traffic_scope_to_proto(value: Mapping[str, Any]) -> protocol.TrafficScope:
    conditions: list[protocol.TrafficCondition] = []
    groups: list[protocol.TrafficScope] = []
    for item in value.get("conditions", ()):
        if not isinstance(item, Mapping):
            raise ValueError("Traffic Scope entries must be objects.")
        if "combinator" in item:
            groups.append(traffic_scope_to_proto(item))
        else:
            conditions.append(_message_from_mapping(protocol.TrafficCondition, item))
    return protocol.TrafficScope(
        combinator=_enum_number(
            protocol.TrafficScope.DESCRIPTOR.fields_by_name["combinator"].enum_type,
            value.get("combinator", "and"),
        ),
        conditions=conditions,
        groups=groups,
    )


def traffic_scope_from_proto(message: protocol.TrafficScope) -> dict[str, Any]:
    return {
        "combinator": _enum_domain(
            message.DESCRIPTOR.fields_by_name["combinator"].enum_type,
            message.combinator,
        ),
        "conditions": [
            _message_to_mapping(item) for item in message.conditions
        ] + [traffic_scope_from_proto(item) for item in message.groups],
    }


def integration_verification_to_proto(
    value: Mapping[str, Any],
) -> protocol.IntegrationVerification:
    raw = value.get("credentials", [])
    if not isinstance(raw, list):
        raise ValueError("Integration verification credentials must be a list.")
    return protocol.IntegrationVerification(credentials=[
        _message_from_mapping(protocol.IntegrationCredential, item, json_names=True)
        for item in raw
        if isinstance(item, Mapping)
    ])


def integration_verification_from_proto(
    message: protocol.IntegrationVerification,
) -> dict[str, Any]:
    return {
        "credentials": [
            _message_to_mapping(item, json_names=True) for item in message.credentials
        ]
    }


def validation_test_to_proto(value: Mapping[str, Any]) -> protocol.ValidationTestCase:
    return _message_from_mapping(protocol.ValidationTestCase, value, json_names=True)


def validation_test_from_proto(message: protocol.ValidationTestCase) -> dict[str, Any]:
    return _message_to_mapping(message, json_names=True)


def validation_metrics_to_proto(value: Mapping[str, Any]) -> protocol.ValidationMetrics:
    return _message_from_mapping(protocol.ValidationMetrics, value, json_names=True)


def validation_case_result_to_proto(
    value: Mapping[str, Any],
) -> protocol.ValidationCaseResult:
    shallow = dict(value)
    findings = shallow.pop("findings", ())
    trace = shallow.pop("trace", ())
    result = _message_from_mapping(
        protocol.ValidationCaseResult,
        shallow,
        json_names=True,
    )
    result.findings.extend(
        _message_from_mapping(protocol.RiskFinding, item)
        for item in findings
        if isinstance(item, Mapping)
    )
    result.trace.extend(
        _message_from_mapping(protocol.RuntimeTraceStep, item)
        for item in trace
        if isinstance(item, Mapping)
    )
    return result


def _message_from_mapping(
    message_type: type[Message],
    value: Mapping[str, Any] | Iterable[str],
    *,
    json_names: bool = False,
) -> Any:
    message = message_type()
    if message.DESCRIPTOR.full_name.endswith(".StringPair") and not isinstance(value, Mapping):
        pair = list(value)
        if len(pair) != 2:
            raise ValueError("StringPair values must contain exactly two entries.")
        message.key, message.value = str(pair[0]), str(pair[1])
        return message
    if message.DESCRIPTOR.full_name.endswith(".ArtifactDependency") and not isinstance(value, Mapping):
        parts = list(value)
        if len(parts) != 3:
            raise ValueError("Artifact dependencies must contain kind, name, and version.")
        message.kind, message.name, message.version = map(str, parts)
        return message
    if not isinstance(value, Mapping):
        raise ValueError(f"{message.DESCRIPTOR.name} requires an object.")

    for field in message.DESCRIPTOR.fields:
        key = field.json_name if json_names else field.name
        if key not in value or value[key] is None:
            continue
        raw = value[key]
        if _is_map(field):
            getattr(message, field.name).update(raw)
            continue
        if field.is_repeated:
            target = getattr(message, field.name)
            if field.message_type is not None:
                for item in raw:
                    target.add().CopyFrom(
                        _message_from_mapping(
                            _message_class(field), item, json_names=json_names
                        )
                    )
            elif field.enum_type is not None:
                target.extend(_enum_number(field.enum_type, item) for item in raw)
            else:
                target.extend(raw)
            continue
        if field.message_type is not None:
            getattr(message, field.name).CopyFrom(
                _message_from_mapping(_message_class(field), raw, json_names=json_names)
            )
        elif field.enum_type is not None:
            setattr(message, field.name, _enum_number(field.enum_type, raw))
        else:
            setattr(message, field.name, raw)
    return message


def _message_to_mapping(message: Message, *, json_names: bool = False) -> Any:
    if message.DESCRIPTOR.full_name.endswith(".StringPair"):
        return [message.key, message.value]
    result: dict[str, Any] = {}
    for field in message.DESCRIPTOR.fields:
        key = field.json_name if json_names else field.name
        value = getattr(message, field.name)
        if field.has_presence and not message.HasField(field.name):
            continue
        if _is_map(field):
            result[key] = dict(value)
        elif field.is_repeated:
            if field.message_type is not None:
                result[key] = [
                    _message_to_mapping(item, json_names=json_names) for item in value
                ]
            elif field.enum_type is not None:
                result[key] = [_enum_domain(field.enum_type, item) for item in value]
            else:
                result[key] = list(value)
        elif field.message_type is not None:
            result[key] = _message_to_mapping(value, json_names=json_names)
        elif field.enum_type is not None:
            result[key] = _enum_domain(field.enum_type, value)
        else:
            result[key] = value
    return result


def _message_class(field: FieldDescriptor) -> type[Message]:
    return GetMessageClass(field.message_type)


def _is_map(field: FieldDescriptor) -> bool:
    return bool(field.message_type and field.message_type.GetOptions().map_entry)


def _enum_number(descriptor: EnumDescriptor, value: Any) -> int:
    if isinstance(value, int):
        if value not in descriptor.values_by_number:
            raise ValueError(f"Unknown {descriptor.name} number {value}.")
        return value
    normalized = str(value).strip().lower()
    for candidate in descriptor.values:
        if _enum_domain(descriptor, candidate.number) == normalized:
            return candidate.number
    raise ValueError(f"Unknown {descriptor.name} value {value!r}.")


def _enum_domain(descriptor: EnumDescriptor, number: int) -> str:
    candidate = descriptor.values_by_number.get(number)
    if candidate is None:
        raise ValueError(f"Unknown {descriptor.name} number {number}.")
    prefix = _upper_snake(descriptor.name) + "_"
    name = candidate.name
    return name.removeprefix(prefix).lower()


def _upper_snake(value: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", value).upper()
