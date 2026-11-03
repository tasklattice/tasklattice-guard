/** Fixed identities exposed by the local mock identity provider. */
export const mockSsoIdentities = [
  { id: "tenantA", tenantId: "tenantA", group: "group_a", displayName: "Tenant A Operator" },
  { id: "tenantB", tenantId: "tenantB", group: "group_b", displayName: "Tenant B Operator" },
  { id: "tenantC", tenantId: "tenantC", group: "group_c", displayName: "Tenant C Operator" },
] as const;

export type MockSsoIdentity = (typeof mockSsoIdentities)[number]["id"];

export function isMockSsoIdentity(value: unknown): value is MockSsoIdentity {
  return typeof value === "string" && mockSsoIdentities.some((identity) => identity.id === value);
}
