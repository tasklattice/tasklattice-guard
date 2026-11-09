import i18n from "@/i18n";
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
    !route.name.trim() && i18n.t("routing.enterRuleName"),
    !route.targets.length && i18n.t("routing.chooseGuardrail"),
    route.targets.some((t) => !t.guardrailId) &&
      i18n.t("routing.chooseEveryGuardrail"),
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
