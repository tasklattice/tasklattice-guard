import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Webhook,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

import { EntitySheet } from "@/components/entity-sheet";
import { ProtectedDeleteSheet } from "@/components/protected-delete-sheet";
import { EmptyState, ErrorNotice, InfoNotice, PageHeader, StateBadge } from "@/components/product-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { queryKeys } from "@/features/query-keys";
import { useAuth } from "@/lib/auth";
import {
  createIntegration,
  deleteIntegration,
  getIntegration,
  getIntegrationDeletionImpact,
  getIntegrations,
  revokeIntegrationCredential,
  rotateIntegrationCredential,
  setIntegrationEnabled,
  type Integration,
  type IntegrationAdapterId,
  type IntegrationCredential,
  type IntegrationDeletionImpact,
  type IntegrationProtocol,
  type IntegrationRegistration,
  type IntegrationSetupStatus,
  type OneTimeIntegrationCredential,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const ADAPTERS: ReadonlyArray<{ id: IntegrationAdapterId; protocol: IntegrationProtocol }> = [
  { id: "litellm-generic-guardrail", protocol: "litellm" },
  { id: "generic-http-guard", protocol: "http" },
  { id: "a2a-guard", protocol: "a2a" },
];

type IntegrationDeletionConfirmation = {
  reason: string;
  confirm_recent_traffic: boolean;
  confirmation_name?: string;
};

export function IntegrationsPage() {
  const { t, i18n } = useTranslation();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: queryKeys.integrations, queryFn: getIntegrations });
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<Integration | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Integration | null>(null);
  const integrations = query.data?.items ?? [];
  const verified = integrations.filter((item) => item.setup_status === "verified").length;
  const attention = integrations.filter((item) => item.runtime_status === "degraded").length;
  const deletionImpactQuery = useQuery({
    queryKey: queryKeys.integrationDeletionImpact(deleteTarget?.id ?? ""),
    queryFn: () => getIntegrationDeletionImpact(deleteTarget!.id),
    enabled: Boolean(deleteTarget),
    staleTime: 0,
  });
  const deleteMutation = useMutation({
    mutationFn: (confirmation: IntegrationDeletionConfirmation) => deleteIntegration(deleteTarget!.id, confirmation),
    onSuccess: async () => {
      toast.success(t("integrations.deleteSucceeded"));
      const deletedId = deleteTarget?.id;
      if (deletedId) {
        await queryClient.cancelQueries({ queryKey: queryKeys.integration(deletedId) });
        queryClient.removeQueries({ queryKey: queryKeys.integration(deletedId) });
      }
      setDeleteTarget(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.integrations, exact: true }),
        queryClient.invalidateQueries({ queryKey: queryKeys.deployments }),
        queryClient.invalidateQueries({ queryKey: queryKeys.metrics }),
        queryClient.invalidateQueries({ queryKey: queryKeys.auditEvents }),
        queryClient.invalidateQueries({ queryKey: queryKeys.systemStatus }),
      ]);
    },
    onError: async () => { await deletionImpactQuery.refetch(); },
  });

  async function refreshIntegrations() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.integrations, exact: true }),
      queryClient.invalidateQueries({ queryKey: queryKeys.systemStatus }),
    ]);
  }

  async function completeCreation(integration: Integration, openDetails: boolean) {
    setCreateOpen(false);
    if (openDetails) setSelected(integration);
    await refreshIntegrations();
  }

  return (
    <section className="py-6 sm:py-8">
      <PageHeader
        title={t("pages.integrations.title")}
        description={t("integrations.description")}
        action={auth.user?.role === "admin" ? <Button className="min-h-11 self-start" onClick={() => setCreateOpen(true)}><Plus />{t("integrations.register")}</Button> : undefined}
      />

      {query.error ? <div className="mt-5"><ErrorNotice error={query.error} /></div> : null}
      {query.isLoading ? <Skeleton className="mt-5 h-60 rounded-lg" /> : null}

      {integrations.length ? (
        <section className="mt-5 overflow-hidden rounded-lg border bg-card shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 px-5 py-3 text-xs text-muted-foreground">
            <span>{t("integrations.listSummary", { total: integrations.length, verified })}</span>
            {attention ? <span className="font-medium text-destructive">{t("integrations.needsAttention", { count: attention })}</span> : null}
          </div>
          <div className="hidden grid-cols-[minmax(220px,1fr)_190px_170px_140px_120px_24px] border-b bg-muted/20 px-5 py-3 text-xs font-medium text-muted-foreground lg:grid">
            <span>{t("integrations.gatewayInstance")}</span>
            <span>{t("integrations.setup")}</span>
            <span>{t("integrations.lastCallback")}</span>
            <span>{t("integrations.traffic")}</span>
            <span>{t("integrations.health")}</span>
            <span />
          </div>
          <div className="divide-y divide-border">
            {integrations.map((integration) => (
              <IntegrationRow key={integration.id} integration={integration} onOpen={() => setSelected(integration)} />
            ))}
          </div>
        </section>
      ) : !query.isLoading ? (
        <div className="mt-5">
          <EmptyState
            title={t("integrations.emptyTitle")}
            description={t("integrations.emptyDescription")}
            action={auth.user?.role === "admin" ? <Button onClick={() => setCreateOpen(true)}><Plus />{t("integrations.register")}</Button> : undefined}
          />
        </div>
      ) : null}

      <IntegrationDetail
        integration={selected}
        onOpenChange={(open) => !open && setSelected(null)}
        onUpdated={refreshIntegrations}
        onDelete={auth.user?.role === "admin" ? (integration) => {
          setSelected(null);
          deleteMutation.reset();
          queryClient.removeQueries({ queryKey: queryKeys.integrationDeletionImpact(integration.id), exact: true });
          setDeleteTarget(integration);
        } : undefined}
      />
      {deleteTarget ? <DeleteIntegrationSheet
        integration={deleteTarget}
        open
        impact={deletionImpactQuery.data}
        loading={deletionImpactQuery.isFetching}
        deleting={deleteMutation.isPending}
        error={deleteMutation.error instanceof Error ? deleteMutation.error : deletionImpactQuery.error instanceof Error ? deletionImpactQuery.error : null}
        locale={i18n.language}
        onOpenChange={(open) => { if (!open && !deleteMutation.isPending) { setDeleteTarget(null); deleteMutation.reset(); } }}
        onRetry={() => { deleteMutation.reset(); void deletionImpactQuery.refetch(); }}
        onConfirm={(confirmation) => deleteMutation.mutate(confirmation)}
      /> : null}
      <CreateIntegrationSheet
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={completeCreation}
      />
    </section>
  );
}

