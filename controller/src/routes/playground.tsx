import { hasPermission, isPlatformAdministrator } from "../../shared/rbac";
import { AdvancedPlayground } from "@/components/playground/advanced-playground";
import { Link } from "@tanstack/react-router";
import { projectParams } from "@/lib/project-paths";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Activity, MessageSquareText } from "lucide-react";
import { toast } from "@/components/ui/notifications";

import { ProbeInspectionDrawer } from "@/components/playground/probe-inspection-drawer";
import { ProbeConversationPanel } from "@/components/playground/probe-conversation-panel";
import { usePlaygroundSession } from "@/components/playground/use-playground-session";
import type { PlaygroundTurn } from "@/components/playground/types";
import {
  EmptyState,
  ErrorNotice,
  InfoNotice,
  PageHeader,
} from "@/components/product-shell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { queryKeys } from "@/features/query-keys";
import { useAuth } from "@/lib/auth";
import {
  createPlaygroundInteraction,
  getGuardrails,
  getGuardrailVersions,
  getPlaygroundModels,
  preparePlaygroundDraftPreview,
  type Guardrail,
  type GuardrailVersion,
  type PlaygroundDraftPreview,
  type PlaygroundInteraction,
  type PlaygroundModel,
  type PlaygroundTarget,
} from "@/lib/api";

type PlaygroundTargetSelection =
  { kind: "draft" } | { kind: "published"; version: string };

