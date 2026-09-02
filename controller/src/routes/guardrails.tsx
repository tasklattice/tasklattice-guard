import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { Activity, ArrowLeft, ArrowUpRight, Ban, Check, ChevronDown, Circle, CircleAlert, FlaskConical, GitCompareArrows, History, LoaderCircle, LockKeyhole, Pencil, Plus, Rocket, RotateCcw, Save, ScrollText, ShieldAlert, ShieldCheck, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { RuntimeHealthAlert } from "@/components/dashboard/runtime-health-alert";
import { RuntimeMetricChart } from "@/components/dashboard/runtime-metric-chart";
import { formatEventTimestamp } from "@/components/dashboard/event-time";
import { AddTestCaseSheet } from "@/components/add-test-case-sheet";
import { CompiledRuntime } from "@/components/compiled-runtime";
import { CopyableChecksum } from "@/components/copyable-checksum";
import { EntitySheet } from "@/components/entity-sheet";
import { formatGuardrailReleaseId, GuardrailVersionComparison, GuardrailVersionNavigator } from "@/components/guardrail-version-workspace";
import { PolicyBindingEditor } from "@/components/policy-binding-editor";
import { ProtectedDeleteSheet } from "@/components/protected-delete-sheet";
import { EmptyState, ErrorNotice, InfoNotice, PageHeader, StateBadge } from "@/components/product-shell";
import { RuntimePostureFields } from "@/components/runtime-posture-fields";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
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
import { useAuth } from "@/lib/auth";
import {
  createValidationRun,
  deleteGuardrail,
  excludeGuardrailTestCase,
  getDeployments,
  getGuardrail,
  getGuardrailDeletionImpact,
  getGuardrailFindings,
  getGuardrailVersion,
  getGuardrails,
  getGuardrailVersions,
  getGuardrailLoggingSettings,
  getMetrics,
  getIntegrations,
  getPolicies,
  getTestCases,
  getValidationRuns,
  publishGuardrail,
  restoreGuardrailTestCase,
  rollbackGuardrail,
  updateGuardrail,
  updateGuardrailLoggingSettings,
  type Guardrail,
  type GuardrailDeletionImpact,
  type GuardrailFindingPage,
  type GuardrailPolicyBinding,
  type GuardrailVersion,
  type GuardrailVersionDetail,
  type MetricWindow,
  type Metrics,
  type LoggingLevel,
  type DeploymentTraceFinding,
  type Integration,
  type Policy,
  type TestCase,
  type ValidationRun,
} from "@/lib/api";
import { CreateGuardrailWizard } from "@/routes/create-guardrail-wizard";
import { CreateDeploymentSheet, TrafficScopeBadges } from "@/routes/deployments";
import { ValidationDetailSheet } from "@/routes/validation";

export { AddTestCaseSheet };

const EMPTY_POLICIES: Policy[] = [];

type GuardrailDeletionConfirmation = {
  reason: string;
  confirm_recent_traffic: boolean;
  confirmation_name?: string;
};

export function GuardrailsPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const auth = useAuth();
  const query = useQuery({ queryKey: queryKeys.guardrails, queryFn: getGuardrails });
  const [createOpen, setCreateOpen] = useState(false);
  const guardrails = [...(query.data?.items ?? [])].sort((left, right) => Number(right.is_default) - Number(left.is_default));

  return (
    <section className="py-6 sm:py-8">
      <PageHeader title={t("pages.guardrails.title")} description={t("guardrails.description")} action={auth.user?.role === "admin" ? <Button className="min-h-11" onClick={() => setCreateOpen(true)}><Plus />{t("guardrails.create")}</Button> : undefined} />
      {query.error ? <div className="mt-5"><ErrorNotice error={query.error} /></div> : null}
      {query.isLoading ? <Skeleton className="mt-5 h-80 rounded-xl" /> : null}
      {!query.isLoading && !guardrails.length ? <div className="mt-5"><EmptyState title={t("guardrails.emptyTitle")} description={t("guardrails.emptyDescription")} action={auth.user?.role === "admin" ? <Button onClick={() => setCreateOpen(true)}><Plus />{t("guardrails.createFirst")}</Button> : undefined} /></div> : null}
      {guardrails.length ? (
        <section className="mt-5 overflow-hidden rounded-xl border bg-card shadow-xs">
          <header className="border-b bg-muted/25 px-5 py-3"><p className="text-xs font-medium text-muted-foreground">{t("guardrails.registry", { count: guardrails.length })}</p></header>
          <Table>
            <TableHeader><TableRow className="hover:bg-transparent"><TableHead className="min-w-64 px-5">{t("guardrails.guardrail")}</TableHead><TableHead>{t("common.status")}</TableHead><TableHead className="hidden md:table-cell">{t("guardrails.policies")}</TableHead><TableHead className="hidden lg:table-cell">{t("guardrails.validation")}</TableHead><TableHead className="hidden xl:table-cell">{t("guardrails.updated")}</TableHead></TableRow></TableHeader>
            <TableBody>{guardrails.map((guardrail) => (
              <TableRow key={guardrail.id} tabIndex={0} className="cursor-pointer focus-visible:outline-2 focus-visible:outline-ring" onClick={() => navigate({ to: "/guardrails/$guardrailId", params: { guardrailId: guardrail.id } })} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") navigate({ to: "/guardrails/$guardrailId", params: { guardrailId: guardrail.id } }); }}>
                <TableCell className="px-5"><span className="flex items-start gap-3"><span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><ShieldCheck className="size-4" /></span><span className="min-w-0"><strong className="block truncate text-sm">{guardrail.name}</strong><span className="mt-1 line-clamp-1 text-xs text-muted-foreground">{guardrail.purpose}</span></span></span></TableCell>
                <TableCell><StateBadge state={guardrail.status} /></TableCell>
                <TableCell className="hidden font-mono text-xs md:table-cell">{guardrail.policy_bindings.length}</TableCell>
                <TableCell className="hidden lg:table-cell">{guardrail.latest_validation_run ? <span className="flex items-center gap-2"><StateBadge state={guardrail.latest_validation_run.status} /><span className="font-mono text-xs text-muted-foreground">{guardrail.latest_validation_run.metrics.compliance_rate}%</span></span> : <span className="text-xs text-muted-foreground">{t("guardrails.notRun")}</span>}</TableCell>
                <TableCell className="hidden text-xs text-muted-foreground xl:table-cell">{new Date(guardrail.updated_at).toLocaleString(i18n.language)}</TableCell>
              </TableRow>
            ))}</TableBody>
          </Table>
        </section>
      ) : null}
      <CreateGuardrailWizard open={createOpen} onOpenChange={setCreateOpen} onCreated={async (id) => { setCreateOpen(false); await queryClient.invalidateQueries({ queryKey: queryKeys.guardrails }); navigate({ to: "/guardrails/$guardrailId", params: { guardrailId: id } }); }} />
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
  const deploymentsQuery = useQuery({ queryKey: queryKeys.deployments, queryFn: getDeployments });
  const integrationsQuery = useQuery({ queryKey: queryKeys.integrations, queryFn: getIntegrations });
  const [section, setSection] = useState("runtime");
  const [window, setWindow] = useState<MetricWindow>("24h");
  const [editOpen, setEditOpen] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [deploymentOpen, setDeploymentOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [selectedValidationRun, setSelectedValidationRun] = useState<ValidationRun | null>(null);
  const [selectedVersionOverride, setSelectedVersionOverride] = useState<number | null>(null);
  const [compareBaseVersionNumber, setCompareBaseVersionNumber] = useState<number | null>(null);
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
  const selectedVersionNumber = selectedVersionOverride && guardrailVersions.some((item) => item.version === selectedVersionOverride) ? selectedVersionOverride : activeVersion?.version ?? guardrailVersions[0]?.version ?? 0;
  const selectedVersion = guardrailVersions.find((item) => item.version === selectedVersionNumber);
  const selectedValidation = validationRunsQuery.data?.items.find((run) => run.guardrail_version === selectedVersionNumber && run.status === "passed") ?? null;
  const compareOptions = guardrailVersions.filter((item) => item.version < selectedVersionNumber);
  const immutableQuery = useQuery({
    queryKey: queryKeys.guardrailVersion(guardrailId, selectedVersionNumber),
    queryFn: () => getGuardrailVersion(guardrailId, selectedVersionNumber),
    enabled: selectedVersionNumber > 0,
  });
  const compareQuery = useQuery({
    queryKey: queryKeys.guardrailVersion(guardrailId, compareBaseVersionNumber ?? 0),
    queryFn: () => getGuardrailVersion(guardrailId, compareBaseVersionNumber ?? 0),
    enabled: Boolean(compareBaseVersionNumber),
  });
  const metricsQuery = useQuery({
    queryKey: queryKeys.metricsScope({ guardrailId, window }),
    queryFn: () => getMetrics({ guardrailId, window }),
  });
  const findingsQuery = useQuery({
    queryKey: queryKeys.guardrailFindings(guardrailId, window),
    queryFn: () => getGuardrailFindings(guardrailId, window),
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
        queryClient.invalidateQueries({ queryKey: queryKeys.deployments }),
        queryClient.invalidateQueries({ queryKey: queryKeys.metrics }),
        queryClient.invalidateQueries({ queryKey: queryKeys.evidence }),
      ]);
      navigate({ to: "/guardrails" });
    },
    onError: async () => { await deletionImpactQuery.refetch(); },
  });
  const validationMutation = useMutation({
    mutationFn: () => createValidationRun(guardrailId),
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

  if (guardrailQuery.isLoading) return <Skeleton className="mt-8 h-[34rem] rounded-xl" />;
  if (guardrailQuery.error || !guardrailQuery.data) return <div className="py-8"><ErrorNotice error={guardrailQuery.error ?? new Error(t("guardrails.notFound"))} /></div>;
  const guardrail = guardrailQuery.data;
  const policies = policiesQuery.data?.items ?? EMPTY_POLICIES;
  const deployments = deploymentsQuery.data?.items.filter((item) => item.guardrail_id === guardrail.id) ?? [];
  const canManageDraft = auth.user?.role === "admin" && isGuardrailDraftManageable(guardrail);
  const hasUnpublishedDraft = canManageDraft && !guardrail.published_current;

  return (
    <section className="py-6 sm:py-8">
      <Link to="/guardrails" className="inline-flex min-h-11 items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" />{t("guardrails.back")}</Link>
      <div className="mt-3 flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-display text-2xl font-semibold tracking-[-0.015em] sm:text-3xl">{guardrail.name}</h1>
            {activeVersion ? <Badge className="border-emerald-200 bg-emerald-50 font-mono text-[11px] text-emerald-700 hover:bg-emerald-50">{t("guardrails.activeVersion", { version: formatGuardrailReleaseId(activeVersion.created_at) })}</Badge> : <StateBadge state={guardrail.tested_current ? "ready" : "needs_validation"} />}
            {deployments.length ? <StateBadge state="protected" /> : activeVersion ? <StateBadge state="ready" /> : null}
            {guardrail.is_default ? <Badge variant="outline">{t("guardrails.defaultBadge")}</Badge> : guardrail.system_managed ? <Badge variant="outline">{t("guardrails.systemManaged")}</Badge> : null}
          </div>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">{guardrail.purpose}</p>
          {hasUnpublishedDraft ? <button type="button" className="mt-3 inline-flex min-h-9 items-center gap-2 rounded-md bg-amber-50 px-3 text-xs font-medium text-amber-800 hover:bg-amber-100 focus-visible:outline-2 focus-visible:outline-ring" onClick={() => setSection("draft")}><Circle className="size-2.5 fill-current" />{t("guardrails.unpublishedDraft")}</button> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {canManageDraft ? <Button asChild className="min-h-11" variant="outline"><Link to="/playground" search={{ guardrail: guardrail.id, target: "draft", version: undefined }}><FlaskConical />{t("guardrails.testDraft")}</Link></Button> : null}
          {canManageDraft ? <Button className="min-h-11" variant="outline" onClick={() => setEditOpen(true)}><Pencil />{t("common.edit")}</Button> : null}
          {auth.user?.role === "admin" && !guardrail.is_default ? <Button className="min-h-11 text-destructive hover:bg-destructive/10 hover:text-destructive" variant="outline" onClick={() => {
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
            <TabsTrigger value="draft"><span className="flex items-center gap-2">{t("guardrails.draftReleaseTab")}{hasUnpublishedDraft ? <Circle className="size-2 fill-amber-500 text-amber-500" /> : null}</span></TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="runtime" className="pt-5">
          <GuardrailRuntimeView guardrailId={guardrail.id} metrics={metricsQuery.data} loading={metricsQuery.isLoading} error={metricsQuery.error} deployments={deployments} versions={guardrailVersions} window={window} onWindowChange={setWindow} />
        </TabsContent>
        <TabsContent value="findings" className="pt-5">
          <GuardrailFindingsView data={findingsQuery.data} loading={findingsQuery.isLoading} error={findingsQuery.error} policies={policies} deployments={deployments} integrations={integrationsQuery.data?.items ?? []} window={window} onWindowChange={setWindow} />
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
        <TabsContent value="draft" className="pt-5">
          <DraftReleaseView guardrail={guardrail} policies={policies} cases={testsQuery.data?.items ?? []} casesLoading={testsQuery.isLoading} activeVersion={activeVersion} versions={guardrailVersions} deployments={deployments} canManage={canManageDraft} validationRunning={validationMutation.isPending} onRunValidation={() => validationMutation.mutate()} onOpenValidation={setSelectedValidationRun} onEdit={() => setEditOpen(true)} onAddCase={() => setTestOpen(true)} onCreateDeployment={() => setDeploymentOpen(true)} onChanged={refresh} />
        </TabsContent>
      </Tabs>

      <EditGuardrailSheet guardrail={guardrail} policies={policies} open={editOpen} onOpenChange={setEditOpen} onSaved={async () => { setEditOpen(false); await refresh(); }} />
      <AddTestCaseSheet guardrail={guardrail} open={testOpen} onOpenChange={setTestOpen} onCreated={async () => { setTestOpen(false); await refresh(); }} />
      <ValidationDetailSheet run={selectedValidationRun} guardrail={guardrail} canManage={canManageDraft} running={validationMutation.isPending} onRunAgain={() => validationMutation.mutate()} onClose={() => setSelectedValidationRun(null)} />
      <CreateDeploymentSheet open={deploymentOpen} onOpenChange={setDeploymentOpen} guardrails={[guardrail]} onCreated={async () => { setDeploymentOpen(false); await refresh(); }} />
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

export function DeleteGuardrailSheet({ guardrail, open, impact, loading, deleting, error, onOpenChange, onRetry, onConfirm }: {
  guardrail: Guardrail;
  open: boolean;
  impact?: GuardrailDeletionImpact;
  loading: boolean;
  deleting: boolean;
  error: Error | null;
  onOpenChange: (open: boolean) => void;
  onRetry: () => void;
  onConfirm: (confirmation: GuardrailDeletionConfirmation) => void;
}) {
  const { t, i18n } = useTranslation();
  const [reason, setReason] = useState("");
  const telemetryFresh = Boolean(impact?.telemetry_fresh);
  const requiresSecondConfirmation = Boolean(impact?.requires_second_confirmation);

  useEffect(() => {
    if (!open) setReason("");
  }, [open]);

  return <ProtectedDeleteSheet
    open={open}
    onOpenChange={onOpenChange}
    entityName={guardrail.name}
    loading={loading}
    ready={telemetryFresh}
    deleting={deleting}
    error={impact && !telemetryFresh ? new Error(t("guardrails.deleteTelemetryStale")) : error}
    requiresConfirmation={requiresSecondConfirmation}
    impactItems={impact ? [
      { label: t("guardrails.recentIncomingRequests", { minutes: impact.window_minutes }), value: impact.incoming_request_count.toLocaleString(i18n.language) },
      { label: t("guardrails.activeDeploymentsAffected"), value: impact.active_deployment_count.toLocaleString(i18n.language) },
    ] : []}
    copy={{
      eyebrow: t("guardrails.deleteEyebrow"),
      title: t("guardrails.deleteDialogTitle"),
      description: t("guardrails.deleteDialogDescription", { name: guardrail.name }),
      protectedMessage: t("guardrails.recentTrafficWarning"),
      clearMessage: t("guardrails.noRecentTraffic"),
      retentionNote: t("guardrails.deleteRetentionNote"),
      continueLabel: t("guardrails.continueDelete"),
      deleteLabel: t("guardrails.deleteConfirm"),
      deletingLabel: t("guardrails.deleting"),
      confirmTitle: t("guardrails.deleteRecentTrafficTitle"),
      confirmDescription: t("guardrails.deleteRecentTrafficDescription", { count: impact?.incoming_request_count ?? 0, minutes: impact?.window_minutes ?? 30 }),
      confirmWarning: t("guardrails.deleteStopsTraffic", { count: impact?.active_deployment_count ?? 0 }),
      typeNameLabel: t("guardrails.typeNameToConfirm", { name: guardrail.name }),
      protectedDeleteLabel: t("guardrails.deleteDespiteTraffic"),
      cancelLabel: t("common.cancel"),
      backLabel: t("common.back"),
      retryLabel: t("common.retry"),
      reasonLabel: t("guardrails.deleteReason"),
      reasonPlaceholder: t("guardrails.deleteReasonPlaceholder"),
    }}
    reason={reason}
    onReasonChange={setReason}
    onRetry={onRetry}
    onConfirm={(confirmRecentTraffic, confirmationName) => onConfirm({
      reason: reason.trim(),
      confirm_recent_traffic: confirmRecentTraffic,
      ...(confirmationName ? { confirmation_name: confirmationName } : {}),
    })}
  />;
}

export function GuardrailRuntimeView({ guardrailId, metrics, loading, error, deployments, versions = [], window, onWindowChange }: { guardrailId: string; metrics?: Metrics; loading: boolean; error: unknown; deployments: Awaited<ReturnType<typeof getDeployments>>["items"]; versions?: GuardrailVersion[]; window: MetricWindow; onWindowChange: (window: MetricWindow) => void }) {
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
      <CallerDistribution metrics={metrics} deployments={deployments} versions={versions} />
    </div>
  );
}

type GuardrailFindingSeverityFilter = "all" | DeploymentTraceFinding["severity"];

export function GuardrailFindingsView({ data, loading, error, policies, deployments, integrations, window, onWindowChange }: { data?: GuardrailFindingPage; loading: boolean; error: unknown; policies: Policy[]; deployments: Awaited<ReturnType<typeof getDeployments>>["items"]; integrations: Integration[]; window: MetricWindow; onWindowChange: (window: MetricWindow) => void }) {
  const { t, i18n } = useTranslation();
  const [severity, setSeverity] = useState<GuardrailFindingSeverityFilter>("all");
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
      <FindingStat label={t("deploymentDetail.severity.critical")} value={summary?.critical ?? 0} danger={Boolean(summary?.critical)} />
      <FindingStat label={t("deploymentDetail.severity.high")} value={summary?.high ?? 0} />
      <FindingStat label={t("deploymentDetail.severity.medium")} value={summary?.medium ?? 0} />
      <FindingStat label={t("deploymentDetail.severity.low")} value={summary?.low ?? 0} />
      <FindingStat label={t("guardrails.affectedInteractions")} value={summary?.affected_traces ?? 0} />
    </dl>

    <Card className="shadow-none">
      <CardHeader className="border-b">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="flex items-start gap-3"><span className="grid size-9 shrink-0 place-items-center rounded-lg bg-red-50 text-red-700"><ShieldAlert className="size-4" /></span><div><CardTitle>{t("guardrails.findings")}</CardTitle><CardDescription className="mt-1 max-w-2xl leading-5">{t("guardrails.findingsPrivacy")}</CardDescription></div></div>
          <div className="grid w-full grid-cols-2 gap-1 rounded-lg border bg-background p-1 sm:grid-cols-5 xl:w-auto" role="group" aria-label={t("guardrails.filterSeverity")}>{filters.map((filter) => <Button key={filter} type="button" size="sm" variant={severity === filter ? "secondary" : "ghost"} className="min-h-10 w-full gap-1 px-2.5" aria-pressed={severity === filter} onClick={() => setSeverity(filter)}><span>{filter === "all" ? t("guardrails.allSeverities") : t(`deploymentDetail.severity.${filter}`)}</span><span className="font-mono text-[10px] text-muted-foreground">{counts[filter]}</span></Button>)}</div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? <Skeleton className="m-4 h-56 rounded-lg" /> : error ? <div className="p-4"><ErrorNotice error={error} /></div> : visibleFindings.length ? <div className="divide-y">{visibleFindings.map((finding) => {
          const timestamp = formatEventTimestamp(finding.created_at, i18n.language);
          const deployment = deployments.find((item) => item.id === finding.deployment_id);
          const integration = integrations.find((item) => item.id === finding.integration_id);
          const source = deployment?.name ?? integration?.name ?? (finding.protocol === "playground" ? t("guardrails.playgroundSource") : finding.protocol?.toUpperCase()) ?? t("guardrails.directRuntimeSource");
          return <article key={finding.id} className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-5">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2"><GuardrailSeverityBadge severity={finding.severity} /><strong className="text-sm">{guardrailFindingTitle(finding, policies)}</strong></div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">{finding.detail}</p>
              <p className="mt-2 break-all font-mono text-[11px] text-muted-foreground">{finding.policy_id ?? "—"}{finding.rule_id ? ` · ${finding.rule_id}` : ""}</p>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"><span>{t("guardrails.sourceLabel")}: <strong className="font-medium text-foreground">{source}</strong></span><span>{t("guardrails.versionLabel")}: <code>v{finding.guardrail_version ?? "—"}</code></span><span>{t("guardrails.phaseLabel")}: <code>{finding.phase}</code></span><span>{t("guardrails.confidenceLabel")}: <code>{Math.round(finding.confidence * 100)}%</code></span></div>
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
function GuardrailSeverityBadge({ severity }: { severity: DeploymentTraceFinding["severity"] }) { const { t } = useTranslation(); const classes = { critical: "border-red-200 bg-red-50 text-red-700", high: "border-orange-200 bg-orange-50 text-orange-700", medium: "border-amber-200 bg-amber-50 text-amber-700", low: "border-slate-200 bg-slate-50 text-slate-700" }[severity]; return <Badge variant="outline" className={classes}>{t(`deploymentDetail.severity.${severity}`)}</Badge>; }
function guardrailFindingTitle(finding: DeploymentTraceFinding, policies: Policy[]) { const policy = policies.find((item) => item.id === finding.policy_id); const rule = policy?.rules.find((item) => item.id === finding.rule_id); return rule?.name ?? policy?.name ?? finding.rule_id ?? finding.risk.replaceAll("_", " "); }

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
        queryClient.invalidateQueries({ queryKey: queryKeys.evidence }),
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
    if (level === "info") mutation.mutate({ level, acknowledge: false });
    else { setAcknowledged(false); setPendingLevel(level); }
  };
  return <>
    <Card size="sm" className={`gap-0 overflow-hidden py-0 shadow-none ${elevated ? "border-amber-200" : ""}`}>
      <div className={`flex flex-col gap-4 px-4 py-4 lg:flex-row lg:items-center lg:justify-between ${elevated ? "bg-amber-50/60" : ""}`}>
        <div className="flex min-w-0 items-start gap-3"><span className={`grid size-9 shrink-0 place-items-center rounded-lg ${elevated ? "bg-amber-100 text-amber-800" : "bg-primary/10 text-primary"}`}><ScrollText className="size-4" /></span><div><div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold">{t("guardrails.loggingTitle")}</h3><Badge variant="outline" className={elevated ? "border-amber-300 bg-amber-100 text-amber-900" : ""}>{settings.level.toUpperCase()}</Badge></div><p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">{t(`guardrails.loggingLevels.${settings.level}.description`)}</p><p className="mt-1 text-[11px] text-muted-foreground">{t("guardrails.loggingRetention", { days: settings.retention_days, time: new Date(settings.updated_at).toLocaleString(i18n.language) })}</p></div></div>
        <div className="w-full shrink-0 lg:w-48"><Label htmlFor={`logging-level-${guardrailId}`} className="sr-only">{t("guardrails.loggingLevel")}</Label><Select value={settings.level} disabled={auth.user?.role !== "admin" || mutation.isPending} onValueChange={(value) => onLevelChange(value as LoggingLevel)}><SelectTrigger id={`logging-level-${guardrailId}`} className="min-h-11 bg-card"><SelectValue /></SelectTrigger><SelectContent>{(["info", "debug", "trace"] as LoggingLevel[]).map((level) => <SelectItem key={level} value={level}><span className="flex items-center gap-2"><span className={`size-1.5 rounded-full ${level === "info" ? "bg-emerald-500" : "bg-amber-500"}`} />{level.toUpperCase()}</span></SelectItem>)}</SelectContent></Select>{auth.user?.role !== "admin" ? <p className="mt-1.5 text-[11px] text-muted-foreground">{t("guardrails.loggingAdminOnly")}</p> : null}</div>
      </div>
      {!settings.content_capture_enabled ? <div className="flex gap-2 border-t border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900"><CircleAlert className="mt-0.5 size-4 shrink-0" /><span>{t("guardrails.loggingEncryptionMissing")}</span></div> : elevated ? <div className="flex gap-2 border-t border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900"><CircleAlert className="mt-0.5 size-4 shrink-0" /><span>{t("guardrails.loggingElevatedActive")}</span></div> : null}
    </Card>

    <AlertDialog open={Boolean(pendingLevel)} onOpenChange={(open) => { if (!open && !mutation.isPending) { setPendingLevel(null); setAcknowledged(false); } }}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>{t("guardrails.loggingConfirmTitle", { level: pendingLevel?.toUpperCase() })}</AlertDialogTitle><AlertDialogDescription>{t("guardrails.loggingConfirmDescription", { level: pendingLevel?.toUpperCase() })}</AlertDialogDescription></AlertDialogHeader>
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-xs leading-5 text-amber-950"><ul className="list-disc space-y-1 pl-4"><li>{t("guardrails.loggingCostWrite")}</li><li>{t("guardrails.loggingCostSensitive")}</li>{pendingLevel === "trace" ? <li>{t("guardrails.loggingCostApproved")}</li> : null}</ul></div>
        <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3"><Checkbox checked={acknowledged} onCheckedChange={(value) => setAcknowledged(Boolean(value))} /><span className="text-xs leading-5">{t("guardrails.loggingAcknowledge")}</span></label>
        <AlertDialogFooter><AlertDialogCancel asChild><Button variant="outline" disabled={mutation.isPending}>{t("common.cancel")}</Button></AlertDialogCancel><Button disabled={!acknowledged || !pendingLevel || mutation.isPending} onClick={() => { if (pendingLevel) mutation.mutate({ level: pendingLevel, acknowledge: true }); }}>{mutation.isPending ? <LoaderCircle className="animate-spin" /> : <ScrollText />}{t("guardrails.enableLoggingLevel", { level: pendingLevel?.toUpperCase() })}</Button></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}

function RuntimeStat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="min-h-20 border-b px-4 py-3 last:border-b-0 sm:odd:border-r sm:[&:nth-child(3)]:border-b-0 xl:border-b-0 xl:border-r xl:odd:border-r xl:last:border-r-0"><dt className="text-xs font-medium text-muted-foreground">{label}</dt><dd className="mt-1 text-xl font-semibold tabular-nums">{value}</dd><p className="mt-1 text-xs text-muted-foreground">{detail}</p></div>;
}

function CallerDistribution({ metrics, deployments, versions }: { metrics: Metrics; deployments: Awaited<ReturnType<typeof getDeployments>>["items"]; versions: GuardrailVersion[] }) {
  const { t, i18n } = useTranslation();
  return <Card size="sm" className="gap-0 overflow-hidden py-0 shadow-none"><CardHeader className="border-b px-4 py-3"><CardTitle className="text-sm">{t("guardrails.callersTitle")}</CardTitle><CardDescription className="text-xs leading-5">{t("guardrails.callersDescription")}</CardDescription></CardHeader>{metrics.caller_distribution.length ? <Table className="text-xs"><TableHeader><TableRow className="hover:bg-transparent"><TableHead className="h-9 pl-4">{t("guardrails.caller")}</TableHead><TableHead className="h-9">{t("guardrails.trafficScope")}</TableHead><TableHead className="h-9">{t("guardrails.volumeShare")}</TableHead><TableHead className="h-9">{t("guardrails.servedVersion")}</TableHead><TableHead className="h-9">{t("guardrails.outcome")}</TableHead><TableHead className="h-9">{t("dashboard.p95Latency")}</TableHead></TableRow></TableHeader><TableBody>{metrics.caller_distribution.map((item) => { const deployment = deployments.find((candidate) => candidate.id === item.deployment_id); return <TableRow key={`${item.integration_id}:${item.deployment_id}:${item.protocol}`}><TableCell className="py-2.5 pl-4 align-top"><strong className="text-sm font-medium">{item.integration_name}</strong><p className="mt-0.5 font-mono text-xs text-muted-foreground">{item.protocol}</p></TableCell><TableCell className="max-w-80 py-2.5 align-top"><p className="mb-1 text-xs font-medium">{item.deployment_name}</p>{deployment ? <TrafficScopeBadges deployment={deployment} /> : <span className="text-xs text-muted-foreground">{t("guardrails.unassignedTraffic")}</span>}</TableCell><TableCell className="py-2.5 align-top"><strong className="text-sm tabular-nums">{item.requests.toLocaleString(i18n.language)}</strong><div className="mt-1.5 flex items-center gap-2"><Progress className="h-1 w-16" value={item.share} /><span className="text-xs text-muted-foreground">{item.share}%</span></div></TableCell><TableCell className="py-2.5 align-top"><div className="flex flex-wrap gap-1">{item.guardrail_versions.map((versionNumber) => { const matched = versions.find((candidate) => candidate.version === versionNumber); return <Badge key={versionNumber} variant="outline" className="font-mono text-[10px]">{matched ? formatGuardrailReleaseId(matched.created_at) : versionNumber}</Badge>; })}</div></TableCell><TableCell className="py-2.5 align-top"><p className="text-xs">{t("guardrails.interventionSummary", { rate: item.intervention_rate })}</p><p className="mt-0.5 text-xs text-muted-foreground">{t("guardrails.errorSummary", { rate: item.error_rate })}</p></TableCell><TableCell className="py-2.5 align-top font-mono text-xs">{item.p95_latency_ms} ms</TableCell></TableRow>; })}</TableBody></Table> : <div className="px-4 pb-4"><EmptyState title={t("guardrails.noRuntimeCalls")} description={t("guardrails.noRuntimeCallsDescription")} /></div>}</Card>;
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
  onSelectVersion: (version: number) => void;
  onStartCompare: () => void;
  onCompareBaseChange: (version: number) => void;
  onCloseCompare: () => void;
}) {
  const { t, i18n } = useTranslation();
  const auth = useAuth();
  const rollback = useMutation({ mutationFn: (version: number) => rollbackGuardrail(guardrailId, version), onSuccess: async () => { toast.success(t("guardrails.rollbackSucceeded")); await onChanged(); }, onError: (error) => notifyError(error, t("guardrails.operationFailed")) });
  if (loading) return <Skeleton className="h-[34rem] rounded-xl" />;
  if (!selectedVersion || !detail) return <EmptyState title={t("guardrails.noActiveVersion")} description={t("guardrails.noActiveVersionDescription")} action={<Button onClick={onOpenDraft}>{t("guardrails.openDraftRelease")}</Button>} />;
  const releaseId = formatGuardrailReleaseId(detail.created_at);
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
  return <div className="grid min-w-0 gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
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
                {auth.user?.role === "admin" && !selectedVersion.active ? <Button variant="outline" className="min-h-11" disabled={rollback.isPending} onClick={() => rollback.mutate(selectedVersion.version)}>{rollback.isPending ? <LoaderCircle className="animate-spin" /> : <History />}{t("guardrails.rollback")}</Button> : null}
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
  </div>;
}

function VersionFact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) { return <div className="min-w-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className={`${mono ? "font-mono text-xs" : "text-sm font-medium"} mt-1.5 truncate`} title={value}>{value}</dd></div>; }

function ImmutablePosture({ detail }: { detail: GuardrailVersionDetail }) { const { t } = useTranslation(); return <section className="rounded-lg border p-4"><h3 className="text-sm font-semibold">{t("guardrails.decisionPosture")}</h3><dl className="mt-4 grid gap-4 sm:grid-cols-2"><VersionFact label={t("guardrailWizard.safetyLevel")} value={t(`guardrailWizard.safetyLevelOptions.${detail.safety_level}`)} /><VersionFact label={t("guardrailWizard.outputDelivery")} value={t(`guardrailWizard.outputDeliveryOptions.${detail.output_delivery}`)} /><VersionFact label={t("guardrails.colangVersion")} value={detail.colang_version} /><VersionFact label={t("guardrails.criticalPath")} value={`${detail.estimated_critical_path_ms} ms`} /></dl></section>; }

function PinnedPolicies({ bindings }: { bindings: GuardrailVersionDetail["policy_bindings"] }) { const { t } = useTranslation(); return <section className="rounded-lg border p-4"><h3 className="text-sm font-semibold">{t("guardrails.pinnedPolicies")}</h3><div className="mt-3 divide-y">{bindings.map((binding) => <div key={`${binding.policy_id}@${binding.policy_version}`} className="py-3 first:pt-0 last:pb-0"><div className="flex flex-wrap items-center justify-between gap-2"><code className="text-xs">{binding.policy_id}@{binding.policy_version}</code><Badge variant="outline">{binding.action ?? t("guardrails.policyBehavior")}</Badge></div><p className="mt-2 text-xs text-muted-foreground">{t("guardrails.pinnedPolicyRules", { count: binding.enabled_rule_ids.length })}</p></div>)}</div></section>; }

export function DraftReleaseView({ guardrail, policies, cases, casesLoading, activeVersion, versions, deployments, canManage, validationRunning = false, onRunValidation = () => undefined, onOpenValidation = () => undefined, onEdit, onAddCase, onCreateDeployment, onChanged }: { guardrail: Guardrail; policies: Policy[]; cases: TestCase[]; casesLoading: boolean; activeVersion?: GuardrailVersion; versions?: GuardrailVersion[]; deployments: Awaited<ReturnType<typeof getDeployments>>["items"]; canManage?: boolean; validationRunning?: boolean; onRunValidation?: () => void; onOpenValidation?: (run: ValidationRun) => void; onEdit: () => void; onAddCase: () => void; onCreateDeployment: () => void; onChanged: () => Promise<void> }) {
  const { t } = useTranslation();
  const releaseId = activeVersion ? formatGuardrailReleaseId(activeVersion.created_at) : "";
  const draftConfigured = Boolean(guardrail.purpose && guardrail.policy_bindings.length);
  const validated = guardrail.tested_current;
  const published = guardrail.published_current;
  const currentRelease = versions?.find((item) => item.source_draft_version === guardrail.draft_revision);
  const compiling = currentRelease?.compile_status === "compiling";
  const compileFailed = currentRelease?.compile_status === "failed";
  const publish = useMutation({
    mutationFn: () => publishGuardrail(guardrail.id),
    onSuccess: async (version) => {
      toast.success(t("guardrails.publishSucceeded", { version: formatGuardrailReleaseId(version.created_at) }));
      await onChanged();
    },
    onError: (error) => notifyError(error, t("guardrails.publishFailed")),
  });
  const validationScope = useMutation({
    mutationFn: ({ caseId, action }: { caseId: string; action: "exclude" | "restore" }) => action === "exclude" ? excludeGuardrailTestCase(guardrail.id, caseId) : restoreGuardrailTestCase(guardrail.id, caseId),
    onSuccess: async (_, variables) => {
      toast.success(t(variables.action === "exclude" ? "guardrails.testCaseExcluded" : "guardrails.testCaseRestored"));
      await onChanged();
    },
    onError: (error) => notifyError(error, t("guardrails.operationFailed")),
  });
  const steps = [
    { label: t("guardrails.releaseStepDraft"), complete: draftConfigured, current: !draftConfigured, detail: t("guardrails.policyCheckDetail", { count: guardrail.policy_bindings.length }) },
    { label: validated ? t("guardrails.flowValidationPassed") : t("guardrails.flowValidationRequired"), complete: validated, current: draftConfigured && !validated, detail: validated && guardrail.latest_validation_run ? t("guardrails.validationEvidenceDetail", { rate: guardrail.latest_validation_run.metrics.compliance_rate }) : guardrail.latest_validation_run?.status === "failed" ? t("guardrails.lastValidationFailedDetail", { rate: guardrail.latest_validation_run.metrics.compliance_rate }) : guardrail.latest_validation_run ? t("guardrails.validationEvidenceStale") : t("guardrails.noValidationEvidence") },
    { label: published ? t("guardrails.releaseStepPublished") : compiling ? t("guardrails.releaseStepCompiling") : compileFailed ? t("guardrails.releaseStepCompileFailed") : t("guardrails.releaseStepPublish"), complete: published, current: validated && !published, detail: published && releaseId ? t("guardrails.publishedVersionDetail", { version: releaseId }) : compiling ? t("guardrails.compilationPendingDetail") : compileFailed ? (currentRelease?.failure_reason ?? t("guardrails.compilationFailedDetail")) : t("guardrails.publishStepDetail") },
  ];
  const stateTitle = published ? t("guardrails.releasePublished") : compiling ? t("guardrails.releaseCompiling") : compileFailed ? t("guardrails.releaseCompileFailed") : validated ? t("guardrails.releaseReadyToPublish") : t("guardrails.releaseNeedsValidation");
  const stateDescription = published ? t("guardrails.releasePublishedDescription") : compiling ? t("guardrails.releaseCompilingDescription") : compileFailed ? t("guardrails.releaseCompileFailedDescription") : validated ? t("guardrails.releaseReadyToPublishDescription") : t("guardrails.releaseNeedsValidationDescription");
  const canManageDraft = canManage ?? isGuardrailDraftManageable(guardrail);

  return <div className="space-y-5">
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
              <span className="min-w-0"><span className="block text-sm font-medium">{step.label}</span><span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{step.detail}</span></span>
            </li>)}
          </ol>
          <aside className="border-t bg-muted/20 p-5 lg:border-t-0 lg:border-l">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("guardrails.currentReleaseState")}</p>
            <h3 className="mt-2 text-base font-semibold">{stateTitle}</h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{stateDescription}</p>
            <div className="mt-4 grid gap-2">
              {canManageDraft && !validated ? <Button className="min-h-11" disabled={validationRunning} onClick={onRunValidation}>{validationRunning ? <LoaderCircle className="animate-spin" /> : <FlaskConical />}{t(validationRunning ? "guardrails.runningValidation" : "guardrails.runReviewed")}</Button> : null}
              {canManageDraft && validated && !published && !compiling ? <Button className="min-h-11" disabled={publish.isPending} onClick={() => publish.mutate()}>{publish.isPending ? <LoaderCircle className="animate-spin" /> : compileFailed ? <RotateCcw /> : <ShieldCheck />}{t(publish.isPending ? "guardrails.requestingCompilation" : compileFailed ? "guardrails.retryCompilation" : "guardrails.publishVersion")}</Button> : null}
              {canManageDraft && published && !guardrail.is_default ? <Button className="min-h-11" onClick={onCreateDeployment}><Rocket />{t("guardrails.createDeployment")}</Button> : null}
              {canManageDraft ? <Button className="min-h-11" variant="outline" onClick={onEdit}><Pencil />{t("common.edit")}</Button> : null}
              {validated && guardrail.latest_validation_run ? <Button className="min-h-11" variant="outline" onClick={() => onOpenValidation(guardrail.latest_validation_run!)}><FlaskConical />{t("guardrails.openValidation")}</Button> : null}
            </div>
          </aside>
        </div>
      </CardContent>
    </Card>

    <section>
      <div className="mb-3"><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("guardrails.releaseInputEyebrow")}</p><h2 className="mt-1 text-base font-semibold">{t("guardrails.draftConfiguration")}</h2><p className="mt-1 text-xs text-muted-foreground">{t("guardrails.draftConfigurationDescription")}</p></div>
      <PolicyBindings bindings={guardrail.policy_bindings} policies={policies} />
    </section>
    <section>
      <div className="mb-3"><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("guardrails.releaseEvidenceEyebrow")}</p><h2 className="mt-1 text-base font-semibold">{t("guardrails.validationInputs")}</h2><p className="mt-1 text-xs text-muted-foreground">{t("guardrails.validationInputsDescription")}</p></div>
      <TestCases cases={cases} bindings={guardrail.policy_bindings} policies={policies} loading={casesLoading} onAdd={onAddCase} onExclude={(caseId) => validationScope.mutate({ caseId, action: "exclude" })} onRestore={(caseId) => validationScope.mutate({ caseId, action: "restore" })} busyCaseId={validationScope.isPending ? validationScope.variables?.caseId : undefined} />
    </section>
    {deployments.length ? <Card className="shadow-none"><CardHeader className="py-4"><CardTitle>{t("guardrails.guardrailDeployments")}</CardTitle><CardDescription>{t("guardrails.guardrailDeploymentsDescription")}</CardDescription></CardHeader><CardContent className="space-y-2">{deployments.map((deployment) => <div key={deployment.id} className="rounded-lg border px-4 py-3"><div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-sm font-medium">{deployment.name}</strong><Badge variant="outline" className="font-mono text-[10px]">v{deployment.guardrail_version}</Badge></div><div className="mt-2"><TrafficScopeBadges deployment={deployment} /></div></div>)}</CardContent></Card> : null}
  </div>;
}

function PolicyBindings({ bindings, policies }: { bindings: GuardrailPolicyBinding[]; policies: Policy[] }) {
  const { t } = useTranslation();
  return bindings.length ? <div className="grid gap-3 lg:grid-cols-2">{bindings.map((binding) => {
    const policy = policies.find((item) => item.id === binding.policy_id);
    const name = policy?.name ?? binding.policy_id;
    const enabledRuleCount = binding.enabled_rule_ids.length || policy?.rules.length || 0;
    return <Link
      key={`${binding.policy_id}@${binding.policy_version}`}
      to="/policy-library"
      search={{ policy: binding.policy_id }}
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
    const policy = policies.find((item) => item.id === binding.policy_id);
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
          {group.kind === "guardrail" ? <div className="px-4 py-4 pl-15"><Button className="min-h-11" size="sm" variant="outline" onClick={onAdd}><Plus />{t("guardrails.addTestCase")}</Button></div> : null}
        </div>
      </details>;
    })}</div>
  </section>;
}

function EditGuardrailSheet({ guardrail, policies, open, onOpenChange, onSaved }: { guardrail: Guardrail; policies: Policy[]; open: boolean; onOpenChange: (open: boolean) => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState(guardrail.name);
  const [purpose, setPurpose] = useState(guardrail.purpose);
  const [customRules, setCustomRules] = useState(() => customRuleRowsFromGuardrail(guardrail));
  const [allowed, setAllowed] = useState(guardrail.allowed_topics.join("\n"));
  const [restricted, setRestricted] = useState(guardrail.restricted_topics.join("\n"));
  const [bindings, setBindings] = useState(guardrail.policy_bindings);
  const [level, setLevel] = useState(guardrail.safety_level);
  const [delivery, setDelivery] = useState(guardrail.output_delivery);
  useEffect(() => {
    if (open) {
      setName(guardrail.name);
      setPurpose(guardrail.purpose);
      setCustomRules(customRuleRowsFromGuardrail(guardrail));
      setAllowed(guardrail.allowed_topics.join("\n"));
      setRestricted(guardrail.restricted_topics.join("\n"));
      setBindings(guardrail.policy_bindings);
      setLevel(guardrail.safety_level);
      setDelivery(guardrail.output_delivery);
    }
  }, [guardrail, open]);
  const mutation = useMutation({
    mutationFn: () => updateGuardrail(guardrail.id, {
      name,
      purpose,
      custom_content_rules: customRulesToDraft(customRules),
      allowed_topics: lines(allowed),
      restricted_topics: lines(restricted),
      policy_bindings: bindings,
      safety_level: level,
      output_delivery: delivery,
    }),
    onSuccess: () => { toast.success(t("guardrails.updated")); onSaved(); },
    onError: (error) => notifyError(error, t("guardrails.operationFailed")),
  });
  return <EntitySheet open={open} onOpenChange={onOpenChange} eyebrow={t("guardrails.editEyebrow")} title={t("guardrails.editTitle", { name: guardrail.name })} description={t("guardrails.editDescription")} width="xl" footer={<><Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button><Button disabled={!name.trim() || !purpose.trim() || !bindings.length || mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? <LoaderCircle className="animate-spin" /> : <Save />}{t(mutation.isPending ? "common.saving" : "common.save")}</Button></>}>
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5">
      <Field label={t("guardrails.guardrailName")}><Input className="min-h-11" value={name} onChange={(event) => setName(event.target.value)} /></Field>
      <Field label={t("guardrails.businessPurpose")}><Textarea className="min-h-28" value={purpose} onChange={(event) => setPurpose(event.target.value)} /></Field>
      <section className="rounded-xl border bg-card p-4">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">Custom phrase rules</h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">Use deterministic input rules for exact phrases. `Transform` replaces the matched phrase; `Block` rejects the request when the phrase appears.</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setCustomRules((current) => [...current, blankCustomRuleRow(current.length + 1)])}>Add rule</Button>
        </div>
        <div className="space-y-3">
          {customRules.map((rule, index) => (
            <div key={rule.id} className="grid gap-3 rounded-lg border bg-muted/15 p-3 sm:grid-cols-[minmax(0,1.2fr)_140px_minmax(0,1fr)_auto]">
              <Field label="Match phrase">
                <Input className="min-h-11" value={rule.phrase} onChange={(event) => setCustomRules((current) => replaceCustomRule(current, index, { ...rule, phrase: event.target.value }))} />
              </Field>
              <Field label="Action">
                <Select value={rule.mode} onValueChange={(value) => setCustomRules((current) => replaceCustomRule(current, index, { ...rule, mode: value as "transform" | "block" }))}>
                  <SelectTrigger className="min-h-11"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="transform">Transform</SelectItem><SelectItem value="block">Block</SelectItem></SelectContent>
                </Select>
              </Field>
              <Field label="Replacement">
                <Input className="min-h-11" disabled={rule.mode !== "transform"} value={rule.replacement} onChange={(event) => setCustomRules((current) => replaceCustomRule(current, index, { ...rule, replacement: event.target.value }))} placeholder={rule.mode === "transform" ? "niulai" : "Not used for block"} />
              </Field>
              <div className="flex items-end">
                <Button variant="ghost" size="sm" onClick={() => setCustomRules((current) => current.filter((_, itemIndex) => itemIndex !== index))}>Remove</Button>
              </div>
            </div>
          ))}
          {!customRules.length ? <p className="text-xs text-muted-foreground">No custom phrase rules yet.</p> : null}
        </div>
      </section>
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2"><Field label={t("guardrails.allowedDomains")}><Textarea className="min-h-24" value={allowed} onChange={(event) => setAllowed(event.target.value)} /></Field><Field label={t("guardrails.restrictedDomains")}><Textarea className="min-h-24" value={restricted} onChange={(event) => setRestricted(event.target.value)} /></Field></div>
      <RuntimePostureFields safetyLevel={level} outputDelivery={delivery} onSafetyLevelChange={setLevel} onOutputDeliveryChange={setDelivery} />
      <section className="min-w-0"><h3 className="mb-3 text-sm font-semibold">{t("guardrails.policyBindings")}</h3><PolicyBindingEditor policies={policies} value={bindings} onChange={setBindings} /></section>
    </div>
  </EntitySheet>;
}

function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="grid gap-2"><Label>{label}</Label>{children}</label>; }
function lines(value: string) { return value.split("\n").map((item) => item.trim()).filter(Boolean); }
function notifyError(error: unknown, fallback: string) { toast.error(error instanceof Error ? error.message : fallback); }
function isGuardrailDraftManageable(guardrail: Pick<Guardrail, "is_default" | "system_managed">) { return guardrail.is_default || !guardrail.system_managed; }

type CustomRuleRow = { id: string; phrase: string; mode: "transform" | "block"; replacement: string };

function customRuleRowsFromGuardrail(guardrail: Guardrail): CustomRuleRow[] {
  return guardrail.custom_content_rules
    .filter((rule) => rule.detector === "keyword" && rule.phases.includes("input"))
    .map((rule, index) => ({
      id: rule.id || `custom-rule-${index + 1}`,
      phrase: rule.keywords?.[0] ?? "",
      mode: rule.action === "reject" ? "block" : "transform",
      replacement: rule.replacement ?? "",
    }));
}

function customRulesToDraft(rows: CustomRuleRow[]): Guardrail["custom_content_rules"] {
  return rows
    .map((rule, index) => ({
      id: rule.id || `custom-rule-${index + 1}`,
      phases: ["input"] as Array<"input">,
      detector: "keyword" as const,
      keywords: [rule.phrase.trim()].filter(Boolean),
      action: rule.mode === "block" ? "reject" as const : "redact" as const,
      ...(rule.mode === "transform" && rule.replacement.trim() ? { replacement: rule.replacement.trim() } : {}),
    }))
    .filter((rule) => rule.keywords.length);
}

function blankCustomRuleRow(index: number): CustomRuleRow {
  return { id: `custom-rule-${index}`, phrase: "", mode: "block", replacement: "" };
}

function replaceCustomRule(rows: CustomRuleRow[], index: number, next: CustomRuleRow): CustomRuleRow[] {
  return rows.map((row, itemIndex) => itemIndex === index ? next : row);
}
