import { deleteControllerGuardrailVersion } from "@/lib/controller-api";
import { MoreHorizontal as VersionActionsIcon } from "lucide-react";
import { DropdownMenu as VersionMenu, DropdownMenuContent as VersionMenuContent, DropdownMenuItem as VersionMenuItem, DropdownMenuTrigger as VersionMenuTrigger } from "@/components/ui/dropdown-menu";
import { useEffect, useMemo, useRef, useState, type ReactNode, type MouseEvent } from "react";
import { boundPolicy } from "@/lib/bound-policy";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { EventPagination, useEventCursor } from '@/components/event-pagination';
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { Activity, ArrowLeft, ArrowUpRight, Ban, Check, ChevronDown, Circle, CircleAlert, FlaskConical, GitCompareArrows, History, LoaderCircle, LockKeyhole, Pencil, Plus, RefreshCw, Rocket, RotateCcw, Save, ScrollText, ShieldAlert, ShieldCheck, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { RuntimeHealthAlert } from "@/components/dashboard/runtime-health-alert";
import { RuntimeMetricChart } from "@/components/dashboard/runtime-metric-chart";
import { formatEventTimestamp } from "@/components/dashboard/event-time";
import { AddTestCaseSheet } from "@/components/add-test-case-sheet";
import { CompiledRuntime } from "@/components/compiled-runtime";
import { ConfirmationSheet } from "@/components/confirmation-sheet";
import { CopyableChecksum } from "@/components/copyable-checksum";
import { EntitySheet } from "@/components/entity-sheet";
import { GuardrailVersionComparison, GuardrailVersionNavigator } from "@/components/guardrail-version-workspace";
import { GuardrailRegistry } from "@/components/guardrail-registry";
import { getPolicyBindingValidation, PolicyBindingEditor } from "@/components/policy-binding-editor";
import { ProtectionDependencies } from "@/components/protection-dependencies";
import { DeleteGuardrailSheet, type GuardrailDeletionConfirmation } from "@/components/guardrail-delete-sheet";
export { DeleteGuardrailSheet } from "@/components/guardrail-delete-sheet";
import { EmptyState, ErrorNotice, InfoNotice, PageHeader, StateBadge } from "@/components/product-shell";
import { RuntimePostureFields } from "@/components/runtime-posture-fields";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { queryKeys } from "@/features/query-keys";
import { guardrailQueries } from "@/features/guardrail-queries";
import { useAuth } from "@/lib/auth";
import { policyRequiresTopicAllowlist } from "@/lib/protection-requirements";
import {
  createValidationRun,
  deleteGuardrail,
  excludeGuardrailTestCase,
  getRouters,
  getGuardrail,
  getGuardrailDeletionImpact,
  getGuardrailFindings,
  getGuardrailVersion,
  getGuardrailVersions,
  getGuardrailLoggingSettings,
  getMetrics,
  getEndpoints,
  getPolicies,
  getTestCases,
  getValidationRuns,
  publishGuardrail,
  restoreGuardrailTestCase,
  rollbackGuardrail,
  updateGuardrail,
  updateGuardrailLoggingSettings,
  type Guardrail,
  type GuardrailFindingPage,
  type GuardrailPolicyBinding,
  type GuardrailVersion,
  type GuardrailVersionDetail,
  type MetricWindow,
  type Metrics,
  type LoggingLevel,
  type RouterTraceFinding,
  type Endpoint,
  type Policy,
  type TestCase,
  type ValidationRun,
} from "@/lib/api";
import { CreateGuardrailWizard } from "@/routes/create-guardrail-wizard";
import { CreateRouterSheet, TrafficScopeBadges } from "@/routes/routers";
import { GuardrailValidationHistory, ValidationDetailSheet } from "@/routes/validation";

export { AddTestCaseSheet };

const EMPTY_POLICIES: Policy[] = [];

export function GuardrailsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const auth = useAuth();
  const query = useQuery(guardrailQueries.list());
  const [createOpen, setCreateOpen] = useState(false);
  const createOpener = useRef<HTMLButtonElement | null>(null);
  const openCreation = (event: MouseEvent<HTMLButtonElement>) => {
    createOpener.current = event.currentTarget;
    setCreateOpen(true);
  };
  const guardrails = query.data?.items ?? [];

  return (
    <section className="py-6 sm:py-8">
      <PageHeader title={t("pages.guardrails.title")} description={t("guardrails.description")} action={auth.user?.role === "admin" ? <Button variant="create" className="min-h-11" onClick={openCreation}><Plus />{t("guardrails.create")}</Button> : undefined} />
      {query.error ? <div className="mt-5 space-y-3"><ErrorNotice error={query.error} /><Button type="button" variant="outline" className="min-h-11" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw className={query.isFetching ? "animate-spin motion-reduce:animate-none" : undefined} />{t("common.retry")}</Button></div> : null}
      {query.isPending ? <GuardrailRegistrySkeleton /> : null}
      {!query.isPending && !guardrails.length ? <div className="mt-5"><EmptyState title={t("guardrails.emptyTitle")} description={t("guardrails.emptyDescription")} action={auth.user?.role === "admin" ? <Button variant="create" onClick={openCreation}><Plus />{t("guardrails.createFirst")}</Button> : undefined} /></div> : null}
      {guardrails.length ? <GuardrailRegistry guardrails={guardrails} onOpen={(guardrailId) => navigate({ to: "/guardrails/$guardrailId", params: { guardrailId } })} /> : null}
      <CreateGuardrailWizard open={createOpen} returnFocusRef={createOpener} onOpenChange={setCreateOpen} onCreated={async (id) => { setCreateOpen(false); await queryClient.invalidateQueries({ queryKey: queryKeys.guardrails }); navigate({ to: "/guardrails/$guardrailId", params: { guardrailId: id } }); }} />
    </section>
  );
}

function GuardrailRegistrySkeleton() {
  return (
    <section className="mt-5 overflow-hidden rounded-xl border bg-card shadow-xs" aria-hidden="true">
      <header className="border-b bg-muted/25 px-5 py-3"><Skeleton className="h-4 w-36" /></header>
      <div className="flex items-center gap-3 px-5 py-4">
        <Skeleton className="size-9 shrink-0 rounded-lg" />
        <div className="min-w-0 flex-1 space-y-2"><Skeleton className="h-4 w-40" /><Skeleton className="h-3 w-full max-w-xl" /></div>
        <Skeleton className="h-5 w-20 shrink-0" />
      </div>
    </section>
  );
}