function IntegrationRow({ integration, onOpen }: { integration: Integration; onOpen: () => void }) {
  const { t, i18n } = useTranslation();
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t("integrations.openIntegration", { name: integration.name })}
      className="group relative grid min-h-24 w-full gap-4 p-5 text-left transition-colors hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-ring lg:grid-cols-[minmax(220px,1fr)_190px_170px_140px_120px_24px] lg:items-center"
    >
      <div className="min-w-0">
        <span className="flex items-center gap-2.5">
          <ProtocolIcon protocol={integration.protocol} size="sm" />
          <strong className="truncate text-sm font-medium">{integration.name}</strong>
        </span>
        <span className="mt-1.5 block truncate pl-9 text-xs text-muted-foreground">
          {t(`integrations.adapters.${integration.adapter_id}`)} · {shortId(integration.id)}
        </span>
      </div>
      <ListDatum label={t("integrations.setup")}><SetupBadge status={integration.setup_status} /></ListDatum>
      <ListDatum label={t("integrations.lastCallback")}>
        <time className="text-xs" dateTime={integration.last_seen_at ?? undefined} title={formatDate(integration.last_seen_at, i18n.language)}>
          {integration.last_seen_at ? formatRelativeDate(integration.last_seen_at, i18n.language) : t("integrations.never")}
        </time>
      </ListDatum>
      <ListDatum label={t("integrations.traffic")}>
        <span className="font-mono text-xs">{t("integrations.requestErrorCount", { requests: integration.request_count, errors: integration.error_count })}</span>
      </ListDatum>
      <ListDatum label={t("integrations.health")}><StateBadge state={integration.runtime_status} /></ListDatum>
      <ChevronRight className="absolute right-4 top-5 size-4 text-muted-foreground lg:static" />
    </button>
  );
}

function ListDatum({ children, label }: { children: ReactNode; label: string }) {
  return (
    <span className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-3 text-muted-foreground lg:block lg:text-foreground">
      <span className="text-xs font-medium text-muted-foreground lg:sr-only">{label}</span>
      <span className="min-w-0">{children}</span>
    </span>
  );
}

function IntegrationDetail({
  integration,
  onDelete,
  onOpenChange,
  onUpdated,
}: {
  integration: Integration | null;
  onDelete?: (integration: Integration) => void;
  onOpenChange: (open: boolean) => void;
  onUpdated: () => Promise<void>;
}) {
  if (!integration) return null;
  return <IntegrationDetailContent key={integration.id} initialIntegration={integration} onDelete={onDelete} onOpenChange={onOpenChange} onUpdated={onUpdated} />;
}

