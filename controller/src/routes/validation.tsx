import { TestModelRulesSwitch, ValidationScopeNotice } from "@/components/validation-model-scope";
import { hasPermission } from "../../shared/rbac";
import { EventPagination, useEventCursor } from "@/components/event-pagination";
import { DeleteTestingReportSheet } from "@/components/delete-testing-report-sheet";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Ban, ChevronDown, ChevronRight, Info, LoaderCircle, Play, Plus, RotateCcw, Search, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "@/components/ui/notifications";

import { hasValidationReportResults, isValidationRunning, ValidationRunProgress } from "@/components/validation-run-progress";
import { ExecutionTrace, playgroundTraceSteps } from "@/components/execution-trace";
import { EntitySheet } from "@/components/entity-sheet";
import { AddTestCaseSheet } from "@/components/add-test-case-sheet";
import { EmptyState, ErrorNotice, InfoNotice, PageHeader, StateBadge } from "@/components/product-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { queryKeys } from "@/features/query-keys";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import {
  createValidationRun,
  deleteTestCase,
  excludeGuardrailTestCase,
  getGuardrails,
  getTestCases,
  getValidationRuns,
  getValidationRun,
  getValidationCases,
  getValidationCase,
  restoreGuardrailTestCase,
  type TestCaseResult,
  type Guardrail,
  type ValidationRun,
} from "@/lib/api";

export function ValidationPage() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const auth = useAuth();
  const canManage = hasPermission(auth.user?.role, "guardrails", "write");
  const requestedGuardrail = typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("guardrail") ?? "";
  const guardrailsQuery = useQuery({ queryKey: queryKeys.guardrails, queryFn: getGuardrails });
  const guardrails = guardrailsQuery.data?.items ?? [];
  const [createOpen, setCreateOpen] = useState(false);
  useEffect(() => { if (requestedGuardrail && canManage) setCreateOpen(true); }, [canManage, requestedGuardrail]);
  const [selected, setSelected] = useState<ValidationRun | null>(null);
  const [search, setSearch] = useState("");
  const [guardrailId, setGuardrailId] = useState("all");
  const [status, setStatus] = useState("all");
  const pagination = useEventCursor(JSON.stringify([search, guardrailId, status]));
  const runsQuery = useQuery({ queryKey: [...queryKeys.allValidationRuns, { search, guardrailId, status, cursor: pagination.cursor }],
    queryFn: () => getValidationRuns(guardrailId === "all" ? undefined : guardrailId, { q: search, status, cursor: pagination.cursor }) });
  const runs = runsQuery.data?.items ?? [];
  const guardrailNames = useMemo(() => new Map(guardrails.map((item) => [item.id, item.name])), [guardrails]);
  const guardrailIds = useMemo(() => [...guardrailNames.keys()].sort((left, right) => (guardrailNames.get(left) ?? left).localeCompare(guardrailNames.get(right) ?? right, i18n.language)), [guardrailNames, i18n.language]);
  const filtered = runs;
  const refresh = async () => { await Promise.all([queryClient.invalidateQueries({ queryKey: queryKeys.allValidationRuns }), queryClient.invalidateQueries({ queryKey: queryKeys.guardrails })]); };
  const rerun = useMutation({ mutationFn: ({ guardrailId, testModelRules }: { guardrailId: string; testModelRules: boolean }) => createValidationRun(guardrailId, { onProgress: setSelected }, testModelRules), onSuccess: async (run) => { await refresh(); setSelected(run); toast[run.status === "failed" ? "error" : "success"](t(run.status === "cancelled" ? "validationControl.stopped" : run.status === "passed" ? "guardrails.validationPassed" : "guardrails.validationFailed", { rate: run.metrics.compliance_rate })); }, onError: (error) => notifyError(error, t("guardrails.operationFailed")) });

  return (
    <section className="py-6 sm:py-8">
      <PageHeader title={t("pages.validation.title")} description={t("pages.validation.description")} action={canManage ? <Button variant="testing" disabled={!guardrails.length} onClick={() => setCreateOpen(true)}><Plus />{t("validation.createValidationRun")}</Button> : undefined} />
      {guardrailsQuery.error || runsQuery.error ? <div className="mt-5"><ErrorNotice error={guardrailsQuery.error || runsQuery.error} /></div> : null}
      {guardrailsQuery.isLoading || runsQuery.isLoading ? <Skeleton className="mt-5 h-[34rem] rounded-xl" /> : null}
      {!guardrailsQuery.isLoading && !guardrails.length ? <div className="mt-5"><EmptyState title={t("validation.noGuardrails")} description={t("validation.noGuardrailsDescription")} /></div> : null}
      {!runsQuery.isLoading && guardrails.length ? (
        <section className="mt-5 overflow-hidden rounded-xl border bg-card shadow-xs">
          <div className="grid gap-3 border-b bg-muted/20 p-4 sm:grid-cols-2 lg:grid-cols-[minmax(16rem,1fr)_minmax(14rem,18rem)_12rem_auto] lg:items-center"><label className="relative"><span className="sr-only">{t("validation.searchValidationRuns")}</span><Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" /><Input className="field:min-h-11 field:bg-card field:pl-9" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("validation.searchValidationRuns")} /></label><Select value={guardrailId} onValueChange={setGuardrailId}><SelectTrigger className="field:min-h-11 min-w-0 field:bg-card" aria-label={t("validation.filterGuardrailId")}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t("validation.allGuardrailIds")}</SelectItem>{guardrailIds.map((id) => <SelectItem key={id} value={id}>{guardrailNames.get(id) ? `${guardrailNames.get(id)} · ${id}` : id}</SelectItem>)}</SelectContent></Select><Select value={status} onValueChange={setStatus}><SelectTrigger className="field:min-h-11 field:bg-card" aria-label={t("validation.filterStatus")}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t("validation.allStatuses")}</SelectItem><SelectItem value="passed">{t("states.passed")}</SelectItem><SelectItem value="failed">{t("states.failed")}</SelectItem><SelectItem value="cancelled">{t("states.cancelled")}</SelectItem><SelectItem value="incomplete">{t("states.incomplete")}</SelectItem></SelectContent></Select><p className="text-xs text-muted-foreground sm:text-right">{t("validation.validationRunCount", { count: runsQuery.data?.count ?? 0 })}</p></div>
          {filtered.length ? <Table><TableHeader><TableRow className="hover:bg-transparent"><TableHead className="pl-4">{t("validation.validationRunColumn")}</TableHead><TableHead>{t("validation.guardrailColumn")}</TableHead><TableHead>{t("validation.targetColumn")}</TableHead><TableHead>{t("validation.casesColumn")}</TableHead><TableHead>{t("validation.statusColumn")}</TableHead><TableHead>{t("validation.passRateColumn")}</TableHead><TableHead>{t("validation.durationColumn")}</TableHead><TableHead>{t("validation.runAtColumn")}</TableHead><TableHead className="w-12"><span className="sr-only">{t("validation.openValidationRun")}</span></TableHead></TableRow></TableHeader><TableBody>{filtered.map((run) => <ValidationRow key={run.id} run={run} guardrailName={guardrailNames.get(run.guardrail_id)} locale={i18n.language} onOpen={() => setSelected(run)} />)}</TableBody></Table> : <EmptyState title={runs.length ? t("validation.noMatchingValidationRuns") : t("validation.noValidationRuns")} description={runs.length ? t("validation.noMatchingValidationRunsDescription") : t("validation.noValidationRunsDescription")} action={canManage && !runs.length ? <Button variant="testing" onClick={() => setCreateOpen(true)}><Plus />{t("validation.createValidationRun")}</Button> : undefined} />}
          <EventPagination page={pagination.page} busy={runsQuery.isFetching} nextCursor={runsQuery.data?.nextCursor} onNext={pagination.next} onPrevious={pagination.previous} onLatest={pagination.latest} />
        </section>
      ) : null}
      <CreateValidationSheet open={createOpen} onOpenChange={setCreateOpen} guardrails={guardrails} initialGuardrailId={requestedGuardrail} onCreated={async (run) => { setCreateOpen(false); await refresh(); setSelected(run); }} />
      <ValidationDetailSheet run={selected} guardrail={selected ? guardrails.find((item) => item.id === selected.guardrail_id) : undefined} canManage={canManage} running={rerun.isPending} onRunAgain={(guardrailId, testModelRules) => rerun.mutate({ guardrailId, testModelRules })} onClose={() => setSelected(null)} />
    </section>
  );
}

