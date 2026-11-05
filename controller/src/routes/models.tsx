import { usePageUpdateBlocker } from "@/lib/page-updates";
import { isPlatformAdministrator } from "../../shared/rbac";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ModelPricingPanel } from "@/components/model-pricing";
import { FormalValidationSheet } from "@/components/formal-validation-sheet";
import type { FormalValidation } from "../../shared/formal-validation";
import { Checkbox as CarbonCheckbox } from "@/components/ui/checkbox";
import { Toggletip, ToggletipButton, ToggletipContent } from "@carbon/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  CircleAlert,
  EllipsisVertical,
  Info,
  LoaderCircle,
  Play,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  TestTube2,
  Trash2,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "@/components/ui/notifications";

import { ConfirmationSheet } from "@/components/confirmation-sheet";
import { ErrorNotice, PageHeader, StateBadge } from "@/components/product-shell";
import { ValidationEvidenceSheet } from "@/components/validation-evidence-sheet";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RegisterModelsDrawer } from "@/components/providers/register-models-drawer";
import { ProviderManagementSheet } from "@/components/providers/provider-management-sheet";
import { ProviderMark } from "@/components/providers/provider-mark";
import { ModelProtocolSettings } from "@/components/providers/model-protocol-settings";
import { ModelCallEvidence } from "@/components/providers/model-call-evidence";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useIsMobile } from "@/hooks/use-mobile";
import { useAuth } from "@/lib/auth";
import {
  applyModelConfiguration,
  deleteModelDefinition,
  getModelConfiguration,
  testModelConnection,
  saveModelAssignment,
  validateModelAssignment,
  validateSavedModelAssignment,
  type ModelAssignments,
  type ModelAssignmentTarget,
  type ModelConfigurationView,
  type ModelDefinition,
  type CapabilityBindingId,
} from "@/lib/controller-api";
import {
  capabilityBindingDefinitions,
  controlPlaneProfileRefs,
  isDataPlaneProviderKindAllowed,
  type CapabilityBindingDefinition,
} from "../../shared/guardrail-catalog";

import { modelBindingChanges, type PartialModelActivation } from "../../shared/model-activation";

const configurationKey = ["resources", "model-configuration"] as const;
const noneValue = "__none__";

export function ProvidersPage() {
  const { t } = useTranslation();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: configurationKey, queryFn: getModelConfiguration, refetchInterval: 10_000, retry: false });
  const administrator = isPlatformAdministrator(auth.user?.role);
  const refresh = async () => { await queryClient.invalidateQueries({ queryKey: configurationKey }); };

  if (query.isLoading) return <ModelsSkeleton />;
  if (query.error || !query.data) {
    return <section className="py-8"><PageHeader title={t("modelSettings.providersTitle")} description={t("modelSettings.providersPageDescription")} /><div className="mt-6"><ErrorNotice error={query.error} /></div></section>;
  }

  return (
    <section className="py-6 sm:py-8">
      <PageHeader
        title={t("modelSettings.providersTitle")}
        description={t("modelSettings.providersPageDescription")}
      />
      {!administrator ? (
        <Alert className="mt-6"><CircleAlert /><AlertTitle>{t("modelSettings.readOnly")}</AlertTitle><AlertDescription>{t("modelSettings.readOnlyDescription")}</AlertDescription></Alert>
      ) : null}
      <ResourceManagement resource="provider" view={query.data} administrator={administrator} onChanged={refresh} />
    </section>
  );
}

export function ModelsPage() {
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const { t } = useTranslation();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: configurationKey, queryFn: getModelConfiguration, refetchInterval: 10_000, retry: false });
  const administrator = isPlatformAdministrator(auth.user?.role);
  const refresh = async () => { await queryClient.invalidateQueries({ queryKey: configurationKey }); };

  if (query.isLoading) return <ModelsSkeleton />;
  if (query.error || !query.data) {
    return <section className="py-8"><PageHeader title={t("modelSettings.title")} description={t("modelSettings.description")} /><div className="mt-6"><ErrorNotice error={query.error} /></div></section>;
  }

  return (
    <section className="py-6 sm:py-8">
      <PageHeader title={t("modelSettings.title")} description={t("modelSettings.description")} />
      {!administrator ? (
        <Alert className="mt-6"><CircleAlert /><AlertTitle>{t("modelSettings.readOnly")}</AlertTitle><AlertDescription>{t("modelSettings.readOnlyDescription")}</AlertDescription></Alert>
      ) : null}
      <Tabs value={search.tab === "pricing" ? "pricing" : "models"} onValueChange={tab => void navigate({ to: "/settings/models", search: { tab } })} className="mt-6">
        <TabsList aria-label={t("modelPricing.models")}><TabsTrigger value="models">{t("modelPricing.models")}</TabsTrigger><TabsTrigger value="pricing">{t("modelPricing.prices")}</TabsTrigger></TabsList>
        <TabsContent value="models"><ResourceManagement resource="model" view={query.data} administrator={administrator} onChanged={refresh} /></TabsContent>
        <TabsContent value="pricing" className="pt-5"><ModelPricingPanel administrator={administrator} /></TabsContent>
      </Tabs>
    </section>
  );
}

