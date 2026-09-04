import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  BrainCircuit,
  CircleAlert,
  CloudCog,
  Database,
  Gauge,
  LoaderCircle,
  ListChecks,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Server,
  ShieldAlert,
  ShieldCheck,
  TestTube2,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { ConfirmationSheet } from "@/components/confirmation-sheet";
import { ErrorNotice, PageHeader, StateBadge } from "@/components/product-shell";
import { SettingsNavigation } from "@/components/settings-navigation";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { MultiSelectCombobox, type MultiSelectOption } from "@/components/ui/multi-select-combobox";
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
  type ModelProfile,
  type ModelRole,
} from "@/lib/controller-api";
import { cn } from "@/lib/utils";

const configurationKey = ["resources", "model-configuration"] as const;
const noneValue = "__none__";

const roles: Array<{
  role: ModelRole;
  plane: "control" | "data";
  icon: typeof Bot;
  profiles: ModelProfile[];
}> = [
  { role: "control_plane", plane: "control", icon: Bot, profiles: ["generic-chat"] },
  { role: "safety_evaluator", plane: "data", icon: ShieldCheck, profiles: ["tali.qwen3guard.v1", "tali.llama-guard-3.v1", "tali.nemotron-content-safety.v1", "tali.nemotron-safety-guard-v3.v1"] },
  { role: "jailbreak_evaluator", plane: "data", icon: ShieldAlert, profiles: ["tali.qwen3guard.v1", "tali.openai-compatible-jailbreak.v1", "tali.nemoguard-jailbreak-detect.v1"] },
  { role: "topic_policy_judge", plane: "data", icon: BrainCircuit, profiles: ["tali.taxonomy-judge.v1", "tali.nemoguard-topic-control.v1"] },
  { role: "grounding_judge", plane: "data", icon: Database, profiles: ["tali.grounding-judge.v1"] },
  { role: "automated_reasoning", plane: "data", icon: Gauge, profiles: ["tali.automated-reasoning.v1"] },
];

const controlRole = roles[0]!;
const dataRoles = roles.filter((item) => item.plane === "data");

type DataRole = Exclude<ModelRole, "control_plane">;
type CapabilityAssignment = { id: string; capabilities: DataRole[]; modelId: string | null };
let capabilityRowSequence = 0;

function capabilityAssignmentsFrom(assignments: ModelAssignments): CapabilityAssignment[] {
  const grouped = new Map<string, DataRole[]>();
  for (const item of dataRoles) {
    const role = item.role as DataRole;
    const modelId = assignments[role];
    if (!modelId) continue;
    grouped.set(modelId, [...(grouped.get(modelId) ?? []), role]);
  }
  return [...grouped.entries()].map(([modelId, capabilities]) => ({ id: `model-${modelId}`, modelId, capabilities }));
}

function assignmentsFrom(controlPlaneModelId: string | null, groups: CapabilityAssignment[]): ModelAssignments {
  const next: ModelAssignments = {
    control_plane: controlPlaneModelId,
    safety_evaluator: null,
    jailbreak_evaluator: null,
    topic_policy_judge: null,
    grounding_judge: null,
    automated_reasoning: null,
  };
  for (const group of groups) {
    if (!group.modelId) continue;
    for (const capability of group.capabilities) next[capability] = group.modelId;
  }
  return next;
}

const localCapabilities = [
  "secretsExact",
  "piiExact",
  "contentFilterRules",
  "promptInjection",
  "indirectPromptInjection",
  "systemPromptLeakage",
  "topicControlRules",
] as const;

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

