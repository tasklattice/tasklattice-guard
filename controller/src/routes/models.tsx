import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
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
import { ProviderMark } from "@/components/providers/provider-mark";
import { ModelProtocolSettings } from "@/components/providers/model-protocol-settings";
import { ProviderTlsSettings } from "@/components/providers/provider-tls-settings";
import { ModelCallEvidence } from "@/components/providers/model-call-evidence";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuth } from "@/lib/auth";
import {
  activateModelConfiguration,
  deleteModelDefinition,
  deleteModelProvider,
  getModelConfiguration,
  revalidateModelDefinition,
  testModelConnection,
  revalidateModelProvider,
  rollbackModelConfiguration,
  saveModelAssignments,
  validateModelConfiguration,
  type ModelAssignments,
  type ModelConfigurationView,
  type ModelDefinition,
  type ModelDetectorType,
} from "@/lib/controller-api";
import {
  controlPlaneProfileRefs,
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
  const [pendingAction, setPendingAction] = useState<"save" | "activate" | "rollback" | null>(null);
  useEffect(() => {
    if (!query.data?.draft.assignments) return;
    setAssignments(structuredClone(query.data.draft.assignments));
  }, [query.data?.draft.id, query.data?.draft.updatedAt]);
  const dirty = Boolean(assignments && query.data && JSON.stringify(assignments) !== JSON.stringify(query.data.draft.assignments));
  const administrator = auth.user?.role === "admin";
  const refresh = async () => { await queryClient.invalidateQueries({ queryKey: configurationKey }); };
  const saveMutation = useMutation({
    mutationFn: async () => saveModelAssignments(assignments!),
    onSuccess: async () => { setPendingAction(null); toast.success(t("modelSettings.saved")); await refresh(); },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const validateMutation = useMutation({
    mutationFn: validateModelConfiguration,
    onSuccess: async (revision) => {
      toast[revision.validationReport?.valid ? "success" : "error"](
        t(revision.validationReport?.valid ? "modelSettings.validationPassed" : "modelSettings.validationFailed"),
      );
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
  const probeModelMutation = useMutation({
    mutationFn: revalidateModelDefinition,
    onSuccess: async (model) => {
      toast[model.status === "validated" ? "success" : "error"](
        model.status === "validated"
          ? t("modelSettings.connectionRetested")
          : model.validationMessage ?? t("modelSettings.modelValidationFailed"),
      );
      await refresh();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const operationPending = saveMutation.isPending || validateMutation.isPending || activateMutation.isPending || rollbackMutation.isPending;

  if (query.isLoading) return <ModelsSkeleton />;
  if (query.error || !query.data) {
    return <section className="py-8"><PageHeader title={t("modelSettings.catalogTitle")} description={t("modelSettings.catalogPageDescription")} /><div className="mt-6"><ErrorNotice error={query.error} /></div></section>;
  }
  if (!assignments) return <ModelsSkeleton />;
  const report = query.data.draft.validationReport;
  const confirmationPending = saveMutation.isPending || activateMutation.isPending || rollbackMutation.isPending;
  const confirmationError = pendingAction === "save" ? saveMutation.error : pendingAction === "activate" ? activateMutation.error : rollbackMutation.error;
  const closeConfirmation = () => {
    if (confirmationPending) return;
    saveMutation.reset();
    activateMutation.reset();
    rollbackMutation.reset();
    setPendingAction(null);
  };
  const confirmPendingAction = () => {
    if (pendingAction === "save") saveMutation.mutate();
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
            <Button type="button" variant="outline" className="h-11" title={dirty ? t("modelSettings.saveBeforeValidation") : undefined} disabled={!administrator || operationPending || dirty} onClick={() => validateMutation.mutate()}>
              {validateMutation.isPending ? <LoaderCircle className="animate-spin" /> : <TestTube2 />}{t("modelSettings.validateCatalog")}
            </Button>
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
          <Button type="button" variant="outline" className="h-11" disabled={!administrator || !dirty || operationPending} onClick={() => setPendingAction("save")}>
            {saveMutation.isPending ? <LoaderCircle className="animate-spin" /> : <Save />}{t("modelSettings.saveDraft")}
          </Button>
        </div>
      </div>

      <GuardrailCatalogSection
        assignments={assignments}
        models={query.data.models}
        report={report}
        dirty={dirty}
        disabled={!administrator || operationPending}
        onChange={(detectorType, modelId) => setAssignments({
          ...assignments,
          detectors: { ...assignments.detectors, [detectorType]: modelId },
        })}
      />
      <ControlPlaneSection
        models={query.data.models}
        selectedId={assignments.controlPlane}
        disabled={!administrator || operationPending}
        probing={Boolean(probeModelMutation.isPending && probeModelMutation.variables === assignments.controlPlane)}
        onChange={(controlPlane) => setAssignments({ ...assignments, controlPlane })}
        onValidate={(modelId) => probeModelMutation.mutate(modelId)}
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

function ControlPlaneSection({ models, selectedId, disabled, probing, onChange, onValidate }: {
  models: ModelDefinition[];
  selectedId: string | null;
  disabled: boolean;
  probing: boolean;
  onChange: (value: string | null) => void;
  onValidate: (modelId: string) => void;
}) {
  const { t } = useTranslation();
  const available = models.filter((model) => controlPlaneProfileRefs.includes(model.profile as "generic-chat"));
  const selected = available.find((model) => model.id === selectedId);
  return (
    <section className="mt-6 overflow-hidden rounded-lg border bg-card" aria-labelledby="control-plane-title">
      <div className="flex items-start gap-3 border-b px-5 py-4">
        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><CloudCog className="size-5" /></span>
        <div><h2 id="control-plane-title" className="text-base font-semibold">{t("modelSettings.controlPlane")}</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">{t("modelSettings.controlPlaneDescription")}</p></div>
      </div>
      <div className="grid gap-4 px-5 py-5 lg:grid-cols-[minmax(13rem,0.7fr)_minmax(20rem,1.3fr)_auto] lg:items-center">
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
        </div>
        <Button type="button" variant="outline" className="h-11 justify-self-start lg:justify-self-end" disabled={disabled || !selected || probing} onClick={() => selected && onValidate(selected.id)}>
          {probing ? <LoaderCircle className="animate-spin" /> : <TestTube2 />}{t("modelSettings.validateModel")}
        </Button>
      </div>
    </section>
  );
}

function GuardrailCatalogSection({ assignments, models, report, dirty, disabled, onChange }: {
  assignments: ModelAssignments;
  models: ModelDefinition[];
  report: ModelConfigurationView["draft"]["validationReport"];
  dirty: boolean;
  disabled: boolean;
  onChange: (detectorType: ModelDetectorType, modelId: string | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="mt-6 overflow-hidden rounded-lg border bg-card" aria-labelledby="guardrail-catalog-title">
      <div className="border-b px-5 py-4">
        <h2 id="guardrail-catalog-title" className="text-base font-semibold">{t("modelSettings.catalogConfiguration")}</h2>
        <p className="mt-1 max-w-4xl text-sm leading-6 text-muted-foreground">{t("modelSettings.catalogConfigurationDescription")}</p>
      </div>
      <Table className="table-fixed md:min-w-[58rem]">
        <TableHeader>
          <TableRow>
            <TableHead className="w-[42%] pl-5 md:w-[22%]">{t("modelSettings.categoryColumn")}</TableHead>
            <TableHead className="hidden w-[24%] md:table-cell">{t("modelSettings.detectorColumn")}</TableHead>
            <TableHead className="w-[58%] md:w-[36%]">{t("modelSettings.modelColumn")}</TableHead>
            <TableHead className="hidden w-[18%] pr-5 md:table-cell">{t("modelSettings.validationColumn")}</TableHead>
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
              </TableRow>];
            }
            return category.detectors.map((detectorType) => {
              const modelId = assignments.detectors[detectorType];
              const selectedModel = models.find((model) => model.id === modelId);
              const compatibleModels = models.filter((model) => (detectorProfileRefs[detectorType] as readonly string[]).includes(model.profile));
              return <TableRow key={detectorType} aria-label={t(`modelSettings.categories.${category.id}.title`)}>
                <TableCell className="whitespace-normal pl-5 font-medium" title={t(`modelSettings.categories.${category.id}.description`)}>
                  {t(`modelSettings.categories.${category.id}.title`)}
                  <span className="mt-1 block text-xs font-normal text-muted-foreground md:hidden">{t(`modelSettings.detectors.${detectorType}.title`)}</span>
                </TableCell>
                <TableCell className="hidden font-medium md:table-cell" title={t(`modelSettings.detectors.${detectorType}.description`)}>{t(`modelSettings.detectors.${detectorType}.title`)}</TableCell>
                <TableCell>
                  <Label className="sr-only" htmlFor={`detector-model-${detectorType}`}>{t("modelSettings.modelColumn")}</Label>
                  <Select value={modelId ?? noneValue} disabled={disabled || !compatibleModels.length} onValueChange={(value) => onChange(detectorType, value === noneValue ? null : value)}>
                    <SelectTrigger id={`detector-model-${detectorType}`} className="h-11 w-full" title={!compatibleModels.length ? t("modelSettings.noCompatibleModels") : undefined}><SelectValue placeholder={t("modelSettings.selectModel")} /></SelectTrigger>
                    <SelectContent position="popper">
                      <SelectItem value={noneValue}>{t(compatibleModels.length ? "modelSettings.notAssigned" : "modelSettings.noCompatibleModelsShort")}</SelectItem>
                      {compatibleModels.map((model) => <SelectItem key={model.id} value={model.id}><ModelOption model={model} /></SelectItem>)}
                    </SelectContent>
                  </Select>
                  <div className="mt-1 md:hidden"><DetectorValidationStatus detectorType={detectorType} model={selectedModel} report={report} dirty={dirty} /></div>
                </TableCell>
                <TableCell className="hidden pr-5 md:table-cell"><DetectorValidationStatus detectorType={detectorType} model={selectedModel} report={report} dirty={dirty} /></TableCell>
              </TableRow>;
            });
          })}
        </TableBody>
      </Table>
    </section>
  );
}

function DetectorValidationStatus({ detectorType, model, report, dirty }: {
  detectorType: ModelDetectorType;
  model?: ModelDefinition;
  report: ModelConfigurationView["draft"]["validationReport"];
  dirty: boolean;
}) {
  const { t } = useTranslation();
  if (!model) return <StateBadge state="unconfigured" label={t("modelSettings.notAssigned")} />;
  if (dirty) return <StateBadge state="needs_validation" label={t("modelSettings.saveToValidate")} />;
  const result = report?.checks.find((check) => check.id === `probe:${detectorType}:${model.id}`);
  if (result?.status === "passed") return <StateBadge state="ready" label={t("modelSettings.detectorValidated")} />;
  if (result?.status === "failed") return <StateBadge state="failed" label={t("modelSettings.probeFailed")} />;
  return <StateBadge state="needs_validation" label={t("modelSettings.notChecked")} />;
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
  const [createMode, setCreateMode] = useState<"provider" | "model" | null>(null);
  const [initialProviderId, setInitialProviderId] = useState<string>();
  const [removeTarget, setRemoveTarget] = useState<{ kind: "provider" | "model"; id: string; name: string } | null>(null);
  const probeMutation = useMutation({
    mutationFn: async ({ kind, id }: { kind: "provider" | "model"; id: string }) => {
      if (kind === "provider") {
        const result = await revalidateModelProvider(id);
        return { passed: result.status === "validated", message: result.validationMessage };
      }
      const result = await testModelConnection(id);
      return { passed: result.connectionStatus === "validated", message: result.connectionMessage };
    },
    onSuccess: async (result, variables) => {
      toast[result.passed ? "success" : "error"](result.passed
        ? t(variables.kind === "provider" ? "modelSettings.connectionRetested" : "modelSettings.callPassed")
        : result.message ?? t("modelSettings.callFailed"));
      await onChanged();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const deleteMutation = useMutation({
    mutationFn: async (target: { kind: "provider" | "model"; id: string }) => target.kind === "provider" ? deleteModelProvider(target.id) : deleteModelDefinition(target.id),
    onSuccess: async () => { setRemoveTarget(null); toast.success(t("modelSettings.resourceRemoved")); await onChanged(); },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const pending = probeMutation.isPending || deleteMutation.isPending;
  const removalModelIds = new Set(removeTarget
    ? removeTarget.kind === "model"
      ? [removeTarget.id]
      : view.models.filter((model) => model.providerId === removeTarget.id).map((model) => model.id)
    : []);
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
  const removalBlocked = assignedTargets.length > 0 || Boolean(removeTarget?.kind === "provider" && removalModelIds.size > 0);
  return (
    <>
      {resource === "provider" ? <ResourceSection
        title={t("modelSettings.providers")}
        description={t("modelSettings.providersDescription")}
        action={<Button type="button" variant="outline" className="h-11" disabled={!administrator} onClick={() => { setInitialProviderId(undefined); setCreateMode("provider"); }}><Plus />{t("modelSettings.addProvider")}</Button>}
      >
        {view.providers.length ? (
          <Table>
            <TableHeader><TableRow><TableHead className="pl-5">{t("modelSettings.provider")}</TableHead><TableHead>{t("modelSettings.endpoint")}</TableHead><TableHead>{t("modelSettings.registeredModels")}</TableHead><TableHead>{t("modelSettings.providerConnection")}</TableHead><TableHead className="pr-5 text-right">{t("modelSettings.actions")}</TableHead></TableRow></TableHeader>
            <TableBody>{view.providers.map((provider) => (
              <TableRow key={provider.id}>
                <TableCell className="pl-5"><div className="flex items-center gap-3"><ProviderMark provider={provider.name} kind={provider.kind} /><div><p className="font-medium">{provider.name}</p><p className="mt-0.5 text-xs text-muted-foreground">{provider.kind}</p></div></div></TableCell>
                <TableCell><code className="block max-w-80 truncate text-xs text-muted-foreground" title={provider.baseUrl}>{provider.baseUrl}</code>{provider.skipTlsVerify ? <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-400">{t("providerRegistration.tlsSkipped")}</p> : null}</TableCell>
                <TableCell>{view.models.filter((model) => model.providerId === provider.id).length}</TableCell>
                <TableCell><ValidationEvidence kind="provider" status={provider.status} checkedAt={provider.validatedAt} latencyMs={provider.validationLatencyMs} message={provider.validationMessage} /></TableCell>
                <TableCell className="pr-5"><div className="flex justify-end gap-1"><ProviderTlsSettings provider={provider} disabled={!administrator || pending} onChanged={onChanged} /><Button type="button" variant="outline" className="h-11" disabled={!administrator || pending} onClick={() => { setInitialProviderId(provider.id); setCreateMode("model"); }}><Plus />{t("providerRegistration.registerModels")}</Button><ResourceActions kind="provider" name={provider.name} pending={pending || !administrator} onRetest={() => probeMutation.mutate({ kind: "provider", id: provider.id })} onRemove={() => setRemoveTarget({ kind: "provider", id: provider.id, name: provider.name })} /></div></TableCell>
              </TableRow>
            ))}</TableBody>
          </Table>
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
                  <TableCell className="pr-5"><ResourceActions kind="model" name={model.name} checking={probeMutation.isPending && probeMutation.variables?.id === model.id} pending={pending || !administrator} onRetest={() => probeMutation.mutate({ kind: "model", id: model.id })} onRemove={() => setRemoveTarget({ kind: "model", id: model.id, name: model.name })} /></TableCell>
                </TableRow>
              );
            })}</TableBody>
          </Table>
        ) : <EmptyResource>{t("modelSettings.noModels")}</EmptyResource>}
      </ResourceSection> : null}

      {createMode ? <RegisterModelsDrawer intent={createMode === "provider" ? "add-provider" : "register-models"} initialProviderId={initialProviderId} open onOpenChange={(open) => { if (!open) setCreateMode(null); }} providers={view.providers} registeredModels={view.models} onChanged={onChanged} /> : null}
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
        {removeTarget?.kind === "provider" ? <p className="rounded-lg border bg-muted/35 px-4 py-3 text-sm leading-6 text-muted-foreground">{t("modelSettings.providerRemovalModelCount", { count: removalModelIds.size })}</p> : null}
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