export function PlaygroundPage() {
  const { t } = useTranslation();
  const auth = useAuth();
  const [advanced, setAdvanced] = useState(
    () =>
      new URLSearchParams(window.location.search).get("mode") === "advanced",
  );
  const [advancedOpened, setAdvancedOpened] = useState(advanced);
  const [conversationActions, setConversationActions] = useState<HTMLDivElement | null>(null);
  const changeMode = (mode: string) => {
    if (mode === "advanced") setAdvancedOpened(true);
    setAdvanced(mode === "advanced");
    const url = new URL(window.location.href);
    url.searchParams.set("mode", mode);
    window.history.replaceState(window.history.state, "", url);
  };
  const canTestDraft = hasPermission(auth.user?.role, "playground", "write");
  const guardrailsQuery = useQuery({
    queryKey: queryKeys.guardrails,
    queryFn: getGuardrails,
  });
  const modelsQuery = useQuery({
    queryKey: queryKeys.playgroundModels,
    queryFn: getPlaygroundModels,
  });
  const guardrails = guardrailsQuery.data?.items ?? [];
  const publishedGuardrails = useMemo(
    () => guardrails.filter(hasPublishedVersion),
    [guardrails],
  );
  const selectableGuardrails = canTestDraft ? guardrails : publishedGuardrails;
  const models = modelsQuery.data?.items ?? [];
  const { guardrailId, target, selectGuardrail, selectTarget } =
    usePlaygroundSelection(selectableGuardrails, canTestDraft, !advanced);
  const selected = selectableGuardrails.find((item) => item.id === guardrailId);
  const versionsQuery = useQuery({
    queryKey: queryKeys.guardrailVersions(guardrailId),
    queryFn: () => getGuardrailVersions(guardrailId),
    enabled: Boolean(guardrailId),
  });
  const versions = versionsQuery.data?.items ?? [];
  const selectedVersion =
    target.kind === "published"
      ? versions.find((item) => item.version === target.version)
      : undefined;

  useEffect(() => {
    if (advanced || !versionsQuery.isSuccess) return;
    if (target.kind === "draft" && canTestDraft) return;
    const requested = target.kind === "published" ? target.version : "";
    const resolved = resolvePublishedVersion(versions, requested);
    if (
      resolved &&
      (target.kind !== "published" || resolved !== target.version)
    ) {
      selectTarget({ kind: "published", version: resolved });
    } else if (!resolved && canTestDraft && target.kind !== "draft") {
      selectTarget({ kind: "draft" });
    }
  }, [advanced, canTestDraft, selectTarget, target, versions, versionsQuery.isSuccess]);

  const loading = guardrailsQuery.isLoading || modelsQuery.isLoading;
  // Path testing uses Runner and Endpoint authentication, not the chat model.
  const advancedActive = advanced;
  return (
    <Tabs
      value={advancedActive ? "advanced" : "simple"}
      onValueChange={changeMode}
      className="gap-0 py-4"
    >
      <PageHeader
        title={t("pages.playground.title")}
        description={advancedActive
          ? t("playground.advancedDescription")
          : t("pages.playground.description")}
      />
      <div className="mt-3 min-w-0 overflow-hidden rounded-2xl border bg-card shadow-xs">
        <header className="flex min-w-0 items-center gap-3 border-b bg-muted/20 px-5 py-2">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl border bg-card text-primary">
            {advancedActive ? <Activity className="size-4.5" /> : <MessageSquareText className="size-4.5" />}
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">{t(advancedActive ? "routing.advancedRequestWorkbench" : "playground.conversationTitle")}</h2>
            {!advancedActive && <p className="mt-0.5 truncate text-xs text-muted-foreground">{t("playground.conversationDescription")}</p>}
          </div>
          <div ref={setConversationActions} className={advancedActive ? "hidden" : "shrink-0"} />
          <div className="min-w-0 shrink-0">
            <TabsList aria-label={t("playground.modeLabel")}>
              <TabsTrigger value="simple">
                {t("playground.simpleMode")}
              </TabsTrigger>
              <TabsTrigger value="advanced">
                {t("playground.advancedMode")}
              </TabsTrigger>
            </TabsList>
          </div>
        </header>
        <TabsContent
          value="simple"
          forceMount
          className="p-0! data-[state=inactive]:hidden"
        >
          {guardrailsQuery.error ? (
            <div className="mt-5">
              <ErrorNotice error={guardrailsQuery.error} />
            </div>
          ) : null}
          {modelsQuery.error ? (
            <div className="mt-5">
              <ErrorNotice error={modelsQuery.error} />
            </div>
          ) : null}
          {versionsQuery.error ? (
            <div className="mt-5">
              <ErrorNotice error={versionsQuery.error} />
            </div>
          ) : null}
          {loading ? (
            <Skeleton className="h-[calc(100dvh-16rem)] min-h-[30rem]" />
          ) : null}
          {!loading && !guardrails.length ? (
            <div className="mt-5">
              <EmptyState
                title={t("validation.noGuardrails")}
                description={t("validation.noGuardrailsDescription")}
              />
            </div>
          ) : null}
          {!loading && guardrails.length > 0 && !selectableGuardrails.length ? (
            <div className="mt-5">
              <EmptyState
                title={t("playground.noPublishedGuardrails")}
                description={t("playground.noPublishedGuardrailsDescription")}
              />
            </div>
          ) : null}
          {!loading && modelsQuery.isSuccess && selectableGuardrails.length > 0 && !models.length ? (
            <div className="mt-5">
              <InfoNotice title={t("playground.controllerUnavailableTitle")}>
                <p>{t("resourceList.testUnavailable")}</p>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <Button variant="outline" disabled={modelsQuery.isFetching} onClick={() => void modelsQuery.refetch()}>{t("resourceList.retryTesting")}</Button>
                  {isPlatformAdministrator(auth.user?.role) ? <Button asChild variant="outline"><a href="/settings/models">{t("resourceList.configureChatModel")}</a></Button> : null}
                  <PlaygroundReturnLink />
                </div>
              </InfoNotice>
            </div>
          ) : null}
          {!loading && selected && models.length ? (
            <PlaygroundWorkspace
              key={`${selected.id}:${target.kind}:${target.kind === "published" ? target.version : (selected.draft_revision ?? 1)}`}
              guardrail={selected}
              guardrails={selectableGuardrails}
              versions={versions}
              target={target}
              selectedVersion={selectedVersion}
              versionsLoading={versionsQuery.isLoading}
              canTestDraft={canTestDraft}
              models={models}
              actionsContainer={conversationActions}
              onGuardrailChange={selectGuardrail}
              onTargetChange={selectTarget}
            />
          ) : null}
        </TabsContent>
        <TabsContent
          value="advanced"
          forceMount
          className="p-0! data-[state=inactive]:hidden"
        >
          {advancedOpened && (
            <AdvancedPlayground active={advancedActive} guardrails={guardrails} />
          )}
        </TabsContent>
      </div>
    </Tabs>
  );
}

