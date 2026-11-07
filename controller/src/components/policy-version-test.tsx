import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FlaskConical, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PolicyTestReadiness, PolicyVersionTestRun } from "../../shared/policy-version-test";
import { hasPermission, isPlatformAdministrator } from "../../shared/rbac";
import type { Policy } from "@/lib/api-types";
import { useAuth } from "@/lib/auth";
import { requestController } from "@/lib/controller-api";
import { downloadLogFile } from "@/lib/http-log-content";
import { ValidationCaseResults } from "@/routes/validation";
import { Button } from "./ui/button";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { ErrorNotice, StateBadge } from "./product-shell";

export function PolicyVersionTest({ policy, children }: { policy: Policy; children: ReactNode }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const client = useQueryClient();
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<unknown>(null);
  const base = `/api/v1/policies/${encodeURIComponent(policy.id)}/versions/${encodeURIComponent(policy.version)}`;
  const key = ["policy-version-test", user?.project_id, policy.id, policy.version];
  const readiness = useQuery({ queryKey: [...key, "readiness"], queryFn: ({ signal }) => requestController<PolicyTestReadiness>(`${base}/test-readiness`, { signal }), refetchInterval: 10_000, retry: false });
  const latest = useQuery({ queryKey: [...key, "latest"], queryFn: ({ signal }) => requestController<PolicyVersionTestRun | null>(`${base}/test-runs/latest`, { signal }),
    refetchInterval: query => query.state.data && ["queued", "running"].includes(query.state.data.status) ? 1000 : false, retry: false });
  const run = latest.data;
  const running = Boolean(run && ["queued", "running"].includes(run.status));
  const canTest = hasPermission(user?.role, "policies", "write");
  const mutation = useMutation({ mutationFn: () => requestController<PolicyVersionTestRun>(`${base}/test-runs`, { method: "POST" }),
    onSuccess: report => { client.setQueryData([...key, "latest"], report); setExportError(null); },
    onError: () => { void readiness.refetch(); void latest.refetch(); } });
  const changed = run && readiness.data?.environment && (run.snapshot.environment.poolId !== readiness.data.environment.poolId || run.snapshot.environment.modelRevisionId !== readiness.data.environment.modelRevisionId);
  async function exportEvidence() {
    if (!run) return;
    setExporting(true); setExportError(null);
    try {
      const evidence = await requestController<unknown>(`${base}/test-runs/${encodeURIComponent(run.id)}/evidence`, { timeoutMs: 120_000 });
      downloadLogFile(new TextEncoder().encode(JSON.stringify(evidence, null, 2)), `${run.id}-evidence.json`, "application/json");
    } catch (error) { setExportError(error); }
    finally { setExporting(false); }
  }
  return <section className="space-y-4">
    <header className="flex items-start justify-between gap-6">
      <div className="min-w-0"><h3 className="text-sm font-semibold">{t("policyLibrary.testCasesTitle")}</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">{t("policyTesting.description")}</p></div>
      <Button variant="testing" className="shrink-0" disabled={!canTest || !readiness.data?.ready || readiness.isError || latest.isPending || latest.isError || running || mutation.isPending}
        onClick={() => mutation.mutate()}>{running || mutation.isPending ? <LoaderCircle className="animate-spin" /> : <FlaskConical />}{t(running || mutation.isPending ? "policyTesting.running" : "policyTesting.test")}</Button>
    </header>
    {!canTest ? <p className="text-sm">{t("policyTesting.permission")}</p> : null}
    {readiness.isPending ? <p role="status" className="text-sm text-muted-foreground">{t("policyTesting.checking")}</p> : readiness.isError ? <div><ErrorNotice error={readiness.error} /><Button variant="ghost" onClick={() => void readiness.refetch()}>{t("common.retry")}</Button></div> : readiness.data?.blockers.length ? <Alert variant="warning">
      <AlertTitle>{t("policyTesting.blocked")}</AlertTitle><AlertDescription><ul className="mt-2 space-y-1">{readiness.data.blockers.map((blocker, index) => <li key={index} className="whitespace-pre-wrap">{blocker.binding ? t("policyTesting.missing", { capability: t(`protection.dependencies.capabilities.${blocker.binding.split(".")[0]}`), stage: t(`protection.${blocker.binding.split(".")[1]}`) }) : blocker.message}</li>)}</ul>
        {readiness.data.blockers.some(b => b.binding) ? isPlatformAdministrator(user?.role) ? <a href="/settings/protection-capabilities" className="mt-2 inline-block text-primary underline">{t("policyTesting.configure")}</a> : <p className="mt-2">{t("policyTesting.contactAdmin")}</p> : null}
      </AlertDescription></Alert> : null}
    {mutation.error ? <ErrorNotice error={mutation.error} /> : null}
    {latest.error ? <div><ErrorNotice error={latest.error} /><Button variant="ghost" onClick={() => void latest.refetch()}>{t("common.retry")}</Button></div> : null}
    {run ? <section className="space-y-4 border-t pt-4" aria-label={t("guardrails.validationEvidence")}>
      <div className="flex items-center justify-between gap-4"><div className="flex flex-wrap items-center gap-3"><StateBadge state={run.status} />
        <span role="status" className="text-sm tabular-nums">{t(running ? "policyTesting.progress" : "policyTesting.summary", { completed: run.completed, passed: run.passed, total: run.total })}</span>
        <time className="text-xs text-muted-foreground" dateTime={run.createdAt}>{new Date(run.createdAt).toLocaleString()}</time></div>
        <Button variant="outline" size="sm" disabled={running || exporting} onClick={() => void exportEvidence()}>{exporting ? <LoaderCircle className="animate-spin" /> : <Download />}{t(exporting ? "policyTesting.exporting" : "policyTesting.export")}</Button></div>
      {changed ? <p role="status" className="border-l-2 border-amber-500 pl-3 text-sm">{t("policyTesting.changed")}</p> : null}
      {run.failureReason ? <p role="alert" className="text-sm text-destructive">{run.failureReason}</p> : null}
      {exportError ? <ErrorNotice error={exportError} /> : null}
      <details className="text-xs"><summary className="cursor-pointer py-2">{t("policyTesting.environment")}</summary><div className="space-y-2 pb-2">
        <p>{t("policyTesting.version", { version: run.version })} · Runner pool: {run.snapshot.environment.poolId}</p>
        {run.snapshot.environment.models.map(model => <p key={model.binding}>{model.binding} · {model.model} · {model.provider}</p>)}
        {Object.keys(run.snapshot.parameters).length ? <dl>{Object.entries(run.snapshot.parameters).map(([name, value]) => <div key={name} className="grid grid-cols-[12rem_minmax(0,1fr)] gap-3"><dt>{name}</dt><dd className="whitespace-pre-wrap break-words">{value}</dd></div>)}</dl> : null}
      </div></details>
      {!running ? <ValidationCaseResults key={run.id} runId={run.id} evidence /> : null}
    </section> : null}
    {run ? <details><summary className="cursor-pointer py-2 text-sm font-medium">{t("policyTesting.sourceCases", { count: policy.test_count })}</summary>{children}</details> : children}
  </section>;
}
