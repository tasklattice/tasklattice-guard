"""Offline action contract: real Controller compilation -> NeMo -> local detectors.

The oracle is the public action contract, not the compiler's generated order.
No model, server, credentials, labels or deployed configuration are involved.
"""
from itertools import product
import json
from pathlib import Path
import subprocess

import pytest

from runner.compiler import DefaultRunnerCompiler
from runner.draft_preview import DraftPreviewRuntime
from runner.toolkit.nemo.action_registry import action_providers
from runner.toolkit.nemo.actions.content_filter import ContentFilterActionProvider
from runner.toolkit.runtime.contracts import ProtectionRequest, RequestContext


ACTIONS = ("block", "transform", "allow")
WORDS = ("alpha", "beta", "gamma")
SEQUENCES = [sequence for length in (2, 3) for sequence in product(ACTIONS, repeat=length)]
CASES = [(sequence, hits) for sequence in SEQUENCES for hits in product((False, True), repeat=len(sequence))]


@pytest.fixture(scope="module")
def composition_plans():
    # Use the production declarative compiler and plan builder, rather than
    # manually constructing an already-sorted execution plan in Python.
    source = r"""
      import { DeclarativeCompiler } from './server/policy-studio/declarative.ts';
      import { buildGuardrailPlan } from './server/domain/guardrail-plan.ts';
      const sequences = JSON.parse(process.argv[1]);
      const compiler = new DeclarativeCompiler('../runner/toolkit/policy_library/assets');
      const template = compiler.shipped('keyword-blocking');
      const words = ['alpha', 'beta', 'gamma'];
      const entries = [];
      for (const actions of sequences) for (const layout of ['same-policy', 'cross-policy']) {
        const groups = layout === 'same-policy' ? [actions.map((_, i) => i)] : actions.map((_, i) => [i]);
        const policies = groups.map((indexes, group) => {
          const definition = structuredClone(template);
          definition.metadata.id = `matrix-${group}`;
          definition.metadata.version = '1.0.0';
          definition.parameters = [];
          delete definition.testing;
          definition.rules = indexes.map(i => ({ ...structuredClone(template.rules[0]),
            id: `r${i}`, name: `Synthetic ${i}`, stages: ['input', 'output'],
            detector: { ref: 'text/keyword', version: '1.0.0', parameters: { keywords: [[words[i], 'low']] } },
            on_match: { action: actions[i], replacement: `[MASK_${i}]` }, runtime_adapter: undefined,
          }));
          definition.tests = indexes.flatMap(i => ['input', 'output'].map(phase => ({
            id: `case-${i}-${phase}`, name: `Synthetic ${i}`, description: '', phase,
            content: words[i], expected_decision: actions[i], covered_rule_ids: [`r${i}`],
            kind: 'rule_acceptance', scope: 'rule', required: true, parameter_names: [], group: 'Matrix',
          })));
          return compiler.compile(definition);
        });
        for (const phase of ['input', 'output']) {
          const draft = { allowedTopics: [], restrictedTopics: [], safetyLevel: 'balanced', outputDelivery: 'full_buffered',
            policyBindings: policies.map(p => ({ policyId: p.id, policyVersion: p.version,
              parameterValues: {}, enabledRuleIds: p.rules.map(r => r.id),
              ruleOrder: p.rules.map(r => r.id), ruleActions: {}, enabledRails: [phase], reasoningPolicy: null })) };
          const before = JSON.stringify({ policies, draft });
          const plan = buildGuardrailPlan({ guardrailId: 'matrix', guardrailVersion: '20261023-000000.001Z', policies, draft });
          if (JSON.stringify({ policies, draft }) !== before) throw new Error('Compilation mutated source definitions');
          entries.push([`${actions.join(',')}:${layout}:${phase}`, plan]);
        }
      }
      console.log(JSON.stringify(Object.fromEntries(entries)));
    """
    result = subprocess.run(
        ["node", "--import", "tsx", "--input-type=module", "-e", source, json.dumps(SEQUENCES)],
        cwd=Path(__file__).resolve().parents[2] / "controller",
        capture_output=True, text=True, check=True, timeout=30,
    )
    return json.loads(result.stdout)


class RecordedLocalChecks(ContentFilterActionProvider):
    def __init__(self):
        super().__init__()
        self.calls = []

    async def execute(self, request):
        enabled = json.loads(dict(request.parameters)["enabled_rules_json"])
        ids = [rule for rules in enabled.values() for rule in rules]
        assert len(ids) == 1  # Each declarative Rule is independently scheduled.
        self.calls.append((ids[0], request.content))
        return await super().execute(request)


@pytest.mark.parametrize("phase", ["input", "output"])
@pytest.mark.parametrize("layout", ["same-policy", "cross-policy"])
@pytest.mark.parametrize("actions,hits", CASES, ids=[
    f"{'-'.join(actions)}-hits{''.join(str(int(hit)) for hit in hits)}" for actions, hits in CASES
])
async def test_action_composition_matrix(composition_plans, actions, hits, layout, phase):
    original = " ".join(word if hit else f"safe{i}" for i, (word, hit) in enumerate(zip(WORDS, hits)))
    current = original
    expected_calls, expected_findings = [], []
    expected_decision = "allow"
    # Stable action partitions: all Block checks, then serial Transform, then Allow.
    # Read-only checks declare the phase input as their view, so scheduling them
    # ahead of a Transform step for latency cannot change what they inspect.
    # Only a Transform step consumes the text produced by the preceding one.
    for action in ACTIONS:
        for index, configured in enumerate(actions):
            if configured != action:
                continue
            expected_calls.append((f"r{index}", current if action == "transform" else original))
            if not hits[index]:
                continue
            expected_findings.append((f"r{index}", action))
            if action == "block":
                expected_decision = "block"
                break
            if action == "transform":
                current = current.replace(WORDS[index], f"[MASK_{index}]")
                expected_decision = "transform"
        if expected_decision == "block":
            break
    plan = composition_plans[f"{','.join(actions)}:{layout}:{phase}"]
    provider = RecordedLocalChecks()
    runtime = DraftPreviewRuntime(DefaultRunnerCompiler(), action_providers(provider))
    try:
        result = await runtime.evaluate(
            ProtectionRequest(phase=phase, texts=(original,), context=RequestContext(protocol="playground")),
            preview_id="action-matrix", guardrail_id="matrix", draft_revision=1,
            candidate_version="20261023-000000.001Z", plan=plan, runtime_profile="auto",
        )
        assert not result.usage.fail_closed, result.reason
        assert result.usage.model_invocations == 0
        assert result.decision == expected_decision
        assert provider.calls == expected_calls  # Includes non-matches and terminal short-circuit.
        assert [(f.rule_id, f.recommended_action) for f in result.findings] == expected_findings
        if expected_decision == "transform":
            assert result.texts == (current,)
        else:
            assert result.texts == ()  # Allow does not replace; Block releases no transformed output.
    finally:
        await runtime.shutdown()
