// @vitest-environment node
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PolicyCatalog } from "../policy-catalog/catalog.js";
import { DeclarativeCompiler } from "../policy-studio/declarative.js";
import { ControlPlaneService } from "../services/control-plane.js";
import { preparePolicyVersionTest } from "./policy-version-test.js";

const directory = resolve("../runner/toolkit/policy_library/assets");
const compiler = new DeclarativeCompiler(directory);
const catalog = PolicyCatalog.load(directory);
const policy = (id: string) => compiler.catalogView(catalog.get(id)!);

describe("published Policy tests", () => {
  it("executes every declared case, isolating acceptance Rules and preserving scenario order", () => {
    const definition = structuredClone(policy("content-safety-local").definition!);
    definition.tests.push({ ...definition.tests[0]!, id: "optional-scenario", kind: "scenario", scope: "policy", required: false });
    const prepared = preparePolicyVersionTest(compiler.compile(definition));
    expect(prepared.tests).toHaveLength(definition.tests.length);
    expect(prepared.jobs.flatMap(j => j.testCases).every(c => c.required)).toBe(true);
    const acceptance = prepared.jobs.find(j => j.tests[0]!.scope === "rule")!;
    expect(acceptance.plan.policy_bindings[0]!.enabled_rule_ids).toEqual(acceptance.tests[0]!.covered_rule_ids);
    const scenario = prepared.jobs.find(j => j.tests[0]!.scope === "policy")!;
    expect(scenario.plan.policy_bindings[0]!.enabled_rule_ids).toEqual(definition.rules.map(r => r.id));
    expect(prepared.requiredBindings).toEqual([]);
  });

  it("expands fixture parameters and discovers both stages of required Protection", () => {
    const phrases = preparePolicyVersionTest(policy("content-filters"));
    expect(phrases.tests.length).toBeGreaterThan(0);
    expect(JSON.stringify(phrases.jobs.flatMap(j => j.testCases))).not.toContain("{{phrase_entries}}");
    const model = preparePolicyVersionTest(policy("content-safety-model"));
    expect(model.requiredBindings).toEqual(["content_safety.input", "content_safety.output"]);
  });

  it("rejects unpublished versions and missing formal verification fixtures", () => {
    expect(() => preparePolicyVersionTest({ ...policy("content-filters"), version: "0" })).toThrow("Publish");
    expect(() => preparePolicyVersionTest(policy("answer-reliability"))).toThrow("policy_id");
  });

  it("resolves the selected historical version without using a newer mutable definition", async () => {
    const old = policy("content-safety-local");
    const current = { ...old, version: "new", definition: { ...old.definition!, tests: [] }, published_versions: [old] };
    const service = { getPolicy: async () => current } as unknown as ControlPlaneService;
    const prepared = await ControlPlaneService.prototype.preparePolicyVersionTest.call(service, old.id, old.version);
    expect(prepared.version).toBe(old.version);
    expect(prepared.tests).toHaveLength(old.definition!.tests.length);
    await expect(ControlPlaneService.prototype.preparePolicyVersionTest.call(service, old.id, "missing")).rejects.toThrow("Policy version");
  });
});
