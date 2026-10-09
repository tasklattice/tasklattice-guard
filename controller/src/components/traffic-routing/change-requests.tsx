import { useTranslation } from "react-i18next";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardCheck, Siren, ArrowUpRight } from "lucide-react";
import * as api from "@/lib/traffic-routing-api";
import { toast } from "@/components/ui/notifications";
import { EntitySheet } from "../entity-sheet";
import { ErrorNotice, StateBadge } from "../product-shell";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Field } from "./form";
import { Changes } from "./routing-changes";
import { AttachedEndpoints, RoutedVersions } from "./review-submit-sheet";
import { revisionLabel } from "./router-view-model";

const changeKeys = (routerId: string) => [...api.trafficRouterKeys.detail(routerId), "change-requests"] as const;
const badgeState: Record<api.RouterChangeRequestStatus, string> = {
  pending: "waiting", applied: "active", rejected: "failed", withdrawn: "unknown", superseded: "stale",
};

function useRefreshRouter(routerId: string) {
  const client = useQueryClient();
  return async () => {
    await client.invalidateQueries({ queryKey: api.trafficRouterKeys.all });
    await client.invalidateQueries({ queryKey: changeKeys(routerId) });
  };
}

function ChangeStatus({ change }: { change: api.RouterChangeRequest }) {
  const { t: localize } = useTranslation();
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <StateBadge state={badgeState[change.status]} label={localize(`routing.changeStatus.${change.status}`)} />
      {change.emergencyReason && <Badge variant="destructive">{localize("routing.emergency")}</Badge>}
      {change.kind === "revert" && <Badge variant="outline">{localize("routing.rollbackChange")}</Badge>}
    </span>
  );
}

function ChangeFacts({ change }: { change: api.RouterChangeRequest }) {
  const { t: localize } = useTranslation();
  const rows: Array<[string, string]> = [
    [localize("routing.changeReason"), change.reason],
    [localize("routing.changeTicket"), change.ticket || "—"],
    [localize("routing.submittedBy"), `${change.submittedByName ?? change.submittedBy} · ${new Date(change.submittedAt).toLocaleString()}`],
  ];
  if (change.decidedAt) rows.push([localize("routing.decidedBy"), `${change.decidedByName ?? change.decidedBy ?? localize("routing.system")} · ${new Date(change.decidedAt).toLocaleString()}`]);
  if (change.decisionNote) rows.push([localize("routing.decisionNote"), change.decisionNote]);
  if (change.emergencyReason) rows.push([localize("routing.emergencyReason"), change.emergencyReason], [localize("routing.managerContact"), change.emergencyContact ?? "—"]);
  return (
    <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-2 rounded-lg border p-4 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 whitespace-pre-wrap break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function PendingChangeNotice({ change, onOpen }: { change: api.RouterChangeRequest; onOpen: () => void }) {
  const { t: localize } = useTranslation();
  return (
    <div className="router-draft-notice" role="status">
      <ClipboardCheck aria-hidden="true" className="router-draft-icon" />
      <div className="router-draft-copy">
        <p className="text-sm font-medium">{localize("routing.changeAwaitingApproval")}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {localize("routing.changeAwaitingApprovalDetail", {
            name: change.submittedByName ?? change.submittedBy,
            time: new Date(change.submittedAt).toLocaleString(),
          })}
          {change.ticket ? ` · ${change.ticket}` : ""}
        </p>
      </div>
      <Button variant="outline" onClick={onOpen}>{localize("routing.reviewChange")}</Button>
    </div>
  );
}

type ChangeRequestSheetProps = {
  router: api.TrafficRouter;
  change: api.RouterChangeRequest;
  revisions: api.RouterRevision[];
  names: Array<{ id: string; name: string }>;
  endpoints: Array<{ id: string; name: string }>;
  currentUserId: string | undefined;
  canDecide: boolean;
  onClose: () => void;
  onOpenRevision: (revision: number) => void;
};

export function ChangeRequestDetails({ changeId, ...props }: Omit<ChangeRequestSheetProps, "change"> & { changeId: string }) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: [...changeKeys(props.router.id), changeId],
    queryFn: () => api.getRouterChangeRequest(props.router.id, changeId),
    refetchInterval: 10000,
  });
  if (!query.data || query.error) return <EntitySheet open title={t("routing.changeRequest")} eyebrow={props.router.name} description={null} footer={<Button variant="outline" onClick={props.onClose}>{t("routing.close")}</Button>} onOpenChange={open => { if (!open) props.onClose(); }}>
    {query.error ? <><ErrorNotice error={query.error} /><Button variant="outline" onClick={() => void query.refetch()}>{t("routing.retry")}</Button></> : <p role="status">{t("routing.loadingChangeRequests")}</p>}
  </EntitySheet>;
  return <ChangeRequestSheet {...props} change={query.data} />;
}

