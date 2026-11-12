import { guardrailProfiles as guardrailProfileSeeds } from "../../shared/guardrail-profiles.js";
import { sql } from "drizzle-orm";
import type { ControllerDatabase } from "./client.js";
import { guardrailProfiles } from "./schema.js";

type SeedDb = Pick<ControllerDatabase, "insert">;

function rows(profiles: readonly (typeof guardrailProfileSeeds)[number][], sortStart = 0) {
  return profiles.map(({ id, category, categoryName, isDefault, ...definition }, index) => ({
    id, category, categoryName, isDefault, sortOrder: sortStart + index, definition,
  }));
}

/** Fresh databases use the same pinned Profiles as the product catalog. */
export async function seedProfiles(db: SeedDb) {
  await db.insert(guardrailProfiles).values(rows(guardrailProfileSeeds));
}

/** Refresh the managed Profile catalog at startup. */
export async function syncProfiles(db: SeedDb): Promise<void> {
  for (const [sortOrder, row] of rows(guardrailProfileSeeds).entries()) {
    await db.insert(guardrailProfiles).values({ ...row, enabled: true })
      .onConflictDoUpdate({ target: guardrailProfiles.id, set: {
        category: row.category, categoryName: row.categoryName, isDefault: row.isDefault,
        enabled: true, sortOrder, definition: row.definition, updatedAt: new Date(),
      }, setWhere: sql`(${guardrailProfiles.category}, ${guardrailProfiles.categoryName},
        ${guardrailProfiles.isDefault}, ${guardrailProfiles.enabled},
        ${guardrailProfiles.sortOrder}, ${guardrailProfiles.definition}) IS DISTINCT FROM
        (excluded.category, excluded.category_name, excluded.is_default,
        excluded.enabled, excluded.sort_order, excluded.definition)` });
  }
}
