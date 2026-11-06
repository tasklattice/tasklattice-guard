import { defaultGuardrailProfiles, targetGuardrailProfiles } from "../../shared/guardrail-profiles.js";
import type { ControllerDatabase } from "./client.js";
import { guardrailProfiles } from "./schema.js";

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
  // Keep legacy seeds available for pinned historical Guardrails. The target
  // Profile picker filters them out; readGuardrailProfiles still resolves them.
  for (const [sortOrder, row] of rows(targetGuardrailProfiles).entries()) {
    await db.insert(guardrailProfiles).values({ ...row, enabled: true })
      .onConflictDoUpdate({ target: guardrailProfiles.id, set: {
        category: row.category, categoryName: row.categoryName, isDefault: row.isDefault,
        enabled: true, sortOrder, definition: row.definition, updatedAt: new Date(),
      } });
  }
}
