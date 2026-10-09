-- Routing and the runtime baseline always name a pinned Guardrail Version.
-- There is no Latest pointer: a Router target cannot follow one, and nothing
-- else reads one.
--
-- 1. A Router draft target that followed Latest is pinned to the version it
--    resolved to. Snapshots were already pinned at submission; drop the key.
UPDATE traffic_router r SET draft = jsonb_set(r.draft, '{routes}', COALESCE((
  SELECT jsonb_agg(jsonb_set(route.value, '{targets}', COALESCE((
    SELECT jsonb_agg(CASE WHEN target.value->>'versionStrategy' = 'latest'
        THEN (target.value - 'versionStrategy') || jsonb_build_object('guardrailVersion', COALESCE(g.latest_version, ''))
        ELSE target.value - 'versionStrategy' END ORDER BY target.ordinality)
    FROM jsonb_array_elements(route.value->'targets') WITH ORDINALITY AS target(value, ordinality)
    LEFT JOIN guardrail g ON g.id = target.value->>'guardrailId'), '[]'::jsonb)) ORDER BY route.ordinality)
  FROM jsonb_array_elements(r.draft->'routes') WITH ORDINALITY AS route(value, ordinality)), '[]'::jsonb))
WHERE r.draft::text LIKE '%versionStrategy%';
--> statement-breakpoint
-- 2. Where the runtime baseline followed the Default's Latest, pin it.
UPDATE controller_state SET baseline_version = (
  SELECT latest_version FROM guardrail WHERE id = 'guardrail-default' AND deleted_at IS NULL
) WHERE baseline_version IS NULL;
--> statement-breakpoint
ALTER TABLE guardrail DROP COLUMN latest_version, DROP COLUMN latest_artifact_id;