export function GuardrailDetailPage() {
  const { t } = useTranslation();
  const { guardrailId } = useParams({ strict: false }) as { guardrailId: string };
  const navigate = useNavigate();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const guardrailQuery = useQuery({ queryKey: queryKeys.guardrail(guardrailId), queryFn: () => getGuardrail(guardrailId) });
  const policiesQuery = useQuery({ queryKey: queryKeys.policies, queryFn: getPolicies });
  const versionsQuery = useQuery({ queryKey: queryKeys.guardrailVersions(guardrailId), queryFn: () => getGuardrailVersions(guardrailId) });
  const validationRunsQuery = useQuery({ queryKey: queryKeys.validationRuns(guardrailId), queryFn: () => getValidationRuns(guardrailId) });
  const testsQuery = useQuery({ queryKey: queryKeys.testCases(guardrailId), queryFn: () => getTestCases(guardrailId) });
  const routersQuery = useQuery({ queryKey: queryKeys.routers, queryFn: getRouters });
  const endpointsQuery = useQuery({ queryKey: queryKeys.endpoints, queryFn: getEndpoints });
  const [section, setSection] = useState("runtime");
  const [window, setWindow] = useState<MetricWindow>("24h");
  const [editOpen, setEditOpen] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [routerOpen, setRouterOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [validationConfirmOpen, setValidationConfirmOpen] = useState(false);
  const [selectedValidationRun, setSelectedValidationRun] = useState<ValidationRun | null>(null);
  const [selectedVersionOverride, setSelectedVersionOverride] = useState<string | null>(null);
  const [compareBaseVersionNumber, setCompareBaseVersionNumber] = useState<string | null>(null);
  const guardrailVersions = versionsQuery.data?.items ?? [];
  const compilationPending = guardrailVersions.some((item) => item.compile_status === "compiling");
  useEffect(() => {
    if (!compilationPending) return;
    const timer = globalThis.setInterval(() => {
      void Promise.all([versionsQuery.refetch(), guardrailQuery.refetch()]);
    }, 1_500);
    return () => globalThis.clearInterval(timer);
  }, [compilationPending, guardrailQuery, versionsQuery]);
  const activeVersion = guardrailVersions.find((item) => item.active);
  const selectedVersionNumber = selectedVersionOverride && guardrailVersions.some((item) => item.version === selectedVersionOverride) ? selectedVersionOverride : activeVersion?.version ?? guardrailVersions[0]?.version ?? "";
  const selectedVersion = guardrailVersions.find((item) => item.version === selectedVersionNumber);
  const selectedValidation = validationRunsQuery.data?.items.find((run) => run.guardrail_version === selectedVersionNumber && run.status === "passed") ?? null;
  const compareOptions = guardrailVersions.filter((item) => item.version < selectedVersionNumber);
  const immutableQuery = useQuery({
    queryKey: queryKeys.guardrailVersion(guardrailId, selectedVersionNumber),
    queryFn: () => getGuardrailVersion(guardrailId, selectedVersionNumber),
    enabled: Boolean(selectedVersionNumber),
  });
  const compareQuery = useQuery({
    queryKey: queryKeys.guardrailVersion(guardrailId, compareBaseVersionNumber ?? ""),
    queryFn: () => getGuardrailVersion(guardrailId, compareBaseVersionNumber ?? ""),
    enabled: Boolean(compareBaseVersionNumber),
  });
  const metricsQuery = useQuery({
    queryKey: queryKeys.metricsScope({ guardrailId, window }),
    queryFn: ({ signal }) => getMetrics({ guardrailId, window }, signal),
  });
  const [findingSeverity, setFindingSeverity] = useState<GuardrailFindingSeverityFilter>('all');
  const findingsPaging = useEventCursor(JSON.stringify([guardrailId, window, findingSeverity]));
  const findingsQuery = useQuery({
    queryKey: [...queryKeys.guardrailFindings(guardrailId, window), findingSeverity, findingsPaging.cursor ?? null],
    queryFn: ({ signal }) => getGuardrailFindings(guardrailId, window, 100, findingsPaging.cursor, signal, findingSeverity),
    gcTime: 30_000,
  });
  const deletionImpactQuery = useQuery({
    queryKey: queryKeys.guardrailDeletionImpact(guardrailId),
    queryFn: () => getGuardrailDeletionImpact(guardrailId),
    enabled: deleteOpen,
    staleTime: 0,
  });
  const deleteMutation = useMutation({
    mutationFn: (confirmation: GuardrailDeletionConfirmation) => deleteGuardrail(guardrailId, confirmation),
    onSuccess: async () => {
      toast.success(t("guardrails.deleteSucceeded"));
      await queryClient.cancelQueries({ queryKey: queryKeys.guardrail(guardrailId) });
      queryClient.removeQueries({ queryKey: queryKeys.guardrail(guardrailId) });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.guardrails, exact: true }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routers }),
        queryClient.invalidateQueries({ queryKey: queryKeys.metrics }),
        queryClient.invalidateQueries({ queryKey: queryKeys.auditEvents }),
      ]);
      navigate({ to: "/guardrails" });
    },
    onError: async () => { await deletionImpactQuery.refetch(); },
  });
  const validationMutation = useMutation({
    mutationFn: () => createValidationRun(guardrailId),
    onSuccess: async (run) => {
      setValidationConfirmOpen(false);
      await refresh();
      setSelectedValidationRun(run);
      toast[run.status === "passed" ? "success" : "error"](t(
        run.status === "passed" ? "guardrails.validationPassed" : "guardrails.validationFailed",
        { rate: run.metrics.compliance_rate },
      ));
    },
    onError: (error) => notifyError(error, t("guardrails.operationFailed")),
  });

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.guardrail(guardrailId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.guardrails }),
      queryClient.invalidateQueries({ queryKey: queryKeys.guardrailVersions(guardrailId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.metrics }),
      queryClient.invalidateQueries({ queryKey: queryKeys.testCases(guardrailId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.allValidationRuns }),
    ]);
  }

  function openValidationTarget(run: ValidationRun) {
    setSelectedValidationRun(null);
    if (guardrailVersions.some((version) => version.version === run.guardrail_version)) {
      setSelectedVersionOverride(run.guardrail_version);
      setCompareBaseVersionNumber(null);
      setSection("immutable");
      return;
    }
    setSection("draft");
  }

  if (guardrailQuery.isLoading) return <Skeleton className="mt-8 h-[34rem] rounded-xl" />;
  if (guardrailQuery.error || !guardrailQuery.data) return <div className="py-8"><ErrorNotice error={guardrailQuery.error ?? new Error(t("guardrails.notFound"))} /></div>;
  const guardrail = guardrailQuery.data;
  const policies = policiesQuery.data?.items ?? EMPTY_POLICIES;
  const routers = routersQuery.data?.items.filter((item) => item.activeSnapshot?.routes.some(route => route.enabled && route.targets.some(target => target.guardrailId === guardrail.id && target.weightBps > 0))) ?? [];
  const canManageDraft = auth.user?.role === "admin" && isGuardrailDraftManageable(guardrail);
  const hasUnpublishedDraft = canManageDraft && !guardrail.published_current;

  return (
    <section className="py-6 sm:py-8">
      <Link to="/guardrails" className="inline-flex min-h-11 items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" />{t("guardrails.back")}</Link>
      <div className="mt-3 flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-display text-2xl font-semibold tracking-[-0.015em] sm:text-3xl">{guardrail.name}</h1>
            {activeVersion ? <Badge className="border-emerald-200 bg-emerald-50 font-mono text-[11px] text-emerald-700 hover:bg-emerald-50">{t("guardrails.activeVersion", { version: activeVersion.version })}</Badge> : <StateBadge state={guardrail.tested_current ? "ready" : "needs_validation"} />}
            {routers.length ? <StateBadge state="protected" /> : activeVersion ? <StateBadge state="ready" /> : null}
            {guardrail.is_default ? <Badge variant="outline">{t("guardrails.defaultBadge")}</Badge> : guardrail.system_managed ? <Badge variant="outline">{t("guardrails.systemManaged")}</Badge> : null}
          </div>
          {guardrail.copy_origin && <p className="mt-2 text-sm text-muted-foreground">Copied from {guardrail.copy_origin.sourceName} · {guardrail.copy_origin.sourceVersion ?? `draft r${guardrail.copy_origin.sourceDraftRevision}`} · {guardrail.copy_origin.sourceGuardrailId}</p>}
          {hasUnpublishedDraft ? <button type="button" className="mt-3 inline-flex min-h-9 items-center gap-2 rounded-md bg-amber-50 px-3 text-xs font-medium text-amber-800 hover:bg-amber-100 focus-visible:outline-2 focus-visible:outline-ring" onClick={() => setSection("draft")}><Circle className="size-2.5 fill-current" />{t("guardrails.unpublishedDraft")}</button> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {canManageDraft ? <Button asChild className="min-h-11" variant="outline"><Link to="/playground" search={{ guardrail: guardrail.id, target: "draft", version: undefined }}><FlaskConical />{t("guardrails.testDraft")}</Link></Button> : null}
          {canManageDraft ? <Button className="min-h-11" variant="edit" onClick={() => setEditOpen(true)}><Pencil />{t("common.edit")}</Button> : null}
          {auth.user?.role === "admin" && !guardrail.is_default ? <Button className="min-h-11" variant="destructive" onClick={() => {
            deleteMutation.reset();
            queryClient.removeQueries({ queryKey: queryKeys.guardrailDeletionImpact(guardrailId), exact: true });
            setDeleteOpen(true);
          }}><Trash2 />{t("guardrails.deleteAction")}</Button> : null}
        </div>
      </div>

      {guardrail.is_default ? <div className="mt-5"><InfoNotice title={t("guardrails.defaultNoticeTitle")}>{t("guardrails.defaultNoticeDescription")}</InfoNotice></div> : null}

      <Tabs value={section} onValueChange={setSection} className="mt-7">
        <div className="overflow-x-auto">
          <TabsList className="min-w-max" aria-label={t("guardrails.detailViews")}>
            <TabsTrigger value="runtime">{t("guardrails.runtimeTab")}</TabsTrigger>
            <TabsTrigger value="findings"><span className="flex items-center gap-2">{t("guardrails.securityFindingsTab")}{findingsQuery.data?.summary.total ? <Badge variant="outline" className={findingsQuery.data.summary.critical ? "border-red-200 bg-red-50 font-mono text-[10px] text-red-700" : "font-mono text-[10px]"}>{findingsQuery.data.summary.total}</Badge> : null}</span></TabsTrigger>
            <TabsTrigger value="immutable">{t("guardrails.versions")}</TabsTrigger>
            <TabsTrigger value="validation"><span className="flex items-center gap-2">{t("guardrails.validationHistoryTab")}{validationRunsQuery.data?.items.length ? <Badge variant="outline" className="font-mono text-[10px]">{validationRunsQuery.data.items.length}</Badge> : null}</span></TabsTrigger>
            <TabsTrigger value="draft"><span className="flex items-center gap-2">{t("guardrails.draftReleaseTab")}{hasUnpublishedDraft ? <Circle className="size-2 fill-amber-500 text-amber-500" /> : null}</span></TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="runtime" className="pt-5">
          <GuardrailRuntimeView guardrailId={guardrail.id} metrics={metricsQuery.data} loading={metricsQuery.isLoading} error={metricsQuery.error} routers={routers} versions={guardrailVersions} window={window} onWindowChange={setWindow} />
        </TabsContent>
        <TabsContent value="findings" className="pt-5">
          <GuardrailFindingsView data={findingsQuery.data} loading={findingsQuery.isLoading} error={findingsQuery.error} policies={policies} routers={routers} endpoints={endpointsQuery.data?.items ?? []} window={window} onWindowChange={setWindow} severity={findingSeverity} onSeverityChange={setFindingSeverity} />
          <EventPagination page={findingsPaging.page} busy={findingsQuery.isFetching} nextCursor={findingsQuery.data?.nextCursor} onNext={findingsPaging.next} onPrevious={findingsPaging.previous} onLatest={findingsPaging.latest} />
        </TabsContent>
        <TabsContent value="immutable" className="pt-5">
          <ImmutableVersionView
            detail={immutableQuery.data}
            selectedVersion={selectedVersion}
            versions={guardrailVersions}
            loading={versionsQuery.isLoading || immutableQuery.isLoading || validationRunsQuery.isLoading}
            comparisonDetail={compareQuery.data}
            comparisonActive={Boolean(compareBaseVersionNumber)}
            comparisonLoading={compareQuery.isLoading}
            compareOptions={compareOptions}
            guardrailId={guardrail.id}
            validation={selectedValidation}
            onChanged={refresh}
            onOpenDraft={() => setSection("draft")}
            onOpenValidation={setSelectedValidationRun}
            onSelectVersion={(version) => { setSelectedVersionOverride(version); setCompareBaseVersionNumber(null); }}
            onStartCompare={() => { const previous = compareOptions[0]; if (previous) setCompareBaseVersionNumber(previous.version); }}
            onCompareBaseChange={setCompareBaseVersionNumber}
            onCloseCompare={() => setCompareBaseVersionNumber(null)}
          />
        </TabsContent>
        <TabsContent value="validation" className="pt-5">
          <GuardrailValidationHistory
            runs={validationRunsQuery.data?.items ?? []}
            loading={validationRunsQuery.isLoading}
            error={validationRunsQuery.error}
            canManage={canManageDraft}
            running={validationMutation.isPending}
            onRun={() => setValidationConfirmOpen(true)}
            onOpen={setSelectedValidationRun}
            onOpenTarget={openValidationTarget}
          />
        </TabsContent>
        <TabsContent value="draft" className="pt-5">
          <DraftReleaseView guardrail={guardrail} policies={policies} cases={testsQuery.data?.items ?? []} casesLoading={testsQuery.isLoading} activeVersion={activeVersion} versions={guardrailVersions} routers={routers} canManage={canManageDraft} validationRunning={validationMutation.isPending} onRunValidation={() => setValidationConfirmOpen(true)} onOpenValidation={setSelectedValidationRun} onEdit={() => setEditOpen(true)} onAddCase={() => setTestOpen(true)} onCreateRouter={() => setRouterOpen(true)} onChanged={refresh} />
        </TabsContent>
      </Tabs>

      <EditGuardrailSheet guardrail={guardrail} policies={policies} open={editOpen} onOpenChange={setEditOpen} onSaved={async () => { setEditOpen(false); await refresh(); }} />
      <AddTestCaseSheet guardrail={guardrail} open={testOpen} onOpenChange={setTestOpen} onCreated={async () => { setTestOpen(false); await refresh(); }} />
      <ValidationDetailSheet run={selectedValidationRun} guardrail={guardrail} canManage={canManageDraft} running={validationMutation.isPending} onRunAgain={() => validationMutation.mutate()} onOpenTarget={openValidationTarget} onClose={() => setSelectedValidationRun(null)} />
      <CreateRouterSheet open={routerOpen} onOpenChange={setRouterOpen} onCreated={async () => { setRouterOpen(false); await refresh(); }} />
      <ConfirmationSheet
        open={validationConfirmOpen}
        onOpenChange={setValidationConfirmOpen}
        eyebrow={t("guardrails.confirmActionEyebrow")}
        title={t("guardrails.confirmValidationTitle")}
        description={t("guardrails.confirmValidationDescription", { name: guardrail.name })}
        cancelLabel={t("common.cancel")}
        confirmLabel={t("guardrails.runReviewed")}
        pendingLabel={t("guardrails.runningValidation")}
        pending={validationMutation.isPending}
        onConfirm={() => validationMutation.mutate()}
      >
        <div className="rounded-lg border bg-muted/35 px-4 py-3 text-sm leading-6 text-muted-foreground">{t("guardrails.confirmValidationImpact")}</div>
        {validationMutation.error ? <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">{validationMutation.error instanceof Error ? validationMutation.error.message : t("guardrails.operationFailed")}</p> : null}
      </ConfirmationSheet>
      <DeleteGuardrailSheet
        guardrail={guardrail}
        open={deleteOpen}
        impact={deletionImpactQuery.data}
        loading={deletionImpactQuery.isFetching}
        deleting={deleteMutation.isPending}
        error={deleteMutation.error instanceof Error ? deleteMutation.error : deletionImpactQuery.error instanceof Error ? deletionImpactQuery.error : null}
        onOpenChange={(open) => { if (!deleteMutation.isPending) { setDeleteOpen(open); if (!open) deleteMutation.reset(); } }}
        onRetry={() => { deleteMutation.reset(); void deletionImpactQuery.refetch(); }}
        onConfirm={(confirmation) => deleteMutation.mutate(confirmation)}
      />
    </section>
  );
}

export function GuardrailRuntimeView({ guardrailId, metrics, loading, error, routers, versions = [], window, onWindowChange }: { guardrailId: string; metrics?: Metrics; loading: boolean; error: unknown; routers: Awaited<ReturnType<typeof getRouters>>["items"]; versions?: GuardrailVersion[]; window: MetricWindow; onWindowChange: (window: MetricWindow) => void }) {
  const { t, i18n } = useTranslation();
  if (loading) return <Skeleton className="h-[38rem] rounded-xl" />;
  if (error || !metrics) return <ErrorNotice error={error ?? new Error(t("guardrails.runtimeUnavailable"))} />;
  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div><h2 className="text-base font-semibold">{t("guardrails.runtimeTitle")}</h2><p className="mt-0.5 text-xs text-muted-foreground">{t("guardrails.runtimeDescription")}</p></div>
        <Select value={window} onValueChange={(value) => onWindowChange(value as MetricWindow)}><SelectTrigger className="h-9 w-full bg-card sm:w-40" aria-label={t("dashboard.timeRangeFilter")}><SelectValue /></SelectTrigger><SelectContent>{(["1h", "24h", "7d", "15d", "30d"] as MetricWindow[]).map((value) => <SelectItem key={value} value={value}>{t(`dashboard.windows.${value}`)}</SelectItem>)}</SelectContent></Select>
      </div>
      <InfoNotice title={t("guardrails.runtimeEvidencePrivacyTitle")}>{t("guardrails.runtimeEvidencePrivacyDescription")}</InfoNotice>
      {metrics.data_availability?.runtime_events === "truncated" || metrics.data_availability?.execution_evidence === "partial" || metrics.data_availability?.execution_evidence === "not_collected" ? <InfoNotice title={t("guardrails.runtimeEvidencePartialTitle")}>{t("guardrails.runtimeEvidencePartialDescription", { returned: metrics.data_availability.returned_events, total: metrics.data_availability.matching_events })}</InfoNotice> : null}
      <RuntimeHealthAlert metrics={metrics} />
      <dl className="grid overflow-hidden rounded-lg border border-border/65 bg-card sm:grid-cols-2 xl:grid-cols-4">
        <RuntimeStat label={t("dashboard.protectedTraffic")} value={metrics.total_decisions.toLocaleString(i18n.language)} detail={t("guardrails.callsInWindow")} />
        <RuntimeStat label={t("dashboard.interventionRate")} value={metrics.total_decisions ? `${metrics.intervention_rate}%` : "—"} detail={t("guardrails.blockedTransformed", { blocked: metrics.blocked, transformed: metrics.intervened })} />
        <RuntimeStat label={t("dashboard.p95Latency")} value={metrics.total_decisions ? `${metrics.runtime_p95_ms} ms` : "—"} detail={t("guardrails.runtimeLatencyDetail")} />
        <RuntimeStat label={t("dashboard.errorRate")} value={metrics.total_decisions ? `${metrics.error_rate}%` : "—"} detail={t("guardrails.errorsInWindow", { count: metrics.errors })} />
      </dl>
      <RuntimeMetricChart metrics={metrics} />
      <CallerDistribution metrics={metrics} routers={routers} versions={versions} />
    </div>
  );
}