type Decision = "view" | "reject" | "emergency";

/** Review a pending change. The submitter may withdraw or apply it in an emergency; another administrator approves or rejects it. */
export function ChangeRequestSheet({
  router,
  change,
  names,
  endpoints,
  currentUserId,
  canDecide,
  onClose,
  revisions,
  onOpenRevision,
}: ChangeRequestSheetProps) {
  const { t: localize } = useTranslation();
  const refresh = useRefreshRouter(router.id);
  const [decision, setDecision] = useState<Decision>("view");
  const [note, setNote] = useState("");
  const [emergencyReason, setEmergencyReason] = useState("");
  const [managerContact, setManagerContact] = useState("");
  const submitter = change.submittedBy === currentUserId;
  const awaiting = change.status === "pending";
  const base = revisions.find(r => r.revision === change.baseRevision);
  const published = revisions.find(r => r.revision === change.appliedRevision);
  const finish = async (message: string) => {
    toast.success(message);
    await refresh();
    setDecision("view");
  };
  const approve = useMutation({
    mutationFn: () => api.approveRouterChange(router.id, change.id, note.trim() || undefined),
    onSuccess: () => finish(localize("routing.changeApplied")),
  });
  const emergency = useMutation({
    mutationFn: () => api.emergencyApplyRouterChange(router.id, change.id, { reason: emergencyReason.trim(), managerContact: managerContact.trim() }),
    onSuccess: () => finish(localize("routing.changeApplied")),
  });
  const reject = useMutation({
    mutationFn: () => api.rejectRouterChange(router.id, change.id, note.trim()),
    onSuccess: () => finish(localize("routing.changeRejected")),
  });
  const withdraw = useMutation({
    mutationFn: () => api.withdrawRouterChange(router.id, change.id),
    onSuccess: () => finish(localize("routing.changeWithdrawn")),
  });
  const pending = approve.isPending || emergency.isPending || reject.isPending || withdraw.isPending;
  const error = approve.error ?? emergency.error ?? reject.error ?? withdraw.error;
  const actions = !canDecide || !awaiting ? null : decision === "reject" ? (
    <>
      <Button variant="outline" disabled={pending} onClick={() => setDecision("view")}>{localize("routing.back")}</Button>
      <Button variant="destructive" disabled={pending || !note.trim()} onClick={() => reject.mutate()}>{localize("routing.rejectChange")}</Button>
    </>
  ) : decision === "emergency" ? (
    <>
      <Button variant="outline" disabled={pending} onClick={() => setDecision("view")}>{localize("routing.back")}</Button>
      <Button variant="destructive" disabled={pending || !emergencyReason.trim() || !managerContact.trim()} onClick={() => emergency.mutate()}>
        <Siren aria-hidden="true" />{emergency.isPending ? localize("routing.applying") : localize("routing.applyNow")}
      </Button>
    </>
  ) : submitter ? (
    <>
      <Button variant="outline" disabled={pending} onClick={() => withdraw.mutate()}>{localize("routing.withdrawChange")}</Button>
      <Button variant="outline" disabled={pending} onClick={() => setDecision("emergency")}><Siren aria-hidden="true" />{localize("routing.emergencyApply")}</Button>
    </>
  ) : (
    <>
      <Button variant="outline" disabled={pending} onClick={() => { setNote(""); setDecision("reject"); }}>{localize("routing.reject")}</Button>
      <Button disabled={pending} onClick={() => approve.mutate()}>{approve.isPending ? localize("routing.applying") : localize("routing.approveAndApply")}</Button>
    </>
  );
  return (
    <EntitySheet
      open
      width="xl"
      eyebrow={localize("routing.changeRequest")}
      title={localize(awaiting ? "routing.reviewPendingChange" : "routing.changeRequest")}
      description={localize(!awaiting ? "routing.closedChangeDescription" : submitter && canDecide ? "routing.ownChangeNeedsAnotherApprover" : "routing.approvalAppliesExactlyThisSnapshot")}
      closeDisabled={pending}
      onOpenChange={(open) => { if (!open && !pending) onClose(); }}
      footer={
        <>
          <Button variant="ghost" disabled={pending} onClick={onClose}>{localize("routing.close")}</Button>
          {published && <Button onClick={() => onOpenRevision(published.revision)}>{localize("routing.viewPublishedRevision")}<ArrowUpRight /></Button>}
          {actions}
        </>
      }
    >
      <div className="space-y-4">
        <ChangeStatus change={change} />
        <ChangeFacts change={change} />
        {awaiting && decision === "view" && canDecide && !submitter && (
          <Field label={localize("routing.approvalNoteOptional")}>
            <Textarea value={note} maxLength={2000} rows={2} onChange={(event) => setNote(event.target.value)} />
          </Field>
        )}
        {awaiting && canDecide && decision === "reject" && (
          <Field label={localize("routing.rejectionNote")}>
            <Textarea value={note} maxLength={2000} rows={3} autoFocus onChange={(event) => setNote(event.target.value)} />
          </Field>
        )}
        {awaiting && canDecide && decision === "emergency" && (
          <div role="group" aria-label={localize("routing.emergencyApply")} className="space-y-4 rounded-lg border border-destructive/40 p-4">
            <p className="text-sm">{localize("routing.emergencyApplyWarning")}</p>
            <Field label={localize("routing.emergencyReason")}>
              <Textarea value={emergencyReason} maxLength={2000} rows={3} autoFocus onChange={(event) => setEmergencyReason(event.target.value)} />
            </Field>
            <Field label={localize("routing.managerContact")}>
              <Input value={managerContact} maxLength={256} placeholder={localize("routing.managerContactPlaceholder")} onChange={(event) => setManagerContact(event.target.value)} />
            </Field>
          </div>
        )}
        {error && <ErrorNotice error={error} />}
      </div>
      <div className="mt-6">
        {change.baseRevision === null || base ? <Changes before={base?.snapshot ?? null} after={change.snapshot} names={change.context?.guardrails ?? names} /> : <p className="text-sm text-muted-foreground">{localize("routing.changeBaseUnavailable")}</p>}
      </div>
      <RoutedVersions snapshot={change.snapshot} names={change.context?.guardrails ?? names} />
      <AttachedEndpoints ids={change.endpointIds} endpoints={change.context?.endpoints ?? endpoints} />
    </EntitySheet>
  );
}

