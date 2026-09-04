import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Ban, ChevronDown, ChevronRight, Info, LoaderCircle, Play, Plus, RotateCcw, Search, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

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
  restoreGuardrailTestCase,
  type TestCaseResult,
  type Guardrail,
  type ValidationRun,
} from "@/lib/api";

export function ValidationPage() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const auth = useAuth();
  const canManage = auth.user?.role === "admin";
  const requestedGuardrail = typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("guardrail") ?? "";
  const guardrailsQuery = useQuery({ queryKey: queryKeys.guardrails, queryFn: getGuardrails });
  const runsQuery = useQuery({ queryKey: queryKeys.allValidationRuns, queryFn: () => getValidationRuns() });
  const guardrails = (guardrailsQuery.data?.items ?? []).filter((item) => item.is_default || !item.system_managed);
  const runs = runsQuery.data?.items ?? [];
  const [createOpen, setCreateOpen] = useState(false);
  useEffect(() => { if (requestedGuardrail && canManage) setCreateOpen(true); }, [canManage, requestedGuardrail]);
  const [selected, setSelected] = useState<ValidationRun | null>(null);
  const [search, setSearch] = useState("");
  const [guardrailId, setGuardrailId] = useState("all");
  const [status, setStatus] = useState("all");
  const guardrailNames = useMemo(() => new Map(guardrails.map((item) => [item.id, item.name])), [guardrails]);
  const guardrailIds = useMemo(() => [...new Set(runs.map((run) => run.guardrail_id))].sort((left, right) => (guardrailNames.get(left) ?? left).localeCompare(guardrailNames.get(right) ?? right, i18n.language)), [guardrailNames, i18n.language, runs]);
  const filtered = useMemo(() => filterValidationRuns(runs, guardrailNames, search, guardrailId, status), [guardrailId, guardrailNames, runs, search, status]);
  const refresh = async () => { await Promise.all([queryClient.invalidateQueries({ queryKey: queryKeys.allValidationRuns }), queryClient.invalidateQueries({ queryKey: queryKeys.guardrails })]); };
  const rerun = useMutation({ mutationFn: (guardrailId: string) => createValidationRun(guardrailId), onSuccess: async (run) => { await refresh(); setSelected(run); toast[run.status === "passed" ? "success" : "error"](t(run.status === "passed" ? "guardrails.validationPassed" : "guardrails.validationFailed", { rate: run.metrics.compliance_rate })); }, onError: (error) => notifyError(error, t("guardrails.operationFailed")) });

  return (
    <section className="py-6 sm:py-8">
      <PageHeader title={t("pages.validation.title")} description={t("pages.validation.description")} action={canManage ? <Button className="min-h-11" disabled={!guardrails.length} onClick={() => setCreateOpen(true)}><Plus />{t("validation.createValidationRun")}</Button> : undefined} />
      {guardrailsQuery.error || runsQuery.error ? <div className="mt-5"><ErrorNotice error={guardrailsQuery.error || runsQuery.error} /></div> : null}
      {guardrailsQuery.isLoading || runsQuery.isLoading ? <Skeleton className="mt-5 h-[34rem] rounded-xl" /> : null}
      {!guardrailsQuery.isLoading && !guardrails.length ? <div className="mt-5"><EmptyState title={t("validation.noGuardrails")} description={t("validation.noGuardrailsDescription")} /></div> : null}
      {!runsQuery.isLoading && guardrails.length ? (
        <section className="mt-5 overflow-hidden rounded-xl border bg-card shadow-xs">
          <div className="grid gap-3 border-b bg-muted/20 p-4 sm:grid-cols-2 lg:grid-cols-[minmax(16rem,1fr)_minmax(14rem,18rem)_12rem_auto] lg:items-center"><label className="relative"><span className="sr-only">{t("validation.searchValidationRuns")}</span><Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" /><Input className="min-h-11 bg-card pl-9" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("validation.searchValidationRuns")} /></label><Select value={guardrailId} onValueChange={setGuardrailId}><SelectTrigger className="min-h-11 min-w-0 bg-card" aria-label={t("validation.filterGuardrailId")}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t("validation.allGuardrailIds")}</SelectItem>{guardrailIds.map((id) => <SelectItem key={id} value={id}>{guardrailNames.get(id) ? `${guardrailNames.get(id)} · ${id}` : id}</SelectItem>)}</SelectContent></Select><Select value={status} onValueChange={setStatus}><SelectTrigger className="min-h-11 bg-card" aria-label={t("validation.filterStatus")}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t("validation.allStatuses")}</SelectItem><SelectItem value="passed">{t("states.passed")}</SelectItem><SelectItem value="failed">{t("states.failed")}</SelectItem><SelectItem value="incomplete">{t("states.incomplete")}</SelectItem></SelectContent></Select><p className="text-xs text-muted-foreground sm:text-right">{t("validation.validationRunCount", { count: filtered.length })}</p></div>
          {filtered.length ? <Table><TableHeader><TableRow className="hover:bg-transparent"><TableHead className="pl-4">{t("validation.validationRunColumn")}</TableHead><TableHead>{t("validation.guardrailColumn")}</TableHead><TableHead>{t("validation.targetColumn")}</TableHead><TableHead>{t("validation.casesColumn")}</TableHead><TableHead>{t("validation.statusColumn")}</TableHead><TableHead>{t("validation.passRateColumn")}</TableHead><TableHead>{t("validation.durationColumn")}</TableHead><TableHead>{t("validation.runAtColumn")}</TableHead><TableHead className="w-12"><span className="sr-only">{t("validation.openValidationRun")}</span></TableHead></TableRow></TableHeader><TableBody>{filtered.map((run) => <ValidationRow key={run.id} run={run} guardrailName={guardrailNames.get(run.guardrail_id)} locale={i18n.language} onOpen={() => setSelected(run)} />)}</TableBody></Table> : <EmptyState title={runs.length ? t("validation.noMatchingValidationRuns") : t("validation.noValidationRuns")} description={runs.length ? t("validation.noMatchingValidationRunsDescription") : t("validation.noValidationRunsDescription")} action={canManage && !runs.length ? <Button onClick={() => setCreateOpen(true)}><Plus />{t("validation.createValidationRun")}</Button> : undefined} />}
        </section>
      ) : null}
      <CreateValidationSheet open={createOpen} onOpenChange={setCreateOpen} guardrails={guardrails} initialGuardrailId={requestedGuardrail} onCreated={async (run) => { setCreateOpen(false); await refresh(); setSelected(run); }} />
      <ValidationDetailSheet run={selected} guardrail={selected ? guardrails.find((item) => item.id === selected.guardrail_id) : undefined} canManage={canManage} running={rerun.isPending} onRunAgain={(guardrailId) => rerun.mutate(guardrailId)} onClose={() => setSelected(null)} />
    </section>
  );
}

