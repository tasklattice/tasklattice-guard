import { describe, expect, it } from "vitest";
import type { policyRecords, policyVersions } from "../db/schema.js";
import { programmablePolicyDraftSchema } from "../policy-studio/model.js";
import { recommendationCatalog } from "../control-plane-ai/recommendation-catalog.js";
import { programmablePolicyPayload } from "./control-plane.js";

const publishedAt = new Date("2026-09-01T00:00:00Z");
const editedAt = new Date("2026-09-06T00:00:00Z");
const draft = programmablePolicyDraftSchema.parse({
  guardrail_category: "content_safety", colang_version: "1.0",
  sources: [{ path: "rails.co", content: "define flow published_check\n  pass" }],
  parameter_schema: [{ name: "published_parameter", kind: "string", required: true }],
  rail_bindings: [{ rail_type: "input", flow_name: "published_check", execution_mode: "detect", on_unsafe: "reject" }],
  execution_contract: [["output_delivery", "full_buffered"]],
  test_cases: [{ id: "published-case", name: "Published acceptance", rail_type: "input", content: "sample", expected_decision: "block",
    covered_rule_ids: ["flow/input/published_check"], case_type: "input_rail" }],
});
const record: typeof policyRecords.$inferSelect = {
  id: "custom-policy", name: "Unpublished rename", description: "Unpublished semantic coverage claim", source: "custom", owner: "new owner",
  draft: { ...draft, rail_bindings: [{ ...draft.rail_bindings[0]!, rail_type: "output", flow_name: "unpublished_check", on_unsafe: "report" }],
    parameter_schema: [], test_cases: [], execution_contract: [["output_delivery", "interruptible"]] },
  draftRevision: 3, createdAt: publishedAt, updatedAt: editedAt,
};
function version(number: number): typeof policyVersions.$inferSelect {
  return { policyId: record.id, version: number, checksum: `checksum-${number}`, publishedAt,
    snapshot: { ...structuredClone(draft), policy_id: record.id, version: String(number), name: `Published ${number}`, description: "Published protection",
      source: "custom", owner: "published owner", checksum: `checksum-${number}`, published_at: publishedAt.toISOString() } };
}

describe("Selectable custom Policy version boundary", () => {
  it("projects Rules, parameters, tests and directions from the published snapshot, not the edited draft", () => {
    const payload = programmablePolicyPayload(record, [version(2)]);
    expect(payload).toMatchObject({ version: "2", name: "Published 2", description: "Published protection", owner: "published owner",
      rails: ["input"], effects: ["reject"], parameters: draft.parameter_schema, test_count: 1, output_delivery: "full_buffered",
      updated_at: publishedAt.toISOString() });
    expect(payload.rules[0]?.implementation.flow_name).toBe("published_check");
    expect(payload.test_cases[0]?.id).toBe("published-case");
    expect(payload.compliance).toMatchObject({ policy_version: "2", maintainer: "published owner", references: [], review: { status: "pending" } });
    expect(payload.implementation_detail).toMatchObject({ name: record.name, description: record.description, owner: record.owner,
      draft: record.draft, draft_revision: 3, updated_at: editedAt.toISOString() });
  });

  it("selects the newest numeric version independently of row order without mutating snapshots", () => {
    const versions = [version(2), version(10), version(1)];
    const before = structuredClone(versions);
    expect(programmablePolicyPayload(record, versions)).toMatchObject({ version: "10", name: "Published 10" });
    expect(versions).toEqual(before);
    const surfaces = programmablePolicyPayload(record, versions).published_versions;
    expect(surfaces.map((item) => item.version)).toEqual(["2", "10", "1"]);
    expect(surfaces[0]).not.toHaveProperty("implementation_detail");
    expect(surfaces[0]).not.toHaveProperty("published_versions");
    expect(surfaces[0]?.rules[0]?.implementation.flow_name).toBe("published_check");
  });

  it("keeps never-published drafts editable but not recommendable", () => {
    const payload = programmablePolicyPayload(record, []);
    expect(payload).toMatchObject({ version: "0", name: record.name, rails: ["output"], test_cases: [] });
    expect(payload.implementation_detail.draft).toEqual(record.draft);
    expect(recommendationCatalog([payload])).toEqual([]);
  });

  it("does not recommend draft-only coverage or directions under a published version", () => {
    const recommendations = recommendationCatalog([programmablePolicyPayload(record, [version(2)])]);
    expect(recommendations[0]).toMatchObject({ name: "Published 2", description: "Published protection", rails: ["input"], model_capabilities: null });
    expect(JSON.stringify(recommendations)).not.toContain("Unpublished");
    expect(JSON.stringify(recommendations)).not.toContain("unpublished_check");
  });
});