export function GuardrailCatalogPage() {
  const { t } = useTranslation();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: configurationKey, queryFn: getModelConfiguration, refetchInterval: 10_000, retry: false });
  // Keep local choices separate from the polled draft. Updating one saved
  // binding must not discard another binding's validated, unsaved choice.
  const [assignmentEdits, setAssignmentEdits] = useState<Partial<Record<ModelAssignmentTarget, string | null>>>({});
  usePageUpdateBlocker(Object.keys(assignmentEdits).length > 0);
  const assignments = query.data?.draft ? structuredClone(query.data.draft.assignments) : null;
  if (assignments) {
    for (const [target, modelId] of Object.entries(assignmentEdits)) {
      if (modelId === undefined) continue;
      if (target === "control_plane") assignments.controlPlane = modelId;
      else assignments.bindings[target as CapabilityBindingId] = modelId;
    }
  }
  const [previewReport, setPreviewReport] = useState<NonNullable<ModelConfigurationView["draft"]>["validationReport"]>(null);
  const validationReceipts = useRef<Record<string, string | undefined>>({});
  const capabilityActionRunning = useRef(false);
  const [capabilityAction, setCapabilityAction] = useState<{ kind: "save" | "validate"; targets: CapabilityBindingId[] } | null>(null);
  const [capabilitySaveErrors, setCapabilitySaveErrors] = useState<Partial<Record<CapabilityBindingId, string>>>({});
  const [formalValidationOpen, setFormalValidationOpen] = useState(false);
  const formalValidation = useRef<FormalValidation | undefined>(undefined);
  const [pendingAction, setPendingAction] = useState<"activate" | null>(null);
  const [activationReview, setActivationReview] = useState<ModelConfigurationView | null>(null);
  const [selectedBindings, setSelectedBindings] = useState<CapabilityBindingId[]>([]);
  const dirty = Boolean(assignments && query.data?.draft && JSON.stringify(assignments.bindings) !== JSON.stringify(query.data.draft.assignments.bindings));
  const administrator = isPlatformAdministrator(auth.user?.role);
  const refresh = async () => { await queryClient.invalidateQueries({ queryKey: configurationKey }); };
  const saveAssignmentMutation = useMutation({
    mutationFn: async ({ target, modelId }: { target: ModelAssignmentTarget; modelId: string | null }) => saveModelAssignment(target, modelId, validationReceipts.current[`${target}:${modelId}`]),
    onSuccess: async (revision, { target, modelId }) => {
      // An in-flight poll may contain the draft from before this save.
      await queryClient.cancelQueries({ queryKey: configurationKey });
      queryClient.setQueryData<ModelConfigurationView>(configurationKey, (previous) => previous ? { ...previous, draft: revision } : previous);
      setAssignmentEdits((previous) => {
        if (previous[target] !== modelId) return previous;
        const next = { ...previous };
        delete next[target];
        return next;
      });
      if (!capabilityActionRunning.current) toast.success(t(target === "control_plane" ? "modelSettings.controlPlaneSaved" : "modelSettings.assignmentSaved"));
      await refresh();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const validateAssignmentMutation = useMutation({
    onMutate: (target: ModelAssignmentTarget) => {
      const modelId = target === "control_plane" ? assignments?.controlPlane : assignments?.bindings[target];
      delete validationReceipts.current[`${target}:${modelId}`];
    },
    mutationFn: async (target: ModelAssignmentTarget) => {
      const modelId = target === "control_plane" ? assignments?.controlPlane : assignments?.bindings[target];
      const context = target === "automated_reasoning.output" ? formalValidation.current : undefined;
      if (target !== "control_plane" && modelId && modelId === query.data?.draft?.assignments.bindings[target]) {
        return { revision: await validateSavedModelAssignment(target, modelId, context), modelId, saved: true as const };
      }
      const revision = await (context ? validateModelAssignment(target, modelId ?? undefined, context) : validateModelAssignment(target, modelId ?? undefined));
      return { revision, modelId, saved: false as const };
    },
    onSuccess: async ({ revision, modelId, saved }, target) => {
      if (target === "automated_reasoning.output") setFormalValidationOpen(false);
      if (!saved && revision.validationId && modelId) validationReceipts.current[`${target}:${modelId}`] = revision.validationId;
      const passed = Boolean(modelId && revision.validationReport?.checks.some((check) => check.id === `probe:${target}:${modelId}` && check.status === "passed"));
      if (!capabilityActionRunning.current) toast[passed ? "success" : "error"](t(passed ? "modelSettings.assignmentValidationPassed" : "modelSettings.assignmentValidationFailed"));
      if (saved) {
        await queryClient.cancelQueries({ queryKey: configurationKey });
        queryClient.setQueryData<ModelConfigurationView>(configurationKey, previous => previous ? { ...previous, draft: revision } : previous);
      }
      setPreviewReport((previous) => {
        const checks = (previous?.checks ?? []).filter(check => !check.id.startsWith(`probe:${target}:`));
        if (saved) return previous && checks.length ? { ...previous, checks } : null;
        return { ...revision.validationReport!, checks: [...checks,
          ...(revision.validationReport?.checks ?? []).filter(check => check.id.startsWith(`probe:${target}:`))] };
      });
    },
    onError: (error, target) => {
      const modelId = target === "control_plane" ? assignments?.controlPlane : assignments?.bindings[target];
      // A transport failure must replace an earlier pass for this stage, while
      // leaving the other stage's evidence intact.
      if (modelId) setPreviewReport(previous => ({
        valid: false, checkedAt: new Date().toISOString(), contractCoverage: previous?.contractCoverage ?? [], policies: previous?.policies ?? [],
        checks: [...(previous?.checks ?? []).filter(check => !check.id.startsWith(`probe:${target}:`)),
          { id: `probe:${target}:${modelId}`, scope: target === "control_plane" ? "model" : "capability", status: "failed", message: errorMessage(error) }],
      }));
      toast.error(errorMessage(error));
    },
  });
  const activateMutation = useMutation({
    mutationFn: async (selection: PartialModelActivation) => applyModelConfiguration(selection),
    onSuccess: async (result) => {
      setPendingAction(null);
      toast[result.distribution.distributionStatus === "ready" ? "success" : "info"](
        t(result.distribution.distributionStatus === "ready" ? "modelSettings.activated" : "modelSettings.syncing"),
      );
      await refresh();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const operationPending = activateMutation.isPending || saveAssignmentMutation.isPending || validateAssignmentMutation.isPending || capabilityAction !== null;

  const runCapabilityAction = async (kind: "save" | "validate", targets: CapabilityBindingId[]) => {
    if (capabilityActionRunning.current || !assignments) return;
    if (kind === "validate" && targets.includes("automated_reasoning.output")) {
      setFormalValidationOpen(true);
      return;
    }
    capabilityActionRunning.current = true;
    setCapabilityAction({ kind, targets });
    if (kind === "save") setCapabilitySaveErrors(previous => {
      const next = { ...previous };
      for (const target of targets) delete next[target];
      return next;
    });
    let succeeded = true;
    try {
      // Saves change the draft revision; keep them sequential. Validation also
      // runs stage by stage so one failed call cannot hide the other result.
      for (const target of targets) {
        const modelId = assignments.bindings[target];
        try {
          if (kind === "save") await saveAssignmentMutation.mutateAsync({ target, modelId });
          else {
            const { revision } = await validateAssignmentMutation.mutateAsync(target);
            succeeded = Boolean(revision.validationReport?.checks.some(check => check.id === `probe:${target}:${modelId}` && check.status === "passed")) && succeeded;
          }
        } catch (error) {
          succeeded = false;
          if (kind === "save") setCapabilitySaveErrors(previous => ({ ...previous, [target]: errorMessage(error) }));
        }
      }
      if (kind === "validate") toast[succeeded ? "success" : "error"](t(succeeded ? "modelSettings.capabilityValidationPassed" : "modelSettings.capabilityValidationFailed"));
      else if (succeeded) toast.success(t("modelSettings.assignmentSaved"));
    } finally {
      capabilityActionRunning.current = false;
      setCapabilityAction(null);
    }
  };

  if (query.isLoading) return <ModelsSkeleton />;
  if (query.error || !query.data) {
    return <section className="py-8"><PageHeader title={t("modelSettings.catalogTitle")} description={t("modelSettings.catalogPageDescription")} /><div className="mt-6"><ErrorNotice error={query.error} /></div></section>;
  }
  if (!assignments || !query.data.draft) return <ModelsSkeleton />;
  const report = query.data.draft.validationReport;
  const displayedReport = previewReport ? { ...previewReport, checks: [
    ...(report?.checks ?? []).filter((check) => !previewReport.checks.some((preview) => preview.id === check.id)),
    ...previewReport.checks,
  ] } : report;
  const changes = modelBindingChanges(query.data.draft.assignments, query.data.active?.assignments, report?.checks ?? []);
  const canActivate = administrator && !operationPending && !dirty && !query.data.activating && Boolean(query.data.draft.reviewToken)
    && selectedBindings.length > 0 && selectedBindings.every(id => changes.some(change => change.id === id));
  const confirmationPending = activateMutation.isPending;
  const activationReviewChanged = Boolean(activationReview && (
    activationReview.draft?.id !== query.data.draft.id
    || activationReview.draft?.updatedAt !== query.data.draft.updatedAt
    || activationReview.draft?.reviewToken !== query.data.draft.reviewToken
    || activationReview.active?.id !== query.data.active?.id
  ));
  const confirmationError = activateMutation.error;
  const closeConfirmation = () => {
    if (confirmationPending) return;
    activateMutation.reset();
    setPendingAction(null);
    setActivationReview(null);
  };
  const confirmPendingAction = () => {
    if (pendingAction === "activate" && activationReview?.draft?.reviewToken && !activationReviewChanged && canActivate) activateMutation.mutate({
      bindingIds: selectedBindings, expectedDraftToken: activationReview.draft.reviewToken, expectedActiveId: activationReview.active?.id ?? null,
    });
  };

  return (
    <section className="py-6 sm:py-8">
      <PageHeader
        title={t("modelSettings.catalogTitle")}
        description={t("modelSettings.catalogPageDescription")}

      />

      {!administrator ? (
        <Alert className="mt-6"><CircleAlert /><AlertTitle>{t("modelSettings.readOnly")}</AlertTitle><AlertDescription>{t("modelSettings.readOnlyDescription")}</AlertDescription></Alert>
      ) : null}
      {query.data.activating ? (
        <Alert variant="info" className="mt-6"><RefreshCw className="animate-spin motion-reduce:animate-none" /><AlertTitle>{t("modelSettings.syncingTitle")}</AlertTitle><AlertDescription>{t("modelSettings.syncingDescription")}</AlertDescription></Alert>
      ) : null}
      {query.data.failed?.failureReason ? (
        <Alert variant="destructive" className="mt-6"><CircleAlert /><AlertTitle>{t("modelSettings.activationFailed")}</AlertTitle><AlertDescription>{query.data.failed.failureReason}</AlertDescription></Alert>
      ) : null}
      {formalValidationOpen ? <FormalValidationSheet pending={validateAssignmentMutation.isPending} onClose={() => setFormalValidationOpen(false)} onValidate={value => { formalValidation.current = value; validateAssignmentMutation.mutate("automated_reasoning.output"); }} /> : null}
      <Tabs defaultValue="runner" className="mt-6">
        <TabsList aria-label={t("modelSettings.catalogTitle")}>
          <TabsTrigger value="runner">{t("modelSettings.catalogConfiguration")}</TabsTrigger>
          <TabsTrigger value="control-plane">{t("modelSettings.controlPlane")}</TabsTrigger>
        </TabsList>
        <TabsContent value="runner" forceMount>
          <GuardrailCatalogSection
            action={(
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  className="h-11"
                  disabled={operationPending}
                  onClick={() => { setActivationReview(structuredClone(query.data)); setSelectedBindings(changes.map(change => change.id)); setPendingAction("activate"); }}
                >
                  {activateMutation.isPending ? <LoaderCircle className="animate-spin" /> : <Play />}{t("modelSettings.reviewActivation")}
                </Button>
              </div>
            )}
            assignments={assignments}
            models={query.data.models.filter(model => model.projectId == null)}
            report={displayedReport}
            savedAssignments={query.data.draft.assignments}
            disabled={!administrator || operationPending || saveAssignmentMutation.isPending || validateAssignmentMutation.isPending}
            savingTarget={saveAssignmentMutation.isPending ? saveAssignmentMutation.variables?.target ?? null : null}
            validatingTarget={validateAssignmentMutation.isPending ? validateAssignmentMutation.variables ?? null : null}
            capabilityAction={capabilityAction}
            saveErrors={capabilitySaveErrors}
            onChange={(bindingIds, modelId) => {
              setAssignmentEdits(previous => {
                const next = { ...previous };
                for (const id of bindingIds) {
                  if (modelId === query.data!.draft!.assignments.bindings[id]) delete next[id];
                  else next[id] = modelId;
                }
                return next;
              });
              setCapabilitySaveErrors(previous => {
                const next = { ...previous };
                for (const id of bindingIds) delete next[id];
                return next;
              });
            }}
            onSave={(targets) => void runCapabilityAction("save", targets)}
            onValidate={(targets) => void runCapabilityAction("validate", targets)}
          />
        </TabsContent>
        <TabsContent value="control-plane" forceMount>
          {saveAssignmentMutation.error && saveAssignmentMutation.variables?.target === "control_plane" ? <div className="mt-6"><ErrorNotice error={saveAssignmentMutation.error} /></div> : null}
          <ControlPlaneSection
            models={query.data.models.filter(model => model.projectId == null)}
            selectedId={assignments.controlPlane}
            savedId={query.data.draft.assignments.controlPlane}
            report={displayedReport}
            disabled={!administrator || operationPending || saveAssignmentMutation.isPending || validateAssignmentMutation.isPending}
            saving={saveAssignmentMutation.isPending && saveAssignmentMutation.variables?.target === "control_plane"}
            validating={validateAssignmentMutation.isPending && validateAssignmentMutation.variables === "control_plane"}
            onChange={(controlPlane) => setAssignmentEdits((previous) => ({ ...previous, control_plane: controlPlane }))}
            onSave={(modelId) => saveAssignmentMutation.mutate({ target: "control_plane", modelId })}
            onValidate={() => validateAssignmentMutation.mutate("control_plane")}
          />
        </TabsContent>
      </Tabs>
      <ConfirmationSheet
        open={Boolean(pendingAction)}
        onOpenChange={(open) => { if (!open) closeConfirmation(); }}
        eyebrow={t("modelSettings.confirmChangeEyebrow")}
        title={t("modelSettings.applyTitle")}
        description={t("modelSettings.activateConfirmationDescription")}
        cancelLabel={t("common.cancel")}
        confirmLabel={t("modelSettings.activateRevisionAction")}
        confirmDisabled={pendingAction === "activate" && (activationReviewChanged || !canActivate)}
        confirmIcon={pendingAction === "activate" ? <Play /> : undefined}
        pendingLabel={t("modelSettings.actionPending")}
        pending={confirmationPending}
        variant="default"
        onConfirm={confirmPendingAction}
      >
        {pendingAction === "activate" && activationReview ? <>
          {changes.length > 0 || dirty ? <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{t("modelSettings.pendingConfiguration")}</span>
              {dirty ? <Badge variant="secondary">{t("modelSettings.unsaved")}</Badge> : null}
            </div>
          </div> : null}
          <RunnerConfigurationComparison view={activationReview} selectedBindings={selectedBindings} onSelectionChange={setSelectedBindings} disabled={confirmationPending} />
          {changes.length > 0 ? <p className="text-sm text-muted-foreground">{t("modelSettings.partialActivationDescription")}</p> : null}
          {dirty ? <Alert variant="warning"><CircleAlert /><AlertDescription>{t("modelSettings.reviewUnsavedBindings")}</AlertDescription></Alert>
            : changes.some(change => selectedBindings.includes(change.id) && !change.ready) ? <Alert variant="info"><Info /><AlertDescription>{t("modelSettings.reviewNeedsValidation")}</AlertDescription></Alert> : null}
          {query.data.activating ? <Alert variant="warning"><CircleAlert /><AlertDescription>{t("modelSettings.activationInProgress")}</AlertDescription></Alert> : null}
        </> : null}
        {pendingAction === "activate" && activationReviewChanged ? <Alert variant="warning"><CircleAlert /><AlertDescription>{t("modelSettings.activationReviewChanged")}</AlertDescription></Alert> : null}
        {confirmationError ? <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">{errorMessage(confirmationError)}</p> : null}
      </ConfirmationSheet>
    </section>
  );
}

function RunnerConfigurationComparison({ view, selectedBindings, onSelectionChange, disabled }: { view: ModelConfigurationView; selectedBindings: CapabilityBindingId[]; onSelectionChange: (ids: CapabilityBindingId[]) => void; disabled: boolean }) {
  const { t } = useTranslation();
  const draft = view.draft;
  if (!draft) return null;
  const changes = modelBindingChanges(draft.assignments, view.active?.assignments, draft.validationReport?.checks ?? []);
  const bindings = capabilityBindingDefinitions.filter(binding => changes.some(change => change.id === binding.id));
  const modelLabel = (id: string | null | undefined, change?: "added" | "removed") => {
    if (!id) return <span className="text-muted-foreground">{t("modelSettings.notAssigned")}</span>;
    const model = view.models.find((item) => item.id === id);
    return <div className={change ? `rounded-md border p-2 ${change === "added" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300" : "border-destructive/30 bg-destructive/10 text-destructive"}` : "py-2"}>
      {change ? <p className="mb-1 text-xs font-semibold"><span aria-hidden="true">{change === "added" ? "+ " : "− "}</span>{t(change === "added" ? "modelSettings.bindingAdded" : "modelSettings.bindingRemoved")}</p> : null}
      <p className="font-medium [overflow-wrap:anywhere]">{model?.name ?? id}</p>
      {model ? <p className={`mt-1 text-xs [overflow-wrap:anywhere] ${change ? "" : "text-muted-foreground"}`}>{model.providerName} · {model.model}</p> : null}
    </div>;
  };
  return <div className="space-y-3">
    {bindings.length > 0 ? <p className="text-sm text-muted-foreground">{t("modelSettings.savedConfigurationOnly")}</p> : null}
    {!bindings.length ? <p role="status" className="text-sm font-medium">{t("modelSettings.noBindingChanges")}</p> : null}
    {!capabilityBindingDefinitions.some(binding => selectedBindings.includes(binding.id) ? draft.assignments.bindings[binding.id] : view.active?.assignments.bindings[binding.id]) ? <Alert variant="warning"><CircleAlert /><AlertDescription>{t("modelSettings.emptyRunnerConfiguration")}</AlertDescription></Alert> : null}
    {bindings.length > 0 ? <Table className="table-fixed">
      <TableHeader><TableRow>
        <TableHead className="w-[34%] whitespace-normal">{t("modelSettings.capabilityColumn")}</TableHead>
        <TableHead className="w-[33%] whitespace-normal">{view.active ? t("modelSettings.currentConfiguration") : t("modelSettings.noActiveConfiguration")}</TableHead>
        <TableHead className="w-[33%] whitespace-normal">{t("modelSettings.pendingConfiguration")}</TableHead>
      </TableRow></TableHeader>
      <TableBody>{bindings.map((binding) => {
        const current = view.active?.assignments.bindings[binding.id] ?? null;
        const next = draft.assignments.bindings[binding.id];
        const change = changes.find(item => item.id === binding.id);
        const selected = selectedBindings.includes(binding.id);
        return <TableRow key={binding.id}>
          <TableCell className="whitespace-normal align-top"><p className="font-medium">{capabilityTitle(t, binding)}</p>
            {change ? <label className="flex min-h-11 items-center gap-2 text-xs"><CarbonCheckbox aria-label={`${t("modelSettings.applyBinding")} ${binding.id}`} checked={selected} disabled={disabled}
              onChange={event => onSelectionChange(event.target.checked ? [...selectedBindings, binding.id] : selectedBindings.filter(id => id !== binding.id))} />
              {t(change.ready ? "modelSettings.bindingReady" : "modelSettings.bindingNotReady")}</label> : null}
          </TableCell>
          <TableCell className="whitespace-normal align-top">{modelLabel(current, selected && current !== next && current ? "removed" : undefined)}</TableCell>
          <TableCell className="whitespace-normal align-top">{modelLabel(next, selected && current !== next && next ? "added" : undefined)}
            {change && !selected ? <p className="text-xs text-muted-foreground">{t("modelSettings.bindingDeferred")}</p> : null}
          </TableCell>
        </TableRow>;
      })}</TableBody>
    </Table> : null}
  </div>;
}

function ProtectionInfo({ title, children, align = "right" }: { title: string; children: ReactNode; align?: "right" | "bottom-start" }) {
  const { t } = useTranslation();
  return <Toggletip align={align} autoAlign className="shrink-0">
    <ToggletipButton label={t("modelSettings.aboutConfiguration", { name: title })} className="grid size-7 place-items-center text-muted-foreground hover:text-foreground">
      <Info className="size-4 fill-none" aria-hidden="true" />
    </ToggletipButton>
    <ToggletipContent className="[&_.cds--toggletip-content]:[max-inline-size:22rem]"><div className="w-80 space-y-3 text-left text-sm leading-6">{children}</div></ToggletipContent>
  </Toggletip>;
}

function ProtectionSectionHeader({ id, title, help, action }: { id: string; title: string; help: ReactNode; action?: ReactNode }) {
  return <div className="flex items-center justify-between gap-4 border-b px-5 py-4">
    <div className="flex min-h-11 min-w-0 items-center gap-1">
      <h2 id={id} className="text-base font-semibold">{title}</h2>
      <ProtectionInfo title={title} align="bottom-start">{help}</ProtectionInfo>
    </div>
    {action}
  </div>;
}

function ControlPlaneSection({ models, selectedId, savedId, report, disabled, saving, validating, onChange, onSave, onValidate }: {
  models: ModelDefinition[];
  selectedId: string | null;
  savedId: string | null;
  report: NonNullable<ModelConfigurationView["draft"]>["validationReport"];
  disabled: boolean;
  saving: boolean;
  validating: boolean;
  onChange: (value: string | null) => void;
  onSave: (modelId: string | null) => void;
  onValidate: () => void;
}) {
  const { t } = useTranslation();
  const available = models.filter((model) => controlPlaneProfileRefs.includes(model.profile as "generic-chat"));
  const selected = available.find((model) => model.id === selectedId);
  const dirty = selectedId !== savedId;
  return (
    <section className="mt-6 overflow-hidden rounded-lg border bg-card" aria-labelledby="control-plane-title">
      <ProtectionSectionHeader id="control-plane-title" title={t("modelSettings.controlPlane")} help={<>
        <p>{t("modelSettings.controlPlaneDescription")}</p>
        <p>{t("modelSettings.recommendedControlPlane")}</p>
      </>} />
      <div className="grid gap-4 px-5 py-5 lg:grid-cols-[minmax(0,1fr)_minmax(8rem,0.4fr)_auto] lg:items-start">
        <div>
          <Label htmlFor="control-plane-model" className="sr-only">{t("modelSettings.assignedModel")}</Label>
          <Select value={selectedId ?? noneValue} disabled={disabled} onValueChange={(value) => onChange(value === noneValue ? null : value)}>
            <SelectTrigger id="control-plane-model" className="field:h-11 w-full"><SelectValue placeholder={t("modelSettings.notAssigned")} /></SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value={noneValue}>{t("modelSettings.notAssigned")}</SelectItem>
              {available.map((model) => <SelectItem key={model.id} value={model.id}><ModelOption model={model} /></SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="flex min-h-11 items-center"><AssignmentValidationStatus target="control_plane" model={selected} report={report} dirty={dirty} /></div>
        <div className="flex items-center gap-2 lg:justify-self-end">
          <Button type="button" variant="testing" className="h-11" disabled={disabled || !selected || saving || validating} onClick={onValidate}>{validating ? <LoaderCircle className="animate-spin" /> : <TestTube2 />}{t("modelSettings.validateAssignment")}</Button>
          <Button type="button" className="h-11" disabled={disabled || saving || validating || (!selectedId && !dirty)} onClick={() => onSave(selectedId)}>{saving ? <LoaderCircle className="animate-spin" /> : <Play />}{t("modelSettings.activateControlPlane")}</Button>
        </div>
      </div>
    </section>
  );
}

type CapabilityConfigurationProps = {
  assignments: ModelAssignments;
  savedAssignments: ModelAssignments;
  models: ModelDefinition[];
  report: NonNullable<ModelConfigurationView["draft"]>["validationReport"];
  disabled: boolean;
  savingTarget: ModelAssignmentTarget | null;
  validatingTarget: ModelAssignmentTarget | null;
  capabilityAction: { kind: "save" | "validate"; targets: CapabilityBindingId[] } | null;
  saveErrors: Partial<Record<CapabilityBindingId, string>>;
  onChange: (bindingIds: CapabilityBindingId[], modelId: string | null) => void;
  onSave: (bindingIds: CapabilityBindingId[]) => void;
  onValidate: (bindingIds: CapabilityBindingId[]) => void;
};

function GuardrailCatalogSection({ action, ...props }: CapabilityConfigurationProps & { action: ReactNode }) {
  const { t } = useTranslation();
  const capabilities = [...new Set(capabilityBindingDefinitions.map(binding => binding.capabilityRef))];
  return (
    <section className="mt-6 overflow-hidden rounded-lg border bg-card" aria-labelledby="guardrail-catalog-title">
      <ProtectionSectionHeader id="guardrail-catalog-title" title={t("modelSettings.catalogConfiguration")} action={action} help={<>
        <p>{t("modelSettings.capabilityConfigurationHelp")}</p>
        <p>{t("modelSettings.catalogConfigurationDescription")}</p>
        <p>{t("modelSettings.contextualValidationBoundary")}</p>
      </>} />
      <Table className="table-fixed min-w-[64rem]">
        <TableHeader><TableRow>
          <TableHead className="w-[17rem] pl-5">{t("modelSettings.capabilityColumn")}</TableHead>
          <TableHead>{t("modelSettings.modelColumn")}</TableHead>
          <TableHead className="w-64 pr-8 min-[1600px]:w-[30%]">{t("modelSettings.validationColumn")}</TableHead>
          <TableHead className="w-64 pr-5">{t("modelSettings.actionsColumn")}</TableHead>
        </TableRow></TableHeader>
        <TableBody>{capabilities.map(capability => <CapabilityConfigurationRow key={capability}
          bindings={capabilityBindingDefinitions.filter(binding => binding.capabilityRef === capability)} {...props} />)}</TableBody>
      </Table>
    </section>
  );
}

function supportsBinding(model: ModelDefinition, binding: CapabilityBindingDefinition) {
  return isDataPlaneProviderKindAllowed(model.providerKind, binding.id) && binding.profileRefs.includes(model.profile);
}

function CapabilityConfigurationRow({ bindings, assignments, savedAssignments, models, report, disabled,
  savingTarget, validatingTarget, capabilityAction, saveErrors, onChange, onSave, onValidate }: CapabilityConfigurationProps & { bindings: CapabilityBindingDefinition[] }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"shared" | "staged" | null>(null);
  const binding = bindings[0]!;
  const title = capabilityName(t, binding);
  const ids = bindings.map(item => item.id);
  const sharedId = assignments.bindings[binding.id];
  const sameModel = bindings.every(item => assignments.bindings[item.id] === sharedId);
  // Derive the initial mode from saved bindings. Opening the page or changing
  // the presentation never overwrites an existing per-stage configuration.
  const staged = bindings.length > 1 && (mode === "staged" || (mode === null && !sameModel));
  const unresolvedSharedModel = !staged && !sameModel;
  const changedIds = ids.filter(id => assignments.bindings[id] !== savedAssignments.bindings[id]);
  const configuredIds = ids.filter(id => Boolean(assignments.bindings[id]));
  const busy = ids.some(id => savingTarget === id || validatingTarget === id || capabilityAction?.targets.includes(id));
  const sharedModels = models.filter(model => bindings.every(item => supportsBinding(model, item)))
    .sort((left, right) => binding.profilePreference.indexOf(left.profile) - binding.profilePreference.indexOf(right.profile) || left.name.localeCompare(right.name));
  const modelSelect = (targets: CapabilityBindingDefinition[], mixed = false) => {
    const first = targets[0]!;
    const modelId = mixed ? undefined : assignments.bindings[first.id];
    const selectedModel = models.find(model => model.id === modelId);
    const compatibleModels = targets.length > 1 ? sharedModels : models.filter(model => supportsBinding(model, first))
      .sort((left, right) => first.profilePreference.indexOf(left.profile) - first.profilePreference.indexOf(right.profile) || left.name.localeCompare(right.name));
    const selectableModels = selectedModel && !compatibleModels.some(model => model.id === selectedModel.id)
      ? [selectedModel, ...compatibleModels] : compatibleModels;
    const selectId = `binding-model-${targets.length > 1 ? binding.capabilityRef : first.id}`;
    return <div>
      <Label className={staged ? "mb-2 block text-xs leading-4 text-muted-foreground" : "sr-only"} htmlFor={selectId}>
        {staged ? t(`modelSettings.stage.${first.railType}`) : t("modelSettings.modelColumn")}
      </Label>
      <Select value={mixed ? "" : modelId ?? noneValue} disabled={disabled || (!selectableModels.length && !modelId)} onValueChange={value => onChange(targets.map(item => item.id), value === noneValue ? null : value)}>
        <SelectTrigger id={selectId} className="field:h-11 w-full"><SelectValue placeholder={t("modelSettings.chooseSharedModel")} /></SelectTrigger>
        <SelectContent position="popper"><SelectItem value={noneValue}>{t(compatibleModels.length ? "modelSettings.notAssigned" : "modelSettings.noCompatibleModelsShort")}</SelectItem>
          {selectableModels.map(model => <SelectItem key={model.id} value={model.id}><ModelOption model={model} /></SelectItem>)}
        </SelectContent>
      </Select>
      {!compatibleModels.length ? <p className="mt-2 text-xs text-muted-foreground">{t(targets.length > 1 && models.some(model => targets.some(target => supportsBinding(model, target))) ? "modelSettings.noSharedModelHelp" : "modelSettings.noCompatibleModelsHelp")}</p> : null}
    </div>;
  };
  return <TableRow aria-label={title}>
    <TableCell className="whitespace-normal py-5 pl-5 align-top">
      <div className="flex min-h-11 items-center gap-1">
        <p className="font-medium">{title}</p>
        <ProtectionInfo title={title}><p>{t(binding.capabilityRef === "classifier_review" ? "modelSettings.detectors.classifier_review.description" : `modelSettings.categories.${binding.categoryId}.description`)}</p></ProtectionInfo>
      </div>
      {changedIds.length ? <p className="mt-2 text-xs text-muted-foreground">{t("modelSettings.unsaved")}</p> : null}
    </TableCell>
    <TableCell className="whitespace-normal py-5 align-top">
      {staged ? <div className="space-y-3">{bindings.map(item => <div key={item.id}>{modelSelect([item])}</div>)}</div> : modelSelect(bindings, unresolvedSharedModel)}
      {bindings.length > 1 ? <>
        <Button type="button" variant="ghost" size="sm" className="mt-2 h-8 px-0" disabled={disabled} aria-expanded={staged}
          onClick={() => setMode(staged ? "shared" : "staged")}>{t(staged ? "modelSettings.useSharedModel" : "modelSettings.configureByStage")}</Button>
        {unresolvedSharedModel ? <p className="mt-1 text-xs text-muted-foreground">{t("modelSettings.chooseSharedModelHelp")}</p> : null}
      </> : null}
    </TableCell>
    <TableCell className="whitespace-normal py-5 pr-8 align-top">
      <div className="space-y-3">{bindings.map(item => <div key={item.id} className={`grid grid-cols-[3rem_minmax(0,1fr)] items-center gap-2 ${staged ? "min-h-[4.25rem] pt-6" : "min-h-11"}`} role="group" aria-label={`${title} · ${t(`modelSettings.stage.${item.railType}`)}`}>
        <p className="text-xs leading-6 text-muted-foreground">{t(`modelSettings.stage.${item.railType}`)}</p>
        <div className="min-w-0">
        {validatingTarget === item.id ? <span className="flex items-center gap-2 text-sm" role="status"><LoaderCircle className="size-4 animate-spin" />{t("modelSettings.validatingStage")}</span>
          : <AssignmentValidationStatus target={item.id} model={models.find(model => model.id === assignments.bindings[item.id])} report={report}
            dirty={assignments.bindings[item.id] !== savedAssignments.bindings[item.id]} binding={item} />}
        {saveErrors[item.id] ? <p role="alert" className="mt-1 text-xs text-destructive">{t("modelSettings.stageSaveFailed", { message: saveErrors[item.id] })}</p> : null}
        </div>
      </div>)}</div>
    </TableCell>
    <TableCell className="py-5 pr-5 align-top">
      <div className={`grid grid-cols-2 items-start gap-2 ${staged ? "pt-6" : ""}`}>
        <Button type="button" variant="testing" className="h-11 w-full min-w-0" disabled={disabled || busy || unresolvedSharedModel || !configuredIds.length} onClick={() => onValidate(configuredIds)}>
          {busy && capabilityAction?.kind === "validate" ? <LoaderCircle className="animate-spin" /> : <TestTube2 />}{t("modelSettings.validateAssignment")}
        </Button>
        <Button type="button" variant="save" className="h-11 w-full min-w-0" disabled={disabled || busy || unresolvedSharedModel || !changedIds.length} onClick={() => onSave(changedIds)}>
          {busy && capabilityAction?.kind === "save" ? <LoaderCircle className="animate-spin" /> : <Save />}{t("modelSettings.saveAssignment")}
        </Button>
      </div>
    </TableCell>
  </TableRow>;
}

function capabilityName(t: ReturnType<typeof useTranslation>["t"], binding: CapabilityBindingDefinition): string {
  const detectorKey = {
    classifier_review: "classifier_review",
    content_safety: "content_safety",
    jailbreak: "jailbreak_detection",
    topic_control: "topic_control",
    pii_semantic: "pii_detection",
    contextual_grounding: "contextual_grounding",
    automated_reasoning: "automated_reasoning",
  }[binding.capabilityRef];
  return t(`modelSettings.detectors.${detectorKey}.title`);
}

function capabilityTitle(t: ReturnType<typeof useTranslation>["t"], binding: CapabilityBindingDefinition): string {
  return `${capabilityName(t, binding)} · ${t(binding.railType === "input" ? "modelSettings.inputRail" : "modelSettings.outputRail")}`;
}

function AssignmentValidationStatus({ target, model, report, dirty, binding }: {
  target: ModelAssignmentTarget;
  model?: ModelDefinition;
  report: NonNullable<ModelConfigurationView["draft"]>["validationReport"];
  dirty: boolean;
  binding?: CapabilityBindingDefinition;
}) {
  const { t } = useTranslation();
  if (!model) return <StateBadge state="unconfigured" label={t("modelSettings.notAssigned")} />;
  void dirty;
  const result = report?.checks.find((check) => check.id === `probe:${target}:${model.id}`);
  if (result && (result.status === "failed" || (result.status === "passed" && (target === "control_plane" || result.evidenceKind === "nemo-rail-v1")))) return <ValidationEvidenceSheet
    key={`${result.id}:${report?.checkedAt}`}
    check={result}
    label={t(result.status === "failed" ? target === "control_plane" ? "modelSettings.probeFailed" : "modelSettings.evidence.validationFailed" : target === "control_plane" ? "modelSettings.detectorValidated" : "modelSettings.railSamplesPassed")}
    subject={`${target === "control_plane" ? t("modelSettings.controlPlaneModel") : binding ? capabilityTitle(t, binding) : target} · ${model.name}`}
  />;
  return <StateBadge state="needs_validation" label={t("modelSettings.notChecked")} />;
}

function ModelOption({ model }: { model: ModelDefinition }) {
  return <span className="flex min-w-0 items-center gap-2"><ProviderMark provider={model.providerName} kind={model.providerKind} model={model.model} size="sm" /><span className="truncate">{model.name} · {model.providerName}</span></span>;
}

type BatchTestResult = { id: string; name: string; status: "passed" | "failed"; message: string | null };
type BatchTestRun = { running: boolean; total: number; current: { id: string; name: string } | null; results: BatchTestResult[] };

function ResourceManagement({ resource, view, administrator, onChanged }: { resource: "provider" | "model"; view: ModelConfigurationView; administrator: boolean; onChanged: () => Promise<void> }) {
  const { t } = useTranslation();
  const ownsModel = (model: ModelDefinition) => model.projectId == null;
  const ownedModels = view.models.filter(ownsModel);
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  const [batchTest, setBatchTest] = useState<BatchTestRun | null>(null);
  const batchTestRunning = useRef(false);
  const [createMode, setCreateMode] = useState<"provider" | "model" | null>(null);
  const [initialProviderId, setInitialProviderId] = useState<string>();
  const [providerTargetId, setProviderTargetId] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<{ id: string; name: string } | null>(null);
  const providerTarget = view.providers.find((provider) => provider.id === providerTargetId) ?? null;
  const probeMutation = useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      const result = await testModelConnection(id);
      return { passed: result.connectionStatus === "validated", message: result.connectionMessage };
    },
    onSuccess: async (result) => {
      toast[result.passed ? "success" : "error"](result.passed
        ? t("modelSettings.callPassed")
        : result.message ?? t("modelSettings.callFailed"));
      await onChanged();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const deleteMutation = useMutation({
    mutationFn: async (target: { id: string }) => deleteModelDefinition(target.id),
    onSuccess: async () => { setRemoveTarget(null); toast.success(t("modelSettings.resourceRemoved")); await onChanged(); },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const pending = probeMutation.isPending || deleteMutation.isPending || Boolean(batchTest?.running);
  // One upstream call at a time: a batch is a reachability sweep, not a load
  // test, and Provider rate limits are shared by every registered Model.
  const runBatchTest = async (targets: ModelDefinition[]) => {
    if (batchTestRunning.current || probeMutation.isPending || deleteMutation.isPending || !targets.length) return;
    batchTestRunning.current = true;
    const results: BatchTestResult[] = [];
    const progress = (current: ModelDefinition | null): BatchTestRun => ({
      running: true, total: targets.length, current: current ? { id: current.id, name: current.name } : null, results: [...results],
    });
    for (const target of targets) {
      setBatchTest(progress(target));
      try {
        const updated = await testModelConnection(target.id);
        results.push({
          id: updated.id, name: updated.name,
          status: updated.connectionStatus === "validated" ? "passed" : "failed",
          message: updated.connectionMessage ?? null,
        });
        // Refresh this row immediately instead of waiting for the poll.
        queryClient.setQueryData<ModelConfigurationView>(configurationKey, (previous) => previous
          ? { ...previous, models: previous.models.map((model) => model.id === updated.id ? updated : model) }
          : previous);
      } catch (error) {
        results.push({ id: target.id, name: target.name, status: "failed", message: errorMessage(error) });
      }
    }
    batchTestRunning.current = false;
    setBatchTest({ running: false, total: targets.length, current: null, results });
    await onChanged();
    const failed = results.filter((result) => result.status === "failed").length;
    toast[failed ? "error" : "success"](t(failed ? "modelSettings.batchTestSummaryFailed" : "modelSettings.batchTestSummaryPassed",
      { passed: results.length - failed, failed, count: results.length }));
  };
  const removalModelIds = new Set(removeTarget ? [removeTarget.id] : []);
  const isTesting = (id: string) => Boolean((probeMutation.isPending && probeMutation.variables?.id === id)
    || (batchTest?.running && batchTest.current?.id === id));
  const topicControlDraftUse = Boolean(view.draft?.assignments.bindings["topic_control.input"] && removalModelIds.has(view.draft?.assignments.bindings["topic_control.input"]));
  const topicControlActiveUse = Boolean(view.active?.assignments.bindings["topic_control.input"] && removalModelIds.has(view.active.assignments.bindings["topic_control.input"]));
  const topicControlUse = topicControlDraftUse || topicControlActiveUse;
  const assignmentTargets: Array<{ id: ModelAssignmentTarget; kind: "controlPlane" | "capability" }> = [
    { id: "control_plane", kind: "controlPlane" },
    ...capabilityBindingDefinitions.map(({ id }) => ({ id, kind: "capability" as const })),
  ];
  const assignedTargets = assignmentTargets.filter(({ id }) => {
    const draftModelId = id === "control_plane" ? view.draft?.assignments.controlPlane : view.draft?.assignments.bindings[id];
    const activeModelId = id === "control_plane" ? view.active?.assignments.controlPlane : view.active?.assignments.bindings[id];
    return Boolean((draftModelId && removalModelIds.has(draftModelId)) || (activeModelId && removalModelIds.has(activeModelId)));
  });
  const removalBlocked = assignedTargets.length > 0;
  return (
    <>
      {resource === "provider" ? <ResourceSection
        title={t("modelSettings.providers")}
        description={t("modelSettings.providersDescription")}
        helpLabel={t("modelSettings.providerConnectionsHelp")}
        action={<Button type="button" variant="create" className="h-11" disabled={!administrator} onClick={() => { setInitialProviderId(undefined); setCreateMode("provider"); }}><Plus />{t("modelSettings.addProvider")}</Button>}
      >
        {view.providers.length ? (
          isMobile ? (
            <div className="divide-y">
              {view.providers.map((provider) => {
                const providerModelCount = view.models.filter((model) => model.providerId === provider.id).length;
                return <article key={provider.id} className="space-y-4 p-4">
                  <div className="flex items-start gap-3">
                    <ProviderMark provider={provider.name} kind={provider.kind} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2"><h3 className="font-medium">{provider.name}</h3><StateBadge state={provider.status === "validated" ? "ready" : provider.status === "failed" ? "failed" : "not evaluated"} label={t(provider.status === "validated" ? "modelSettings.connected" : provider.status === "failed" ? "modelSettings.connectionFailed" : "modelSettings.notChecked")} /></div>
                      <p className="mt-1 text-xs text-muted-foreground">{provider.kind}</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 rounded-lg bg-muted/35 px-3 py-2.5">
                    <div className="min-w-0"><p className="text-[11px] font-medium text-muted-foreground">{t("modelSettings.endpoint")}</p><code className="mt-1 block truncate text-xs" title={provider.baseUrl}>{provider.baseUrl}</code>{provider.skipTlsVerify ? <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-400">{t("providerRegistration.tlsSkipped")}</p> : null}</div>
                    <div className="text-right"><p className="text-[11px] font-medium text-muted-foreground">{t("modelSettings.registeredModels")}</p><p className="mt-1 text-sm font-semibold">{providerModelCount}</p></div>
                  </div>
                  {administrator ? <Button type="button" variant="outline" className="h-11 w-full justify-between" disabled={pending} aria-label={`${t("modelSettings.manageProvider")} ${provider.name}`} onClick={() => setProviderTargetId(provider.id)}>{t("modelSettings.manageProvider")}<ChevronRight /></Button> : null}
                </article>;
              })}
            </div>
          ) : (
              <Table>
                <TableHeader><TableRow><TableHead className="pl-5">{t("modelSettings.provider")}</TableHead><TableHead>{t("modelSettings.endpoint")}</TableHead><TableHead>{t("modelSettings.registeredModels")}</TableHead><TableHead>{t("modelSettings.providerConnection")}</TableHead><TableHead className="pr-5 text-right">{t("modelSettings.actions")}</TableHead></TableRow></TableHeader>
                <TableBody>{view.providers.map((provider) => (
                  <TableRow key={provider.id}>
                    <TableCell className="pl-5"><div className="flex items-center gap-3"><ProviderMark provider={provider.name} kind={provider.kind} /><div><p className="font-medium">{provider.name}</p><p className="mt-0.5 text-xs text-muted-foreground">{provider.kind}</p></div></div></TableCell>
                    <TableCell><code className="block max-w-80 truncate text-xs text-muted-foreground" title={provider.baseUrl}>{provider.baseUrl}</code>{provider.skipTlsVerify ? <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-400">{t("providerRegistration.tlsSkipped")}</p> : null}</TableCell>
                    <TableCell>{view.models.filter((model) => model.providerId === provider.id).length}</TableCell>
                    <TableCell><ValidationEvidence kind="provider" status={provider.status} checkedAt={provider.validatedAt} latencyMs={provider.validationLatencyMs} message={provider.validationMessage} /></TableCell>
                    <TableCell className="pr-5 text-right">{administrator ? <Button type="button" variant="outline" className="h-11" disabled={pending} aria-label={`${t("modelSettings.manageProvider")} ${provider.name}`} onClick={() => setProviderTargetId(provider.id)}>{t("modelSettings.manageProvider")}<ChevronRight /></Button> : null}</TableCell>
                  </TableRow>
                ))}</TableBody>
              </Table>
          )
        ) : <EmptyResource>{t("modelSettings.noProviders")}</EmptyResource>}
      </ResourceSection> : null}

      {resource === "model" ? <ResourceSection
        title={t("modelSettings.models")}
        description={t("modelSettings.modelsDescription")}
        helpLabel={t("modelSettings.modelCallsHelp")}
        action={<div className="flex flex-wrap gap-2">
          <Button type="button" variant="testing" className="h-11" disabled={!administrator || pending || !ownedModels.length} onClick={() => void runBatchTest(ownedModels)}>
            {batchTest?.running ? <LoaderCircle className="animate-spin motion-reduce:animate-none" /> : <TestTube2 />}
            {t(batchTest?.running ? "modelSettings.testingAllModels" : "modelSettings.testAllModels", { done: batchTest?.results.length ?? 0, total: batchTest?.total ?? ownedModels.length })}
          </Button>
          <ModelProtocolSettings models={ownedModels} disabled={!administrator || pending} onChanged={onChanged} />
          <Button type="button" variant="create" className="h-11" disabled={!administrator} onClick={() => { setInitialProviderId(undefined); setCreateMode("model"); }}><Plus />{t("modelSettings.addModel")}</Button>
        </div>}
      >
        {batchTest ? <BatchTestReport
          run={batchTest}
          onDismiss={() => setBatchTest(null)}
          onRetestFailed={() => void runBatchTest(ownedModels.filter((model) => batchTest.results.some((result) => result.id === model.id && result.status === "failed")))}
        /> : null}
        {view.models.length ? (
          <Table className="min-w-[56rem] table-fixed">
            <colgroup><col className="w-[28%]" /><col className="w-[23%]" /><col /><col className="w-24" /><col className="w-24" /></colgroup>
            <TableHeader><TableRow><TableHead className="pl-5">{t("modelSettings.model")}</TableHead><TableHead>{t("modelSettings.providerConnection")}</TableHead><TableHead>{t("modelSettings.modelCall")}</TableHead><TableHead className="text-right">{t("modelSettings.maxConcurrency")}</TableHead><TableHead className="pr-5 text-right">{t("modelSettings.actions")}</TableHead></TableRow></TableHeader>
            <TableBody>{view.models.map((model) => {
              const provider = view.providers.find((item) => item.id === model.providerId);
              return (
                <TableRow key={model.id}>
                  <TableCell className="pl-5"><div><p className="font-medium">{model.name}</p><code className="mt-1 block max-w-80 truncate text-xs text-muted-foreground" title={model.model}>{model.model}</code></div></TableCell>
                  <TableCell><div className="flex items-start gap-3"><ProviderMark provider={model.providerName} kind={model.providerKind} model={model.model} /><div><p className="mb-1.5 font-medium">{model.providerName}</p>{provider ? <ValidationEvidence kind="provider" status={provider.status} checkedAt={provider.validatedAt} latencyMs={provider.validationLatencyMs} message={provider.validationMessage} /> : <StateBadge state="unavailable" label={t("modelSettings.providerUnavailable")} />}</div></div></TableCell>
                  <TableCell><ModelCallEvidence model={model} checking={isTesting(model.id)} /></TableCell>
                  <TableCell className="text-right tabular-nums">{model.maxConcurrency ?? 2}</TableCell>
                  <TableCell className="pr-5">{ownsModel(model) ? <ResourceActions kind="model" name={model.name} checking={isTesting(model.id)} pending={pending || !administrator} onRetest={() => probeMutation.mutate({ id: model.id })} onRemove={() => setRemoveTarget({ id: model.id, name: model.name })} /> : null}</TableCell>
                </TableRow>
              );
            })}</TableBody>
          </Table>
        ) : <EmptyResource>{t("modelSettings.noModels")}</EmptyResource>}
      </ResourceSection> : null}

      {createMode ? <RegisterModelsDrawer intent={createMode === "provider" ? "add-provider" : "register-models"} initialProviderId={initialProviderId} open onOpenChange={(open) => { if (!open) setCreateMode(null); }} allowProviderCreation={administrator} providers={view.providers} registeredModels={ownedModels} onChanged={onChanged} /> : null}
      {providerTarget ? <ProviderManagementSheet
        open
        provider={providerTarget}
        models={ownedModels}
        administrator={administrator}
        onChanged={onChanged}
        onOpenChange={(open) => { if (!open) setProviderTargetId(null); }}
        onRegisterModels={() => { setInitialProviderId(providerTarget.id); setCreateMode("model"); }}
      /> : null}
      <ConfirmationSheet
        open={Boolean(removeTarget)}
        onOpenChange={(next) => { if (!next && !deleteMutation.isPending) { setRemoveTarget(null); deleteMutation.reset(); } }}
        eyebrow={t("modelSettings.removeResourceEyebrow")}
        title={t("modelSettings.removeResourceTitle", { name: removeTarget?.name })}
        description={t("modelSettings.removeResourceDescription")}
        cancelLabel={t("common.cancel")}
        confirmLabel={t("common.remove")}
        pendingLabel={t("modelSettings.removingResource")}
        pending={deleteMutation.isPending}
        confirmDisabled={removalBlocked}
        variant="destructive"
        onConfirm={() => { if (removeTarget) deleteMutation.mutate(removeTarget); }}
      >
        {topicControlUse ? <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>{t("modelSettings.topicControlRemovalTitle")}</AlertTitle>
          <AlertDescription>{t("modelSettings.topicControlRemovalWarning", {
            scope: t(topicControlDraftUse && topicControlActiveUse
              ? "modelSettings.draftAndActiveConfiguration"
              : topicControlActiveUse
                ? "modelSettings.activeConfiguration"
                : "modelSettings.draftConfiguration"),
          })}</AlertDescription>
        </Alert> : <Alert variant="info">
          <ShieldCheck />
          <AlertTitle>{t("modelSettings.removalProtectionTitle")}</AlertTitle>
          <AlertDescription>{t("modelSettings.removalProtectionDescription")}</AlertDescription>
        </Alert>}
        {assignedTargets.length ? <section aria-labelledby="model-removal-assignments" className="rounded-lg border bg-card px-4 py-3">
          <h3 id="model-removal-assignments" className="text-sm font-semibold">{t("modelSettings.currentAssignments")}</h3>
          <div className="mt-2 flex flex-wrap gap-2">{assignedTargets.map(({ id, kind }) => (
            <Badge key={id} variant={id === "topic_control.input" ? "destructive" : "secondary"}>
              {kind === "controlPlane" ? t("modelSettings.controlPlaneModel") : capabilityTitle(t, capabilityBindingDefinitions.find((binding) => binding.id === id)!)}
            </Badge>
          ))}</div>
        </section> : null}
        {deleteMutation.error ? <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">{errorMessage(deleteMutation.error)}</p> : null}
      </ConfirmationSheet>
    </>
  );
}

function BatchTestReport({ run, onDismiss, onRetestFailed }: { run: BatchTestRun; onDismiss: () => void; onRetestFailed: () => void }) {
  const { t } = useTranslation();
  const failed = run.results.filter((result) => result.status === "failed");
  const passed = run.results.length - failed.length;
  const percent = run.total ? Math.round((run.results.length / run.total) * 100) : 0;
  return <section aria-label={t("modelSettings.batchTestReport")} className="border-b bg-muted/30 px-5 py-3" aria-live="polite">
    {run.running ? <div className="flex flex-wrap items-center gap-3">
      <LoaderCircle className="size-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      <p role="status" className="text-sm">{t("modelSettings.batchTestProgress", { name: run.current?.name ?? "", done: run.results.length, total: run.total })}</p>
      <div role="progressbar" aria-label={t("modelSettings.batchTestProgressLabel")} aria-valuemin={0} aria-valuemax={run.total} aria-valuenow={run.results.length}
        className="h-1.5 w-40 overflow-hidden rounded-full bg-border"><div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${percent}%` }} /></div>
    </div> : <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <p role="status" className={`text-sm font-medium ${failed.length ? "text-destructive" : "text-emerald-700 dark:text-emerald-400"}`}>
          {failed.length ? t("modelSettings.batchTestSummaryFailed", { passed, failed: failed.length }) : t("modelSettings.batchTestSummaryPassed", { count: passed })}
        </p>
        {failed.length ? <Button type="button" variant="ghost" size="sm" className="h-8 px-2" onClick={onRetestFailed}><RefreshCw className="size-4" />{t("modelSettings.batchTestRetestFailed", { count: failed.length })}</Button> : null}
        <Button type="button" variant="ghost" size="sm" className="h-8 px-2" onClick={onDismiss}>{t("modelSettings.batchTestDismiss")}</Button>
      </div>
      {failed.length ? <ul className="space-y-1 text-xs text-muted-foreground">{failed.map((result) => {
        const message = result.message && result.message.length > 160 ? `${result.message.slice(0, 160)}…` : result.message;
        return <li key={result.id} className="[overflow-wrap:anywhere]"><span className="font-medium text-foreground">{result.name}</span>{message ? <span> — {message}</span> : null}</li>;
      })}</ul> : null}
    </div>}
  </section>;
}

function ResourceSection({ title, description, helpLabel, action, children }: { title: string; description: string; helpLabel: string; action: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-6 overflow-hidden rounded-lg border bg-card">
      <div className="flex flex-col gap-3 border-b px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1"><h2 className="sr-only">{title}</h2><details className="text-xs leading-5 text-muted-foreground"><summary className="w-fit cursor-pointer py-2">{helpLabel}</summary><p className="pb-2">{description}</p></details></div>
        <div className="shrink-0">{action}</div>
      </div>
      {children}
    </section>
  );
}

function EmptyResource({ children }: { children: ReactNode }) {
  return <p className="m-5 rounded-lg border border-dashed p-5 text-sm text-muted-foreground">{children}</p>;
}

function ValidationEvidence({ kind, status, checkedAt, latencyMs, message }: {
  kind: "provider" | "model";
  status: "pending" | "validated" | "failed";
  checkedAt: string | null;
  latencyMs: number | null;
  message: string | null;
}) {
  const { t, i18n } = useTranslation();
  const state = status === "validated" ? (kind === "provider" ? "ready" : "passed") : status === "failed" ? "failed" : "not evaluated";
  const label = status === "validated"
    ? t(kind === "provider" ? "modelSettings.connected" : "modelSettings.probePassed")
    : status === "failed"
      ? t(kind === "provider" ? "modelSettings.connectionFailed" : "modelSettings.probeFailed")
      : t("modelSettings.notChecked");
  const checked = checkedAt ? new Date(checkedAt).toLocaleString(i18n.language, { dateStyle: "medium", timeStyle: "short" }) : null;
  return (
    <div className="min-w-36" title={message ?? undefined}>
      <StateBadge state={state} label={label} />
      {checked ? <time className="mt-1.5 block text-[11px] text-muted-foreground" dateTime={checkedAt ?? undefined}>{t("modelSettings.lastChecked", { time: checked, latency: latencyMs ?? "—" })}</time> : null}
    </div>
  );
}

function ResourceActions({ kind, name, pending, checking = false, onRetest, onRemove }: { kind: "provider" | "model"; name: string; pending: boolean; checking?: boolean; onRetest: () => void; onRemove: () => void }) {
  const { t } = useTranslation();
  return <ModelRowActions label={`${t("modelSettings.actions")} ${name}`} disabled={pending} busy={checking}>
    <DropdownMenuItem variant="testing" disabled={pending} onSelect={onRetest}><TestTube2 />{t(kind === "model" ? "modelSettings.testCall" : "modelSettings.retest")}</DropdownMenuItem>
    <DropdownMenuItem variant="destructive" disabled={pending} onSelect={onRemove}><Trash2 />{t("common.remove")}</DropdownMenuItem>
  </ModelRowActions>;
}

function ModelRowActions({ label, disabled, busy, children }: { label: string; disabled: boolean; busy?: boolean; children: ReactNode }) {
  return <div className="flex justify-end">
    <DropdownMenu>
      <DropdownMenuTrigger asChild><button type="button" aria-label={label} disabled={disabled} className="size-10">
        {busy ? <LoaderCircle className="size-4 animate-spin" /> : <EllipsisVertical className="size-4" />}
      </button></DropdownMenuTrigger>
      <DropdownMenuContent align="end">{children}</DropdownMenuContent>
    </DropdownMenu>
  </div>;
}

function ModelsSkeleton() {
  return <section className="py-8"><Skeleton className="h-10 w-72" /><Skeleton className="mt-3 h-5 w-full max-w-2xl" /><div className="mt-7 space-y-5">{Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-36" />)}</div></section>;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Request failed.";
}