export function filterValidationRuns(runs: ValidationRun[], guardrailNames: Map<string, string>, search: string, guardrailId: string, status: string) {
  const query = search.trim().toLowerCase();
  return runs.filter((run) => (guardrailId === "all" || run.guardrail_id === guardrailId) && (status === "all" || run.status === status) && (!query || `${run.id} ${guardrailNames.get(run.guardrail_id) ?? run.guardrail_id}`.toLowerCase().includes(query)));
}

export function GuardrailValidationHistory({ runs, loading, error, canManage, running, onRun, onOpen, onOpenTarget }: {
  runs: ValidationRun[];
  loading: boolean;
  error: unknown;
  canManage: boolean;
  running: boolean;
  onRun: () => void;
  onOpen: (run: ValidationRun) => void;
  onOpenTarget: (run: ValidationRun) => void;
}) {
  const { t, i18n } = useTranslation();
  const orderedRuns = useMemo(() => [...runs].sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at)), [runs]);
  return <section className="overflow-hidden rounded-xl border bg-card shadow-xs">
    <header className="flex flex-col gap-3 border-b bg-muted/20 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <div className="flex flex-wrap items-center gap-2"><h2 className="text-sm font-semibold">{t("guardrails.validationHistoryTitle")}</h2><Badge variant="outline" className="font-mono text-[10px]">{orderedRuns.length}</Badge></div>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("guardrails.validationHistoryDescription")}</p>
      </div>
      {canManage ? <Button className="min-h-11 shrink-0" disabled={running} onClick={onRun}>{running ? <LoaderCircle className="animate-spin" /> : <Play />}{t(running ? "guardrails.runningValidation" : "guardrails.runReviewed")}</Button> : null}
    </header>
    {error ? <div className="p-4"><ErrorNotice error={error} /></div> : null}
    {loading ? <div className="p-4"><Skeleton className="h-72 rounded-lg" /></div> : null}
    {!loading && !error && orderedRuns.length ? <div className="overflow-x-auto"><Table>
      <TableHeader><TableRow className="hover:bg-transparent"><TableHead className="min-w-52 pl-4">{t("validation.validationRunColumn")}</TableHead><TableHead>{t("validation.targetColumn")}</TableHead><TableHead>{t("validation.casesColumn")}</TableHead><TableHead>{t("validation.statusColumn")}</TableHead><TableHead>{t("validation.passRateColumn")}</TableHead><TableHead>{t("validation.durationColumn")}</TableHead><TableHead>{t("validation.runAtColumn")}</TableHead><TableHead className="w-12"><span className="sr-only">{t("validation.openValidationRun")}</span></TableHead></TableRow></TableHeader>
      <TableBody>{orderedRuns.map((run) => <ValidationRow key={run.id} run={run} locale={i18n.language} showGuardrail={false} onOpen={() => onOpen(run)} onOpenTarget={() => onOpenTarget(run)} />)}</TableBody>
    </Table></div> : null}
    {!loading && !error && !orderedRuns.length ? <EmptyState title={t("validation.noValidationRuns")} description={t("validation.noValidationRunsDescription")} action={canManage ? <Button onClick={onRun}><Play />{t("guardrails.runReviewed")}</Button> : undefined} /> : null}
  </section>;
}

