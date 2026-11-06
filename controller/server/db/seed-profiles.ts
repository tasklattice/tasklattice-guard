import { defaultGuardrailProfiles, targetGuardrailProfiles } from "../../shared/guardrail-profiles.js";
import type { ControllerDatabase } from "./client.js";
import { guardrailProfiles } from "./schema.js";
import { inArray } from "drizzle-orm";

type SeedDb = Pick<ControllerDatabase, "insert" | "update">;
type SeedMode = "legacy" | "target";

function rows(profiles: readonly (typeof defaultGuardrailProfiles)[number][], sortStart = 0) {
  return profiles.map(({ id, category, categoryName, isDefault, ...definition }, index) => ({
    id, category, categoryName, isDefault, sortOrder: sortStart + index, definition,
  }));
}

/** Fresh databases use the same pinned Profiles as the product catalog. */
export async function seedProfiles(db: Pick<ControllerDatabase, "insert">, mode: SeedMode = "legacy") {
  const profiles = mode === "target" ? targetGuardrailProfiles : defaultGuardrailProfiles;
  await db.insert(guardrailProfiles).values(rows(profiles));
}

/**
 * Existing installations upgrade their seed catalog when target mode is enabled.
 * User-created Profiles are untouched; only the reviewed legacy seeds are disabled.
 */
export async function syncTargetProfiles(db: SeedDb): Promise<void> {
  const targetIds = targetGuardrailProfiles.map(profile => profile.id);
  const legacyIds = defaultGuardrailProfiles.map(profile => profile.id).filter(id => !targetIds.includes(id));
  if (legacyIds.length) {
    await db.update(guardrailProfiles).set({ enabled: false }).where(inArray(guardrailProfiles.id, legacyIds));
  }
  for (const [sortOrder, row] of rows(targetGuardrailProfiles).entries()) {
    await db.insert(guardrailProfiles).values({ ...row, enabled: true })
      .onConflictDoUpdate({ target: guardrailProfiles.id, set: {
        category: row.category, categoryName: row.categoryName, isDefault: row.isDefault,
        enabled: true, sortOrder, definition: row.definition, updatedAt: new Date(),
      } });
  }
}