type GuardrailFindingSeverityFilter = "all" | RouterTraceFinding["severity"];

export function GuardrailFindingsView({ data, loading, error, policies, routers, endpoints, window, onWindowChange, severity: controlledSeverity, onSeverityChange }: { data?: GuardrailFindingPage; loading: boolean; error: unknown; policies: Policy[]; routers: Awaited<ReturnType<typeof getRouters>>["items"]; endpoints: Endpoint[]; window: MetricWindow; onWindowChange: (window: MetricWindow) => void; severity?: GuardrailFindingSeverityFilter; onSeverityChange?: (severity: GuardrailFindingSeverityFilter) => void }) {
  const { t, i18n } = useTranslation();
  const [localSeverity, setLocalSeverity] = useState<GuardrailFindingSeverityFilter>('all');
  const severity = controlledSeverity ?? localSeverity;
  const setSeverity = onSeverityChange ?? setLocalSeverity;
  const findings = data?.items ?? [];
  const summary = data?.summary;
  const counts = useMemo(() => ({
    all: summary?.total ?? 0,
    critical: summary?.critical ?? 0,
    high: summary?.high ?? 0,
    medium: summary?.medium ?? 0,
    low: summary?.low ?? 0,
  }), [summary]);
  const visibleFindings = severity === "all" ? findings : findings.filter((finding) => finding.severity === severity);
  const filters: GuardrailFindingSeverityFilter[] = ["all", "critical", "high", "medium", "low"];

  return <div className="space-y-4">
    <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
      <div><h2 className="text-base font-semibold">{t("guardrails.securityFindingsTitle")}</h2><p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">{t("guardrails.securityFindingsDescription")}</p></div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button asChild variant="outline" className="min-h-11"><Link to="/logs"><ScrollText />{t("guardrails.openPromptHistory")}<ArrowUpRight /></Link></Button>
        <Select value={window} onValueChange={(value) => onWindowChange(value as MetricWindow)}><SelectTrigger className="min-h-11 w-full bg-card sm:w-40" aria-label={t("dashboard.timeRangeFilter")}><SelectValue /></SelectTrigger><SelectContent>{(["1h", "24h", "7d", "15d", "30d"] as MetricWindow[]).map((value) => <SelectItem key={value} value={value}>{t(`dashboard.windows.${value}`)}</SelectItem>)}</SelectContent></Select>
      </div>
    </div>

    <dl className="grid overflow-hidden rounded-lg border border-border/65 bg-card sm:grid-cols-3 xl:grid-cols-6">
      <FindingStat label={t("guardrails.totalFindings")} value={summary?.total ?? 0} />
      <FindingStat label={t("routerDetail.severity.critical")} value={summary?.critical ?? 0} danger={Boolean(summary?.critical)} />
      <FindingStat label={t("routerDetail.severity.high")} value={summary?.high ?? 0} />
      <FindingStat label={t("routerDetail.severity.medium")} value={summary?.medium ?? 0} />
      <FindingStat label={t("routerDetail.severity.low")} value={summary?.low ?? 0} />
      <FindingStat label={t("guardrails.affectedInteractions")} value={summary?.affected_traces ?? 0} />
    </dl>

    <Card className="shadow-none">
      <CardHeader className="border-b">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="flex items-start gap-3"><span className="grid size-9 shrink-0 place-items-center rounded-lg bg-red-50 text-red-700"><ShieldAlert className="size-4" /></span><div><CardTitle>{t("guardrails.findings")}</CardTitle><CardDescription className="mt-1 max-w-2xl leading-5">{t("guardrails.findingsPrivacy")}</CardDescription></div></div>
          <div className="grid w-full grid-cols-2 gap-1 rounded-lg border bg-background p-1 sm:grid-cols-5 xl:w-auto" role="group" aria-label={t("guardrails.filterSeverity")}>{filters.map((filter) => <Button key={filter} type="button" size="sm" variant={severity === filter ? "secondary" : "ghost"} className="min-h-10 w-full gap-1 px-2.5" aria-pressed={severity === filter} onClick={() => setSeverity(filter)}><span>{filter === "all" ? t("guardrails.allSeverities") : t(`routerDetail.severity.${filter}`)}</span><span className="font-mono text-[10px] text-muted-foreground">{counts[filter]}</span></Button>)}</div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? <Skeleton className="m-4 h-56 rounded-lg" /> : error ? <div className="p-4"><ErrorNotice error={error} /></div> : visibleFindings.length ? <div className="divide-y">{visibleFindings.map((finding) => {
          const timestamp = formatEventTimestamp(finding.created_at, i18n.language);
          const router = routers.find((item) => item.id === finding.router_id);
          const endpoint = endpoints.find((item) => item.id === finding.endpoint_id);
          const source = router?.name ?? endpoint?.name ?? (finding.protocol === "playground" ? t("guardrails.playgroundSource") : finding.protocol?.toUpperCase()) ?? t("guardrails.directRuntimeSource");
          return <article key={`${finding.trace_id}:${finding.id}`} className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-5">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2"><GuardrailSeverityBadge severity={finding.severity} /><strong className="text-sm">{guardrailFindingTitle(finding, policies)}</strong></div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">{finding.detail}</p>
              <p className="mt-2 break-all font-mono text-[11px] text-muted-foreground">{finding.policy_id ?? "—"}{finding.rule_id ? ` · ${finding.rule_id}` : ""}</p>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"><span>{t("guardrails.sourceLabel")}: <strong className="font-medium text-foreground">{source}</strong></span><span>{t("guardrails.versionLabel")}: <code>{finding.guardrail_version ?? "—"}</code></span><span>{t("guardrails.phaseLabel")}: <code>{finding.phase}</code></span><span>{t("guardrails.confidenceLabel")}: <code>{finding.confidence === null ? "—" : `${Math.round(finding.confidence * 100)}%`}</code></span></div>
            </div>
            <time className="self-start font-mono text-[11px] text-muted-foreground" dateTime={finding.created_at}><span className="sm:hidden">{timestamp.date} · </span>{timestamp.time}<span className="hidden sm:mt-1 sm:block sm:text-right">{timestamp.date}</span></time>
          </article>;
        })}</div> : <div className="flex min-h-56 flex-col items-center justify-center px-6 py-10 text-center"><span className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground"><ShieldCheck className="size-5" /></span><p className="mt-3 text-sm font-medium">{t(findings.length ? "guardrails.noMatchingFindings" : data?.collection_status === "not_collected" ? "guardrails.findingsNotCollected" : data?.collection_status === "no_events" ? "guardrails.noRuntimeEvidence" : "guardrails.noSecurityFindings")}</p><p className="mt-1 max-w-lg text-xs leading-5 text-muted-foreground">{t(findings.length ? "guardrails.noMatchingFindingsDescription" : data?.collection_status === "not_collected" ? "guardrails.findingsNotCollectedDescription" : data?.collection_status === "no_events" ? "guardrails.noRuntimeEvidenceDescription" : "guardrails.noSecurityFindingsDescription")}</p></div>}
        {!loading && !error && data && data.summary.total > data.count ? <div className="border-t bg-muted/20 px-4 py-3 text-xs text-muted-foreground">{t("guardrails.findingsTruncated", { shown: data.count, total: data.summary.total })}</div> : null}
      </CardContent>
    </Card>
  </div>;
}

