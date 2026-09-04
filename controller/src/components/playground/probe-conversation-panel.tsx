import { useCallback, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  ErrorPrimitive,
  MessageNotSentError,
  MessagePrimitive,
  ThreadPrimitive,
  generateId,
  getExternalStoreMessages,
  useAuiState,
  useExternalStoreRuntime,
  type AppendMessage,
  type TextMessagePartProps,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { AlertTriangle, Eraser, ExternalLink, FlaskConical, LoaderCircle, MessageSquareText, RotateCcw, Send, ShieldCheck, Tags } from "lucide-react";
import { useTranslation } from "react-i18next";

import { GuardrailResultCard } from "@/components/playground/guardrail-result-card";
import { ModelMark } from "@/components/playground/model-mark";
import type { PlaygroundTurn } from "@/components/playground/types";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Guardrail, GuardrailVersion, PlaygroundDraftPreview, PlaygroundInteraction, PlaygroundModel } from "@/lib/api";

type PlaygroundTargetChoice = { kind: "draft" } | { kind: "published"; version: string };

type PlaygroundThreadMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  turn?: PlaygroundTurn;
};

const MESSAGE_PARTS = { Text: PlaygroundMessageText };

export function ProbeConversationPanel({
  guardrail,
  guardrails,
  versions,
  target,
  selectedVersion,
  versionsLoading,
  canTestDraft,
  draftPreview,
  draftPreparing,
  draftError,
  turns,
  models,
  modelId,
  pending,
  onModelChange,
  onSubmitMessage,
  onClear,
  onGuardrailChange,
  onTargetChange,
  onRetryDraft,
  onViewDetails,
}: {
  guardrail: Guardrail;
  guardrails: Guardrail[];
  versions: GuardrailVersion[];
  target: PlaygroundTargetChoice;
  selectedVersion?: GuardrailVersion;
  versionsLoading: boolean;
  canTestDraft: boolean;
  draftPreview?: PlaygroundDraftPreview;
  draftPreparing: boolean;
  draftError: Error | null;
  turns: PlaygroundTurn[];
  models: PlaygroundModel[];
  modelId: string;
  pending: boolean;
  onModelChange: (modelId: string) => void;
  onSubmitMessage: (message: string) => Promise<void>;
  onClear: () => void;
  onGuardrailChange: (guardrailId: string) => void;
  onTargetChange: (target: PlaygroundTargetChoice) => void;
  onRetryDraft: () => void;
  onViewDetails: (result: PlaygroundInteraction) => void;
}) {
  const { t } = useTranslation();
  const selectedModel = models.find((model) => model.id === modelId);
  const targetReady = target.kind === "draft" ? Boolean(draftPreview) : Boolean(selectedVersion);
  const [optimisticUserMessage, setOptimisticUserMessage] = useState<PlaygroundThreadMessage | null>(null);
  const messages = useMemo(() => threadMessages(turns, optimisticUserMessage), [optimisticUserMessage, turns]);
  const onNew = useCallback(async (message: AppendMessage) => {
    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (!text) return;

    const optimisticId = generateId();
    setOptimisticUserMessage({ id: optimisticId, role: "user", content: text });
    try {
      await onSubmitMessage(text);
    } catch (error) {
      throw new MessageNotSentError(error instanceof Error ? error.message : undefined);
    } finally {
      setOptimisticUserMessage((current) => current?.id === optimisticId ? null : current);
    }
  }, [onSubmitMessage]);
  const runtime = useExternalStoreRuntime<PlaygroundThreadMessage>({
    messages,
    convertMessage,
    onNew,
    isRunning: pending,
    isDisabled: !models.length || !targetReady,
    isSendDisabled: !selectedModel || !targetReady,
  });

  return (
    <section className="flex h-[calc(100dvh-14rem)] min-h-[34rem] min-w-0 flex-col overflow-hidden rounded-2xl border bg-card shadow-xs">
      <header className="flex items-center gap-3 border-b bg-muted/20 px-4 py-3.5 sm:px-5">
        <span className="grid size-9 place-items-center rounded-xl border bg-card text-primary"><MessageSquareText className="size-4.5" /></span>
        <div className="min-w-0 flex-1"><h2 className="text-sm font-semibold">{t("playground.conversationTitle")}</h2><p className="mt-0.5 truncate text-xs text-muted-foreground">{t("playground.conversationDescription")}</p></div>
        <Button type="button" variant="ghost" className="min-h-11 shrink-0 text-muted-foreground" disabled={!turns.length} onClick={onClear} aria-label={t("playground.clearSession")}>
          <Eraser />
          <span className="hidden sm:inline">{t("playground.clearSession")}</span>
        </Button>
      </header>

      {target.kind === "draft" ? (
        <DraftPreviewNotice
          revision={guardrail.draft_revision ?? 1}
          preview={draftPreview}
          preparing={draftPreparing}
          error={draftError}
          onRetry={onRetryDraft}
        />
      ) : null}

      <AssistantRuntimeProvider runtime={runtime}>
        <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
          <ThreadPrimitive.Viewport className="min-h-0 flex-1 space-y-8 overflow-y-auto bg-background/40 p-4 sm:p-6" aria-live="polite">
            <ThreadPrimitive.Messages>
              {({ message }) => message.role === "user"
                ? <PlaygroundUserMessage />
                : <PlaygroundAssistantMessage model={selectedModel} onViewDetails={onViewDetails} />}
            </ThreadPrimitive.Messages>
          </ThreadPrimitive.Viewport>
          <PlaygroundComposer
            guardrail={guardrail}
            guardrails={guardrails}
            versions={versions}
            target={target}
            selectedVersion={selectedVersion}
            versionsLoading={versionsLoading}
            canTestDraft={canTestDraft}
            draftReady={Boolean(draftPreview)}
            draftPreparing={draftPreparing}
            models={models}
            modelId={modelId}
            pending={pending}
            onGuardrailChange={onGuardrailChange}
            onTargetChange={onTargetChange}
            onModelChange={onModelChange}
          />
        </ThreadPrimitive.Root>
      </AssistantRuntimeProvider>
    </section>
  );
}

