import { useTranslation } from "react-i18next";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardCheck, Siren, Undo2 } from "lucide-react";
import * as api from "@/lib/traffic-routing-api";
import { toast } from "@/components/ui/notifications";
import { EntitySheet } from "../entity-sheet";
import { ErrorNotice, StateBadge } from "../product-shell";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { Field } from "./form";
import { Changes } from "./routing-changes";
import { AttachedEndpoints, ResolvedVersions } from "./review-submit-sheet";
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
}: {
  router: api.TrafficRouter;
  change: api.RouterChangeRequest;
  names: Array<{ id: string; name: string }>;
  endpoints: Array<{ id: string; name: string }>;
  currentUserId: string | undefined;
  canDecide: boolean;
  onClose: () => void;
}) {
  const { t: localize } = useTranslation();
  const refresh = useRefreshRouter(router.id);
  const [decision, setDecision] = useState<Decision>("view");
  const [note, setNote] = useState("");
  const [emergencyReason, setEmergencyReason] = useState("");
  const [managerContact, setManagerContact] = useState("");
  const submitter = change.submittedBy === currentUserId;
  const finish = async (message: string) => {
    toast.success(message);
    await refresh();
    onClose();
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
  const actions = !canDecide ? null : decision === "reject" ? (
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
      title={localize("routing.reviewPendingChange")}
      description={submitter && canDecide ? localize("routing.ownChangeNeedsAnotherApprover") : localize("routing.approvalAppliesExactlyThisSnapshot")}
      closeDisabled={pending}
      onOpenChange={(open) => { if (!open && !pending) onClose(); }}
      footer={
        <>
          <Button variant="ghost" disabled={pending} onClick={onClose}>{localize("routing.close")}</Button>
          {actions}
        </>
      }
    >
      <div className="space-y-4">
        <ChangeFacts change={change} />
        {decision === "view" && canDecide && !submitter && (
          <Field label={localize("routing.approvalNoteOptional")}>
            <Textarea value={note} maxLength={2000} rows={2} onChange={(event) => setNote(event.target.value)} />
          </Field>
        )}
        {decision === "reject" && (
          <Field label={localize("routing.rejectionNote")}>
            <Textarea value={note} maxLength={2000} rows={3} autoFocus onChange={(event) => setNote(event.target.value)} />
          </Field>
        )}
        {decision === "emergency" && (
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
        <Changes before={router.activeSnapshot} after={change.snapshot} names={names} />
      </div>
      <ResolvedVersions snapshot={change.snapshot} names={names} />
      <AttachedEndpoints ids={change.endpointIds} endpoints={endpoints} />
    </EntitySheet>
  );
}

/** Restore the base revision of the active change; it was approved together with that change. */
export function RevertChangeSheet({ router, label, onClose }: { router: api.TrafficRouter; label: string; onClose: () => void }) {
  const { t: localize } = useTranslation();
  const refresh = useRefreshRouter(router.id);
  const target = router.revertibleChangeRequest!;
  const [reason, setReason] = useState("");
  const revert = useMutation({
    mutationFn: () => api.revertRouterChange(router.id, target.id, reason.trim()),
    onSuccess: async () => {
      toast.success(localize("routing.rolledBack", { revision: label }));
      await refresh();
      onClose();
    },
  });
  return (
    <EntitySheet
      open
      eyebrow={localize("routing.router")}
      title={localize("routing.rollBackToRevision", { revision: label })}
      description={localize("routing.preApprovedRollbackDescription", { revision: label })}
      closeDisabled={revert.isPending}
      onOpenChange={(open) => { if (!open && !revert.isPending) onClose(); }}
      footer={
        <>
          <Button variant="outline" disabled={revert.isPending} onClick={onClose}>{localize("routing.cancel")}</Button>
          <Button variant="destructive" disabled={revert.isPending || !reason.trim()} onClick={() => revert.mutate()}>
            <Undo2 aria-hidden="true" />{localize("routing.rollBack")}
          </Button>
        </>
      }
    >
      <Field label={localize("routing.rollbackReason")}>
        <Textarea value={reason} maxLength={2000} rows={3} autoFocus onChange={(event) => setReason(event.target.value)} />
      </Field>
      {revert.error && <div className="mt-4"><ErrorNotice error={revert.error} /></div>}
    </EntitySheet>
  );
}

export function ChangeRequestHistory({ routerId, revisions }: { routerId: string; revisions: api.RouterRevision[] }) {
  const { t: localize } = useTranslation();
  const changes = useQuery({ queryKey: changeKeys(routerId), queryFn: () => api.listRouterChangeRequests(routerId) });
  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">{localize("routing.changeRequests")}</h2>
      <p className="text-sm text-muted-foreground">{localize("routing.changeRequestsDescription")}</p>
      {changes.error ? <ErrorNotice error={changes.error} />
        : changes.isPending ? <p role="status">{localize("routing.loadingChangeRequests")}</p>
        : !changes.data.items.length ? <p className="rounded-lg border border-dashed p-6 text-sm">{localize("routing.noChangeRequests")}</p>
        : (
          <Table>
            <TableHeader>
              <TableRow>
                {[localize("routing.submitted"), localize("routing.status"), localize("routing.changeTicket"), localize("routing.changeReason"),
                  localize("routing.submittedBy"), localize("routing.decidedBy"), localize("routing.revision")].map(h => <TableHead key={h}>{h}</TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {changes.data.items.map(change => (
                <TableRow key={change.id}>
                  <TableCell className="whitespace-nowrap">{new Date(change.submittedAt).toLocaleString()}</TableCell>
                  <TableCell><ChangeStatus change={change} /></TableCell>
                  <TableCell>{change.ticket || "—"}</TableCell>
                  <TableCell className="max-w-80 whitespace-pre-wrap break-words">{change.emergencyReason ? `${change.reason}\n${localize("routing.emergencyReason")}: ${change.emergencyReason} (${change.emergencyContact})` : change.reason}</TableCell>
                  <TableCell>{change.submittedByName ?? change.submittedBy}</TableCell>
                  <TableCell>{change.decidedAt ? change.decidedByName ?? change.decidedBy ?? localize("routing.system") : "—"}</TableCell>
                  <TableCell className="font-mono text-xs">{change.appliedRevision === null ? "—" : revisionLabel(revisions.find(r => r.revision === change.appliedRevision))}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
    </section>
  );
}
