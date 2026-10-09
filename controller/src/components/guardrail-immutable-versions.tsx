import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, ChevronLeft, ChevronRight, Download, FlaskConical, GitCompareArrows, LoaderCircle, LockKeyhole, MoreHorizontal, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { GeneratedVersionFiles, RuntimeDependencySummary, RuntimeExecutionSummary } from "./compiled-runtime";
import { ConfirmationSheet } from "./confirmation-sheet";
import { CopyableChecksum } from "./copyable-checksum";
import { EntitySheet } from "./entity-sheet";
import { ExportGuardrailSheet } from "./guardrail-export-sheet";
import { DeleteGuardrailVersionSheet } from "./guardrail-version-delete-sheet";
import { GuardrailVersionComparison } from "./guardrail-version-workspace";
import { EmptyState, ErrorNotice, StateBadge } from "./product-shell";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { toast } from "./ui/notifications";
import { Skeleton } from "./ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { type GuardrailVersion, type GuardrailVersionDetail, type ValidationRun } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { checkGuardrailVersionEnvironment, getSystemBaseline, setSystemBaseline } from "@/lib/controller-api";
import { useDeploymentCapabilities } from "@/lib/deployment";
import { queryKeys } from "@/features/query-keys";
import { CopyableChecksum as Digest } from "./copyable-checksum";
import { EnvironmentStatus } from "./guardrail-import-sheet";
import { VersionTestSuite } from "./version-test-suite";
import { Input } from "./ui/input";

type VersionAction = { kind: "export" | "delete" | "baseline"; version: string };
type Props = {
  openRequested?: boolean;
  onOpenRequestHandled?: () => void;
  detail?: GuardrailVersionDetail;
  selectedVersion?: GuardrailVersion;
  versions: GuardrailVersion[];
  loading: boolean;
  error?: unknown;
  detailLoading?: boolean;
  detailError?: unknown;
  comparisonDetail?: GuardrailVersionDetail;
  comparisonActive: boolean;
  comparisonLoading: boolean;
  comparisonError?: unknown;
  compareOptions: GuardrailVersion[];
  guardrailId: string;
  guardrailName: string;
  /** The Default Guardrail supplies the runtime baseline. */
  isDefault?: boolean;
  validation: ValidationRun | null;
  validationRuns?: ValidationRun[];
  validationLoading?: boolean;
  validationError?: unknown;
  onRetry?: () => void;
  onRetryComparison?: () => void;
  onChanged: () => Promise<void>;
  onOpenDraft: () => void;
  onOpenValidation: (run: ValidationRun) => void;
  onSelectVersion: (version: string) => void;
  onStartCompare: () => void;
  onCompareBaseChange: (version: string) => void;
  onCloseCompare: () => void;
};

const PAGE_SIZE = 10;