function FindingStat({ label, value, danger = false }: { label: string; value: number; danger?: boolean }) { return <div className="border-b px-4 py-3 last:border-b-0 sm:border-r sm:[&:nth-child(3n)]:border-r-0 xl:border-b-0 xl:[&:nth-child(3n)]:border-r xl:last:border-r-0"><dt className="text-[11px] text-muted-foreground">{label}</dt><dd className={`mt-0.5 font-display text-xl font-semibold tabular-nums ${danger ? "text-red-700" : ""}`}>{value.toLocaleString()}</dd></div>; }
function GuardrailSeverityBadge({ severity }: { severity: RouterTraceFinding["severity"] }) { const { t } = useTranslation(); const classes = { critical: "border-red-200 bg-red-50 text-red-700", high: "border-orange-200 bg-orange-50 text-orange-700", medium: "border-amber-200 bg-amber-50 text-amber-700", low: "border-slate-200 bg-slate-50 text-slate-700" }[severity]; return <Badge variant="outline" className={classes}>{t(`routerDetail.severity.${severity}`)}</Badge>; }
function guardrailFindingTitle(finding: RouterTraceFinding, policies: Policy[]) { const policy = policies.find((item) => item.id === finding.policy_id); const rule = policy?.rules.find((item) => item.id === finding.rule_id); return rule?.name ?? policy?.name ?? finding.rule_id ?? finding.risk.replaceAll("_", " "); }

function GuardrailLoggingCard({ guardrailId }: { guardrailId: string }) {
  const { t, i18n } = useTranslation();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [pendingLevel, setPendingLevel] = useState<LoggingLevel | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const query = useQuery({ queryKey: queryKeys.guardrailLogging(guardrailId), queryFn: () => getGuardrailLoggingSettings(guardrailId) });
  const mutation = useMutation({
    mutationFn: ({ level, acknowledge }: { level: LoggingLevel; acknowledge: boolean }) => updateGuardrailLoggingSettings(guardrailId, level, acknowledge),
    onSuccess: async () => {
      setPendingLevel(null);
      setAcknowledged(false);
      toast.success(t("guardrails.loggingUpdated"));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.guardrailLogging(guardrailId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.auditEvents }),
      ]);
    },
    onError: (mutationError) => toast.error(mutationError instanceof Error ? mutationError.message : t("guardrails.loggingUpdateFailed")),
  });
  if (query.isLoading) return <Skeleton className="h-32 rounded-lg" />;
  if (query.error || !query.data) return <ErrorNotice error={query.error ?? new Error(t("guardrails.loggingUnavailable"))} />;
  const settings = query.data;
  const elevated = settings.level !== "info";
  const onLevelChange = (level: LoggingLevel) => {
    if (level === settings.level) return;
    setAcknowledged(level === "info");
    setPendingLevel(level);
  };
  return <>
    <Card size="sm" className={`gap-0 overflow-hidden py-0 shadow-none ${elevated ? "border-amber-200" : ""}`}>
      <div className={`flex flex-col gap-4 px-4 py-4 lg:flex-row lg:items-center lg:justify-between ${elevated ? "bg-amber-50/60" : ""}`}>
        <div className="flex min-w-0 items-start gap-3"><span className={`grid size-9 shrink-0 place-items-center rounded-lg ${elevated ? "bg-amber-100 text-amber-800" : "bg-primary/10 text-primary"}`}><ScrollText className="size-4" /></span><div><div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold">{t("guardrails.loggingTitle")}</h3><Badge variant="outline" className={elevated ? "border-amber-300 bg-amber-100 text-amber-900" : ""}>{settings.level.toUpperCase()}</Badge></div><p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">{t(`guardrails.loggingLevels.${settings.level}.description`)}</p><p className="mt-1 text-[11px] text-muted-foreground">{t("guardrails.loggingRetention", { days: settings.retention_days, time: new Date(settings.updated_at).toLocaleString(i18n.language) })}</p></div></div>
        <div className="w-full shrink-0 lg:w-48"><Label htmlFor={`logging-level-${guardrailId}`} className="sr-only">{t("guardrails.loggingLevel")}</Label><Select value={settings.level} disabled={auth.user?.role !== "admin" || mutation.isPending} onValueChange={(value) => onLevelChange(value as LoggingLevel)}><SelectTrigger id={`logging-level-${guardrailId}`} className="min-h-11 bg-card"><SelectValue /></SelectTrigger><SelectContent>{(["info", "debug", "trace"] as LoggingLevel[]).map((level) => <SelectItem key={level} value={level}><span className="flex items-center gap-2"><span className={`size-1.5 rounded-full ${level === "info" ? "bg-emerald-500" : "bg-amber-500"}`} />{level.toUpperCase()}</span></SelectItem>)}</SelectContent></Select>{auth.user?.role !== "admin" ? <p className="mt-1.5 text-[11px] text-muted-foreground">{t("guardrails.loggingAdminOnly")}</p> : null}</div>
      </div>
      {!settings.content_capture_enabled ? <div className="flex gap-2 border-t border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900"><CircleAlert className="mt-0.5 size-4 shrink-0" /><span>{t("guardrails.loggingEncryptionMissing")}</span></div> : elevated ? <div className="flex gap-2 border-t border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900"><CircleAlert className="mt-0.5 size-4 shrink-0" /><span>{t("guardrails.loggingElevatedActive")}</span></div> : null}
    </Card>

    <ConfirmationSheet
      open={Boolean(pendingLevel)}
      onOpenChange={(open) => { if (!open && !mutation.isPending) { setPendingLevel(null); setAcknowledged(false); } }}
      eyebrow={t("guardrails.loggingTitle")}
      title={t("guardrails.loggingConfirmTitle", { level: pendingLevel?.toUpperCase() })}
      description={t("guardrails.loggingConfirmDescription", { level: pendingLevel?.toUpperCase() })}
      cancelLabel={t("common.cancel")}
      confirmLabel={t("guardrails.enableLoggingLevel", { level: pendingLevel?.toUpperCase() })}
      pendingLabel={t("common.saving")}
      pending={mutation.isPending}
      confirmDisabled={!acknowledged || !pendingLevel}
      variant={pendingLevel === "info" ? "default" : "warning"}
      onConfirm={() => { if (pendingLevel) mutation.mutate({ level: pendingLevel, acknowledge: pendingLevel !== "info" }); }}
    >
        {pendingLevel === "info" ? <div className="rounded-lg border bg-muted/35 p-4 text-xs leading-5 text-muted-foreground">{t("guardrails.loggingLevels.info.description")}</div> : <>
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-xs leading-5 text-amber-950"><ul className="list-disc space-y-1 pl-4"><li>{t("guardrails.loggingCostWrite")}</li><li>{t("guardrails.loggingCostSensitive")}</li>{pendingLevel === "trace" ? <li>{t("guardrails.loggingCostApproved")}</li> : null}</ul></div>
          <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3"><Checkbox checked={acknowledged} onCheckedChange={(value) => setAcknowledged(Boolean(value))} /><span className="text-xs leading-5">{t("guardrails.loggingAcknowledge")}</span></label>
        </>}
    </ConfirmationSheet>
  </>;
}

