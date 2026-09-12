import { guardrailVersionId } from "../../../shared/guardrail-version";
import type {
  RouterDraft,
  TrafficRoute,
  SelectorExpression,
} from "@/lib/traffic-routing-api";

export const conditionCount = (expression: SelectorExpression): number =>
  expression.conditions.reduce(
    (n, c) => n + ("conditions" in c ? conditionCount(c) : 1),
    0,
  );
export function selectorSummary(expression: SelectorExpression): string {
  if (!expression.conditions.length) return "No matching conditions";
  return expression.conditions
    .map((c) => {
      if ("conditions" in c) return `(${selectorSummary(c)})`;
      const source =
        c.requestSource === "business_request"
          ? "Business request"
          : c.requestSource === "endpoint_request"
            ? "Endpoint request"
            : "";
      return [
        source,
        c.field,
        c.key,
        c.operator.replaceAll("_", " "),
        ["exists", "not_exists"].includes(c.operator)
          ? ""
          : JSON.stringify(c.value),
      ]
        .filter(Boolean)
        .join(" ");
    })
    .join(expression.combinator === "and" ? " AND " : " OR ");
}
type RouteChange = {
  kind: "Added" | "Updated" | "Removed";
  route: TrafficRoute;
  previous: TrafficRoute | undefined;
};
export function routingDiff(
  before: RouterDraft | null,
  after: RouterDraft,
): RouteChange[] {
  const old = before?.routes ?? [];
  return [
    ...after.routes.flatMap<RouteChange>((route, index) => {
      const previous = old.find((r) => r.id === route.id);
      if (!previous)
        return [{ kind: "Added" as const, route, previous: undefined }];
      if (
        JSON.stringify(previous) !== JSON.stringify(route) ||
        (route.kind !== "fallback" &&
          old.findIndex((r) => r.id === route.id) !== index)
      )
        return [{ kind: "Updated" as const, route, previous }];
      return [];
    }),
    ...old
      .filter((r) => !after.routes.some((next) => next.id === r.id))
      .map((route) => ({ kind: "Removed" as const, route, previous: route })),
  ];
}
export function duplicateRoute(route: TrafficRoute): TrafficRoute {
  return {
    ...structuredClone(route),
    id: crypto.randomUUID(),
    name: `${route.name} copy`,
    targets: route.targets.map((t) => ({ ...t, id: crypto.randomUUID() })),
  };
}
export function newRoute(): TrafficRoute {
  return {
    id: crypto.randomUUID(),
    name: "New Route",
    kind: "normal",
    enabled: true,
    selector: { expression: { combinator: "and", conditions: [] } },
    targets: [],
  };
}

/** UTC release label, matching GuardRail timestamp versions; sequence remains the API key. */
export function revisionLabel(revision?: { createdAt: string } | null): string {
  if (!revision) return "—";
  const date = new Date(revision.createdAt);
  if (!Number.isFinite(date.getTime())) return "—";
  return guardrailVersionId(date);
}