function ValidationRow({ run, guardrailName, locale, showGuardrail = true, onOpen, onOpenTarget }: { run: ValidationRun; guardrailName?: string; locale: string; showGuardrail?: boolean; onOpen: () => void; onOpenTarget?: () => void }) {
  const { t } = useTranslation();
  return <TableRow className="cursor-pointer" onClick={onOpen}><TableCell className="pl-4"><strong className="block text-sm font-medium">{t("validation.validationRunNamed", { id: shortId(run.id) })}</strong><span className="mt-1 block font-mono text-xs text-muted-foreground">{run.id}</span></TableCell>{showGuardrail ? <TableCell><strong className="block text-sm font-medium">{guardrailName ?? run.guardrail_id}</strong>{guardrailName ? <span className="mt-1 block font-mono text-xs text-muted-foreground">{run.guardrail_id}</span> : null}</TableCell> : null}<TableCell className="text-xs"><ValidationTarget run={run} onOpen={onOpenTarget} /></TableCell><TableCell className="font-mono text-xs">{run.metrics.total}</TableCell><TableCell><StateBadge state={run.status} /></TableCell><TableCell className="font-mono text-xs">{run.metrics.compliance_rate}%</TableCell><TableCell className="font-mono text-xs">P95 {run.metrics.p95_latency_ms} ms</TableCell><TableCell className="whitespace-nowrap text-xs text-muted-foreground">{new Date(run.created_at).toLocaleString(locale)}</TableCell><TableCell><Button type="button" variant="ghost" size="icon" className="size-11" aria-label={t("validation.openValidationRun")} onClick={(event) => { event.stopPropagation(); onOpen(); }}><ChevronRight className="size-4 text-muted-foreground" /></Button></TableCell></TableRow>;
}

function ValidationTarget({ run, onOpen }: { run: ValidationRun; onOpen?: () => void }) {
  const { t } = useTranslation();
  const label = targetLabel(run, t);
  if (!onOpen) return <span className="font-mono text-xs">{label}</span>;
  return <Button type="button" variant="link" className="-my-2 h-auto min-h-11 justify-start gap-1.5 px-0 py-2 font-mono text-xs" onClick={(event) => { event.stopPropagation(); onOpen?.(); }} onKeyDown={(event) => event.stopPropagation()}>{label}<ArrowUpRight className="size-3.5" /></Button>;
}

