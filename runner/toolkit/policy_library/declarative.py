"""Authoring contract shared by bundled and imported Policy source packages.

The compiler emits the catalog consumed by Controller and Runner. Colang and
Action names belong to the registered detector adapter, never to Policy authors.
"""
from __future__ import annotations

from copy import deepcopy
import json
import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
import yaml

from ..runtime.enforcement_action_generated import ENFORCEMENT_ACTIONS, EnforcementAction
from .pattern_validation import parse_pattern_validators


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class DetectorReference(StrictModel):
    ref: str = Field(min_length=1)
    version: str = Field(min_length=1)
    parameters: dict[str, Any] = Field(default_factory=dict)


class Handling(StrictModel):
    action: EnforcementAction
    replacement: str | None = None

    @field_validator("action")
    @classmethod
    def known_action(cls, value: str) -> str:
        if value not in ENFORCEMENT_ACTIONS:
            raise ValueError(f"Unknown handling action {value}")
        return value


class RuleMetadata(StrictModel):
    taxonomy_ids: list[str] = Field(min_length=1)

    @field_validator("taxonomy_ids")
    @classmethod
    def taxonomy(cls, value: list[str]) -> list[str]:
        if any(not re.fullmatch(r"TALI(?:-[A-Z0-9]+)+", item) for item in value):
            raise ValueError("Invalid taxonomy ID")
        return value


class RuntimeIdentity(StrictModel):
    binding_id: str = Field(min_length=1)
    implementation_rule_id: str = Field(min_length=1)


class DiscoveryTag(StrictModel):
    namespace: Literal["protection", "guardrail_category", "collection", "domain", "framework", "implementation", "jurisdiction", "rail"]
    value: str = Field(min_length=1)
    label: str = Field(min_length=1)
    source: Literal["declared", "derived"] = "declared"


class RuleDefinition(StrictModel):
    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    description: str = ""
    stages: list[Literal["input", "output"]] = Field(min_length=1)
    detector: DetectorReference
    on_match: Handling
    risk_level: Literal["critical", "high", "medium", "low", "informational"]
    metadata: RuleMetadata
    expand: dict[str, str] | None = None
    # Existing built-in provenance is retained for stable signed versions.
    # New imported definitions derive these identities from Policy/Rule IDs.
    runtime_adapter: RuntimeIdentity | None = None

    @field_validator("stages")
    @classmethod
    def unique_stages(cls, value: list[str]) -> list[str]:
        if len(set(value)) != len(value):
            raise ValueError("Duplicate check stages")
        return value


class PolicyMetadata(StrictModel):
    id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$", max_length=160)
    name: str = Field(min_length=1, max_length=160)
    description: str = ""
    source: Literal["built_in", "custom"]
    version: str = Field(min_length=1)
    tags: list[DiscoveryTag]
    safety_level: Literal["balanced", "strict"] = "balanced"
    output_delivery: Literal["interruptible", "window_buffered", "full_buffered"] = "window_buffered"
    compliance: dict[str, Any] | None = None


class ParameterDefinition(StrictModel):
    name: str = Field(pattern=r"^[A-Za-z_][A-Za-z0-9_]*$")
    label: str = ""
    kind: str = Field(min_length=1)
    required: bool
    placeholder: str = ""
    description: str = ""
    default: str | None = None


class TestDefinition(StrictModel):
    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    description: str = ""
    phase: Literal["input", "output"]
    content: str = Field(min_length=1)
    expected_decision: Literal["allow", "block", "transform", "intervene"]
    covered_rule_ids: list[str]
    kind: Literal["rule_acceptance", "scenario"] = "scenario"
    required: bool = True
    parameter_names: list[str] = Field(default_factory=list)
    group: str = "General"
    expected_text: str | None = None
    expected_matched_rules: list[str] | None = None
    scope: Literal["rule", "policy"] = "policy"


class ExecutionDefinition(StrictModel):
    mode: Literal["sequential"] = "sequential"
    input: Literal["previous_output"] = "previous_output"
    stop_on: Literal["block"] = "block"