function PlaygroundUserMessage() {
  return (
    <MessagePrimitive.Root className="flex w-full justify-end">
      <div className="w-fit max-w-[88%] rounded-2xl rounded-br-md bg-slate-800 px-4 py-3 text-white shadow-sm sm:max-w-3xl">
        <MessagePrimitive.Parts components={MESSAGE_PARTS} />
      </div>
    </MessagePrimitive.Root>
  );
}

function PlaygroundAssistantMessage({ model, onViewDetails }: { model?: PlaygroundModel; onViewDetails: (result: PlaygroundInteraction) => void }) {
  const { t } = useTranslation();
  const source = useAuiState((state) => getExternalStoreMessages<PlaygroundThreadMessage>(state.message)[0]);
  const turn = source?.turn;
  const effectiveModel = turn?.model ?? model;
  return (
    <MessagePrimitive.Root className="w-full space-y-3">
      <div className="mr-auto flex max-w-[92%] items-start gap-3 sm:max-w-3xl">
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-xl border bg-white shadow-xs"><ModelMark model={effectiveModel} className="size-5" /></span>
        {turn && !turn.assistant_message ? (
          <div className="rounded-2xl rounded-tl-md border border-red-200 bg-red-50/60 px-4 py-3">
            <p className="text-sm font-semibold text-red-900">{t(turn.state === "input_blocked" ? "playground.requestStopped" : "playground.responseWithheld")}</p>
            <p className="mt-1 text-xs leading-5 text-red-800/75">{t(turn.state === "input_blocked" ? "playground.requestStoppedDescription" : "playground.responseWithheldDescription")}</p>
          </div>
        ) : (
          <div className="min-w-0 rounded-2xl rounded-tl-md border bg-card px-4 py-3 shadow-xs">
            <p className="mb-1.5 text-[11px] font-semibold text-muted-foreground">{effectiveModel ? `${effectiveModel.provider} · ${effectiveModel.name}` : t("playground.processingTurn")}</p>
            {turn ? <MessagePrimitive.Parts components={MESSAGE_PARTS} /> : <div className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />{t("playground.processingTurnDescription")}</div>}
            <ErrorPrimitive.Root className="mt-2 text-xs text-red-700 empty:hidden"><ErrorPrimitive.Message /></ErrorPrimitive.Root>
          </div>
        )}
      </div>
      {turn ? <div className="mr-auto w-full max-w-[94%] sm:max-w-3xl sm:pl-11"><GuardrailResultCard result={turn} onViewDetails={() => onViewDetails(turn)} /></div> : null}
    </MessagePrimitive.Root>
  );
}

