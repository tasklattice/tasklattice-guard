import { describe, expect, it } from "vitest";
import {
  capabilityIssues, evaluateCondition, evaluateSelector, previewRouter, routerDraftSchema,
  routingInputSchema, routingIssues, selectorConditionSchema, selectorExpressionSchema,
  selectorFieldCatalog, type RouterDraft, type RoutingInput, type SelectorCondition,
  type SelectorExpression, type TrafficRoute,
} from "./traffic-routing.js";

const header = (changes: Partial<SelectorCondition> = {}): SelectorCondition => ({
  field: "http.header", key: "X-Channel", requestSource: "business_request", operator: "equals", value: "partner", ...changes,
});
const group = (...conditions: SelectorExpression["conditions"]): SelectorExpression => ({ combinator: "and", conditions });
const input = (values: string[] = ["partner"]): RoutingInput => ({ endpointId: "http", fields: {}, business_request: { "X-Channel": values } });
const route = (id: string, expression = group(header())): TrafficRoute => ({
  id, name: id, kind: "normal", enabled: true, selector: { expression },
  targets: [{ id: `${id}-a`, guardrailId: "a", guardrailVersion: "v1", weightBps: 10000 }],
});
const fallback = (): TrafficRoute => ({ ...route("fallback", group()), kind: "fallback" });
const draft = (...routes: TrafficRoute[]): RouterDraft => ({ routes: [...routes, fallback()] });

describe("Header contract", () => {
  it("normalizes saved names and combines casing variants without mutating or splitting values", () => {
    expect(selectorConditionSchema.parse(header()).key).toBe("x-channel");
    const sample = input(["partner,internal"]);
    sample.business_request!["x-channel"] = ["internal"];
    const parsed = routingInputSchema.parse(sample);
    expect(parsed.business_request!["x-channel"]).toEqual(["partner,internal", "internal"]);
    expect(sample.business_request!["X-Channel"]).toEqual(["partner,internal"]);
    expect(evaluateCondition(header(), sample).matched).toBe(false);
    expect(evaluateCondition(header({ value: "internal" }), sample).matched).toBe(true);
  });
  it("never defaults, merges or falls back between HTTP sources", () => {
    const sample = { ...input(), endpoint_request: { "x-channel": ["internal"] } };
    expect(evaluateCondition(header(), sample).matched).toBe(true);
    expect(evaluateCondition(header({ requestSource: "endpoint_request" }), sample).matched).toBe(false);
    expect(() => evaluateCondition(header({ requestSource: undefined }), sample)).toThrow(expect.objectContaining({ code: "selector_expression_error" }));
    expect(evaluateCondition(header({ operator: "not_exists" }), { endpointId: "http", fields: {}, endpoint_request: sample.endpoint_request })).toEqual({ matched: false, reason: "source_unavailable" });
  });
  it.each([undefined, []])("treats %j as missing without vacuous negative matches", values => {
    const sample = input(); sample.business_request = values === undefined ? {} : { "x-channel": values };
    for (const operator of ["equals", "not_equals", "in", "not_in", "contains", "starts_with", "glob", "exists"] as const) {
      expect(evaluateCondition(header({ operator, value: ["in", "not_in"].includes(operator) ? ["partner"] : "" }), sample)).toEqual({ matched: false, reason: "missing" });
    }
    expect(evaluateCondition(header({ operator: "not_exists" }), sample).matched).toBe(true);
  });
  it("distinguishes empty strings from missing and preserves whitespace", () => {
    expect(evaluateCondition(header({ operator: "exists" }), input([""])).matched).toBe(true);
    expect(evaluateCondition(header({ value: "" }), input([""])).matched).toBe(true);
    expect(evaluateCondition(header(), input([" partner "])).matched).toBe(false);
  });
  it("uses existential positives, universal negatives, and permits different values to satisfy AND", () => {
    const sample = input(["partner", "internal"]);
    expect(evaluateSelector(group(header(), header({ value: "internal" })), sample).matched).toBe(true);
    expect(evaluateCondition(header({ operator: "not_equals" }), sample).matched).toBe(false);
    expect(evaluateCondition(header({ operator: "not_in", value: ["other"] }), sample).matched).toBe(true);
  });
  it("folds only ASCII and never coerces Header strings", () => {
    expect(evaluateCondition(header(), input(["PARTNER"])).matched).toBe(false);
    expect(evaluateCondition(header({ caseSensitive: false }), input(["PARTNER"])).matched).toBe(true);
    expect(evaluateCondition(header({ caseSensitive: false, value: "ä" }), input(["Ä"])).matched).toBe(false);
    expect(evaluateCondition(header({ value: "1" }), input(["01"])).matched).toBe(false);
  });
  it("strips credentials from normalized samples and rejects their selectors", () => {
    const sample = input(); sample.business_request!.Authorization = ["secret"];
    expect(routingInputSchema.parse(sample).business_request).not.toHaveProperty("authorization");
    expect(() => evaluateCondition(header({ key: "Authorization" }), sample)).toThrow(expect.objectContaining({ code: "selector_expression_error" }));
  });
});

