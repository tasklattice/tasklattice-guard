#!/usr/bin/env python3
"""Compile the approved 20-Policy target catalog into a standalone asset."""
from __future__ import annotations

import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from runner.toolkit.policy_library.declarative import compile_policy
from runner.toolkit.policy_library.package import load_package
from runner.toolkit.policy_library.rules import RuleRegistry
from scripts.policy_sources import registry

ASSETS = ROOT / "runner/toolkit/policy_library/assets_target"


def build() -> Path:
    shared = RuleRegistry.load(ROOT / "policies/rules")
    policies = []
    for path in sorted((ROOT / "policies/target").glob("*/policy.yaml")):
        package = load_package(path.parent, shared)
        compiled = compile_policy(package.definition, registry())
        compiled["rails"] = sorted({rail for rule in compiled["rules"] for rail in rule["rails"]})
        policies.append(compiled)
    output = ASSETS / "target_policies.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(policies, ensure_ascii=False, indent=2) + "\n")
    return output


if __name__ == "__main__":
    print(build())