function CreateValidationSheet({ open, onOpenChange, guardrails, initialGuardrailId, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; guardrails: Guardrail[]; initialGuardrailId: string; onCreated: (run: ValidationRun) => Promise<void> }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [guardrailId, setGuardrailId] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  useEffect(() => { if (open) setGuardrailId(guardrails.some((item) => item.id === initialGuardrailId) ? initialGuardrailId : guardrails[0]?.id ?? ""); }, [guardrails, initialGuardrailId, open]);
  const guardrail = guardrails.find((item) => item.id === guardrailId);
  const casesQuery = useQuery({ queryKey: queryKeys.testCases(guardrailId), queryFn: () => getTestCases(guardrailId), enabled: open && Boolean(guardrailId) });
  const cases = casesQuery.data?.items ?? [];
  const activeCases = cases.filter((item) => !item.excluded);
  const run = useMutation({ mutationFn: () => createValidationRun(guardrailId), onSuccess: async (result) => { toast[result.status === "passed" ? "success" : "error"](t(result.status === "passed" ? "guardrails.validationPassed" : "guardrails.validationFailed", { rate: result.metrics.compliance_rate })); await onCreated(result); }, onError: (error) => notifyError(error, t("guardrails.operationFailed")) });
  const remove = useMutation({ mutationFn: deleteTestCase, onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: queryKeys.testCases(guardrailId) }); toast.success(t("guardrails.caseRemoved")); }, onError: (error) => notifyError(error, t("guardrails.operationFailed")) });
  const validationScope = useMutation({ mutationFn: ({ caseId, action }: { caseId: string; action: "exclude" | "restore" }) => action === "exclude" ? excludeGuardrailTestCase(guardrailId, caseId) : restoreGuardrailTestCase(guardrailId, caseId), onSuccess: async (_, variables) => { await Promise.all([queryClient.invalidateQueries({ queryKey: queryKeys.testCases(guardrailId) }), queryClient.invalidateQueries({ queryKey: queryKeys.guardrail(guardrailId) }), queryClient.invalidateQueries({ queryKey: queryKeys.guardrails })]); toast.success(t(variables.action === "exclude" ? "guardrails.testCaseExcluded" : "guardrails.testCaseRestored")); }, onError: (error) => notifyError(error, t("guardrails.operationFailed")) });
  return <><EntitySheet open={open} onOpenChange={onOpenChange} eyebrow={t("validation.createEyebrow")} title={t("validation.createValidationRun")} description={t("validation.createValidationRunDescription")} width="lg" footer={<><Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button><Button disabled={!guardrailId || !activeCases.length || run.isPending} onClick={() => run.mutate()}>{run.isPending ? <LoaderCircle className="animate-spin" /> : <Play />}{t(run.isPending ? "guardrails.runningValidation" : "validation.runRegression")}</Button></>}>
    <div className="space-y-5"><label className="grid gap-2 text-sm font-medium">{t("validation.chooseGuardrail")}<Select value={guardrailId} onValueChange={setGuardrailId}><SelectTrigger className="min-h-11 bg-card"><SelectValue /></SelectTrigger><SelectContent>{guardrails.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent></Select></label>
      {guardrail ? <section className="rounded-xl border bg-muted/20 p-4"><div className="flex flex-wrap items-center gap-2"><strong className="text-sm">{guardrail.name}</strong><StateBadge state={guardrail.status} /></div><p className="mt-2 text-xs leading-5 text-muted-foreground">{guardrail.purpose}</p><p className="mt-3 text-xs font-medium">{t("validation.draftTarget", { revision: guardrail.tested_current ? guardrail.latest_validation_run?.source_draft_version ?? "—" : "current" })}</p></section> : null}
      <section className="overflow-hidden rounded-xl border"><header className="flex items-center justify-between gap-3 border-b bg-muted/25 px-4 py-3"><div><h3 className="text-sm font-semibold">{t("validation.testCases")}</h3><p className="mt-1 text-xs text-muted-foreground">{t("validation.validationScopeCount", { active: activeCases.length, excluded: cases.length - activeCases.length })}</p></div><Button variant="outline" size="sm" onClick={() => setAddOpen(true)} disabled={!guardrail}><Plus />{t("guardrails.addTestCase")}</Button></header>{casesQuery.isLoading ? <div className="p-4"><Skeleton className="h-32" /></div> : cases.length ? <div className="max-h-72 divide-y overflow-y-auto">{cases.map((item) => <div key={item.id} className={cn("grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3", item.excluded && "bg-muted/30 text-muted-foreground")}><div className="min-w-0"><div className="flex min-w-0 flex-wrap items-center gap-2"><strong className="truncate text-sm font-medium">{item.name}</strong><Badge variant="outline" className="font-normal">{testCaseTypeLabel(item.case_type, t)}</Badge>{item.excluded ? <Badge variant="secondary">{t("guardrails.excludedFromValidation")}</Badge> : null}</div><span className="mt-1 block text-xs text-muted-foreground">{humanize(item.policy_id)} · {humanize(item.phase)} · {humanize(item.expected_decision)}</span>{item.source_policy_id ? <span className="mt-1 block truncate font-mono text-xs text-muted-foreground">{item.source_policy_id}@{item.source_policy_version} · {item.source_case_id}</span> : null}</div>{item.origin === "custom" ? <Button type="button" size="icon" variant="ghost" className="size-11" aria-label={t("validation.deleteCase", { name: item.name })} disabled={remove.isPending} onClick={() => remove.mutate(item.id)}><Trash2 /></Button> : item.excluded ? <Button type="button" size="sm" variant="outline" className="min-h-11" disabled={validationScope.isPending} onClick={() => validationScope.mutate({ caseId: item.id, action: "restore" })}><RotateCcw />{t("guardrails.restoreTestCase")}</Button> : <Button type="button" size="sm" variant="outline" className="min-h-11 text-foreground" disabled={validationScope.isPending} onClick={() => validationScope.mutate({ caseId: item.id, action: "exclude" })}><Ban />{t("guardrails.excludeTestCase")}</Button>}</div>)}</div> : <div className="p-4"><InfoNotice title={t("guardrails.noCases")}>{t("guardrails.noCasesDescription")}</InfoNotice></div>}</section>
      <InfoNotice title={t("validation.releaseSemantics")}>{t("validation.releaseSemanticsDescription")}</InfoNotice>
    </div>
  </EntitySheet>{guardrail ? <AddTestCaseSheet guardrail={guardrail} open={addOpen} onOpenChange={setAddOpen} onCreated={async () => { setAddOpen(false); await queryClient.invalidateQueries({ queryKey: queryKeys.testCases(guardrailId) }); }} /> : null}</>;
}

