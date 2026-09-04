import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  CircleAlert,
  CloudCog,
  LoaderCircle,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  TestTube2,
  Trash2,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { ConfirmationSheet } from "@/components/confirmation-sheet";
import { ErrorNotice, PageHeader, StateBadge } from "@/components/product-shell";
import { SettingsNavigation } from "@/components/settings-navigation";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RegisterModelsDrawer } from "@/components/providers/register-models-drawer";
import { ProviderManagementSheet } from "@/components/providers/provider-management-sheet";
import { ProviderMark } from "@/components/providers/provider-mark";
import { ModelProtocolSettings } from "@/components/providers/model-protocol-settings";
import { ModelCallEvidence } from "@/components/providers/model-call-evidence";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useIsMobile } from "@/hooks/use-mobile";
import { useAuth } from "@/lib/auth";
import {
  activateModelConfiguration,
  deleteModelDefinition,
  getModelConfiguration,
  testModelConnection,
  rollbackModelConfiguration,
  saveModelAssignment,
  validateModelAssignment,
  type ModelAssignments,
  type ModelAssignmentTarget,
  type ModelConfigurationView,
  type ModelDefinition,
  type ModelDetectorType,
} from "@/lib/controller-api";
import {
  controlPlaneProfileRefs,
  detectorProfilePreference,
  detectorProfileRefs,
  guardrailCatalog,
  modelDetectorTypes,
  type GuardrailCategoryId,
} from "../../shared/guardrail-catalog";

const configurationKey = ["resources", "model-configuration"] as const;
const noneValue = "__none__";

export function ProvidersPage() {
  const { t } = useTranslation();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: configurationKey, queryFn: getModelConfiguration, refetchInterval: 10_000, retry: false });
  const administrator = auth.user?.role === "admin";
  const refresh = async () => { await queryClient.invalidateQueries({ queryKey: configurationKey }); };

  if (query.isLoading) return <ModelsSkeleton />;
  if (query.error || !query.data) {
    return <section className="py-8"><PageHeader title={t("modelSettings.providersTitle")} description={t("modelSettings.providersPageDescription")} /><div className="mt-6"><ErrorNotice error={query.error} /></div></section>;
  }

  return (
    <section className="py-6 sm:py-8">
      <PageHeader
        eyebrow={t("modelSettings.providersEyebrow")}
        title={t("modelSettings.providersTitle")}
        description={t("modelSettings.providersPageDescription")}
      />
      <SettingsNavigation />
      {!administrator ? (
        <Alert className="mt-6"><CircleAlert /><AlertTitle>{t("modelSettings.readOnly")}</AlertTitle><AlertDescription>{t("modelSettings.readOnlyDescription")}</AlertDescription></Alert>
      ) : null}
      <ResourceManagement resource="provider" view={query.data} administrator={administrator} onChanged={refresh} />
    </section>
  );
}

export function ModelsPage() {
  const { t } = useTranslation();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: configurationKey, queryFn: getModelConfiguration, refetchInterval: 10_000, retry: false });
  const administrator = auth.user?.role === "admin";
  const refresh = async () => { await queryClient.invalidateQueries({ queryKey: configurationKey }); };

  if (query.isLoading) return <ModelsSkeleton />;
  if (query.error || !query.data) {
    return <section className="py-8"><PageHeader title={t("modelSettings.title")} description={t("modelSettings.description")} /><div className="mt-6"><ErrorNotice error={query.error} /></div></section>;
  }

  return (
    <section className="py-6 sm:py-8">
      <PageHeader eyebrow={t("modelSettings.eyebrow")} title={t("modelSettings.title")} description={t("modelSettings.description")} />
      <SettingsNavigation />
      {!administrator ? (
        <Alert className="mt-6"><CircleAlert /><AlertTitle>{t("modelSettings.readOnly")}</AlertTitle><AlertDescription>{t("modelSettings.readOnlyDescription")}</AlertDescription></Alert>
      ) : null}
      <ResourceManagement resource="model" view={query.data} administrator={administrator} onChanged={refresh} />
    </section>
  );
}