describe("bounded schemas and error classes", () => {
  it("bounds case-collapsed Header arrays before evaluation", () => {
    const sample = input(Array(40).fill("a")); sample.business_request!["x-channel"] = Array(40).fill("b");
    expect(routingInputSchema.safeParse(sample).success).toBe(false);
  });
  it.each([
    header({ operator: "in", value: "partner,internal" }), header({ operator: "not_in", value: [] }),
    header({ operator: "equals", value: ["partner"] }), header({ key: "bad header" }),
    { field: "model", key: "unexpected", operator: "equals", value: "x" } as SelectorCondition,
  ])("rejects invalid condition semantics", condition => {
    expect(() => evaluateCondition(condition, input())).toThrow(expect.objectContaining({ code: "selector_expression_error" }));
  });
  it("applies HTTP source rules to method, host and path", () => {
    const sample = { ...input(), business_request: { ":method": ["POST"], ":host": ["business"], ":path": ["/api"] }, endpoint_request: { ":method": ["GET"], ":host": ["guard"], ":path": ["/evaluate"] } };
    for (const [field, value] of [["http.method", "POST"], ["http.host", "business"], ["http.path", "/api"]]) {
      const condition: SelectorCondition = { field: field!, value: value!, requestSource: "business_request", operator: "equals" };
      expect(evaluateCondition(condition, sample).matched).toBe(true);
      expect(evaluateCondition({ ...condition, requestSource: "endpoint_request" }, sample).matched).toBe(false);
    }
  });
  it("separates valid JSON structure from invalid expression semantics", () => {
    const invalid = draft(route("bad", group(header({ requestSource: undefined }))));
    expect(routerDraftSchema.safeParse(invalid).success).toBe(true);
    expect(routingIssues(invalid)).toContain("bad: choose the HTTP request source");
    expect(() => previewRouter(invalid, input())).toThrow(expect.objectContaining({ code: "selector_expression_error" }));
    expect(routingIssues({ routes: "bad" } as unknown as RouterDraft)[0]).toMatch(/^schema:/);
  });
  it("rejects deep and cyclic expressions before recursively parsing an unbounded tree", () => {
    let expression = group(header());
    for (let n = 0; n < 1000; n++) expression = group(expression);
    expect(selectorExpressionSchema.safeParse(expression).success).toBe(false);
    const cycle = group(); cycle.conditions.push(cycle);
    expect(selectorExpressionSchema.safeParse(cycle).success).toBe(false);
  });
  it("enforces total leaves across groups, accepts the exact depth and leaf boundary", () => {
    expect(selectorExpressionSchema.safeParse(group(group(group(...Array.from({ length: 16 }, () => header()))))).success).toBe(true);
    expect(selectorExpressionSchema.safeParse(group(group(...Array.from({ length: 9 }, () => header())), group(...Array.from({ length: 8 }, () => header())))).success).toBe(false);
  });
  it.each([
    { fields: { model: 4 } }, { fields: { model: "x".repeat(2049) } },
    { fields: Object.fromEntries(Array.from({ length: 129 }, (_, n) => [`k${n}`, "v"])) },
    { business_request: { "x-channel": Array(65).fill("x") } },
    { business_request: { "bad header": ["x"] } },
    { fields: JSON.parse('{"__proto__":"x"}') },
    { fields: { model: Array(33).fill("x".repeat(2048)) } },
  ])("rejects malformed or oversized input %j", changes => {
    const sample = { ...input(), ...changes } as RoutingInput;
    expect(routingInputSchema.safeParse(sample).success).toBe(false);
    expect(() => previewRouter(draft(), sample)).toThrow(expect.objectContaining({ code: "routing_input_error" }));
  });
  it("propagates adapter extraction failures even for fallback-only routing", () => {
    expect(() => previewRouter(draft(), { ...input(), extractionErrors: ["headers_overflow"] })).toThrow(expect.objectContaining({ code: "routing_input_error" }));
  });
  it("keeps system Endpoint identity authoritative and custom keys literal", () => {
    const sample = { ...input(), fields: { "endpoint.id": "spoofed", "tenant.id": "a" } };
    expect(evaluateCondition({ field: "endpoint.id", operator: "equals", value: "http" }, sample).matched).toBe(true);
    expect(evaluateCondition({ field: "adapter.field", key: "tenant.id", operator: "equals", value: "a" }, sample).matched).toBe(true);
    expect(evaluateCondition({ field: "adapter.field", key: "toString", operator: "exists", value: "" }, sample).matched).toBe(false);
  });
  it("allows incomplete weights in drafts but validates immutable versions, empty groups and fallback on publish", () => {
    const config = draft(route("a", group())); config.routes[0]!.targets[0]!.weightBps = 9900;
    expect(routingIssues(config)).toEqual([]);
    expect(routingIssues(config, true).join(";")).toMatch(/Selector/);
    expect(routingIssues(config, true).join(";")).toMatch(/100%/);
    config.routes[0]!.targets[0]!.guardrailVersion = "latest";
    expect(routingIssues(config, true).join(";")).toMatch(/pin a Guardrail Version/);
    const invalidFallback = fallback(); invalidFallback.selector.expression.combinator = "or";
    expect(routingIssues({ routes: [invalidFallback] }).join(";")).toMatch(/unconditional/);
  });
});

