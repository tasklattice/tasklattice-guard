export function policyLibrarySearch(search: Record<string, unknown>) {
  // TanStack's JSON search parser decodes a bare ?version=1 as a number.
  // Custom Policy versions are positive integers; preserve those deep links.
  const version = typeof search.version === "string" ? search.version
    : typeof search.version === "number" && Number.isSafeInteger(search.version) && search.version > 0 ? String(search.version) : undefined;
  return { policy: typeof search.policy === "string" ? search.policy : undefined, version };
}
