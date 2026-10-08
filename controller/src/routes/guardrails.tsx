import { ImmutableVersionView } from "@/components/guardrail-immutable-versions";
import { ImportGuardrailSheet } from "@/components/guardrail-import-sheet";
import { useDeploymentCapabilities } from "@/lib/deployment";
export { ImmutableVersionView } from "@/components/guardrail-immutable-versions";
import { ResourceList } from "@/components/resource-list";
import { EventFilterToolbar } from "@/components/event-filter-toolbar";
import { selectedSeverities, type EventSeverity } from "../../shared/security-severity";
import { SecuritySeverityBadge } from "@/components/security-severity";
import { isSplitTopicPolicy, TOPIC_POLICY_ID } from "../../shared/topic-policy";
import { upgradeTopicBinding } from "@/lib/topic-policy-upgrade";
import { GuardrailValidationReadiness, useGuardrailValidationReadiness } from "@/components/guardrail-validation-readiness";
import { useCorrectnessAvailability } from "@/components/correctness-availability";
import { TopicControlFields, type TopicControlMode } from "@/components/topic-control-fields";
import { useEffect, useMemo, useRef, useState, type ReactNode, type MouseEvent } from "react";
import { boundPolicy } from "@/lib/bound-policy";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { EventPagination, useEventCursor } from '@/components/event-pagination';
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { MenuButton, MenuItem, MenuItemDivider } from "@carbon/react";
import { Activity, ArrowLeft, ArrowUpRight, Ban, ChevronDown, CircleAlert, FileText, FlaskConical, History, LoaderCircle, LockKeyhole, Pencil, Plus, RefreshCw, RotateCcw, Save, ScrollText, ShieldAlert, ShieldCheck, Trash2, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "@/components/ui/notifications";

import { RuntimeHealthAlert } from "@/components/dashboard/runtime-health-alert";
import { RuntimeMetricChart } from "@/components/dashboard/runtime-metric-chart";
import { formatEventTimestamp } from "@/components/dashboard/event-time";
import { AddTestCaseSheet } from "@/components/add-test-case-sheet";
import { ConfirmationSheet } from "@/components/confirmation-sheet";
import { EntitySheet } from "@/components/entity-sheet";
import { GuardrailDraftReviewSheet, draftStateKey, hasUnpublishedDraft } from "@/components/guardrail-draft-review";
import { GuardrailDraftChangesSheet } from "@/components/guardrail-draft-changes";
import { isValidationRunning } from "@/components/validation-run-progress";
import { GuardrailRegistry } from "@/components/guardrail-registry";
import { getPolicyBindingValidation, PolicyBindingEditor } from "@/components/policy-binding-editor";
import { DeleteGuardrailSheet, type GuardrailDeletionConfirmation } from "@/components/guardrail-delete-sheet";
export { DeleteGuardrailSheet } from "@/components/guardrail-delete-sheet";
import { EmptyState, ErrorNotice, InfoNotice, PageHeader, StateBadge } from "@/components/product-shell";
import { RuntimePostureFields } from "@/components/runtime-posture-fields";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
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
import { policyRequiresTopicAllowlist, policyRequiresTopicModel } from "@/lib/protection-requirements";
import {
  createValidationRun,
  deleteGuardrail,
  deleteTestCase,
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
  restoreGuardrailTestCase,
  updateGuardrail,
  updateGuardrailLoggingSettings,
  type Guardrail,
  type GuardrailFindingPage,
  type GuardrailPolicyBinding,
  type GuardrailVersion,
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
import { TrafficScopeBadges } from "@/routes/routers";
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
  const capabilities = useDeploymentCapabilities();
  const [importOpen, setImportOpen] = useState(false);
  const importOpener = useRef<HTMLButtonElement | null>(null);
  const isAdmin = auth.user?.role === "admin";
  const actions = isAdmin ? <div className="flex items-center gap-2">
    {capabilities.packageImport.available ? <Button variant="outline" size="lg" onClick={event => { importOpener.current = event.currentTarget; setImportOpen(true); }}><Upload />{t("guardrailPackage.import")}</Button> : null}
    {capabilities.authoringEnabled ? <Button variant="create" size="lg" onClick={openCreation}><Plus />{t("guardrails.create")}</Button> : null}
  </div> : undefined;

  return (
    <section className="py-8">
      <PageHeader title={t("pages.guardrails.title")} description={t(capabilities.authoringEnabled ? "guardrails.description" : "guardrailPackage.receivingDescription")} />
      <ResourceList items={guardrails} label={t("pages.guardrails.title")} searchPlaceholder={t("resourceList.searchGuardrails")} searchText={item => `${item.name} ${item.id}`}
        filter={{ label: t("common.status"), options: [{ value: "", label: t("resourceList.allStatuses") }, ...[...new Set(guardrails.map(item => item.status))].sort().map(value => ({ value, label: t(`states.${value}`, { defaultValue: value.replaceAll("_", " ") }) }))], matches: (item, value) => item.status === value }}
        loading={query.isPending} refreshing={query.isFetching} error={query.error} onRefresh={() => void query.refetch()}
        emptyTitle={t("guardrails.emptyTitle")} emptyDescription={t("guardrails.emptyDescription")}
        action={actions}>
        {items => <GuardrailRegistry guardrails={items} onOpen={guardrailId => navigate({ to: "/guardrails/$guardrailId", params: { guardrailId } })} />}
      </ResourceList>
      {importOpen ? <ImportGuardrailSheet returnFocusRef={importOpener} onClose={() => setImportOpen(false)} /> : null}
      <CreateGuardrailWizard open={createOpen} returnFocusRef={createOpener} onOpenChange={setCreateOpen} onCreated={async (id) => { setCreateOpen(false); await queryClient.invalidateQueries({ queryKey: queryKeys.guardrails }); navigate({ to: "/guardrails/$guardrailId", params: { guardrailId: id } }); }} />
    </section>
  );
}

export function GuardrailDetailPage() {
  const { t: uiText } = useTranslation();
  const { t } = useTranslation();
  const { guardrailId } = useParams({ strict: false }) as { guardrailId: string };
  const navigate = useNavigate({ from: "/guardrails/$guardrailId" });
  const auth = useAuth();
  const queryClient = useQueryClient();
  const guardrailQuery = useQuery({ queryKey: queryKeys.guardrail(guardrailId), queryFn: () => getGuardrail(guardrailId) });
  const capabilities = useDeploymentCapabilities();
  // Imported Guardrails and receiving environments have no draft: versions are the whole state.
  const releaseOnly = !capabilities.authoringEnabled || guardrailQuery.data?.origin === "imported";
  const policiesQuery = useQuery({ queryKey: queryKeys.policies, queryFn: getPolicies, enabled: capabilities.authoringEnabled });
  const validationReadiness = useGuardrailValidationReadiness({ bindings: guardrailQuery.data?.policy_bindings ?? [], policies: policiesQuery.data?.items ?? EMPTY_POLICIES,
    enabled: Boolean(guardrailQuery.data), policiesReady: policiesQuery.isSuccess, policiesError: policiesQuery.isError });
  const versionsQuery = useQuery({ queryKey: queryKeys.guardrailVersions(guardrailId), queryFn: () => getGuardrailVersions(guardrailId) });
  const validationRunsQuery = useQuery({ queryKey: queryKeys.validationRuns(guardrailId), queryFn: () => getValidationRuns(guardrailId) });
  const testsQuery = useQuery({ queryKey: queryKeys.testCases(guardrailId), queryFn: () => getTestCases(guardrailId), enabled: Boolean(guardrailQuery.data) && !releaseOnly });
  const routersQuery = useQuery({ queryKey: queryKeys.routers, queryFn: getRouters });
  const endpointsQuery = useQuery({ queryKey: queryKeys.endpoints, queryFn: getEndpoints });
  const search = useSearch({ from: "/guardrails/$guardrailId" });
  const requestedSection = search.tab === "draft" ? "runtime" : search.tab ?? (guardrailQuery.data?.origin === "imported" ? "immutable" : "runtime");
  const section = releaseOnly && requestedSection === "testing" ? "immutable" : requestedSection;
  const setSection = (tab: string) => void navigate({ to: "/guardrails/$guardrailId", params: { guardrailId }, search: previous => ({ ...previous, tab }) });
  const window: MetricWindow = search.window ?? "24h";
  const setWindow = (window: MetricWindow) => void navigate({ to: "/guardrails/$guardrailId", params: { guardrailId }, search: previous => ({ ...previous, window }) });
  const [draftAction, setDraftAction] = useState<"edit" | "review" | "publish" | "changes" | "discard" | null>(null);
  const [draftJustSaved, setDraftJustSaved] = useState(false);
  const [testCasesOpen, setTestCasesOpen] = useState(false);
  const editOpen = draftAction === "edit";
  const setEditOpen = (open: boolean) => setDraftAction(open ? "edit" : null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [selectedValidationRun, setSelectedValidationRun] = useState<ValidationRun | null>(null);
  const [versionDetailRequested, setVersionDetailRequested] = useState(false);
  const [selectedVersionOverride, setSelectedVersionOverride] = useState<string | null>(null);
  const [compareBaseVersionNumber, setCompareBaseVersionNumber] = useState<string | null>(null);
  useEffect(() => {
    if (search.tab === "draft") void navigate({ search: previous => ({ ...previous, tab: "runtime" }), replace: true });
  }, [search.tab, navigate]);
  const guardrailVersions = [...(versionsQuery.data?.items ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.version.localeCompare(a.version));
  const compilationPending = guardrailVersions.some((item) => item.compile_status === "compiling");
  const validationPending = isValidationRunning(guardrailQuery.data?.latest_validation_run);
  useEffect(() => {
    if (!compilationPending && !validationPending) return;
    const timer = globalThis.setInterval(() => {
      void Promise.all([versionsQuery.refetch(), guardrailQuery.refetch()]);
    }, 1_500);
    return () => globalThis.clearInterval(timer);
  }, [compilationPending, validationPending, guardrailQuery, versionsQuery]);
  const latestVersion = guardrailVersions.find((item) => item.latest);
  const selectedVersionNumber = selectedVersionOverride && guardrailVersions.some((item) => item.version === selectedVersionOverride) ? selectedVersionOverride : latestVersion?.version ?? guardrailVersions[0]?.version ?? "";
  const selectedVersion = guardrailVersions.find((item) => item.version === selectedVersionNumber);
  const selectedValidation = [...(validationRunsQuery.data?.items ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at)).find((run) => run.guardrail_version === selectedVersionNumber) ?? null;
  const compareOptions = guardrailVersions.filter((item) => item.version !== selectedVersionNumber && (!item.compile_status || item.compile_status === "ready"));
  const immutableQuery = useQuery({
    queryKey: queryKeys.guardrailVersion(guardrailId, selectedVersionNumber),
    queryFn: () => getGuardrailVersion(guardrailId, selectedVersionNumber),
    enabled: section === "immutable" && Boolean(selectedVersionNumber),
    refetchInterval: selectedVersion?.compile_status === "compiling" ? 1_500 : false,
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
  const findingSeverities = selectedSeverities(search.severity);
  const setFindingSeverities = (levels: EventSeverity[]) => void navigate({ to: "/guardrails/$guardrailId", params: { guardrailId }, search: previous => ({ ...previous, severity: selectedSeverities(levels).join(",") || undefined }) });
  const findingsPaging = useEventCursor(JSON.stringify([guardrailId, window, findingSeverities]));
  const findingsQuery = useQuery({
    queryKey: [...queryKeys.guardrailFindings(guardrailId, window), findingSeverities, findingsPaging.cursor ?? null],
    queryFn: ({ signal }) => getGuardrailFindings(guardrailId, window, 100, findingsPaging.cursor, signal, findingSeverities),
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
    mutationFn: () => {
      if (validationReadiness.blocked) throw new Error(validationReadiness.reason ?? t("protection.validationReadiness.blockedTitle"));
      return createValidationRun(guardrailId);
    },
    onSuccess: async (run) => {
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
      setVersionDetailRequested(true);
      setSection("immutable");
      return;
    }
    setDraftJustSaved(false);
    setDraftAction("review");
  }

  if (guardrailQuery.isLoading) return <Skeleton className="mt-8 h-[34rem] rounded-xl" />;
  if (guardrailQuery.error || !guardrailQuery.data) return <div className="py-8"><ErrorNotice error={guardrailQuery.error ?? new Error(t("guardrails.notFound"))} /></div>;
  const guardrail = guardrailQuery.data;
  const policies = policiesQuery.data?.items ?? EMPTY_POLICIES;
  const routers = routersQuery.data?.items.filter((item) => item.activeSnapshot?.routes.some(route => route.enabled && route.targets.some(target => target.guardrailId === guardrail.id && target.weightBps > 0))) ?? [];
  const canManageDraft = auth.user?.role === "admin" && isGuardrailDraftManageable(guardrail) && !releaseOnly;
  const currentRelease = guardrailVersions.find(version => version.source_draft_version === guardrail.draft_revision);
  const hasDraft = hasUnpublishedDraft(guardrail);
  const currentTest = guardrail.latest_validation_run?.source_draft_version === guardrail.draft_revision ? guardrail.latest_validation_run : null;
  const testingDraft = isValidationRunning(currentTest);
  const openDraftReview = () => { setDraftJustSaved(false); setDraftAction("review"); };

  return (
    <section className="py-6 sm:py-8">
      <Link to="/guardrails" className="inline-flex min-h-11 items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" />{t("guardrails.back")}</Link>
      <div className="mt-3 flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-sans text-[2rem] font-normal tracking-normal">{guardrail.name}</h1>
            {latestVersion ? <Badge className="border-emerald-200 bg-emerald-50 font-mono text-[11px] text-emerald-700 hover:bg-emerald-50">{t("guardrails.latestVersion", { version: latestVersion.version })}</Badge> : <StateBadge state={guardrail.tested_current ? "ready" : "needs_validation"} />}
            {routers.length ? <StateBadge state="protected" /> : latestVersion ? <StateBadge state="ready" /> : null}
            {guardrail.is_default ? <Badge variant="outline">{t("guardrails.defaultBadge")}</Badge> : guardrail.system_managed ? <Badge variant="outline">{t("guardrails.systemManaged")}</Badge> : null}
          </div>
          {guardrail.origin === "imported" ? <p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground"><LockKeyhole className="size-3.5" aria-hidden="true" />{t("guardrailPackage.importedFrom", { source: guardrail.source_id ?? "" })}</p> : null}
          {guardrail.copy_origin && <p className="mt-2 text-sm text-muted-foreground">{uiText("uiCopy.copiedFrom")}{" "}{guardrail.copy_origin.sourceName} · {guardrail.copy_origin.sourceVersion ?? `draft r${guardrail.copy_origin.sourceDraftRevision}`} · {guardrail.copy_origin.sourceGuardrailId}</p>}
          {hasDraft ? <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <p role="status"><span className="font-medium">{t(latestVersion ? "guardrails.unpublishedChanges" : "guardrails.newDraft")}</span> · {t(draftStateKey(guardrail, currentRelease))}{currentTest?.status === "failed" ? ` (${currentTest.metrics.total - currentTest.metrics.passed}/${currentTest.metrics.total})` : ""}</p>
            <button type="button" className="min-h-11 text-primary hover:underline" onClick={() => setDraftAction("changes")}>{t("guardrails.draftChanges.view")}</button>
            {testingDraft && currentTest?.progress ? <span className="text-xs tabular-nums text-muted-foreground">{t(`guardrails.testProgress.${currentTest.progress.phase}`)} · {t("guardrails.testProgress.completed", { completed: currentTest.progress.completedCases, total: currentTest.metrics.total })}</span> : null}
          </div> : null}
        </div>
        <div className="flex shrink-0 items-start gap-2">
          {canManageDraft && hasDraft ? <Button className="min-h-11" variant="outline" disabled={compilationPending} onClick={openDraftReview}>{testingDraft ? <LoaderCircle className="animate-spin" /> : <FlaskConical />}{t(testingDraft ? "guardrails.viewTestProgress" : "guardrails.testDraft")}</Button> : null}
          {canManageDraft && guardrail.tested_current && !guardrail.published_current ? <Button disabled={compilationPending} onClick={() => { setDraftJustSaved(false); setDraftAction("publish"); }}>{compilationPending ? <LoaderCircle className="animate-spin" /> : <ShieldCheck />}{t(compilationPending ? "guardrails.requestingCompilation" : "guardrails.publishVersion")}</Button> : null}
          {auth.user?.role === "admin" ? <MenuButton label={t("routing.actions")} kind="tertiary" size="md" menuAlignment="bottom-end" className="guard-actions-menu">
            {canManageDraft ? <MenuItem label={t("guardrails.editAction")} renderIcon={Pencil} onClick={() => setEditOpen(true)} /> : null}
            {canManageDraft ? <MenuItem label={t("guardrails.editTestCases")} renderIcon={FlaskConical} onClick={() => setTestCasesOpen(true)} /> : null}
            {hasDraft ? <MenuItem label={t("guardrails.draftChanges.view")} renderIcon={FileText} onClick={() => setDraftAction("changes")} /> : null}
            {canManageDraft && hasDraft && latestVersion ? <MenuItem label={t("guardrails.draftChanges.discard")} renderIcon={RotateCcw} disabled={compilationPending} onClick={() => setDraftAction("discard")} /> : null}
            {canManageDraft ? <MenuItem label={t("guardrails.openPlayground")} renderIcon={FlaskConical} onClick={() => { void navigate({ to: "/playground", search: { guardrail: guardrail.id, target: "draft", version: undefined } }); }} /> : null}
            {!guardrail.is_default ? <MenuItemDivider /> : null}
            {!guardrail.is_default ? <MenuItem label={t("guardrails.deleteAction")} renderIcon={Trash2} kind="danger" onClick={() => {
            deleteMutation.reset();
            queryClient.removeQueries({ queryKey: queryKeys.guardrailDeletionImpact(guardrailId), exact: true });
            setDeleteOpen(true);
          }} /> : null}
          </MenuButton> : null}
        </div>
      </div>

      {guardrail.is_default ? <div className="mt-5"><InfoNotice title={t("guardrails.defaultNoticeTitle")}>{t(releaseOnly ? "guardrailPackage.defaultReleaseNotice" : "guardrails.defaultNoticeDescription")}</InfoNotice></div> : null}

      {hasDraft && !releaseOnly ? <div className="mt-5"><GuardrailValidationReadiness readiness={validationReadiness} onEdit={canManageDraft ? () => setEditOpen(true) : undefined} onRetry={() => { void policiesQuery.refetch(); validationReadiness.refresh(); }} /></div> : null}

      <Tabs value={section} onValueChange={setSection} className="mt-7">
        <div className="overflow-x-auto">
          <TabsList className="min-w-max" aria-label={t("guardrails.detailViews")}>
            <TabsTrigger value="runtime"><Activity aria-hidden="true" />{t("guardrails.runtimeTab")}</TabsTrigger>
            <TabsTrigger value="event"><ShieldAlert aria-hidden="true" /><span className="flex items-center gap-2">{t("guardrails.eventTab")}{metricsQuery.data?.findings_summary?.total ? <Badge variant="outline" className={metricsQuery.data?.findings_summary?.critical ? "border-red-200 bg-red-50 font-mono text-[10px] text-red-700" : "font-mono text-[10px]"}>{metricsQuery.data?.findings_summary?.total}</Badge> : null}</span></TabsTrigger>
            <TabsTrigger value="immutable"><History aria-hidden="true" /><span className="flex items-center gap-2">{t("guardrails.versions")}{versionsQuery.data ? <Badge variant="outline" className="font-mono text-[10px]">{guardrailVersions.length}</Badge> : null}</span></TabsTrigger>
            {releaseOnly ? null : <TabsTrigger value="testing"><FileText aria-hidden="true" /><span className="flex items-center gap-2">{t("guardrails.validationHistoryTab")}{validationRunsQuery.data?.items.length ? <Badge variant="outline" className="font-mono text-[10px]">{validationRunsQuery.data.items.length}</Badge> : null}</span></TabsTrigger>}
          </TabsList>
        </div>
        <TabsContent value="runtime" className="space-y-5 pt-5">
          <GuardrailLoggingCard guardrailId={guardrail.id} />
          <GuardrailRuntimeView guardrailId={guardrail.id} metrics={metricsQuery.data} loading={metricsQuery.isLoading} error={metricsQuery.error} routers={routers} versions={guardrailVersions} window={window} onWindowChange={setWindow} />
        </TabsContent>
        <TabsContent value="event" className="space-y-5 pt-5">
          <GuardrailFindingsView guardrailId={guardrailId} data={findingsQuery.data} loading={findingsQuery.isLoading} error={findingsQuery.error} policies={policies} routers={routers} endpoints={endpointsQuery.data?.items ?? []} window={window} onWindowChange={setWindow} summary={metricsQuery.data?.findings_summary} severities={findingSeverities} onSeveritiesChange={setFindingSeverities} onRetry={() => { void findingsQuery.refetch(); void metricsQuery.refetch(); }} />
          <EventPagination page={findingsPaging.page} busy={findingsQuery.isFetching} nextCursor={findingsQuery.data?.nextCursor} onNext={findingsPaging.next} onPrevious={findingsPaging.previous} onLatest={findingsPaging.latest} />
        </TabsContent>
        <TabsContent value="immutable" className="pt-5">
          <ImmutableVersionView
            openRequested={versionDetailRequested}
            onOpenRequestHandled={() => setVersionDetailRequested(false)}
            detail={immutableQuery.data}
            selectedVersion={selectedVersion}
            versions={guardrailVersions}
            loading={versionsQuery.isLoading}
            error={versionsQuery.error}
            detailLoading={immutableQuery.isFetching}
            detailError={immutableQuery.error}
            comparisonError={compareQuery.error}
            validationRuns={validationRunsQuery.data?.items ?? []}
            validationLoading={validationRunsQuery.isLoading}
            validationError={validationRunsQuery.error}
            onRetry={() => { void versionsQuery.refetch(); void immutableQuery.refetch(); void validationRunsQuery.refetch(); }}
            onRetryComparison={() => { void compareQuery.refetch(); }}
            comparisonDetail={compareQuery.data}
            comparisonActive={Boolean(compareBaseVersionNumber)}
            comparisonLoading={compareQuery.isLoading}
            compareOptions={compareOptions}
            guardrailId={guardrail.id}
            guardrailName={guardrail.name}
            isDefault={guardrail.is_default}
            validation={selectedValidation}
            onChanged={refresh}
            onOpenDraft={canManageDraft ? () => setEditOpen(true) : () => setSection("testing")}
            onOpenValidation={setSelectedValidationRun}
            onSelectVersion={(version) => { setSelectedVersionOverride(version); setCompareBaseVersionNumber(null); }}
            onStartCompare={() => { const previous = compareOptions.find((item) => item.created_at < (selectedVersion?.created_at ?? "")) ?? compareOptions[0]; if (previous) setCompareBaseVersionNumber(previous.version); }}
            onCompareBaseChange={setCompareBaseVersionNumber}
            onCloseCompare={() => setCompareBaseVersionNumber(null)}
          />
        </TabsContent>
        <TabsContent value="testing" className="pt-5">
          <GuardrailValidationHistory
            runs={validationRunsQuery.data?.items ?? []}
            loading={validationRunsQuery.isLoading}
            error={validationRunsQuery.error}
            canManage={canManageDraft}
            blockedReason={validationReadiness.reason}
            running={validationMutation.isPending}
            onRun={openDraftReview}
            onOpen={setSelectedValidationRun}
            onOpenTarget={openValidationTarget}
          />
        </TabsContent>
      </Tabs>

      {canManageDraft && editOpen ? <EditGuardrailSheet guardrail={guardrail} policies={policies} open onOpenChange={setEditOpen} onSaved={async saved => { queryClient.setQueryData(queryKeys.guardrail(guardrailId), saved); setDraftJustSaved(true); setDraftAction(hasUnpublishedDraft(saved) ? "review" : null); await refresh(); }} /> : null}
      {draftAction === "changes" || draftAction === "discard" ? <GuardrailDraftChangesSheet guardrail={guardrail} initialDiscard={draftAction === "discard"} canManage={canManageDraft} onClose={() => setDraftAction(null)} onChanged={refresh} /> : null}
      {draftAction === "review" || draftAction === "publish" ? <GuardrailDraftReviewSheet guardrail={guardrail} policies={policies} versions={guardrailVersions} policiesReady={policiesQuery.isSuccess} policiesError={policiesQuery.isError} onRetryPolicies={() => { void policiesQuery.refetch(); }} readOnly={!canManageDraft} justSaved={draftJustSaved} initialPublish={draftAction === "publish"} onClose={() => setDraftAction(null)} onEdit={() => setEditOpen(true)} onChanged={refresh} onPublished={version => { setDraftAction(null); setSelectedVersionOverride(version.version); setVersionDetailRequested(true); setSection("immutable"); }} /> : null}
      {canManageDraft && testCasesOpen ? <EditGuardrailTestCasesSheet guardrail={guardrail} policies={policies} cases={testsQuery.data?.items ?? []} casesLoading={testsQuery.isLoading} casesError={testsQuery.error} onRetryCases={() => { void testsQuery.refetch(); }} onChanged={refresh} onClose={() => setTestCasesOpen(false)} /> : null}
      <ValidationDetailSheet blockedReason={validationReadiness.reason} run={selectedValidationRun} guardrail={guardrail} canManage={canManageDraft} running={validationMutation.isPending} onRunAgain={() => validationMutation.mutate()} onOpenTarget={openValidationTarget} onClose={() => setSelectedValidationRun(null)} />
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
        <Select value={window} onValueChange={(value) => onWindowChange(value as MetricWindow)}><SelectTrigger className="field:h-9 w-full field:bg-card sm:w-40" aria-label={t("dashboard.timeRangeFilter")}><SelectValue /></SelectTrigger><SelectContent>{(["1h", "24h", "7d", "15d", "30d"] as MetricWindow[]).map((value) => <SelectItem key={value} value={value}>{t(`dashboard.windows.${value}`)}</SelectItem>)}</SelectContent></Select>
      </div>
      <InfoNotice dismissible title={t("guardrails.runtimeEvidencePrivacyTitle")}>{t("guardrails.runtimeEvidencePrivacyDescription")}</InfoNotice>
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

export function GuardrailFindingsView({ guardrailId, data, summary: scopeSummary, loading, error, policies, routers, endpoints, window, onWindowChange, severities: controlledSeverities, onSeveritiesChange, onRetry }: { guardrailId?: string; data?: GuardrailFindingPage; summary?: GuardrailFindingPage["summary"]; loading: boolean; error: unknown; policies: Policy[]; routers: Awaited<ReturnType<typeof getRouters>>["items"]; endpoints: Endpoint[]; window: MetricWindow; onWindowChange: (window: MetricWindow) => void; severities?: EventSeverity[]; onSeveritiesChange?: (severities: EventSeverity[]) => void; onRetry?: () => void }) {
  const { t, i18n } = useTranslation();
  const [localSeverities, setLocalSeverities] = useState<EventSeverity[]>([]);
  const severities = controlledSeverities ?? localSeverities;
  const setSeverities = onSeveritiesChange ?? setLocalSeverities;
  const summary = scopeSummary ?? data?.summary;
  const findings = data?.items ?? [];
  const visibleFindings = severities.length ? findings.filter(finding => severities.includes(finding.severity)) : findings;
  const matchedCount = summary ? (severities.length ? severities.reduce((sum, level) => sum + (summary[level] ?? 0), 0) : summary.total) : undefined;

  return <section className="space-y-4" aria-label={t("guardrails.securityFindingsTitle")}>
    <header className="flex items-start justify-between gap-6">
      <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{t("guardrails.securityFindingsDescription")}</p>
      <Link to="/logs" search={{ guardrailId: guardrailId ?? data?.items[0]?.guardrail_id ?? undefined }} className="inline-flex shrink-0 items-center gap-1.5 py-1 text-sm text-primary underline-offset-4 hover:underline">{t("securityEvents.openLogs")}<ArrowUpRight className="size-4" /></Link>
    </header>
    <div className="border bg-card">
      <EventFilterToolbar window={window} onWindowChange={onWindowChange} severities={severities} onSeveritiesChange={setSeverities} counts={summary} />
      <div className="flex min-h-12 items-center justify-between gap-4 border-y px-4 py-3 text-xs text-muted-foreground" role="status" aria-live="polite" aria-atomic="true">
        <span>{summary ? t("securityEvents.resultSummary", { matched: matchedCount, total: summary.total, interactions: summary.affected_traces }) : t(error ? "securityEvents.summaryUnavailable" : "securityEvents.loadingSummary")}</span>
        {loading && summary ? <span className="inline-flex items-center gap-1.5"><LoaderCircle className="size-3.5 animate-spin" />{t("securityEvents.updating")}</span> : null}
      </div>
      <div aria-busy={loading}>
        {loading ? <Skeleton className="m-4 h-56 rounded-none" /> : error ? <div className="space-y-3 p-4"><ErrorNotice error={error} />{onRetry ? <Button variant="outline" onClick={onRetry}>{t("securityEvents.retry")}</Button> : null}</div> : visibleFindings.length ? <div className="divide-y">{visibleFindings.map(finding => {
          const timestamp = formatEventTimestamp(finding.created_at, i18n.language);
          const router = routers.find(item => item.id === finding.router_id);
          const endpoint = endpoints.find(item => item.id === finding.endpoint_id);
          const source = router?.name ?? endpoint?.name ?? (finding.protocol === "playground" ? t("guardrails.playgroundSource") : finding.protocol?.toUpperCase()) ?? t("guardrails.directRuntimeSource");
          return <article key={`${finding.trace_id}:${finding.id}`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-5 px-4 py-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2"><SecuritySeverityBadge severity={finding.severity} /><strong className="text-sm">{guardrailFindingTitle(finding, policies)}</strong><Badge variant="outline">{t("securityEvents.requestedAction")}: {t(`securityEvents.actions.${finding.recommended_action}`, { defaultValue: finding.recommended_action })}</Badge></div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">{finding.detail}</p>
              <p className="mt-2 break-all font-mono text-[11px] text-muted-foreground">{finding.policy_id ?? "—"}{finding.policy_version ? ` @ ${finding.policy_version}` : ""}{finding.rule_id ? ` · ${finding.rule_id}` : ""}</p>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"><span>{t("guardrails.sourceLabel")}: <strong className="font-medium text-foreground">{source}</strong></span><span>{t("guardrails.versionLabel")}: <code>{finding.guardrail_version ?? "—"}</code></span><span>{t("guardrails.phaseLabel")}: <code>{finding.phase}</code></span><span>{t("guardrails.confidenceLabel")}: <code>{finding.confidence === null ? t("securityEvents.notProvided") : `${Math.round(finding.confidence * 100)}%`}</code></span></div>
            </div>
            <div className="flex flex-col items-end gap-3"><time className="font-mono text-right text-[11px] text-muted-foreground" dateTime={finding.created_at}>{timestamp.time}<span className="mt-1 block">{timestamp.date}</span></time><Button asChild variant="outline" size="sm"><Link to="/logs" search={{ eventId: finding.event_id, requestId: finding.trace_id, checkpointId: finding.event_id, guardrailId: finding.guardrail_id ?? undefined }}><ScrollText />{t("logs.viewLog")}</Link></Button></div>
          </article>;
        })}</div> : <div className="flex min-h-56 flex-col items-center justify-center px-6 py-10 text-center"><ShieldCheck className="size-6 text-muted-foreground" /><p className="mt-3 text-sm font-medium">{t(severities.length ? "guardrails.noMatchingFindings" : data?.collection_status === "not_collected" ? "guardrails.findingsNotCollected" : data?.collection_status === "no_events" ? "guardrails.noRuntimeEvidence" : "guardrails.noSecurityFindings")}</p><p className="mt-1 max-w-lg text-xs leading-5 text-muted-foreground">{t(severities.length ? "guardrails.noMatchingFindingsDescription" : data?.collection_status === "not_collected" ? "guardrails.findingsNotCollectedDescription" : data?.collection_status === "no_events" ? "guardrails.noRuntimeEvidenceDescription" : "guardrails.noSecurityFindingsDescription")}</p>{severities.length ? <Button variant="ghost" className="mt-3" onClick={() => setSeverities([])}>{t("securityEvents.clearFilters")}</Button> : null}</div>}
        {!loading && !error && data && (matchedCount ?? 0) > visibleFindings.length ? <div className="border-t px-4 py-3 text-xs text-muted-foreground">{t("guardrails.findingsTruncated", { shown: visibleFindings.length, total: matchedCount })}</div> : null}
      </div>
    </div>
  </section>;
}

function guardrailFindingTitle(finding: RouterTraceFinding, policies: Policy[]) { const policy = policies.find((item) => item.id === finding.policy_id); const rule = policy?.rules.find((item) => item.id === finding.rule_id); return rule?.name ?? policy?.name ?? finding.rule_id ?? finding.risk.replaceAll("_", " "); }

export function GuardrailLoggingCard({ guardrailId }: { guardrailId: string }) {
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
  if (query.error || !query.data) return <div className="space-y-3"><ErrorNotice error={query.error ?? new Error(t("guardrails.loggingUnavailable"))} /><Button variant="outline" className="min-h-11" onClick={() => void query.refetch()}>{t("common.retry")}</Button></div>;
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
        <div className="w-full shrink-0 lg:w-48"><Label htmlFor={`logging-level-${guardrailId}`} className="sr-only">{t("guardrails.loggingLevel")}</Label><Select value={settings.level} disabled={auth.user?.role !== "admin" || mutation.isPending} onValueChange={(value) => onLevelChange(value as LoggingLevel)}><SelectTrigger id={`logging-level-${guardrailId}`} className="field:min-h-11 field:bg-card"><SelectValue /></SelectTrigger><SelectContent>{(["info", "debug", "trace"] as LoggingLevel[]).map((level) => <SelectItem key={level} value={level}><span className="flex items-center gap-2"><span className={`size-1.5 rounded-full ${level === "info" ? "bg-emerald-500" : "bg-amber-500"}`} />{level.toUpperCase()}</span></SelectItem>)}</SelectContent></Select>{auth.user?.role !== "admin" ? <p className="mt-1.5 text-[11px] text-muted-foreground">{t("guardrails.loggingAdminOnly")}</p> : null}</div>
      </div>
      <p className="border-t px-4 py-3 text-xs leading-5 text-muted-foreground">{t("guardrails.loggingScopeHint")}</p>
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

export function EditGuardrailTestCasesSheet({ guardrail, policies, cases, casesLoading, casesError, onChanged, onRetryCases, onClose }: {
  guardrail: Guardrail; policies: Policy[]; cases: TestCase[]; casesLoading: boolean; casesError?: unknown;
  onChanged: () => Promise<void>; onRetryCases: () => void; onClose: () => void;
}) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const [change, setChange] = useState<{ caseId: string; action: "exclude" | "restore" | "delete" } | null>(null);
  const mutation = useMutation({
    mutationFn: async ({ caseId, action }: NonNullable<typeof change>) => {
      if (action === "delete") await deleteTestCase(guardrail.id, caseId);
      else if (action === "exclude") await excludeGuardrailTestCase(guardrail.id, caseId);
      else await restoreGuardrailTestCase(guardrail.id, caseId);
    },
    onSuccess: async (_, variables) => {
      await onChanged();
      setChange(null);
      toast.success(t(variables.action === "delete" ? "guardrails.caseRemoved" : variables.action === "exclude" ? "guardrails.testCaseExcluded" : "guardrails.testCaseRestored"));
    },
  });
  const confirmKey = change?.action === "delete" ? "guardrails.deleteCustomCase" : change?.action === "restore" ? "guardrails.restoreTestCase" : "guardrails.excludeTestCase";
  // Each step replaces the drawer contents; drawers never stack.
  if (adding) return <AddTestCaseSheet guardrail={guardrail} open onOpenChange={open => { if (!open) setAdding(false); }} onCreated={async () => { await onChanged(); setAdding(false); }} />;
  return <EntitySheet open width="xl" density="compact" closeDisabled={mutation.isPending} onOpenChange={open => { if (!open && !mutation.isPending) onClose(); }}
    eyebrow={guardrail.name} title={t("guardrails.editTestCases")} description={t("guardrails.editTestCasesDescription")}
    footer={change ? <><Button variant="outline" disabled={mutation.isPending} onClick={() => { setChange(null); mutation.reset(); }}>{t("common.cancel")}</Button><Button variant={change.action === "delete" ? "destructive" : "default"} disabled={mutation.isPending} onClick={() => mutation.mutate(change)}>{mutation.isPending ? <LoaderCircle className="animate-spin" /> : null}{t(confirmKey)}</Button></> : <Button variant="outline" onClick={onClose}>{t("common.close")}</Button>}>
    {change ? <div className="space-y-4"><h3 className="text-base font-medium">{t(confirmKey)}</h3><p className="text-sm">{cases.find(item => item.id === change.caseId)?.name}</p><p className="text-sm text-muted-foreground">{t(change.action === "delete" ? "guardrails.deleteCustomCaseImpact" : "guardrails.confirmScopeChangeImpact")}</p>{mutation.error ? <ErrorNotice error={mutation.error} /> : null}</div> : casesError ? <div className="space-y-3"><ErrorNotice error={casesError} /><Button variant="outline" onClick={onRetryCases}><RefreshCw />{t("common.retry")}</Button></div> : <TestCases cases={cases} bindings={guardrail.policy_bindings} policies={policies} loading={casesLoading} onAdd={() => setAdding(true)} onExclude={caseId => setChange({ caseId, action: "exclude" })} onRestore={caseId => setChange({ caseId, action: "restore" })} onDelete={caseId => setChange({ caseId, action: "delete" })} />}
  </EntitySheet>;
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

export function TestCases({ cases, bindings, policies, loading, onAdd, onExclude, onRestore, onDelete, busyCaseId }: { cases: TestCase[]; bindings: GuardrailPolicyBinding[]; policies: Policy[]; loading: boolean; onAdd?: () => void; onExclude?: (caseId: string) => void; onRestore?: (caseId: string) => void; onDelete?: (caseId: string) => void; busyCaseId?: string }) {
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
            {item.origin === "custom" && onDelete ? <Button type="button" size="sm" variant="ghost" className="min-h-11 text-destructive" disabled={busyCaseId === item.id} onClick={() => onDelete(item.id)}><Trash2 />{t("guardrails.deleteCustomCase")}</Button> : null}
          </article>)}</div> : <div className="px-4 py-4 pl-15"><p className="text-xs leading-5 text-muted-foreground">{group.kind === "policy" ? t("guardrails.noInheritedTests") : t("guardrails.noCustomTests")}</p></div>}
          {group.kind === "guardrail" && onAdd ? <div className="px-4 py-4 pl-15"><Button className="min-h-11" size="sm" variant="create" onClick={onAdd}><Plus />{t("guardrails.addTestCase")}</Button></div> : null}
        </div>
      </details>;
    })}</div>
  </section>;
}

export function EditGuardrailSheet({ guardrail, policies, open, onOpenChange, onSaved }: { guardrail: Guardrail; policies: Policy[]; open: boolean; onOpenChange: (open: boolean) => void; onSaved: (saved: Guardrail) => void | Promise<void> }) {
  const { t } = useTranslation();
  const [name, setName] = useState(guardrail.name);
  const [allowed, setAllowed] = useState(guardrail.allowed_topics.join("\n"));
  const [denied, setDenied] = useState(guardrail.restricted_topics.join("\n"));
  const [topicMode, setTopicMode] = useState<TopicControlMode>(guardrail.topic_control_mode ?? "strict");
  const [bindings, setBindings] = useState(guardrail.policy_bindings);
  const correctnessAvailability = useCorrectnessAvailability(open);
  const editReadiness = useGuardrailValidationReadiness({ bindings, policies, enabled: open });
  const correctnessBlocker = bindings.map(binding => correctnessAvailability.reason(boundPolicy(policies, binding))).find(Boolean);
  const [level, setLevel] = useState(guardrail.safety_level);
  const [delivery, setDelivery] = useState(guardrail.output_delivery);
  const wasOpen = useRef(false);
  const [baseline, setBaseline] = useState(guardrail);
  const [discardRequested, setDiscardRequested] = useState(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setBaseline(guardrail);
      setDiscardRequested(false);
      setName(guardrail.name);
      setAllowed(guardrail.allowed_topics.join("\n"));
      setDenied(guardrail.restricted_topics.join("\n"));
      setTopicMode(guardrail.topic_control_mode ?? "strict");
      setBindings(guardrail.policy_bindings);
      setLevel(guardrail.safety_level);
      setDelivery(guardrail.output_delivery);
    }
    wasOpen.current = open;
  }, [guardrail, open]);
  const mutation = useMutation({
    mutationFn: () => {
      if (editReadiness.blocked) throw new Error(editReadiness.reason ?? t("protection.validationReadiness.blockedTitle"));
      if (correctnessBlocker) throw new Error(correctnessBlocker);
      return updateGuardrail(guardrail.id, {
        ...(baseline.draft_revision !== undefined ? { expectedDraftRevision: baseline.draft_revision } : {}),
        name,
        allowed_topics: lines(allowed),
        restricted_topics: lines(denied),
        topic_control_mode: topicMode,
        policy_bindings: bindings,
        safety_level: level,
        output_delivery: delivery,
      });
    },
    onSuccess: async saved => { toast.success(t("guardrails.updated")); await onSaved(saved); },
    onError: (error) => notifyError(error, t("guardrails.operationFailed")),
  });
  const dirty = name !== baseline.name || allowed !== baseline.allowed_topics.join("\n")
    || denied !== baseline.restricted_topics.join("\n") || topicMode !== (baseline.topic_control_mode ?? "strict")
    || level !== baseline.safety_level || delivery !== baseline.output_delivery
    || JSON.stringify(bindings) !== JSON.stringify(baseline.policy_bindings);
  const topicControlEnabled = hasTopicControlBinding(bindings, policies);
  const allowedTopicsMissing = topicControlEnabled && topicMode === "strict" && !lines(allowed).length;
  const parameterErrors = bindings.flatMap((binding) => {
    const policy = boundPolicy(policies, binding);
    if (!policy) return [t("guardrailWizard.nextBlocked.policyUnavailable", { name: `${binding.policy_id}@${binding.policy_version}` })];
    const { missingRequiredParameters, missingRules, missingRails } = getPolicyBindingValidation(binding, policy);
    if (missingRules) return [t("guardrailWizard.nextBlocked.enableRules", { name: policy.name })];
    if (missingRails) return [t("protection.selectDirection")];
    return missingRequiredParameters.length ? [t("guardrailWizard.nextBlocked.requiredFields", { name: policy.name, fields: missingRequiredParameters.map((parameter) => parameter.label).join(", ") })] : [];
  });
  const requestClose = () => { if (mutation.isPending) return; if (dirty) setDiscardRequested(true); else onOpenChange(false); };
  return <EntitySheet open={open} closeDisabled={mutation.isPending} onOpenChange={next => { if (!next) requestClose(); }} eyebrow={t("guardrails.editEyebrow")} title={t("guardrails.editTitle", { name: guardrail.name })} description={t("guardrails.editDescription")} width="xl" footer={discardRequested ? <><span role="status" className="mr-auto text-xs text-muted-foreground">{t("guardrails.unsavedDraft")}</span><Button variant="outline" onClick={() => setDiscardRequested(false)}>{t("guardrails.continueEditing")}</Button><Button variant="destructive" onClick={() => onOpenChange(false)}>{t("guardrails.discardChanges")}</Button></> : <>{dirty ? <span role="status" className="mr-auto self-center text-xs text-muted-foreground">{t("guardrails.unsavedDraft")}</span> : null}<Button variant="outline" disabled={mutation.isPending} onClick={requestClose}>{t("common.cancel")}</Button><Button disabled={editReadiness.blocked || Boolean(correctnessBlocker) || !name.trim() || !bindings.length || allowedTopicsMissing || parameterErrors.length > 0 || mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? <LoaderCircle className="animate-spin" /> : <Save />}{t(mutation.isPending ? "common.saving" : "guardrails.saveDraft")}</Button></>}>
    {mutation.error ? <div className="mb-4"><ErrorNotice error={mutation.error} /></div> : null}
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5">
      <GuardrailValidationReadiness readiness={editReadiness} onRemoveTopic={() => setBindings(items => items.filter(binding => !policyRequiresTopicModel(boundPolicy(policies, binding))))} />
      <Field label={t("guardrails.guardrailName")}><Input className="field:min-h-11" value={name} onChange={(event) => setName(event.target.value)} /></Field>
      {topicControlEnabled ? <section className="rounded-xl border bg-card p-4">
        <h3 className="text-sm font-semibold">{t("guardrails.topicAllowlist")}</h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("guardrails.topicAllowlistDescription")}</p>
        {policies.some(policy => isSplitTopicPolicy(policy.id, policy.version)) && bindings.some(binding => binding.policy_id === TOPIC_POLICY_ID && binding.policy_version === "1.0.0") ? <div className="mt-3 space-y-2"><p className="text-xs text-muted-foreground">{t("protection.topicRules.upgradeHint")}</p><Button variant="outline" onClick={() => setBindings(items => items.map(binding => upgradeTopicBinding(binding, allowed, denied, topicMode)))}>{t("protection.topicRules.upgrade")}</Button></div> : null}
        <div className="mt-4"><TopicControlFields allowed={allowed} denied={denied} mode={topicMode} onAllowedChange={setAllowed} onDeniedChange={setDenied} onModeChange={setTopicMode} allowedLabel={t("guardrails.allowedDomains")} /></div>
        {allowedTopicsMissing ? <p role="alert" className="mt-2 flex items-start gap-2 text-xs leading-5 text-destructive"><CircleAlert className="mt-0.5 size-4 shrink-0" />{t("guardrails.topicAllowlistRequired")}</p> : null}
      </section> : null}
      <RuntimePostureFields safetyLevel={level} outputDelivery={delivery} onSafetyLevelChange={setLevel} onOutputDeliveryChange={setDelivery} />
      <section className="min-w-0"><h3 className="mb-3 text-sm font-semibold">{t("guardrails.policyBindings")}</h3><PolicyBindingEditor policies={policies} value={bindings} onChange={setBindings} unavailableReason={correctnessAvailability.reason} />{parameterErrors.length ? <p role="alert" className="mt-3 text-sm text-destructive">{parameterErrors.join(" ")}</p> : null}</section>
    </div>
  </EntitySheet>;
}

function hasTopicControlBinding(bindings: GuardrailPolicyBinding[], policies: Policy[]): boolean {
  return bindings.some((binding) => policyRequiresTopicAllowlist(boundPolicy(policies, binding) ?? { id: binding.policy_id, version: binding.policy_version }));
}

function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="grid gap-2"><Label>{label}</Label>{children}</label>; }
function lines(value: string) { return value.split("\n").map((item) => item.trim()).filter(Boolean); }
function notifyError(error: unknown, fallback: string) { toast.error(error instanceof Error ? error.message : fallback); }
function isGuardrailDraftManageable(guardrail: Pick<Guardrail, "is_default" | "system_managed">) { return guardrail.is_default || !guardrail.system_managed; }