export function ValidationDetailSheet({ run, guardrail, canManage, running, onRunAgain, onOpenTarget, onClose }: { run: ValidationRun | null; guardrail?: Guardrail; canManage: boolean; running: boolean; onRunAgain: (guardrailId: string) => void; onOpenTarget?: (run: ValidationRun) => void; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const validationScope = useMutation({ mutationFn: ({ guardrailId, caseId, action }: { guardrailId: string; caseId: string; action: "exclude" | "restore" }) => action === "exclude" ? excludeGuardrailTestCase(guardrailId, caseId) : restoreGuardrailTestCase(guardrailId, caseId), onSuccess: async (_, variables) => { await Promise.all([queryClient.invalidateQueries({ queryKey: queryKeys.testCases(variables.guardrailId) }), queryClient.invalidateQueries({ queryKey: queryKeys.guardrail(variables.guardrailId) }), queryClient.invalidateQueries({ queryKey: queryKeys.guardrails })]); toast.success(t(variables.action === "exclude" ? "guardrails.testCaseExcludedRerun" : "guardrails.testCaseRestored")); }, onError: (error) => notifyError(error, t("guardrails.operationFailed")) });
  if (!run) return null;
  const results = [...run.results].sort((left, right) => resultPriority(left) - resultPriority(right));
  return <EntitySheet open density="compact" onOpenChange={(next) => { if (!next) onClose(); }} eyebrow={t("validation.detailEyebrow")} title={t("validation.validationRunNamed", { id: shortId(run.id) })} description={`${guardrail?.name ?? run.guardrail_id} · ${new Date(run.created_at).toLocaleString(i18n.language)}`} width="xl" footer={<><Button variant="outline" onClick={onClose}>{t("common.close")}</Button>{canManage ? <Button disabled={running} onClick={() => onRunAgain(run.guardrail_id)}>{running ? <LoaderCircle className="animate-spin" /> : <Play />}{t("validation.runAgain")}</Button> : null}</>}>
    <div className="space-y-3">
      <section className="overflow-hidden rounded-sm border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/20 px-3 py-2.5">
          <div><p className="text-xs text-muted-foreground">{t("validation.targetColumn")}</p><div className="mt-0.5 text-sm font-medium"><ValidationTarget run={run} onOpen={onOpenTarget ? () => onOpenTarget(run) : undefined} /></div></div>
          <StateBadge state={run.status} />
        </div>
        <dl className="grid grid-cols-2 sm:grid-cols-4"><DetailFact label={t("validation.casesColumn")} value={String(run.metrics.total)} definition={t("validation.metricDefinitions.cases")} /><DetailFact label={t("validation.passRateColumn")} value={`${run.metrics.compliance_rate}%`} definition={t("validation.metricDefinitions.passRate")} /><DetailFact label={t("guardrails.falsePositive")} value={`${run.metrics.false_positive_rate}%`} definition={t("validation.metricDefinitions.falsePositive")} /><DetailFact label={t("guardrails.latency")} value={`${run.metrics.p95_latency_ms} ms`} definition={t("validation.metricDefinitions.p95Latency")} /></dl>
      </section>
      <InfoNotice title={t("validation.versionTargetReserved", { version: run.guardrail_version })}>{t("validation.versionTargetReservedDescription")}</InfoNotice>
      {run.excluded_case_ids?.length ? <InfoNotice title={t("validation.excludedScopeTitle", { count: run.excluded_case_ids.length })}>{t("validation.excludedScopeDescription")}</InfoNotice> : null}
      <ValidationCaseResults key={run.id} results={results} defaultFilter={run.status === "failed" ? "failed" : "all"} excludedCaseIds={guardrail?.excluded_test_case_ids ?? []} busyCaseId={validationScope.isPending ? validationScope.variables?.caseId : undefined} onValidationScopeChange={canManage && guardrail ? (caseId, action) => validationScope.mutate({ guardrailId: guardrail.id, caseId, action }) : undefined} />
    </div>
  </EntitySheet>;
}

export function DetailFact({ label, value, definition }: { label: string; value: string; definition: string }) {
  const { t } = useTranslation();
  const [helpOpen, setHelpOpen] = useState(false);
  return <div className="border-b px-3 py-2.5 last:border-b-0 sm:border-r sm:border-b-0 sm:last:border-r-0"><div className="flex items-center justify-between gap-2"><dt className="text-xs text-muted-foreground">{label}</dt><Tooltip open={helpOpen} onOpenChange={setHelpOpen}><TooltipTrigger asChild><Button type="button" variant="ghost" size="icon-xs" className="-my-3 -mr-3 size-11 text-muted-foreground shadow-none hover:text-foreground" aria-label={t("validation.metricDefinition", { metric: label })} onClick={() => setHelpOpen((current) => !current)}><Info className="size-3.5" /></Button></TooltipTrigger><TooltipContent side="top" align="end" sideOffset={6} className="max-w-72 items-start text-left leading-5">{definition}</TooltipContent></Tooltip></div><dd className="mt-0.5 font-mono text-sm font-medium">{value}</dd></div>;
}

type CaseResultFilter = "all" | "failed" | "passed";

export function ValidationCaseResults({ results, defaultFilter = "all", excludedCaseIds = [], busyCaseId, onValidationScopeChange }: { results: TestCaseResult[]; defaultFilter?: CaseResultFilter; excludedCaseIds?: string[]; busyCaseId?: string; onValidationScopeChange?: (caseId: string, action: "exclude" | "restore") => void }) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<CaseResultFilter>(defaultFilter);
  const failed = results.filter((result) => !result.passed).length;
  const passed = results.length - failed;
  const visible = results.filter((result) => filter === "all" || (filter === "failed" ? !result.passed : result.passed));
  const filters: Array<{ value: CaseResultFilter; label: string; count: number }> = [
    { value: "all", label: t("validation.caseFilters.all"), count: results.length },
    { value: "failed", label: t("validation.caseFilters.failed"), count: failed },
    { value: "passed", label: t("validation.caseFilters.passed"), count: passed },
  ];
  return <section className="overflow-hidden rounded-sm border"><header className="border-b bg-muted/25 px-3 py-2.5"><h3 className="text-sm font-semibold">{t("validation.caseResults")}</h3><p className="mt-0.5 text-xs text-muted-foreground">{t("validation.failuresFirst")}</p><div className="mt-2 flex flex-wrap gap-1" role="group" aria-label={t("validation.filterCaseResults")}>{filters.map((item) => <Button key={item.value} type="button" size="sm" variant={filter === item.value ? "secondary" : "ghost"} className="min-h-11 px-3" aria-pressed={filter === item.value} onClick={() => setFilter(item.value)}>{item.label}<span className={cn("font-mono text-[11px] text-muted-foreground", item.value === "failed" && item.count > 0 && "text-destructive")}>{item.count}</span></Button>)}</div></header><div className="divide-y">{visible.map((result) => <TestCaseResultRow key={result.case_id} result={result} excluded={excludedCaseIds.includes(result.case_id)} busy={busyCaseId === result.case_id} onValidationScopeChange={onValidationScopeChange} />)}</div></section>;
}