class PolicyDefinition(StrictModel):
    schema_version: Literal[1]
    kind: Literal["Policy"]
    metadata: PolicyMetadata
    parameters: list[ParameterDefinition] = Field(default_factory=list)
    rules: list[RuleDefinition] = Field(min_length=1)
    tests: list[TestDefinition] = Field(default_factory=list)
    execution: ExecutionDefinition = Field(default_factory=ExecutionDefinition)

    @model_validator(mode="after")
    def references(self) -> PolicyDefinition:
        ids = [rule.id for rule in self.rules]
        if len(ids) != len(set(ids)):
            raise ValueError("Rule IDs must be unique within a Policy")
        parameters = [item.name for item in self.parameters]
        if len(parameters) != len(set(parameters)):
            raise ValueError("Parameter names must be unique")
        tests = [test.id for test in self.tests]
        if len(tests) != len(set(tests)):
            raise ValueError("Test IDs must be unique")
        by_id = {rule.id: rule for rule in self.rules}
        for test in self.tests:
            if test.scope == "rule" and not test.covered_rule_ids:
                raise ValueError(f"Rule test {test.id} must select covered_rule_ids")
            if set(test.covered_rule_ids) - by_id.keys():
                raise ValueError(f"Test {test.id} references unknown Rules")
            if any(test.phase not in by_id[id].stages for id in test.covered_rule_ids):
                raise ValueError(f"Test {test.id} targets an unsupported Rule stage")
            if set(test.parameter_names) - set(parameters):
                raise ValueError(f"Test {test.id} references unknown Policy parameters")
            if test.expected_matched_rules is not None and set(test.expected_matched_rules) - by_id.keys():
                raise ValueError(f"Test {test.id} expects unknown Rules")
        for rule in self.rules:
            for stage in rule.stages:
                if not any(test.required and test.kind == "rule_acceptance" and test.phase == stage and rule.id in test.covered_rule_ids for test in self.tests):
                    raise ValueError(f"Rule {rule.id} requires an acceptance test for {stage}")
        if self.metadata.source == "custom":
            if self.metadata.compliance is not None or any(rule.runtime_adapter for rule in self.rules):
                raise ValueError("Custom packages cannot claim built-in provenance or compliance review")
            if any(item.kind == "secret" and item.default is not None for item in self.parameters):
                raise ValueError("Secret parameter defaults cannot be transported")
        return self


def parse_yaml(raw: str) -> Any:
    """Safe YAML/JSON parsing; duplicate keys are errors, not silent overrides."""
    class UniqueLoader(yaml.SafeLoader):
        pass

    def mapping(loader: yaml.SafeLoader, node: yaml.MappingNode, deep: bool = False):
        result = {}
        for key_node, value_node in node.value:
            key = loader.construct_object(key_node, deep=deep)
            if not isinstance(key, str) or key in result:
                raise ValueError(f"Invalid or duplicate YAML key {key!r}")
            result[key] = loader.construct_object(value_node, deep=deep)
        return result

    UniqueLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, mapping)
    if len(raw.encode()) > 2_000_000:
        raise ValueError("Policy source exceeds 2 MB")
    if any(isinstance(token, yaml.tokens.AliasToken) for token in yaml.scan(raw)):
        raise ValueError("YAML aliases are not supported in Policy packages")
    value = yaml.load(raw, Loader=UniqueLoader)
    json.dumps(value, allow_nan=False)
    return value


def compile_policy(definition: PolicyDefinition, registry: dict[str, Any]) -> dict[str, Any]:
    """Resolve registered adapters into the existing executable Rule contract."""
    if registry.get("schema_version") != 2:
        raise ValueError("Unknown detector registry schema")
    bundled = definition.metadata.source == "built_in"
    if not bundled:
        from .protection import protection_contracts
        if definition.metadata.id in protection_contracts()["nativePolicies"]:
            raise ValueError("Custom Policies cannot claim a platform-native Policy ID")
    result = definition.metadata.model_dump(exclude_unset=bundled, exclude={"compliance"} if definition.metadata.compliance is None else set())
    result["parameters"] = [item.model_dump(exclude_unset=bundled) for item in definition.parameters]
    result["test_cases"] = [item.model_dump(exclude_unset=bundled, exclude={"expected_text", "expected_matched_rules", "scope"}) for item in definition.tests]
    result["rules"] = []
    for rule in definition.rules:
        detector = registry["detectors"].get(rule.detector.ref)
        if detector is None or detector["version"] != rule.detector.version:
            raise ValueError(f"Rule {rule.id}: registered detector/version unavailable: {rule.detector.ref}@{rule.detector.version}")
        params = deepcopy(rule.detector.parameters)
        unknown = set(params) - set(detector["parameters"])
        if unknown:
            raise ValueError(f"Rule {rule.id}: unknown detector parameters {sorted(unknown)}")
        if "profiles" in detector:
            profile = params.pop("profile", None)
            if not isinstance(profile, str) or profile not in detector["profiles"]:
                raise ValueError(f"Rule {rule.id}: unknown classifier profile {profile!r}")
            detector = {**detector, "adapter": deepcopy(detector["profiles"][profile]), "required_parameters": []}
            params["detector_options"] = {"profile": profile}
        if not bundled:
            validate_custom_detector(definition, rule, detector, params)
        validate_detector_parameters(rule, detector, params)
        adapter = deepcopy(detector["adapter"])
        identity = rule.runtime_adapter.model_dump() if rule.runtime_adapter else {
            "binding_id": definition.metadata.id, "implementation_rule_id": rule.id,
        }
        compiled = {
            "id": rule.id, "name": rule.name, "description": rule.description,
            "detector": {"ref": rule.detector.ref, "version": rule.detector.version}, "effect": rule.on_match.action,
            "risk_severity": rule.risk_level, "rails": rule.stages,
            "implementation": {**adapter, **identity},
            **params, **rule.metadata.model_dump(),
        }
        if rule.expand:
            required = {"parameter", "text_field", "action_field", "replacement_field"}
            if set(rule.expand) != required or rule.expand["parameter"] not in {p.name for p in definition.parameters}:
                raise ValueError("Rule expansion must reference a declared entry parameter")
            if (rule.expand["text_field"], rule.expand["action_field"], rule.expand["replacement_field"]) != ("phrase", "action", "replacement"):
                raise ValueError("Rule entries require phrase, action and replacement fields")
            if adapter["detector"] != "keyword":
                raise ValueError("Rule entry expansion requires a keyword detector")
            compiled["rule_expansion"] = rule.expand
        if "replacement" in rule.on_match.model_fields_set:
            compiled["redaction"] = rule.on_match.replacement
        result["rules"].append(compiled)
    # Authoring and catalog loading must enforce the same taxonomy, discovery,
    # parameter and acceptance-coverage contract.
    from .loader import _policy
    from .registry import PolicyLibraryRegistry
    PolicyLibraryRegistry((_policy(result),))
    return result