/** Submit a historical snapshot through the same approval flow as routing edits. */
export function RestoreRevisionSheet({ router, target, revisions, names, endpoints, hasLocalEdits, onClose, onSubmitted }: {
  router: api.TrafficRouter; target: api.RouterRevision; revisions: api.RouterRevision[];
  names: Array<{ id: string; name: string }>; endpoints: Array<{ id: string; name: string }>;
  hasLocalEdits: boolean; onClose: () => void; onSubmitted: (change: api.RouterChangeRequest) => void;
}) {
  const { t } = useTranslation();
  const refresh = useRefreshRouter(router.id);
  const [reviewedRouter] = useState(router);
  const [reason, setReason] = useState("");
  const [ticket, setTicket] = useState("");
  const current = revisions.find(r => r.revision === reviewedRouter.activeRevision);
  const stale = router.activeRevision !== reviewedRouter.activeRevision || router.draftRevision !== reviewedRouter.draftRevision
    || JSON.stringify([...router.endpointIds].sort()) !== JSON.stringify([...reviewedRouter.endpointIds].sort());
  const blocked = stale || Boolean(router.pendingChangeRequest) || !current || target.revision === router.activeRevision;
  const replacesDraft = hasLocalEdits || JSON.stringify(reviewedRouter.draft) !== JSON.stringify(reviewedRouter.activeSnapshot);
  const submit = useMutation({
    mutationFn: () => api.submitRouterChange(router.id, {
      expectedDraftRevision: reviewedRouter.draftRevision,
      restore: { revision: target.revision, expectedActiveRevision: reviewedRouter.activeRevision! },
      reviewedSnapshot: target.snapshot,
      reviewedEndpointIds: reviewedRouter.endpointIds,
      reason: reason.trim(), ticket: ticket.trim(),
    }),
    onSuccess: async change => {
      onSubmitted(change);
      await refresh();
      toast.success(t("routing.changeSubmitted"));
    },
  });
  return <EntitySheet open width="xl" eyebrow={t("routing.routerRevision")}
    title={t("routing.restoreVersionTitle", { revision: revisionLabel(target) })}
    description={t("routing.restoreVersionDescription")}
    closeDisabled={submit.isPending}
    onOpenChange={open => { if (!open && !submit.isPending) onClose(); }}
    footer={<>
      <Button variant="outline" disabled={submit.isPending} onClick={onClose}>{t("routing.cancel")}</Button>
      <Button disabled={submit.isPending || blocked || !reason.trim()} onClick={() => submit.mutate()}>{t(submit.isPending ? "routing.submitting" : "routing.submitForApproval")}</Button>
    </>}>
    <dl className="mb-5 grid grid-cols-[10rem_1fr] gap-x-4 gap-y-3 text-sm">
      <dt className="text-muted-foreground">{t("routing.restoreCurrentVersion")}</dt><dd className="font-mono">{revisionLabel(current)}</dd>
      <dt className="text-muted-foreground">{t("routing.restoreTargetVersion")}</dt><dd className="font-mono">{revisionLabel(target)}</dd>
    </dl>
    <div className="space-y-4">
      {stale && <p role="alert" className="text-sm text-destructive">{t("routing.restoreReviewStale")}</p>}
      {router.pendingChangeRequest && <p role="alert" className="text-sm">{t("routing.restorePendingChange")}</p>}
      {!current && <p role="alert" className="text-sm">{t("routing.restoreCurrentUnavailable")}</p>}
      {replacesDraft && <p className="text-sm">{t("routing.restoreReplacesDraft")}</p>}
      <Field label={t("routing.changeReason")}><Textarea value={reason} maxLength={2000} rows={3} onChange={event => setReason(event.target.value)} /></Field>
      <Field label={t("routing.changeTicketOptional")}><Input value={ticket} maxLength={128} onChange={event => setTicket(event.target.value)} /></Field>
      {submit.error && <ErrorNotice error={submit.error} />}
    </div>
    {current && <div className="mt-6"><Changes before={current.snapshot} after={target.snapshot} names={[...names, ...(target.context?.guardrails ?? []), ...(current.context?.guardrails ?? [])]} /></div>}
    <RoutedVersions snapshot={target.snapshot} names={target.context?.guardrails ?? names} />
    <AttachedEndpoints ids={reviewedRouter.endpointIds} endpoints={endpoints} />
  </EntitySheet>;
}

