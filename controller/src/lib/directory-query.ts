import type { DirectoryQuery } from "../../shared/directory";
export type PageQuery = Partial<DirectoryQuery>;
export function directorySearch(
  query: PageQuery & Record<string, unknown> = {},
) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined && value !== "") params.set(key, String(value));
  return params.size ? `?${params}` : "";
}
