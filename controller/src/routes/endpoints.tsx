import { ResourceList } from "@/components/resource-list";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { MoreHorizontal } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { EndpointProtocolIcon } from "@/components/endpoint-protocol-icon";
import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  BookOpen,
  Check,
  CheckCircle2,
  Clock3,
  Copy,
  Eye,
  EyeOff,
  FlaskConical,
  KeyRound,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { toast } from "@/components/ui/notifications";
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
  createEndpoint,
  deleteEndpoint,
  getEndpoint,
  getEndpointDeletionImpact,
  getEndpoints,
  revokeEndpointCredential,
  rotateEndpointCredential,
  setEndpointEnabled,
  type Endpoint,
  type EndpointAdapterId,
  type EndpointCredential,
  type EndpointDeletionImpact,
  type EndpointProtocol,
  type EndpointRegistration,
  type EndpointSetupStatus,
  type OneTimeEndpointCredential,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const ADAPTERS: ReadonlyArray<{ id: EndpointAdapterId; protocol: EndpointProtocol }> = [
  { id: "litellm-generic-guardrail", protocol: "litellm" },
  { id: "generic-http-guard", protocol: "http" },
  { id: "a2a-guard", protocol: "a2a" },
];

type EndpointDeletionConfirmation = {
  reason: string;
  confirm_recent_traffic: boolean;
  confirmation_name?: string;
};

export function EndpointsPage({ endpointId, onEndpointChange }: {
  endpointId?: string;
  onEndpointChange?: (id: string | undefined) => void;
} = {}) {
  const { t, i18n } = useTranslation();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: queryKeys.endpoints, queryFn: getEndpoints, refetchInterval: 30_000 });
  const [createOpen, setCreateOpen] = useState(false);
  const [localSelected, setLocalSelected] = useState<Endpoint | null>(null);
  const linkedEndpoint = useQuery({
    queryKey: queryKeys.endpoint(endpointId ?? ""),
    queryFn: () => getEndpoint(endpointId!),
    enabled: Boolean(endpointId),
  });
  const selected = onEndpointChange ? (endpointId ? linkedEndpoint.data ?? null : null) : localSelected;
  function setSelected(endpoint: Endpoint | null) {
    if (onEndpointChange) {
      if (endpoint) queryClient.setQueryData(queryKeys.endpoint(endpoint.id), endpoint);
      onEndpointChange(endpoint?.id);
    } else setLocalSelected(endpoint);
  }
  const [deleteTarget, setDeleteTarget] = useState<Endpoint | null>(null);
  const endpoints = query.data?.items ?? [];
  const verified = endpoints.filter((item) => item.setup_status === "verified").length;
  const attention = endpoints.filter((item) => item.runtime_status === "degraded").length;
  const deletionImpactQuery = useQuery({
    queryKey: queryKeys.endpointDeletionImpact(deleteTarget?.id ?? ""),
    queryFn: () => getEndpointDeletionImpact(deleteTarget!.id),
    enabled: Boolean(deleteTarget),
    staleTime: 0,
  });
  const deleteMutation = useMutation({
    mutationFn: (confirmation: EndpointDeletionConfirmation) => deleteEndpoint(deleteTarget!.id, confirmation),
    onSuccess: async () => {
      toast.success(t("endpoints.deleteSucceeded"));
      const deletedId = deleteTarget?.id;
      if (deletedId) {
        await queryClient.cancelQueries({ queryKey: queryKeys.endpoint(deletedId) });
        queryClient.removeQueries({ queryKey: queryKeys.endpoint(deletedId) });
      }
      setDeleteTarget(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.endpoints, exact: true }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routers }),
        queryClient.invalidateQueries({ queryKey: queryKeys.metrics }),
        queryClient.invalidateQueries({ queryKey: queryKeys.auditEvents }),
        queryClient.invalidateQueries({ queryKey: queryKeys.systemStatus }),
      ]);
    },
    onError: async () => { await deletionImpactQuery.refetch(); },
  });

  async function refreshEndpoints() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.endpoints, exact: true }),
      queryClient.invalidateQueries({ queryKey: queryKeys.systemStatus }),
    ]);
  }

  async function completeCreation(endpoint: Endpoint, openDetails: boolean) {
    setCreateOpen(false);
    if (openDetails) setSelected(endpoint);
    await refreshEndpoints();
  }

  return (
    <section className="py-8">
      <PageHeader
        title={t("pages.endpoints.title")}
        description={t("endpoints.description")}
      />

      <ResourceList items={endpoints} label={t("pages.endpoints.title")} searchPlaceholder={t("resourceList.searchEndpoints")}
        searchText={item => `${item.name} ${item.id} ${item.adapter_id} ${t(`endpoints.adapters.${item.adapter_id}`)} ${item.protocol}`}
        filter={{ label: t("endpoints.setup"), options: [{ value: "", label: t("resourceList.allStatuses") }, ...[...new Set(endpoints.map(item => item.setup_status))].sort().map(value => ({ value, label: t(`endpoints.setupStatuses.${value}`) }))], matches: (item, value) => item.setup_status === value }}
        loading={query.isPending} refreshing={query.isFetching} error={query.error} onRefresh={() => void refreshEndpoints()}
        emptyTitle={t("endpoints.emptyTitle")} emptyDescription={t("endpoints.emptyDescription")}
        summary={<span>{t("endpoints.listSummary", { total: endpoints.length, verified })}{attention ? ` · ${t("endpoints.needsAttention", { count: attention })}` : ''}</span>}
        action={auth.user?.role === "admin" ? <Button variant="create" size="lg" onClick={() => setCreateOpen(true)}><Plus />{t("endpoints.register")}</Button> : undefined}>
        {items => <Table className="resource-table" aria-label={t("pages.endpoints.title")}><TableHeader><TableRow>
          <TableHead className="resource-name-column">{t("endpoints.gatewayInstance")}</TableHead>
          <TableHead>{t("endpoints.setup")}</TableHead><TableHead>{t("endpoints.successRate24h")}</TableHead>
          <TableHead>{t("endpoints.detectionP9524h")}</TableHead><TableHead>{t("endpoints.lastCallback")}</TableHead>
          <TableHead className="resource-actions-column"><span className="sr-only">{t("common.actions")}</span></TableHead>
        </TableRow></TableHeader><TableBody>{items.map(endpoint => <EndpointRow key={endpoint.id} endpoint={endpoint} onOpen={() => setSelected(endpoint)} />)}</TableBody></Table>}
      </ResourceList>

      {endpointId && !selected && <EntitySheet
        open onOpenChange={(open) => { if (!open) onEndpointChange?.(undefined); }}
        eyebrow="Endpoint" title={t("pages.endpoints.title")} description={endpointId}
        footer={<Button variant="outline" onClick={() => onEndpointChange?.(undefined)}>{t("common.close")}</Button>}
      >
        {linkedEndpoint.error ? <div className="space-y-3"><ErrorNotice error={linkedEndpoint.error} /><Button onClick={() => void linkedEndpoint.refetch()}>{t("common.retry")}</Button></div> : <Skeleton className="h-60" />}
      </EntitySheet>}
      <EndpointDetail
        endpoint={selected}
        onOpenChange={(open) => !open && setSelected(null)}
        onUpdated={refreshEndpoints}
        onDelete={auth.user?.role === "admin" ? (endpoint) => {
          setSelected(null);
          deleteMutation.reset();
          queryClient.removeQueries({ queryKey: queryKeys.endpointDeletionImpact(endpoint.id), exact: true });
          setDeleteTarget(endpoint);
        } : undefined}
      />
      {deleteTarget ? <DeleteEndpointSheet
        endpoint={deleteTarget}
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
      <CreateEndpointSheet
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={completeCreation}
      />
    </section>
  );
}

