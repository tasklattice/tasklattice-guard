import { useRoutingText } from "@/components/traffic-routing/form";
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
  const t = useRoutingText();
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
      : (decision.decision ?? body.action);
  const detail =
    typeof body.detail === "string" ? body.detail : object(body.detail).reason;
  const defaultTab =
    item.input.target === "router" && !failed ? "routing" : "evaluation";
  const stateLabel = (state: unknown) =>
    ({
      selected: t("已选中", "Selected"),
      not_matched: t("未命中", "Not matched"),
      not_evaluated: t("未执行", "Not evaluated"),
      not_applicable: t("不适用", "Not applicable"),
    })[String(state)] ?? String(state ?? "");
  return (
    <article className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-1 border-b px-4 py-3" role="status">
        <p
          className={`break-words text-sm font-semibold ${failed ? "text-destructive" : ""}`}
        >
          {failed
            ? item.error
              ? t("测试失败", "Test failed")
              : `HTTP ${item.result?.status}`
            : outcome
              ? `${t("检测结果", "Decision")}: ${String(outcome)}`
              : guardrail
                ? `${t("路由命中", "Routed to")} ${name} · ${version}`
                : t("草稿匹配完成", "Draft matching complete")}
        </p>
        {failed && (
          <p className="break-words text-sm text-destructive">
            {item.error ??
              String(
                detail ??
                  t(
                    "请求失败，请查看原始响应。",
                    "Request failed. Inspect the raw response.",
                  ),
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
            ? ` · ${t("仅匹配，未执行检测", "Matching only; no evaluation")}`
            : ""}
        </p>
      </div>
      <Tabs defaultValue={defaultTab} className="min-h-0 flex-1 gap-0">
        <TabsList
          className="mx-3 shrink-0"
          aria-label={t("测试结果", "Test results")}
        >
          <TabsTrigger value="routing">{t("路由分析", "Routing")}</TabsTrigger>
          <TabsTrigger value="evaluation">
            {t("检测结果", "Evaluation")}
          </TabsTrigger>
          <TabsTrigger value="raw">{t("原始响应", "Raw response")}</TabsTrigger>
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
              {t(
                "沿用了此 Call ID 的固定路由。生成新 Call ID 可以重新匹配。",
                "Reused the pinned route for this Call ID. Generate a new Call ID to match again.",
              )}
            </p>
          )}
          {rules.length ? (
            <div
              role="table"
              aria-label={t("规则匹配过程", "Rule matching")}
              className="text-sm"
            >
              <div
                role="row"
                className="grid grid-cols-[minmax(0,1fr)_6rem_minmax(0,2fr)] gap-3 border-b pb-2 text-xs text-muted-foreground"
              >
                <span role="columnheader">{t("规则", "Rule")}</span>
                <span role="columnheader">{t("结果", "Result")}</span>
                <span role="columnheader">{t("原因", "Reason")}</span>
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
                      t(
                        "前序规则已接收请求",
                        "An earlier rule received the request",
                      )
                    ) : rule.state === "not_applicable" ? (
                      t(
                        "规则未启用或来源 Endpoint 不适用",
                        "Disabled or outside the Endpoint scope",
                      )
                    ) : rows(rule.children).length ? (
                      <Conditions conditions={rows(rule.children)} />
                    ) : (
                      t("无附加条件", "No additional conditions")
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {assignment.routerId
                ? t(
                    "Endpoint 响应提供实际分配；逐条规则分析可在 Router 模式查看。",
                    "The Endpoint returned the actual assignment. Use Router mode for per-rule analysis.",
                  )
                : t(
                    "本次响应未提供路由分配。",
                    "No route assignment was returned.",
                  )}
            </p>
          )}
          {(selected || Array.isArray(body.candidates)) && (
            <div className="space-y-2 text-sm">
              <p className="font-medium">
                {Array.isArray(body.candidates)
                  ? t(
                      "草稿候选目标，未实际分配",
                      "Draft candidates, not assigned",
                    )
                  : t("目标分配", "Target allocation")}
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
                      ? ` · ${t("本次选中", "Selected")}`
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
              {t(
                "本次只检查路由，未执行 GuardRail。",
                "This request only checked routing; no GuardRail was executed.",
              )}
            </p>
          ) : failed ? (
            <p>
              {t(
                "请求失败，无法确认检测完成。请根据上方错误修改请求后重试。",
                "The request failed. Evaluation completion is not confirmed. Correct the error above and retry.",
              )}
            </p>
          ) : (
            <>
              <p className="text-sm">
                {t("检测结果", "Decision")}:{" "}
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
                  ? t(
                      "经 Runner Endpoint 执行；外部 Ingress / TLS 不在测试范围内。",
                      "Executed through the Runner Endpoint; external Ingress / TLS is outside this test.",
                    )
                  : t(
                      "Runner 执行 Body 输入检测；Endpoint 认证不在测试范围内。",
                      "Runner evaluated the body as input; Endpoint authentication is outside this test.",
                    )}
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
  const t = useRoutingText();
  return (
    <ul className="space-y-1">
      {conditions.map((condition, index) => (
        <li key={index}>
          {Array.isArray(condition.children) ? (
            <div className="border-l pl-2">
              <span>
                {String(condition.combinator ?? t("条件组", "Condition group"))}
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