export function GuardrailCatalogPage() {
  const { t } = useTranslation();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: configurationKey, queryFn: getModelConfiguration, refetchInterval: 10_000, retry: false });
  const [assignments, setAssignments] = useState<ModelAssignments | null>(null);
  const [pendingAction, setPendingAction] = useState<"activate" | "rollback" | null>(null);
  useEffect(() => {
    if (!query.data?.draft.assignments) return;
    setAssignments(structuredClone(query.data.draft.assignments));
  }, [query.data?.draft.id, query.data?.draft.updatedAt]);
  const dirty = Boolean(assignments && query.data && JSON.stringify(assignments) !== JSON.stringify(query.data.draft.assignments));
  const administrator = auth.user?.role === "admin";
  const refresh = async () => { await queryClient.invalidateQueries({ queryKey: configurationKey }); };
  const saveAssignmentMutation = useMutation({
    mutationFn: async ({ target, modelId }: { target: ModelAssignmentTarget; modelId: string | null }) => saveModelAssignment(target, modelId),
    onSuccess: async (revision) => { setAssignments(structuredClone(revision.assignments)); toast.success(t("modelSettings.assignmentSaved")); await refresh(); },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const validateAssignmentMutation = useMutation({
    mutationFn: validateModelAssignment,
    onSuccess: async (revision, target) => {
      const modelId = target === "control_plane" ? revision.assignments.controlPlane : revision.assignments.detectors[target];
      const passed = Boolean(modelId && revision.validationReport?.checks.some((check) => check.id === `probe:${target}:${modelId}` && check.status === "passed"));
      toast[passed ? "success" : "error"](t(passed ? "modelSettings.assignmentValidationPassed" : "modelSettings.assignmentValidationFailed"));
      await refresh();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const activateMutation = useMutation({
    mutationFn: async (revisionId: string) => activateModelConfiguration(revisionId),
    onSuccess: async (result) => {
      setPendingAction(null);
      toast[result.distribution.distributionStatus === "ready" ? "success" : "info"](
        t(result.distribution.distributionStatus === "ready" ? "modelSettings.activated" : "modelSettings.syncing"),
      );
      await refresh();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const rollbackMutation = useMutation({
    mutationFn: rollbackModelConfiguration,
    onSuccess: async () => { setPendingAction(null); toast.success(t("modelSettings.rollbackStarted")); await refresh(); },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const operationPending = activateMutation.isPending || rollbackMutation.isPending;

  if (query.isLoading) return <ModelsSkeleton />;
  if (query.error || !query.data) {
    return <section className="py-8"><PageHeader title={t("modelSettings.catalogTitle")} description={t("modelSettings.catalogPageDescription")} /><div className="mt-6"><ErrorNotice error={query.error} /></div></section>;
  }
  if (!assignments) return <ModelsSkeleton />;
  const report = query.data.draft.validationReport;
  const confirmationPending = activateMutation.isPending || rollbackMutation.isPending;
  const confirmationError = pendingAction === "activate"
        ? activateMutation.error
        : rollbackMutation.error;
  const closeConfirmation = () => {
    if (confirmationPending) return;
    activateMutation.reset();
    rollbackMutation.reset();
    setPendingAction(null);
  };
  const confirmPendingAction = () => {
    if (pendingAction === "activate") activateMutation.mutate(query.data.draft.id);
    if (pendingAction === "rollback") rollbackMutation.mutate();
  };

  return (
    <section className="py-6 sm:py-8">
      <PageHeader
        eyebrow={t("modelSettings.catalogEyebrow")}
        title={t("modelSettings.catalogTitle")}
        description={t("modelSettings.catalogPageDescription")}
        action={(
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              className="h-11"
              disabled={!administrator || operationPending || dirty || query.data.draft.state !== "validated" || !report?.valid}
              onClick={() => setPendingAction("activate")}
            >
              {activateMutation.isPending ? <LoaderCircle className="animate-spin" /> : <Play />}{t("modelSettings.activate")}
            </Button>
          </div>
        )}
      />
      <SettingsNavigation />

      {!administrator ? (
        <Alert className="mt-6"><CircleAlert /><AlertTitle>{t("modelSettings.readOnly")}</AlertTitle><AlertDescription>{t("modelSettings.readOnlyDescription")}</AlertDescription></Alert>
      ) : null}
      {query.data.activating ? (
        <Alert variant="info" className="mt-6"><RefreshCw className="animate-spin motion-reduce:animate-none" /><AlertTitle>{t("modelSettings.syncingTitle")}</AlertTitle><AlertDescription>{t("modelSettings.syncingDescription", { revision: query.data.activating.revision, generation: query.data.activating.generation })}</AlertDescription></Alert>
      ) : null}
      {query.data.failed?.failureReason ? (
        <Alert variant="destructive" className="mt-6"><CircleAlert /><AlertTitle>{t("modelSettings.activationFailed")}</AlertTitle><AlertDescription>{query.data.failed.failureReason}</AlertDescription></Alert>
      ) : null}

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">{t("modelSettings.draftRevision", { revision: query.data.draft.revision })}</span>
          <StateBadge state={query.data.draft.state} />
          {query.data.active ? <span className="text-muted-foreground">{t("modelSettings.activeRevision", { revision: query.data.active.revision })}</span> : <span className="text-muted-foreground">{t("modelSettings.noActiveRevision")}</span>}
          {dirty ? <Badge variant="secondary">{t("modelSettings.unsaved")}</Badge> : null}
        </div>
        <div className="flex gap-2">
          {query.data.active ? <Button type="button" variant="ghost" className="h-11" disabled={!administrator || operationPending} onClick={() => setPendingAction("rollback")}><RotateCcw />{t("modelSettings.rollback")}</Button> : null}
        </div>
      </div>

      <GuardrailCatalogSection
        assignments={assignments}
        models={query.data.models}
        report={report}
        savedAssignments={query.data.draft.assignments}
        disabled={!administrator || operationPending}
        savingTarget={saveAssignmentMutation.isPending ? saveAssignmentMutation.variables?.target ?? null : null}
        validatingTarget={validateAssignmentMutation.isPending ? validateAssignmentMutation.variables ?? null : null}
        onChange={(detectorType, modelId) => setAssignments({
          ...assignments,
          detectors: { ...assignments.detectors, [detectorType]: modelId },
        })}
        onSave={(target, modelId) => saveAssignmentMutation.mutate({ target, modelId })}
        onValidate={(target) => validateAssignmentMutation.mutate(target)}
      />
      <ControlPlaneSection
        models={query.data.models}
        selectedId={assignments.controlPlane}
        savedId={query.data.draft.assignments.controlPlane}
        report={report}
        disabled={!administrator || operationPending}
        saving={saveAssignmentMutation.isPending && saveAssignmentMutation.variables?.target === "control_plane"}
        validating={validateAssignmentMutation.isPending && validateAssignmentMutation.variables === "control_plane"}
        onChange={(controlPlane) => setAssignments({ ...assignments, controlPlane })}
        onSave={(modelId) => saveAssignmentMutation.mutate({ target: "control_plane", modelId })}
        onValidate={() => validateAssignmentMutation.mutate("control_plane")}
      />
      <ConfirmationSheet
        open={Boolean(pendingAction)}
        onOpenChange={(open) => { if (!open) closeConfirmation(); }}
        eyebrow={t("modelSettings.confirmChangeEyebrow")}
        title={t(`modelSettings.${pendingAction ?? "save"}ConfirmationTitle`)}
        description={t(`modelSettings.${pendingAction ?? "save"}ConfirmationDescription`)}
        cancelLabel={t("common.cancel")}
        confirmLabel={t(`modelSettings.${pendingAction ?? "save"}ConfirmationAction`)}
        pendingLabel={t("modelSettings.actionPending")}
        pending={confirmationPending}
        variant={pendingAction === "rollback" ? "warning" : "default"}
        onConfirm={confirmPendingAction}
      >
        <Alert variant={pendingAction === "rollback" ? "default" : "info"} className={pendingAction === "rollback" ? "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100" : undefined}>
          {pendingAction === "rollback" ? <CircleAlert /> : <ShieldCheck />}
          <AlertTitle>{t(`modelSettings.${pendingAction ?? "save"}ConfirmationSummary`)}</AlertTitle>
          <AlertDescription>{t(`modelSettings.${pendingAction ?? "save"}ConfirmationImpact`)}</AlertDescription>
        </Alert>
        {confirmationError ? <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">{errorMessage(confirmationError)}</p> : null}
      </ConfirmationSheet>
    </section>
  );
}

function ControlPlaneSection({ models, selectedId, savedId, report, disabled, saving, validating, onChange, onSave, onValidate }: {
  models: ModelDefinition[];
  selectedId: string | null;
  savedId: string | null;
  report: ModelConfigurationView["draft"]["validationReport"];
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
      <div className="flex items-start gap-3 border-b px-5 py-4">
        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><CloudCog className="size-5" /></span>
        <div><h2 id="control-plane-title" className="text-base font-semibold">{t("modelSettings.controlPlane")}</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">{t("modelSettings.controlPlaneDescription")}</p></div>
      </div>
      <div className="grid gap-4 px-5 py-5 lg:grid-cols-[minmax(13rem,0.7fr)_minmax(20rem,1.3fr)_minmax(10rem,0.7fr)_auto] lg:items-center">
        <div>
          <h3 className="text-sm font-semibold">{t("modelSettings.controlPlaneModel")}</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("modelSettings.controlPlaneModelDescription")}</p>
        </div>
        <div>
          <Label htmlFor="control-plane-model" className="sr-only">{t("modelSettings.assignedModel")}</Label>
          <Select value={selectedId ?? noneValue} disabled={disabled} onValueChange={(value) => onChange(value === noneValue ? null : value)}>
            <SelectTrigger id="control-plane-model" className="h-11 w-full"><SelectValue placeholder={t("modelSettings.notAssigned")} /></SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value={noneValue}>{t("modelSettings.notAssigned")}</SelectItem>
              {available.map((model) => <SelectItem key={model.id} value={model.id}><ModelOption model={model} /></SelectItem>)}
            </SelectContent>
          </Select>
          {selected ? <p className="mt-2 text-xs text-muted-foreground">{t("modelSettings.recommendedControlPlane")}</p> : null}
        </div>
        <AssignmentValidationStatus target="control_plane" model={selected} report={report} dirty={dirty} />
        <div className="flex flex-wrap gap-2 lg:justify-self-end">
          <Button type="button" variant="outline" className="h-11" disabled={disabled || !dirty || saving || validating} onClick={() => onSave(selectedId)}>{saving ? <LoaderCircle className="animate-spin" /> : <Save />}{t("modelSettings.saveAssignment")}</Button>
          <Button type="button" className="h-11" disabled={disabled || dirty || !selected || saving || validating} onClick={onValidate}>{validating ? <LoaderCircle className="animate-spin" /> : <TestTube2 />}{t("modelSettings.validateAssignment")}</Button>
        </div>
      </div>
    </section>
  );
}

function GuardrailCatalogSection({ assignments, savedAssignments, models, report, disabled, savingTarget, validatingTarget, onChange, onSave, onValidate }: {
  assignments: ModelAssignments;
  savedAssignments: ModelAssignments;
  models: ModelDefinition[];
  report: ModelConfigurationView["draft"]["validationReport"];
  disabled: boolean;
  savingTarget: ModelAssignmentTarget | null;
  validatingTarget: ModelAssignmentTarget | null;
  onChange: (detectorType: ModelDetectorType, modelId: string | null) => void;
  onSave: (detectorType: ModelDetectorType, modelId: string | null) => void;
  onValidate: (detectorType: ModelDetectorType) => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="mt-6 overflow-hidden rounded-lg border bg-card" aria-labelledby="guardrail-catalog-title">
      <div className="border-b px-5 py-4">
        <h2 id="guardrail-catalog-title" className="text-base font-semibold">{t("modelSettings.catalogConfiguration")}</h2>
        <p className="mt-1 max-w-4xl text-sm leading-6 text-muted-foreground">{t("modelSettings.catalogConfigurationDescription")}</p>
      </div>
      <Table className="table-fixed md:min-w-[56rem]">
        <TableHeader>
          <TableRow>
            <TableHead className="w-[42%] pl-5 md:w-[18%]">{t("modelSettings.categoryColumn")}</TableHead>
            <TableHead className="hidden w-[19%] md:table-cell">{t("modelSettings.detectorColumn")}</TableHead>
            <TableHead className="w-[58%] md:w-[30%]">{t("modelSettings.modelColumn")}</TableHead>
            <TableHead className="hidden w-[17%] md:table-cell">{t("modelSettings.validationColumn")}</TableHead>
            <TableHead className="hidden w-[16%] pr-5 text-right md:table-cell">{t("modelSettings.actionsColumn")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {guardrailCatalog.flatMap((category) => {
            if (!category.detectors.length) {
              const state = categoryExecutionState(category.id);
              return [<TableRow key={category.id} aria-label={t(`modelSettings.categories.${category.id}.title`)}>
                <TableCell className="whitespace-normal pl-5 font-medium" title={t(`modelSettings.categories.${category.id}.description`)}>
                  {t(`modelSettings.categories.${category.id}.title`)}
                  <span className="mt-1 block text-xs font-normal text-muted-foreground md:hidden">{t(`modelSettings.categoryStates.${state}.title`)}</span>
                </TableCell>
                <TableCell className="hidden md:table-cell" title={t(`modelSettings.categoryStates.${state}.description`)}>{t(`modelSettings.categoryStates.${state}.title`)}</TableCell>
                <TableCell className="whitespace-normal text-muted-foreground">{t("modelSettings.noModelBinding")}</TableCell>
                <TableCell className="hidden pr-5 text-muted-foreground md:table-cell">—</TableCell>
                <TableCell className="hidden pr-5 md:table-cell" />
              </TableRow>];
            }
            return category.detectors.map((detectorType) => {
              const modelId = assignments.detectors[detectorType];
              const selectedModel = models.find((model) => model.id === modelId);
              const preference = detectorProfilePreference[detectorType] as readonly string[];
              const compatibleModels = models
                .filter((model) => (detectorProfileRefs[detectorType] as readonly string[]).includes(model.profile))
                .sort((left, right) => preference.indexOf(left.profile) - preference.indexOf(right.profile) || left.name.localeCompare(right.name));
              const rowDirty = modelId !== savedAssignments.detectors[detectorType];
              const preferred = compatibleModels[0];
              return <TableRow key={detectorType} aria-label={t(`modelSettings.categories.${category.id}.title`)}>
                <TableCell className="whitespace-normal pl-5 font-medium" title={t(`modelSettings.categories.${category.id}.description`)}>
                  {t(`modelSettings.categories.${category.id}.title`)}
                  <span className="mt-1 block text-xs font-normal text-muted-foreground md:hidden">{t(`modelSettings.detectors.${detectorType}.title`)}</span>
                </TableCell>
                <TableCell className="hidden font-medium md:table-cell" title={t(`modelSettings.detectors.${detectorType}.description`)}>{t(`modelSettings.detectors.${detectorType}.title`)}</TableCell>
                <TableCell className="whitespace-normal">
                  <Label className="sr-only" htmlFor={`detector-model-${detectorType}`}>{t("modelSettings.modelColumn")}</Label>
                  <Select value={modelId ?? noneValue} disabled={disabled || !compatibleModels.length} onValueChange={(value) => onChange(detectorType, value === noneValue ? null : value)}>
                    <SelectTrigger id={`detector-model-${detectorType}`} className="h-11 w-full" title={!compatibleModels.length ? t("modelSettings.noCompatibleModels") : undefined}><SelectValue placeholder={t("modelSettings.selectModel")} /></SelectTrigger>
                    <SelectContent position="popper">
                      <SelectItem value={noneValue}>{t(compatibleModels.length ? "modelSettings.notAssigned" : "modelSettings.noCompatibleModelsShort")}</SelectItem>
                      {compatibleModels.map((model) => <SelectItem key={model.id} value={model.id}><ModelOption model={model} /></SelectItem>)}
                    </SelectContent>
                  </Select>
                  {preferred ? <p className="mt-2 text-xs text-muted-foreground">{t("modelSettings.recommendedModel", { name: preferred.name })}</p> : <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">{t("modelSettings.noCompatibleModelsHelp")}</p>}
                  <div className="mt-3 space-y-3 md:hidden"><AssignmentValidationStatus target={detectorType} model={selectedModel} report={report} dirty={rowDirty} /><AssignmentActions target={detectorType} modelId={modelId} dirty={rowDirty} disabled={disabled} saving={savingTarget === detectorType} validating={validatingTarget === detectorType} onSave={onSave} onValidate={onValidate} /></div>
                </TableCell>
                <TableCell className="hidden md:table-cell"><AssignmentValidationStatus target={detectorType} model={selectedModel} report={report} dirty={rowDirty} /></TableCell>
                <TableCell className="hidden pr-5 md:table-cell"><AssignmentActions target={detectorType} modelId={modelId} dirty={rowDirty} disabled={disabled} saving={savingTarget === detectorType} validating={validatingTarget === detectorType} onSave={onSave} onValidate={onValidate} /></TableCell>
              </TableRow>;
            });
          })}
        </TableBody>
      </Table>
    </section>
  );
}

function AssignmentValidationStatus({ target, model, report, dirty }: {
  target: ModelAssignmentTarget;
  model?: ModelDefinition;
  report: ModelConfigurationView["draft"]["validationReport"];
  dirty: boolean;
}) {
  const { t } = useTranslation();
  if (!model) return <StateBadge state="unconfigured" label={t("modelSettings.notAssigned")} />;
  if (dirty) return <StateBadge state="needs_validation" label={t("modelSettings.saveToValidate")} />;
  const result = report?.checks.find((check) => check.id === `probe:${target}:${model.id}`);
  if (result?.status === "passed") return <div><StateBadge state="ready" label={t("modelSettings.detectorValidated")} />{result.latencyMs ? <p className="mt-1 text-xs text-muted-foreground">{result.latencyMs} ms</p> : null}</div>;
  if (result?.status === "failed") return <div><StateBadge state="failed" label={t("modelSettings.probeFailed")} /><p className="mt-1 line-clamp-2 max-w-xs text-xs leading-5 text-destructive" title={result.message}>{result.message}</p></div>;
  return <StateBadge state="needs_validation" label={t("modelSettings.notChecked")} />;
}

function AssignmentActions({ target, modelId, dirty, disabled, saving, validating, onSave, onValidate }: {
  target: ModelDetectorType;
  modelId: string | null;
  dirty: boolean;
  disabled: boolean;
  saving: boolean;
  validating: boolean;
  onSave: (target: ModelDetectorType, modelId: string | null) => void;
  onValidate: (target: ModelDetectorType) => void;
}) {
  const { t } = useTranslation();
  return <div className="flex flex-col items-stretch justify-end gap-2 2xl:flex-row">
    <Button type="button" variant="outline" className="h-10" disabled={disabled || !dirty || saving || validating} onClick={() => onSave(target, modelId)}>{saving ? <LoaderCircle className="animate-spin" /> : <Save />}{t("modelSettings.saveAssignment")}</Button>
    <Button type="button" className="h-10" disabled={disabled || dirty || !modelId || saving || validating} onClick={() => onValidate(target)}>{validating ? <LoaderCircle className="animate-spin" /> : <TestTube2 />}{t("modelSettings.validateAssignment")}</Button>
  </div>;
}

function categoryExecutionState(category: GuardrailCategoryId): "policy" | "service" | "notAvailable" {
  if (category === "agentic_security" || category === "tool_calling") return "policy";
  if (category === "third_party_apis") return "service";
  return "notAvailable";
}

function ModelOption({ model }: { model: ModelDefinition }) {
  return <span className="flex min-w-0 items-center gap-2"><ProviderMark provider={model.providerName} kind={model.providerKind} model={model.model} size="sm" /><span className="truncate">{model.name} · {model.providerName}</span></span>;
}

function ResourceManagement({ resource, view, administrator, onChanged }: { resource: "provider" | "model"; view: ModelConfigurationView; administrator: boolean; onChanged: () => Promise<void> }) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const [createMode, setCreateMode] = useState<"provider" | "model" | null>(null);
  const [initialProviderId, setInitialProviderId] = useState<string>();
  const [providerTargetId, setProviderTargetId] = useState<string | null>(null);
  const [probeTarget, setProbeTarget] = useState<{ id: string; name: string } | null>(null);
  const [removeTarget, setRemoveTarget] = useState<{ id: string; name: string } | null>(null);
  const providerTarget = view.providers.find((provider) => provider.id === providerTargetId) ?? null;
  const probeMutation = useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      const result = await testModelConnection(id);
      return { passed: result.connectionStatus === "validated", message: result.connectionMessage };
    },
    onSuccess: async (result) => {
      setProbeTarget(null);
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
  const pending = probeMutation.isPending || deleteMutation.isPending;
  const removalModelIds = new Set(removeTarget ? [removeTarget.id] : []);
  const topicControlDraftUse = Boolean(view.draft.assignments.detectors.topic_control && removalModelIds.has(view.draft.assignments.detectors.topic_control));
  const topicControlActiveUse = Boolean(view.active?.assignments.detectors.topic_control && removalModelIds.has(view.active.assignments.detectors.topic_control));
  const topicControlUse = topicControlDraftUse || topicControlActiveUse;
  const assignmentTargets: Array<{ id: "control_plane" | ModelDetectorType; kind: "controlPlane" | "detector" }> = [
    { id: "control_plane", kind: "controlPlane" },
    ...modelDetectorTypes.map((id) => ({ id, kind: "detector" as const })),
  ];
  const assignedTargets = assignmentTargets.filter(({ id }) => {
    const draftModelId = id === "control_plane" ? view.draft.assignments.controlPlane : view.draft.assignments.detectors[id];
    const activeModelId = id === "control_plane" ? view.active?.assignments.controlPlane : view.active?.assignments.detectors[id];
    return Boolean((draftModelId && removalModelIds.has(draftModelId)) || (activeModelId && removalModelIds.has(activeModelId)));
  });
  const removalBlocked = assignedTargets.length > 0;
  return (
    <>
      {resource === "provider" ? <ResourceSection
        title={t("modelSettings.providers")}
        description={t("modelSettings.providersDescription")}
        action={<Button type="button" variant="outline" className="h-11" disabled={!administrator} onClick={() => { setInitialProviderId(undefined); setCreateMode("provider"); }}><Plus />{t("modelSettings.addProvider")}</Button>}
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
                  <Button type="button" variant="outline" className="h-11 w-full justify-between" disabled={!administrator || pending} aria-label={`${t("modelSettings.manageProvider")} ${provider.name}`} onClick={() => setProviderTargetId(provider.id)}>{t("modelSettings.manageProvider")}<ChevronRight /></Button>
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
                    <TableCell className="pr-5 text-right"><Button type="button" variant="outline" className="h-11" disabled={!administrator || pending} aria-label={`${t("modelSettings.manageProvider")} ${provider.name}`} onClick={() => setProviderTargetId(provider.id)}>{t("modelSettings.manageProvider")}<ChevronRight /></Button></TableCell>
                  </TableRow>
                ))}</TableBody>
              </Table>
          )
        ) : <EmptyResource>{t("modelSettings.noProviders")}</EmptyResource>}
      </ResourceSection> : null}

      {resource === "model" ? <ResourceSection
        title={t("modelSettings.models")}
        description={t("modelSettings.modelsDescription")}
        action={<div className="flex flex-wrap gap-2"><ModelProtocolSettings models={view.models} disabled={!administrator || pending} onChanged={onChanged} /><Button type="button" variant="outline" className="h-11" disabled={!administrator} onClick={() => { setInitialProviderId(undefined); setCreateMode("model"); }}><Plus />{t("modelSettings.addModel")}</Button></div>}
      >
        {view.models.length ? (
          <Table className="min-w-[56rem] table-fixed">
            <colgroup><col className="w-[32%]" /><col className="w-[24%]" /><col /><col className="w-48" /></colgroup>
            <TableHeader><TableRow><TableHead className="pl-5">{t("modelSettings.model")}</TableHead><TableHead>{t("modelSettings.providerConnection")}</TableHead><TableHead>{t("modelSettings.modelCall")}</TableHead><TableHead className="pr-5 text-right">{t("modelSettings.actions")}</TableHead></TableRow></TableHeader>
            <TableBody>{view.models.map((model) => {
              const provider = view.providers.find((item) => item.id === model.providerId);
              return (
                <TableRow key={model.id}>
                  <TableCell className="pl-5"><div><p className="font-medium">{model.name}</p><code className="mt-1 block max-w-80 truncate text-xs text-muted-foreground" title={model.model}>{model.model}</code></div></TableCell>
                  <TableCell><div className="flex items-start gap-3"><ProviderMark provider={model.providerName} kind={model.providerKind} model={model.model} /><div><p className="mb-1.5 font-medium">{model.providerName}</p>{provider ? <ValidationEvidence kind="provider" status={provider.status} checkedAt={provider.validatedAt} latencyMs={provider.validationLatencyMs} message={provider.validationMessage} /> : <StateBadge state="unavailable" label={t("modelSettings.providerUnavailable")} />}</div></div></TableCell>
                  <TableCell><ModelCallEvidence model={model} checking={probeMutation.isPending && probeMutation.variables?.id === model.id} /></TableCell>
                  <TableCell className="pr-5"><ResourceActions kind="model" name={model.name} checking={probeMutation.isPending && probeMutation.variables?.id === model.id} pending={pending || !administrator} onRetest={() => setProbeTarget({ id: model.id, name: model.name })} onRemove={() => setRemoveTarget({ id: model.id, name: model.name })} /></TableCell>
                </TableRow>
              );
            })}</TableBody>
          </Table>
        ) : <EmptyResource>{t("modelSettings.noModels")}</EmptyResource>}
      </ResourceSection> : null}

      {createMode ? <RegisterModelsDrawer intent={createMode === "provider" ? "add-provider" : "register-models"} initialProviderId={initialProviderId} open onOpenChange={(open) => { if (!open) setCreateMode(null); }} providers={view.providers} registeredModels={view.models} onChanged={onChanged} /> : null}
      {providerTarget ? <ProviderManagementSheet
        open
        provider={providerTarget}
        models={view.models}
        administrator={administrator}
        onChanged={onChanged}
        onOpenChange={(open) => { if (!open) setProviderTargetId(null); }}
        onRegisterModels={() => { setInitialProviderId(providerTarget.id); setCreateMode("model"); }}
      /> : null}
      <ConfirmationSheet
        open={Boolean(probeTarget)}
        onOpenChange={(next) => {
          if (!next && !probeMutation.isPending) {
            setProbeTarget(null);
            probeMutation.reset();
          }
        }}
        eyebrow={t("modelSettings.confirmValidationEyebrow")}
        title={t("modelSettings.modelTestConfirmationTitle", { name: probeTarget?.name ?? "" })}
        description={t("modelSettings.modelTestConfirmationDescription")}
        cancelLabel={t("common.cancel")}
        confirmLabel={t("modelSettings.modelTestConfirmationAction")}
        pendingLabel={t("modelSettings.testingCall")}
        pending={probeMutation.isPending}
        confirmIcon={<TestTube2 />}
        onConfirm={() => { if (probeTarget) probeMutation.mutate({ id: probeTarget.id }); }}
      >
        <Alert variant="info">
          <TestTube2 />
          <AlertTitle>{t("modelSettings.modelTestConfirmationSummary")}</AlertTitle>
          <AlertDescription>{t("modelSettings.modelTestConfirmationImpact")}</AlertDescription>
        </Alert>
        {probeMutation.error ? <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">{errorMessage(probeMutation.error)}</p> : null}
      </ConfirmationSheet>
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
            <Badge key={id} variant={id === "topic_control" ? "destructive" : "secondary"}>
              {kind === "controlPlane" ? t("modelSettings.controlPlaneModel") : t(`modelSettings.detectors.${id}.title`)}
            </Badge>
          ))}</div>
        </section> : null}
        {deleteMutation.error ? <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">{errorMessage(deleteMutation.error)}</p> : null}
      </ConfirmationSheet>
    </>
  );
}

function ResourceSection({ title, description, action, children }: { title: string; description: string; action: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-6 overflow-hidden rounded-lg border bg-card">
      <div className="flex flex-col gap-3 border-b px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div><h2 className="text-base font-semibold">{title}</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">{description}</p></div>
        {action}
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
  return (
    <div className="flex justify-end gap-1">
      <Button type="button" variant={kind === "model" ? "outline" : "ghost"} className="h-11 min-w-11" aria-label={`${t(kind === "model" ? "modelSettings.testCall" : "modelSettings.retest")} ${name}`} disabled={pending} onClick={onRetest}>{checking ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}{kind === "model" ? t("modelSettings.testCall") : null}</Button>
      <Button type="button" size="icon-sm" className="size-11" variant="ghost" aria-label={`${t("common.remove")} ${name}`} disabled={pending} onClick={onRemove}><Trash2 /></Button>
    </div>
  );
}


function ModelsSkeleton() {
  return <section className="py-8"><Skeleton className="h-10 w-72" /><Skeleton className="mt-3 h-5 w-full max-w-2xl" /><div className="mt-7 space-y-5">{Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-36" />)}</div></section>;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Request failed.";
}