export function filterValidationRuns(runs: ValidationRun[], guardrailNames: Map<string, string>, search: string, guardrailId: string, status: string) {
  const query = search.trim().toLowerCase();
  return runs.filter((run) => (guardrailId === "all" || run.guardrail_id === guardrailId) && (status === "all" || run.status === status) && (!query || `${run.id} ${guardrailNames.get(run.guardrail_id) ?? run.guardrail_id}`.toLowerCase().includes(query)));
}

export function GuardrailValidationHistory({ runs, loading, error, canManage, running, blockedReason, onRun, onOpen, onOpenTarget, description, emptyDescription, action, pagination }: {
  description?: string;
  emptyDescription?: string;
  action?: ReactNode;
  pagination?: ReactNode;
  runs: ValidationRun[];
  loading: boolean;
  error: unknown;
  canManage: boolean;
  running: boolean;
  blockedReason?: string | null;
  onRun: () => void;
  onOpen: (run: ValidationRun) => void;
  onOpenTarget: (run: ValidationRun) => void;
}) {
  const { t, i18n } = useTranslation();
  const orderedRuns = useMemo(() => [...runs].sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at)), [runs]);
  return <section className="overflow-hidden rounded-xl border bg-card shadow-xs" aria-label={t("guardrails.validationHistoryTitle")}>
    <header className="flex flex-wrap items-center justify-between gap-4 border-b bg-muted/20 px-4 py-3">
      <details className="min-w-64 flex-1 text-xs leading-5 text-muted-foreground"><summary className="min-h-11 w-fit cursor-pointer content-center py-2 focus-visible:outline-2 focus-visible:outline-ring">{t("immutableVersions.reportRetention")}</summary><p className="max-w-3xl pb-2">{description ?? t("guardrails.validationHistoryDescription")}</p></details>
      {action ?? (canManage ? <Button variant="testing" className="shrink-0" disabled={running || Boolean(blockedReason)} title={blockedReason ?? undefined} onClick={onRun}>{running ? <LoaderCircle className="animate-spin" /> : <Play />}{t(running ? "guardrails.runningValidation" : "guardrails.runReviewed")}</Button> : null)}
    </header>
    {error ? <div className="p-4"><ErrorNotice error={error} /></div> : null}
    {loading ? <div className="p-4"><Skeleton className="h-72 rounded-lg" /></div> : null}
    {!loading && !error && orderedRuns.length ? <div className="overflow-x-auto"><Table>
      <TableHeader><TableRow className="hover:bg-transparent"><TableHead className="min-w-52 pl-4">{t("validation.validationRunColumn")}</TableHead><TableHead>{t("validation.targetColumn")}</TableHead><TableHead>{t("validation.casesColumn")}</TableHead><TableHead>{t("validation.statusColumn")}</TableHead><TableHead>{t("validation.passRateColumn")}</TableHead><TableHead>{t("validation.durationColumn")}</TableHead><TableHead>{t("validation.runAtColumn")}</TableHead><TableHead className="w-12"><span className="sr-only">{t("validation.openValidationRun")}</span></TableHead></TableRow></TableHeader>
      <TableBody>{orderedRuns.map((run) => <ValidationRow key={run.id} run={run} locale={i18n.language} showGuardrail={false} onOpen={() => onOpen(run)} onOpenTarget={() => onOpenTarget(run)} />)}</TableBody>
    </Table></div> : null}
    {!loading && !error && !orderedRuns.length ? <EmptyState title={t("validation.noValidationRuns")} description={emptyDescription ?? t("validation.noValidationRunsDescription")} action={canManage && !action ? <Button variant="testing" disabled={running || Boolean(blockedReason)} title={blockedReason ?? undefined} onClick={onRun}><Play />{t("guardrails.runReviewed")}</Button> : undefined} /> : null}
    {pagination}
  </section>;
}

