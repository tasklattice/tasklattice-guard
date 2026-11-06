import { defaultGuardrailProfiles, targetGuardrailProfiles } from "../../shared/guardrail-profiles.js";
import type { ControllerDatabase } from "./client.js";
import { guardrailProfiles } from "./schema.js";

/** Fresh databases use the same pinned Profiles as the product catalog. */
export async function seedProfiles(db: Pick<ControllerDatabase, "insert">) {
  const profiles = process.env.CONTROLLER_POLICY_CATALOG_MODE === "target"
    ? targetGuardrailProfiles
    : defaultGuardrailProfiles;
  await db.insert(guardrailProfiles).values(profiles.map(({ id, category, categoryName, isDefault, ...definition }, sortOrder) => ({
    id, category, categoryName, isDefault, sortOrder, definition,
  })));
}
