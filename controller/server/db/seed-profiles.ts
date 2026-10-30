import { defaultGuardrailProfiles } from "../../shared/guardrail-profiles.js";
import type { ControllerDatabase } from "./client.js";
import { guardrailProfiles } from "./schema.js";

/** Fresh databases use the same pinned Profiles as the product catalog. */
export async function seedProfiles(db: Pick<ControllerDatabase, "insert">) {
  await db.insert(guardrailProfiles).values(defaultGuardrailProfiles.map(({ id, category, categoryName, isDefault, ...definition }, sortOrder) => ({
    id, category, categoryName, isDefault, sortOrder, definition,
  })));
}