function EndpointRow({ endpoint, onOpen }: { endpoint: Endpoint; onOpen: () => void }) {
  const { t, i18n } = useTranslation();
  return <TableRow className="resource-row" onClick={onOpen}>
    <TableCell>
      <button type="button" className="resource-name" onClick={event => { event.stopPropagation(); onOpen(); }} aria-label={t("endpoints.openEndpoint", { name: endpoint.name })}>
        <EndpointProtocolIcon protocol={endpoint.protocol} size="sm" /><span>{endpoint.name}</span>
      </button>
      <span className="resource-secondary" title={`${t(`endpoints.adapters.${endpoint.adapter_id}`)} · ${endpoint.id}`}>{t(`endpoints.protocolShort.${endpoint.protocol}`)} · {shortId(endpoint.id)}</span>
    </TableCell>
    <TableCell><SetupBadge status={endpoint.setup_status} /></TableCell>
    <TableCell><EndpointSuccessRate endpoint={endpoint} /></TableCell>
    <TableCell><span className="text-xs tabular-nums" title={t("endpoints.detectionP95Explanation")}>
      {endpoint.request_count > 0 && endpoint.detection_p95_ms != null ? `${endpoint.detection_p95_ms.toLocaleString(i18n.language)} ms` : "—"}
    </span></TableCell>
    <TableCell><time className="text-xs" dateTime={endpoint.last_seen_at ?? undefined} title={formatDate(endpoint.last_seen_at, i18n.language)}>
      {endpoint.last_seen_at ? formatRelativeDate(endpoint.last_seen_at, i18n.language) : t("endpoints.never")}
    </time></TableCell>
    <TableCell className="resource-actions-column" onClick={event => event.stopPropagation()}><DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label={t("resourceList.actionsFor", { name: endpoint.name })}><MoreHorizontal /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end"><DropdownMenuItem onSelect={onOpen}><Eye />{t("resourceList.viewDetails")}</DropdownMenuItem></DropdownMenuContent>
    </DropdownMenu></TableCell>
  </TableRow>;
}

