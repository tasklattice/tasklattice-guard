import { describe, expect, it, vi } from "vitest";
import type { ControllerConfig } from "../config.js";
import type { ControllerDatabase } from "../db/client.js";
import { programmablePolicyDraftSchema } from "../policy-studio/model.js";
import { ControlPlaneService } from "./control-plane.js";

const draft = programmablePolicyDraftSchema.parse({
  guardrail_category: "content_safety",
  sources: [{ path: "main.co", content: 'flow check $text\n  # await MissingAction()\n  $s = "import llm"\n  pass\n' }],
  rail_bindings: [{ rail_type: "input", flow_name: "check", execution_mode: "detect", on_unsafe: "reject" }],
  test_cases: [{ name: "safe", rail_type: "input", content: "ordinary", expected_decision: "allow", covered_rule_ids: ["flow/input/check"], case_type: "input_rail" }],
});

function harness(status: string | null, revision = 2, source = draft.sources[0]!.content) {
  const reads: unknown[][] = [
    [{ id: "fixture", draftRevision: 2, draft: { ...draft, sources: [{ path: "main.co", content: source }] } }],
    status ? [{ status, draftRevision: revision }] : [],
  ];
  const query = () => {
    const result: Record<string, unknown> = {};
    for (const method of ["from", "where", "orderBy", "limit", "for"]) result[method] = () => result;
    result.then = (resolve: (value: unknown) => void) => { const rows = reads.shift(); if (!rows) throw new Error("Unexpected read"); return Promise.resolve(rows).then(resolve); };
    return result;
  };
  const tx = { select: vi.fn(query), insert: vi.fn(() => { throw new Error("Unexpected publication"); }) };
  const db = { ...tx, transaction: vi.fn(async (callback) => callback(tx)) } as unknown as ControllerDatabase;
  return { service: new ControlPlaneService(db, {} as ControllerConfig), tx, reads };
}

describe("Policy validation authority", () => {
  it.each([null, "queued", "running", "failed", "passed"])("uses current Runner evidence, not metadata alone (%s)", async status => {
    const { service, reads } = harness(status);
    expect(await service.validatePolicy("fixture")).toMatchObject({
      valid: status === "passed", metadata_valid: true,
      validation_status: status ?? "not_run", requires_runner_validation: status !== "passed",
    });
    expect(reads).toEqual([]);
  });

  it("does not reuse a passed older draft's result", async () => {
    expect(await harness("passed", 1).service.validatePolicy("fixture")).toMatchObject({
      valid: false, validation_status: "stale", requires_runner_validation: true,
    });
  });

  it("leaves incomplete source to the authoritative NeMo compile gate without certifying it", async () => {
    expect(await harness(null, 2, "flow check $text\n  await missing\n").service.validatePolicy("fixture"))
      .toMatchObject({ valid: false, metadata_valid: true, validation_status: "not_run" });
  });

  it.each([[null, 2], ["failed", 2], ["passed", 1]] as const)("cannot publish missing, failed or stale compilation evidence (%s, %s)", async (status, revision) => {
    const { service, tx, reads } = harness(status, revision);
    reads.splice(1, 0, []); // No existing publication for this draft.
    await expect(service.publishPolicy({ id: "fixture", actorId: "author" })).rejects.toThrow("must pass validation");
    expect(tx.insert).not.toHaveBeenCalled();
  });
});
