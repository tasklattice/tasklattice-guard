import type { RouterRolloutState } from "./router-lifecycle.js";
import { z } from "zod";

export const selectorOperators = ["equals", "not_equals", "in", "not_in", "contains", "starts_with", "glob", "exists", "not_exists"] as const;
export type SelectorCondition = {
  field: string; key?: string | undefined; requestSource?: "endpoint_request" | "business_request" | undefined;
  operator: typeof selectorOperators[number]; value: string | string[]; caseSensitive?: boolean | undefined; valueType?: "string" | undefined;
};
export type SelectorExpression = { combinator: "and" | "or"; conditions: Array<SelectorCondition | SelectorExpression> };
export type RequestSource = "endpoint_request" | "business_request";
export const routingLimits = { maxDepth: 3, maxConditions: 16, maxFields: 128, maxValues: 64, maxValueLength: 2048, maxInputCharacters: 65536 } as const;
export const sensitiveHeaders = new Set(["authorization", "cookie", "proxy-authorization", "x-api-key"]);
const headerName = /^[!#$%&'*+.^_`|~0-9a-z-]+$/i;
const safeKey = z.string().min(1).max(160).refine(k => !["__proto__", "prototype", "constructor"].includes(k));
const inputValue = z.string().max(routingLimits.maxValueLength);
const inputValues = z.array(inputValue).max(routingLimits.maxValues);
function boundedRecord<T extends z.ZodType>(value: T) {
  return z.unknown().superRefine((raw, ctx) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const keys = Object.keys(raw);
    if (keys.length > routingLimits.maxFields) ctx.addIssue({ code: "custom", message: "Too many routing fields" });
    if (keys.some(k => !safeKey.safeParse(k).success)) ctx.addIssue({ code: "custom", message: "Invalid routing field key" });
  }).pipe(z.record(safeKey, value));
}
const requestInputSchema = boundedRecord(inputValues).superRefine((request, ctx) => {
  for (const key of Object.keys(request)) {
    if (![":method", ":host", ":path"].includes(key) && !headerName.test(key)) ctx.addIssue({ code: "custom", path: [key], message: "Invalid Header name" });
  }
}).transform((request, ctx) => {
  const normalized: Record<string, string[]> = Object.create(null);
  for (const [key, values] of Object.entries(request)) {
    const name = key.toLowerCase();
    if (sensitiveHeaders.has(name)) continue;
    normalized[name] = [...(normalized[name] ?? []), ...values];
    if (normalized[name]!.length > routingLimits.maxValues) ctx.addIssue({ code: "custom", path: [key], message: "Too many repeated Header values" });
  }
  return normalized;
});
export const routingInputSchema = z.object({
  endpointId: z.string().min(1).max(128),
  fields: boundedRecord(z.union([inputValue, inputValues])),
  endpoint_request: requestInputSchema.optional(), business_request: requestInputSchema.optional(),
  // Adapters must report failed extraction instead of dropping values and returning partial input.
  extractionErrors: z.array(z.string().min(1).max(256)).max(16).optional(),
}).strict().superRefine((input, ctx) => {
  let size = input.endpointId.length;
  for (const record of [input.fields, input.endpoint_request, input.business_request]) {
    for (const [key, value] of Object.entries(record ?? {})) size += key.length + (Array.isArray(value) ? value.reduce((n, v) => n + v.length, 0) : value.length);
  }
  if (size > routingLimits.maxInputCharacters) ctx.addIssue({ code: "custom", message: "Routing input exceeds extraction limit" });
});
export type RoutingInput = z.infer<typeof routingInputSchema>;
export const selectorConditionSchema = z.object({
  field: z.string().min(1).max(160), key: safeKey.optional(),
  requestSource: z.enum(["endpoint_request", "business_request"]).optional(),
  operator: z.enum(selectorOperators), value: z.union([inputValue, inputValues]).default(""),
  valueType: z.literal("string").optional(), caseSensitive: z.boolean().default(true),
}).strict().transform(c => c.field === "http.header" && c.key !== undefined ? { ...c, key: c.key.toLowerCase() } : c);
// A finite schema rejects excessive depth before recursive parsing can exhaust the stack.
function expressionSchema(depth: number): z.ZodType<SelectorExpression> {
  return z.object({
    combinator: z.enum(["and", "or"]),
    conditions: z.array(depth === routingLimits.maxDepth ? selectorConditionSchema : z.union([selectorConditionSchema, expressionSchema(depth + 1)])).max(routingLimits.maxConditions),
  }).strict();
}
export const selectorExpressionSchema = expressionSchema(1).superRefine((expression, ctx) => {
  const count = (g: SelectorExpression): number => g.conditions.reduce((n, c) => n + ("conditions" in c ? count(c) : 1), 0);
  if (count(expression) > routingLimits.maxConditions) ctx.addIssue({ code: "custom", message: "Maximum 16 conditions" });
});
export const targetSchema = z.object({ id: z.string().min(1).max(128), guardrailId: z.string().min(1).max(128), guardrailVersion: z.string().max(128), versionStrategy: z.enum(["latest", "pinned"]).optional(), weightBps: z.number().int().min(0).max(10000) }).strict();
export const routeSchema = z.object({
  id: z.string().min(1).max(128), name: z.string().trim().min(1).max(160), kind: z.enum(["normal", "fallback"]), enabled: z.boolean(),
  selector: z.object({ expression: selectorExpressionSchema }).strict(),
  targets: z.array(targetSchema).max(32),
}).strict();
export const routerDraftSchema = z.object({ routes: z.array(routeSchema).min(1).max(128) }).strict();
export type RouteTarget = z.infer<typeof targetSchema>;
export type TrafficRoute = z.infer<typeof routeSchema>;
export type RouterDraft = z.infer<typeof routerDraftSchema>;
export type TrafficRouter = {
  id: string; name: string; description: string; draftRevision: number; draft: RouterDraft; activeRevision: number | null;
  activeDraftRevision: number | null; activeSnapshot: RouterDraft | null; desiredGeneration: number;
  rolloutStatus: RouterRolloutState; endpointIds: string[]; updatedAt: string;
};
export type SelectorField = { id: string; label: string; group: string; customKey?: boolean; http?: boolean; cardinality: "one" | "many"; operators: readonly string[]; valueType?: "string"; availableAt?: "first_assignment"; sourceDescription?: string };
const strings = selectorOperators;
export const selectorFields: SelectorField[] = [
  ...["protocol", "endpoint.id", "auth.principal", "model", "output.sink", "output.content_type", "output.schema_id", "tool.name", "target.environment", "litellm.api_key_alias", "litellm.team_id", "litellm.user_id", "a2a.version", "a2a.extensions", "a2a.operation", "a2a.context_id", "a2a.task_id"].map(id => ({ id, label: id, group: id.split(".")[0]!, cardinality: "one" as const, operators: strings })),
  ...["http.method", "http.host", "http.path"].map(id => ({ id, label: id, group: "http", http: true, cardinality: "one" as const, operators: strings })),
  { id: "http.header", label: "HTTP Header", group: "http", customKey: true, http: true, cardinality: "many", operators: strings },
  { id: "auth.jwt_claim", label: "JWT Claim", group: "auth", customKey: true, cardinality: "one", operators: strings },
  { id: "adapter.field", label: "Request attribute", group: "request", customKey: true, cardinality: "one", operators: strings },
];
export function routingIssues(draft: RouterDraft, publish = false): string[] {
  const parsed = routerDraftSchema.safeParse(draft);
  if (!parsed.success) return parsed.error.issues.map(issue => `schema: ${issue.path.join(".")}: ${issue.message}`);
  draft = parsed.data;
  const errors: string[] = [], ids = new Set<string>();
  let fallbacks = 0;
  for (const [index, route] of draft.routes.entries()) {
    const prefix = route.name;
    if (ids.has(route.id)) errors.push(`${prefix}: duplicate Route ID`); ids.add(route.id);
    if (route.kind === "fallback") {
      fallbacks++;
      if (publish && (route.targets.length !== 1 || route.targets[0]?.weightBps !== 10000)) errors.push(`${prefix}: Fallback requires exactly one Target at 100%`);
      if (index !== draft.routes.length - 1 || !route.enabled || route.selector.expression.conditions.length || route.selector.expression.combinator !== "and") errors.push(`${prefix}: Fallback must be enabled, unconditional and last`);
    } else if (publish && !route.selector.expression.conditions.length) errors.push(`${prefix}: add a Traffic Selector`);
    let leaves = 0;
    function visit(group: SelectorExpression, depth: number) {
      if (depth > 3) errors.push(`${prefix}: maximum Selector depth is 3`);
      if (publish && !group.conditions.length && route.kind !== "fallback") errors.push(`${prefix}: empty condition group`);
      for (const condition of group.conditions) {
        if ("conditions" in condition) { visit(condition, depth + 1); continue; }
        leaves++;
        const field = selectorFields.find(f => f.id === condition.field);
        if (!field) { errors.push(`${prefix}: unknown field ${condition.field}`); continue; }
        if (field.customKey && !condition.key?.trim()) errors.push(`${prefix}: field key is required`);
        if (!field.customKey && condition.key !== undefined) errors.push(`${prefix}: field does not accept a key`);
        if (!field.http && condition.requestSource !== undefined) errors.push(`${prefix}: field does not accept an HTTP request source`);
        if (field.http && !condition.requestSource) errors.push(`${prefix}: choose the HTTP request source`);
        if (condition.field === "http.header" && (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(condition.key ?? "") || sensitiveHeaders.has((condition.key ?? "").toLowerCase()))) errors.push(`${prefix}: invalid or credential Header`);
        if (["in", "not_in"].includes(condition.operator) && (!Array.isArray(condition.value) || !condition.value.length)) errors.push(`${prefix}: enter a nonempty value list`);
        if (!["in", "not_in"].includes(condition.operator) && Array.isArray(condition.value)) errors.push(`${prefix}: this operator needs a single value`);
      }
    }
    visit(route.selector.expression, 1);
    if (leaves > 16) errors.push(`${prefix}: maximum 16 conditions`);
    const targetIds = new Set<string>(), refs = new Set<string>();
    for (const t of route.targets) {
      if (targetIds.has(t.id)) errors.push(`${prefix}: duplicate Target ID`); targetIds.add(t.id);
      const ref = JSON.stringify([t.guardrailId, t.versionStrategy === "latest" ? "latest" : t.guardrailVersion]);
      if (refs.has(ref)) errors.push(`${prefix}: duplicate Guardrail Version`); refs.add(ref);
      if (publish && t.versionStrategy !== "latest" && (!t.guardrailVersion.trim() || t.guardrailVersion.toLowerCase() === "latest")) errors.push(`${prefix}: pin a Guardrail Version`);
    }
    if (publish && (!route.targets.length || route.targets.reduce((sum, t) => sum + t.weightBps, 0) !== 10000)) errors.push(`${prefix}: target percentages must total 100%`);
  }
  if (fallbacks !== 1) errors.push("Router requires exactly one Fallback Route");
  return errors;
}
export type SelectorCapability = {
  field: string; key?: string; requestSource?: RequestSource;
  availableAt: "first_assignment" | "output"; cardinality: "one" | "many"; valueType: "string";
};
export type SelectorEndpoint = { id: string; adapter: string; selectorCapabilities?: SelectorCapability[] };
/** Explicit declarations are authoritative, including an empty list. */
export function endpointSelectorCapabilities(endpoint: SelectorEndpoint): SelectorCapability[] {
  if (endpoint.selectorCapabilities !== undefined) return endpoint.selectorCapabilities;
  const adapter = endpoint.adapter.toUpperCase();
  return selectorFields.flatMap(field => {
    if (field.id.startsWith("litellm.") && adapter !== "LITELLM" || field.id.startsWith("a2a.") && adapter !== "A2A") return [];
    // Dynamic keys and output descriptors need explicit first-assignment declarations.
    if (["adapter.field", "auth.jwt_claim"].includes(field.id) || field.id.startsWith("output.")) return [];
    const base = { field: field.id, availableAt: "first_assignment" as const, cardinality: field.cardinality, valueType: "string" as const };
    return field.http ? ["endpoint_request", ...(["HTTP", "LITELLM"].includes(adapter) ? ["business_request"] : [])].map(requestSource => ({ ...base, requestSource: requestSource as RequestSource })) : [base];
  });
}
export function selectorFieldCatalog(endpoints: SelectorEndpoint[]) {
  return selectorFields.map(field => ({ ...field, valueType: "string" as const,
    sourceDescription: field.http ? "Explicit endpoint_request or business_request; never merged or inferred" : "Authenticated identity or adapter-extracted first-assignment field",
    availability: endpoints.flatMap(endpoint => endpointSelectorCapabilities(endpoint).filter(c => c.field === field.id).map(c => ({ ...c, endpointId: endpoint.id }))),
    availableEndpoints: endpoints.filter(endpoint => endpointSelectorCapabilities(endpoint).some(c => c.field === field.id && c.availableAt === "first_assignment")).map(e => e.id),
  }));
}
export function capabilityIssues(draft: RouterDraft, endpoints: SelectorEndpoint[]): string[] {
  const parsed = routerDraftSchema.safeParse(draft);
  if (!parsed.success) return parsed.error.issues.map(issue => `schema: ${issue.path.join(".")}: ${issue.message}`);
  const errors: string[] = [];
  for (const route of parsed.data.routes) {
    const scoped = endpoints;
    function visit(g: SelectorExpression, path: string) {
      for (const [index, c] of g.conditions.entries()) {
        const location = `${path}.conditions.${index}`;
        if ("conditions" in c) { visit(c, location); continue; }
        for (const e of scoped) {
          const supported = endpointSelectorCapabilities(e).some(cap => cap.field === c.field && cap.requestSource === c.requestSource &&
            cap.availableAt === "first_assignment" && cap.valueType === "string" && (c.field === "http.header" ? cap.key === undefined || cap.key.toLowerCase() === c.key : cap.key === c.key));
          if (!supported) errors.push(`${route.name}: ${e.id} does not supply ${c.field}${c.key ? ` [${c.key}]` : ""}${c.requestSource ? ` from ${c.requestSource}` : ""} at first_assignment (${location})`);
        }
      }
    }
    visit(route.selector.expression, "selector.expression");
  }
  return [...new Set(errors)];
}
export class RoutingEvaluationError extends Error {
  constructor(public readonly code: "routing_input_error" | "selector_expression_error", message: string) {
    super(message); this.name = "RoutingEvaluationError";
  }
}
function checkedInput(input: RoutingInput): RoutingInput {
  const parsed = routingInputSchema.safeParse(input);
  if (!parsed.success || parsed.data.extractionErrors?.length) throw new RoutingEvaluationError("routing_input_error", "Routing input is malformed or extraction failed");
  return parsed.data;
}
function checkedExpression(expression: SelectorExpression, allowEmpty = false): SelectorExpression {
  const parsed = selectorExpressionSchema.safeParse(expression);
  if (!parsed.success) throw new RoutingEvaluationError("selector_expression_error", "Invalid Selector structure or limits");
  const visit = (group: SelectorExpression, root: boolean) => {
    if (!group.conditions.length && !(root && allowEmpty && group.combinator === "and")) throw new RoutingEvaluationError("selector_expression_error", "Empty Selector group");
    for (const c of group.conditions) {
      if ("conditions" in c) { visit(c, false); continue; }
      const field = selectorFields.find(f => f.id === c.field);
      if (!field || (field.customKey && !c.key?.trim()) || (!field.customKey && c.key !== undefined) ||
        (field.http ? !c.requestSource : c.requestSource !== undefined) ||
        (c.field === "http.header" && (!headerName.test(c.key ?? "") || sensitiveHeaders.has(c.key!))) ||
        (["in", "not_in"].includes(c.operator) ? !Array.isArray(c.value) || !c.value.length : Array.isArray(c.value))) {
        throw new RoutingEvaluationError("selector_expression_error", `Invalid condition for ${c.field}`);
      }
    }
  };
  visit(parsed.data, true);
  return parsed.data;
}
const fold = (s: string) => s.replace(/[A-Z]/g, c => c.toLowerCase());
// Dynamic programming avoids regex backtracking. '?' consumes one Unicode code point.
function glob(pattern: string, actual: string): boolean {
  const tokens: Array<{ kind: "star" | "any" | "literal"; value: string }> = [];
  const chars = Array.from(pattern);
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (c === "\\") tokens.push({ kind: "literal", value: chars[++i] ?? "\\" });
    else if (c !== "*" || tokens.at(-1)?.kind !== "star") tokens.push({ kind: c === "*" ? "star" : c === "?" ? "any" : "literal", value: c });
  }
  let previous = new Uint8Array(tokens.length + 1); previous[0] = 1;
  for (let j = 1; j <= tokens.length; j++) previous[j] = tokens[j - 1]!.kind === "star" ? previous[j - 1]! : 0;
  for (const c of actual) {
    const next = new Uint8Array(tokens.length + 1);
    for (let j = 1; j <= tokens.length; j++) {
      const token = tokens[j - 1]!;
      next[j] = token.kind === "star" ? (next[j - 1]! | previous[j]!) : (token.kind === "any" || token.value === c) ? previous[j - 1]! : 0;
    }
    previous = next;
  }
  return previous[tokens.length] === 1;
}
const own = <T>(record: Record<string, T>, key: string): T | undefined => Object.hasOwn(record, key) ? record[key] : undefined;
export type ConditionEvaluation = { matched: boolean; reason: "source_unavailable" | "missing" | "present" | "matched" | "value_mismatch" };
function conditionResult(c: SelectorCondition, input: RoutingInput): ConditionEvaluation {
  let raw: string | string[] | undefined;
  if (c.field.startsWith("http.")) {
    const source = input[c.requestSource!];
    if (!source) return { matched: false, reason: "source_unavailable" };
    raw = own(source, c.field === "http.header" ? c.key!.toLowerCase() : `:${c.field.slice(5)}`);
  } else raw = c.field === "endpoint.id" ? input.endpointId : own(input.fields, c.field === "adapter.field" ? c.key! : c.field === "auth.jwt_claim" ? `auth.jwt_claim.${c.key}` : c.field);
  if (Array.isArray(raw) && !raw.length) raw = undefined;
  if (c.operator === "exists") return { matched: raw !== undefined, reason: raw === undefined ? "missing" : "present" };
  if (c.operator === "not_exists") return { matched: raw === undefined, reason: raw === undefined ? "missing" : "present" };
  if (raw === undefined) return { matched: false, reason: "missing" };
  const values = (Array.isArray(raw) ? raw : [raw]).map(s => c.caseSensitive === false ? fold(s) : s);
  const expected = (Array.isArray(c.value) ? c.value : [c.value]).map(s => c.caseSensitive === false ? fold(s) : s);
  const positive = (v: string) => c.operator === "contains" ? v.includes(expected[0]!) : c.operator === "starts_with" ? v.startsWith(expected[0]!) : c.operator === "glob" ? glob(expected[0]!, v) : expected.includes(v);
  const matched = ["not_equals", "not_in"].includes(c.operator) ? values.every(v => !positive(v)) : values.some(positive);
  return { matched, reason: matched ? "matched" : "value_mismatch" };
}
export function evaluateCondition(c: SelectorCondition, input: RoutingInput): ConditionEvaluation {
  const expression = checkedExpression({ combinator: "and", conditions: [c] });
  return conditionResult(expression.conditions[0] as SelectorCondition, checkedInput(input));
}
export type SelectorEvaluation = { matched: boolean; children: Array<SelectorEvaluation | (ConditionEvaluation & { field: string; key?: string | undefined; requestSource?: RequestSource | undefined })> };
function selectorResult(expression: SelectorExpression, input: RoutingInput): SelectorEvaluation {
  const children = expression.conditions.map(c => "conditions" in c ? selectorResult(c, input) : { field: c.field, key: c.key, requestSource: c.requestSource, ...conditionResult(c, input) });
  return { matched: expression.combinator === "and" ? children.every(c => c.matched) : children.some(c => c.matched), children };
}
export function evaluateSelector(expression: SelectorExpression, input: RoutingInput): SelectorEvaluation {
  return selectorResult(checkedExpression(expression), checkedInput(input));
}
export function previewRouter(draft: RouterDraft, input: RoutingInput) {
  const issues = routingIssues(draft);
  if (issues.length) throw new RoutingEvaluationError("selector_expression_error", issues.join("; "));
  input = checkedInput(input);
  let selected: string | null = null;
  return draft.routes.map(route => {
  const applies = route.enabled;
    // Independent results are explanatory only; all applicable rows after the winner are skipped online.
    const result = applies ? selectorResult(checkedExpression(route.selector.expression, route.kind === "fallback"), input) : { matched: false, children: [] };
    const independentMatch = applies && result.matched;
    const blockedBy = applies ? selected : null;
    const received = independentMatch && selected === null;
    if (received) selected = route.id;
    return { routeId: route.id, independentMatch, received, blockedBy, state: !applies ? "not_applicable" : blockedBy !== null ? "not_evaluated" : received ? "selected" : "not_matched", ...result };
  });
}