function EndpointSuccessRate({ endpoint }: { endpoint: Endpoint }) {
  const { t, i18n } = useTranslation();
  if (!endpoint.request_count) return <span className="text-xs text-muted-foreground">{t("endpoints.noRequests")}</span>;
  const successes = Math.max(0, Math.min(endpoint.request_count, endpoint.request_count - endpoint.error_count));
  // Never round a non-zero failure rate up to a perfect 100%.
  const percent = Math.floor(successes * 10_000 / endpoint.request_count) / 100;
  return <span className="block text-xs" title={t("endpoints.successRateExplanation")}>
    <span className="block font-medium tabular-nums">{percent.toLocaleString(i18n.language, { maximumFractionDigits: 2 })}%</span>
    <span className="mt-1 block text-muted-foreground">{t("endpoints.requestSample", { count: endpoint.request_count.toLocaleString(i18n.language) })}</span>
  </span>;
}


function EndpointDetail({
  endpoint,
  onDelete,
  onOpenChange,
  onUpdated,
}: {
  endpoint: Endpoint | null;
  onDelete?: (endpoint: Endpoint) => void;
  onOpenChange: (open: boolean) => void;
  onUpdated: () => Promise<void>;
}) {
  if (!endpoint) return null;
  return <EndpointDetailContent key={endpoint.id} initialEndpoint={endpoint} onDelete={onDelete} onOpenChange={onOpenChange} onUpdated={onUpdated} />;
}

