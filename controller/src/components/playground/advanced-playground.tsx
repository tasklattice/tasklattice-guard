import { useTranslation } from "react-i18next";
import { useState } from "react";
import { Activity, History, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorNotice } from "@/components/product-shell";

import type { Guardrail } from "@/lib/api";
import { usePathWorkbench } from "./use-path-workbench";
import { PathTargetBar } from "./path-target-bar";
import { PathRequestEditor } from "./path-request-editor";
import { PathTestResult } from "./path-test-result";
import { PathTestHistory } from "./path-test-history";
import { PathWorkbenchSplit } from "./path-workbench-split";
import "./advanced-playground.scss";

export function AdvancedPlayground({
  active,
  guardrails,
}: {
  active: boolean;
  guardrails: Guardrail[];
}) {
  const { t } = useTranslation();
  const workbench = usePathWorkbench(active);
  const [historyOpen, setHistoryOpen] = useState(false);
  const names = Object.fromEntries(guardrails.map((g) => [g.id, g.name]));
  return (
    <section
      aria-label={t("routing.advancedRequestWorkbench")}
      className="advanced-workbench flex min-w-0 flex-col overflow-hidden"
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
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <Activity className="size-4" aria-hidden="true" />
                {t("routing.testResult")}
              </h2>
              <Button
                variant="ghost"
                className="min-h-11"
                disabled={workbench.pending}
                onClick={() => setHistoryOpen(true)}
              >
                <History className="size-4" />
                {t("routing.history")}
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
                  {t("routing.testingTheRequestWaitingForResults")}
                </p>
              ) : workbench.current ? (
                <PathTestResult
                  key={workbench.current.id}
                  item={workbench.current}
                  guardrailNames={names}
                  routerNames={Object.fromEntries(workbench.routers.map((router) => [router.id, router.name]))}
                  endpointNames={Object.fromEntries(workbench.endpoints.map((endpoint) => [endpoint.id, endpoint.name]))}
                />
              ) : (
                <div className="p-6 text-sm text-muted-foreground">
                  <p>
                    {t("routing.sendARequestToInspectTheSelectedGuardRailAnd")}
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
