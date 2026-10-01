import { z } from "zod";
import { enforcementActions } from "./enforcement-action.generated.js";

export const PHRASE_POLICY_ID = "configured-phrase-filter";
export const PHRASE_RULE_ID = "configured/phrases";
export const PHRASE_PARAMETER = "phrase_entries";

/** Configuration belongs to a versioned Policy binding, never the Guardrail root. */
export const phraseEntrySchema = z.object({
  id: z.string().trim().min(1).max(100),
  phrase: z.string().trim().min(1, "Enter a phrase.").max(240),
  action: z.enum(enforcementActions),
  replacement: z.string().max(240).default("[REDACTED]"),
}).strict();
export type PhraseEntry = z.infer<typeof phraseEntrySchema>;
const entriesSchema = z.array(phraseEntrySchema).min(1, "Add at least one phrase.").max(50).superRefine((entries, ctx) => {
  const ids = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (ids.has(entry.id)) ctx.addIssue({ code: "custom", path: [index, "id"], message: "Phrase IDs must be unique." });
    ids.add(entry.id);
  }
});

export function parsePhraseEntries(value: string): PhraseEntry[] {
  let decoded: unknown;
  try { decoded = JSON.parse(value); } catch { throw new Error("Add at least one phrase."); }
  const result = entriesSchema.safeParse(decoded);
  if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid phrase configuration.");
  return result.data;
}
