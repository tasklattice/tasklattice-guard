import { useState } from "react";
import { History, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorNotice } from "@/components/product-shell";
import { useRoutingText } from "@/components/traffic-routing/form";
import type { Guardrail } from "@/lib/api";
import { usePathWorkbench } from "./use-path-workbench";
import { PathTargetBar } from "./path-target-bar";
import { PathRequestEditor } from "./path-request-editor";
import { PathTestResult } from "./path-test-result";
import { PathTestHistory } from "./path-test-history";
import { PathWorkbenchSplit } from "./path-workbench-split";

export function AdvancedPlayground({
  active,
  guardrails,
}: {
  active: boolean;
  guardrails: Guardrail[];
}) {
  const t = useRoutingText();
  const workbench = usePathWorkbench(active);
  const [historyOpen, setHistoryOpen] = useState(false);
  const names = Object.fromEntries(guardrails.map((g) => [g.id, g.name]));
  return (
    <section
      aria-label={t("高级请求工作台", "Advanced request workbench")}
      className="flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card shadow-xs"
    >
      <PathTargetBar workbench={workbench} />
      {workbench.error && (
        <div className="border-b p-3">
          <ErrorNotice error={workbench.error} />
        </div>
      )}
      <PathWorkbenchSplit
        request={<PathRequestEditor workbench={workbench} />}
        result={
          <>
            <div className="flex shrink-0 items-center justify-between border-b px-4">
              <h2 className="text-sm font-semibold">
                {t("测试结果", "Test result")}
              </h2>
              <Button
                variant="ghost"
                className="min-h-11"
                disabled={workbench.pending}
                onClick={() => setHistoryOpen(true)}
              >
                <History className="size-4" />
                {t("历史记录", "History")}
                {workbench.records.length
                  ? ` (${workbench.records.length})`
                  : ""}
              </Button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col">
              {workbench.pending ? (
                <p
                  role="status"
                  className="flex items-center gap-2 p-6 text-sm text-muted-foreground"
                >
                  <LoaderCircle className="size-4 animate-spin" />
                  {t(
                    "正在测试，请等待结果…",
                    "Testing the request. Waiting for results…",
                  )}
                </p>
              ) : workbench.current ? (
                <PathTestResult
                  key={workbench.current.id}
                  item={workbench.current}
                  guardrailNames={names}
                />
              ) : (
                <div className="p-6 text-sm text-muted-foreground">
                  <p>
                    {t(
                      "发送请求，查看命中的 GuardRail 和执行结果。",
                      "Send a request to inspect the selected GuardRail and test result.",
                    )}
                  </p>
                  <p className="mt-2 text-xs">
                    {t(
                      "先在上方选择测试目标，编辑 Headers 或 Body。",
                      "Choose a target above, then edit Headers or Body.",
                    )}
                  </p>
                </div>
              )}
            </div>
          </>
        }
      />
      <PathTestHistory
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        records={workbench.records}
        onRestore={workbench.restore}
        onClear={workbench.clearHistory}
      />
    </section>
  );
}