export function ImmutableVersionView({ openRequested, onOpenRequestHandled, detail, selectedVersion, versions, loading, error, detailLoading, detailError, comparisonDetail, comparisonActive, comparisonLoading, comparisonError, compareOptions, guardrailId, guardrailName, isDefault = false, validation, validationRuns = [], validationLoading, validationError, onRetry, onRetryComparison, onChanged, onOpenDraft, onOpenValidation, onSelectVersion, onStartCompare, onCompareBaseChange, onCloseCompare }: Props) {
  const { t, i18n } = useTranslation();
  const auth = useAuth();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [action, setAction] = useState<VersionAction | null>(null);
  const [tab, setTab] = useState("overview");
  const [page, setPage] = useState(0);
  const [policyPage, setPolicyPage] = useState(0);
  const opener = useRef<HTMLElement | null>(null);
  const versionButtons = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => {
    if (!openRequested) return;
    setTab("overview");
    setPolicyPage(0);
    setDrawerOpen(true);
    onOpenRequestHandled?.();
  }, [openRequested, onOpenRequestHandled]);
  const ordered = [...versions].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.version.localeCompare(a.version));
  const selectedIndex = ordered.findIndex(item => item.version === selectedVersion?.version);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(ordered.length / PAGE_SIZE) - 1));
  const ready = !selectedVersion?.compile_status || selectedVersion.compile_status === "ready";
  const currentDetail = detail?.version === selectedVersion?.version ? detail : undefined;
  const latestTests = new Map<string, ValidationRun>();
  for (const run of [...validationRuns].sort((a, b) => b.created_at.localeCompare(a.created_at))) {
    if (!latestTests.has(run.guardrail_version)) latestTests.set(run.guardrail_version, run);
  }
  const capabilities = useDeploymentCapabilities();
  const baseline = useQuery({ queryKey: queryKeys.systemBaseline, queryFn: getSystemBaseline, enabled: isDefault });
  const [baselineReason, setBaselineReason] = useState("");
  const switchBaseline = useMutation({
    mutationFn: ({ version, reason }: { version: string; reason: string }) => setSystemBaseline(version, reason),
    onSuccess: async (_result, { version }) => {
      await Promise.all([onChanged(), baseline.refetch()]);
      setAction(null);
      setBaselineReason("");
      toast.success(t("guardrailPackage.baselineSet", { version }));
    },
  });
  const environmentCheck = useMutation({
    mutationFn: (version: string) => checkGuardrailVersionEnvironment(guardrailId, version),
    onSuccess: () => onChanged(),
  });
  const openVersion = (version: string, target: HTMLElement) => {
    opener.current = target;
    onSelectVersion(version);
    onCloseCompare();
    setTab("overview");
    setPolicyPage(0);
    setDrawerOpen(true);
  };
  const navigateVersion = (index: number) => {
    const version = ordered[index];
    if (!version) return;
    onSelectVersion(version.version);
    onCloseCompare();
    setPage(Math.floor(index / PAGE_SIZE));
    setPolicyPage(0);
  };
  const closeAction = () => { setAction(null); switchBaseline.reset(); };
  const menu = (version: GuardrailVersion, inDrawer = false) => (
    <div onFocusCapture={event => { if (!inDrawer && event.target instanceof HTMLButtonElement && event.currentTarget.contains(event.target)) opener.current = event.target; }}><DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="size-11 shrink-0" aria-label={inDrawer ? t("uiCopy.versionActions") : t("immutableVersions.versionActions", { version: version.version })}><MoreHorizontal /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled={Boolean(version.compile_status && version.compile_status !== "ready")} onSelect={() => setAction({ kind: "export", version: version.version })}><Download />{t("guardrails.exportEllipsis")}</DropdownMenuItem>
        {/* The runtime baseline is pinned; switching it is always explicit. */}
        {auth.user?.role === "admin" && isDefault ?
          <DropdownMenuItem variant="edit" disabled={baseline.data?.version === version.version || Boolean(version.compile_status && version.compile_status !== "ready")} onSelect={() => setAction({ kind: "baseline", version: version.version })}><ShieldCheck />{t("guardrailPackage.setBaseline")}</DropdownMenuItem> : null}
        {auth.user?.role === "admin" ? <DropdownMenuItem variant="destructive" onSelect={() => setAction({ kind: "delete", version: version.version })}><Trash2 />{t("uiCopy.delete")}</DropdownMenuItem>
        : null}
      </DropdownMenuContent>
    </DropdownMenu></div>
  );
  const testStatus = (run?: ValidationRun | null) => validationLoading
    ? <span className="text-sm text-muted-foreground">{t("immutableVersions.loading")}</span>
    : validationError ? <span className="text-sm text-muted-foreground">{t("immutableVersions.testUnavailable")}</span>
      : run ? <StateBadge state={run.status} /> : <span className="text-sm text-muted-foreground">{t("immutableVersions.noTest")}</span>;

  return <>
    <section className="min-w-0 border bg-card" aria-label={t("guardrails.versions")}>
      <header className="border-b px-5 py-4">
        <p className="text-sm text-muted-foreground">{t("immutableVersions.description")}</p>
      </header>
      {error ? <div className="space-y-3 p-5"><ErrorNotice error={error} /><Button variant="outline" onClick={onRetry}>{t("immutableVersions.retry")}</Button></div> : null}
      {loading ? <div className="space-y-3 p-5" aria-label={t("immutableVersions.loading")}><Skeleton className="h-12" /><Skeleton className="h-16" /><Skeleton className="h-16" /></div>
        : !versions.length ? !error && <EmptyState title={t("guardrails.noPublishedVersion")} description={t("guardrails.noPublishedVersionDescription")} action={auth.user?.role === "admin" ? <Button onClick={onOpenDraft}>{t("guardrails.openDraftRelease")}</Button> : undefined} />
          : <>
            <Table>
              <TableHeader><TableRow><TableHead>{t("immutableVersions.version")}</TableHead><TableHead>{t("immutableVersions.published")}</TableHead><TableHead>{t("immutableVersions.policies")}</TableHead><TableHead>{t("immutableVersions.tests")}</TableHead><TableHead className="w-16"><span className="sr-only">{t("immutableVersions.actions")}</span></TableHead></TableRow></TableHeader>
              <TableBody>{ordered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map(version => <TableRow key={version.version} data-state={drawerOpen && selectedVersion?.version === version.version ? "selected" : undefined}>
                <TableCell><div className="flex items-center gap-3">
                  <Button variant="ghost" className="min-h-11 px-0 font-mono text-sm text-primary hover:underline" aria-label={t("immutableVersions.view", { version: version.version })} ref={node => { if (node) versionButtons.current.set(version.version, node); else versionButtons.current.delete(version.version); }} aria-haspopup="dialog" onClick={event => openVersion(version.version, event.currentTarget)}>{version.version}</Button>
                  {isDefault && baseline.data?.version === version.version ? <StateBadge state="protected" label={t("guardrailPackage.baselineCurrent")} /> : null}
                  {version.compile_status && version.compile_status !== "ready" ? <StateBadge state={version.compile_status === "failed" ? "failed" : "running"} label={t(`immutableVersions.${version.compile_status === "failed" ? "failed" : "compiling"}`)} /> : null}
                </div></TableCell>
                <TableCell><time dateTime={version.created_at} className="text-muted-foreground">{new Date(version.created_at).toLocaleString(i18n.language)}</time></TableCell>
                <TableCell className="tabular-nums">{version.policy_count ?? (detail?.version === version.version ? detail.policy_bindings.length : "—")}</TableCell>
                <TableCell>{version.provenance ? <StateBadge state="passed" label={t("guardrailPackage.sourceTestPassed", { source: version.provenance.uatEvidence.source.name })} /> : testStatus(latestTests.get(version.version))}</TableCell>
                <TableCell>{menu(version)}</TableCell>
              </TableRow>)}</TableBody>
            </Table>
            {ordered.length > PAGE_SIZE ? <ListPagination page={currentPage} total={ordered.length} onPageChange={setPage} /> : null}
          </>}
    </section>

    {/* Actions replace the detail sheet; two modal drawers must never overlap. */}
    {drawerOpen && !action && selectedVersion ? <EntitySheet open onOpenChange={open => { if (!open) { opener.current = versionButtons.current.get(selectedVersion.version) ?? opener.current; setDrawerOpen(false); onCloseCompare(); } }}
      returnFocusRef={opener} width="xl" density="compact" bodyClassName="flex flex-col !overflow-hidden !py-0" footer={null}
      eyebrow={t("guardrails.versions")}
      title={<span className="flex items-center gap-3"><span className="font-mono text-xl">{selectedVersion.version}</span>{isDefault && baseline.data?.version === selectedVersion.version ? <StateBadge state="protected" label={t("guardrailPackage.baselineCurrent")} /> : null}</span>}
      description={<span className="flex items-center gap-2"><LockKeyhole className="size-3.5" />{t("immutableVersions.readOnly")}<span aria-hidden="true">·</span>{t("immutableVersions.detailDescription", { date: new Date(selectedVersion.created_at).toLocaleString(i18n.language) })}</span>}
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b bg-background py-2">
        <div className="flex items-center gap-1">
          <Button variant="ghost" className="size-11" aria-label={t("immutableVersions.previous")} disabled={selectedIndex <= 0} onClick={() => navigateVersion(selectedIndex - 1)}><ChevronLeft /></Button>
          <span className="px-1 text-xs tabular-nums text-muted-foreground">{t("immutableVersions.position", { current: selectedIndex + 1, total: ordered.length })}</span>
          <Button variant="ghost" className="size-11" aria-label={t("immutableVersions.next")} disabled={selectedIndex < 0 || selectedIndex >= ordered.length - 1} onClick={() => navigateVersion(selectedIndex + 1)}><ChevronRight /></Button>
        </div>
        <div className="flex items-center gap-2">{ready && compareOptions.length > 0 && !comparisonActive ? <Button variant="outline" className="min-h-11" disabled={!currentDetail || Boolean(detailError)} onClick={onStartCompare}><GitCompareArrows />{t("immutableVersions.compare")}</Button> : null}{menu(selectedVersion, true)}</div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-5">
        {!ready ? <section className="space-y-3"><h3 className="text-base font-semibold">{t(selectedVersion.compile_status === "failed" ? "guardrails.versionCompilationFailed" : "guardrails.versionCompilationPending")}</h3>{selectedVersion.compile_status === "failed" ? <ErrorNotice error={new Error(selectedVersion.failure_reason ?? t("guardrails.compilationFailedDetail"))} /> : <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />{t("guardrails.compilationPendingDetail")}</p>}</section>
          : detailError ? <RetryNotice error={detailError} onRetry={onRetry} />
            : detailLoading && !currentDetail ? <div role="status"><p className="mb-4 text-sm text-muted-foreground">{t("immutableVersions.loadingDetail")}</p><Skeleton className="h-64" /></div>
              : !currentDetail ? <RetryNotice error={new Error(t("immutableVersions.noDetail"))} onRetry={onRetry} />
                : comparisonActive ? comparisonError ? <div className="space-y-4"><Button variant="outline" onClick={onCloseCompare}>{t("guardrails.backToVersionDetail")}</Button><RetryNotice error={comparisonError} onRetry={onRetryComparison} /></div>
                  : comparisonLoading || !comparisonDetail ? <div className="space-y-4"><Button variant="outline" onClick={onCloseCompare}>{t("guardrails.backToVersionDetail")}</Button><Skeleton className="h-64" /></div>
                    : <GuardrailVersionComparison base={comparisonDetail} target={currentDetail} baseOptions={compareOptions} onBaseChange={onCompareBaseChange} onClose={onCloseCompare} />
                  : <Tabs value={tab} onValueChange={setTab} className="flex h-full min-h-0 flex-col">
                    <TabsList className="shrink-0" aria-label={t("immutableVersions.views")}>
                      <TabsTrigger value="overview">{t("immutableVersions.overview")}</TabsTrigger>
                      <TabsTrigger value="policies">{t("immutableVersions.policies")}<Badge variant="outline">{currentDetail.policy_bindings.length}</Badge></TabsTrigger>
                      <TabsTrigger value="tests">{t("immutableVersions.testSuite")}{currentDetail.test_suite_count != null ? <Badge variant="outline">{currentDetail.test_suite_count}</Badge> : null}</TabsTrigger>
                      <TabsTrigger value="compiled">{t("immutableVersions.compiled")}</TabsTrigger>
                      <TabsTrigger value="files">{t("immutableVersions.files")}<Badge variant="outline">{currentDetail.artifacts.length}</Badge></TabsTrigger>
                    </TabsList>
                    <TabsContent value="overview" className="min-h-0 flex-1 overflow-y-auto overscroll-contain space-y-7 pt-6">
                      <ImmutablePosture detail={currentDetail} />
                      {selectedVersion.origin === "imported" || !capabilities.authoringEnabled ? <ReleaseEnvironment version={selectedVersion}
                        checking={environmentCheck.isPending} error={environmentCheck.error} canCheck={auth.user?.role === "admin"}
                        onCheck={() => environmentCheck.mutate(selectedVersion.version)} /> : null}
                      {selectedVersion.provenance ? <ReleaseEvidence version={selectedVersion} /> : <section className="space-y-3 border-t pt-6">
                        <div><h3 className="text-base font-semibold">{t("guardrails.validationEvidence")}</h3><p className="mt-1 text-sm text-muted-foreground">{t("immutableVersions.testDescription")}</p></div>
                        {validationError ? <RetryNotice error={validationError} onRetry={onRetry} /> : validationLoading ? <Skeleton className="h-20" /> : validation ? <div className="flex items-center justify-between gap-4 border p-4"><div><div className="flex items-center gap-3">{testStatus(validation)}<span className="text-sm">{t("guardrails.compliance", { rate: validation.metrics.compliance_rate })}</span></div><p className="mt-2 text-xs text-muted-foreground">{new Date(validation.created_at).toLocaleString(i18n.language)}</p></div><Button variant="outline" onClick={() => { setDrawerOpen(false); onOpenValidation(validation); }}><FlaskConical />{t("guardrails.openValidation")}</Button></div>
                          : <p className="border bg-muted/20 p-4 text-sm text-muted-foreground">{t("immutableVersions.noTestDescription")}</p>}
                      </section>}
                    </TabsContent>
                    <TabsContent value="policies" className="min-h-0 flex-1 overflow-y-auto overscroll-contain pt-5"><PinnedPolicies key={currentDetail.version} bindings={currentDetail.policy_bindings} page={policyPage} onPageChange={setPolicyPage} /></TabsContent>
                    <TabsContent value="tests" className="min-h-0 flex-1 overflow-y-auto overscroll-contain pt-5"><VersionTestSuite key={currentDetail.version} guardrailId={guardrailId} version={currentDetail.version} /></TabsContent>
                    <TabsContent value="compiled" className="min-h-0 flex-1 overflow-y-auto overscroll-contain space-y-5 pt-5">
                      <p className="text-sm text-muted-foreground">{t("immutableVersions.compiledDescription")}</p>
                      <dl className="grid grid-cols-2 gap-5">
                        <VersionFact label={t("guardrails.runtimeEngine")} value={`${currentDetail.runtime_engine} · ${currentDetail.runtime_profile}`} />
                        <VersionFact label={t("guardrails.compiledWith")} value={currentDetail.compiler_version} mono />
                        <VersionFact label={t("guardrails.colangVersion")} value={currentDetail.colang_version} />
                        <VersionFact label={t("guardrails.criticalPath")} value={`${currentDetail.estimated_critical_path_ms} ms`} />
                        <div className="col-span-2"><dt className="text-xs text-muted-foreground">{t("guardrails.configIdentity")}</dt><dd className="mt-2"><CopyableChecksum value={currentDetail.config_checksum} /></dd></div>
                      </dl>
                      <div className="border"><RuntimeExecutionSummary detail={currentDetail} /><RuntimeDependencySummary detail={currentDetail} /></div>
                    </TabsContent>
                    <TabsContent value="files" className="min-h-0 flex-1 overflow-hidden pt-5"><GeneratedVersionFiles fillHeight key={currentDetail.version} detail={currentDetail} /></TabsContent>
                  </Tabs>}
      </div>
    </EntitySheet> : null}
    {action?.kind === "delete" ? <DeleteGuardrailVersionSheet returnFocusRef={drawerOpen ? undefined : opener} guardrailId={guardrailId} version={action.version} onClose={closeAction} onDeleted={async () => {
      toast.success(t("guardrails.versionDeleted", { version: action.version }));
      setDrawerOpen(false);
      setAction(null);
      onCloseCompare();
      await onChanged();
    }} /> : null}
    {action?.kind === "baseline" ? <ConfirmationSheet open returnFocusRef={drawerOpen ? undefined : opener} onOpenChange={open => { if (!open && !switchBaseline.isPending) { setAction(null); switchBaseline.reset(); } }}
      eyebrow={t("guardrails.confirmActionEyebrow")} title={t("guardrailPackage.baselineTitle", { version: action.version })} description={t("guardrailPackage.baselineDescription")}
      cancelLabel={t("common.cancel")} confirmLabel={t("guardrailPackage.setBaseline")} pendingLabel={t("common.saving")} pending={switchBaseline.isPending}
      confirmDisabled={!baselineReason.trim()} confirmIcon={<ShieldCheck />} onConfirm={() => switchBaseline.mutate({ version: action.version, reason: baselineReason.trim() })}>
      <label className="block space-y-2 text-sm"><span className="font-medium">{t("guardrailPackage.baselineReason")}</span>
        <Input value={baselineReason} maxLength={500} placeholder={t("guardrailPackage.baselineReasonPlaceholder")} onChange={event => setBaselineReason(event.target.value)} /></label>
      {switchBaseline.error ? <ErrorNotice error={switchBaseline.error} /> : null}
    </ConfirmationSheet> : null}
    {action?.kind === "export" ? <ExportGuardrailSheet returnFocusRef={drawerOpen ? undefined : opener} guardrailId={guardrailId} guardrailName={guardrailName} initialVersion={action.version} onClose={closeAction} /> : null}
  </>;
}

