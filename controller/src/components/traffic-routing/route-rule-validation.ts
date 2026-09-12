import type { TrafficRoute } from "@/lib/traffic-routing-api";
import { routingIssues } from "../../../shared/traffic-routing";
export function ruleErrors(route: TrafficRoute): string[] {
  const fallback: TrafficRoute = {
    id: "validation-fallback",
    name: "Fallback",
    kind: "fallback",
    enabled: true,
    selector: { expression: { combinator: "and", conditions: [] } },
    targets: [
      {
        id: "validation-target",
        guardrailId: "validation",
        guardrailVersion: "validation",
        weightBps: 10000,
      },
    ],
  };
  const simple = [
    !route.name.trim() && "Enter a rule name.",
    !route.targets.length && "Choose a GuardRail.",
    route.targets.some((t) => !t.guardrailId) &&
      "Choose a GuardRail for every target.",
  ].filter((s): s is string => Boolean(s));
  if (simple.length) return simple;
  return [
    ...new Set(
      routingIssues(
        { routes: route.kind === "fallback" ? [route] : [route, fallback] },
        true,
      ).map((e) =>
        e
          .replace(`${route.name}: `, "")
          .replace(/^schema:.*?: /, "Invalid value: "),
      ),
    ),
  ];
}