function ValidationRow({ run, guardrailName, locale, showGuardrail = true, onOpen, onOpenTarget }: { run: ValidationRun; guardrailName?: string; locale: string; showGuardrail?: boolean; onOpen: () => void; onOpenTarget?: () => void }) {
  const { t } = useTranslation();
  return <TableRow role="button" tabIndex={0} className="cursor-pointer" onClick={onOpen} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(); } }}><TableCell className="pl-4"><strong className="block text-sm font-medium">{t("validation.validationRunNamed", { id: shortId(run.id) })}</strong><span className="mt-1 block max-w-52 truncate font-mono text-xs text-muted-foreground" title={reportNumber(run.id)}>{reportNumber(run.id)}</span>{run.test_model_rules === false ? <Badge variant="outline" className="mt-1">{t("validationScope.badge")}</Badge> : null}</TableCell>{showGuardrail ? <TableCell><strong className="block text-sm font-medium">{guardrailName ?? run.guardrail_id}</strong>{guardrailName ? <span className="mt-1 block font-mono text-xs text-muted-foreground">{run.guardrail_id}</span> : null}</TableCell> : null}<TableCell className="text-xs"><ValidationTarget run={run} onOpen={onOpenTarget} /></TableCell><TableCell className="font-mono text-xs">{run.metrics.total}</TableCell><TableCell className="testing-report-status whitespace-nowrap"><StateBadge state={isValidationRunning(run) ? "syncing" : run.status} label={isValidationRunning(run) ? t("guardrails.runningValidation") : undefined} /></TableCell><TableCell className="font-mono text-xs">{hasValidationReportResults(run) ? `${run.metrics.compliance_rate}%` : "—"}</TableCell><TableCell className="font-mono text-xs">{hasValidationReportResults(run) ? `P95 ${run.metrics.p95_latency_ms} ms` : "—"}</TableCell><TableCell className="whitespace-nowrap text-xs text-muted-foreground">{new Date(run.created_at).toLocaleString(locale)}</TableCell><TableCell><Button type="button" variant="ghost" size="icon" className="size-11" aria-label={t("validation.openValidationRun")} onClick={(event) => { event.stopPropagation(); onOpen(); }}><ChevronRight className="size-4 text-muted-foreground" /></Button></TableCell></TableRow>;
}

function ValidationTarget({ run, onOpen }: { run: ValidationRun; onOpen?: () => void }) {
  const { t } = useTranslation();
  const label = targetLabel(run, t);
  if (!onOpen) return <span className="font-mono text-xs">{label}</span>;
  return <Button type="button" variant="link" className="-my-2 h-auto min-h-11 max-w-60 justify-start gap-1.5 whitespace-normal px-0 py-2 text-left font-mono text-xs" onClick={(event) => { event.stopPropagation(); onOpen?.(); }} onKeyDown={(event) => event.stopPropagation()}>{label}<ArrowUpRight className="size-3.5" /></Button>;
}