function PlaygroundComposer({ guardrail, guardrails, versions, target, selectedVersion, versionsLoading, canTestDraft, draftReady, draftPreparing, models, modelId, pending, onGuardrailChange, onTargetChange, onModelChange }: {
  guardrail: Guardrail;
  guardrails: Guardrail[];
  versions: GuardrailVersion[];
  target: PlaygroundTargetChoice;
  selectedVersion?: GuardrailVersion;
  versionsLoading: boolean;
  canTestDraft: boolean;
  draftReady: boolean;
  draftPreparing: boolean;
  models: PlaygroundModel[];
  modelId: string;
  pending: boolean;
  onGuardrailChange: (guardrailId: string) => void;
  onTargetChange: (target: PlaygroundTargetChoice) => void;
  onModelChange: (modelId: string) => void;
}) {
  const { t } = useTranslation();
  const latestVersion = versions[0]?.version ?? "";
  const targetValue = target.kind === "draft" ? "draft" : `version:${target.version}`;
  const targetReady = target.kind === "draft" ? draftReady : Boolean(selectedVersion);
  return (
    <div className="border-t bg-card p-3 sm:p-4">
      <ComposerPrimitive.Root className="rounded-2xl border bg-background shadow-xs transition-shadow focus-within:border-primary/35 focus-within:ring-3 focus-within:ring-primary/10">
        <ComposerPrimitive.Input
          className="block max-h-48 min-h-20 w-full resize-none bg-transparent px-4 pt-4 text-sm leading-6 outline-none placeholder:text-muted-foreground"
          placeholder={!models.length ? t("playground.noModelPlaceholder") : draftPreparing ? t("playground.preparingDraftPlaceholder") : targetReady ? t("playground.chatPlaceholder") : t("playground.noTargetPlaceholder")}
          maxLength={8_000}
          submitMode="enter"
          unstable_insertNewlineOnTouchEnter
          aria-label={t("playground.messageModel")}
        />
        <div className="flex flex-col gap-2 border-t border-border/70 p-2 2xl:flex-row 2xl:items-center 2xl:justify-between">
          <div className="grid min-w-0 gap-2 sm:grid-cols-3 2xl:flex 2xl:items-center">
            <Select value={modelId} onValueChange={onModelChange} disabled={!models.length || pending}>
              <SelectTrigger className="h-11 w-full border-0 bg-muted/55 shadow-none 2xl:w-56" aria-label={t("playground.selectedModel")}>
                <SelectValue placeholder={t("playground.selectModel")} />
              </SelectTrigger>
              <SelectContent>
                {models.map((model) => <SelectItem key={model.id} value={model.id}><ModelMark model={model} className="size-4" /><span className="font-medium">{model.provider}</span><span className="text-muted-foreground">{model.name}</span></SelectItem>)}
              </SelectContent>
            </Select>
            <div className="flex min-w-0 items-center gap-1">
              <Select value={guardrail.id} onValueChange={onGuardrailChange} disabled={pending}>
                <SelectTrigger className="h-11 min-w-0 flex-1 border-0 bg-muted/55 shadow-none 2xl:w-56" aria-label={t("playground.selectedGuardrail")}>
                  <ShieldCheck className="size-4 shrink-0 text-emerald-600" /><SelectValue />
                </SelectTrigger>
                <SelectContent>{guardrails.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent>
              </Select>
              <Button asChild size="icon" variant="ghost" className="size-11 shrink-0 text-muted-foreground" title={t("playground.openGuardrailDefinition")}>
                <Link to="/guardrails/$guardrailId" params={{ guardrailId: guardrail.id }} aria-label={t("playground.openGuardrailDefinition")}><ExternalLink /></Link>
              </Button>
            </div>
            <Select value={targetValue} onValueChange={(value) => onTargetChange(value === "draft" ? { kind: "draft" } : { kind: "published", version: value.slice("version:".length) })} disabled={pending || versionsLoading || (!canTestDraft && !versions.length)}>
              <SelectTrigger className="h-11 w-full border-0 bg-muted/55 text-xs shadow-none 2xl:w-64" aria-label={t("playground.selectedGuardrailTarget")}>
                {versionsLoading || draftPreparing ? <LoaderCircle className="size-4 animate-spin text-muted-foreground" /> : target.kind === "draft" ? <FlaskConical className="size-4 text-amber-600" /> : <Tags className="size-4 text-muted-foreground" />}
                <SelectValue placeholder={versionsLoading ? t("playground.loadingTargets") : t("playground.selectTarget")}>
                  {target.kind === "draft" ? <><span className="font-mono font-medium">{t("playground.draftRevision", { revision: guardrail.draft_revision ?? 1 })}</span><span className="text-amber-700">· {t("playground.unpublished")}</span></> : selectedVersion ? <><span className="font-mono font-medium">{t("playground.versionNumber", { version: selectedVersion.version })}</span>{selectedVersion.version === latestVersion ? <span className="text-muted-foreground">· {t("playground.latestVersion")}</span> : selectedVersion.active ? <span className="text-muted-foreground">· {t("playground.activeVersion")}</span> : null}</> : undefined}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {canTestDraft ? <SelectGroup><SelectLabel>{t("playground.draftTargetGroup")}</SelectLabel><SelectItem value="draft"><FlaskConical className="size-4 text-amber-600" /><span className="font-mono font-medium">{t("playground.draftRevision", { revision: guardrail.draft_revision ?? 1 })}</span><span className="text-amber-700">· {t("playground.unpublished")}</span></SelectItem></SelectGroup> : null}
                {canTestDraft && versions.length ? <SelectSeparator /> : null}
                {versions.length ? <SelectGroup><SelectLabel>{t("playground.publishedTargetGroup")}</SelectLabel>{versions.map((item) => {
                    const state = item.version === latestVersion ? t("playground.latestVersion") : item.active ? t("playground.activeVersion") : "";
                    return <SelectItem key={item.version} value={`version:${item.version}`}><span className="font-mono font-medium">{t("playground.versionNumber", { version: item.version })}</span>{state ? <span className="text-muted-foreground">· {state}</span> : null}</SelectItem>;
                  })}</SelectGroup> : null}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-end gap-3 pl-1">
            <span className="hidden text-[11px] text-muted-foreground sm:inline">{t("playground.keyboardHelp")}</span>
            <ComposerPrimitive.Send asChild>
              <Button type="submit" size="icon" className="size-11 shrink-0 rounded-xl" aria-label={t("playground.sendMessage")}>
                {pending ? <LoaderCircle className="animate-spin" /> : <Send />}
              </Button>
            </ComposerPrimitive.Send>
          </div>
        </div>
      </ComposerPrimitive.Root>
    </div>
  );
}

function DraftPreviewNotice({ revision, preview, preparing, error, onRetry }: { revision: number; preview?: PlaygroundDraftPreview; preparing: boolean; error: Error | null; onRetry: () => void }) {
  const { t } = useTranslation();
  if (error) {
    return (
      <div className="flex items-start gap-3 border-b border-red-200 bg-red-50/70 px-4 py-3 text-red-900 sm:px-5" role="alert">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1"><p className="text-xs font-semibold">{t("playground.draftPreviewFailed")}</p><p className="mt-0.5 text-xs text-red-800/80">{error.message}</p></div>
        <Button type="button" size="sm" variant="outline" className="min-h-9 border-red-200 bg-white" onClick={onRetry}><RotateCcw />{t("common.retry")}</Button>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-3 border-b border-amber-200 bg-amber-50/70 px-4 py-3 text-amber-950 sm:px-5">
      {preparing ? <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin" /> : <FlaskConical className="mt-0.5 size-4 shrink-0" />}
      <div className="min-w-0"><p className="text-xs font-semibold">{preparing ? t("playground.preparingDraft", { revision }) : t("playground.testingDraft", { revision })}</p><p className="mt-0.5 text-xs leading-5 text-amber-900/75">{t("playground.draftPreviewNotice", { expires: preview ? new Date(preview.expires_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "" })}</p></div>
    </div>
  );
}

function PlaygroundMessageText({ text }: TextMessagePartProps) {
  return <p className="whitespace-pre-wrap text-sm leading-6">{text}</p>;
}

function threadMessages(turns: PlaygroundTurn[], optimisticUserMessage: PlaygroundThreadMessage | null): PlaygroundThreadMessage[] {
  const completedMessages: PlaygroundThreadMessage[] = turns.flatMap((turn) => [
    { id: `${turn.interaction_id}:user`, role: "user", content: turn.user_message },
    { id: `${turn.interaction_id}:assistant`, role: "assistant", content: turn.assistant_message ?? "", turn },
  ]);
  return optimisticUserMessage ? [...completedMessages, optimisticUserMessage] : completedMessages;
}

function convertMessage(message: PlaygroundThreadMessage): ThreadMessageLike {
  return { id: message.id, role: message.role, content: message.content };
}
