import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, RotateCcw, Trash2 } from "lucide-react";
import { deleteRouterRevision, trafficRouterKeys } from "@/lib/traffic-routing-api";
import { ConfirmationSheet } from "../confirmation-sheet";
import { StateBadge } from "../product-shell";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { useState } from "react";
import type {
  RouterRevision,
  TrafficRouter,
} from "@/lib/traffic-routing-api";
import { EntitySheet } from "../entity-sheet";
import { Button } from "../ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";
import {
  revisionLabel,
  routingDiff,
  selectorSummary,
} from "./router-view-model";
import { percent } from "./form";

import { Changes } from "./routing-changes";
export { Changes } from "./routing-changes";

export function RouterRevisions({
  router,
  revisions,
  canEdit,
  onRestore,
  selectedRevision,
  onSelectRevision,
  onOpenChange,
}: {
  router: TrafficRouter;
  revisions: RouterRevision[];
  canEdit: boolean;
  onRestore: (r: RouterRevision) => void;
  selectedRevision: number | null;
  onSelectRevision: (revision: number | null) => void;
  onOpenChange: (id: string) => void;
}) {
  const { t: localize } = useTranslation();
  const selected = revisions.find(r => r.revision === selectedRevision);
  const setSelected = (r: RouterRevision | null) => onSelectRevision(r?.revision ?? null);
  const [deleting, setDeleting] = useState<RouterRevision | null>(null);
  const client = useQueryClient();
  const remove = useMutation({ mutationFn: (revision: number) => deleteRouterRevision(router.id, revision), onSuccess: async () => { setDeleting(null); setSelected(null); await client.invalidateQueries({ queryKey: trafficRouterKeys.all }); } });
  const status = (r: RouterRevision) =>
    r.revision === router.activeRevision
      ? router.rolloutStatus === "active"
        ? localize("routing.active")
        : router.rolloutStatus === "failed"
          ? localize("routing.failed")
          : localize("routing.deploying")
      : localize("routing.previous");
  return (
    <section className="space-y-4" aria-label={localize("routing.tabs.revisions")}>
      <p className="text-sm text-muted-foreground">{localize("routing.revisionsRestoreDescription")}</p>
      {!revisions.length ? (
        <p className="rounded-lg border border-dashed p-6 text-sm">{localize("routing.noPublishedRevisions2")}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              {[
                localize("routing.revision"),
                localize("routing.status"),
                localize("routing.published"),
                localize("routing.publishedBy"),
                localize("routing.changes2"),
                localize("routing.actions"),
              ].map((h) => (
                <TableHead key={h}>{h}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {revisions.map((r, index) => (
              <TableRow key={r.revision}>
                <TableCell>
                  <Button
                    variant="link"
                    className="px-0 font-mono text-xs"
                    onClick={() => setSelected(r)}
                  >
                    {revisionLabel(r)}
                  </Button>
                </TableCell>
                <TableCell><StateBadge state={status(r)} /></TableCell>
                <TableCell>{new Date(r.createdAt).toLocaleString()}</TableCell>
                <TableCell>{r.createdBy ?? localize("routing.unknown")}</TableCell>
                <TableCell>
                  {
                    routingDiff(
                      revisions[index + 1]?.snapshot ?? null,
                      r.snapshot,
                    ).length
                  }{" "}{localize("routing.changes")}</TableCell>
                <TableCell>
                  {canEdit && <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" className="size-11" aria-label={localize("routing.revisionActions", { revision: revisionLabel(r) })}><MoreHorizontal /></Button></DropdownMenuTrigger><DropdownMenuContent align="end">
                    {r.revision !== router.activeRevision && <DropdownMenuItem variant="edit" disabled={remove.isPending} onSelect={() => onRestore(r)}><RotateCcw />{localize("routing.restoreVersionAction")}</DropdownMenuItem>}
                    <DropdownMenuItem variant="destructive" disabled={r.revision === router.activeRevision || remove.isPending} onSelect={() => { remove.reset(); setDeleting(r); }}><Trash2 />{localize("routing.delete")}</DropdownMenuItem>
                  </DropdownMenuContent></DropdownMenu>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <ConfirmationSheet open={deleting !== null} onOpenChange={open => { if (!open) setDeleting(null); }} eyebrow={localize("routing.routerRevision")} title={localize("routing.deleteRevisionTitle", { revision: deleting ? revisionLabel(deleting) : "" })} description={localize("routing.thisPermanentlyRemovesTheHistoricalConfigurationFromRevisionHistory")} cancelLabel={localize("routing.cancel")} confirmLabel={localize("routing.deleteRevision")} variant="destructive" pending={remove.isPending} onConfirm={() => { if (deleting) remove.mutate(deleting.revision); }}>
        {remove.error && <p role="alert" className="text-sm text-destructive">{remove.error.message}</p>}
      </ConfirmationSheet>
      {selected && (
        <EntitySheet
          open
          eyebrow={localize("routing.routerRevision")}
          title={localize("routing.revisionTitle", { revision: revisionLabel(selected) })}
          description={`${new Date(selected.createdAt).toLocaleString()} · ${selected.createdBy ?? localize("routing.unknownAuthor")}`}
          onOpenChange={(open) => {
            if (!open) setSelected(null);
          }}
          footer={
            <>
              <Button variant="outline" onClick={() => setSelected(null)}>{localize("routing.close")}</Button>
              {canEdit && selected.revision !== router.activeRevision && (
                <Button
                  variant="edit"
                  onClick={() => {
                    onRestore(selected);
                    setSelected(null);
                  }}
                >{localize("routing.restoreVersionAction")}</Button>
              )}
            </>
          }
        >
          <section className="space-y-3">
            <StateBadge state={status(selected)} />
            {selected.changeRequestId && <Button variant="link" onClick={() => onOpenChange(selected.changeRequestId!)}>{localize("routing.viewChangeRequest")}</Button>}
            <h3 className="font-medium">{localize("routing.endpointsSnapshot")}</h3>
            {selected.context ? (
              selected.context.endpoints.length ? (
                selected.context.endpoints.map((e) => (
                  <p key={e.id} className="text-sm">
                    {e.name} · {e.adapter}
                    <span className="block text-xs text-muted-foreground">
                      {e.id}
                    </span>
                  </p>
                ))
              ) : (
                <p className="text-sm">{localize("routing.noEndpointsWereAttachedAtPublication")}</p>
              )
            ) : (
              <p className="text-sm text-muted-foreground">{localize("routing.thisOlderRevisionDidNotCaptureEndpointContextHistorical")}</p>
            )}
            <p className="text-xs text-muted-foreground">{localize("routing.membershipAtPublicationLaterAttachDetachActionsAreRecorded")}</p>
          </section>
          <section className="mt-6 space-y-3">
            <h3 className="font-medium">{localize("routing.routingSnapshot")}</h3>
            {selected.snapshot.routes.map((r, i) => (
              <div key={r.id} className="rounded-lg border p-3 text-sm">
                <p className="font-medium">
                  {r.kind === "fallback" ? localize("routing.fallback") : `${i + 1}. ${r.name}`}
                  {!r.enabled ? " · Disabled" : ""}
                </p>
                <p className="mt-1 break-words text-xs text-muted-foreground">
                  {r.kind === "fallback"
                    ? localize("routing.allUnmatchedTraffic")
                    : selectorSummary(r.selector.expression)}
                </p>
                {r.targets.map((t) => (
                  <p key={t.id} className="mt-2 break-words text-xs">
                    {selected.context?.guardrails.find(
                      (g) => g.id === t.guardrailId,
                    )?.name ?? t.guardrailId}{" "}
                    · {t.guardrailVersion} · {percent(t.weightBps)}
                  </p>
                ))}
              </div>
            ))}
          </section>
          <section className="mt-6 space-y-3">
            <h3 className="font-medium">{localize("routing.guardRailVersions2")}</h3>
            {Array.from(
              new Map(
                selected.snapshot.routes
                  .flatMap((r) => r.targets)
                  .map((t) => [`${t.guardrailId}:${t.guardrailVersion}`, t]),
              ).values(),
            ).map((t) => (
              <p
                key={`${t.guardrailId}:${t.guardrailVersion}`}
                className="break-words text-sm"
              >
                {selected.context?.guardrails.find(
                  (g) => g.id === t.guardrailId,
                )?.name ?? t.guardrailId}{" "}
                · {t.guardrailVersion}
              </p>
            ))}
          </section>
          <section className="mt-6 space-y-3">
            <h3 className="font-medium">
              {revisions.find((r) => r.revision === selected.revision - 1)
                ? localize("routing.changesFrom", { revision: revisionLabel(revisions.find((r) => r.revision === selected.revision - 1)) })
                : localize("routing.initialRoutingConfiguration")}
            </h3>
            <Changes
              before={
                revisions.find((r) => r.revision === selected.revision - 1)
                  ?.snapshot ?? null
              }
              after={selected.snapshot}
              names={selected.context?.guardrails ?? []}
            />
          </section>
          <p className="mt-6 text-xs text-muted-foreground">{localize("routing.thisSnapshotDescribesPossibleRoutingDecisionsAParticularRequest")}</p>
        </EntitySheet>
      )}
    </section>
  );
}
