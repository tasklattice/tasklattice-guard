import { and, inArray } from "drizzle-orm";
import type { ControllerDatabase } from "../db/client.js";
import { canonicalJson } from "../../shared/canonical-json.js";
import { policyImportedVersions, policyRecords, policyResources, policyResourceVersions, policyVersions } from "../db/schema.js";
import { derivesFromCatalogNode, frozenBuiltInDefinition, planBuiltInDefinitions, planCustomVersions, planPolicyEdges, planPolicyVersion, policyNodeDigest, snapshotChecksum, type PolicyNode } from "../domain/policy-node.js";
import type { PolicyDto } from "../policy-catalog/catalog.js";
import type { ProgrammablePolicySnapshot } from "../policy-studio/model.js";
import { currentTenantId, resourceReadPredicate } from "./tenant-context.js";

/** A Guardrail share does not transitively disclose its frozen Policy leaves.
 * Require a current Policy read grant and the same immutable definition; IDs
 * reused after deletion cannot authorize a different historical definition. */
export async function mayReadFrozenPolicyContent(db: Pick<ControllerDatabase, "select">, nodes: PolicyNode[] | null,
  plan: Record<string, unknown>, shipped: readonly PolicyDto[]): Promise<boolean> {
  if (!currentTenantId()) return true;
  if (!Array.isArray(nodes) || !Array.isArray(plan.policy_bindings)) return false;
  if (plan.policy_bindings.some(binding => !binding || typeof binding !== "object" || Array.isArray(binding))) return false;
  if (nodes.some(node => !node || typeof node.id !== "string" || typeof node.version !== "string" ||
    !node.definition || typeof node.definition !== "object" || Array.isArray(node.definition) ||
    (node.kind !== "catalog" && node.kind !== "programmable"))) return false;
  const edges = planPolicyEdges(plan);
  if (edges.some(edge => !edge.id || !edge.version || !nodes.some(node => node.id === edge.id && node.version === edge.version))) return false;
  if (!matchesFrozenPlan(nodes, plan)) return false;
  if (!nodes.length) return edges.length === 0;
  const ids = [...new Set(nodes.map(node => node.id))];
  // Callers may pass a transaction backed by a single pg client; do not rely
  // on its deprecated concurrent-query queue behavior.
  const records = await db.select({ id: policyRecords.id }).from(policyRecords)
    .where(and(inArray(policyRecords.id, ids), resourceReadPredicate("policy", policyRecords.id, policyRecords.tenantId)));
  const resources = await db.select({ id: policyResources.id }).from(policyResources)
    .where(and(inArray(policyResources.id, ids), resourceReadPredicate("policy", policyResources.id, policyResources.tenantId)));
  const imported = await db.select().from(policyImportedVersions)
    .where(and(inArray(policyImportedVersions.policyId, ids), resourceReadPredicate("policy", policyImportedVersions.policyId, policyImportedVersions.tenantId)));
  const versions = await db.select().from(policyVersions).where(inArray(policyVersions.policyId, ids));
  const maintained = await db.select().from(policyResourceVersions).where(inArray(policyResourceVersions.policyId, ids));
  const publicVersions = shipped.flatMap(policy => [policy, ...(policy.published_versions ?? [])]);
  return nodes.every(node => {
    const digest = policyNodeDigest(node.definition);
    if (node.kind === "catalog" && publicVersions.some(policy => policy.id === node.id && policy.version === node.version &&
      policyNodeDigest(frozenBuiltInDefinition(policy)) === digest)) return true;
    if (node.kind === "programmable") return records.some(row => row.id === node.id) && versions.some(row =>
      row.policyId === node.id && String(row.version) === node.version && policyNodeDigest(row.snapshot as unknown as Record<string, unknown>) === digest);
    return (resources.some(row => row.id === node.id) && maintained.some(row => row.policyId === node.id && row.version === node.version &&
      policyNodeDigest(frozenBuiltInDefinition(row.view)) === digest)) ||
      imported.some(row => row.policyId === node.id && row.version === node.version && row.digest === digest);
  });
}

/** Verify source-bearing plan projections, not merely their Policy names.
 * Stored publication/import integrity remains the authority for compiled files. */
function matchesFrozenPlan(nodes: PolicyNode[], plan: Record<string, unknown>): boolean {
  try {
    const key = (id: string, version: string) => `${id}@${version}`;
    const nodeKeys = new Set(nodes.map(node => key(node.id, node.version)));
    const edges = new Set(planPolicyEdges(plan).map(edge => key(edge.id, edge.version)));
    if (nodeKeys.size !== nodes.length || edges.size !== nodeKeys.size || [...nodeKeys].some(id => !edges.has(id))) return false;
    if (plan.policy_versions !== undefined && (!Array.isArray(plan.policy_versions) || plan.policy_versions.some(value => !value || typeof value !== "object" || Array.isArray(value)))) return false;
    if (plan.steps !== undefined && !Array.isArray(plan.steps)) return false;
    for (const step of Array.isArray(plan.steps) ? plan.steps : []) {
      if (!step || typeof step !== "object" || Array.isArray(step)) return false;
      if (step.capability !== "builtin_content_filter") continue;
      const pairs: unknown[] = Array.isArray(step.parameters) ? step.parameters : [];
      const parameters = new Map<string, string>(pairs.filter(Array.isArray)
        .map((pair): [string, string] => [String(pair[0]), String(pair[1] ?? "")]));
      const definitions = JSON.parse(parameters.get("policy_definitions_json") ?? "null");
      const versions = JSON.parse(parameters.get("policy_versions_json") ?? "null");
      const ids = (parameters.get("policy_ids") ?? "").split(/\r?\n/).map(id => id.trim()).filter(Boolean);
      if (!definitions || typeof definitions !== "object" || Array.isArray(definitions) ||
        !versions || typeof versions !== "object" || Array.isArray(versions) || !ids.length ||
        ids.some(id => !definitions[id]?.rules?.length || definitions[id].version !== versions[id])) return false;
    }
    const projections = planCustomVersions(plan);
    if (Array.isArray(plan.policy_versions) && projections.size !== plan.policy_versions.length) return false;
    const frozen = planBuiltInDefinitions(plan);
    if ([...projections.keys()].some(id => !nodes.some(node => node.kind === "programmable" && key(node.id, node.version) === id))) return false;
    if ([...frozen.keys()].some(id => !nodes.some(node => node.kind === "catalog" && node.id === id))) return false;
    for (const node of nodes) {
      if (node.kind === "catalog") {
        const copy = frozen.get(node.id);
        if (copy && !derivesFromCatalogNode(node.definition, copy)) return false;
      } else {
        const snapshot = node.definition as unknown as ProgrammablePolicySnapshot;
        const projection = projections.get(key(node.id, node.version));
        if (snapshotChecksum(node.definition) !== snapshot.checksum || !projection ||
          canonicalJson(withoutNulls(planPolicyVersion(snapshot))) !== canonicalJson(withoutNulls(projection))) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null).map(([key, item]) => [key, withoutNulls(item)]));
}