function EndpointDetailContent({
  initialEndpoint,
  onDelete,
  onOpenChange,
  onUpdated,
}: {
  initialEndpoint: Endpoint;
  onDelete?: (endpoint: Endpoint) => void;
  onOpenChange: (open: boolean) => void;
  onUpdated: () => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const auth = useAuth();
  const canManage = auth.user?.role === "admin";
  const queryClient = useQueryClient();
  const copy = useCopyText();
  const query = useQuery({
    queryKey: queryKeys.endpoint(initialEndpoint.id),
    queryFn: () => getEndpoint(initialEndpoint.id),
    initialData: initialEndpoint,
    refetchInterval: 5_000,
  });
  const endpoint = query.data;
  const [oneTimeCredential, setOneTimeCredential] = useState<OneTimeEndpointCredential | null>(null);
  const [credentialSaved, setCredentialSaved] = useState(false);
  const [closeWarning, setCloseWarning] = useState(false);
  const [pendingRevokeId, setPendingRevokeId] = useState<string | null>(null);

  async function cacheEndpoint(next: Endpoint) {
    queryClient.setQueryData(queryKeys.endpoint(next.id), next);
    await onUpdated();
  }

  const enabledMutation = useMutation({
    mutationFn: (enabled: boolean) => setEndpointEnabled(endpoint.id, enabled),
    onSuccess: async (next) => {
      await cacheEndpoint(next);
      toast.success(t(next.enabled ? "endpoints.enabledSuccess" : "endpoints.disabledSuccess"));
    },
    onError: showMutationError(t("endpoints.updateFailed")),
  });

  const rotateMutation = useMutation({
    mutationFn: () => rotateEndpointCredential(endpoint.id),
    onSuccess: async (result) => {
      setOneTimeCredential(result.credential);
      setCredentialSaved(false);
      setCloseWarning(false);
      await cacheEndpoint(result.endpoint);
      toast.success(t("endpoints.credentialRotated"));
    },
    onError: showMutationError(t("endpoints.rotationFailed")),
  });

  const revokeMutation = useMutation({
    mutationFn: (credentialId: string) => revokeEndpointCredential(endpoint.id, credentialId),
    onSuccess: async () => {
      setPendingRevokeId(null);
      await query.refetch();
      await onUpdated();
      toast.success(t("endpoints.credentialRevoked"));
    },
    onError: showMutationError(t("endpoints.revocationFailed")),
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
      <Button variant="outline" onClick={() => setCloseWarning(false)}>{t("endpoints.keepSettingUp")}</Button>
      <Button variant="destructive" onClick={() => onOpenChange(false)}>{t("endpoints.leaveAndLoseKey")}</Button>
    </>
  ) : <>
    {onDelete && (!oneTimeCredential || credentialSaved) ? <Button variant="destructive" onClick={() => onDelete(endpoint)}><Trash2 />{t("endpoints.deleteAction")}</Button> : null}
    <Button variant="outline" onClick={requestClose}>{t("common.close")}</Button>
  </>;

  return (
    <EntitySheet
      open
      onOpenChange={(open) => !open && requestClose()}
      eyebrow={t("endpoints.details")}
      title={endpoint.name}
      description={null}
      density="compact"
      width="lg"
      footer={footer}
    >
      <div className="space-y-4">
        {query.error ? <ErrorNotice error={query.error} /> : null}
        {closeWarning ? <SecretExitWarning /> : null}
        {oneTimeCredential ? (
          <OneTimeCredentialCard
            credential={oneTimeCredential}
            saved={credentialSaved}
            onSavedChange={(saved) => { setCredentialSaved(saved); if (saved) setCloseWarning(false); }}
            onCopy={() => copy(oneTimeCredential.value, t("endpoints.credential"))}
          />
        ) : null}

        <section className="overflow-hidden rounded-lg border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/30 p-4">
            <div className="flex items-center gap-3">
              <EndpointProtocolIcon protocol={endpoint.protocol} />
              <div>
                <p className="text-sm font-medium">{t(`endpoints.adapters.${endpoint.adapter_id}`)}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t("endpoints.createdAt", { date: formatDate(endpoint.created_at, i18n.language) })}</p>
              </div>
              <SetupBadge status={endpoint.setup_status} />
            </div>
            <Button asChild variant="testing" size="sm"><Link to="/playground" search={{ mode: "advanced", endpoint: endpoint.id }}><FlaskConical />{t("endpoints.testEndpoint")}</Link></Button>
          </div>
          <dl className="divide-y divide-border">
            <Detail label={t("endpoints.id")} mono copyValue={endpoint.id}>{endpoint.id}</Detail>
          </dl>
          <div className="flex items-center justify-between gap-4 border-t px-4 py-4">
            <div>
              <Label htmlFor={`endpoint-enabled-${endpoint.id}`}>{t("endpoints.acceptCallbacks")}</Label>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("endpoints.acceptCallbacksDescription")}</p>
            </div>
            <Switch
              id={`endpoint-enabled-${endpoint.id}`}
              checked={endpoint.enabled}
              disabled={!canManage || enabledMutation.isPending}
              onCheckedChange={(enabled) => enabledMutation.mutate(enabled)}
              aria-label={t("endpoints.acceptCallbacks")}
            />
          </div>
        </section>

        <SetupConfiguration endpoint={endpoint} />

        <section className="overflow-hidden rounded-lg border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/30 px-4 py-3">
            <div>
              <h3 className="text-sm font-semibold">{t("endpoints.activeCredentials")}</h3>
              <p className="mt-1 text-xs text-muted-foreground">{t("endpoints.credentialRecoveryHint")}</p>
            </div>
            {canManage ? <Button variant="outline" disabled={rotateMutation.isPending} onClick={() => rotateMutation.mutate()}>
              <RefreshCw className={cn(rotateMutation.isPending && "animate-spin")} />
              {t("endpoints.generateCredential")}
            </Button> : null}
          </div>
          <div className="divide-y divide-border">
            {endpoint.credentials.map((credential) => (
              <CredentialRow
                key={credential.id}
                credential={credential}
                locale={i18n.language}
                onlyCredential={endpoint.credentials.length === 1}
                confirming={pendingRevokeId === credential.id}
                pending={revokeMutation.isPending && pendingRevokeId === credential.id}
                canManage={canManage}
                onConfirm={() => setPendingRevokeId(credential.id)}
                onCancel={() => setPendingRevokeId(null)}
                onRevoke={() => revokeMutation.mutate(credential.id)}
              />
            ))}
          </div>
          {endpoint.credentials.length === 1 ? <p className="border-t bg-muted/20 px-4 py-3 text-xs text-muted-foreground">{t("endpoints.lastCredentialRequired")}</p> : null}
        </section>

        <section className="overflow-hidden rounded-lg border bg-card">
          <div className="border-b bg-muted/30 px-4 py-3"><h3 className="text-sm font-semibold">{t("endpoints.runtimeActivity")}</h3></div>
          <dl className="grid grid-cols-3 gap-x-4 gap-y-5 p-4">
            <ActivityFact label={t("endpoints.inputCallback")}>{callbackTimestamp(endpoint.input_seen_at, i18n.language, t("endpoints.notReceived"))}</ActivityFact>
            <ActivityFact label={t("endpoints.outputCallback")}>{callbackTimestamp(endpoint.output_seen_at, i18n.language, t("endpoints.notReceived"))}</ActivityFact>
            <ActivityFact label={t("endpoints.streamFinalCheck")}>{callbackTimestamp(endpoint.stream_final_check_seen_at ?? null, i18n.language, t("endpoints.notReceived"))}</ActivityFact>
            <ActivityFact label={t("endpoints.successRate24h")}><EndpointSuccessRate endpoint={endpoint} /></ActivityFact>
            <ActivityFact label={t("endpoints.failedRequests24h")}>{endpoint.error_count.toLocaleString(i18n.language)}</ActivityFact>
            <ActivityFact label={t("endpoints.lastActivity")}>{endpoint.last_seen_at ? formatDate(endpoint.last_seen_at, i18n.language) : t("endpoints.noTraffic")}</ActivityFact>
          </dl>
        </section>
      </div>
    </EntitySheet>
  );
}

function ActivityFact({ label, children }: { label: string; children: ReactNode }) {
  return <div className="min-w-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 text-sm">{children}</dd></div>;
}

