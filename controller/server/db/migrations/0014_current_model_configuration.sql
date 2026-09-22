-- Model settings are current state + pending edits, not a version history.
-- Keep the newest editable/current/in-flight/error state; audit events are retained.
-- The existing table/sequence names remain internal wire compatibility details.
WITH ranked AS (
  SELECT id, state,
    row_number() OVER (
      PARTITION BY CASE WHEN state IN ('draft', 'validated') THEN 'editable' ELSE state END
      ORDER BY revision DESC
    ) AS position
  FROM model_configuration_revision
)
DELETE FROM model_configuration_revision
WHERE id IN (SELECT id FROM ranked WHERE state = 'superseded' OR position > 1);