function CreateValidationSheet({ open, onOpenChange, guardrails, initialGuardrailId, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; guardrails: Guardrail[]; initialGuardrailId: string; onCreated: (run: ValidationRun) => Promise<void> }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [guardrailId, setGuardrailId] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [testModelRules, setTestModelRules] = useState(true);
  useEffect(() => { if (open) setGuardrailId(guardrails.some((item) => item.id === initialGuardrailId) ? initialGuardrailId : guardrails[0]?.id ?? ""); }, [guardrails, initialGuardrailId, open]);
  const guardrail = guardrails.find((item) => item.id === guardrailId);
  const casesQuery = useQuery({ queryKey: queryKeys.testCases(guardrailId), queryFn: () => getTestCases(guardrailId), enabled: open && Boolean(guardrailId) });
  const cases = casesQuery.data?.items ?? [];
  const activeCases = cases.filter((item) => !item.excluded);
  const [observedRun, setObservedRun] = useState<ValidationRun | null>(null);
  const run = useMutation({ mutationFn: () => { setObservedRun(null); return createValidationRun(guardrailId, { onProgress: setObservedRun }, testModelRules); }, onSuccess: async (result) => { toast[result.status === "failed" ? "error" : "success"](t(result.status === "cancelled" ? "validationControl.stopped" : result.status === "passed" ? "guardrails.validationPassed" : "guardrails.validationFailed", { rate: result.metrics.compliance_rate })); await onCreated(result); }, onError: (error) => notifyError(error, t("guardrails.operationFailed")) });
  const remove = useMutation({ mutationFn: (caseId: string) => deleteTestCase(guardrailId, caseId), onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: queryKeys.testCases(guardrailId) }); toast.success(t("guardrails.caseRemoved")); }, onError: (error) => notifyError(error, t("guardrails.operationFailed")) });
  const validationScope = useMutation({ mutationFn: ({ caseId, action }: { caseId: string; action: "exclude" | "restore" }) => action === "exclude" ? excludeGuardrailTestCase(guardrailId, caseId) : restoreGuardrailTestCase(guardrailId, caseId), onSuccess: async (_, variables) => { await Promise.all([queryClient.invalidateQueries({ queryKey: queryKeys.testCases(guardrailId) }), queryClient.invalidateQueries({ queryKey: queryKeys.guardrail(guardrailId) }), queryClient.invalidateQueries({ queryKey: queryKeys.guardrails })]); toast.success(t(variables.action === "exclude" ? "guardrails.testCaseExcluded" : "guardrails.testCaseRestored")); }, onError: (error) => notifyError(error, t("guardrails.operationFailed")) });
  return <><EntitySheet open={open} onOpenChange={onOpenChange} eyebrow={t("validation.createEyebrow")} title={t("validation.createValidationRun")} description={t("validation.createValidationRunDescription")} width="lg" footer={<><Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button><Button variant="testing" disabled={!guardrailId || !activeCases.length || run.isPending} onClick={() => run.mutate()}>{run.isPending ? <LoaderCircle className="animate-spin" /> : <Play />}{t(run.isPending ? "guardrails.runningValidation" : "validation.runRegression")}</Button></>}>
    <div className="space-y-5"><label className="grid gap-2 text-sm font-medium">{t("validation.chooseGuardrail")}<Select value={guardrailId} onValueChange={setGuardrailId}><SelectTrigger className="field:min-h-11 field:bg-card"><SelectValue /></SelectTrigger><SelectContent>{guardrails.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent></Select></label>
      <TestModelRulesSwitch checked={testModelRules} onChange={setTestModelRules} disabled={run.isPending} />
      {guardrail ? <section className="rounded-xl border bg-muted/20 p-4"><div className="flex flex-wrap items-center gap-2"><strong className="text-sm">{guardrail.name}</strong><StateBadge state={guardrail.status} /></div><p className="mt-3 text-xs font-medium">{t("validation.draftTarget", { revision: guardrail.tested_current ? guardrail.latest_validation_run?.source_draft_version ?? "—" : "current" })}</p></section> : null}
      <section className="overflow-hidden rounded-xl border"><header className="flex items-center justify-between gap-3 border-b bg-muted/25 px-4 py-3"><div><h3 className="text-sm font-semibold">{t("validation.testCases")}</h3><p className="mt-1 text-xs text-muted-foreground">{t("validation.validationScopeCount", { active: activeCases.length, excluded: cases.length - activeCases.length })}</p></div><Button variant="create" size="sm" onClick={() => setAddOpen(true)} disabled={!guardrail}><Plus />{t("guardrails.addTestCase")}</Button></header>{casesQuery.isLoading ? <div className="p-4"><Skeleton className="h-32" /></div> : cases.length ? <div className="max-h-72 divide-y overflow-y-auto">{cases.map((item) => <div key={item.id} className={cn("grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3", item.excluded && "bg-muted/30 text-muted-foreground")}><div className="min-w-0"><div className="flex min-w-0 flex-wrap items-center gap-2"><strong className="truncate text-sm font-medium">{item.name}</strong><Badge variant="outline" className="font-normal">{testCaseTypeLabel(item.case_type, t)}</Badge>{item.excluded ? <Badge variant="secondary">{t("guardrails.excludedFromValidation")}</Badge> : null}</div><span className="mt-1 block text-xs text-muted-foreground">{humanize(item.policy_id)} · {humanize(item.phase)} · {humanize(item.expected_decision)}</span>{item.source_policy_id ? <span className="mt-1 block truncate font-mono text-xs text-muted-foreground">{item.source_policy_id}@{item.source_policy_version} · {item.source_case_id}</span> : null}</div>{item.origin === "custom" ? <Button type="button" size="icon" variant="destructive" className="size-11" aria-label={t("validation.deleteCase", { name: item.name })} disabled={remove.isPending} onClick={() => remove.mutate(item.id)}><Trash2 /></Button> : item.excluded ? <Button type="button" size="sm" variant="outline" className="min-h-11" disabled={validationScope.isPending} onClick={() => validationScope.mutate({ caseId: item.id, action: "restore" })}><RotateCcw />{t("guardrails.restoreTestCase")}</Button> : <Button type="button" size="sm" variant="outline" className="min-h-11 text-foreground" disabled={validationScope.isPending} onClick={() => validationScope.mutate({ caseId: item.id, action: "exclude" })}><Ban />{t("guardrails.excludeTestCase")}</Button>}</div>)}</div> : <div className="p-4"><InfoNotice title={t("guardrails.noCases")}>{t("guardrails.noCasesDescription")}</InfoNotice></div>}</section>
      {run.isPending ? <ValidationRunProgress run={observedRun} startedAt={run.submittedAt} canCancel /> : null}
      <InfoNotice title={t("validation.releaseSemantics")}>{t("validation.releaseSemanticsDescription")}</InfoNotice>
    </div>
  </EntitySheet>{guardrail ? <AddTestCaseSheet guardrail={guardrail} open={addOpen} onOpenChange={setAddOpen} onCreated={async () => { setAddOpen(false); await queryClient.invalidateQueries({ queryKey: queryKeys.testCases(guardrailId) }); }} /> : null}</>;
}

