-- Retire legacy LiteLLM-derived financial phrase collections whose MAS-labelled
-- Rules do not have a verified, Rule-level mapping to an authoritative source.
-- Preserve all other Profile ordering and customer edits.
UPDATE "guardrail_profile"
SET "definition" = jsonb_set(
  jsonb_set(
    "definition",
    '{policies}',
    COALESCE((
      SELECT jsonb_agg(entry.item ORDER BY entry.position)
      FROM jsonb_array_elements(COALESCE("definition"->'policies', '[]'::jsonb))
        WITH ORDINALITY AS entry(item, position)
      WHERE entry.item->>'policyId' NOT IN ('mas-ai-risk-management', 'singapore-financial-conduct')
    ), '[]'::jsonb)
  ),
  '{optionalPolicyIds}',
  COALESCE((
    SELECT jsonb_agg(entry.item ORDER BY entry.position)
    FROM jsonb_array_elements(COALESCE("definition"->'optionalPolicyIds', '[]'::jsonb))
      WITH ORDINALITY AS entry(item, position)
    WHERE entry.item #>> '{}' NOT IN ('mas-ai-risk-management', 'singapore-financial-conduct')
  ), '[]'::jsonb)
)
WHERE EXISTS (
  SELECT 1
  FROM jsonb_array_elements(COALESCE("definition"->'policies', '[]'::jsonb)) AS entry(item)
  WHERE entry.item->>'policyId' IN ('mas-ai-risk-management', 'singapore-financial-conduct')
) OR COALESCE("definition"->'optionalPolicyIds', '[]'::jsonb) ?| ARRAY['mas-ai-risk-management', 'singapore-financial-conduct'];

UPDATE "guardrail_profile"
SET "definition" = jsonb_set("definition", '{version}', '"1.0.1"'::jsonb)
WHERE "id" IN ('banking-assistant', 'securities-assistant', 'singapore-financial-assistant')
  AND "definition"->>'version' = '1.0.0';

UPDATE "guardrail_profile"
SET "definition" = jsonb_set(
  jsonb_set(
    "definition",
    '{description}',
    to_jsonb('Banking baseline plus Singapore customer-identifier and personal-data-use phrase checks. No MAS-specific Policy is included.'::text)
  ),
  '{limitations}',
  ("definition"->'limitations') || to_jsonb(ARRAY['No MAS-specific control is included without a verified, directly relevant MAS source and reviewed Rule-level mapping.']::text[])
)
WHERE "id" = 'singapore-financial-assistant'
  AND "definition"->>'description' = 'Banking baseline plus Singapore customer identifiers and reviewed financial-conduct/data-use phrase checks.';