export function DeleteEndpointSheet({
  deleting,
  error,
  impact,
  endpoint,
  loading,
  locale,
  onConfirm,
  onOpenChange,
  onRetry,
  open,
}: {
  deleting: boolean;
  error: Error | null;
  impact?: EndpointDeletionImpact;
  endpoint: Endpoint;
  loading: boolean;
  locale: string;
  onConfirm: (confirmation: EndpointDeletionConfirmation) => void;
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
    entityName={endpoint.name}
    loading={loading}
    ready={telemetryFresh}
    deleting={deleting}
    error={impact && !telemetryFresh ? new Error(t("endpoints.deleteTelemetryStale")) : error}
    requiresConfirmation={requiresSecondConfirmation}
    impactItems={impact ? [
      { label: t("endpoints.recentIncomingRequests", { minutes: impact.window_minutes }), value: impact.incoming_request_count.toLocaleString(locale) },
      { label: t("endpoints.activeRoutersAffected"), value: impact.active_router_count.toLocaleString(locale) },
      { label: t("endpoints.activeCredentialsRetained"), value: impact.active_credential_count.toLocaleString(locale) },
    ] : []}
    copy={{
      eyebrow: t("endpoints.deleteEyebrow"),
      title: t("endpoints.deleteDialogTitle"),
      description: t("endpoints.deleteDialogDescription", { name: endpoint.name }),
      protectedMessage: t("endpoints.protectedDeleteWarning"),
      clearMessage: t("endpoints.noProtectedActivity"),
      retentionNote: t("endpoints.deleteRetentionNote"),
      continueLabel: t("endpoints.continueDelete"),
      deleteLabel: t("endpoints.deleteConfirm"),
      deletingLabel: t("endpoints.deleting"),
      confirmTitle: t("endpoints.deleteProtectedTitle"),
      confirmDescription: t("endpoints.deleteProtectedDescription", { requests: impact?.incoming_request_count ?? 0, minutes: impact?.window_minutes ?? 30, routers: impact?.active_router_count ?? 0 }),
      confirmWarning: t("endpoints.deleteStopsTraffic", { routers: impact?.active_router_count ?? 0, credentials: impact?.active_credential_count ?? 0 }),
      typeNameLabel: t("endpoints.typeNameToConfirm", { name: endpoint.name }),
      protectedDeleteLabel: t("endpoints.deleteDespiteProtection"),
      cancelLabel: t("common.cancel"),
      backLabel: t("common.back"),
      retryLabel: t("common.retry"),
      reasonLabel: t("endpoints.deleteReason"),
      reasonPlaceholder: t("endpoints.deleteReasonPlaceholder"),
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

export function CreateEndpointSheet({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (endpoint: Endpoint, openDetails: boolean) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [adapterId, setAdapterId] = useState<EndpointAdapterId>("litellm-generic-guardrail");
  const [registration, setRegistration] = useState<EndpointRegistration | null>(null);
  const [credentialSaved, setCredentialSaved] = useState(false);
  const [configurationCopied, setConfigurationCopied] = useState(false);
  const [closeWarning, setCloseWarning] = useState(false);
  const endpointId = registration?.endpoint.id ?? "";
  const endpointQuery = useQuery({
    queryKey: queryKeys.endpoint(endpointId),
    queryFn: () => getEndpoint(endpointId),
    enabled: open && Boolean(endpointId),
    initialData: registration?.endpoint,
    refetchInterval: (query) => query.state.data?.setup_status === "verified" ? false : 4_000,
  });
  const endpoint = endpointQuery.data ?? registration?.endpoint;

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
    mutationFn: () => createEndpoint({ name: name.trim(), adapter_id: adapterId }),
    onSuccess: (result) => {
      setRegistration(result);
      toast.success(t("endpoints.registered"));
    },
    onError: showMutationError(t("endpoints.registrationFailed")),
  });

  function finish(openDetails: boolean, force = false) {
    if (!registration || !endpoint) return;
    if (!force && !credentialSaved) {
      setCloseWarning(true);
      return;
    }
    void onCreated(endpoint, openDetails);
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
  const providerConnected = endpoint?.protocol === "litellm"
    ? Boolean(endpoint.input_seen_at || endpoint.output_seen_at)
    : configurationCopied;
  const setupComplete = [credentialSaved, providerConnected, endpoint?.setup_status === "verified"].filter(Boolean).length;
  const footer = registration ? closeWarning ? (
    <>
      <Button variant="outline" onClick={() => setCloseWarning(false)}>{t("endpoints.keepSettingUp")}</Button>
      <Button variant="destructive" onClick={() => finish(false, true)}>{t("endpoints.leaveAndLoseKey")}</Button>
    </>
  ) : (
    <>
      <Button variant="outline" onClick={() => finish(false)}>{t("endpoints.finishLater")}</Button>
      <Button onClick={() => finish(true)}>{t("endpoints.openEndpointDetails")}</Button>
    </>
  ) : (
    <>
      <Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
      <Button disabled={!name.trim() || mutation.isPending} onClick={() => mutation.mutate()}>
        <Plus />{t(mutation.isPending ? "endpoints.registering" : "endpoints.register")}
      </Button>
    </>
  );

  return (
    <EntitySheet
      open={open}
      onOpenChange={requestOpenChange}
      eyebrow={`Endpoint / ${adapter.protocol.toUpperCase()}`}
      title={t(registration ? "endpoints.setupTitle" : "endpoints.register")}
      description={t(registration ? "endpoints.setupDescription" : "endpoints.registerDescription", { name: registration?.endpoint.name })}
      width={registration ? "lg" : "md"}
      footer={footer}
    >
      {registration && endpoint ? (
        <div className="space-y-5">
          {endpointQuery.error ? <ErrorNotice error={endpointQuery.error} /> : null}
          {closeWarning ? <SecretExitWarning /> : null}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <EndpointProtocolIcon protocol={endpoint.protocol} />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{endpoint.name}</p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">{t(`endpoints.adapters.${endpoint.adapter_id}`)}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground">{t("endpoints.stepsComplete", { count: setupComplete })}</span>
              <SetupBadge status={endpoint.setup_status} />
            </div>
          </div>
          <SetupChecklist
            endpoint={endpoint}
            credential={registration.credential}
            credentialSaved={credentialSaved}
            configurationCopied={configurationCopied}
            onCredentialSavedChange={(saved) => { setCredentialSaved(saved); if (saved) setCloseWarning(false); }}
            onConfigurationCopied={() => setConfigurationCopied(true)}
          />
        </div>
      ) : (
        <div className="grid min-w-0 gap-5">
          <Field label={t("endpoints.name")}>
            <Input autoFocus className="field:min-h-11 field:rounded-lg field:bg-card" value={name} onChange={(event) => setName(event.target.value)} placeholder={t("endpoints.namePlaceholder")} />
          </Field>
          <Field label={t("endpoints.endpointProtocol")}>
            <Select value={adapterId} onValueChange={(value) => setAdapterId(value as EndpointAdapterId)}>
              <SelectTrigger variant="rich" aria-label={t("endpoints.endpointProtocol")}><SelectValue /></SelectTrigger>
              <SelectContent>
                {ADAPTERS.map((item) => <SelectItem key={item.id} value={item.id} textValue={t(`endpoints.adapters.${item.id}`)}><AdapterOption adapterId={item.id} /></SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
        </div>
      )}
    </EntitySheet>
  );
}

export function SetupChecklist({
  endpoint,
  credential,
  credentialSaved,
  configurationCopied,
  onCredentialSavedChange,
  onConfigurationCopied,
}: {
  endpoint: Endpoint;
  credential: OneTimeEndpointCredential;
  credentialSaved: boolean;
  configurationCopied: boolean;
  onCredentialSavedChange: (saved: boolean) => void;
  onConfigurationCopied: () => void;
}) {
  const { t, i18n } = useTranslation();
  const copy = useCopyText();
  return (
    <ol className="space-y-4" aria-label={t("endpoints.setupChecklist")}>
      <SetupStep
        number={1}
        title={t("endpoints.saveCredential")}
        description={endpoint.protocol === "litellm"
          ? t("endpoints.saveEndpointSecretDescription")
          : t("endpoints.saveCredentialDescription", { env: endpoint.setup.credential_env_var })}
        complete={credentialSaved}
      >
        <OneTimeCredentialCard
          credential={credential}
          saved={credentialSaved}
          onSavedChange={onCredentialSavedChange}
          onCopy={() => copy(credential.value, t("endpoints.credential"))}
          compact
        />
      </SetupStep>
      <SetupStep
        number={2}
        title={endpoint.protocol === "litellm"
          ? t("endpoints.configureTaskLatticeProvider")
          : t("endpoints.configureAdapter", { adapter: t(`endpoints.protocolShort.${endpoint.protocol}`) })}
        description={endpoint.protocol === "litellm"
          ? t("endpoints.configureTaskLatticeProviderDescription")
          : t("endpoints.configureAdapterDescription")}
        complete={endpoint.setup_status !== "applying" && (endpoint.protocol === "litellm"
          ? Boolean(endpoint.input_seen_at || endpoint.output_seen_at)
          : configurationCopied)}
      >
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
          {endpoint.setup_status === "applying" ? (
            <InfoNotice title={t("endpoints.runnerSyncTitle")}>{t("endpoints.runnerSyncDescription", { generation: endpoint.desired_generation ?? "—" })}</InfoNotice>
          ) : endpoint.protocol === "litellm" ? (
            <LiteLLMProviderSetup endpoint={endpoint.setup.api_base_url} />
          ) : (
            <>
              <CopyField label={t("endpoints.apiBaseUrl")} value={endpoint.setup.api_base_url} />
              <EnvironmentVariableValue label={t("endpoints.apiBaseEnvironmentVariable")} name={endpoint.setup.api_base_env_var} value={endpoint.setup.api_base_url} />
              <CodeBlock label={t("endpoints.configurationTemplate")} value={endpoint.setup.yaml_template} onCopied={onConfigurationCopied} />
              <SetupFacts endpoint={endpoint} />
            </>
          )}
        </div>
      </SetupStep>
      <SetupStep
        number={3}
        title={t("endpoints.verifyCallbacks")}
        description={t("endpoints.verifyCallbacksDescription")}
        complete={endpoint.setup_status === "verified"}
      >
        <div className="overflow-hidden rounded-lg border bg-card" aria-live="polite">
          <CallbackStatusRow label={t("endpoints.inputCallback")} seenAt={endpoint.input_seen_at} locale={i18n.language} />
          <CallbackStatusRow label={t("endpoints.outputCallback")} seenAt={endpoint.output_seen_at} locale={i18n.language} border />
          <div className="flex items-start gap-2 border-t bg-muted/20 px-4 py-3 text-xs leading-5 text-muted-foreground">
            <RefreshCw className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            {endpoint.setup_status === "verified" ? t("endpoints.callbacksVerified") : t("endpoints.waitingForCallbacks")}
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
          {complete ? <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700"><Check />{t("endpoints.complete")}</Badge> : null}
        </div>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
        <div className="mt-4 min-w-0">{children}</div>
      </div>
    </li>
  );
}

function EndpointSetupGuide({ protocol }: { protocol: EndpointProtocol }) {
  const { t } = useTranslation();
  return (
    <Button asChild variant="ghost" size="sm">
      <a href={`/document/developer/endpoint-setup#${protocol === "litellm" ? "endpoint-litellm" : "endpoint-adapters"}`} target="_blank" rel="noopener noreferrer">
        <BookOpen />{t("endpoints.setupGuide")}
      </a>
    </Button>
  );
}

function SetupConfiguration({ endpoint }: { endpoint: Endpoint }) {
  const { t } = useTranslation();
  return (
    <section className="overflow-hidden rounded-lg border bg-card">
      <div className="flex items-center justify-between gap-3 border-b bg-muted/30 px-4 py-3">
        <h3 className="text-sm font-semibold">{t("endpoints.connection")}</h3>
        <EndpointSetupGuide protocol={endpoint.protocol} />
      </div>
      <div className="p-4">
        <CopyField label={t(endpoint.protocol === "litellm" ? "endpoints.endpointUrl" : "endpoints.apiBaseUrl")} value={endpoint.setup.api_base_url} />
      </div>
      {endpoint.protocol !== "litellm" ? (
        <details className="border-t">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-primary focus-visible:outline-primary">{t("endpoints.connectionDetails")}</summary>
          <div className="grid min-w-0 gap-4 px-4 pb-4">
            <CopyField label={t("endpoints.callbackUrl")} value={endpoint.setup.callback_url} />
            {endpoint.setup.stream_callback_url ? <CopyField label={t("endpoints.streamCallbackUrl")} value={endpoint.setup.stream_callback_url} /> : null}
            <div className="grid grid-cols-2 gap-4">
              <CopyField label={t("endpoints.authHeader")} value={endpoint.setup.auth_header} />
              <CopyField label={t("endpoints.credentialEnvironmentVariable")} value={endpoint.setup.credential_env_var} />
            </div>
            <EnvironmentVariableValue label={t("endpoints.apiBaseEnvironmentVariable")} name={endpoint.setup.api_base_env_var} value={endpoint.setup.api_base_url} />
            <CodeBlock label={t("endpoints.configurationTemplate")} value={endpoint.setup.yaml_template} />
          </div>
        </details>
      ) : null}
    </section>
  );
}

function SetupFacts({ endpoint }: { endpoint: Endpoint }) {
  const { t } = useTranslation();
  const setup = endpoint.setup;
  return (
    <div className="space-y-3"><dl className="grid gap-3 rounded-lg bg-muted/30 p-3 text-xs sm:grid-cols-3">
      <div><dt className="text-muted-foreground">{t("endpoints.modes")}</dt><dd className="mt-1 font-medium">{setup.recommended_modes.join(" + ")}</dd></div>
      <div><dt className="text-muted-foreground">{t("endpoints.defaultBehavior")}</dt><dd className="mt-1 font-medium">{t(setup.default_on ? "endpoints.defaultOn" : "endpoints.requestSelected")}</dd></div>
      <div><dt className="text-muted-foreground">{t("endpoints.failureBehavior")}</dt><dd className="mt-1 font-medium">{t(setup.unreachable_fallback === "fail_closed" ? "endpoints.failClosed" : "endpoints.failOpen")} · {t(setup.fail_on_error ? "endpoints.blockOnError" : "endpoints.allowOnError")}</dd></div>
    </dl><dl className="grid gap-3 border-t pt-3 text-xs sm:grid-cols-3">
        {[{ label: "Input", seen: endpoint.input_seen_at }, { label: "Output", seen: endpoint.output_seen_at }, { label: "Stream", seen: endpoint.stream_final_check_seen_at }].map(({ label, seen }) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="mt-1"><StateBadge state={seen ? "ready" : "unknown"} label={t(seen ? (label === "Stream" ? "endpoints.streamFinalObserved" : "endpoints.railObserved") : "endpoints.railNotObserved")} /></dd></div>)}
      </dl></div>
  );
}

function LiteLLMProviderSetup({ endpoint }: { endpoint: string }) {
  const { t } = useTranslation();
  return (
    <div className="grid min-w-0 gap-3">
      <CopyField label={t("endpoints.endpointUrl")} value={endpoint} />
      <p className="text-xs leading-5 text-muted-foreground">{t("endpoints.endpointSecretDescription")}</p>
      <div><EndpointSetupGuide protocol="litellm" /></div>
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
  credential: OneTimeEndpointCredential;
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
            <p className="flex items-center gap-2 text-xs font-medium text-emerald-700"><CheckCircle2 className="size-4" aria-hidden="true" />{t("endpoints.credentialSaved")}</p>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">{t("endpoints.credentialSavedDescription")}</p>
            <code className="mt-2 block break-all font-mono text-xs text-foreground">{credential.key_hint}</code>
          </div>
          <Button type="button" variant="outline" className="min-h-11 shrink-0 bg-background" onClick={() => setRevealedSavedCredentialId(credential.id)}>
            <Eye aria-hidden="true" />
            {t("endpoints.revealCredential")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("rounded-lg border border-primary/20 bg-primary/5", compact ? "p-4" : "p-5")}>
      <p className="flex items-center gap-2 text-xs font-medium text-primary"><KeyRound className="size-4" aria-hidden="true" />{t("endpoints.oneTimeCredential")}</p>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">{t("endpoints.oneTimeCredentialDescription")}</p>
      <code className="mt-3 block break-all rounded-md border bg-card p-4 font-mono text-xs leading-6">{credential.value}</code>
      <div className="mt-3 flex flex-wrap items-center gap-4">
        <Button type="button" variant="outline" className="min-h-11" onClick={onCopy}><Copy />{t("endpoints.copyCredential")}</Button>
        {saved ? (
          <>
            <span className="flex min-h-11 items-center gap-2 text-xs font-medium text-emerald-700"><CheckCircle2 className="size-4" aria-hidden="true" />{t("endpoints.credentialSaved")}</span>
            <Button type="button" variant="ghost" className="min-h-11" onClick={() => setRevealedSavedCredentialId(null)}>
              <EyeOff aria-hidden="true" />
              {t("endpoints.hideCredential")}
            </Button>
          </>
        ) : (
          <Label htmlFor={checkboxId} className="min-h-11 cursor-pointer gap-3 text-xs leading-5">
            <Checkbox id={checkboxId} checked={saved} onCheckedChange={(checked) => onSavedChange(checked === true)} />
            {t("endpoints.credentialStoredConfirmation")}
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
      <AlertTitle>{t("endpoints.unsavedCredentialTitle")}</AlertTitle>
      <AlertDescription>{t("endpoints.unsavedCredentialDescription")}</AlertDescription>
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
        <Button type="button" size="icon" variant="ghost" className="size-11 rounded-none border-l" aria-label={t("endpoints.copyItem", { item: label })} onClick={() => copy(value, label)}><Copy /></Button>
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
        <Button type="button" size="icon" variant="ghost" className="size-11 rounded-none border-l" aria-label={t("endpoints.copyItem", { item: label })} onClick={() => copy(environmentVariable, label)}><Copy /></Button>
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
        <Button type="button" size="sm" variant="outline" onClick={handleCopy}><Copy />{t("endpoints.copyTemplate")}</Button>
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
      <span className="text-right text-xs text-muted-foreground">{seenAt ? formatDate(seenAt, locale) : t("endpoints.waiting")}</span>
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
  credential: EndpointCredential;
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
        <p className="mt-1 text-xs text-muted-foreground">{t("endpoints.createdAt", { date: formatDate(credential.created_at, locale) })}</p>
      </div>
      {!canManage ? null : confirming ? (
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={onCancel}>{t("common.cancel")}</Button>
          <Button size="sm" variant="destructive" disabled={pending} onClick={onRevoke}><Trash2 />{t("endpoints.confirmRevoke")}</Button>
        </div>
      ) : (
        <Button size="sm" variant="destructive" disabled={onlyCredential} onClick={onConfirm}><Trash2 />{t("endpoints.revoke")}</Button>
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
      {copyValue ? <Button type="button" size="icon-sm" variant="ghost" aria-label={t("endpoints.copyItem", { item: label })} onClick={() => copy(copyValue, label)}><Copy /></Button> : null}
    </div>
  );
}

function SetupBadge({ status }: { status: EndpointSetupStatus }) {
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
      {t(`endpoints.setupStatuses.${status}`)}
    </Badge>
  );
}

function AdapterOption({ adapterId }: { adapterId: EndpointAdapterId }) {
  const { t } = useTranslation();
  const adapter = adapterDefinition(adapterId);
  return (
    <span className="flex min-w-0 items-center gap-3">
      <EndpointProtocolIcon protocol={adapter.protocol} />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{t(`endpoints.adapters.${adapterId}`)}</span>
        <span className="mt-0.5 block text-xs font-normal text-muted-foreground">{t(`endpoints.adapterDescriptions.${adapterId}`)}</span>
      </span>
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
      toast.success(t("endpoints.copySuccess", { item: label }));
      return true;
    } catch {
      toast.error(t("endpoints.copyFailed", { item: label }));
      return false;
    }
  };
}

function showMutationError(fallback: string) {
  return (error: unknown) => toast.error(error instanceof Error ? error.message : fallback);
}

function adapterDefinition(adapterId: EndpointAdapterId) {
  return ADAPTERS.find((item) => item.id === adapterId) ?? ADAPTERS[0];
}

function shortId(id: string) {
  return id.replace(/^endpoint-/, "").slice(0, 8);
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