export function ValidationDetailSheet({ run: selectedRun, guardrail, canManage, running, blockedReason, onRunAgain, onRunVersionAgain, onOpenTarget, onClose }: { run: ValidationRun | null; guardrail?: Guardrail; canManage: boolean; running: boolean; blockedReason?: string | null; onRunAgain: (guardrailId: string, testModelRules: boolean) => void; onRunVersionAgain?: (run: ValidationRun) => void; onOpenTarget?: (run: ValidationRun) => void; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const detailQuery = useQuery({ queryKey: queryKeys.validationRun(selectedRun?.id ?? ""),
    queryFn: () => getValidationRun(selectedRun!.id), enabled: Boolean(selectedRun),
    refetchInterval: query => isValidationRunning(query.state.data ?? selectedRun) ? 1_000 : false,
    staleTime: Infinity, gcTime: 0 });
  const run = detailQuery.data ?? selectedRun;

  const validationScope = useMutation({ mutationFn: ({ guardrailId, caseId, action }: { guardrailId: string; caseId: string; action: "exclude" | "restore" }) => action === "exclude" ? excludeGuardrailTestCase(guardrailId, caseId) : restoreGuardrailTestCase(guardrailId, caseId), onSuccess: async (_, variables) => { await Promise.all([queryClient.invalidateQueries({ queryKey: queryKeys.testCases(variables.guardrailId) }), queryClient.invalidateQueries({ queryKey: queryKeys.guardrail(variables.guardrailId) }), queryClient.invalidateQueries({ queryKey: queryKeys.guardrails })]); toast.success(t(variables.action === "exclude" ? "guardrails.testCaseExcludedRerun" : "guardrails.testCaseRestored")); }, onError: (error) => notifyError(error, t("guardrails.operationFailed")) });
  const [deletingReport, setDeletingReport] = useState(false);
  useEffect(() => { setDeletingReport(false); }, [run?.id]);
  if (!run) return null;
  if (deletingReport) return <DeleteTestingReportSheet run={run} onClose={() => setDeletingReport(false)} onDeleted={() => { setDeletingReport(false); onClose(); }} />;
  const versionRun = run.subject === "version";
  const canRerun = versionRun ? Boolean(onRunVersionAgain) : canManage;
  const processing = isValidationRunning(run);
  const reportReady = hasValidationReportResults(run);
  const cancelled = (run.execution_status ?? run.status) === "cancelled";
  const finished = reportReady || cancelled;
  const hasCaseResults = reportReady && run.metrics.total > 0;
  const titleKey = processing ? run.progress?.phase === "finalizing" ? "validation.generatingReportNamed" : "validation.testInProgressNamed" : cancelled ? "validation.testCancelledNamed" : "validation.validationRunNamed";
  return <EntitySheet open allowPageUpdates density="compact" onOpenChange={(next) => { if (!next) onClose(); }}
    eyebrow={t(reportReady ? "validation.detailEyebrow" : "validation.progressEyebrow")}
    title={t(titleKey, { id: shortId(run.id) })}
    description={`${guardrail?.name ?? run.guardrail_id} · ${new Date(run.created_at).toLocaleString(i18n.language)}`}
    width="xl" footer={<>
      {finished && canManage ? <Button variant="ghost" className="mr-auto text-destructive" disabled={running} onClick={() => setDeletingReport(true)}><Trash2 />{t("validation.deleteReport")}</Button> : null}
      <Button variant={processing ? "default" : "outline"} onClick={onClose}>{t(processing ? "validation.closeWhileRunning" : "common.close")}</Button>
      {finished && canRerun ? <Button variant="testing" disabled={running || Boolean(blockedReason)} title={blockedReason ?? undefined} onClick={() => versionRun ? onRunVersionAgain?.(run) : onRunAgain(run.guardrail_id, run.test_model_rules ?? true)}>{running ? <LoaderCircle className="animate-spin motion-reduce:animate-none" /> : <Play />}{t("validation.runAgain")}</Button> : null}
    </>}>
    <div className="space-y-4">
      <section className="overflow-hidden rounded-sm border bg-card">
        <div className={cn("flex items-center justify-between gap-3 px-4 py-3", hasCaseResults && "border-b bg-muted/20")}>
          <div><p className="text-xs text-muted-foreground">{t("validation.targetColumn")}</p><div className="mt-0.5 text-sm font-medium"><ValidationTarget run={run} onOpen={onOpenTarget ? () => onOpenTarget(run) : undefined} /></div></div>
          {finished ? <StateBadge state={cancelled ? "cancelled" : run.status} /> : null}
        </div>
        {hasCaseResults ? <dl className="grid grid-cols-4"><DetailFact label={t("validation.casesColumn")} value={String(run.metrics.total)} definition={t("validation.metricDefinitions.cases")} /><DetailFact label={t("validation.passRateColumn")} value={`${run.metrics.compliance_rate}%`} definition={t("validation.metricDefinitions.passRate")} /><DetailFact label={t("guardrails.falsePositive")} value={`${run.metrics.false_positive_rate}%`} definition={t("validation.metricDefinitions.falsePositive")} /><DetailFact label={t("guardrails.latency")} value={`${run.metrics.p95_latency_ms} ms`} definition={t("validation.metricDefinitions.p95Latency")} /></dl> : null}
      </section>
      {processing ? <>
        <div className="rounded-sm border bg-card px-4"><ValidationRunProgress run={run} startedAt={Date.parse(run.created_at)} interrupted={Boolean(detailQuery.error)} canCancel={canManage} showContext={false} /></div>
        <p className="flex items-start gap-2 text-sm leading-6 text-muted-foreground"><Info aria-hidden className="mt-1 size-4 shrink-0" />{t("validation.processingHint")}</p>
      </> : null}
      {cancelled ? <InfoNotice title={t("validationControl.stopped")}>{t("validation.cancelledWithoutReport")}</InfoNotice> : null}
      {!processing && !finished ? <InfoNotice title={t("states.incomplete")}>{t("validation.reportUnavailable")}</InfoNotice> : null}
      {finished && blockedReason ? <Alert variant="destructive"><AlertTitle>{t("protection.validationReadiness.blockedTitle")}</AlertTitle><AlertDescription className="text-current">{blockedReason}</AlertDescription></Alert> : null}
      {reportReady && (run.failure_reason || run.status === "failed" && !hasCaseResults) ? <Alert variant={run.failure_reason ? "destructive" : "warning"}><AlertTitle>{t("protection.validationReadiness.failureTitle")}</AlertTitle><AlertDescription className="whitespace-pre-wrap break-words text-current">{run.failure_reason || t("protection.validationReadiness.noFailureDetail")}</AlertDescription></Alert> : null}
      {detailQuery.error ? <div className="space-y-3"><ErrorNotice error={detailQuery.error} /><Button variant="outline" onClick={() => void detailQuery.refetch()}>{t("common.retry")}</Button></div> : reportReady ? hasCaseResults ? <ValidationCaseResults key={run.id} runId={run.id} defaultFilter={run.status === "failed" ? "failed" : "all"} excludedCaseIds={guardrail?.excluded_test_case_ids ?? []} busyCaseId={validationScope.isPending ? validationScope.variables?.caseId : undefined} onValidationScopeChange={canManage && !versionRun && guardrail ? (caseId, action) => validationScope.mutate({ guardrailId: guardrail.id, caseId, action }) : undefined} /> : <p className="text-sm text-muted-foreground">{t("validation.noReportResults")}</p> : null}
      {reportReady ? <>
        <ValidationScopeNotice run={run} />
        {run.excluded_case_ids?.length ? <p className="text-xs text-muted-foreground">{t("validation.excludedScopeTitle", { count: run.excluded_case_ids.length })}</p> : null}
        <details className="text-xs leading-5 text-muted-foreground"><summary className="min-h-11 w-fit cursor-pointer content-center py-2 focus-visible:outline-2 focus-visible:outline-ring">{t("validation.reportScopeHelp")}</summary><p className="pb-2">{t(versionRun ? "immutableVersions.localTestReportDescription" : "validation.versionTargetReservedDescription")}</p></details>
      </> : null}
    </div>
  </EntitySheet>;
}

export function DetailFact({ label, value, definition }: { label: string; value: string; definition: string }) {
  const { t } = useTranslation();
  const [helpOpen, setHelpOpen] = useState(false);
  return <div className="border-b px-3 py-2.5 last:border-b-0 sm:border-r sm:border-b-0 sm:last:border-r-0"><div className="flex items-center justify-between gap-2"><dt className="text-xs text-muted-foreground">{label}</dt><Tooltip open={helpOpen} onOpenChange={setHelpOpen}><TooltipTrigger asChild><Button type="button" variant="ghost" size="icon-xs" className="-my-3 -mr-3 size-11 text-muted-foreground shadow-none hover:text-foreground" aria-label={t("validation.metricDefinition", { metric: label })} onClick={() => setHelpOpen((current) => !current)}><Info className="size-3.5" /></Button></TooltipTrigger><TooltipContent side="top" align="end" sideOffset={6} className="max-w-72 items-start text-left leading-5">{definition}</TooltipContent></Tooltip></div><dd className="mt-0.5 font-mono text-sm font-medium">{value}</dd></div>;
}

type CaseResultFilter = "all" | "failed" | "passed" | "skipped";

type CaseResultsProps = { runId: string; defaultFilter?: CaseResultFilter; excludedCaseIds?: string[]; busyCaseId?: string | undefined; onValidationScopeChange?: ((caseId: string, action: "exclude" | "restore") => void) | undefined };
export function ValidationCaseResults({ runId, defaultFilter = "all", excludedCaseIds = [], busyCaseId, onValidationScopeChange }: CaseResultsProps) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<CaseResultFilter>(defaultFilter);
  const pagination = useEventCursor(`${runId}:${filter}`);
  const query = useQuery({ queryKey: ["validation-cases", runId, filter, pagination.cursor], queryFn: ({ signal }) => getValidationCases(runId, filter, pagination.cursor, signal), staleTime: Infinity, gcTime: 0, retry: false });
  const counts = query.data?.counts;
  return <section className="overflow-hidden rounded-sm border">
    <header className="border-b bg-muted/25 px-3 py-2.5"><h3 className="text-sm font-semibold">{t("validation.caseResults")}</h3>
      {counts?.warnings ? <p className="mt-1 text-xs text-muted-foreground">{t("validation.executionWarningCount", { count: counts.warnings })}</p> : null}
      <div className="mt-2 flex gap-1" role="group" aria-label={t("validation.filterCaseResults")}>{(["all", "failed", "passed", "skipped"] as const).map(value => <Button key={value} type="button" size="sm" variant={filter === value ? "secondary" : "ghost"} className="min-h-11 px-3" aria-pressed={filter === value} onClick={() => setFilter(value)}>{t(value === "skipped" ? "validationScope.skipped" : `validation.caseFilters.${value}`)}<span className="font-mono text-xs">{counts?.[value] ?? "—"}</span></Button>)}</div>
    </header>
    <div className="space-y-3 bg-background p-3" aria-busy={query.isFetching}>
      {query.isPending ? <Skeleton className="h-48" /> : query.error ? <><ErrorNotice error={query.error} /><Button variant="outline" onClick={() => void query.refetch()}>{t("common.retry")}</Button></> : !query.data?.items.length ? <p role="status" className="px-4 py-6 text-sm text-muted-foreground">{t(filter === "skipped" ? "validationScope.empty" : `validation.emptyCaseResults.${filter}`)}</p> : query.data.items.map(result => <TestCaseResultRow key={result.ordinal} result={result} runId={runId} ordinal={result.ordinal} excluded={excludedCaseIds.includes(result.case_id)} busy={busyCaseId === result.case_id} onValidationScopeChange={onValidationScopeChange} />)}
    </div>
    <EventPagination page={pagination.page} busy={query.isFetching} nextCursor={query.data?.nextCursor} onNext={pagination.next} onPrevious={pagination.previous} onLatest={pagination.latest} casePages itemCount={query.data?.items.length ?? 0} />
  </section>;
}