/** Source evidence for an imported version: recorded at the source, never re-run here. */
function ReleaseEvidence({ version }: { version: GuardrailVersion }) {
  const { t, i18n } = useTranslation();
  const provenance = version.provenance!;
  const evidence = provenance.uatEvidence;
  return <section className="space-y-3 border-t pt-6">
    <div><h3 className="text-base font-semibold">{t("guardrailPackage.provenanceTitle")}</h3><p className="mt-1 text-sm text-muted-foreground">{t("guardrailPackage.provenanceDescription")}</p></div>
    <div className="space-y-3 border p-4">
      <div className="flex flex-wrap items-center gap-3"><StateBadge state="passed" label={t("guardrailPackage.sourceTestPassed", { source: evidence.source.name })} />
        {typeof evidence.metrics.total === "number" ? <span className="text-sm">{t("guardrailPackage.passedCases", { passed: evidence.metrics.passed ?? 0, total: evidence.metrics.total })}</span> : null}</div>
      <p className="text-xs text-muted-foreground">{t("guardrailPackage.testedAt", { time: new Date(evidence.testedAt).toLocaleString(i18n.language) })} · {t("guardrailPackage.importedAt", { time: new Date(provenance.importedAt).toLocaleString(i18n.language) })} · {t("guardrailPackage.signedBy", { keyId: provenance.sourceKeyId })}</p>
      <div><p className="mb-1 text-xs text-muted-foreground">{t("guardrailPackage.contentDigest")}</p><Digest value={provenance.contentDigest} /></div>
    </div>
  </section>;
}

