"""Bounded integer-constraint proof API backed by Z3, with no generated verdicts."""
from __future__ import annotations

from contextlib import asynccontextmanager
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
from typing import Annotated, Literal

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field, StrictInt
import z3


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Claim(StrictModel):
    variable: str = Field(pattern=r"^[a-z][a-z0-9_]{0,63}$")
    operator: Literal["eq", "ne", "lt", "le", "gt", "ge"]
    value: StrictInt = Field(ge=-1_000_000, le=1_000_000)


class Rule(Claim):
    id: str = Field(min_length=1, max_length=128)
    description: str = Field(default="", max_length=1000)


class Domain(StrictModel):
    minimum: StrictInt = Field(ge=-1_000_000, le=1_000_000)
    maximum: StrictInt = Field(ge=-1_000_000, le=1_000_000)


class Policy(StrictModel):
    id: str = Field(min_length=1, max_length=256)
    version: str = Field(min_length=1, max_length=100)
    variables: dict[str, Domain] = Field(min_length=1, max_length=32)
    rules: list[Rule] = Field(min_length=1, max_length=100)


class Catalog(StrictModel):
    policies: list[Policy] = Field(min_length=1, max_length=100)


class PolicyRef(StrictModel):
    id: str = Field(min_length=1, max_length=256)
    version: str = Field(min_length=1, max_length=100)


class Evaluation(StrictModel):
    policy: PolicyRef
    query_content: str = Field(min_length=1, max_length=10_000)
    guard_content: str = Field(min_length=1, max_length=10_000)
    confidence_threshold: float = Field(ge=0, le=1)


class Claims(StrictModel):
    claims: list[Claim] = Field(min_length=1, max_length=32)


def translate(text: str, policy: Policy) -> list[Claim] | None:
    # A deliberately narrow grammar avoids pretending to prove arbitrary prose.
    if text.lstrip().startswith("{"):
        try:
            claims = Claims.model_validate_json(text).claims
        except ValueError:
            return None
    else:
        match = re.fullmatch(r"The (?:product )?warranty lasts (one|two|three|five|ten|[0-9]{1,3}) years?\.", text.strip(), re.IGNORECASE)
        if match is None:
            return None
        word = match.group(1).lower()
        number = {"one": 1, "two": 2, "three": 3, "five": 5, "ten": 10}.get(word)
        claims = [Claim(variable="warranty_years", operator="eq", value=int(word) if number is None else number)]
    return claims if all(claim.variable in policy.variables for claim in claims) else None


def expression(claim: Claim, variables):
    left, right = variables[claim.variable], claim.value
    return {"eq": lambda: left == right, "ne": lambda: left != right, "lt": lambda: left < right,
            "le": lambda: left <= right, "gt": lambda: left > right, "ge": lambda: left >= right}[claim.operator]()