function PlaygroundWorkspace({
  guardrail,
  guardrails,
  versions,
  target,
  selectedVersion,
  versionsLoading,
  canTestDraft,
  models,
  actionsContainer,
  onGuardrailChange,
  onTargetChange,
}: {
  guardrail: Guardrail;
  guardrails: Guardrail[];
  versions: GuardrailVersion[];
  target: PlaygroundTargetSelection;
  selectedVersion?: GuardrailVersion;
  versionsLoading: boolean;
  canTestDraft: boolean;
  models: PlaygroundModel[];
  actionsContainer: HTMLDivElement | null;
  onGuardrailChange: (value: string) => void;
  onTargetChange: (value: PlaygroundTargetSelection) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [modelId, setModelId] = useState("");
  const draftRevision = guardrail.draft_revision ?? 1;
  const draftPreview = useQuery({
    queryKey: queryKeys.playgroundDraftPreview(guardrail.id, draftRevision),
    queryFn: () => preparePlaygroundDraftPreview(guardrail.id),
    enabled: target.kind === "draft" && canTestDraft,
    staleTime: 14 * 60 * 1_000,
    gcTime: 15 * 60 * 1_000,
    retry: false,
  });
  const [draftPreviewExpired, setDraftPreviewExpired] = useState(false);
  useEffect(() => {
    if (!draftPreview.data) {
      setDraftPreviewExpired(false);
      return;
    }
    setDraftPreviewExpired(false);
    const remaining =
      new Date(draftPreview.data.expires_at).getTime() - Date.now();
    if (remaining <= 0) {
      setDraftPreviewExpired(true);
      return;
    }
    const timeout = window.setTimeout(
      () => setDraftPreviewExpired(true),
      remaining,
    );
    return () => window.clearTimeout(timeout);
  }, [draftPreview.data]);
  const preparedDraft = draftPreviewExpired ? undefined : draftPreview.data;
  const targetKey =
    target.kind === "draft"
      ? `draft:${draftRevision}`
      : `version:${target.version}`;
  const { turns, appendTurn, clearTurns } = usePlaygroundSession(
    guardrail.id,
    targetKey,
  );
  const [details, setDetails] = useState<PlaygroundInteraction | null>(null);

  useEffect(() => {
    if (models.length && !models.some((model) => model.id === modelId))
      setModelId(models[0].id);
  }, [modelId, models]);

  const interaction = useMutation({
    mutationFn: (input: {
      target: PlaygroundTarget;
      model_id: string;
      message: string;
      history: { role: "user" | "assistant"; content: string }[];
    }) => createPlaygroundInteraction(guardrail.id, input),
    onSuccess: (result) => {
      appendTurn(result);
      if (target.kind === "published") {
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.metrics }),
          queryClient.invalidateQueries({ queryKey: queryKeys.runtimeEvents }),
        ]);
      }
    },
    onError: (error) =>
      toast.error(
        error instanceof Error
          ? error.message
          : t("guardrails.operationFailed"),
      ),
  });
  const submit = async (message: string) => {
    const trimmed = message.trim();
    const interactionTarget = playgroundInteractionTarget(
      target,
      selectedVersion,
      preparedDraft,
    );
    if (!trimmed || interaction.isPending || !modelId || !interactionTarget)
      return;
    await interaction.mutateAsync({
      target: interactionTarget,
      model_id: modelId,
      message: trimmed,
      history: conversationHistory(turns),
    });
  };
  const clear = () => {
    clearTurns();
    setDetails(null);
    interaction.reset();
  };
  return (
    <>
      <div className="min-w-0">
        <ProbeConversationPanel
          actionsContainer={actionsContainer}
          guardrail={guardrail}
          guardrails={guardrails}
          versions={versions}
          target={target}
          selectedVersion={selectedVersion}
          versionsLoading={versionsLoading}
          canTestDraft={canTestDraft}
          draftPreview={preparedDraft}
          draftPreparing={draftPreview.isLoading || draftPreview.isFetching}
          draftError={
            draftPreviewExpired
              ? new Error(t("playground.draftPreviewExpired"))
              : draftPreview.error
          }
          turns={turns}
          models={models}
          modelId={modelId}
          pending={interaction.isPending}
          onGuardrailChange={onGuardrailChange}
          onTargetChange={onTargetChange}
          onRetryDraft={() => void draftPreview.refetch()}
          onModelChange={setModelId}
          onSubmitMessage={submit}
          onClear={clear}
          onViewDetails={setDetails}
        />
      </div>
      <ProbeInspectionDrawer
        result={details}
        open={Boolean(details)}
        onOpenChange={(open) => {
          if (!open) setDetails(null);
        }}
      />
    </>
  );
}

function conversationHistory(
  turns: PlaygroundTurn[],
): { role: "user" | "assistant"; content: string }[] {
  return turns.flatMap((turn) => {
    if (
      turn.state !== "completed" ||
      !turn.effective_user_message ||
      !turn.assistant_message
    )
      return [];
    return [
      { role: "user" as const, content: turn.effective_user_message },
      { role: "assistant" as const, content: turn.assistant_message },
    ];
  });
}

function hasPublishedVersion(guardrail: Guardrail) {
  return guardrail.published_version_count === undefined
    ? guardrail.published_current
    : guardrail.published_version_count > 0;
}