/** Whether this environment's Runners can load the version; required before routing imported content. */
function ReleaseEnvironment({ version, checking, error, canCheck, onCheck }: { version: GuardrailVersion; checking: boolean; error: unknown; canCheck: boolean; onCheck: () => void }) {
  const { t, i18n } = useTranslation();
  const check = version.environment_check;
  return <section className="space-y-3 border-t pt-6">
    <div className="flex items-start justify-between gap-4">
      <div><h3 className="text-base font-semibold">{t("guardrailPackage.environmentTitle")}</h3><p className="mt-1 text-sm text-muted-foreground">{t("guardrailPackage.environmentDescription")}</p></div>
      {canCheck ? <Button variant="outline" className="min-h-11 shrink-0" disabled={checking} onClick={onCheck}>{checking ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}{t(checking ? "guardrailPackage.checking" : "guardrailPackage.checkEnvironment")}</Button> : null}
    </div>
    <div className="border p-4"><EnvironmentStatus check={check} />
      {check ? <p className="mt-2 text-xs text-muted-foreground">{t("guardrailPackage.lastChecked", { time: new Date(check.checkedAt).toLocaleString(i18n.language) })}</p> : null}</div>
    {error ? <ErrorNotice error={error} /> : null}
  </section>;
}

function RetryNotice({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useTranslation();
  return <div className="space-y-3"><ErrorNotice error={error} /><Button variant="outline" onClick={onRetry}>{t("immutableVersions.retry")}</Button></div>;
}

function VersionFact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="min-w-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className={`mt-2 break-words leading-6 ${mono ? "font-mono text-xs" : "text-sm font-medium"}`}>{value}</dd></div>;
}