function IntegrationDetailContent({
  initialIntegration,
  onDelete,
  onOpenChange,
  onUpdated,
}: {
  initialIntegration: Integration;
  onDelete?: (integration: Integration) => void;
  onOpenChange: (open: boolean) => void;
  onUpdated: () => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const auth = useAuth();
  const canManage = auth.user?.role === "admin";
  const queryClient = useQueryClient();
  const copy = useCopyText();
  const query = useQuery({
    queryKey: queryKeys.integration(initialIntegration.id),
    queryFn: () => getIntegration(initialIntegration.id),
    initialData: initialIntegration,
    refetchInterval: 5_000,
  });
  const integration = query.data;
  const [oneTimeCredential, setOneTimeCredential] = useState<OneTimeIntegrationCredential | null>(null);
  const [credentialSaved, setCredentialSaved] = useState(false);
  const [closeWarning, setCloseWarning] = useState(false);
  const [pendingRevokeId, setPendingRevokeId] = useState<string | null>(null);

  async function cacheIntegration(next: Integration) {
    queryClient.setQueryData(queryKeys.integration(next.id), next);
    await onUpdated();
  }

  const enabledMutation = useMutation({
    mutationFn: (enabled: boolean) => setIntegrationEnabled(integration.id, enabled),
    onSuccess: async (next) => {
      await cacheIntegration(next);
      toast.success(t(next.enabled ? "integrations.enabledSuccess" : "integrations.disabledSuccess"));
    },
    onError: showMutationError(t("integrations.updateFailed")),
  });

  const rotateMutation = useMutation({
    mutationFn: () => rotateIntegrationCredential(integration.id),
    onSuccess: async (result) => {
      setOneTimeCredential(result.credential);
      setCredentialSaved(false);
      setCloseWarning(false);
      await cacheIntegration(result.integration);
      toast.success(t("integrations.credentialRotated"));
    },
    onError: showMutationError(t("integrations.rotationFailed")),
  });

  const revokeMutation = useMutation({
    mutationFn: (credentialId: string) => revokeIntegrationCredential(integration.id, credentialId),
    onSuccess: async () => {
      setPendingRevokeId(null);
      await query.refetch();
      await onUpdated();
      toast.success(t("integrations.credentialRevoked"));
    },
    onError: showMutationError(t("integrations.revocationFailed")),
  });

  function requestClose() {
    if (oneTimeCredential && !credentialSaved) {
      setCloseWarning(true);
      return;
    }
    onOpenChange(false);
  }

  const footer = closeWarning ? (
    <>
      <Button variant="outline" onClick={() => setCloseWarning(false)}>{t("integrations.keepSettingUp")}</Button>
      <Button variant="destructive" onClick={() => onOpenChange(false)}>{t("integrations.leaveAndLoseKey")}</Button>
    </>
  ) : <>
    {onDelete && (!oneTimeCredential || credentialSaved) ? <Button className="text-destructive hover:bg-destructive/10 hover:text-destructive" variant="outline" onClick={() => onDelete(integration)}><Trash2 />{t("integrations.deleteAction")}</Button> : null}
    <Button variant="outline" onClick={requestClose}>{t("common.close")}</Button>
  </>;

  return (
    <EntitySheet
      open
      onOpenChange={(open) => !open && requestClose()}
      eyebrow={t("integrations.details")}
      title={integration.name}
      description={t("integrations.detailsDescription")}
      width="lg"
      footer={footer}
    >
      <div className="space-y-5">
        {query.error ? <ErrorNotice error={query.error} /> : null}
        {closeWarning ? <SecretExitWarning /> : null}
        {oneTimeCredential ? (
          <OneTimeCredentialCard
            credential={oneTimeCredential}
            saved={credentialSaved}
            onSavedChange={(saved) => { setCredentialSaved(saved); if (saved) setCloseWarning(false); }}
            onCopy={() => copy(oneTimeCredential.value, t("integrations.credential"))}
          />
        ) : null}

        <section className="overflow-hidden rounded-lg border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/30 p-4">
            <div className="flex items-center gap-3">
              <ProtocolIcon protocol={integration.protocol} />
              <div>
                <p className="text-sm font-medium">{t(`integrations.adapters.${integration.adapter_id}`)}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{integration.id}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <SetupBadge status={integration.setup_status} />
              <StateBadge state={integration.runtime_status} />
            </div>
          </div>
          <dl className="divide-y divide-border">
            <Detail label={t("integrations.id")} mono copyValue={integration.id}>{integration.id}</Detail>
            <Detail label={t("integrations.protocol")}>{t(`integrations.protocols.${integration.protocol}`)}</Detail>
            <Detail label={t("integrations.keyHint")} mono>{integration.key_hint || t("integrations.noActiveCredential")}</Detail>
            <Detail label={t("integrations.created")}>{formatDate(integration.created_at, i18n.language)}</Detail>
          </dl>
          <div className="flex items-center justify-between gap-4 border-t px-4 py-4">
            <div>
              <Label htmlFor={`integration-enabled-${integration.id}`}>{t("integrations.acceptCallbacks")}</Label>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("integrations.acceptCallbacksDescription")}</p>
            </div>
            <Switch
              id={`integration-enabled-${integration.id}`}
              checked={integration.enabled}
              disabled={!canManage || enabledMutation.isPending}
              onCheckedChange={(enabled) => enabledMutation.mutate(enabled)}
              aria-label={t("integrations.acceptCallbacks")}
            />
          </div>
        </section>

        <SetupConfiguration integration={integration} />

        <section className="overflow-hidden rounded-lg border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/30 px-4 py-3">
            <div>
              <h3 className="text-sm font-semibold">{t("integrations.activeCredentials")}</h3>
              <p className="mt-1 text-xs text-muted-foreground">{t("integrations.activeCredentialsDescription")}</p>
            </div>
            {canManage ? <Button variant="outline" disabled={rotateMutation.isPending} onClick={() => rotateMutation.mutate()}>
              <RefreshCw className={cn(rotateMutation.isPending && "animate-spin")} />
              {t("integrations.generateCredential")}
            </Button> : null}
          </div>
          <div className="divide-y divide-border">
            {integration.credentials.map((credential) => (
              <CredentialRow
                key={credential.id}
                credential={credential}
                locale={i18n.language}
                onlyCredential={integration.credentials.length === 1}
                confirming={pendingRevokeId === credential.id}
                pending={revokeMutation.isPending && pendingRevokeId === credential.id}
                canManage={canManage}
                onConfirm={() => setPendingRevokeId(credential.id)}
                onCancel={() => setPendingRevokeId(null)}
                onRevoke={() => revokeMutation.mutate(credential.id)}
              />
            ))}
          </div>
          {integration.credentials.length === 1 ? <p className="border-t bg-muted/20 px-4 py-3 text-xs text-muted-foreground">{t("integrations.lastCredentialRequired")}</p> : null}
        </section>

        <section className="overflow-hidden rounded-lg border bg-card">
          <div className="border-b bg-muted/30 px-4 py-3"><h3 className="text-sm font-semibold">{t("integrations.runtimeActivity")}</h3></div>
          <dl className="divide-y divide-border">
            <Detail label={t("integrations.inputCallback")}>{callbackTimestamp(integration.input_seen_at, i18n.language, t("integrations.notReceived"))}</Detail>
            <Detail label={t("integrations.outputCallback")}>{callbackTimestamp(integration.output_seen_at, i18n.language, t("integrations.notReceived"))}</Detail>
            <Detail label={t("integrations.requests")} mono>{integration.request_count.toLocaleString(i18n.language)}</Detail>
            <Detail label={t("integrations.errors")} mono>{integration.error_count.toLocaleString(i18n.language)}</Detail>
            <Detail label={t("integrations.lastActivity")}>{integration.last_seen_at ? formatDate(integration.last_seen_at, i18n.language) : t("integrations.noTraffic")}</Detail>
          </dl>
        </section>

        <InfoNotice title={t("integrations.trustedContext")}>{t("integrations.trustedContextDescription")}</InfoNotice>
      </div>
    </EntitySheet>
  );
}

