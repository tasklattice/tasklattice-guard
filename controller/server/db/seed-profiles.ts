import { guardrailProfiles as guardrailProfileSeeds } from "../../shared/guardrail-profiles.js";
import { inArray, sql } from "drizzle-orm";
import type { ControllerDatabase } from "./client.js";
import { guardrailProfiles } from "./schema.js";

type SeedDb = Pick<ControllerDatabase, "insert" | "update" | "delete">;

function rows(profiles: readonly (typeof guardrailProfileSeeds)[number][], sortStart = 0) {
  return profiles.map(({ id, category, categoryName, isDefault, ...definition }, index) => ({
    id, category, categoryName, isDefault, sortOrder: sortStart + index, definition,
  }));
}

/** Fresh databases use the same pinned Profiles as the product catalog. */
export async function seedProfiles(db: Pick<ControllerDatabase, "insert">) {
  await db.insert(guardrailProfiles).values(rows(guardrailProfileSeeds));
}

/** Profile IDs that belonged to the retired seed catalog. */
const REMOVED_PROFILE_IDS = ["banking-assistant", "full-feature-baseline", "internet-customer-support", "local-baseline", "securities-assistant"];

/** Existing installations upgrade their seed catalog on startup. */
export async function syncProfiles(db: SeedDb): Promise<void> {
  // User-created Profiles are untouched; only the reviewed seeds are updated.
  await db.delete(guardrailProfiles).where(inArray(guardrailProfiles.id, REMOVED_PROFILE_IDS));
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
