-- Retire only the superseded built-in choices. Keep their definitions for
-- provenance; Guardrail drafts, tests and published snapshots are independent.
UPDATE "guardrail_profile"
SET "enabled" = false, "updated_at" = now()
WHERE "is_default" AND "enabled" AND "id" IN (
  'common-baseline',
  'singapore-financial-assistant',
  'china-mainland-runtime',
  'china-banking-assistant',
  'australia-data-protection',
  'eu-data-protection',
  'singapore-data-protection',
  'uae-reference-controls',
  'multilingual-content-safety',
  'claims-assistant',
  'eu-high-risk-practices'
);
--> statement-breakpoint
-- Names and discovery order change; IDs, versions, bindings and settings do not.
-- Preserve disabled state and explicitly user-owned or renamed definitions.
UPDATE "guardrail_profile" AS profile
SET "definition" = jsonb_set(profile."definition", '{name}', to_jsonb(choice.name)),
    "category_name" = choice.category_name,
    "sort_order" = choice.sort_order,
    "updated_at" = now()
FROM (VALUES
  ('local-baseline', 'Local baseline', 'Default', 'Default', 0),
  ('full-feature-baseline', 'Full-feature baseline', 'Full-feature baseline', 'Full-feature baseline', 1),
  ('banking-assistant', 'Banking customer service', 'Bank', 'Bank', 2),
  ('securities-assistant', 'Securities & brokerage', 'Securities & brokerage', 'Securities', 3),
  ('internet-customer-support', 'Internet platform support', 'Internet platform support', 'Internet support', 4)
) AS choice(id, old_name, name, category_name, sort_order)
WHERE profile."id" = choice.id AND profile."is_default"
  AND profile."definition"->>'name' IN (choice.old_name, choice.name)
  AND (profile."definition"->>'name', profile."category_name", profile."sort_order")
      IS DISTINCT FROM (choice.name, choice.category_name, choice.sort_order);
