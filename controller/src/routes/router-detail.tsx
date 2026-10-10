import { useTranslation } from "react-i18next";
import { discardRouterDraft } from "@/components/traffic-routing/discard-router-draft";
import { DistributionOverview } from "@/components/traffic-routing/distribution";
import { ReviewSubmitSheet, type ChangeSubmission } from "@/components/traffic-routing/review-submit-sheet";
import { ChangeRequestHistory, ChangeRequestDetails, PendingChangeNotice, RestoreRevisionSheet } from "@/components/traffic-routing/change-requests";
import { useEffect, useRef, useState } from "react";
import { Activity, Cable, ClipboardCheck, GitBranch, History, LayoutDashboard, AlertTriangle, FlaskConical, Pencil } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearch, useNavigate, useBlocker } from "@tanstack/react-router";
import { toast } from "@/components/ui/notifications";
import { useAuth } from "@/lib/auth";
import { getEndpoints } from "@/lib/endpoints-api";
import { listControllerGuardrails } from "@/lib/controller-api";
import { queryKeys } from "@/features/query-keys";
import * as api from "@/lib/traffic-routing-api";
import { PageHeader, ErrorNotice } from "@/components/product-shell";
import { RouterRolloutBadge } from "@/components/traffic-routing/router-rollout-badge";
import { EntitySheet } from "@/components/entity-sheet";
import { Badge } from "@/components/ui/badge";
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
import "@/components/traffic-routing/router-workspace.scss";
export {
  DeleteRouterSheet,
  RouterRuntimeEventTable,
} from "@/components/traffic-routing/runtime-events";

