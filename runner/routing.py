"""Deterministic composed routing; selection never falls back after assignment."""
from __future__ import annotations

import hmac
import json
import re
import uuid
from datetime import UTC, datetime
from typing import Any

from .protocol_codec import traffic_scope_from_proto

SELECTOR_FIELDS = set("protocol endpoint.id auth.principal model output.sink output.content_type output.schema_id tool.name target.environment litellm.api_key_alias litellm.team_id litellm.user_id a2a.version a2a.extensions a2a.operation a2a.context_id a2a.task_id http.method http.host http.path http.header auth.jwt_claim adapter.field".split())
CUSTOM_FIELDS = {"http.header", "auth.jwt_claim", "adapter.field"}
SENSITIVE_HEADERS = {"authorization", "cookie", "proxy-authorization", "x-api-key"}


class RoutingError(RuntimeError):
    def __init__(self, reason: str, assignment: dict[str, Any] | None = None):
        super().__init__(reason)
        self.reason = reason
        self.assignment = assignment


def _fold(value: str) -> str:
    return value.translate(str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"))


def _glob(pattern: str, value: str) -> bool:
    tokens = []
    escaped = False
    for c in pattern:
        if not escaped and c == "\\":
            escaped = True
            continue
        token = ("literal", c) if escaped or c not in "*?" else (c, "")
        if token != ("*", "") or not tokens or tokens[-1] != token: tokens.append(token)
        escaped = False
    if escaped: tokens.append(("literal", "\\"))
    previous = [True] + [False] * len(tokens)
    for j, (kind, _) in enumerate(tokens, 1): previous[j] = kind == "*" and previous[j-1]
    for c in value:
        next_row = [False] * (len(tokens)+1)
        for j, (kind, literal) in enumerate(tokens, 1):
            next_row[j] = next_row[j-1] or previous[j] if kind == "*" else previous[j-1] and (kind == "?" or literal == c)
        previous = next_row
    return previous[-1]


def condition_matches(c: dict, context) -> bool:
    field, key, operator = c["field"], c.get("key", ""), c["operator"]
    if field.startswith("http."):
        source = c.get("request_source", c.get("requestSource"))
        if source not in {"endpoint_request", "business_request"}:
            raise RoutingError("selector_expression_error")
        values_by_key = getattr(context, source)
        if values_by_key is None:
            return False
        lookup = key.lower() if field == "http.header" else ":" + field[5:]
        values = [v for k, v in values_by_key if k.lower() == lookup]
    else:
        value = context.protocol if field == "protocol" else context.endpoint_id if field == "endpoint.id" else context.value("jwt_claim", key) if field == "auth.jwt_claim" else context.value("field", key if field == "adapter.field" else field)
        values = [] if value is None else [value]
    if operator == "exists":
        return bool(values)
    if operator == "not_exists":
        return not values
    if not values:
        return False
    raw = c.get("values", c.get("value", "")) if operator in {"in", "not_in"} else c.get("value", "")
    expected = raw if isinstance(raw, list) else [raw]
    if c.get("case_sensitive", c.get("caseSensitive", True)) is False:
        values, expected = list(map(_fold, values)), list(map(_fold, expected))
    def positive(v):
        if operator == "contains": return expected[0] in v
        if operator == "starts_with": return v.startswith(expected[0])
        if operator == "glob": return _glob(expected[0], v)
        return v in expected
    return all(not positive(v) for v in values) if operator in {"not_equals", "not_in"} else any(positive(v) for v in values)


def selector_matches(scope: dict, context) -> bool:
    # Evaluate every leaf in the selected Route: malformed sources must not be
    # hidden by an earlier false AND/true OR operand.
    results = [selector_matches(c, context) if "conditions" in c else condition_matches(c, context) for c in scope["conditions"]]
    return all(results) if scope["combinator"] == "and" else any(results)


def validate_router(router, artifacts: dict) -> None:
    if router.revision < 1 or router.assignment_algorithm != "hmac-sha256-v1" or not router.assignment_key_id or len(router.assignment_key) < 32:
        raise ValueError("Router requires a revision and versioned HMAC key of at least 32 bytes.")
    if not router.router_id or len(router.routes) > 128: raise ValueError("Invalid Router identity or size.")
    ids, fallbacks = set(), 0
    for index, route in enumerate(router.routes):
        if not route.route_id or route.route_id in ids: raise ValueError("Duplicate or empty Route ID.")
        ids.add(route.route_id)
        scope = traffic_scope_from_proto(route.traffic_scope)
        if route.kind == "fallback":
            fallbacks += 1
            if index != len(router.routes)-1 or not route.enabled or scope["conditions"] or scope["combinator"] != "and" or not route.all_endpoints:
                raise ValueError("Fallback must be enabled, unconditional and last.")
        elif route.kind != "normal" or not scope["conditions"]:
            raise ValueError("Normal Routes require a selector.")
        leaves = []
        def visit(group, depth=1):
            if depth > 3 or group["combinator"] not in {"and", "or"}: raise ValueError("Invalid selector group.")
            if not group["conditions"] and route.kind != "fallback": raise ValueError("Empty selector group.")
            for c in group["conditions"]:
                if "conditions" in c: visit(c, depth+1); continue
                leaves.append(c)
                field, key = c["field"], c.get("key", "")
                if field not in SELECTOR_FIELDS: raise ValueError("Unknown selector field.")
                if field in CUSTOM_FIELDS:
                    if not key.strip() or len(key) > 160 or key in {"__proto__", "constructor", "prototype"}: raise ValueError("Invalid selector key.")
                elif key: raise ValueError("Scalar fields cannot have a key.")
                if not field.startswith("http.") and c.get("request_source"): raise ValueError("Non-HTTP field cannot have a request source.")
                if len(c.get("value", "")) > 2048 or len(c.get("values", [])) > 64 or any(len(v) > 2048 for v in c.get("values", [])): raise ValueError("Selector operands exceed limits.")
                if c["operator"] not in {"in", "not_in"} and c.get("values"): raise ValueError("Scalar operator cannot use operand list.")
                if c["operator"] not in {"equals","not_equals","in","not_in","contains","starts_with","glob","exists","not_exists"}: raise ValueError("Unknown selector operator.")
                if c["field"].startswith("http.") and c.get("request_source") not in {"endpoint_request","business_request"}: raise ValueError("HTTP selector requires explicit source.")
                if c["field"] == "http.header" and (not re.fullmatch(r"[!#$%&'*+.^_`|~0-9a-z-]+", c.get("key", ""), re.I) or c["key"].lower() in SENSITIVE_HEADERS): raise ValueError("Invalid or credential header.")
                if c["operator"] in {"in","not_in"} and not c.get("values"): raise ValueError("Membership requires operands.")
        visit(scope)
        if len(leaves)>16: raise ValueError("Too many selector conditions.")
        if len(route.targets) > 32: raise ValueError("Too many targets.")
        if not route.targets or sum(t.weight_bps for t in route.targets) != 10000: raise ValueError("Target weights must total 10000.")
        targets, refs = set(), set()
        for t in route.targets:
            if not t.target_id or t.target_id in targets or (t.guardrail_id,t.guardrail_version) in refs or not 0 <= t.weight_bps <= 10000: raise ValueError("Invalid or duplicate target.")
            targets.add(t.target_id); refs.add((t.guardrail_id,t.guardrail_version))
            if not t.guardrail_id or not t.guardrail_version.strip() or t.guardrail_version.lower() == "latest": raise ValueError("Target version must be fixed.")
            if t.weight_bps:
                a = artifacts.get(t.artifact_id)
                if a is None or (a.plan.guardrail_id,a.plan.guardrail_version) != (t.guardrail_id,t.guardrail_version): raise ValueError("Target artifact/version is unavailable.")
    if fallbacks != 1: raise ValueError("Router requires exactly one fallback.")


def select(router, context):
    assignment = {"decisionId": str(uuid.uuid4()), "routerId": router.router_id, "routerRevision": int(router.revision), "endpointId": context.endpoint_id, "decisionAt": datetime.now(UTC).isoformat(), "assignmentStatus": "unassigned"}
    try:
        validate_input(context)
        for route in router.routes:
            if not route.enabled or (not route.all_endpoints and context.endpoint_id not in route.endpoint_ids): continue
            if not selector_matches(traffic_scope_from_proto(route.traffic_scope), context): continue
            assignment["routeId"] = route.route_id
            # Secret hash prevents clients predicting targets by selecting call IDs.
            data = json.dumps([context.call_id or assignment["decisionId"], int(router.revision), route.route_id], ensure_ascii=False, separators=(",", ":")).encode()
            bucket = int.from_bytes(hmac.digest(router.assignment_key, data, "sha256"), "big") % 10000
            for target in route.targets:
                if bucket < target.weight_bps:
                    assignment.update(targetId=target.target_id, guardrailId=target.guardrail_id, guardrailVersion=target.guardrail_version, assignmentStatus="assigned")
                    return target, assignment
                bucket -= target.weight_bps
            raise RoutingError("route_assignment_failed")
        raise RoutingError("route_assignment_failed")
    except RoutingError as error:
        error.assignment = {**assignment, "failureReason": error.reason}
        raise


def validate_input(context):
    if not isinstance(context.endpoint_id, str) or not 1 <= len(context.endpoint_id) <= 128:
        raise RoutingError("routing_input_error")
    size = len(context.endpoint_id)
    for pairs, http in ((context.fields, False), (context.endpoint_request, True), (context.business_request, True)):
        if pairs is None: continue
        counts = {}
        for key, value in pairs:
            if not isinstance(key, str) or not 1 <= len(key) <= 160 or key in {"__proto__", "constructor", "prototype"} or not isinstance(value, str) or len(value) > 2048:
                raise RoutingError("routing_input_error")
            if http and key not in {":method", ":host", ":path"} and not re.fullmatch(r"[!#$%&'*+.^_`|~0-9a-z-]+", key, re.I): raise RoutingError("routing_input_error")
            name = key.lower() if http else key
            counts[name] = counts.get(name, 0) + 1
            if counts[name] > 64 or len(counts) > 128: raise RoutingError("routing_input_error")
            size += (len(key) if counts[name] == 1 else 0) + len(value)
    if size > 65536: raise RoutingError("routing_input_error")
