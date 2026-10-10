-- Imports have the same editable draft lifecycle as UI-created Guardrails.
-- Frozen versions remain unchanged; these snapshots support copy/discard operations.
UPDATE guardrail_version v
SET source_snapshot = jsonb_build_object(
  'draftConfig', v.inspection->'draftConfig',
  'runtimeProfile', v.runtime_profile,
  'loggingLevel', 'info',
  'excludedTestCaseIds', '[]'::jsonb,
  'testCases', COALESCE((
    SELECT jsonb_agg((c - 'expectationOverride') || jsonb_build_object('guardrailId', v.guardrail_id))
    FROM jsonb_array_elements(v.test_suite) c
  ), '[]'::jsonb)
)
WHERE v.origin = 'imported' AND v.source_snapshot IS NULL
  AND v.inspection->'draftConfig' IS NOT NULL AND v.test_suite IS NOT NULL;
--> statement-breakpoint
-- Only seed legacy untouched stubs. Never replace a working draft or its cases.
WITH stubs AS (
  SELECT g.id, latest.source_snapshot
  FROM guardrail g
  CROSS JOIN LATERAL (
    SELECT v.source_snapshot FROM guardrail_version v
    WHERE v.guardrail_id = g.id AND v.origin = 'imported' AND v.source_snapshot IS NOT NULL
    ORDER BY v.created_at DESC, v.version DESC LIMIT 1
  ) latest
  WHERE g.origin = 'imported' AND g.draft_revision = 1
    AND NOT EXISTS (SELECT 1 FROM guardrail_test_case c WHERE c.guardrail_id = g.id)
    AND NOT EXISTS (SELECT 1 FROM guardrail_validation_run r WHERE r.guardrail_id = g.id AND r.subject = 'draft')
), seeded AS (
  UPDATE guardrail g SET draft_config = s.source_snapshot->'draftConfig',
    runtime_profile = s.source_snapshot->>'runtimeProfile'
  FROM stubs s WHERE g.id = s.id
  RETURNING g.id, s.source_snapshot
)
INSERT INTO guardrail_test_case (
  guardrail_id, id, name, policy_id, phase, content, expected_decision, origin,
  trusted_instruction, target_source, query, grounding_sources, expected_reasoning_result,
  case_type, required, expected_failure, concurrency_group, source_policy_id,
  source_policy_version, source_case_id, covered_rule_ids
)
SELECT s.id, c->>'id', c->>'name', c->>'policyId', c->>'phase', c->>'content', c->>'expectedDecision',
  COALESCE(c->>'origin', 'generated'), COALESCE(c->>'trustedInstruction', ''),
  COALESCE(c->>'targetSource', 'user_input'), COALESCE(c->>'query', ''), COALESCE(c->'groundingSources', '[]'::jsonb),
  c->>'expectedReasoningResult', COALESCE(c->>'caseType', 'scenario'), COALESCE((c->>'required')::boolean, true),
  c->>'expectedFailure', c->>'concurrencyGroup', c->>'sourcePolicyId', c->>'sourcePolicyVersion', c->>'sourceCaseId',
  COALESCE(c->'coveredRuleIds', '[]'::jsonb)
FROM seeded s CROSS JOIN LATERAL jsonb_array_elements(s.source_snapshot->'testCases') c
ON CONFLICT (guardrail_id, id) DO NOTHING;