export function CapabilitiesPage() {
  const { t } = useTranslation();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: configurationKey, queryFn: getModelConfiguration, refetchInterval: 10_000, retry: false });
  const [controlPlaneModelId, setControlPlaneModelId] = useState<string | null>(null);
  const [capabilityAssignments, setCapabilityAssignments] = useState<CapabilityAssignment[] | null>(null);
  const [pendingAction, setPendingAction] = useState<"save" | "activate" | "rollback" | null>(null);
  useEffect(() => {
    if (!query.data?.draft.assignments) return;
    setControlPlaneModelId(query.data.draft.assignments.control_plane);
    setCapabilityAssignments(capabilityAssignmentsFrom(query.data.draft.assignments));
  }, [query.data?.draft.id, query.data?.draft.updatedAt]);

  const assignments = useMemo(
    () => capabilityAssignments ? assignmentsFrom(controlPlaneModelId, capabilityAssignments) : null,
    [capabilityAssignments, controlPlaneModelId],
  );
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

  if (query.isLoading || !assignments || !capabilityAssignments) return <ModelsSkeleton />;
  if (query.error || !query.data) {
    return <section className="py-8"><PageHeader title={t("modelSettings.capabilitiesTitle")} description={t("modelSettings.capabilitiesPageDescription")} /><div className="mt-6"><ErrorNotice error={query.error} /></div></section>;
  }
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
        eyebrow={t("modelSettings.capabilitiesEyebrow")}
        title={t("modelSettings.capabilitiesTitle")}
        description={t("modelSettings.capabilitiesPageDescription")}
        action={(
          <div className="flex flex-wrap gap-2">
            <ModelProtocolSettings models={query.data.models} disabled={!administrator || operationPending || dirty} onChanged={refresh} />
            <Button type="button" variant="outline" className="h-11" title={dirty ? t("modelSettings.saveBeforeValidation") : undefined} disabled={!administrator || operationPending || dirty} onClick={() => validateMutation.mutate()}>
              {validateMutation.isPending ? <LoaderCircle className="animate-spin" /> : <TestTube2 />}{t("modelSettings.validateSetup")}
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

      <ControlPlaneSection
        models={query.data.models}
        selectedId={controlPlaneModelId}
        disabled={!administrator || operationPending}
        probing={Boolean(probeModelMutation.isPending && probeModelMutation.variables === controlPlaneModelId)}
        onChange={setControlPlaneModelId}
        onValidate={(modelId) => probeModelMutation.mutate(modelId)}
      />
      <CapabilityAssignmentsSection
        groups={capabilityAssignments}
        models={query.data.models}
        disabled={!administrator || operationPending}
        probingModelId={probeModelMutation.isPending ? probeModelMutation.variables : undefined}
        onChange={setCapabilityAssignments}
        onValidate={(modelId) => probeModelMutation.mutate(modelId)}
      />
      <CapabilityCatalogSection assignments={assignments} models={query.data.models} />
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
  const available = models.filter((model) => controlRole.profiles.includes(model.profile));
  const selected = available.find((model) => model.id === selectedId);
  return (
    <section className="mt-6 overflow-hidden rounded-lg border bg-card" aria-labelledby="control-plane-title">
      <div className="flex items-start gap-3 border-b px-5 py-4">
        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><CloudCog className="size-5" /></span>
        <div><h2 id="control-plane-title" className="text-base font-semibold">{t("modelSettings.controlPlane")}</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">{t("modelSettings.controlPlaneDescription")}</p></div>
      </div>
      <div className="grid gap-4 px-5 py-5 lg:grid-cols-[minmax(13rem,0.7fr)_minmax(20rem,1.3fr)_auto] lg:items-center">
        <div>
          <h3 className="text-sm font-semibold">{t("modelSettings.roles.control_plane.title")}</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("modelSettings.roles.control_plane.description")}</p>
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

function CapabilityAssignmentsSection({ groups, models, disabled, probingModelId, onChange, onValidate }: {
  groups: CapabilityAssignment[];
  models: ModelDefinition[];
  disabled: boolean;
  probingModelId?: string;
  onChange: (groups: CapabilityAssignment[]) => void;
  onValidate: (modelId: string) => void;
}) {
  const { t } = useTranslation();
  const addGroup = () => onChange([...groups, { id: `new-${++capabilityRowSequence}`, capabilities: [], modelId: null }]);
  const updateGroup = (id: string, patch: Partial<CapabilityAssignment>) => onChange(groups.map((group) => group.id === id ? { ...group, ...patch } : group));
  const removeGroup = (id: string) => onChange(groups.filter((group) => group.id !== id));

  return (
    <section className="mt-6 overflow-hidden rounded-lg border bg-card" aria-labelledby="capability-assignments-title">
      <div className="flex flex-col gap-4 border-b px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><ListChecks className="size-5" /></span>
          <div><h2 id="capability-assignments-title" className="text-base font-semibold">{t("modelSettings.capabilityAssignments")}</h2><p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">{t("modelSettings.capabilityAssignmentsDescription")}</p></div>
        </div>
        <Button type="button" variant="outline" className="h-11 shrink-0" disabled={disabled || groups.length >= dataRoles.length} onClick={addGroup}><Plus />{t("modelSettings.addCapabilityAssignment")}</Button>
      </div>
      {groups.length ? (
        <div className="divide-y" role="table" aria-label={t("modelSettings.capabilityAssignments")}>
          <div className="hidden grid-cols-[minmax(18rem,1fr)_minmax(18rem,1fr)_minmax(10rem,auto)] gap-4 bg-muted/25 px-5 py-2.5 text-xs font-medium text-muted-foreground md:grid" role="row">
            <span role="columnheader">{t("modelSettings.capabilityColumn")}</span>
            <span role="columnheader">{t("modelSettings.modelColumn")}</span>
            <span className="text-right" role="columnheader">{t("modelSettings.actions")}</span>
          </div>
          {groups.map((group) => {
            const selectedModel = models.find((model) => model.id === group.modelId);
            const capabilitiesUsedElsewhere = new Set(groups.filter((candidate) => candidate.id !== group.id).flatMap((candidate) => candidate.capabilities));
            const modelsUsedElsewhere = new Set(groups.filter((candidate) => candidate.id !== group.id).map((candidate) => candidate.modelId).filter(Boolean));
            const capabilityOptions: MultiSelectOption[] = dataRoles
              .filter((item) => !capabilitiesUsedElsewhere.has(item.role as DataRole))
              .filter((item) => !selectedModel || item.profiles.includes(selectedModel.profile))
              .map((item) => ({
                value: item.role,
                label: t(`modelSettings.roles.${item.role}.title`),
                description: t(`modelSettings.roles.${item.role}.description`),
              }));
            const availableModels = models.filter((model) => (
              model.profile !== "generic-chat"
              && !modelsUsedElsewhere.has(model.id)
              && group.capabilities.every((role) => roleDefinition(role).profiles.includes(model.profile))
            ));
            return (
              <div key={group.id} className="grid gap-4 px-5 py-5 md:grid-cols-[minmax(18rem,1fr)_minmax(18rem,1fr)_minmax(10rem,auto)] md:items-start" role="row">
                <div role="cell">
                  <Label className="mb-2 block md:sr-only" htmlFor={`capabilities-${group.id}`}>{t("modelSettings.capabilityColumn")}</Label>
                  <MultiSelectCombobox
                    id={`capabilities-${group.id}`}
                    ariaLabel={t("modelSettings.capabilityColumn")}
                    disabled={disabled}
                    options={capabilityOptions}
                    value={group.capabilities}
                    placeholder={t("modelSettings.selectCapabilities")}
                    searchPlaceholder={t("modelSettings.searchCapabilities")}
                    noOptionsMessage={t("modelSettings.noAvailableCapabilities")}
                    onValueChange={(value) => updateGroup(group.id, { capabilities: value as DataRole[] })}
                  />
                </div>
                <div role="cell">
                  <Label className="mb-2 block md:sr-only" htmlFor={`capability-model-${group.id}`}>{t("modelSettings.modelColumn")}</Label>
                  <Select value={group.modelId ?? noneValue} disabled={disabled} onValueChange={(value) => updateGroup(group.id, { modelId: value === noneValue ? null : value })}>
                    <SelectTrigger id={`capability-model-${group.id}`} className="h-12 w-full"><SelectValue placeholder={t("modelSettings.selectModel")} /></SelectTrigger>
                    <SelectContent position="popper">
                      <SelectItem value={noneValue}>{t("modelSettings.notAssigned")}</SelectItem>
                      {availableModels.map((model) => <SelectItem key={model.id} value={model.id}><ModelOption model={model} /></SelectItem>)}
                    </SelectContent>
                  </Select>
                  {selectedModel?.profile === "tali.qwen3guard.v1" ? <p className="mt-2 text-xs leading-5 text-muted-foreground">{t("modelSettings.qwenGuardCoverage")}</p> : null}
                </div>
                <div className="flex justify-start gap-1 md:justify-end" role="cell">
                  <Button type="button" variant="outline" className="h-11" aria-label={selectedModel ? `${t("modelSettings.validateModel")} ${selectedModel.name}` : t("modelSettings.validateModel")} disabled={disabled || !selectedModel || probingModelId === selectedModel?.id} onClick={() => selectedModel && onValidate(selectedModel.id)}>
                    {probingModelId === selectedModel?.id ? <LoaderCircle className="animate-spin" /> : <TestTube2 />}{t("modelSettings.validateModel")}
                  </Button>
                  <Button type="button" size="icon" variant="ghost" className="size-11" aria-label={t("modelSettings.removeCapabilityAssignment")} disabled={disabled} onClick={() => removeGroup(group.id)}><X /></Button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="grid min-h-36 place-items-center p-6 text-center">
          <div><Server className="mx-auto size-5 text-muted-foreground" /><p className="mt-3 text-sm font-medium">{t("modelSettings.noCapabilityAssignments")}</p><p className="mt-1 text-xs text-muted-foreground">{t("modelSettings.noCapabilityAssignmentsDescription")}</p></div>
        </div>
      )}
    </section>
  );
}

function roleDefinition(role: DataRole) {
  return dataRoles.find((item) => item.role === role)!;
}

function CapabilityCatalogSection({ assignments, models }: { assignments: ModelAssignments; models: ModelDefinition[] }) {
  const { t } = useTranslation();
  const modelById = new Map(models.map((model) => [model.id, model]));
  const safetyModel = assignments.safety_evaluator ? modelById.get(assignments.safety_evaluator) : undefined;
  const modelCapabilities = [
    ...dataRoles.map((item) => ({
      id: item.role,
      label: t(`modelSettings.roles.${item.role}.title`),
      source: t("modelSettings.capabilitySourceModel"),
      model: assignments[item.role] ? modelById.get(assignments[item.role]!) : undefined,
    })),
    {
      id: "semantic_pii",
      label: t("modelSettings.semanticPii"),
      source: t("modelSettings.capabilitySourceBundled"),
      model: safetyModel?.profile === "tali.qwen3guard.v1" ? safetyModel : undefined,
    },
  ];
  return (
    <section className="mt-6 overflow-hidden rounded-lg border bg-card" aria-labelledby="capability-catalog-title">
      <div className="border-b px-5 py-4">
        <h2 id="capability-catalog-title" className="text-base font-semibold">{t("modelSettings.capabilityCatalog")}</h2>
        <p className="mt-1 max-w-4xl text-sm leading-6 text-muted-foreground">{t("modelSettings.capabilityCatalogDescription")}</p>
      </div>
      <Table className="min-w-[54rem]">
        <TableHeader>
          <TableRow>
            <TableHead className="pl-5">{t("modelSettings.capabilityColumn")}</TableHead>
            <TableHead>{t("modelSettings.capabilitySource")}</TableHead>
            <TableHead>{t("modelSettings.capabilityAvailability")}</TableHead>
            <TableHead className="pr-5">{t("modelSettings.capabilityProvidedBy")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {modelCapabilities.map((item) => (
            <TableRow key={item.id}>
              <TableCell className="pl-5 font-medium">{item.label}</TableCell>
              <TableCell><Badge variant="secondary">{item.source}</Badge></TableCell>
              <TableCell><CapabilityAvailability model={item.model} /></TableCell>
              <TableCell className="pr-5 text-sm text-muted-foreground">{item.model?.name ?? t("modelSettings.notAssigned")}</TableCell>
            </TableRow>
          ))}
          {localCapabilities.map((capability) => (
            <TableRow key={capability}>
              <TableCell className="pl-5 font-medium">{t(`modelSettings.localCapabilities.${capability}`)}</TableCell>
              <TableCell><Badge variant="secondary">{t("modelSettings.capabilitySourceLocal")}</Badge></TableCell>
              <TableCell><StateBadge state="ready" label={t("modelSettings.capabilityAvailable")} /></TableCell>
              <TableCell className="pr-5 text-sm text-muted-foreground">{t("modelSettings.noModelRequired")}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

function CapabilityAvailability({ model }: { model?: ModelDefinition }) {
  const { t } = useTranslation();
  if (!model) return <StateBadge state="unconfigured" label={t("modelSettings.notAssigned")} />;
  if (model.status === "validated") return <StateBadge state="ready" label={t("modelSettings.capabilityAvailable")} />;
  if (model.status === "failed") return <StateBadge state="failed" label={t("modelSettings.probeFailed")} />;
  return <StateBadge state="needs_validation" label={t("modelSettings.notChecked")} />;
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
  const topicControlDraftUse = Boolean(view.draft.assignments.topic_policy_judge && removalModelIds.has(view.draft.assignments.topic_policy_judge));
  const topicControlActiveUse = Boolean(view.active?.assignments.topic_policy_judge && removalModelIds.has(view.active.assignments.topic_policy_judge));
  const topicControlUse = topicControlDraftUse || topicControlActiveUse;
  const assignedRoles = roles.filter(({ role }) => {
    const draftModelId = view.draft.assignments[role];
    const activeModelId = view.active?.assignments[role];
    return Boolean((draftModelId && removalModelIds.has(draftModelId)) || (activeModelId && removalModelIds.has(activeModelId)));
  });
  const removalBlocked = assignedRoles.length > 0 || Boolean(removeTarget?.kind === "provider" && removalModelIds.size > 0);
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
        action={<Button type="button" variant="outline" className="h-11" disabled={!administrator} onClick={() => { setInitialProviderId(undefined); setCreateMode("model"); }}><Plus />{t("modelSettings.addModel")}</Button>}
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
        {assignedRoles.length ? <section aria-labelledby="model-removal-assignments" className="rounded-lg border bg-card px-4 py-3">
          <h3 id="model-removal-assignments" className="text-sm font-semibold">{t("modelSettings.currentAssignments")}</h3>
          <div className="mt-2 flex flex-wrap gap-2">{assignedRoles.map(({ role }) => <Badge key={role} variant={role === "topic_policy_judge" ? "destructive" : "secondary"}>{t(`modelSettings.roles.${role}.title`)}</Badge>)}</div>
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