def prove(policy: Policy, request: Evaluation) -> dict:
    claims = translate(request.guard_content, policy)
    if claims is None:
        return {"findings": [{"id": "translation", "result": "no_translations", "confidence": 0.0,
            "message": "The complete response must match the supported claim grammar; no proof was attempted.",
            "translation": {"premises": [], "claims": [], "untranslated": [request.guard_content]}}]}
    # Separate contexts allow concurrent HTTP workers without sharing Z3 objects.
    ctx = z3.Context()
    variables = {name: z3.Int(name, ctx) for name in policy.variables}
    solver = z3.Solver(ctx=ctx); solver.set(timeout=2000, rlimit=100_000)
    for name, domain in policy.variables.items():
        solver.add(variables[name] >= domain.minimum, variables[name] <= domain.maximum)
    for index, rule in enumerate(policy.rules):
        solver.assert_and_track(expression(rule, variables), z3.Bool(f"rule_{index}", ctx))
    translated = [str(expression(claim, variables)) for claim in claims]
    finding = {"id": "proof-1", "result": "too_complex", "confidence": 0.0,
        "translation": {"premises": [str(expression(rule, variables)) for rule in policy.rules], "claims": translated, "untranslated": []}}
    consistent = solver.check()
    if consistent == z3.unsat:
        finding.update(result="impossible", confidence=1.0, message="The policy constraints are inconsistent.")
    elif consistent == z3.sat:
        claim = z3.And(*[expression(item, variables) for item in claims])
        solver.push(); solver.add(z3.Not(claim)); entailed = solver.check()
        supporting = {str(item) for item in solver.unsat_core()} if entailed == z3.unsat else set()
        counterexample = {name: str(solver.model().eval(value, model_completion=True)) for name, value in variables.items()} if entailed == z3.sat else None
        solver.pop()
        if entailed == z3.unsat:
            finding.update(result="valid", confidence=1.0, message="Z3 proved policy AND NOT claims is unsatisfiable.",
                supporting_rules=[{"id": rule.id, "expression": str(expression(rule, variables)), "description": rule.description} for index, rule in enumerate(policy.rules) if f"rule_{index}" in supporting])
        elif entailed == z3.sat:
            solver.push(); solver.add(claim); compatible = solver.check()
            if compatible == z3.unsat:
                core = {str(item) for item in solver.unsat_core()}
                finding.update(result="invalid", confidence=1.0, message="Z3 proved policy AND claims is unsatisfiable.",
                    contradicting_rules=[{"id": rule.id, "expression": str(expression(rule, variables)), "description": rule.description} for index, rule in enumerate(policy.rules) if f"rule_{index}" in core])
            elif compatible == z3.sat:
                finding.update(result="satisfiable", confidence=1.0, message="The claims are possible but not entailed by the policy.")
            solver.pop()
            if counterexample:
                finding["claims_false_scenario"] = {"variable_values": counterexample}
    canonical = json.dumps(policy.model_dump(), sort_keys=True, separators=(",", ":"))
    return {"findings": [finding], "solver": {"name": "Z3", "version": z3.get_version_string(), "policy_sha256": hashlib.sha256(canonical.encode()).hexdigest()}}


def create_app(*, api_key: str | None = None, policy_path: Path | None = None) -> FastAPI:
    token = api_key if api_key is not None else os.environ.get("FORMAL_SERVICE_API_KEY", "")
    path = policy_path or Path(os.environ.get("FORMAL_SERVICE_POLICIES", Path(__file__).with_name("policies.json")))
    catalog = Catalog.model_validate_json(path.read_text())
    policies = {(policy.id, policy.version): policy for policy in catalog.policies}
    if len(policies) != len(catalog.policies): raise ValueError("Formal policy identities must be unique.")
    for policy in policies.values():
        if len({rule.id for rule in policy.rules}) != len(policy.rules): raise ValueError("Rule IDs must be unique.")
        if any(rule.variable not in policy.variables for rule in policy.rules): raise ValueError("Unknown rule variable.")
        if any(not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", name) or domain.minimum > domain.maximum for name, domain in policy.variables.items()): raise ValueError("Invalid variable domain.")

    @asynccontextmanager
    async def lifespan(_):
        if not token: raise RuntimeError("Set FORMAL_SERVICE_API_KEY before starting the proof service.")
        yield

    app = FastAPI(title="TaskLattice formal proof service", lifespan=lifespan)
    def authenticated(authorization: Annotated[str | None, Header()] = None):
        if not token or not hmac.compare_digest(authorization or "", f"Bearer {token}"):
            raise HTTPException(status_code=401, detail="Invalid proof service credential.")

    @app.get("/evaluate", dependencies=[Depends(authenticated)])
    def health():
        return {"protocol": "tali.automated-reasoning.v1", "ready": True, "solver": "Z3", "policies": [{"id": p.id, "version": p.version} for p in policies.values()]}

    @app.post("/evaluate", dependencies=[Depends(authenticated)])
    def evaluate(request: Evaluation):
        policy = policies.get((request.policy.id, request.policy.version))
        if policy is None: raise HTTPException(status_code=404, detail="Formal policy version is unavailable.")
        if not request.query_content.strip(): raise HTTPException(status_code=422, detail="A query is required.")
        return prove(policy, request)
    return app
