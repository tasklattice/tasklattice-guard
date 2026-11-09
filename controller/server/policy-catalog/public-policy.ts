/** Hide authoring-mode metadata from the public DTO without modifying signed snapshots. */
export type PublicPolicy<T> = T extends Array<infer Item> ? PublicPolicy<Item>[] : T extends object ? {
  [Key in keyof T as Key extends "source" ? never : Key]: Key extends "published_versions" | "implementation_detail" ? PublicPolicy<T[Key]> : T[Key]
} : T;

export function publicPolicy<T>(value: T): PublicPolicy<T> {
  if (Array.isArray(value)) return value.map(publicPolicy) as PublicPolicy<T>;
  if (!value || typeof value !== "object") return value as PublicPolicy<T>;
  const { source: _source, ...rest } = value as Record<string, unknown>;
  for (const key of ["published_versions", "implementation_detail"]) if (rest[key] != null) rest[key] = publicPolicy(rest[key]);
  return rest as PublicPolicy<T>;
}