export function RouterDetailPage() {
  const { t: localize } = useTranslation();
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
        <Button onClick={() => void query.refetch()}>{localize("routing.retry")}</Button>
      </section>
    ) : (
      <p role="status" className="py-8">{localize("routing.loadingRouter")}</p>
    );
  return (
    <>
      {query.error && (
        <div className="pt-4">
          <ErrorNotice error={query.error} />
          <Button variant="outline" onClick={() => void query.refetch()}>{localize("routing.retryRefresh")}</Button>
        </div>
      )}
      <RouterWorkspace key={query.data.id} router={query.data} />
    </>
  );
}
export function RouterWorkspace({ router }: { router: api.TrafficRouter }) {
  const { t: localize } = useTranslation();
  const auth = useAuth(),
    canEdit = auth.user?.role === "admin";
  const awaiting = router.pendingChangeRequest;
  const client = useQueryClient();
  const search = useSearch({ strict: false }) as { routeId?: string; tab?: string };
  const navigate = useNavigate();
  const tab = search.tab ?? (search.routeId ? "routing" : "overview");
  const setTab = (nextTab: string, routeId = search.routeId) => void navigate({
    to: "/integration/routers/$routerId",
    params: { routerId: router.id },
    search: previous => ({ ...previous, tab: nextTab, routeId }),
    resetScroll: false,
  });
  // Canonicalize direct links without adding a browser-history entry.
  useEffect(() => {
    if (!search.tab) void navigate({
      to: "/integration/routers/$routerId",
      params: { routerId: router.id },
      search: previous => ({ ...previous, tab }),
      replace: true,
      resetScroll: false,
    });
  }, [navigate, router.id, search.tab, tab]);
  const [selected, setSelected] = useState<string | null>(
    search.routeId ?? null,
  );
  useEffect(() => setSelected(search.routeId ?? null), [search.routeId]);
  const [editing, setEditing] = useState(false);
  const [base, setBase] = useState(router);
  const [draft, setDraft] = useState(router.draft);
  // Keep the pre-edit draft across Review's save boundary. An unpublished
  // Router has no active snapshot, but its existing configuration is still
  // the baseline for discarding edits made in this workspace.
  const [initialDraft] = useState(router.draft);
  const discardTarget = router.activeSnapshot ?? initialDraft;
  const hasDraftChanges = JSON.stringify(draft) !== JSON.stringify(discardTarget);
  const [review, setReview] = useState<api.RouterPublicationPreview | null>(null);
  const [dialog, setDialog] = useState<"discard" | "cancel" | null>(
    null,
  );
  const [restore, setRestore] = useState<api.RouterRevision | null>(null);
  const [selectedChangeId, setSelectedChangeId] = useState<string | null>(null);
  const [selectedRevision, setSelectedRevision] = useState<number | null>(null);
  const openChange = (id: string) => { setSelectedRevision(null); setSelectedChangeId(id); setTab("change-requests"); };
  const openRevision = (revision: number) => { setSelectedChangeId(null); setSelectedRevision(revision); setTab("revisions"); };
  const opener = useRef<HTMLElement | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(base.draft);
  const unpublished =
    dirty ||
    (router.draftRevision !== router.activeDraftRevision &&
      JSON.stringify(router.draft) !== JSON.stringify(router.activeSnapshot));
  const blocker = useBlocker({
    // Tab navigation keeps this workspace mounted and does not discard drafts.
    shouldBlockFn: ({ current, next }) => dirty && current.pathname !== next.pathname,
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
      return api.previewTrafficRouter(router.id, next.draftRevision);
    },
    onSuccess: (result) => {
      setReview(result);
      release.reset();
    },
  });
  const release = useMutation({
    // Submission freezes the reviewed snapshot; another administrator applies it.
    mutationFn: (submission: ChangeSubmission) =>
      api.submitRouterChange(router.id, {
        expectedDraftRevision: review!.draftRevision,
        reviewedSnapshot: review!.snapshot,
        reviewedEndpointIds: review!.endpointIds,
        ...submission,
      }),
    onSuccess: async (change) => {
      setReview(null);
      setEditing(false);
      openChange(change.id);
      await client.invalidateQueries({ queryKey: api.trafficRouterKeys.all });
      toast.success(localize("routing.changeSubmitted"));
    },
  });
  const discard = useMutation({
    mutationFn: () => discardRouterDraft(base, discardTarget),
    onSuccess: async (next) => {
      setBase(next);
      setDraft(next.draft);
      setEditing(false);
      setReview(null);
      setDialog(null);
      prepare.reset();
      release.reset();
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
    setTab("routing", id);
    setSelected(id);
  };
  const openReview = () => {
    opener.current = document.activeElement as HTMLElement;
    prepare.mutate();
  };
  const serverChanged = router.draftRevision !== base.draftRevision;
  const draftIsAwaiting = Boolean(awaiting) && !dirty && awaiting!.sourceDraftRevision === router.draftRevision;
  return (
    <section className="router-workspace space-y-5 py-8">
      <Link
        className="inline-flex min-h-11 items-center text-sm text-primary"
        to="/integration/routers"
      >{localize("routing.trafficRouters2")}</Link>
      <PageHeader
        className="router-workspace-header"
        title={router.name}
        description={localize("routing.manageTrafficRoutingFromIncomingEndpointsToGuardRails")}
        action={<div className="flex shrink-0 items-center gap-2">
          <Button asChild variant="testing" className="router-workspace-action"><Link to="/playground" search={{ mode: "advanced", router: router.id }}><FlaskConical aria-hidden="true" />{localize("routing.testRouter")}</Link></Button>

        </div>}
      />
      <div className="router-workspace-status">
        <RouterRolloutBadge router={router} revision={revisions.data?.items.find(revision => revision.revision === router.activeRevision)} />
        <p className="text-muted-foreground">
          {localize("routing.summary", {
            endpoints: router.endpointIds.length,
            routes: active?.routes.filter(r => r.kind === "normal").length ?? 0,
            guardrails: new Set(active?.routes.flatMap(r => r.targets.map(t => t.guardrailId)) ?? []).size,
          })}
        </p>
      </div>
      {router.rolloutStatus === "failed" && (
        <p role="alert" className="router-deployment-error">
          <AlertTriangle aria-hidden="true" />{localize("routing.runnerDeploymentFailedReviewTheConfigurationAndPublishA")}</p>
      )}
      {awaiting && <PendingChangeNotice change={awaiting} onOpen={() => openChange(awaiting.id)} />}
      {unpublished && !draftIsAwaiting && (!editing || tab !== "routing") && (
        <div className="router-draft-notice" role="status">
          <Pencil aria-hidden="true" className="router-draft-icon" />
          <div className="router-draft-copy">
            <p className="text-sm font-medium">{hasDraftChanges ? localize("routing.draftChanges") : localize("routing.unpublishedConfiguration")}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {hasDraftChanges
                ? localize("routing.routingConfigurationHasUnpublishedChanges")
                : localize("routing.thisRouterHasNotBeenPublishedReviewItsConfiguration")}
            </p>
          </div>
          {canEdit && (
            <div className="flex gap-2">
              {hasDraftChanges && <Button
                variant="outline"
                disabled={busy}
                onClick={() => { discard.reset(); setDialog("discard"); }}
              >{localize("routing.discard")}</Button>}
              <Button
                disabled={busy || Boolean(awaiting)}
                title={awaiting ? localize("routing.waitForPendingChange") : undefined}
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
                {prepare.isPending ? localize("routing.preparing") : localize("routing.reviewSubmit")}
              </Button>
            </div>
          )}
        </div>
      )}
      {serverChanged && editing && (
        <div role="alert" className="space-y-2 rounded-lg border p-4 text-sm">
          <p>{localize("routing.theServerDraftChangedYourEditsArePreservedCancel")}</p>
          <Button variant="outline" onClick={() => setDialog("cancel")}>{localize("routing.compareWithCurrentDraft")}</Button>
          <details>
            <summary className="cursor-pointer py-2">{localize("routing.currentServerChanges")}</summary>
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
          >{localize("routing.retryReview")}</Button>
        </div>
      )}
      <Tabs
        value={tab}
        onValueChange={setTab}
        className="mt-7"
      >
        <div className="overflow-x-auto">
          <TabsList className="min-w-max" aria-label={localize("routing.routerViews")}>
            {([
              ["overview", LayoutDashboard],
              ["endpoints", Cable],
              ["routing", GitBranch],
              ["monitoring", Activity],
              ["revisions", History],
              ["change-requests", ClipboardCheck],
            ] as const).map(([value, Icon]) => (
              <TabsTrigger value={value} key={value}>
                <Icon aria-hidden="true" />
                {localize(`routing.tabs.${value}`)}
                {value === "change-requests" && awaiting ? <Badge variant="secondary">1</Badge> : null}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value="overview" className="min-w-0 pt-5">
          {endpoints.error && <ErrorNotice error={endpoints.error} />}
          {guardrails.error && <ErrorNotice error={guardrails.error} />}
          {revisions.error && <ErrorNotice error={revisions.error} />}
          {endpoints.isPending ||
          guardrails.isPending ||
          revisions.isPending ? (
            <p role="status">{localize("routing.loadingTrafficFlow")}</p>
          ) : !endpoints.data || !revisions.data ? (
            <p className="text-sm text-muted-foreground">{localize("routing.trafficFlowIsUnavailableUntilItsSourceAndRevision")}</p>
          ) : (
            <RouterOverview
              canEdit={canEdit}
              router={router}
              endpoints={incoming}
              guardrails={names}
              revisions={revisions.data?.items ?? []}
              onRule={openRule}
              onEndpoints={() => setTab("endpoints")}
              onRouting={() => setTab("routing")}
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
            >{localize("routing.retryOverview")}</Button>
          )}
        </TabsContent>
        <TabsContent value="endpoints" className="min-w-0 pt-5">
          <RouterEndpoints
            router={router}
            canEdit={canEdit && !busy}
            onBound={accept}
          />
        </TabsContent>
        <TabsContent value="routing" className="min-w-0 space-y-5 pt-5">
          {editing && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/30 p-4">
              <div>
                <p className="text-sm font-medium">{localize("routing.editingDraft")}</p>
                <p className="text-sm text-muted-foreground">{awaiting ? localize("routing.waitForPendingChange") : localize("routing.changesAreNotServingTrafficUntilPublished")}</p>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    dirty ? setDialog("cancel") : setEditing(false)
                  }
                >{localize("routing.cancel")}</Button>
                <Button
                  disabled={
                    busy ||
                    Boolean(awaiting) ||
                    errors.length > 0 ||
                    serverChanged ||
                    fields.isPending ||
                    Boolean(fields.error)
                  }
                  onClick={openReview}
                >
                  {prepare.isPending ? localize("routing.preparing") : localize("routing.reviewChanges")}
                </Button>
              </div>
            </div>
          )}
          {fields.error && (
            <>
              <ErrorNotice error={fields.error} />
              <Button variant="outline" onClick={() => void fields.refetch()}>{localize("routing.retrySelectorFields")}</Button>
            </>
          )}
          {guardrails.error && (
            <>
              <ErrorNotice error={guardrails.error} />
              <Button
                variant="outline"
                onClick={() => void guardrails.refetch()}
              >{localize("routing.retryGuardRails")}</Button>
            </>
          )}
          {guardrails.isPending ? (
            <p role="status">{localize("routing.loadingRoutingTargets")}</p>
          ) : (
            <RouterRouting
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
        <TabsContent value="monitoring" className="min-w-0 space-y-5 pt-5">
          <div>
            <h2 className="text-lg font-semibold">{localize("routing.monitoring")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{localize("routing.monitorActualTrafficDistributionAndRuntimeOutcomesFilterBy")}</p>
          </div>
          {endpoints.error ? <>
            <ErrorNotice error={endpoints.error} />
            <Button variant="outline" onClick={() => void endpoints.refetch()}>{localize("routing.retryMonitoring")}</Button>
          </> : endpoints.isPending ? <p role="status">{localize("routing.loadingMonitoring")}</p> :
            <DistributionOverview router={router} endpoints={incoming} />}
        </TabsContent>
        <TabsContent value="revisions" className="min-w-0 pt-5">
          {revisions.error ? (
            <>
              <ErrorNotice error={revisions.error} />
              <Button onClick={() => void revisions.refetch()}>{localize("routing.retryRevisions")}</Button>
            </>
          ) : revisions.isPending ? (
            <p role="status">{localize("routing.loadingRevisions")}</p>
          ) : (
              <RouterRevisions
                router={router}
                revisions={revisions.data?.items ?? []}
                canEdit={canEdit && !busy}
                onRestore={setRestore}
                selectedRevision={selectedRevision}
                onSelectRevision={setSelectedRevision}
                onOpenChange={openChange}
              />
          )}
        </TabsContent>
        <TabsContent value="change-requests" className="min-w-0 pt-5">
          <ChangeRequestHistory routerId={router.id} revisions={revisions.data?.items ?? []} onOpenChange={openChange} onOpenRevision={openRevision} />
        </TabsContent>
      </Tabs>
      {selectedChangeId && (
        <ChangeRequestDetails
          key={selectedChangeId}
          changeId={selectedChangeId}
          router={router}
          revisions={revisions.data?.items ?? []}
          names={names}
          endpoints={endpoints.data?.items ?? []}
          currentUserId={auth.user?.id}
          canDecide={canEdit}
          onClose={() => setSelectedChangeId(null)}
          onOpenRevision={openRevision}
        />
      )}
      {review && (
        <ReviewSubmitSheet
          review={review}
          before={router.activeSnapshot}
          names={names}
          endpoints={endpoints.data?.items ?? []}
          pending={release.isPending}
          busy={busy}
          error={release.error}
          opener={opener}
          onClose={() => setReview(null)}
          onSubmit={(submission) => release.mutate(submission)}
          onReviewAgain={() => prepare.mutate()}
        />
      )}
      {restore && (
        <RestoreRevisionSheet
          router={router}
          target={restore}
          revisions={revisions.data?.items ?? []}
          names={names}
          endpoints={endpoints.data?.items ?? []}
          hasLocalEdits={dirty}
          onClose={() => setRestore(null)}
          onSubmitted={change => {
            setRestore(null);
            setEditing(false);
            setDraft(change.snapshot);
            setBase({ ...router, draft: change.snapshot, draftRevision: change.sourceDraftRevision! });
            openChange(change.id);
          }}
        />
      )}
      {dialog && (
        <EntitySheet
          open
          eyebrow={localize("routing.router")}
          title={
            dialog === "discard"
              ? localize("routing.discardDraftChanges")
              : localize("routing.cancelEditing")
          }
          description={
            dialog === "discard"
              ? router.activeSnapshot
                ? localize("routing.discardRoutingChangesAndRestoreTheCurrentlyPublishedConfiguration")
                : localize("routing.discardRoutingChangesMadeInThisWorkspaceAndRestore")
              : localize("routing.unsavedEditsWillBeDiscardedTheLastSavedServer")
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
              >{localize("routing.keepEditing")}</Button>
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
                  ? localize("routing.discardChanges")
                  : localize("routing.cancelEditing2")}
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
          eyebrow={localize("routing.router")}
          title={localize("routing.unsavedEdits")}
          description={localize("routing.leavingDiscardsLocalRoutingEdits")}
          onOpenChange={() => blocker.reset()}
          footer={
            <>
              <Button variant="outline" onClick={() => blocker.reset()}>{localize("routing.keepEditing")}</Button>
              <Button onClick={() => blocker.proceed()}>{localize("routing.discardAndLeave")}</Button>
            </>
          }
        >
          <p>{localize("routing.reviewChangesToSaveThisDraftBeforeLeaving")}</p>
        </EntitySheet>
      )}
    </section>
  );
}
