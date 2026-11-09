import { z } from "zod";

export const auditQuerySchema = z.object({
  q: z.string().trim().max(300).default(""),
  actor: z.enum(["all", "human", "system"]).default("all"),
  window: z.enum(["24h", "7d", "30d", "all"]).default("7d"),
  kind: z.string().trim().max(200).default(""),
  resourceType: z.string().trim().max(200).default(""),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(25),
  before: z.iso.datetime({ offset: true }).optional(),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;

/** Invalid URL fields fall back independently, without losing valid filters. */
export function auditLogSearch(search: Record<string, unknown>): AuditQuery {
  const result = Object.fromEntries(Object.entries(auditQuerySchema.shape).map(([key, schema]) => {
    const parsed = schema.safeParse(search[key]);
    return [key, parsed.success ? parsed.data : schema.parse(undefined)];
  }));
  return result as AuditQuery;
}