export function TestCaseResultRow({ result: summary, runId, ordinal, excluded = false, busy = false, onValidationScopeChange }: { result: TestCaseResult; runId?: string; ordinal?: number; excluded?: boolean; busy?: boolean; onValidationScopeChange?: ((caseId: string, action: "exclude" | "restore") => void) | undefined }) {
  const [open, setOpen] = useState(!runId && isExecutionError(summary));
  const [traceOffset, setTraceOffset] = useState(0);
  const detail = useQuery({ queryKey: ["validation-case", runId, ordinal, traceOffset], queryFn: ({ signal }) => getValidationCase(runId!, ordinal!, traceOffset, signal), enabled: Boolean(runId && open), staleTime: Infinity, gcTime: 0, retry: false });
  const result = runId ? detail.data?.result ?? summary : summary;
  const { t } = useTranslation();
  const executionWarning = hasExecutionWarning(result);
  const failed = !result.passed && !result.skipped;
  const sameRules = result.covered_rule_ids.length === result.matched_rule_ids.length
    && result.covered_rule_ids.every(id => result.matched_rule_ids.includes(id));
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)} className={cn("group/case validation-case overflow-hidden rounded-sm border bg-card", failed && "border-l-2 border-l-destructive")}>
    <summary className="grid min-h-18 cursor-pointer list-none grid-cols-[minmax(0,1fr)_100px_72px_20px] items-center gap-3 bg-muted/40 px-4 py-3 group-open/case:bg-muted/70 hover:bg-accent group-open/case:hover:bg-accent active:bg-muted group-open/case:active:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <strong className="min-w-0 break-words text-base font-semibold leading-6 text-foreground [overflow-wrap:anywhere]">{result.name}</strong>
          {!result.skipped ? <StateBadge state={result.passed ? "passed" : "failed"} label={executionWarning ? t("validation.executionWarningBadge") : undefined} /> : null}
          {excluded ? <Badge variant="secondary">{t("guardrails.excludedFromValidation")}</Badge> : null}
          <Badge variant="outline" className="shrink-0 font-normal">{testCaseTypeLabel(result.case_type, t)}</Badge>
        </div>
        <p className="mt-1 break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">{humanize(result.policy_id)} · {humanize(result.phase)}</p>
      </div>
      <span className="justify-self-start">{result.skipped ? <Badge variant="secondary">{t("validationScope.skipped")}</Badge> : <StateBadge state={result.actual_decision} />}</span>
      <span className="whitespace-nowrap text-right font-mono text-xs tabular-nums text-muted-foreground">{result.skipped ? "—" : `${result.latency_ms} ms`}</span>
      <ChevronDown aria-hidden className="size-4 text-muted-foreground transition-transform group-open/case:rotate-180 motion-reduce:transition-none" />
    </summary>
    {runId && !open ? null : runId && !detail.data ? <div className="border-t p-4">{detail.error ? <><ErrorNotice error={detail.error} /><Button variant="outline" onClick={() => void detail.refetch()}>{t("common.retry")}</Button></> : <Skeleton className="h-32" />}</div> : <div className="space-y-4 border-t bg-card p-4">
      {failed ? <FailureDiagnosis result={result} /> : null}
      {executionWarning ? <Alert variant="warning">
        <AlertTitle>{t("validation.executionWarningTitle")}</AlertTitle>
        <AlertDescription>{t("validation.executionWarningDescription", { failure: humanize(result.actual_failure!) })}</AlertDescription>
      </Alert> : null}
      {result.skipped && (result.skip_reason || result.reason) ? <p className="break-words text-sm leading-5 [overflow-wrap:anywhere]">{result.skip_reason || result.reason}</p> : null}
      {result.superseded_by?.length ? <section className="border-t pt-3">
        <h4 className="text-xs font-semibold">{t("validation.supersededTitle")}</h4>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{result.evidence_detail}</p>
        <ul className="mt-2 space-y-1">{result.superseded_by.map(match => <li key={`${match.policyId}/${match.ruleId}`} className="break-all font-mono text-xs">{match.policyId} / {match.ruleId}</li>)}</ul>
      </section> : null}
      {result.source_policy_id ? <details className="border-t">
        <summary className="min-h-11 cursor-pointer content-center text-xs font-medium focus-visible:outline-2 focus-visible:outline-ring">{t("validation.acceptanceProvenance")}</summary>
        <dl className="grid grid-cols-2 gap-4 pb-3 text-xs">
          <div className="min-w-0"><dt className="text-muted-foreground">{t("validation.sourcePolicy")}</dt><dd className="mt-1 break-all font-mono">{result.source_policy_id}@{result.source_policy_version}</dd></div>
          <div className="min-w-0"><dt className="text-muted-foreground">{t("validation.sourceTestCase")}</dt><dd className="mt-1 break-all font-mono">{result.source_case_id}</dd></div>
          {(!failed || result.rule_contract_satisfied) && (sameRules ? <div className="col-span-2 min-w-0"><dt className="text-muted-foreground">{t("validation.expectedAndMatchedRules")}</dt><dd className="mt-1 space-y-1">{result.covered_rule_ids.length ? result.covered_rule_ids.map(id => <code key={id} className="block break-all">{id}</code>) : t("validation.noCoveredRule")}</dd></div> : <>
            <div className="min-w-0"><dt className="text-muted-foreground">{t("validation.coveredRules")}</dt><dd className="mt-1 space-y-1">{result.covered_rule_ids.length ? result.covered_rule_ids.map(id => <code key={id} className="block break-all">{id}</code>) : t("validation.noCoveredRule")}</dd></div>
            <div className="min-w-0"><dt className="text-muted-foreground">{t("validation.matchedRules")}</dt><dd className="mt-1 space-y-1">{result.matched_rule_ids.length ? result.matched_rule_ids.map(id => <code key={id} className="block break-all">{id}</code>) : <span>{t("validation.noRulesMatched")}</span>}</dd></div>
          </>)}
        </dl>
      </details> : null}
      {result.trace.length || !result.skipped && result.reason ? <ExecutionTrace steps={playgroundTraceSteps(result.trace)} description={result.skipped ? undefined : result.reason} /> : null}
      {runId && (traceOffset > 0 || detail.data?.nextTraceOffset != null) ? <nav className="flex items-center justify-end gap-2" aria-label={t("eventPagination.label")}><Button variant="outline" disabled={detail.isFetching || traceOffset === 0} onClick={() => setTraceOffset(Math.max(0, traceOffset - 100))}>{t("eventPagination.previous")}</Button><Button variant="outline" disabled={detail.isFetching || detail.data?.nextTraceOffset == null} onClick={() => { if (detail.data?.nextTraceOffset != null) setTraceOffset(detail.data.nextTraceOffset); }}>{t("eventPagination.next")}</Button></nav> : null}
      {!result.passed && !result.skipped && result.source_policy_id && onValidationScopeChange ? <section className="flex items-center justify-between gap-4 border-t pt-3">
        <div className="min-w-0"><h4 className="text-xs font-semibold">{excluded ? t("validation.caseExcludedTitle") : t("validation.excludeFailedCaseTitle")}</h4><p className="mt-1 text-xs leading-5 text-muted-foreground">{excluded ? t("validation.caseExcludedDescription") : t("validation.excludeFailedCaseDescription")}</p></div>
        <Button size="sm" variant="outline" className="min-h-11 shrink-0" disabled={busy} onClick={() => onValidationScopeChange(result.case_id, excluded ? "restore" : "exclude")}>{busy ? <LoaderCircle className="animate-spin" /> : excluded ? <RotateCcw /> : <Ban />}{t(excluded ? "guardrails.restoreTestCase" : "guardrails.excludeTestCase")}</Button>
      </section> : null}
    </div>}
  </details>;
}