export function ChangeRequestHistory({ routerId, revisions, onOpenChange, onOpenRevision }: {
  routerId: string; revisions: api.RouterRevision[];
  onOpenChange: (id: string) => void; onOpenRevision: (revision: number) => void;
}) {
  const { t: localize } = useTranslation();
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(1);
  const changes = useQuery({ queryKey: changeKeys(routerId), queryFn: () => api.listRouterChangeRequests(routerId), refetchInterval: 10000 });
  const filtered = (changes.data?.items ?? []).filter(change => filter === "all" || change.status === filter)
    .sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending") || Date.parse(b.submittedAt) - Date.parse(a.submittedAt));
  const pageSize = 10;
  const currentPage = Math.min(page, Math.max(1, Math.ceil(filtered.length / pageSize)));
  const visible = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  return (
    <section className="space-y-4" aria-label={localize("routing.tabs.change-requests")}>
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">{localize("routing.changeRequestsDescription")}</p>
        <Select value={filter} onValueChange={value => { setFilter(value); setPage(1); }}>
          <SelectTrigger className="w-56 shrink-0" aria-label={localize("routing.changeStatusFilter")}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{localize("routing.allChangeStatuses")}</SelectItem>
            {(["pending", "applied", "rejected", "withdrawn", "superseded"] as const).map(status => <SelectItem key={status} value={status}>{localize(`routing.changeStatus.${status}`)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      {changes.error ? <><ErrorNotice error={changes.error} /><Button variant="outline" onClick={() => void changes.refetch()}>{localize("routing.retry")}</Button></>
        : changes.isPending ? <p role="status">{localize("routing.loadingChangeRequests")}</p>
        : !filtered.length ? <p className="border border-dashed p-6 text-sm">{localize(filter === "all" ? "routing.noChangeRequests" : "routing.noMatchingChangeRequests")}</p>
        : <>
          <Table>
            <TableHeader><TableRow>
              {[localize("routing.changeReason"), localize("routing.status"), localize("routing.submitted"), localize("routing.submittedBy"), localize("routing.decidedBy"), localize("routing.revision")].map(h => <TableHead key={h}>{h}</TableHead>)}
            </TableRow></TableHeader>
            <TableBody>
              {visible.map(change => {
                const revision = revisions.find(r => r.revision === change.appliedRevision);
                return <TableRow key={change.id}>
                  <TableCell className="max-w-80">
                    <button type="button" className="min-h-11 text-left text-primary hover:underline whitespace-pre-wrap break-words" onClick={() => onOpenChange(change.id)}>{change.reason}</button>
                    {change.ticket && <p className="text-xs text-muted-foreground">{change.ticket}</p>}
                  </TableCell>
                  <TableCell><ChangeStatus change={change} /></TableCell>
                  <TableCell className="whitespace-nowrap">{new Date(change.submittedAt).toLocaleString()}</TableCell>
                  <TableCell>{change.submittedByName ?? change.submittedBy}</TableCell>
                  <TableCell>{change.decidedAt ? change.decidedByName ?? change.decidedBy ?? localize("routing.system") : "—"}</TableCell>
                  <TableCell>{revision ? <Button variant="link" className="px-0 font-mono text-xs" onClick={() => onOpenRevision(revision.revision)}>{revisionLabel(revision)}<ArrowUpRight /></Button> : change.appliedRevision !== null ? <span className="text-xs text-muted-foreground">{localize("routing.revisionUnavailable")}</span> : "—"}</TableCell>
                </TableRow>;
              })}
            </TableBody>
          </Table>
          {filtered.length > pageSize && <nav className="flex items-center justify-between gap-3 border-t py-3" aria-label={localize("routing.requestPages")}>
            <span className="text-xs tabular-nums text-muted-foreground">{localize("immutableVersions.rows", { start: (currentPage - 1) * pageSize + 1, end: Math.min(currentPage * pageSize, filtered.length), total: filtered.length })}</span>
            <div className="flex gap-2">
              <Button variant="outline" disabled={changes.isFetching || currentPage === 1} onClick={() => setPage(currentPage - 1)}>{localize("immutableVersions.previousPage")}</Button>
              <Button variant="outline" disabled={changes.isFetching || currentPage * pageSize >= filtered.length} onClick={() => setPage(currentPage + 1)}>{localize("immutableVersions.nextPage")}</Button>
            </div>
          </nav>}
        </>}
    </section>
  );
}