function ImmutablePosture({ detail }: { detail: GuardrailVersionDetail }) {
  const { t } = useTranslation();
  const effective = detail.effective_output_delivery ?? detail.output_delivery;
  return <section><h3 className="text-base font-semibold">{t("immutableVersions.requestHandling")}</h3>
    <dl className="mt-5 grid grid-cols-2 gap-6">
      <VersionFact label={t("guardrailWizard.safetyLevel")} value={t(`guardrailWizard.safetyLevelOptions.${detail.safety_level}`)} />
      <VersionFact label={t("guardrailWizard.outputDelivery")} value={t(`guardrailWizard.outputDeliveryOptions.${effective}`)} />
      <VersionFact label={t("modelSettings.inputRail")} value={t("guardrails.compiledFlowCount", { count: detail.rails.filter(rail => rail.rail_type === "input").length })} />
      <VersionFact label={t("modelSettings.outputRail")} value={t("guardrails.compiledFlowCount", { count: detail.rails.filter(rail => rail.rail_type === "output").length })} />
    </dl><p className="mt-5 text-sm leading-6 text-muted-foreground">{t(effective === "full_buffered" ? "modelSettings.streamFull" : "modelSettings.streamWindow")}</p>
    {effective !== detail.output_delivery ? <p className="mt-2 text-sm text-muted-foreground">{t("guardrails.deliverySafetyFallback")}</p> : null}
  </section>;
}