function RuntimeStat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="min-h-20 border-b px-4 py-3 last:border-b-0 sm:odd:border-r sm:[&:nth-child(3)]:border-b-0 xl:border-b-0 xl:border-r xl:odd:border-r xl:last:border-r-0"><dt className="text-xs font-medium text-muted-foreground">{label}</dt><dd className="mt-1 text-xl font-semibold tabular-nums">{value}</dd><p className="mt-1 text-xs text-muted-foreground">{detail}</p></div>;
}

function CallerDistribution({ metrics, routers, versions }: { metrics: Metrics; routers: Awaited<ReturnType<typeof getRouters>>["items"]; versions: GuardrailVersion[] }) {
  const { t, i18n } = useTranslation();
  return <Card size="sm" className="gap-0 overflow-hidden py-0 shadow-none"><CardHeader className="border-b px-4 py-3"><CardTitle className="text-sm">{t("guardrails.callersTitle")}</CardTitle><CardDescription className="text-xs leading-5">{t("guardrails.callersDescription")}</CardDescription></CardHeader>{metrics.caller_distribution.length ? <Table className="text-xs"><TableHeader><TableRow className="hover:bg-transparent"><TableHead className="h-9 pl-4">{t("guardrails.caller")}</TableHead><TableHead className="h-9">{t("guardrails.trafficScope")}</TableHead><TableHead className="h-9">{t("guardrails.volumeShare")}</TableHead><TableHead className="h-9">{t("guardrails.servedVersion")}</TableHead><TableHead className="h-9">{t("guardrails.outcome")}</TableHead><TableHead className="h-9">{t("dashboard.p95Latency")}</TableHead></TableRow></TableHeader><TableBody>{metrics.caller_distribution.map((item) => { const router = routers.find((candidate) => candidate.id === item.router_id); return <TableRow key={`${item.endpoint_id}:${item.router_id}:${item.protocol}`}><TableCell className="py-2.5 pl-4 align-top"><strong className="text-sm font-medium">{item.endpoint_name}</strong><p className="mt-0.5 font-mono text-xs text-muted-foreground">{item.protocol}</p></TableCell><TableCell className="max-w-80 py-2.5 align-top"><p className="mb-1 text-xs font-medium">{item.router_name}</p>{router ? <TrafficScopeBadges router={router} /> : <span className="text-xs text-muted-foreground">{t("guardrails.unassignedTraffic")}</span>}</TableCell><TableCell className="py-2.5 align-top"><strong className="text-sm tabular-nums">{item.requests.toLocaleString(i18n.language)}</strong><div className="mt-1.5 flex items-center gap-2"><Progress className="h-1 w-16" value={item.share} /><span className="text-xs text-muted-foreground">{item.share}%</span></div></TableCell><TableCell className="py-2.5 align-top"><div className="flex flex-wrap gap-1">{item.guardrail_versions.map((version) => <Badge key={version} variant="outline" className="font-mono text-[10px]">{version}</Badge>)}</div></TableCell><TableCell className="py-2.5 align-top"><p className="text-xs">{t("guardrails.interventionSummary", { rate: item.intervention_rate })}</p><p className="mt-0.5 text-xs text-muted-foreground">{t("guardrails.errorSummary", { rate: item.error_rate })}</p></TableCell><TableCell className="py-2.5 align-top font-mono text-xs">{item.p95_latency_ms} ms</TableCell></TableRow>; })}</TableBody></Table> : <div className="px-4 pb-4"><EmptyState title={t("guardrails.noRuntimeCalls")} description={t("guardrails.noRuntimeCallsDescription")} /></div>}</Card>;
}