def validate_custom_detector(definition: PolicyDefinition, rule: RuleDefinition, detector: dict, params: dict) -> None:
    """Refuse authoring features that the existing executable adapter ignores."""
    adapter = detector["adapter"]
    if adapter["execution"] != "local":
        raise ValueError("Custom model-backed detector registration is not available in this iteration")
    if "replacement" in rule.on_match.model_fields_set and not (rule.on_match.action == "transform"):
        raise ValueError(f"Rule {rule.id}: this detector/action does not accept replacement text")
    if adapter["detector"] == "keyword" and not (rule.expand or params.get("keywords") or params.get("detector_options", {}).get("terms")):
        raise ValueError(f"Rule {rule.id}: keyword detection requires keywords")


def validate_detector_parameters(rule: RuleDefinition, detector: dict, params: dict) -> None:
    from .conditions import validate_conditions, validate_terms
    options = params.get("detector_options", {})
    if not isinstance(options, dict):
        raise ValueError("Detector options must be an object")
    kind = detector["adapter"]["detector"]
    if kind == "conditions":
        validate_conditions(options)
    elif kind == "keyword" and options:
        if set(options) - {"terms", "literal"} or "terms" not in options or ("literal" in options and type(options["literal"]) is not bool):
            raise ValueError("Keyword detector accepts only terms")
        validate_terms(options["terms"])
    elif kind == "code_block":
        if set(options) - {"languages", "minimum_score", "require_context", "require_terms", "exclude_terms"}:
            raise ValueError("Unknown code detector option")
        for key in ("require_terms", "exclude_terms"):
            if not isinstance(options.get(key, []), list) or not all(isinstance(x, str) for x in options.get(key, [])):
                raise ValueError("Code context terms must be strings")
    for name in detector["required_parameters"]:
        if not params.get(name):
            raise ValueError(f"Rule {rule.id}: detector requires {name}")
    strings = {"expression", "context_expression", "severity_threshold"}
    lists = {"identifiers", "conditions", "exceptions", "phrase_patterns"}
    pairs = {"keywords", "always_block"}
    for key, value in params.items():
        valid = True
        if key == "validators":
            params[key] = list(parse_pattern_validators(value))
        elif key in strings:
            valid = value is None or isinstance(value, str)
        elif key in lists:
            valid = isinstance(value, list) and all(isinstance(item, str) for item in value)
        elif key in pairs:
            valid = isinstance(value, list) and all(isinstance(item, list) and len(item) == 2 and all(isinstance(part, str) for part in item) for item in value)
        elif key == "allow_word_numbers":
            valid = isinstance(value, bool)
        elif key == "context_max_gap_words":
            valid = value is None or (type(value) is int and value >= 0)
        if not valid:
            raise ValueError(f"Rule {rule.id}: invalid {key}")
    try:
        for key in ("expression", "context_expression"):
            if params.get(key):
                re.compile(params[key])
        for expression in params.get("phrase_patterns", ()):
            re.compile(expression)
    except re.error as error:
        raise ValueError(f"Rule {rule.id}: invalid regular expression: {error}") from error
    if rule.on_match.action == "transform" and detector["adapter"]["execution"] == "local" and rule.on_match.replacement is None:
        raise ValueError(f"Rule {rule.id}: transform requires replacement text")