function PinnedPolicies({ bindings, page, onPageChange }: { bindings: GuardrailVersionDetail["policy_bindings"]; page: number; onPageChange: (page: number) => void }) {
  const { t } = useTranslation();
  return <section className="space-y-4"><p className="text-sm text-muted-foreground">{t("immutableVersions.policyDescription")}</p>
    {bindings.length ? <div className="border"><Table><TableHeader><TableRow><TableHead>{t("immutableVersions.policyVersion")}</TableHead><TableHead>{t("immutableVersions.rules")}</TableHead><TableHead>{t("immutableVersions.phases")}</TableHead><TableHead>{t("immutableVersions.behavior")}</TableHead></TableRow></TableHeader>
      <TableBody>{bindings.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(binding => <TableRow key={`${binding.policy_id}@${binding.policy_version}`}>
        <TableCell className="whitespace-normal">{binding.policy_name ? <p className="text-sm font-medium">{binding.policy_name}</p> : null}<code className="break-all text-xs">{binding.policy_id}</code><p className="mt-1 font-mono text-xs text-muted-foreground">{binding.policy_version}</p></TableCell>
        <TableCell className="tabular-nums">{binding.enabled_rule_ids.length}</TableCell>
        <TableCell className="whitespace-normal text-xs">{binding.enabled_rails.join(" · ") || "—"}</TableCell>
        <TableCell className="whitespace-normal text-xs">{binding.action ?? t("guardrails.policyBehavior")}</TableCell>
      </TableRow>)}</TableBody></Table>{bindings.length > PAGE_SIZE ? <ListPagination page={page} total={bindings.length} onPageChange={onPageChange} /> : null}</div> : <p className="py-6 text-sm text-muted-foreground">{t("immutableVersions.noPolicies")}</p>}
  </section>;
}

function ListPagination({ page, total, onPageChange }: { page: number; total: number; onPageChange: (page: number) => void }) {
  const { t } = useTranslation();
  return <nav className="flex items-center justify-between gap-3 border-t px-4 py-2">
    <span className="text-xs tabular-nums text-muted-foreground">{t("immutableVersions.rows", { start: page * PAGE_SIZE + 1, end: Math.min((page + 1) * PAGE_SIZE, total), total })}</span>
    <div className="flex gap-1"><Button variant="ghost" className="size-11" aria-label={t("immutableVersions.previousPage")} disabled={page === 0} onClick={() => onPageChange(page - 1)}><ChevronLeft /></Button><Button variant="ghost" className="size-11" aria-label={t("immutableVersions.nextPage")} disabled={(page + 1) * PAGE_SIZE >= total} onClick={() => onPageChange(page + 1)}><ChevronRight /></Button></div>
  </nav>;
}
