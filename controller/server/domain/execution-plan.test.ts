import { expect, it } from "vitest";
import { scheduleChecks, scheduleRankedChecks } from "./execution-plan.js";
const step = (id: string, action: string, remote = false, after?: string) => ({ id, capability: remote ? "content_safety" : "pii", contract_ref: remote ? "tali.guard.content-safety.v1" : "local", phases: ["input", "output"], on_unsafe: action, trigger: after ? { type: "on_result", step_ref: after } : { type: "always" }, parameters: [] as Array<[string, string]> });
const modules = (steps: ReturnType<typeof step>[]) => ["input", "output"].flatMap(phase => steps.map((s, i) => ({ id: `${s.id}:${phase}`, phase, step_ids: [s.id], depends_on: i ? [`${steps[i - 1]!.id}:${phase}`] : [], input_view: "previous_output" })));
it("runs local checks before model checks, prioritizing Block within each stage", () => {
 const steps = [step("mask-1", "transform"), step("model-a", "block", true), step("allow", "allow"), step("mask-2", "transform"), step("local", "block"), step("model-b", "block", true)];
 const mods = modules(steps); scheduleChecks(steps, mods, false);
 expect(steps.map(s => s.id)).toEqual(["local", "mask-1", "mask-2", "allow", "model-a", "model-b"]);
 for (const phase of ["input", "output"]) {
  expect(mods.find(m => m.id === `model-a:${phase}`)?.depends_on).toEqual([`allow:${phase}`]);
  expect(mods.find(m => m.id === `model-b:${phase}`)?.depends_on).toEqual([`allow:${phase}`]);
  expect(mods.find(m => m.id === `mask-1:${phase}`)?.depends_on).toEqual([`local:${phase}`]);
  expect(Object.fromEntries(steps[4]!.parameters)[`parallel_leader_${phase}`]).toBe("true");
  expect(Object.fromEntries(steps[5]!.parameters)[`parallel_leader_${phase}`]).toBe("false");
 }
});
it("retains a trigger prerequisite even when it must transform before Block", () => {
 const steps = [step("mask", "transform"), step("dependent", "block", true, "mask"), step("independent", "block", true)];
 scheduleChecks(steps, modules(steps), false);
 expect(steps.map(s => s.id)).toEqual(["mask", "dependent", "independent"]);
 expect(steps.flatMap(s => s.parameters).some(([k]) => k.startsWith("parallel_group"))).toBe(false);
});
it("does not reorder arbitrary authored flows or parallelize streaming output", () => {
 const steps = [step("mask", "transform"), step("a", "block", true), step("b", "block", true)], mods = modules(steps), before = structuredClone({steps, mods});
 scheduleChecks(steps, mods, true); expect({steps, mods}).toEqual(before);
 scheduleChecks(steps, mods, false, false);
 expect(steps[1]!.parameters.some(([k]) => k === "parallel_group_input")).toBe(true);
 expect(steps.flatMap(s => s.parameters).some(([k]) => k === "parallel_group_output")).toBe(false);
});
it("keeps a module's conditional chain contiguous", () => {
 const steps = [step("exact", "block"), step("semantic", "block", true, "exact"), step("other", "block")];
 const mods = [{ id: "chain", phase: "input", step_ids: ["exact", "semantic"], depends_on: [], input_view: "previous_output" }, { id: "other", phase: "input", step_ids: ["other"], depends_on: ["chain"], input_view: "previous_output" }];
 scheduleChecks(steps, mods, false);
 expect(steps.map(s => s.id)).toEqual(["other", "exact", "semantic"]);
});
it("groups local Blocks before local observations and model checks", () => {
 const steps = [step("observe", "allow"), step("model", "block", true), step("b", "block"), step("a", "block")];
 const mods = modules(steps); scheduleChecks(steps, mods, false);
 expect(steps.map(s => s.id)).toEqual(["b", "a", "observe", "model"]);
 const params = steps.map(s => Object.fromEntries(s.parameters));
 expect(params[0]!.parallel_group_input).toBe(params[1]!.parallel_group_input);
 expect(params[0]!.execution_stage_input).toBe("local");
 expect(params[3]!.execution_stage_input).toBe("model");
 expect(mods.find(m => m.id === "model:input")?.depends_on).toEqual(["observe:input"]);
});
it("uses declared model dependencies and recognizes classifier review", () => {
 const customModel = step("custom-model", "block"); customModel.parameters.push(["execution_dependency", "model"]);
 const review = step("review", "block"); review.contract_ref = "tali.guard.classifier-review.v1";
 const steps = [customModel, review, step("local", "allow")]; scheduleChecks(steps, modules(steps), false);
 expect(steps.map(s => s.id)).toEqual(["local", "custom-model", "review"]);
 expect(Object.fromEntries(steps[1]!.parameters).parallel_group_input).toBe(Object.fromEntries(steps[2]!.parameters).parallel_group_input);
});


it("Rank Mode groups read-only checks and starts a new segment after Transform", () => {
  const steps = [step("a", "block"), step("b", "allow"), step("t", "transform"), step("c", "block"), step("d", "block")];
  const mods = modules(steps);
  scheduleRankedChecks(steps, mods);
  expect(steps.map(item => item.id)).toEqual(["a", "b", "t", "c", "d"]);
  const params = steps.map(item => Object.fromEntries(item.parameters));
  expect(params[0]!.parallel_group_input).toBe(params[1]!.parallel_group_input);
  expect(params[0]!.parallel_leader_input).toBe("true");
  expect(params[1]!.parallel_leader_input).toBe("false");
  expect(params[2]!.parallel_group_input).toBeUndefined();
  expect(params[3]!.parallel_group_input).toBe(params[4]!.parallel_group_input);
  expect(params[3]!.parallel_group_input).not.toBe(params[0]!.parallel_group_input);
  for (const item of params) expect(item.evaluation_view).toBe("previous_output");
  expect(mods.find(item => item.id === "t:input")?.depends_on).toEqual(["a:input", "b:input"]);
  expect(mods.find(item => item.id === "c:input")?.depends_on).toEqual(["t:input"]);
});

it("Rank Mode runs local and model read-only checks in the same content segment", () => {
  const steps = [step("local", "block"), step("model", "block", true), step("next", "block")];
  const mods = modules(steps);
  scheduleRankedChecks(steps, mods);
  const params = steps.map(item => Object.fromEntries(item.parameters));
  expect(params[0]!.parallel_group_input).toBe(params[1]!.parallel_group_input);
  expect(params[0]!.parallel_group_input).toBe(params[2]!.parallel_group_input);
  expect(params[0]!.execution_stage_input).toBe("local");
  expect(params[1]!.execution_stage_input).toBe("model");
});

it("Rank Mode treats an unknown-to-Transform fallback as a segment barrier", () => {
  const steps = [step("a", "allow"), step("b", "allow"), step("c", "block")];
  steps[1]!.parameters.push(["on_unknown", "transform"]);
  const mods = modules(steps);
  scheduleRankedChecks(steps, mods);
  const params = steps.map(item => Object.fromEntries(item.parameters));
  expect(params[0]!.parallel_group_input).toBeUndefined();
  expect(params[1]!.parallel_group_input).toBeUndefined();
  expect(params[2]!.parallel_group_input).toBeUndefined();
});