export function TestCaseResultRow({ result, excluded = false, busy = false, onValidationScopeChange }: { result: TestCaseResult; excluded?: boolean; busy?: boolean; onValidationScopeChange?: (caseId: string, action: "exclude" | "restore") => void }) {
  const { t } = useTranslation();
  const hasExecutionError = isExecutionError(result);
  return <details open={hasExecutionError} className={cn("group", !result.passed && "border-l-2 border-l-destructive bg-destructive/[0.035]")}><summary className="grid min-h-14 cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto_auto_20px] items-center gap-2 px-3 py-2.5 focus-visible:outline-2 focus-visible:outline-ring sm:grid-cols-[minmax(0,1fr)_100px_72px_20px] [&::-webkit-details-marker]:hidden"><div className="min-w-0"><div className="flex items-center gap-2">{!result.passed ? <span aria-hidden className="size-2 shrink-0 rounded-full bg-destructive" /> : null}<strong className={cn("min-w-0 truncate text-sm font-medium", !result.passed && "font-semibold text-destructive")}>{result.name}</strong>{!result.passed ? <StateBadge state="failed" /> : null}{excluded ? <Badge variant="secondary">{t("guardrails.excludedFromValidation")}</Badge> : null}<Badge variant="outline" className="hidden shrink-0 font-normal sm:inline-flex">{testCaseTypeLabel(result.case_type, t)}</Badge></div><p className="mt-0.5 truncate text-xs text-muted-foreground">{humanize(result.policy_id)} · {humanize(result.phase)}</p></div><StateBadge state={result.actual_decision} /><span className="font-mono text-xs text-muted-foreground">{result.latency_ms} ms</span><ChevronDown className="size-3.5 text-muted-foreground transition-transform group-open:rotate-180" /></summary><div className="border-t bg-muted/15 p-3">{!result.passed ? <FailureDiagnosis result={result} /> : null}{!result.passed && result.source_policy_id && onValidationScopeChange ? <section className="mb-2 flex flex-col gap-3 rounded-sm border bg-card p-3 sm:flex-row sm:items-center sm:justify-between"><div><h4 className="text-xs font-semibold">{excluded ? t("validation.caseExcludedTitle") : t("validation.excludeFailedCaseTitle")}</h4><p className="mt-1 text-xs leading-5 text-muted-foreground">{excluded ? t("validation.caseExcludedDescription") : t("validation.excludeFailedCaseDescription")}</p></div><Button size="sm" variant="outline" disabled={busy} onClick={() => onValidationScopeChange(result.case_id, excluded ? "restore" : "exclude")}>{busy ? <LoaderCircle className="animate-spin" /> : excluded ? <RotateCcw /> : <Ban />}{t(excluded ? "guardrails.restoreTestCase" : "guardrails.excludeTestCase")}</Button></section> : null}{result.source_policy_id ? <section className="mb-2 rounded-sm border bg-card p-3"><h4 className="text-xs font-medium text-muted-foreground">{t("validation.acceptanceProvenance")}</h4><dl className="mt-2 grid gap-2 text-xs sm:grid-cols-2"><div><dt className="text-muted-foreground">{t("validation.sourcePolicy")}</dt><dd className="mt-1 break-all font-mono">{result.source_policy_id}@{result.source_policy_version}</dd></div><div><dt className="text-muted-foreground">{t("validation.sourceTestCase")}</dt><dd className="mt-1 break-all font-mono">{result.source_case_id}</dd></div><div><dt className="text-muted-foreground">{t("validation.coveredRules")}</dt><dd className="mt-1 flex flex-wrap gap-1">{result.covered_rule_ids.map((id) => <code key={id} className="rounded-sm bg-muted px-1.5 py-0.5 text-xs">{id}</code>)}</dd></div><div><dt className="text-muted-foreground">{t("validation.matchedRules")}</dt><dd className="mt-1 flex flex-wrap gap-1">{result.matched_rule_ids.length ? result.matched_rule_ids.map((id) => <code key={id} className="rounded-sm bg-muted px-1.5 py-0.5 text-xs">{id}</code>) : <span>{t("validation.noRulesMatched")}</span>}</dd></div></dl></section> : null}<div className="grid gap-2 sm:grid-cols-2"><div className="rounded-sm border bg-card p-2.5"><p className="text-xs text-muted-foreground">{t("guardrails.expectedDecision")}</p><div className="mt-1.5"><StateBadge state={result.expected_decision} /></div></div><div className="rounded-sm border bg-card p-2.5"><p className="text-xs text-muted-foreground">{t("guardrails.actualDecision")}</p><div className="mt-1.5"><StateBadge state={result.actual_decision} /></div></div></div><p className="mt-2 text-sm leading-5">{result.reason}</p>{result.trace.length ? <div className="mt-2 space-y-1.5">{result.trace.map((step) => <div key={step.id} className="flex gap-3 rounded-sm border bg-card p-2.5 text-xs"><strong>{step.name}</strong><span className="min-w-0 flex-1 text-muted-foreground">{step.detail}</span><span className="font-mono text-muted-foreground">{step.duration_ms} ms</span></div>)}</div> : null}</div></details>;
}