function playgroundInteractionTarget(
  target: PlaygroundTargetSelection,
  version: GuardrailVersion | undefined,
  preview: PlaygroundDraftPreview | undefined,
): PlaygroundTarget | null {
  if (target.kind === "draft") {
    return preview
      ? {
          kind: "draft",
          draft_revision: preview.draft_revision,
          preview_id: preview.preview_id,
        }
      : null;
  }
  return version ? { kind: "published", version: version.version } : null;
}

export function resolvePublishedVersion(
  versions: GuardrailVersion[],
  requested: string,
) {
  if (versions.some((item) => item.version === requested)) return requested;
  return versions.reduce(
    (latest, item) => (item.version > latest ? item.version : latest),
    "",
  );
}

function usePlaygroundSelection(
  guardrails: Guardrail[],
  canTestDraft: boolean,
  enabled = true,
) {
  const initial = initialPlaygroundSelection();
  const [selection, setSelection] = useState(initial);
  useEffect(() => {
    if (
      !enabled || !guardrails.length ||
      guardrails.some((item) => item.id === selection.guardrailId)
    )
      return;
    const next = {
      guardrailId: guardrails[0].id,
      target:
        selection.target.kind === "draft" && canTestDraft
          ? selection.target
          : initialTargetFor(guardrails[0], canTestDraft),
    };
    setSelection(next);
    syncPlaygroundSearch(next);
  }, [enabled, canTestDraft, guardrails, selection.guardrailId]);
  const selectGuardrail = useCallback(
    (guardrailId: string) => {
      const guardrail = guardrails.find((item) => item.id === guardrailId);
      const next = {
        guardrailId,
        target: guardrail
          ? initialTargetFor(guardrail, canTestDraft)
          : ({ kind: "published", version: "" } as PlaygroundTargetSelection),
      };
      setSelection(next);
      syncPlaygroundSearch(next);
    },
    [canTestDraft, guardrails],
  );
  const selectTarget = useCallback(
    (target: PlaygroundTargetSelection) => {
      const next = { guardrailId: selection.guardrailId, target };
      setSelection(next);
      syncPlaygroundSearch(next);
    },
    [selection.guardrailId],
  );
  return { ...selection, selectGuardrail, selectTarget };
}

function initialPlaygroundSelection(): {
  guardrailId: string;
  target: PlaygroundTargetSelection;
} {
  if (typeof window === "undefined")
    return { guardrailId: "", target: { kind: "published", version: "" } };
  const search = new URLSearchParams(window.location.search);
  const version = search.get("version") ?? "";
  return {
    guardrailId: search.get("guardrail") ?? "",
    target:
      search.get("target") === "draft"
        ? { kind: "draft" }
        : { kind: "published", version },
  };
}

function syncPlaygroundSearch(selection: {
  guardrailId: string;
  target: PlaygroundTargetSelection;
}) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (selection.guardrailId)
    url.searchParams.set("guardrail", selection.guardrailId);
  else url.searchParams.delete("guardrail");
  if (selection.target.kind === "draft") {
    url.searchParams.set("target", "draft");
    url.searchParams.delete("version");
  } else {
    url.searchParams.delete("target");
    if (selection.target.version)
      url.searchParams.set("version", selection.target.version);
    else url.searchParams.delete("version");
  }
  window.history.replaceState(window.history.state, "", url);
}

function initialTargetFor(
  guardrail: Guardrail,
  canTestDraft: boolean,
): PlaygroundTargetSelection {
  return canTestDraft && !hasPublishedVersion(guardrail)
    ? { kind: "draft" }
    : { kind: "published", version: "" };
}

function PlaygroundReturnLink() {
  const { t } = useTranslation();
  const search = new URLSearchParams(window.location.search);
  const endpoint = search.get("endpoint");
  const router = search.get("router");
  const guardrail = search.get("guardrail");
  const link = endpoint ? <Link to="/$projectId/integration/endpoints" params={projectParams()} search={{ endpointId: endpoint }}>{t("common.back")}</Link>
    : router ? <Link to="/$projectId/integration/routers/$routerId" params={{ ...projectParams(), routerId: router }}>{t("common.back")}</Link>
      : guardrail ? <Link to="/$projectId/guardrails/$guardrailId" params={{ ...projectParams(), guardrailId: guardrail }} search={{ tab: "testing" }}>{t("common.back")}</Link>
        : <Link to="/$projectId/guardrails" params={projectParams()}>{t("common.back")}</Link>;
  return <Button asChild variant="outline">{link}</Button>;
}