export function DeleteIntegrationSheet({
  deleting,
  error,
  impact,
  integration,
  loading,
  locale,
  onConfirm,
  onOpenChange,
  onRetry,
  open,
}: {
  deleting: boolean;
  error: Error | null;
  impact?: IntegrationDeletionImpact;
  integration: Integration;
  loading: boolean;
  locale: string;
  onConfirm: (confirmation: IntegrationDeletionConfirmation) => void;
  onOpenChange: (open: boolean) => void;
  onRetry: () => void;
  open: boolean;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  const telemetryFresh = Boolean(impact?.telemetry_fresh);
  const requiresSecondConfirmation = Boolean(impact?.requires_second_confirmation);

  useEffect(() => {
    if (!open) setReason("");
  }, [open]);

  return <ProtectedDeleteSheet
    open={open}
    onOpenChange={onOpenChange}
    entityName={integration.name}
    loading={loading}
    ready={telemetryFresh}
    deleting={deleting}
    error={impact && !telemetryFresh ? new Error(t("integrations.deleteTelemetryStale")) : error}
    requiresConfirmation={requiresSecondConfirmation}
    impactItems={impact ? [
      { label: t("integrations.recentIncomingRequests", { minutes: impact.window_minutes }), value: impact.incoming_request_count.toLocaleString(locale) },
      { label: t("integrations.activeDeploymentsAffected"), value: impact.active_deployment_count.toLocaleString(locale) },
      { label: t("integrations.activeCredentialsRetained"), value: impact.active_credential_count.toLocaleString(locale) },
    ] : []}
    copy={{
      eyebrow: t("integrations.deleteEyebrow"),
      title: t("integrations.deleteDialogTitle"),
      description: t("integrations.deleteDialogDescription", { name: integration.name }),
      protectedMessage: t("integrations.protectedDeleteWarning"),
      clearMessage: t("integrations.noProtectedActivity"),
      retentionNote: t("integrations.deleteRetentionNote"),
      continueLabel: t("integrations.continueDelete"),
      deleteLabel: t("integrations.deleteConfirm"),
      deletingLabel: t("integrations.deleting"),
      confirmTitle: t("integrations.deleteProtectedTitle"),
      confirmDescription: t("integrations.deleteProtectedDescription", { requests: impact?.incoming_request_count ?? 0, minutes: impact?.window_minutes ?? 30, deployments: impact?.active_deployment_count ?? 0 }),
      confirmWarning: t("integrations.deleteStopsTraffic", { deployments: impact?.active_deployment_count ?? 0, credentials: impact?.active_credential_count ?? 0 }),
      typeNameLabel: t("integrations.typeNameToConfirm", { name: integration.name }),
      protectedDeleteLabel: t("integrations.deleteDespiteProtection"),
      cancelLabel: t("common.cancel"),
      backLabel: t("common.back"),
      retryLabel: t("common.retry"),
      reasonLabel: t("integrations.deleteReason"),
      reasonPlaceholder: t("integrations.deleteReasonPlaceholder"),
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

export function CreateIntegrationSheet({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (integration: Integration, openDetails: boolean) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [adapterId, setAdapterId] = useState<IntegrationAdapterId>("litellm-generic-guardrail");
  const [registration, setRegistration] = useState<IntegrationRegistration | null>(null);
  const [credentialSaved, setCredentialSaved] = useState(false);
  const [configurationCopied, setConfigurationCopied] = useState(false);
  const [closeWarning, setCloseWarning] = useState(false);
  const integrationId = registration?.integration.id ?? "";
  const integrationQuery = useQuery({
    queryKey: queryKeys.integration(integrationId),
    queryFn: () => getIntegration(integrationId),
    enabled: open && Boolean(integrationId),
    initialData: registration?.integration,
    refetchInterval: (query) => query.state.data?.setup_status === "verified" ? false : 4_000,
  });
  const integration = integrationQuery.data ?? registration?.integration;

  useEffect(() => {
    if (!open) return;
    setName("");
    setAdapterId("litellm-generic-guardrail");
    setRegistration(null);
    setCredentialSaved(false);
    setConfigurationCopied(false);
    setCloseWarning(false);
  }, [open]);

  const mutation = useMutation({
    mutationFn: () => createIntegration({ name: name.trim(), adapter_id: adapterId }),
    onSuccess: (result) => {
      setRegistration(result);
      toast.success(t("integrations.registered"));
    },
    onError: showMutationError(t("integrations.registrationFailed")),
  });

  function finish(openDetails: boolean, force = false) {
    if (!registration || !integration) return;
    if (!force && !credentialSaved) {
      setCloseWarning(true);
      return;
    }
    void onCreated(integration, openDetails);
  }

  function requestOpenChange(next: boolean) {
    if (next) {
      onOpenChange(true);
      return;
    }
    if (registration) finish(false);
    else onOpenChange(false);
  }

  const adapter = adapterDefinition(adapterId);
  const providerConnected = integration?.protocol === "litellm"
    ? Boolean(integration.input_seen_at || integration.output_seen_at)
    : configurationCopied;
  const setupComplete = [credentialSaved, providerConnected, integration?.setup_status === "verified"].filter(Boolean).length;
  const footer = registration ? closeWarning ? (
    <>
      <Button variant="outline" onClick={() => setCloseWarning(false)}>{t("integrations.keepSettingUp")}</Button>
      <Button variant="destructive" onClick={() => finish(false, true)}>{t("integrations.leaveAndLoseKey")}</Button>
    </>
  ) : (
    <>
      <Button variant="outline" onClick={() => finish(false)}>{t("integrations.finishLater")}</Button>
      <Button onClick={() => finish(true)}>{t("integrations.openIntegrationDetails")}</Button>
    </>
  ) : (
    <>
      <Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
      <Button disabled={!name.trim() || mutation.isPending} onClick={() => mutation.mutate()}>
        <Plus />{t(mutation.isPending ? "integrations.registering" : "integrations.register")}
      </Button>
    </>
  );

  return (
    <EntitySheet
      open={open}
      onOpenChange={requestOpenChange}
      eyebrow={`Integration / ${adapter.protocol.toUpperCase()}`}
      title={t(registration ? "integrations.setupTitle" : "integrations.register")}
      description={t(registration ? "integrations.setupDescription" : "integrations.registerDescription", { name: registration?.integration.name })}
      width={registration ? "lg" : "md"}
      footer={footer}
    >
      {registration && integration ? (
        <div className="space-y-5">
          {integrationQuery.error ? <ErrorNotice error={integrationQuery.error} /> : null}
          {closeWarning ? <SecretExitWarning /> : null}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <ProtocolIcon protocol={integration.protocol} />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{integration.name}</p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">{t(`integrations.adapters.${integration.adapter_id}`)}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground">{t("integrations.stepsComplete", { count: setupComplete })}</span>
              <SetupBadge status={integration.setup_status} />
            </div>
          </div>
          <SetupChecklist
            integration={integration}
            credential={registration.credential}
            credentialSaved={credentialSaved}
            configurationCopied={configurationCopied}
            onCredentialSavedChange={(saved) => { setCredentialSaved(saved); if (saved) setCloseWarning(false); }}
            onConfigurationCopied={() => setConfigurationCopied(true)}
          />
        </div>
      ) : (
        <div className="grid min-w-0 gap-5">
          <Field label={t("integrations.name")}>
            <Input autoFocus className="min-h-11 rounded-lg bg-card" value={name} onChange={(event) => setName(event.target.value)} placeholder={t("integrations.namePlaceholder")} />
          </Field>
          <Field label={t("integrations.integrationProtocol")}>
            <Select value={adapterId} onValueChange={(value) => setAdapterId(value as IntegrationAdapterId)}>
              <SelectTrigger className="min-h-16 min-w-0 overflow-hidden rounded-xl bg-card px-3 py-2 text-left"><SelectValue /></SelectTrigger>
              <SelectContent className="min-w-[var(--radix-select-trigger-width)] rounded-xl p-1">
                {ADAPTERS.map((item) => <SelectItem key={item.id} className="min-h-16 rounded-lg px-2.5 py-2 pr-10" value={item.id}><AdapterOption adapterId={item.id} /></SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
        </div>
      )}
    </EntitySheet>
  );
}

export function SetupChecklist({
  integration,
  credential,
  credentialSaved,
  configurationCopied,
  onCredentialSavedChange,
  onConfigurationCopied,
}: {
  integration: Integration;
  credential: OneTimeIntegrationCredential;
  credentialSaved: boolean;
  configurationCopied: boolean;
  onCredentialSavedChange: (saved: boolean) => void;
  onConfigurationCopied: () => void;
}) {
  const { t, i18n } = useTranslation();
  const copy = useCopyText();
  return (
    <ol className="space-y-4" aria-label={t("integrations.setupChecklist")}>
      <SetupStep
        number={1}
        title={t("integrations.saveCredential")}
        description={integration.protocol === "litellm"
          ? t("integrations.saveIntegrationSecretDescription")
          : t("integrations.saveCredentialDescription", { env: integration.setup.credential_env_var })}
        complete={credentialSaved}
      >
        <OneTimeCredentialCard
          credential={credential}
          saved={credentialSaved}
          onSavedChange={onCredentialSavedChange}
          onCopy={() => copy(credential.value, t("integrations.credential"))}
          compact
        />
      </SetupStep>
      <SetupStep
        number={2}
        title={integration.protocol === "litellm"
          ? t("integrations.configureTaskLatticeProvider")
          : t("integrations.configureAdapter", { adapter: t(`integrations.protocolShort.${integration.protocol}`) })}
        description={integration.protocol === "litellm"
          ? t("integrations.configureTaskLatticeProviderDescription")
          : t("integrations.configureAdapterDescription")}
        complete={integration.setup_status !== "applying" && (integration.protocol === "litellm"
          ? Boolean(integration.input_seen_at || integration.output_seen_at)
          : configurationCopied)}
      >
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
          {integration.setup_status === "applying" ? (
            <InfoNotice title={t("integrations.runnerSyncTitle")}>{t("integrations.runnerSyncDescription", { generation: integration.desired_generation ?? "—" })}</InfoNotice>
          ) : integration.protocol === "litellm" ? (
            <LiteLLMProviderSetup endpoint={integration.setup.api_base_url} />
          ) : (
            <>
              <CopyField label={t("integrations.apiBaseUrl")} value={integration.setup.api_base_url} />
              <EnvironmentVariableValue label={t("integrations.apiBaseEnvironmentVariable")} name={integration.setup.api_base_env_var} value={integration.setup.api_base_url} />
              <CodeBlock label={t("integrations.configurationTemplate")} value={integration.setup.yaml_template} onCopied={onConfigurationCopied} />
              <SetupFacts integration={integration} />
            </>
          )}
        </div>
      </SetupStep>
      <SetupStep
        number={3}
        title={t("integrations.verifyCallbacks")}
        description={t("integrations.verifyCallbacksDescription")}
        complete={integration.setup_status === "verified"}
      >
        <div className="overflow-hidden rounded-lg border bg-card" aria-live="polite">
          <CallbackStatusRow label={t("integrations.inputCallback")} seenAt={integration.input_seen_at} locale={i18n.language} />
          <CallbackStatusRow label={t("integrations.outputCallback")} seenAt={integration.output_seen_at} locale={i18n.language} border />
          <div className="flex items-start gap-2 border-t bg-muted/20 px-4 py-3 text-xs leading-5 text-muted-foreground">
            <RefreshCw className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            {integration.setup_status === "verified" ? t("integrations.callbacksVerified") : t("integrations.waitingForCallbacks")}
          </div>
        </div>
      </SetupStep>
    </ol>
  );
}

function SetupStep({
  number,
  title,
  description,
  complete,
  children,
}: {
  number: number;
  title: string;
  description: string;
  complete: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <li className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3 rounded-lg border bg-background p-4 sm:grid-cols-[2.25rem_minmax(0,1fr)] sm:p-5">
      <span className={cn("flex size-8 items-center justify-center rounded-full border text-xs font-semibold", complete ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-border bg-muted/40 text-muted-foreground")} aria-hidden="true">
        {complete ? <Check className="size-4" /> : number}
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">{title}</h3>
          {complete ? <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700"><Check />{t("integrations.complete")}</Badge> : null}
        </div>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
        <div className="mt-4 min-w-0">{children}</div>
      </div>
    </li>
  );
}

function SetupConfiguration({ integration }: { integration: Integration }) {
  const { t } = useTranslation();
  if (integration.protocol === "litellm") {
    return (
      <section className="overflow-hidden rounded-lg border bg-card">
        <div className="border-b bg-muted/30 px-4 py-3">
          <h3 className="text-sm font-semibold">{t("integrations.litellmProviderSetup")}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{t("integrations.litellmProviderSetupDescription")}</p>
        </div>
        <div className="p-4">
          <LiteLLMProviderSetup endpoint={integration.setup.api_base_url} detail />
        </div>
      </section>
    );
  }
  return (
    <section className="overflow-hidden rounded-lg border bg-card">
      <div className="border-b bg-muted/30 px-4 py-3">
        <h3 className="text-sm font-semibold">{t("integrations.setupConfiguration")}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{t("integrations.setupConfigurationDescription")}</p>
      </div>
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 p-4">
        <CopyField label={t("integrations.apiBaseUrl")} value={integration.setup.api_base_url} />
        <CopyField label={t("integrations.callbackUrl")} value={integration.setup.callback_url} />
        <div className="grid gap-4 sm:grid-cols-2">
          <CopyField label={t("integrations.authHeader")} value={integration.setup.auth_header} />
          <CopyField label={t("integrations.credentialEnvironmentVariable")} value={integration.setup.credential_env_var} />
        </div>
        <EnvironmentVariableValue label={t("integrations.apiBaseEnvironmentVariable")} name={integration.setup.api_base_env_var} value={integration.setup.api_base_url} />
        <CodeBlock label={t("integrations.configurationTemplate")} value={integration.setup.yaml_template} />
        <SetupFacts integration={integration} />
      </div>
    </section>
  );
}

function SetupFacts({ integration }: { integration: Integration }) {
  const { t } = useTranslation();
  const setup = integration.setup;
  return (
    <dl className="grid gap-3 rounded-lg bg-muted/30 p-3 text-xs sm:grid-cols-3">
      <div><dt className="text-muted-foreground">{t("integrations.modes")}</dt><dd className="mt-1 font-medium">{setup.recommended_modes.join(" + ")}</dd></div>
      <div><dt className="text-muted-foreground">{t("integrations.defaultBehavior")}</dt><dd className="mt-1 font-medium">{t(setup.default_on ? "integrations.defaultOn" : "integrations.requestSelected")}</dd></div>
      <div><dt className="text-muted-foreground">{t("integrations.failureBehavior")}</dt><dd className="mt-1 font-medium">{t(setup.unreachable_fallback === "fail_closed" ? "integrations.failClosed" : "integrations.failOpen")} · {t(setup.fail_on_error ? "integrations.blockOnError" : "integrations.allowOnError")}</dd></div>
    </dl>
  );
}

function LiteLLMProviderSetup({ endpoint, detail = false }: { endpoint: string; detail?: boolean }) {
  const { t } = useTranslation();
  const confirmationId = `litellm-provider-configured-${endpoint}`;
  return (
    <div className="grid min-w-0 gap-4">
      <section className="overflow-hidden rounded-lg border bg-card" aria-labelledby={`${confirmationId}-title`}>
        <div className="flex items-center gap-3 border-b bg-muted/30 px-4 py-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background text-primary shadow-xs">
            <ShieldCheck className="size-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h4 id={`${confirmationId}-title`} className="text-sm font-semibold">{t("integrations.taskLatticeGuardProvider")}</h4>
            <p className="mt-0.5 text-xs text-muted-foreground">{t("integrations.taskLatticeGuardProviderDescription")}</p>
          </div>
        </div>
        <ol className="divide-y divide-border text-sm">
          {[t("integrations.litellmProviderStepOpen"), t("integrations.litellmProviderStepSelect"), t("integrations.litellmProviderStepConnect")].map((instruction, index) => (
            <li key={instruction} className="grid grid-cols-[1.75rem_minmax(0,1fr)] items-start gap-3 px-4 py-3">
              <span className="flex size-7 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground" aria-hidden="true">{index + 1}</span>
              <span className="min-w-0 pt-1 leading-5">{instruction}</span>
            </li>
          ))}
        </ol>
      </section>

      <CopyField label={t("integrations.integrationEndpoint")} value={endpoint} />

      <div className="rounded-lg border bg-muted/20 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-2 text-xs font-medium text-foreground"><KeyRound className="size-4 text-muted-foreground" aria-hidden="true" />{t("integrations.integrationSecret")}</p>
          {detail ? <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700"><CheckCircle2 />{t("integrations.integrationSecretAvailable")}</Badge> : null}
        </div>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">{t(detail ? "integrations.integrationSecretDetailsDescription" : "integrations.integrationSecretDescription")}</p>
      </div>

      <section className="overflow-hidden rounded-lg border bg-card" aria-labelledby={`${confirmationId}-settings-title`}>
        <div className="border-b bg-muted/30 px-4 py-3">
          <h4 id={`${confirmationId}-settings-title`} className="text-sm font-semibold">{t("integrations.litellmProviderSettings")}</h4>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("integrations.litellmProviderSettingsDescription")}</p>
        </div>
        <dl className="divide-y divide-border text-xs">
          <div className="grid gap-1 px-4 py-3 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4">
            <dt className="font-medium text-foreground">{t("integrations.protectionStages")}</dt>
            <dd className="leading-5 text-muted-foreground">{t("integrations.protectionStagesDescription")}</dd>
          </div>
          <div className="grid gap-1 px-4 py-3 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4">
            <dt className="font-medium text-foreground">{t("integrations.guardUnavailable")}</dt>
            <dd className="leading-5 text-muted-foreground">{t("integrations.guardUnavailableDescription")}</dd>
          </div>
          <div className="grid gap-1 px-4 py-3 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4">
            <dt className="font-medium text-foreground">{t("integrations.advancedProviderSettings")}</dt>
            <dd className="leading-5 text-muted-foreground">{t("integrations.advancedProviderSettingsDescription")}</dd>
          </div>
        </dl>
      </section>

      <InfoNotice title={t("integrations.failOpenScopeTitle")}>{t("integrations.failOpenScopeDescription")}</InfoNotice>

      <InfoNotice title={t("integrations.noLiteLLMRestartTitle")}>{t("integrations.noLiteLLMRestartDescription")}</InfoNotice>
    </div>
  );
}

function OneTimeCredentialCard({
  credential,
  saved,
  onSavedChange,
  onCopy,
  compact = false,
}: {
  credential: OneTimeIntegrationCredential;
  saved: boolean;
  onSavedChange: (saved: boolean) => void;
  onCopy: () => void;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const checkboxId = `credential-saved-${credential.id}`;
  const [revealedSavedCredentialId, setRevealedSavedCredentialId] = useState<string | null>(null);
  const revealed = !saved || revealedSavedCredentialId === credential.id;

  if (!revealed) {
    return (
      <div className={cn("rounded-lg border border-emerald-200 bg-emerald-50/60", compact ? "p-4" : "p-5")} aria-live="polite">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-xs font-medium text-emerald-700"><CheckCircle2 className="size-4" aria-hidden="true" />{t("integrations.credentialSaved")}</p>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">{t("integrations.credentialSavedDescription")}</p>
            <code className="mt-2 block break-all font-mono text-xs text-foreground">{credential.key_hint}</code>
          </div>
          <Button type="button" variant="outline" className="min-h-11 shrink-0 bg-background" onClick={() => setRevealedSavedCredentialId(credential.id)}>
            <Eye aria-hidden="true" />
            {t("integrations.revealCredential")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("rounded-lg border border-primary/20 bg-primary/5", compact ? "p-4" : "p-5")}>
      <p className="flex items-center gap-2 text-xs font-medium text-primary"><KeyRound className="size-4" aria-hidden="true" />{t("integrations.oneTimeCredential")}</p>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">{t("integrations.oneTimeCredentialDescription")}</p>
      <code className="mt-3 block break-all rounded-md border bg-card p-4 font-mono text-xs leading-6">{credential.value}</code>
      <div className="mt-3 flex flex-wrap items-center gap-4">
        <Button type="button" variant="outline" className="min-h-11" onClick={onCopy}><Copy />{t("integrations.copyCredential")}</Button>
        {saved ? (
          <>
            <span className="flex min-h-11 items-center gap-2 text-xs font-medium text-emerald-700"><CheckCircle2 className="size-4" aria-hidden="true" />{t("integrations.credentialSaved")}</span>
            <Button type="button" variant="ghost" className="min-h-11" onClick={() => setRevealedSavedCredentialId(null)}>
              <EyeOff aria-hidden="true" />
              {t("integrations.hideCredential")}
            </Button>
          </>
        ) : (
          <Label htmlFor={checkboxId} className="min-h-11 cursor-pointer gap-3 text-xs leading-5">
            <Checkbox id={checkboxId} checked={saved} onCheckedChange={(checked) => onSavedChange(checked === true)} />
            {t("integrations.credentialStoredConfirmation")}
          </Label>
        )}
      </div>
    </div>
  );
}

function SecretExitWarning() {
  const { t } = useTranslation();
  return (
    <Alert variant="destructive">
      <AlertTriangle />
      <AlertTitle>{t("integrations.unsavedCredentialTitle")}</AlertTitle>
      <AlertDescription>{t("integrations.unsavedCredentialDescription")}</AlertDescription>
    </Alert>
  );
}

function CopyField({ label, value }: { label: string; value: string }) {
  const { t } = useTranslation();
  const copy = useCopyText();
  return (
    <div>
      <p className="mb-2 text-xs font-medium text-muted-foreground">{label}</p>
      <div className="grid grid-cols-[minmax(0,1fr)_2.75rem] items-center overflow-hidden rounded-lg border bg-background">
        <code className="min-w-0 break-all px-3 py-2.5 font-mono text-xs leading-5">{value}</code>
        <Button type="button" size="icon" variant="ghost" className="size-11 rounded-none border-l" aria-label={t("integrations.copyItem", { item: label })} onClick={() => copy(value, label)}><Copy /></Button>
      </div>
    </div>
  );
}

function EnvironmentVariableValue({ label, name, value }: { label: string; name: string; value: string }) {
  const { t } = useTranslation();
  const copy = useCopyText();
  const environmentVariable = `${name}=${value}`;
  return (
    <div>
      <p className="mb-2 text-xs font-medium text-muted-foreground">{label}</p>
      <div className="grid grid-cols-[minmax(0,1fr)_2.75rem] items-center overflow-hidden rounded-lg border bg-background">
        <code className="min-w-0 break-all px-3 py-2.5 font-mono text-xs leading-5">{environmentVariable}</code>
        <Button type="button" size="icon" variant="ghost" className="size-11 rounded-none border-l" aria-label={t("integrations.copyItem", { item: label })} onClick={() => copy(environmentVariable, label)}><Copy /></Button>
      </div>
    </div>
  );
}

function CodeBlock({ label, value, onCopied }: { label: string; value: string; onCopied?: () => void }) {
  const { t } = useTranslation();
  const copy = useCopyText();
  async function handleCopy() {
    if (await copy(value, label)) onCopied?.();
  }
  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <Button type="button" size="sm" variant="outline" onClick={handleCopy}><Copy />{t("integrations.copyTemplate")}</Button>
      </div>
      <pre className="max-h-80 min-w-0 max-w-full overflow-auto rounded-lg border bg-muted/30 p-4 font-mono text-xs leading-5 text-foreground"><code>{value}</code></pre>
    </div>
  );
}

function CallbackStatusRow({ label, seenAt, locale, border = false }: { label: string; seenAt: string | null; locale: string; border?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className={cn("flex items-center justify-between gap-4 px-4 py-3", border && "border-t")}>
      <span className="flex items-center gap-2 text-sm font-medium">
        {seenAt ? <CheckCircle2 className="size-4 text-emerald-600" /> : <Clock3 className="size-4 text-amber-600" />}
        {label}
      </span>
      <span className="text-right text-xs text-muted-foreground">{seenAt ? formatDate(seenAt, locale) : t("integrations.waiting")}</span>
    </div>
  );
}

function CredentialRow({
  credential,
  locale,
  onlyCredential,
  confirming,
  pending,
  canManage,
  onConfirm,
  onCancel,
  onRevoke,
}: {
  credential: IntegrationCredential;
  locale: string;
  onlyCredential: boolean;
  confirming: boolean;
  pending: boolean;
  canManage: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onRevoke: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <code className="block truncate font-mono text-xs">{credential.key_hint}</code>
        <p className="mt-1 text-xs text-muted-foreground">{t("integrations.createdAt", { date: formatDate(credential.created_at, locale) })}</p>
      </div>
      {!canManage ? null : confirming ? (
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={onCancel}>{t("common.cancel")}</Button>
          <Button size="sm" variant="destructive" disabled={pending} onClick={onRevoke}><Trash2 />{t("integrations.confirmRevoke")}</Button>
        </div>
      ) : (
        <Button size="sm" variant="ghost" className="text-destructive" disabled={onlyCredential} onClick={onConfirm}><Trash2 />{t("integrations.revoke")}</Button>
      )}
    </div>
  );
}

function Detail({ children, copyValue, label, mono = false }: { children: ReactNode; copyValue?: string; label: string; mono?: boolean }) {
  const { t } = useTranslation();
  const copy = useCopyText();
  return (
    <div className="grid min-h-12 grid-cols-[120px_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className={mono ? "min-w-0 break-all font-mono text-xs" : "min-w-0 text-sm"}>{children}</dd>
      {copyValue ? <Button type="button" size="icon-sm" variant="ghost" aria-label={t("integrations.copyItem", { item: label })} onClick={() => copy(copyValue, label)}><Copy /></Button> : null}
    </div>
  );
}

function SetupBadge({ status }: { status: IntegrationSetupStatus }) {
  const { t } = useTranslation();
  const verified = status === "verified";
  const disabled = status === "disabled";
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-6 rounded-md px-2 text-[11px] font-medium",
        verified && "border-emerald-200 bg-emerald-50 text-emerald-700",
        !verified && !disabled && "border-amber-200 bg-amber-50 text-amber-700",
        disabled && "bg-muted text-muted-foreground",
      )}
    >
      <span className={cn("size-1.5 rounded-full bg-muted-foreground/50", verified && "bg-emerald-500", !verified && !disabled && "bg-amber-500")} />
      {t(`integrations.setupStatuses.${status}`)}
    </Badge>
  );
}

function AdapterOption({ adapterId }: { adapterId: IntegrationAdapterId }) {
  const { t } = useTranslation();
  const adapter = adapterDefinition(adapterId);
  return (
    <span className="flex min-w-0 items-center gap-3">
      <ProtocolIcon protocol={adapter.protocol} />
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-foreground">{t(`integrations.adapters.${adapterId}`)}</span>
        <span className="mt-0.5 block truncate text-xs font-normal text-muted-foreground">{t(`integrations.adapterDescriptions.${adapterId}`)}</span>
      </span>
    </span>
  );
}

function ProtocolIcon({ protocol, size = "default" }: { protocol: IntegrationProtocol; size?: "default" | "sm" }) {
  const frameClassName = size === "sm" ? "size-7 rounded-md" : "size-10 rounded-lg";
  const iconClassName = size === "sm" ? "size-4" : "size-5";
  return (
    <span className={`flex shrink-0 items-center justify-center overflow-hidden border border-border/80 bg-background shadow-xs ${frameClassName}`}>
      {protocol === "litellm" ? <img alt="" src="/assets/integrations/litellm-train.webp" className="size-full object-cover" /> : protocol === "a2a" ? <img alt="" src="/assets/integrations/a2a-agent.png" className="size-full object-contain p-1" /> : <Webhook aria-hidden="true" className={`${iconClassName} text-primary`} />}
    </span>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="grid min-w-0 gap-2 text-sm font-medium">{label}{children}</label>;
}

function useCopyText() {
  const { t } = useTranslation();
  return async (value: string, label: string) => {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard is unavailable.");
      await navigator.clipboard.writeText(value);
      toast.success(t("integrations.copySuccess", { item: label }));
      return true;
    } catch {
      toast.error(t("integrations.copyFailed", { item: label }));
      return false;
    }
  };
}

function showMutationError(fallback: string) {
  return (error: unknown) => toast.error(error instanceof Error ? error.message : fallback);
}

function adapterDefinition(adapterId: IntegrationAdapterId) {
  return ADAPTERS.find((item) => item.id === adapterId) ?? ADAPTERS[0];
}

function shortId(id: string) {
  return id.replace(/^integration-/, "").slice(0, 8);
}

function callbackTimestamp(value: string | null, locale: string, fallback: string) {
  return value ? formatDate(value, locale) : fallback;
}

function formatDate(value: string | null, locale: string) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(locale);
}

function formatRelativeDate(value: string, locale: string) {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return value;
  const deltaSeconds = Math.round((timestamp - Date.now()) / 1_000);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (Math.abs(deltaSeconds) < 60) return formatter.format(deltaSeconds, "second");
  const deltaMinutes = Math.round(deltaSeconds / 60);
  if (Math.abs(deltaMinutes) < 60) return formatter.format(deltaMinutes, "minute");
  const deltaHours = Math.round(deltaMinutes / 60);
  if (Math.abs(deltaHours) < 24) return formatter.format(deltaHours, "hour");
  return formatter.format(Math.round(deltaHours / 24), "day");
}
