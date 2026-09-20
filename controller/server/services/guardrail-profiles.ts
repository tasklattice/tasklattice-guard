import { asc, eq } from "drizzle-orm";
import type { ControllerDatabase } from "../db/client.js";
import { guardrailProfiles } from "../db/schema.js";
import type { GuardrailProfile } from "../../shared/protection-map.js";

export async function readGuardrailProfiles(db: ControllerDatabase): Promise<GuardrailProfile[]> {
  const rows = await db.select().from(guardrailProfiles).where(eq(guardrailProfiles.enabled, true))
    .orderBy(asc(guardrailProfiles.sortOrder), asc(guardrailProfiles.id));
  return rows.map(row => ({ ...row.definition, id: row.id, category: row.category, categoryName: row.categoryName, isDefault: row.isDefault }));
}
