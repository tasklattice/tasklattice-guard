"""Each current local detector has one owner; reviewed within-Policy aliases are explicit."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from runner.toolkit.policy_library.package import load_package

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / 'tests/fixtures'
ALIASES = json.loads((FIXTURES / 'policy-rule-aliases.json').read_text())


def signature(rule: dict) -> str:
    contract = {k: v for k, v in rule.items()
                if k not in ('id', 'name', 'description', 'runtime_adapter', 'stages')}
    return hashlib.sha256(json.dumps(contract, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def catalog():
    return {p.parent.name: load_package(p.parent).definition.model_dump(mode='json', exclude_none=True)
            for p in (ROOT / 'policies/builtin').glob('*/policy.yaml')}


def test_local_rules_have_one_canonical_owner():
    owners = {}
    aliases = {(item['policy'], frozenset(item['rules'])): item
               for item in ALIASES}
    seen_aliases = set()
    for pid, policy in catalog().items():
        for rule in policy['rules']:
            if not rule['detector']['ref'].startswith(('text/', 'code/')) or policy['parameters']:
                continue
            key = signature(rule)
            if key in owners:
                owner, original = owners[key]
                alias_key = (pid, frozenset((original, rule['id'])))
                # Versioned repairs may converge two established IDs within
                # one Policy. Only explicitly audited aliases are permitted.
                assert owner == pid and alias_key in aliases, ((pid, rule['id']), owners[key])
                alias = aliases[alias_key]
                assert alias['version'] == policy['metadata']['version']
                assert alias['sha256'] == key
                seen_aliases.add(alias_key)
            owners[key] = (pid, rule['id'])
    assert seen_aliases == aliases.keys()
