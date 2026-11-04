import { z } from "zod";

export const directoryQuerySchema = z.object({
  q: z.string().trim().max(100).default(""),
  cursor: z.string().min(1).max(256).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type DirectoryQuery = z.infer<typeof directoryQuerySchema>;
export type DirectoryPage<T> = { items: T[]; nextCursor: string | null };
export function directoryPage<T>(
  rows: T[],
  limit: number,
  id: (row: T) => string,
): DirectoryPage<T> {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? id(items.at(-1)!) : null };
}
export const searchPattern = (q: string) => `%${q.replace(/[\\%_]/g, "\\$&")}%`;