function FailureDiagnosis({ result }: { result: TestCaseResult }) {
  const { t } = useTranslation();
  const reasons: string[] = [];
  if (!decisionMatches(result.expected_decision, result.actual_decision)) reasons.push(t("validation.decisionMismatch", { expected: humanize(result.expected_decision), actual: humanize(result.actual_decision) }));
  if (!result.rule_contract_satisfied) reasons.push(t("validation.ruleMismatch", { expected: result.covered_rule_ids.join(", ") || t("validation.noCoveredRule"), actual: result.matched_rule_ids.join(", ") || t("validation.noRulesMatched") }));
  if (result.actual_failure) reasons.push(t("validation.executionFailure", { failure: humanize(result.actual_failure) }));
  if (result.expected_reasoning_result && result.expected_reasoning_result !== result.actual_reasoning_result) reasons.push(t("validation.reasoningMismatch", { expected: humanize(result.expected_reasoning_result), actual: result.actual_reasoning_result ? humanize(result.actual_reasoning_result) : t("validation.noReasoningResult") }));
  if (!reasons.length) reasons.push(t("validation.validationContractMismatch"));
  return <section className="mb-2 border-l-2 border-destructive bg-destructive/[0.06] p-2.5 text-xs"><h4 className="font-semibold text-destructive">{t("validation.whyCaseFailed")}</h4><ul className="mt-1.5 space-y-1 text-destructive/85">{reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></section>;
}

export function targetLabel(run: ValidationRun, t: ReturnType<typeof useTranslation>["t"]) {
  return t("validation.versionTarget", { version: run.guardrail_version });
}
function isExecutionError(result: TestCaseResult) { return !result.skipped && (Boolean(result.actual_failure) || result.actual_decision.toLowerCase() === "error"); }
function hasExecutionWarning(result: TestCaseResult) { return result.passed && !result.skipped && Boolean(result.actual_failure) && !result.expected_failure; }
function decisionMatches(expected: string, actual: string) { return expected === "intervene" ? actual !== "allow" : expected === actual; }
function reportNumber(id: string) { return id.replace(/^(?:policy-)?(?:validation|testing-report)-/, ""); }
function shortId(id: string) { return reportNumber(id).slice(0, 8).toUpperCase(); }
function humanize(value: string) { return value ? value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) : "—"; }
function testCaseTypeLabel(value: string, t: ReturnType<typeof useTranslation>["t"]) { return value === "rule_acceptance" || value === "scenario" || value === "custom" || value === "unit" ? t(`validation.caseTypes.${value}`) : humanize(value); }
function notifyError(error: unknown, fallback: string) { toast.error(error instanceof Error ? error.message : fallback); }
