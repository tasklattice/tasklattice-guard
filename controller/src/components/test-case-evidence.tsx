import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, FileSearch } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TestCaseResult } from "@/lib/api-types";
import { requestController } from "@/lib/controller-api";
import { downloadLogFile } from "@/lib/http-log-content";
import { exchanges, list, parse, record, text, type ValidationCheck } from "@/lib/validation-evidence";
import { EntitySheet } from "./entity-sheet";
import { Button } from "./ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { ErrorNotice } from "./product-shell";
import { Skeleton } from "./ui/skeleton";
import { ValidationResultSummary } from "./validation-result-summary";
import { ValidationHttpInspector } from "./validation-http-inspector";

/** Uses the same summary and HTTP inspector as Protection capability evidence. */
export function TestCaseEvidence({ runId, ordinal, result }: { runId: string; ordinal: number; result: TestCaseResult }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const query = useQuery({ queryKey: ["test-case-evidence", runId, ordinal], queryFn: ({ signal }) => requestController<Record<string, unknown>>(`/api/v1/test-runs/${encodeURIComponent(runId)}/cases/${ordinal}/evidence`, { signal }), enabled: open, staleTime: Infinity, gcTime: 0, retry: false });
  const data = query.data;
  const trace = list(data?.trace).map(record);
  const http = trace.filter(step => step.kind === "model_http_evidence").map(step => parse(step.evidence));
  const calls = exchanges({ model_http_evidence: http });
  const output = { findings: data?.findings, evaluation_evidence: trace.filter(step => step.evidence && step.kind !== "model_http_evidence"),
    model_exchanges: calls, query: data?.query, validation_context: { input_context: list(data?.groundingSources).map(value => ({ role: "source", text: value })) } };
  const sample: NonNullable<ValidationCheck["cases"]>[number] = { id: result.case_id, passed: result.passed,
    inputContent: text(data?.inputContent), outputContent: "", expectedDecision: text(data?.expectedDecision), actualDecision: text(data?.actualDecision), reason: text(data?.reason) };
  const label = t(`modelSettings.evidence.${result.passed ? "passedEvidence" : "failedEvidence"}`);
  return <>
    <Button variant="ghost" size="sm" aria-label={`${label} · ${result.name}`} className={result.passed ? "!text-[var(--success)] !bg-[var(--notice-success)]" : "!text-destructive !bg-[var(--notice-danger)]"} onClick={() => setOpen(true)}><FileSearch />{label}</Button>
    <EntitySheet open={open} onOpenChange={setOpen} title={result.name} eyebrow={label} description={`${result.source_policy_id ?? result.policy_id} · ${result.source_policy_version ?? ""}`} width="workflow"
      footer={<><Button variant="outline" onClick={() => setOpen(false)}>{t("common.close")}</Button><Button variant="outline" disabled={!data} onClick={() => downloadLogFile(new TextEncoder().encode(JSON.stringify({ schema: "tasklattice.test-case-evidence.v1", runId, case: data }, null, 2)), `${runId}-case-${ordinal}.json`, "application/json")}><Download />{t("policyTesting.export")}</Button></>}>
      {query.isPending ? <Skeleton className="h-48" /> : query.error ? <><ErrorNotice error={query.error} /><Button variant="outline" onClick={() => void query.refetch()}>{t("common.retry")}</Button></> : <Tabs defaultValue="result">
        <TabsList aria-label={t("modelSettings.evidence.views")}><TabsTrigger value="result">{t("modelSettings.evidence.result")}</TabsTrigger><TabsTrigger value="calls">{t("modelSettings.evidence.http")} ({calls.length})</TabsTrigger></TabsList>
        <TabsContent value="result" className="space-y-5 pt-4"><ValidationResultSummary sample={sample} output={output} />
          <section><h4 className="mb-2 text-sm font-semibold">{t("policyTesting.output")}</h4><pre className="whitespace-pre-wrap break-words bg-muted/30 p-3 text-sm">{text(data?.outputContent) || "—"}</pre></section>
          <section><h4 className="mb-2 text-sm font-semibold">{t("policyTesting.rules")}</h4><p className="break-words text-sm">{list(data?.matchedRuleIds).map(text).join(", ") || "—"}</p></section>
        </TabsContent>
        <TabsContent value="calls" className="pt-4">{calls.length ? <ValidationHttpInspector calls={calls} output={output} /> : <p className="text-sm text-muted-foreground">{t(data?.modelInvocations === 0 ? "policyTesting.noCalls" : "policyTesting.noCapturedCalls")}</p>}</TabsContent>
      </Tabs>}
    </EntitySheet>
  </>;
}
