import { DistributionOverview } from "@/components/traffic-routing/distribution";
import { ReviewPublishSheet } from "@/components/traffic-routing/review-publish-sheet";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearch, useBlocker } from "@tanstack/react-router";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { getEndpoints } from "@/lib/endpoints-api";
import { listControllerGuardrails } from "@/lib/controller-api";
import { queryKeys } from "@/features/query-keys";
import * as api from "@/lib/traffic-routing-api";
import { PageHeader, ErrorNotice } from "@/components/product-shell";
import { EntitySheet } from "@/components/entity-sheet";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

import { RouterEndpoints } from "@/components/traffic-routing/router-endpoints";
import { RouterOverview } from "@/components/traffic-routing/router-overview";
import {
  RouterRouting,
  ruleErrors,
} from "@/components/traffic-routing/router-routing";
import {
  RouterRevisions,
  Changes,
} from "@/components/traffic-routing/router-revisions";
import { revisionLabel } from "@/components/traffic-routing/router-view-model";
import { RouterStatus } from "./routers";
export {
  DeleteRouterSheet,
  RouterRuntimeEventTable,
} from "@/components/traffic-routing/runtime-events";

export function RouterDetailPage() {
  const { routerId } = useParams({ strict: false });
  const query = useQuery({
    queryKey: api.trafficRouterKeys.detail(routerId!),
    queryFn: () => api.getTrafficRouter(routerId!),
    refetchInterval: 10000,
  });
  // A failed background refresh must not unmount the workspace and lose its draft.
  if (!query.data)
    return query.error ? (
      <section className="py-8">
        <ErrorNotice error={query.error} />
        <Button onClick={() => void query.refetch()}>Retry</Button>
      </section>
    ) : (
      <p role="status" className="py-8">
        Loading Router…
      </p>
    );
  return (
    <>
      {query.error && (
        <div className="pt-4">
          <ErrorNotice error={query.error} />
          <Button variant="outline" onClick={() => void query.refetch()}>
            Retry refresh
          </Button>
        </div>
      )}
      <RouterWorkspace key={query.data.id} router={query.data} />
    </>
  );
}
export function RouterWorkspace({ router }: { router: api.TrafficRouter }) {
  const auth = useAuth(),
    canEdit = auth.user?.role === "admin";
  const client = useQueryClient();
  const search = useSearch({ strict: false }) as { routeId?: string; tab?: string };
  const [tab, setTab] = useState(search.routeId ? "routing" : search.tab ?? "overview");
  const [selected, setSelected] = useState<string | null>(
    search.routeId ?? null,
  );
  const [editing, setEditing] = useState(false);
  const [base, setBase] = useState(router);
  const [draft, setDraft] = useState(router.draft);
  const [review, setReview] = useState<
    | (api.RouterPublicationPreview & {
        key: string;
        sourceDraft: api.RouterDraft;
      })
    | null
  >(null);
  const [dialog, setDialog] = useState<"discard" | "cancel" | null>(
    null,
  );
  const [restore, setRestore] = useState<api.RouterRevision | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(base.draft);
  const unpublished =
    dirty ||
    (router.draftRevision !== router.activeDraftRevision &&
      JSON.stringify(router.draft) !== JSON.stringify(router.activeSnapshot));
  const blocker = useBlocker({
    shouldBlockFn: () => dirty,
    withResolver: true,
    enableBeforeUnload: dirty,
  });
  useEffect(() => {
    if (!editing && !dirty && !review) {
      setBase(router);
      setDraft(router.draft);
    }
  }, [router, editing, dirty, review]);
  const endpoints = useQuery({
    queryKey: queryKeys.endpoints,
    queryFn: getEndpoints,
  });
  const guardrails = useQuery({
    queryKey: ["routing-guardrails"],
    queryFn: listControllerGuardrails,
  });
  const revisions = useQuery({
    queryKey: [...api.trafficRouterKeys.detail(router.id), "revisions"],
    queryFn: () => api.getRouterRevisions(router.id),
  });
  const fields = useQuery({
    queryKey: ["selector-fields", router.endpointIds],
    queryFn: () => api.getSelectorFields(router.endpointIds),
    enabled: editing,
  });
  const accept = async (next: api.TrafficRouter) => {
    client.setQueryData(api.trafficRouterKeys.detail(next.id), next);
    await client.invalidateQueries({ queryKey: api.trafficRouterKeys.all });
  };
  const prepare = useMutation({
    mutationFn: async () => {
      const next = dirty
        ? await api.saveTrafficRouter(router.id, base.draftRevision, draft)
        : base;
      // Review is the persistence boundary; the user does not manage a Save API.
      if (dirty) {
        setBase(next);
        setDraft(next.draft);
        await accept(next);
      }
      return {
        ...(await api.previewTrafficRouter(router.id, next.draftRevision)),
        key: crypto.randomUUID(),
        sourceDraft: next.draft,
      };
    },
    onSuccess: (result) => {
      setReview(result);
      release.reset();
    },
  });
  const release = useMutation({
    mutationFn: () =>
      api.publishTrafficRouter(router.id, review!.draftRevision, review!.key, {
        reviewedSnapshot: review!.snapshot,
        reviewedEndpointIds: review!.endpointIds,
      }),
    onSuccess: async (next) => {
      setReview(null);
      setEditing(false);
      setBase(next);
      setDraft(next.draft);
      setTab("overview");
      await accept(next);
      await client.invalidateQueries({
        queryKey: [...api.trafficRouterKeys.detail(router.id), "revisions"],
      });
      toast.success(
        next.rolloutStatus === "active"
          ? "Revision is active."
          : "Revision published. Waiting for Runner deployment.",
      );
    },
  });
  const discard = useMutation({
    mutationFn: () =>
      api.saveTrafficRouter(
        router.id,
        base.draftRevision,
        router.activeSnapshot!,
      ),
    onSuccess: async (next) => {
      setBase(next);
      setDraft(next.draft);
      setEditing(false);
      setReview(null);
      setDialog(null);
      await accept(next);
    },
  });
  const busy = prepare.isPending || release.isPending || discard.isPending;
  const errors = draft.routes.flatMap((r) =>
    ruleErrors(r).map((error) => `${r.name}: ${error}`),
  );
  const names = guardrails.data?.items ?? [];
  const incoming = (endpoints.data?.items ?? []).filter((e) =>
    router.endpointIds.includes(e.id),
  );
  const active = router.activeSnapshot;
  const beginEdit = () => {
    setTab("routing");
    setEditing(true);
    prepare.reset();
  };
  const openRule = (id: string) => {
    setTab("routing");
    setSelected(id);
  };
  const openReview = () => {
    opener.current = document.activeElement as HTMLElement;
    prepare.mutate();
  };
  const serverChanged = router.draftRevision !== base.draftRevision;
  return (
    <section className="space-y-5 py-7">
      <Link
        className="inline-flex min-h-11 items-center text-sm text-primary"
        to="/integration/routers"
      >
        ← Traffic Routers
      </Link>
      <PageHeader
        title={router.name}
        description="Manage traffic routing from incoming Endpoints to GuardRails."
      />
      <div className="space-y-2 text-sm">
        <RouterStatus
          router={router}
          revisionLabel={revisionLabel(
            revisions.data?.items.find(
              (r) => r.revision === router.activeRevision,
            ),
          )}
        />
        <p className="text-muted-foreground">
          {router.endpointIds.length} Endpoints ·{" "}
          {active?.routes.filter((r) => r.kind === "normal").length ?? 0} Routes
          ·{" "}
          {
            new Set(
              active?.routes.flatMap((r) =>
                r.targets.map((t) => t.guardrailId),
              ) ?? [],
            ).size
          }{" "}
          GuardRails
        </p>
      </div>
      {router.rolloutStatus === "failed" && (
        <p role="alert" className="text-sm text-destructive">
          Runner deployment failed. Review the configuration and publish a new
          revision to retry.
        </p>
      )}
      {unpublished && !editing && (
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border bg-muted/30 p-4">
          <div>
            <p className="text-sm font-medium">Draft changes</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Routing configuration has unpublished changes.
            </p>
          </div>
          {canEdit && (
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={busy || !router.activeSnapshot}
                onClick={() => setDialog("discard")}
              >
                Discard
              </Button>
              <Button
                disabled={busy}
                onClick={() => {
                  if (errors.length) {
                    beginEdit();
                    setSelected(
                      draft.routes.find((r) => ruleErrors(r).length)?.id ??
                        null,
                    );
                  } else openReview();
                }}
              >
                {prepare.isPending ? "Preparing…" : "Review & publish"}
              </Button>
            </div>
          )}
        </div>
      )}
      {serverChanged && editing && (
        <div role="alert" className="space-y-2 rounded-lg border p-4 text-sm">
          <p>
            The server draft changed. Your edits are preserved. Cancel editing
            to load the current draft before retrying.
          </p>
          <Button variant="outline" onClick={() => setDialog("cancel")}>
            Compare with current draft
          </Button>
          <details>
            <summary className="cursor-pointer py-2">
              Current server changes
            </summary>
            <Changes before={base.draft} after={router.draft} names={names} />
          </details>
        </div>
      )}
      {prepare.error && (
        <div role="alert">
          <ErrorNotice error={prepare.error} />
          <Button
            variant="outline"
            disabled={busy || serverChanged}
            onClick={openReview}
          >
            Retry review
          </Button>
        </div>
      )}
      <Tabs
        value={tab}
        onValueChange={setTab}
        className="gap-0 overflow-hidden rounded-xl border bg-card"
      >
        <div className="overflow-x-auto border-b px-4">
          <TabsList className="min-w-max border-b-0" aria-label="Router views">
            {["overview", "endpoints", "routing", "monitoring", "revisions"].map((value) => (
              <TabsTrigger value={value} key={value}>
                {value[0]!.toUpperCase() + value.slice(1)}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value="overview" className="min-w-0 p-4 sm:p-6">
          {endpoints.error && <ErrorNotice error={endpoints.error} />}
          {guardrails.error && <ErrorNotice error={guardrails.error} />}
          {revisions.error && <ErrorNotice error={revisions.error} />}
          {endpoints.isPending ||
          guardrails.isPending ||
          revisions.isPending ? (
            <p role="status">Loading traffic flow…</p>
          ) : !endpoints.data || !revisions.data ? (
            <p className="text-sm text-muted-foreground">
              Traffic flow is unavailable until its source and revision data can
              be loaded.
            </p>
          ) : (
            <RouterOverview
              canEdit={canEdit}
              router={router}
              endpoints={incoming}
              guardrails={names}
              revisions={revisions.data?.items ?? []}
              onRule={openRule}
              onEndpoints={() => setTab("endpoints")}
              onRevisions={() => setTab("revisions")}
            />
          )}
          {(endpoints.error || guardrails.error || revisions.error) && (
            <Button
              variant="outline"
              onClick={() => {
                void endpoints.refetch();
                void guardrails.refetch();
                void revisions.refetch();
              }}
            >
              Retry overview
            </Button>
          )}
        </TabsContent>
        <TabsContent value="endpoints" className="min-w-0 p-4 sm:p-6">
          <RouterEndpoints
            router={router}
            canEdit={canEdit && !busy}
            onBound={accept}
          />
        </TabsContent>
        <TabsContent value="routing" className="min-w-0 space-y-5 p-4 sm:p-6">
          {editing && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/30 p-4">
              <div>
                <p className="text-sm font-medium">Editing draft</p>
                <p className="text-sm text-muted-foreground">
                  Changes are not serving traffic until published.
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    dirty ? setDialog("cancel") : setEditing(false)
                  }
                >
                  Cancel
                </Button>
                <Button
                  disabled={
                    busy ||
                    errors.length > 0 ||
                    serverChanged ||
                    fields.isPending ||
                    Boolean(fields.error)
                  }
                  onClick={openReview}
                >
                  {prepare.isPending ? "Preparing…" : "Review changes"}
                </Button>
              </div>
            </div>
          )}
          {fields.error && (
            <>
              <ErrorNotice error={fields.error} />
              <Button variant="outline" onClick={() => void fields.refetch()}>
                Retry selector fields
              </Button>
            </>
          )}
          {guardrails.error && (
            <>
              <ErrorNotice error={guardrails.error} />
              <Button
                variant="outline"
                onClick={() => void guardrails.refetch()}
              >
                Retry GuardRails
              </Button>
            </>
          )}
          {guardrails.isPending ? (
            <p role="status">Loading routing targets…</p>
          ) : (
            <RouterRouting
              routerId={router.id}
              endpointIds={router.endpointIds}
              draft={editing ? draft : (router.activeSnapshot ?? router.draft)}
              editableDraft={draft}
              editing={editing}
              canEdit={canEdit}
              busy={busy}
              selected={selected}
              select={setSelected}
              onChange={setDraft}
              onEdit={beginEdit}
              fields={fields.data?.items}
              guardrails={names}
            />
          )}
        </TabsContent>
        <TabsContent value="monitoring" className="min-w-0 space-y-5 p-4 sm:p-6">
          <div>
            <h2 className="text-lg font-semibold">Monitoring</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Monitor actual traffic distribution and runtime outcomes. Filter by time, revision, or source Endpoint.
            </p>
          </div>
          {endpoints.error ? <>
            <ErrorNotice error={endpoints.error} />
            <Button variant="outline" onClick={() => void endpoints.refetch()}>Retry monitoring</Button>
          </> : endpoints.isPending ? <p role="status">Loading monitoring…</p> :
            <DistributionOverview router={router} endpoints={incoming} />}
        </TabsContent>
        <TabsContent value="revisions" className="min-w-0 p-4 sm:p-6">
          {revisions.error ? (
            <>
              <ErrorNotice error={revisions.error} />
              <Button onClick={() => void revisions.refetch()}>
                Retry revisions
              </Button>
            </>
          ) : revisions.isPending ? (
            <p role="status">Loading revisions…</p>
          ) : (
            <RouterRevisions
              router={router}
              revisions={revisions.data?.items ?? []}
              canEdit={canEdit && !busy}
              onRestore={setRestore}
            />
          )}
        </TabsContent>
      </Tabs>
      {review && (
        <ReviewPublishSheet
          review={review}
          before={router.activeSnapshot}
          names={names}
          endpoints={endpoints.data?.items ?? []}
          pending={release.isPending}
          busy={busy}
          error={release.error}
          opener={opener}
          onClose={() => setReview(null)}
          onPublish={() => release.mutate()}
          onReviewAgain={() => prepare.mutate()}
        />
      )}
      {restore && (
        <EntitySheet
          open
          eyebrow="Router"
          title={`Restore ${revisionLabel(restore)} as draft`}
          description="Copy the historical routing configuration into a new draft. Existing Endpoint bindings stay unchanged. Review before publishing a new revision."
          onOpenChange={(open) => {
            if (!open) setRestore(null);
          }}
          footer={
            <>
              <Button variant="outline" onClick={() => setRestore(null)}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  setBase(router);
                  setDraft(structuredClone(restore.snapshot));
                  setEditing(true);
                  setSelected(null);
                  setTab("routing");
                  setRestore(null);
                  prepare.reset();
                }}
              >
                Create draft
              </Button>
            </>
          }
        >
          <p className="text-sm">
            {dirty
              ? "This replaces your unsaved routing edits."
              : "This replaces the routing configuration in the editor."}{" "}
            Revision {revisionLabel(restore)} remains immutable. Its pinned
            GuardRail versions are preserved.
          </p>
        </EntitySheet>
      )}
      {dialog && (
        <EntitySheet
          open
          eyebrow="Router"
          title={
            dialog === "discard"
              ? "Discard draft changes?"
              : "Cancel editing?"
          }
          description={
            dialog === "discard"
              ? "Restore the currently published routing configuration. Live traffic is unchanged."
              : "Unsaved edits will be discarded. The last saved server draft will remain."
          }
          closeDisabled={busy}
          onOpenChange={(open) => {
            if (!open && !busy) setDialog(null);
          }}
          footer={
            <>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setDialog(null)}
              >
                Keep editing
              </Button>
              <Button
                disabled={busy}
                onClick={() => {
                  if (dialog === "discard") discard.mutate();
                  else {
                    setBase(router);
                    setDraft(router.draft);
                    setEditing(false);
                    setDialog(null);
                  }
                }}
              >
                {dialog === "discard"
                  ? "Discard changes"
                  : "Cancel editing"}
              </Button>
            </>
          }
        >
          {discard.error && <ErrorNotice error={discard.error} />}
        </EntitySheet>
      )}
      {blocker.status === "blocked" && (
        <EntitySheet
          open
          eyebrow="Router"
          title="Unsaved edits"
          description="Leaving discards local routing edits."
          onOpenChange={() => blocker.reset()}
          footer={
            <>
              <Button variant="outline" onClick={() => blocker.reset()}>
                Keep editing
              </Button>
              <Button onClick={() => blocker.proceed()}>
                Discard and leave
              </Button>
            </>
          }
        >
          <p>Review changes to save this draft before leaving.</p>
        </EntitySheet>
      )}
    </section>
  );
}
