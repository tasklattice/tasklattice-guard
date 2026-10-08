-- The Guardrail version pointer is "Latest": Router targets that use latest
-- resolve to it when a change is submitted. It is not a traffic state.
ALTER TABLE guardrail RENAME COLUMN active_version TO latest_version;
ALTER TABLE guardrail RENAME COLUMN active_artifact_id TO latest_artifact_id;