describe("glob and boolean expressions", () => {
  it.each([
    ["p*?r", "partner", true], ["p*?r", "xpartner", false], ["\\*", "*", true],
    ["a.b", "axb", false], ["?", "😀", true], ["*", "a\nb", true],
    ["a\\", "a\\", true], ["\\?", "?", true], ["", "", true],
    ["*a".repeat(80) + "b", "a".repeat(300), false],
  ])("matches whole strings safely: %s", (pattern, actual, matched) => {
    expect(evaluateCondition(header({ operator: "glob", value: pattern }), input([actual])).matched).toBe(matched);
  });
  it("evaluates nested OR and AND and rejects empty ordinary groups", () => {
    const expression = group({ combinator: "or", conditions: [header({ value: "other" }), header()] });
    expect(evaluateSelector(expression, input()).matched).toBe(true);
    expect(() => evaluateSelector(group(group()), input())).toThrow(expect.objectContaining({ code: "selector_expression_error" }));
  });
});

describe("capabilities and exact ordered preview", () => {
  it("checks every scoped Endpoint without guessing boolean reachability", () => {
    const config = draft(route("business"));
    const endpoints = [{ id: "http", adapter: "HTTP" }, { id: "a2a", adapter: "A2A" }];
    expect(capabilityIssues(config, endpoints).join(";")).toMatch(/a2a.*business_request.*conditions.0/);
  });
  it("honors explicit stage and key declarations and exposes availability to editors", () => {
    const config = draft(route("output", group({ field: "output.sink", operator: "equals", value: "chat" })));
    const endpoint = { id: "http", adapter: "HTTP", selectorCapabilities: [{ field: "output.sink", availableAt: "output" as const, cardinality: "one" as const, valueType: "string" as const }] };
    expect(capabilityIssues(config, [endpoint])).toHaveLength(1);
    expect(selectorFieldCatalog([endpoint]).find(f => f.id === "output.sink")!.availableEndpoints).toEqual([]);
    expect(capabilityIssues(config, [{ ...endpoint, selectorCapabilities: [{ ...endpoint.selectorCapabilities[0]!, availableAt: "first_assignment" }] }])).toEqual([]);
    expect(capabilityIssues(draft(route("a")), [{ id: "http", adapter: "HTTP", selectorCapabilities: [] }])).toHaveLength(1);
  });
  it("marks every later applicable route unexecuted regardless of independent match", () => {
    const rows = previewRouter(draft(route("winner"), route("overlap"), route("different", group(header({ value: "other" })))), input());
    expect(rows.map(r => [r.independentMatch, r.received, r.state, r.blockedBy])).toEqual([
      [true, true, "selected", null], [true, false, "not_evaluated", "winner"],
      [false, false, "not_evaluated", "winner"], [true, false, "not_evaluated", "winner"],
    ]);
  });
  it("uses the Router source Endpoint and skips disabled routes", () => {
    const source = route("source", group(header({ value: "partner" })));
    const disabled = route("disabled"); disabled.enabled = false;
    const rows = previewRouter(draft(source, disabled), input());
    expect(rows.map(r => r.state)).toEqual(["selected", "not_applicable", "not_evaluated"]);
  });
});


describe("publication target contracts", () => {
  it("allows latest with empty version while undefined and explicit pinned require identities", () => {
    const value = draft(); const target = value.routes[0]!.targets[0]!;
    target.guardrailVersion = "";
    expect(routingIssues(value, true).join(";")).toContain("pin a Guardrail Version");
    target.versionStrategy = "pinned";
    expect(routingIssues(value, true).join(";")).toContain("pin a Guardrail Version");
    target.versionStrategy = "latest";
    expect(routingIssues(value, true)).toEqual([]);
  });
  it("requires one 100% fallback target and preserves fallback topology", () => {
    const value = draft(); const fallbackRoute = value.routes[0]!;
    fallbackRoute.targets.push({ ...fallbackRoute.targets[0]!, id: "b", guardrailId: "b", weightBps: 0 });
    expect(routingIssues(value)).toEqual([]);
    expect(routingIssues(value, true).join(";")).toContain("exactly one Target at 100%");
    fallbackRoute.targets.pop(); fallbackRoute.targets[0]!.weightBps = 9999;
    expect(routingIssues(value, true).join(";")).toContain("exactly one Target at 100%");
    fallbackRoute.targets[0]!.weightBps = 10000; fallbackRoute.enabled = false;
    expect(routingIssues(value, true).join(";")).toContain("Fallback must be enabled, unconditional and last");
    fallbackRoute.enabled = true; fallbackRoute.selector.expression = { combinator: "and", conditions: [{ field: "protocol", operator: "equals", value: "HTTP" }] };
    expect(routingIssues(value, true).join(";")).toContain("Fallback must be enabled, unconditional and last");
    fallbackRoute.selector.expression = group(); value.routes.push(route("after", group()));
    expect(routingIssues(value, true).join(";")).toContain("Fallback must be enabled, unconditional and last");
  });
});
