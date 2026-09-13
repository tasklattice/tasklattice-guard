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
}: {
  router: TrafficRouter;
  revisions: RouterRevision[];
  canEdit: boolean;
  onRestore: (r: RouterRevision) => void;
}) {
  const [selected, setSelected] = useState<RouterRevision | null>(null);
  const [deleting, setDeleting] = useState<RouterRevision | null>(null);
  const client = useQueryClient();
  const remove = useMutation({ mutationFn: (revision: number) => deleteRouterRevision(router.id, revision), onSuccess: async () => { setDeleting(null); setSelected(null); await client.invalidateQueries({ queryKey: trafficRouterKeys.all }); } });
  const status = (r: RouterRevision) =>
    r.revision === router.activeRevision
      ? router.rolloutStatus === "active"
        ? "Active"
        : router.rolloutStatus === "failed"
          ? "Failed"
          : "Deploying"
      : "Previous";
  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">Deployment history</h2>
      <p className="text-sm text-muted-foreground">
        Published revisions are immutable. Restore creates a draft for a new
        revision.
      </p>
      {!revisions.length ? (
        <p className="rounded-lg border border-dashed p-6 text-sm">
          No published revisions.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              {[
                "Revision",
                "Status",
                "Published",
                "Published by",
                "Changes",
                "Actions",
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
                <TableCell>{r.createdBy ?? "Unknown"}</TableCell>
                <TableCell>
                  {
                    routingDiff(
                      revisions[index + 1]?.snapshot ?? null,
                      r.snapshot,
                    ).length
                  }{" "}
                  changes
                </TableCell>
                <TableCell>
                  {canEdit && <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" className="size-11" aria-label={`Actions for revision ${revisionLabel(r)}`}><MoreHorizontal /></Button></DropdownMenuTrigger><DropdownMenuContent align="end">
                    <DropdownMenuItem variant="edit" disabled={r.revision === router.activeRevision || remove.isPending} onSelect={() => onRestore(r)}><RotateCcw />Rollback</DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" disabled={r.revision === router.activeRevision || remove.isPending} onSelect={() => { remove.reset(); setDeleting(r); }}><Trash2 />Delete</DropdownMenuItem>
                  </DropdownMenuContent></DropdownMenu>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <ConfirmationSheet open={deleting !== null} onOpenChange={open => { if (!open) setDeleting(null); }} eyebrow="Router revision" title={`Delete revision ${deleting ? revisionLabel(deleting) : ""}?`} description="This permanently removes the historical configuration from revision history. It will no longer be available for rollback. Runtime logs and audit evidence are retained." cancelLabel="Cancel" confirmLabel="Delete revision" variant="destructive" pending={remove.isPending} onConfirm={() => { if (deleting) remove.mutate(deleting.revision); }}>
        {remove.error && <p role="alert" className="text-sm text-destructive">{remove.error.message}</p>}
      </ConfirmationSheet>
      {selected && (
        <EntitySheet
          open
          eyebrow="Router revision"
          title={`Revision ${revisionLabel(selected)}`}
          description={`${new Date(selected.createdAt).toLocaleString()} · ${selected.createdBy ?? "Unknown author"}`}
          onOpenChange={(open) => {
            if (!open) setSelected(null);
          }}
          footer={
            <>
              <Button variant="outline" onClick={() => setSelected(null)}>
                Close
              </Button>
              {canEdit && selected.revision !== router.activeRevision && (
                <Button
                  variant="edit"
                  onClick={() => {
                    onRestore(selected);
                    setSelected(null);
                  }}
                >
                  Restore as draft
                </Button>
              )}
            </>
          }
        >
          <section className="space-y-3">
            <StateBadge state={status(selected)} />
            <h3 className="font-medium">Endpoints snapshot</h3>
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
                <p className="text-sm">
                  No Endpoints were attached at publication.
                </p>
              )
            ) : (
              <p className="text-sm text-muted-foreground">
                This older revision did not capture Endpoint context. Historical
                membership is unavailable.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Membership at publication. Later attach/detach actions are
              recorded separately in the audit log.
            </p>
          </section>
          <section className="mt-6 space-y-3">
            <h3 className="font-medium">Routing snapshot</h3>
            {selected.snapshot.routes.map((r, i) => (
              <div key={r.id} className="rounded-lg border p-3 text-sm">
                <p className="font-medium">
                  {r.kind === "fallback" ? "Fallback" : `${i + 1}. ${r.name}`}
                  {!r.enabled ? " · Disabled" : ""}
                </p>
                <p className="mt-1 break-words text-xs text-muted-foreground">
                  {r.kind === "fallback"
                    ? "All unmatched traffic"
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
            <h3 className="font-medium">GuardRail Versions</h3>
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
                ? `Changes from ${revisionLabel(revisions.find((r) => r.revision === selected.revision - 1))}`
                : "Initial routing configuration"}
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
          <p className="mt-6 text-xs text-muted-foreground">
            This snapshot describes possible routing decisions. A particular
            request’s selected rule and GuardRail version are recorded in
            Runtime logs.
          </p>
        </EntitySheet>
      )}
    </section>
  );
}
