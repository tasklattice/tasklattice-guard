import { useTranslation } from "react-i18next";
import { Braces, GitBranch, ShieldCheck } from "lucide-react";

import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import type { PathTestRecord } from "./use-path-workbench";

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const rows = (value: unknown) =>
  Array.isArray(value) ? value.map(object) : [];
export function PathTestResult({
  item,
  guardrailNames,
}: {
  item: PathTestRecord;
  guardrailNames: Record<string, string>;
}) {
  const { t } = useTranslation();
  const body = item.result?.body ?? {};
  const decision = object(body.decision);
  const assignment = object(
    body.assignment ?? body.route_assignment ?? decision.route_assignment,
  );
  const guardrail = String(
    assignment.guardrailId ?? body.guardrail_id ?? decision.guardrail_id ?? "",
  );
  const version = String(
    assignment.guardrailVersion ??
      body.guardrail_version ??
      decision.guardrail_version ??
      "",
  );
  const name = guardrailNames[guardrail] ?? guardrail;
  const rules = rows(body.rules);
  const selected = rules.find((row) => row.routeId === assignment.routeId);
  const failed = Boolean(
    item.error || (item.result && item.result.status >= 400),
  );
  const outcome =
    typeof body.decision === "string"
      ? body.decision
      : (decision.decision ?? body.action ?? object(body.result).outcome);
  const detail =
    typeof body.detail === "string" ? body.detail : (object(body.detail).reason ?? object(body.detail).message);
  const defaultTab =
    item.input.target === "router" && !failed ? "routing" : "evaluation";
  const stateLabel = (state: unknown) =>
    ({
      selected: t("routing.selected"),
      not_matched: t("routing.notMatched"),
      not_evaluated: t("routing.notEvaluated"),
      not_applicable: t("routing.notApplicable"),
    })[String(state)] ?? String(state ?? "");
  return (
    <article className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-1 border-b px-4 py-3" role="status">
        <p
          className={`break-words text-sm font-semibold ${failed ? "text-destructive" : ""}`}
        >
          {failed
            ? item.error
              ? t("routing.testFailed")
              : `HTTP ${item.result?.status}`
            : outcome
              ? `${t("routing.decision")}: ${String(outcome)}`
              : guardrail
                ? `${t("routing.routedTo")} ${name} · ${version}`
                : t("routing.draftMatchingComplete")}
        </p>
        {failed && (
          <p className="break-words text-sm text-destructive">
            {item.error ??
              String(
                detail ??
                  t("routing.requestFailedInspectTheRawResponse"),
              )}
          </p>
        )}
        {Boolean(outcome) && guardrail && (
          <p className="text-sm">
            {name} · {version}
          </p>
        )}
        <p className="break-words text-xs text-muted-foreground">
          {item.label} · {item.configuration}
          {body.runnerId ? ` · Runner: ${String(body.runnerId)}` : ""}
          {item.result ? ` · ${item.result.durationMs} ms` : ""}
          {body.simulation
            ? ` · ${t("routing.matchingOnlyNoEvaluation")}`
            : ""}
        </p>
      </div>
      <Tabs defaultValue={defaultTab} className="min-h-0 flex-1 gap-0">
        <TabsList
          className="mx-3 shrink-0"
          aria-label={t("routing.testResults")}
        >
          <TabsTrigger value="routing"><GitBranch aria-hidden="true" className="size-4" />{t("routing.routing")}</TabsTrigger>
          <TabsTrigger value="evaluation"><ShieldCheck aria-hidden="true" className="size-4" />
            {t("routing.evaluation")}
          </TabsTrigger>
          <TabsTrigger value="raw"><Braces aria-hidden="true" className="size-4" />{t("routing.rawResponse")}</TabsTrigger>
        </TabsList>
        <TabsContent
          value="routing"
          className="min-h-0 space-y-4 overflow-auto p-4"
        >
          {assignment.routerId ? (
            <p className="break-words text-sm">
              {String(assignment.endpointId ?? "")} →{" "}
              {String(assignment.routerId)} · r
              {String(assignment.routerRevision)} → {String(assignment.routeId)}{" "}
              → {name}
            </p>
          ) : null}
          {body.pinned === true && (
            <p className="text-sm">
              {t("routing.reusedThePinnedRouteForThisCallIDGenerate")}
            </p>
          )}
          {rules.length ? (
            <div
              role="table"
              aria-label={t("routing.ruleMatching")}
              className="text-sm"
            >
              <div
                role="row"
                className="grid grid-cols-[minmax(0,1fr)_6rem_minmax(0,2fr)] gap-3 border-b pb-2 text-xs text-muted-foreground"
              >
                <span role="columnheader">{t("routing.rule")}</span>
                <span role="columnheader">{t("routing.result")}</span>
                <span role="columnheader">{t("routing.reason")}</span>
              </div>
              {rules.map((rule, index) => (
                <div
                  role="row"
                  key={String(rule.routeId ?? index)}
                  className="grid grid-cols-[minmax(0,1fr)_6rem_minmax(0,2fr)] gap-3 border-b py-3"
                >
                  <span role="cell" className="break-words font-medium">
                    {String(rule.name ?? rule.routeId)}
                  </span>
                  <span role="cell">{stateLabel(rule.state)}</span>
                  <div
                    role="cell"
                    className="break-words text-xs leading-5 text-muted-foreground"
                  >
                    {rule.state === "not_evaluated" ? (
                      t("routing.anEarlierRuleReceivedTheRequest")
                    ) : rule.state === "not_applicable" ? (
                      t("routing.disabledOrOutsideTheEndpointScope")
                    ) : rows(rule.children).length ? (
                      <Conditions conditions={rows(rule.children)} />
                    ) : (
                      t("routing.noAdditionalConditions")
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {assignment.routerId
                ? t("routing.theEndpointReturnedTheActualAssignmentUseRouterMode")
                : t("routing.noRouteAssignmentWasReturned")}
            </p>
          )}
          {(selected || Array.isArray(body.candidates)) && (
            <div className="space-y-2 text-sm">
              <p className="font-medium">
                {Array.isArray(body.candidates)
                  ? t("routing.draftCandidatesNotAssigned")
                  : t("routing.targetAllocation")}
              </p>
              {rows(selected?.targets ?? body.candidates).map(
                (target, index) => (
                  <p key={index} className="break-words">
                    {guardrailNames[String(target.guardrailId)] ??
                      String(target.guardrailId)}{" "}
                    ·{" "}
                    {String(
                      target.guardrailVersion ?? target.versionStrategy ?? "",
                    )}{" "}
                    · {Number(target.weightBps) / 100}%
                    {target.guardrailId === guardrail &&
                    target.guardrailVersion === version
                      ? ` · ${t("routing.selected")}`
                      : ""}
                  </p>
                ),
              )}
            </div>
          )}
        </TabsContent>
        <TabsContent
          value="evaluation"
          className="min-h-0 space-y-3 overflow-auto p-4"
        >
          {body.simulation ? (
            <p>
              {t("routing.thisRequestOnlyCheckedRoutingNoGuardRailWasExecuted")}
            </p>
          ) : failed ? (
            <p>
              {t("routing.theRequestFailedEvaluationCompletionIsNotConfirmedCorrect")}
            </p>
          ) : (
            <>
              <p className="text-sm">
                {t("routing.decision")}:{" "}
                <strong>{String(outcome ?? "—")}</strong>
              </p>
              {["action", "reason"].map((key) => {
                const value = decision[key] ?? body[key];
                return value !== undefined && value !== null ? (
                  <p key={key} className="break-words text-sm">
                    {key}: {String(value)}
                  </p>
                ) : null;
              })}
              {rows(decision.findings ?? body.findings).map((finding, i) => (
                <p key={i} className="break-words text-sm">
                  {String(
                    finding.title ?? finding.rule_id ?? finding.policy_id ?? "",
                  )}{" "}
                  {String(finding.evidence ?? finding.reason ?? "")}
                </p>
              ))}
              <p className="text-xs text-muted-foreground">
                {item.input.target === "endpoint"
                  ? t("routing.executedThroughTheRunnerEndpointExternalIngressTLSIs")
                  : t("routing.runnerEvaluatedTheBodyAsInputEndpointAuthenticationIs")}
              </p>
            </>
          )}
        </TabsContent>
        <TabsContent value="raw" className="min-h-0 overflow-auto p-4">
          <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-6">
            {JSON.stringify(
              item.result?.body ?? { error: item.error },
              null,
              2,
            )}
          </pre>
        </TabsContent>
      </Tabs>
    </article>
  );
}
function Conditions({ conditions }: { conditions: Record<string, unknown>[] }) {
  const { t } = useTranslation();
  return (
    <ul className="space-y-1">
      {conditions.map((condition, index) => (
        <li key={index}>
          {Array.isArray(condition.children) ? (
            <div className="border-l pl-2">
              <span>
                {String(condition.combinator ?? t("routing.conditionGroup"))}
              </span>
              <Conditions conditions={rows(condition.children)} />
            </div>
          ) : (
            <span>
              {condition.matched ? "✓ " : "× "}
              {String(condition.key || condition.field)}{" "}
              {String(condition.operator ?? condition.reason ?? "")}{" "}
              {condition.value !== undefined ? String(condition.value) : ""}
              {condition.request_source || condition.requestSource
                ? ` (${String(condition.request_source ?? condition.requestSource)})`
                : ""}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