function FailureDiagnosis({ result }: { result: TestCaseResult }) {
  const { t } = useTranslation();
  const reasons: string[] = [];
  if (!decisionMatches(result.expected_decision, result.actual_decision)) reasons.push(t("validation.decisionMismatch", { expected: humanize(result.expected_decision), actual: humanize(result.actual_decision) }));
  if (!ruleContractMatches(result)) reasons.push(t("validation.ruleMismatch", { expected: result.covered_rule_ids.join(", ") || t("validation.noCoveredRule"), actual: result.matched_rule_ids.join(", ") || t("validation.noRulesMatched") }));
  if (result.actual_failure) reasons.push(t("validation.executionFailure", { failure: humanize(result.actual_failure) }));
  if (result.expected_reasoning_result && result.expected_reasoning_result !== result.actual_reasoning_result) reasons.push(t("validation.reasoningMismatch", { expected: humanize(result.expected_reasoning_result), actual: result.actual_reasoning_result ? humanize(result.actual_reasoning_result) : t("validation.noReasoningResult") }));
  if (!reasons.length) reasons.push(t("validation.validationContractMismatch"));
  return <section className="mb-2 border-l-2 border-destructive bg-destructive/[0.06] p-2.5 text-xs"><h4 className="font-semibold text-destructive">{t("validation.whyCaseFailed")}</h4><ul className="mt-1.5 space-y-1 text-destructive/85">{reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></section>;
}

export function targetLabel(run: ValidationRun, t: ReturnType<typeof useTranslation>["t"]) {
  return t("validation.versionTarget", { version: run.guardrail_version });
}
function isExecutionError(result: TestCaseResult) { return Boolean(result.actual_failure) || result.actual_decision.toLowerCase() === "error"; }
function decisionMatches(expected: string, actual: string) { return expected === "intervene" ? actual !== "allow" : expected === actual; }
function ruleContractMatches(result: TestCaseResult) {
  if (result.expected_failure || !result.covered_rule_ids.length) return true;
  const matched = new Set(result.matched_rule_ids);
  const targetMatched = result.covered_rule_ids.some((id) => matched.has(id));
  return result.expected_decision === "allow" ? !targetMatched : targetMatched;
}
function resultPriority(result: TestCaseResult) { return isExecutionError(result) ? 0 : result.passed ? 2 : 1; }
function shortId(id: string) { return id.replace(/^validation-/, "").slice(0, 8).toUpperCase(); }
function humanize(value: string) { return value ? value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) : "—"; }
function testCaseTypeLabel(value: string, t: ReturnType<typeof useTranslation>["t"]) { return value === "rule_acceptance" || value === "scenario" || value === "custom" || value === "unit" ? t(`validation.caseTypes.${value}`) : humanize(value); }
function notifyError(error: unknown, fallback: string) { toast.error(error instanceof Error ? error.message : fallback); }