export function ImmutableVersionView({ detail, selectedVersion, versions, loading, comparisonDetail, comparisonActive, comparisonLoading, compareOptions, guardrailId, validation, onChanged, onOpenDraft, onOpenValidation, onSelectVersion, onStartCompare, onCompareBaseChange, onCloseCompare }: {
  detail?: GuardrailVersionDetail;
  selectedVersion?: GuardrailVersion;
  versions: GuardrailVersion[];
  loading: boolean;
  comparisonDetail?: GuardrailVersionDetail;
  comparisonActive: boolean;
  comparisonLoading: boolean;
  compareOptions: GuardrailVersion[];
  guardrailId: string;
  validation: Guardrail["latest_validation_run"];
  onChanged: () => Promise<void>;
  onOpenDraft: () => void;
  onOpenValidation: (run: ValidationRun) => void;
  onSelectVersion: (version: string) => void;
  onStartCompare: () => void;
  onCompareBaseChange: (version: string) => void;
  onCloseCompare: () => void;
}) {
  const { t, i18n } = useTranslation();
  const auth = useAuth();
  const [deleteVersion, setDeleteVersion] = useState<string | null>(null);
  const removeVersion = useMutation({ mutationFn: (version: string) => deleteControllerGuardrailVersion(guardrailId, version), onSuccess: async () => { setDeleteVersion(null); await onChanged(); onOpenDraft(); } });
  const [rollbackVersion, setRollbackVersion] = useState<string | null>(null);
  const rollback = useMutation({ mutationFn: (version: string) => rollbackGuardrail(guardrailId, version), onSuccess: async () => { setRollbackVersion(null); toast.success(t("guardrails.rollbackSucceeded")); await onChanged(); }, onError: (error) => notifyError(error, t("guardrails.operationFailed")) });
  if (loading) return <Skeleton className="h-[34rem] rounded-xl" />;
  if (!selectedVersion || !detail) return <EmptyState title={t("guardrails.noActiveVersion")} description={t("guardrails.noActiveVersionDescription")} action={<Button onClick={onOpenDraft}>{t("guardrails.openDraftRelease")}</Button>} />;
  const releaseId = detail.version;
  if (selectedVersion.compile_status && selectedVersion.compile_status !== "ready") {
    const failed = selectedVersion.compile_status === "failed";
    return <Card className={failed ? "border-destructive/30 shadow-none" : "shadow-none"}>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2"><CardTitle className="font-mono">{releaseId}</CardTitle><StateBadge state={failed ? "failed" : "running"} /></div>
        <CardDescription>{failed ? t("guardrails.versionCompilationFailed") : t("guardrails.versionCompilationPending")}</CardDescription>
      </CardHeader>
      <CardContent>{failed ? <ErrorNotice error={new Error(selectedVersion.failure_reason ?? t("guardrails.compilationFailedDetail"))} /> : <div className="flex items-center gap-2 rounded-lg border bg-muted/20 p-4 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />{t("guardrails.compilationPendingDetail")}</div>}</CardContent>
    </Card>;
  }
  return <><div className="grid min-w-0 gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
    <GuardrailVersionNavigator versions={versions} selectedVersion={selectedVersion.version} onSelect={onSelectVersion} />
    <div className="min-w-0 space-y-4">
      {comparisonActive ? comparisonLoading || !comparisonDetail ? <Skeleton className="h-[34rem] rounded-xl" /> : <GuardrailVersionComparison base={comparisonDetail} target={detail} baseOptions={compareOptions} onBaseChange={onCompareBaseChange} onClose={onCloseCompare} /> : <>
        <Card className="shadow-none">
          <CardHeader className="border-b">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <LockKeyhole className="size-4 text-primary" />
                  <CardTitle className="font-mono">{releaseId}</CardTitle>
                  {selectedVersion.active ? <StateBadge state="active" /> : <Badge variant="outline">{t("guardrails.historicalVersion")}</Badge>}
                </div>
                <CardDescription className="mt-2">{t("guardrails.immutableDescription")}</CardDescription>
              </div>
              <div className="flex flex-wrap gap-2">
                {compareOptions.length ? <Button variant="outline" className="min-h-11" onClick={onStartCompare}><GitCompareArrows />{t("guardrails.compareWithPrevious")}</Button> : null}
                {auth.user?.role === "admin" ? <VersionMenu><VersionMenuTrigger asChild><Button variant="ghost" className="size-11" aria-label="Version actions"><VersionActionsIcon /></Button></VersionMenuTrigger><VersionMenuContent align="end">
                  <VersionMenuItem variant="edit" disabled={selectedVersion.active || rollback.isPending || removeVersion.isPending} onSelect={() => setRollbackVersion(selectedVersion.version)}><History />{t("guardrails.rollback")}</VersionMenuItem>
                  <VersionMenuItem variant="destructive" disabled={selectedVersion.active || rollback.isPending || removeVersion.isPending} onSelect={() => { removeVersion.reset(); setDeleteVersion(selectedVersion.version); }}><Trash2 />Delete</VersionMenuItem>
                </VersionMenuContent></VersionMenu> : null}
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6 pt-6">
          <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><VersionFact label={t("guardrails.runtimeEngine")} value={`${detail.runtime_engine} · ${detail.runtime_profile}`} /><VersionFact label={t("guardrails.compiledWith")} value={detail.compiler_version} mono /><VersionFact label={t("guardrails.createdAt")} value={new Date(detail.created_at).toLocaleString(i18n.language)} /><div className="min-w-0"><dt className="text-xs text-muted-foreground">{t("guardrails.configIdentity")}</dt><dd className="mt-0.5"><CopyableChecksum value={detail.config_checksum} /></dd></div></dl>
          <div className="grid gap-4 xl:grid-cols-2"><ImmutablePosture detail={detail} /><PinnedPolicies bindings={detail.policy_bindings} /></div>
        </CardContent></Card>
        <CompiledRuntime detail={detail} />
        <Card className="shadow-none"><CardHeader><CardTitle>{t("guardrails.validationEvidence")}</CardTitle><CardDescription>{t("guardrails.validationEvidenceDescription")}</CardDescription></CardHeader><CardContent>{validation ? <div className="flex flex-col gap-3 rounded-lg border bg-muted/20 p-4 sm:flex-row sm:items-center sm:justify-between"><div><div className="flex items-center gap-2"><StateBadge state={validation.status} /><span className="text-sm font-medium">{t("guardrails.compliance", { rate: validation.metrics.compliance_rate })}</span></div><p className="mt-2 text-xs text-muted-foreground">{new Date(validation.created_at).toLocaleString(i18n.language)}</p></div><Button variant="outline" onClick={() => onOpenValidation(validation)}><FlaskConical />{t("guardrails.openValidation")}</Button></div> : <InfoNotice title={t("guardrails.noValidationEvidence")}>{t("guardrails.noEvidence")}</InfoNotice>}</CardContent></Card>
      </>}
    </div>
  </div><ConfirmationSheet
    open={rollbackVersion !== null}
    onOpenChange={(open) => { if (!open && !rollback.isPending) { setRollbackVersion(null); rollback.reset(); } }}
    eyebrow={t("guardrails.confirmActionEyebrow")}
    title={t("guardrails.confirmRollbackTitle", { version: rollbackVersion ?? "" })}
    description={t("guardrails.confirmRollbackDescription")}
    cancelLabel={t("common.cancel")}
    confirmLabel={t("guardrails.rollback")}
    pendingLabel={t("common.saving")}
    pending={rollback.isPending}
    variant="warning"
    onConfirm={() => { if (rollbackVersion !== null) rollback.mutate(rollbackVersion); }}
  >
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950">{t("guardrails.confirmRollbackImpact")}</div>
    {rollback.error ? <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">{rollback.error instanceof Error ? rollback.error.message : t("guardrails.operationFailed")}</p> : null}
  </ConfirmationSheet>
  <ConfirmationSheet open={deleteVersion !== null} onOpenChange={open => { if (!open) setDeleteVersion(null); }} eyebrow="Guardrail version" title={`Delete version ${deleteVersion ?? ""}?`} description="This permanently removes the historical version. Active, compiling, or referenced versions cannot be deleted. Audit evidence and artifacts are retained." cancelLabel={t("common.cancel")} confirmLabel="Delete version" variant="destructive" pending={removeVersion.isPending} onConfirm={() => { if (deleteVersion) removeVersion.mutate(deleteVersion); }}>
    {removeVersion.error && <p role="alert" className="text-sm text-destructive">{removeVersion.error.message}</p>}
  </ConfirmationSheet></>;
}

function VersionFact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) { return <div className="min-w-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className={`${mono ? "font-mono text-xs" : "text-sm font-medium"} mt-1.5 truncate`} title={value}>{value}</dd></div>; }

function ImmutablePosture({ detail }: { detail: GuardrailVersionDetail }) {
  const { t } = useTranslation();
  const effective = detail.effective_output_delivery ?? detail.output_delivery;
  return <section className="rounded-lg border p-4"><h3 className="text-sm font-semibold">{t("guardrails.decisionPosture")}</h3>
    <dl className="mt-4 grid gap-4 sm:grid-cols-2">
      <VersionFact label={t("guardrailWizard.safetyLevel")} value={t(`guardrailWizard.safetyLevelOptions.${detail.safety_level}`)} />
      <VersionFact label={t("guardrailWizard.outputDelivery")} value={t(`guardrailWizard.outputDeliveryOptions.${effective}`)} />
      <VersionFact label={t("modelSettings.inputRail")} value={t("guardrails.compiledFlowCount", { count: detail.rails.filter((rail) => rail.rail_type === "input").length })} />
      <VersionFact label={t("modelSettings.outputRail")} value={t("guardrails.compiledFlowCount", { count: detail.rails.filter((rail) => rail.rail_type === "output").length })} />
      <VersionFact label={t("guardrails.colangVersion")} value={detail.colang_version} /><VersionFact label={t("guardrails.criticalPath")} value={`${detail.estimated_critical_path_ms} ms`} />
    </dl><p className="mt-4 border-t pt-3 text-xs leading-5 text-muted-foreground">{t(effective === "full_buffered" ? "modelSettings.streamFull" : "modelSettings.streamWindow")}</p>
    {effective !== detail.output_delivery ? <p className="mt-2 text-xs text-muted-foreground">{t("guardrails.deliverySafetyFallback")}</p> : null}
  </section>;
}

function PinnedPolicies({ bindings }: { bindings: GuardrailVersionDetail["policy_bindings"] }) { const { t } = useTranslation(); return <section className="rounded-lg border p-4"><h3 className="text-sm font-semibold">{t("guardrails.pinnedPolicies")}</h3><div className="mt-3 divide-y">{bindings.map((binding) => <div key={`${binding.policy_id}@${binding.policy_version}`} className="py-3 first:pt-0 last:pb-0"><div className="flex flex-wrap items-center justify-between gap-2"><code className="text-xs">{binding.policy_id}@{binding.policy_version}</code><Badge variant="outline">{binding.action ?? t("guardrails.policyBehavior")}</Badge></div><p className="mt-2 text-xs text-muted-foreground">{t("guardrails.pinnedPolicyRules", { count: binding.enabled_rule_ids.length })}</p></div>)}</div></section>; }

export function DraftReleaseView({ guardrail, policies, cases, casesLoading, activeVersion, versions, routers, canManage, validationRunning = false, onRunValidation = () => undefined, onOpenValidation = () => undefined, onEdit, onAddCase, onCreateRouter, onChanged }: { guardrail: Guardrail; policies: Policy[]; cases: TestCase[]; casesLoading: boolean; activeVersion?: GuardrailVersion; versions?: GuardrailVersion[]; routers: Awaited<ReturnType<typeof getRouters>>["items"]; canManage?: boolean; validationRunning?: boolean; onRunValidation?: () => void; onOpenValidation?: (run: ValidationRun) => void; onEdit: () => void; onAddCase: () => void; onCreateRouter: () => void; onChanged: () => Promise<void> }) {
  const { t } = useTranslation();
  const [publishOpen, setPublishOpen] = useState(false);
  const [scopeChange, setScopeChange] = useState<{ caseId: string; action: "exclude" | "restore" } | null>(null);
  const releaseId = activeVersion?.version ?? "";
  const draftConfigured = Boolean(guardrail.policy_bindings.length);
  const validated = guardrail.tested_current;
  const published = guardrail.published_current;
  const currentRelease = versions?.find((item) => item.source_draft_version === guardrail.draft_revision);
  const compiling = currentRelease?.compile_status === "compiling";
  const compileFailed = currentRelease?.compile_status === "failed";
  const publish = useMutation({
    mutationFn: () => {
      if (guardrail.draft_revision === undefined) throw new Error("Reload the Guardrail draft before publishing.");
      return publishGuardrail(guardrail.id, guardrail.draft_revision);
    },
    onSuccess: async (version) => {
      setPublishOpen(false);
      toast.success(t("guardrails.publishSucceeded", { version: version.version }));
      await onChanged();
    },
    onError: (error) => notifyError(error, t("guardrails.publishFailed")),
  });
  const validationScope = useMutation({
    mutationFn: ({ caseId, action }: { caseId: string; action: "exclude" | "restore" }) => action === "exclude" ? excludeGuardrailTestCase(guardrail.id, caseId) : restoreGuardrailTestCase(guardrail.id, caseId),
    onSuccess: async (_, variables) => {
      setScopeChange(null);
      toast.success(t(variables.action === "exclude" ? "guardrails.testCaseExcluded" : "guardrails.testCaseRestored"));
      await onChanged();
    },
    onError: (error) => notifyError(error, t("guardrails.operationFailed")),
  });
  const steps = [
    { label: t("guardrails.releaseStepDraft"), complete: draftConfigured, current: !draftConfigured, detail: t("guardrails.policyCheckDetail", { count: guardrail.policy_bindings.length }) },
    { label: validated ? t("guardrails.flowValidationPassed") : t("guardrails.flowValidationRequired"), complete: validated, current: draftConfigured && !validated, detail: validated && guardrail.latest_validation_run ? t("guardrails.validationEvidenceDetail", { rate: guardrail.latest_validation_run.metrics.compliance_rate }) : guardrail.latest_validation_run?.status === "failed" ? (guardrail.latest_validation_run.failure_reason || t("guardrails.lastValidationFailedDetail", { rate: guardrail.latest_validation_run.metrics.compliance_rate })) : guardrail.latest_validation_run ? t("guardrails.validationEvidenceStale") : t("guardrails.noValidationEvidence") },
    { label: published ? t("guardrails.releaseStepPublished") : compiling ? t("guardrails.releaseStepCompiling") : compileFailed ? t("guardrails.releaseStepCompileFailed") : t("guardrails.releaseStepPublish"), complete: published, current: validated && !published, detail: published && releaseId ? t("guardrails.publishedVersionDetail", { version: releaseId }) : compiling ? t("guardrails.compilationPendingDetail") : compileFailed ? (currentRelease?.failure_reason ?? t("guardrails.compilationFailedDetail")) : t("guardrails.publishStepDetail") },
  ];
  const stateTitle = published ? t("guardrails.releasePublished") : compiling ? t("guardrails.releaseCompiling") : compileFailed ? t("guardrails.releaseCompileFailed") : validated ? t("guardrails.releaseReadyToPublish") : t("guardrails.releaseNeedsValidation");
  const stateDescription = published ? t("guardrails.releasePublishedDescription") : compiling ? t("guardrails.releaseCompilingDescription") : compileFailed ? t("guardrails.releaseCompileFailedDescription") : validated ? t("guardrails.releaseReadyToPublishDescription") : t("guardrails.releaseNeedsValidationDescription");
  const canManageDraft = canManage ?? isGuardrailDraftManageable(guardrail);

  return <><div className="space-y-5">
    <Card className="overflow-hidden shadow-none">
      <CardHeader className="border-b bg-muted/15 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><CardTitle>{t("guardrails.releaseWorkflow")}</CardTitle><CardDescription>{t("guardrails.releaseWorkflowDescription")}</CardDescription></div>
          <Badge variant="outline" className={published ? "border-emerald-200 bg-emerald-50 text-emerald-700" : validated ? "border-amber-200 bg-amber-50 text-amber-800" : ""}>{stateTitle}</Badge>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="grid lg:grid-cols-[minmax(0,1fr)_20rem]">
          <ol className="divide-y">
            {steps.map((step, index) => <li key={step.label} className={`grid grid-cols-[2rem_minmax(0,1fr)] gap-3 px-5 py-3.5 ${step.current ? "bg-primary/[0.025]" : ""}`}>
              <span className={`mt-0.5 grid size-7 place-items-center rounded-full border text-xs font-semibold ${step.complete ? "border-emerald-200 bg-emerald-50 text-emerald-700" : step.current ? "border-primary bg-primary text-primary-foreground" : "bg-background text-muted-foreground"}`}>{step.complete ? <Check className="size-3.5" /> : index + 1}</span>
              <span className="min-w-0"><span className="block text-sm font-medium">{step.label}</span><span className="mt-0.5 block break-words text-xs leading-5 text-muted-foreground">{step.detail}</span></span>
            </li>)}
          </ol>
          <aside className="border-t bg-muted/20 p-5 lg:border-t-0 lg:border-l">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("guardrails.currentReleaseState")}</p>
            <h3 className="mt-2 text-base font-semibold">{stateTitle}</h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{stateDescription}</p>
            <div className="mt-4 grid gap-2">
              {canManageDraft && !validated ? <Button className="min-h-11" disabled={validationRunning} onClick={onRunValidation}>{validationRunning ? <LoaderCircle className="animate-spin" /> : <FlaskConical />}{t(validationRunning ? "guardrails.runningValidation" : "guardrails.runReviewed")}</Button> : null}
              {canManageDraft && validated && !published && !compiling ? <Button className="min-h-11" disabled={publish.isPending} onClick={() => setPublishOpen(true)}>{publish.isPending ? <LoaderCircle className="animate-spin" /> : compileFailed ? <RotateCcw /> : <ShieldCheck />}{t(publish.isPending ? "guardrails.requestingCompilation" : compileFailed ? "guardrails.retryCompilation" : "guardrails.publishVersion")}</Button> : null}
              {canManageDraft && published && !guardrail.is_default ? <Button variant="create" className="min-h-11" onClick={onCreateRouter}><Rocket />{t("guardrails.createRouter")}</Button> : null}
              {canManageDraft ? <Button className="min-h-11" variant="edit" onClick={onEdit}><Pencil />{t("common.edit")}</Button> : null}
              {guardrail.latest_validation_run ? <Button className="min-h-11" variant="outline" onClick={() => onOpenValidation(guardrail.latest_validation_run!)}><FlaskConical />{t("guardrails.openValidation")}</Button> : null}
            </div>
          </aside>
        </div>
      </CardContent>
    </Card>

    <section>
      <div className="mb-3"><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("guardrails.releaseInputEyebrow")}</p><h2 className="mt-1 text-base font-semibold">{t("guardrails.draftConfiguration")}</h2><p className="mt-1 text-xs text-muted-foreground">{t("guardrails.draftConfigurationDescription")}</p></div>
      <PolicyBindings bindings={guardrail.policy_bindings} policies={policies} />
      <div className="mt-4"><ProtectionDependencies bindings={guardrail.policy_bindings} policies={policies} /></div>
    </section>
    <section>
      <div className="mb-3"><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("guardrails.releaseEvidenceEyebrow")}</p><h2 className="mt-1 text-base font-semibold">{t("guardrails.validationInputs")}</h2><p className="mt-1 text-xs text-muted-foreground">{t("guardrails.validationInputsDescription")}</p></div>
      <TestCases cases={cases} bindings={guardrail.policy_bindings} policies={policies} loading={casesLoading} onAdd={onAddCase} onExclude={(caseId) => setScopeChange({ caseId, action: "exclude" })} onRestore={(caseId) => setScopeChange({ caseId, action: "restore" })} busyCaseId={validationScope.isPending ? validationScope.variables?.caseId : undefined} />
    </section>
    {routers.length ? <Card className="shadow-none"><CardHeader className="py-4"><CardTitle>{t("guardrails.guardrailRouters")}</CardTitle><CardDescription>{t("guardrails.guardrailRoutersDescription")}</CardDescription></CardHeader><CardContent className="space-y-2">{routers.map((router) => <div key={router.id} className="rounded-lg border px-4 py-3"><div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-sm font-medium">{router.name}</strong><Badge variant="outline" className="font-mono text-[10px]">{router.activeRevision ? `r${router.activeRevision}` : "—"}</Badge></div><div className="mt-2"><TrafficScopeBadges router={router} /></div></div>)}</CardContent></Card> : null}
  </div>
  <ConfirmationSheet
    open={publishOpen}
    onOpenChange={(open) => { if (!publish.isPending) { setPublishOpen(open); if (!open) publish.reset(); } }}
    eyebrow={t("guardrails.confirmActionEyebrow")}
    title={t("guardrails.confirmPublishTitle")}
    description={t("guardrails.confirmPublishDescription", { name: guardrail.name })}
    cancelLabel={t("common.cancel")}
    confirmLabel={t(compileFailed ? "guardrails.retryCompilation" : "guardrails.publishVersion")}
    pendingLabel={t("guardrails.requestingCompilation")}
    pending={publish.isPending}
    onConfirm={() => publish.mutate()}
  >
    <div className="rounded-lg border bg-muted/35 px-4 py-3 text-sm leading-6 text-muted-foreground">{t("guardrails.confirmPublishImpact")}</div>
    {publish.error ? <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">{publish.error instanceof Error ? publish.error.message : t("guardrails.publishFailed")}</p> : null}
  </ConfirmationSheet>
  <ConfirmationSheet
    open={Boolean(scopeChange)}
    onOpenChange={(open) => { if (!open && !validationScope.isPending) { setScopeChange(null); validationScope.reset(); } }}
    eyebrow={t("guardrails.confirmActionEyebrow")}
    title={t(scopeChange?.action === "restore" ? "guardrails.confirmRestoreCaseTitle" : "guardrails.confirmExcludeCaseTitle")}
    description={t("guardrails.confirmScopeChangeDescription")}
    cancelLabel={t("common.cancel")}
    confirmLabel={t(scopeChange?.action === "restore" ? "guardrails.restoreTestCase" : "guardrails.excludeTestCase")}
    pendingLabel={t("common.saving")}
    pending={validationScope.isPending}
    variant={scopeChange?.action === "exclude" ? "warning" : "default"}
    onConfirm={() => { if (scopeChange) validationScope.mutate(scopeChange); }}
  >
    <div className="rounded-lg border bg-muted/35 px-4 py-3 text-sm leading-6 text-muted-foreground">{t("guardrails.confirmScopeChangeImpact")}</div>
    {validationScope.error ? <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">{validationScope.error instanceof Error ? validationScope.error.message : t("guardrails.operationFailed")}</p> : null}
  </ConfirmationSheet></>;
}

function PolicyBindings({ bindings, policies }: { bindings: GuardrailPolicyBinding[]; policies: Policy[] }) {
  const { t } = useTranslation();
  return bindings.length ? <div className="grid gap-3 lg:grid-cols-2">{bindings.map((binding) => {
    const policy = boundPolicy(policies, binding);
    const name = policy?.name ?? binding.policy_id;
    const enabledRuleCount = binding.enabled_rule_ids.length || policy?.rules.length || 0;
    return <Link
      key={`${binding.policy_id}@${binding.policy_version}`}
      to="/policy-library"
      search={{ policy: binding.policy_id, version: binding.policy_version }}
      aria-label={t("guardrails.inspectPolicyAria", { name })}
      className="group rounded-lg border bg-card p-4 shadow-xs outline-none transition-colors hover:border-primary/35 hover:bg-primary/[0.025] focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
    >
      <div className="flex items-start justify-between gap-3">
        <span className="min-w-0"><strong className="block truncate text-sm">{name}</strong><span className="mt-1 block font-mono text-xs text-muted-foreground">{binding.policy_id}@{binding.policy_version}</span></span>
        <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-primary">{t("guardrails.inspectPolicy")}<ArrowUpRight className="size-3.5" /></span>
      </div>
      <p className="mt-3 line-clamp-2 text-xs leading-5 text-muted-foreground">{policy?.description}</p>
      <div className="mt-4 flex flex-wrap items-center gap-2"><Badge variant="secondary">{t("guardrails.ruleCount", { count: enabledRuleCount })}</Badge>{binding.enabled_rails.map((rail) => <Badge key={rail} variant="outline" className="font-mono uppercase">{rail}</Badge>)}<span className="ml-auto text-xs text-muted-foreground">{binding.action ?? t("guardrails.policyBehavior")}</span></div>
    </Link>;
  })}</div> : <EmptyState title={t("guardrails.noPolicies")} description={t("guardrails.noPoliciesDescription")} />;
}

type TestCaseSourceGroup = {
  id: string;
  kind: "policy" | "guardrail";
  label: string;
  sourceId: string | null;
  version: string | null;
  cases: TestCase[];
  coveredRules: number;
};

function groupTestCasesBySource(cases: TestCase[], bindings: GuardrailPolicyBinding[], policies: Policy[]): TestCaseSourceGroup[] {
  const boundPolicyIds = new Set(bindings.map((binding) => binding.policy_id));
  const policyGroups = bindings.map((binding) => {
    const items = cases.filter((item) => item.origin !== "custom" && item.source_policy_id === binding.policy_id);
    const policy = boundPolicy(policies, binding);
    return {
      id: `policy:${binding.policy_id}`,
      kind: "policy" as const,
      label: policy?.name ?? binding.policy_id,
      sourceId: binding.policy_id,
      version: binding.policy_version,
      cases: items,
      coveredRules: new Set(items.flatMap((item) => item.covered_rule_ids)).size,
    };
  });
  const unboundSourceIds = Array.from(new Set(cases.flatMap((item) => item.origin !== "custom" && item.source_policy_id && !boundPolicyIds.has(item.source_policy_id) ? [item.source_policy_id] : [])));
  const unboundGroups = unboundSourceIds.map((sourceId) => {
    const items = cases.filter((item) => item.origin !== "custom" && item.source_policy_id === sourceId);
    const policy = policies.find((item) => item.id === sourceId);
    return {
      id: `policy:${sourceId}`,
      kind: "policy" as const,
      label: policy?.name ?? sourceId,
      sourceId,
      version: items[0]?.source_policy_version ?? null,
      cases: items,
      coveredRules: new Set(items.flatMap((item) => item.covered_rule_ids)).size,
    };
  });
  const guardrailCases = cases.filter((item) => item.origin === "custom" || !item.source_policy_id);
  return [...policyGroups, ...unboundGroups, {
    id: "guardrail:custom",
    kind: "guardrail",
    label: "",
    sourceId: null,
    version: null,
    cases: guardrailCases,
    coveredRules: new Set(guardrailCases.flatMap((item) => item.covered_rule_ids)).size,
  }];
}

export function TestCases({ cases, bindings, policies, loading, onAdd, onExclude, onRestore, busyCaseId }: { cases: TestCase[]; bindings: GuardrailPolicyBinding[]; policies: Policy[]; loading: boolean; onAdd: () => void; onExclude?: (caseId: string) => void; onRestore?: (caseId: string) => void; busyCaseId?: string }) {
  const { t } = useTranslation();
  if (loading) return <Skeleton className="h-64 rounded-xl" />;
  const groups = groupTestCasesBySource(cases, bindings, policies);
  const inheritedCount = groups.filter((group) => group.kind === "policy").reduce((total, group) => total + group.cases.filter((item) => !item.excluded).length, 0);
  const excludedCount = cases.filter((item) => item.excluded).length;
  const customCount = groups.find((group) => group.kind === "guardrail")?.cases.length ?? 0;
  return <section className="overflow-hidden rounded-lg border bg-card">
    <header className="flex flex-col gap-3 border-b bg-muted/20 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div><div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold">{t("guardrails.testCaseSources")}</h3>{excludedCount ? <Badge variant="secondary">{t("guardrails.excludedTestCount", { count: excludedCount })}</Badge> : null}</div><p className="mt-1 text-xs leading-5 text-muted-foreground">{t("guardrails.testCaseSourceSummary", { inherited: inheritedCount, policies: groups.filter((group) => group.kind === "policy").length, custom: customCount })}</p></div>
    </header>
    <div className="divide-y">{groups.map((group) => {
      const label = group.kind === "policy" ? group.label : t("guardrails.guardrailCustomTests");
      const identity = group.kind === "policy" ? `${group.sourceId}@${group.version}` : t("guardrails.guardrailCustomTestsIdentity");
      return <details key={group.id} data-testid={`test-source-${group.id}`} className="group">
        <summary className="flex min-h-16 cursor-pointer list-none items-center gap-3 px-4 py-3 outline-none hover:bg-muted/25 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <span className="grid size-8 shrink-0 place-items-center rounded-md border bg-muted/25 text-muted-foreground">{group.kind === "policy" ? <ShieldCheck className="size-4" /> : <FlaskConical className="size-4" />}</span>
          <span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-2"><strong className="truncate text-sm font-medium">{label}</strong><Badge variant="outline" className="font-normal">{group.kind === "policy" ? t("guardrails.inheritedTests") : t("guardrails.customTests")}</Badge></span><span className="mt-1 block truncate font-mono text-xs text-muted-foreground">{identity}</span></span>
          <span className="hidden shrink-0 text-right text-xs text-muted-foreground sm:block">{t("guardrails.testCaseGroupSummary", { cases: group.cases.filter((item) => !item.excluded).length, rules: group.coveredRules })}</span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
        </summary>
        <div className="border-t bg-muted/10">
          {group.cases.length ? <div className="divide-y">{group.cases.map((item) => <article key={item.id} className={`grid gap-2 px-4 py-3 pl-15 sm:grid-cols-[minmax(0,1fr)_7rem_8rem_auto] sm:items-center ${item.excluded ? "bg-muted/30 text-muted-foreground" : ""}`}>
            <span className="min-w-0"><span className="flex min-w-0 items-center gap-2"><strong className="truncate text-sm font-medium">{item.name}</strong>{item.excluded ? <Badge variant="outline" className="shrink-0 font-normal">{t("guardrails.excludedFromValidation")}</Badge> : null}</span><span className="mt-1 block truncate font-mono text-xs text-muted-foreground">{item.source_case_id ?? item.id}</span></span>
            <Badge variant="outline" className="w-fit font-mono uppercase">{item.phase}</Badge>
            <StateBadge state={item.expected_decision} />
            {group.kind === "policy" && item.excluded && onRestore ? <Button type="button" size="sm" variant="outline" className="min-h-11" disabled={busyCaseId === item.id} onClick={() => onRestore(item.id)}>{busyCaseId === item.id ? <LoaderCircle className="animate-spin" /> : <RotateCcw />}{t("guardrails.restoreTestCase")}</Button> : null}
            {group.kind === "policy" && !item.excluded && onExclude ? <Button type="button" size="sm" variant="outline" className="min-h-11 text-foreground" disabled={busyCaseId === item.id} onClick={() => onExclude(item.id)}>{busyCaseId === item.id ? <LoaderCircle className="animate-spin" /> : <Ban />}{t("guardrails.excludeTestCase")}</Button> : null}
          </article>)}</div> : <div className="px-4 py-4 pl-15"><p className="text-xs leading-5 text-muted-foreground">{group.kind === "policy" ? t("guardrails.noInheritedTests") : t("guardrails.noCustomTests")}</p></div>}
          {group.kind === "guardrail" ? <div className="px-4 py-4 pl-15"><Button className="min-h-11" size="sm" variant="create" onClick={onAdd}><Plus />{t("guardrails.addTestCase")}</Button></div> : null}
        </div>
      </details>;
    })}</div>
  </section>;
}

export function EditGuardrailSheet({ guardrail, policies, open, onOpenChange, onSaved }: { guardrail: Guardrail; policies: Policy[]; open: boolean; onOpenChange: (open: boolean) => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState(guardrail.name);
  const [allowed, setAllowed] = useState(guardrail.allowed_topics.join("\n"));
  const [bindings, setBindings] = useState(guardrail.policy_bindings);
  const [level, setLevel] = useState(guardrail.safety_level);
  const [delivery, setDelivery] = useState(guardrail.output_delivery);
  useEffect(() => {
    if (open) {
      setName(guardrail.name);
      setAllowed(guardrail.allowed_topics.join("\n"));
      setBindings(guardrail.policy_bindings);
      setLevel(guardrail.safety_level);
      setDelivery(guardrail.output_delivery);
    }
  }, [guardrail, open]);
  const mutation = useMutation({
    mutationFn: () => updateGuardrail(guardrail.id, {
      name,
      allowed_topics: lines(allowed),
      policy_bindings: bindings,
      safety_level: level,
      output_delivery: delivery,
    }),
    onSuccess: () => { toast.success(t("guardrails.updated")); onSaved(); },
    onError: (error) => notifyError(error, t("guardrails.operationFailed")),
  });
  const dirty = name !== guardrail.name || allowed !== guardrail.allowed_topics.join("\n")
    || level !== guardrail.safety_level || delivery !== guardrail.output_delivery
    || JSON.stringify(bindings) !== JSON.stringify(guardrail.policy_bindings);
  const topicControlEnabled = hasTopicControlBinding(bindings, policies);
  const allowedTopicsMissing = topicControlEnabled && !lines(allowed).length;
  const parameterErrors = bindings.flatMap((binding) => {
    const policy = boundPolicy(policies, binding);
    if (!policy) return [t("guardrailWizard.nextBlocked.policyUnavailable", { name: `${binding.policy_id}@${binding.policy_version}` })];
    const { missingRequiredParameters } = getPolicyBindingValidation(binding, policy);
    return missingRequiredParameters.length ? [t("guardrailWizard.nextBlocked.requiredFields", { name: policy.name, fields: missingRequiredParameters.map((parameter) => parameter.label).join(", ") })] : [];
  });
  return <EntitySheet open={open} onOpenChange={onOpenChange} eyebrow={t("guardrails.editEyebrow")} title={t("guardrails.editTitle", { name: guardrail.name })} description={t("guardrails.editDescription")} width="xl" footer={<>{dirty ? <span role="status" className="mr-auto self-center text-xs text-muted-foreground">{t("protection.unsavedOrder")}</span> : null}<Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button><Button disabled={!name.trim() || !bindings.length || allowedTopicsMissing || parameterErrors.length > 0 || mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? <LoaderCircle className="animate-spin" /> : <Save />}{t(mutation.isPending ? "common.saving" : "common.save")}</Button></>}>
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5">
      <Field label={t("guardrails.guardrailName")}><Input className="min-h-11" value={name} onChange={(event) => setName(event.target.value)} /></Field>
      <section className="rounded-xl border bg-card p-4">
        <h3 className="text-sm font-semibold">{t("guardrails.topicAllowlist")}</h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("guardrails.topicAllowlistDescription")}</p>
        <div className="mt-4"><Field label={`${t("guardrails.allowedDomains")}${topicControlEnabled ? " *" : ""}`}><Textarea className="min-h-28" value={allowed} onChange={(event) => setAllowed(event.target.value)} placeholder={t("guardrails.topicAllowlistPlaceholder")} /></Field></div>
        {allowedTopicsMissing ? <p role="alert" className="mt-2 flex items-start gap-2 text-xs leading-5 text-destructive"><CircleAlert className="mt-0.5 size-4 shrink-0" />{t("guardrails.topicAllowlistRequired")}</p> : null}
      </section>
      <RuntimePostureFields safetyLevel={level} outputDelivery={delivery} onSafetyLevelChange={setLevel} onOutputDeliveryChange={setDelivery} />
      <section className="min-w-0"><h3 className="mb-3 text-sm font-semibold">{t("guardrails.policyBindings")}</h3><PolicyBindingEditor policies={policies} value={bindings} onChange={setBindings} />{parameterErrors.length ? <p role="alert" className="mt-3 text-sm text-destructive">{parameterErrors.join(" ")}</p> : null}</section>
      <ProtectionDependencies bindings={bindings} policies={policies} />
    </div>
  </EntitySheet>;
}

function hasTopicControlBinding(bindings: GuardrailPolicyBinding[], policies: Policy[]): boolean {
  return bindings.some((binding) => policyRequiresTopicAllowlist(boundPolicy(policies, binding) ?? { id: binding.policy_id }));
}

function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="grid gap-2"><Label>{label}</Label>{children}</label>; }
function lines(value: string) { return value.split("\n").map((item) => item.trim()).filter(Boolean); }
function notifyError(error: unknown, fallback: string) { toast.error(error instanceof Error ? error.message : fallback); }
function isGuardrailDraftManageable(guardrail: Pick<Guardrail, "is_default" | "system_managed">) { return guardrail.is_default || !guardrail.system_managed; }
