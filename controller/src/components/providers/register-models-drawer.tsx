import { useMutation } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Check, CheckCircle2, KeyRound, LoaderCircle, Plus, ServerCog, TriangleAlert, X } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CreationFlow } from "@/components/creation-flow";
import { EntitySheet } from "@/components/entity-sheet";
import { StateBadge } from "@/components/product-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  createModelDefinition, discoverModelProvider, discoverProviderDraft, registerProviderModels, testModelConnection,
  type DiscoveredProviderModels, type ModelDefinition, type ModelProvider, type ProviderModelSelection,
} from "@/lib/controller-api";
import { cn } from "@/lib/utils";
import { displayNameForModel, suggestedProfile } from "./model-selection";
import { ProviderMark } from "./provider-mark";
import { ProviderPicker } from "./provider-picker";
import { ProviderTlsControl } from "./provider-tls-control";
import { ModelCallEvidence } from "./model-call-evidence";
import { createProviderDraft, providerPresets, type ProviderPresetId } from "./provider-ui-registry";

type Step = "source" | "models" | "complete";
type Summary = { providerName: string; models: ModelDefinition[]; failures: Array<{ model: ProviderModelSelection; message: string }> };
type Discovery = Omit<DiscoveredProviderModels, "providerId">;

// Port of Relay's RegisterModelsDrawer: source -> review models -> complete.
// Registration checks actual model calls. Scenario assignments and semantic
// detection validation belong to Capabilities rather than this selection step.
export function RegisterModelsDrawer({ providers, registeredModels, initialProviderId, intent, open, onOpenChange, onChanged }: {
  providers: ModelProvider[];
  registeredModels: ModelDefinition[];
  initialProviderId?: string;
  intent: "add-provider" | "register-models";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>("source");
  const [credentialMode, setCredentialMode] = useState<"existing" | "new">(intent === "add-provider" || !providers.length ? "new" : "existing");
  const [providerId, setProviderId] = useState(initialProviderId ?? providers[0]?.id ?? "");
  const [presetId, setPresetId] = useState<ProviderPresetId>();
  const [draft, setDraft] = useState(() => createProviderDraft("openai"));
  const [discovery, setDiscovery] = useState<Discovery>();
  const [models, setModels] = useState<ProviderModelSelection[]>([]);
  const [manualModelId, setManualModelId] = useState("");
  const [search, setSearch] = useState("");
  const [summary, setSummary] = useState<Summary>();
  const [formError, setFormError] = useState("");
  const [manualDiscoveryError, setManualDiscoveryError] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const activeProvider = providers.find((item) => item.id === providerId);
  const existing = registeredModels.filter((item) => credentialMode === "existing" && item.providerId === providerId);
  const existingIds = new Set(existing.map((item) => item.model));
  const preset = providerPresets.find((item) => item.id === presetId);

  const discover = useMutation({
    mutationFn: () => credentialMode === "existing" ? discoverModelProvider(providerId) : discoverProviderDraft(draft),
    onSuccess: (result) => {
      setDiscovery(result);
      setModels([]);
      setManualDiscoveryError("");
      setStep("models");
    },
  });
  const register = useMutation({
    mutationFn: async (): Promise<Summary> => {
      if (credentialMode === "new") {
        const result = await registerProviderModels({ connection: draft, models });
        return { providerName: result.provider.name, models: result.models, failures: result.failures };
      }
      if (!activeProvider) throw new Error(t("modelSettings.selectProvider"));
      const results = await Promise.all(models.map(async (model) => {
        try {
          const created = await createModelDefinition({ providerId, ...model });
          return { created };
        } catch (error) {
          return { failure: { model, message: errorMessage(error) } };
        }
      }));
      return { providerName: activeProvider.name, models: results.flatMap((result) => result.created ? [result.created] : []), failures: results.flatMap((result) => result.failure ? [result.failure] : []) };
    },
    onSuccess: async (result) => {
      setSummary(result);
      setDraft((current) => ({ ...current, apiKey: "" }));
      setStep("complete");
      await onChanged();
    },
  });
  const retryFailures = useMutation({
    mutationFn: async () => {
      if (!summary) return;
      // Retry only failed items; never submit already registered models again.
      const results = await Promise.all(summary.failures.map(async (failure) => {
        try {
          const model = await createModelDefinition({
            providerId: summary.models[0]?.providerId ?? providerId, ...failure.model,
          });
          return { model };
        } catch (error) { return { failure: { ...failure, message: errorMessage(error) } }; }
      }));
      setSummary({ ...summary, models: [...summary.models, ...results.flatMap((result) => result.model ? [result.model] : [])], failures: results.flatMap((result) => result.failure ? [result.failure] : []) });
      await onChanged();
    },
  });
  const retryConnection = useMutation({
    mutationFn: testModelConnection,
    onSuccess: async (updated) => {
      setSummary((current) => current ? { ...current, models: current.models.map((item) => item.id === updated.id ? updated : item) } : current);
      await onChanged();
    },
  });
  const pending = discover.isPending || register.isPending || retryFailures.isPending || retryConnection.isPending;
  const needsAttention = Boolean(summary?.failures.length || summary?.models.some((model) => model.connectionStatus !== "validated"));
  const invalidSelection = models.some((model) => model.name.trim().length < 2
    || !Number.isInteger(model.timeoutSeconds) || model.timeoutSeconds < 1 || model.timeoutSeconds > 120
    || !Number.isInteger(model.maxTokens) || model.maxTokens < 1 || model.maxTokens > 32768);
  const sourceChanged = () => { discover.reset(); register.reset(); setFormError(""); setDiscovery(undefined); setModels([]); setSearch(""); setManualModelId(""); setManualDiscoveryError(""); };
  const steps = [
    { label: t("modelSettings.provider"), description: t("providerRegistration.chooseSource") },
    { label: t("providerRegistration.reviewModels"), description: t("providerRegistration.selectModels") },
    { label: t("providerRegistration.complete"), description: t("providerRegistration.reviewResults") },
  ];
  const chooseProvider = (id: ProviderPresetId) => { sourceChanged(); setPresetId(id); setDraft(createProviderDraft(id)); };
  const validateAndDiscover = () => {
    if (!formRef.current?.reportValidity()) return;
    if (credentialMode === "new" && !presetId) { setFormError(t("modelSettings.selectProvider")); return; }
    setFormError("");
    discover.mutate();
  };
  const toggle = (id: string) => setModels((current) => current.some((item) => item.model === id) ? current.filter((item) => item.model !== id) : [...current, selection(id)]);
  const catalog = [
    ...(discovery?.models ?? []),
    ...models.filter((item) => !discovery?.models.some((candidate) => candidate.id === item.model)).map((item) => ({ id: item.model, name: item.name })),
  ].filter((item) => `${item.name} ${item.id}`.toLowerCase().includes(search.toLowerCase()));

  return (
    <EntitySheet
      open={open}
      closeDisabled={pending}
      onOpenChange={(next) => { if (!pending) onOpenChange(next); }}
      eyebrow={t("providerRegistration.progress")}
      title={t(intent === "add-provider" ? "modelSettings.addProvider" : "providerRegistration.registerModels")}
      description={t("providerRegistration.description")}
      width="xl"
      bodyClassName="p-0 sm:p-0"
      footer={<div className="w-full space-y-2">
        <div className="flex items-center justify-between gap-3">
          {step === "complete" ? <Button className="ml-auto h-11" disabled={pending} onClick={() => onOpenChange(false)}>{t("providerRegistration.done")}</Button> : <>
            <Button type="button" variant="outline" className="h-11" disabled={pending} onClick={() => { if (step === "source") onOpenChange(false); else { setStep("source"); register.reset(); } }}>{step === "models" ? <ArrowLeft /> : null}{t(step === "source" ? "common.cancel" : "common.back")}</Button>
            <Button type="button" className="h-11" disabled={pending || (step === "source" ? credentialMode === "existing" ? !activeProvider : !presetId : !models.length || models.length > 50 || invalidSelection)}
              onClick={() => step === "source" ? validateAndDiscover() : register.mutate()}>
              {pending ? <LoaderCircle className="animate-spin motion-reduce:animate-none" /> : null}{t(step === "source" ? "providerRegistration.discoverModels" : "providerRegistration.registerSelected", { count: models.length })}<ArrowRight />
            </Button>
          </>}
        </div>
        {step === "models" && !models.length ? <p className="text-right text-xs text-muted-foreground">{t("providerRegistration.selectAtLeastOne")}</p> : null}
        {step === "models" && models.length > 50 ? <p className="text-right text-xs text-destructive">{t("providerRegistration.selectionLimit")}</p> : null}
        {step === "models" && invalidSelection ? <p role="alert" className="text-right text-xs text-destructive">{t("providerRegistration.invalidSelection")}</p> : null}
      </div>}
    >
          <CreationFlow steps={steps} currentStep={step === "source" ? 0 : step === "models" ? 1 : 2} progressLabel={t("providerRegistration.progress")} orientation="sidebar"
            onStepChange={(next) => { if (!pending && step !== "complete" && next === 0) { setStep("source"); register.reset(); } }}>
            {step === "source" ? (
              <form ref={formRef} onSubmit={(event) => { event.preventDefault(); validateAndDiscover(); }}>
                <fieldset disabled={pending} className="min-w-0 space-y-6">
                  {intent !== "add-provider" && !initialProviderId && providers.length ? (
                    <div role="radiogroup" aria-label={t("providerRegistration.credentialSource")} className="grid gap-2 sm:grid-cols-2">
                      {(["existing", "new"] as const).map((mode) => <button key={mode} type="button" role="radio" aria-checked={credentialMode === mode}
                        className={cn("min-h-24 border p-3 text-left transition-colors focus-visible:ring-3 focus-visible:ring-ring/20", credentialMode === mode ? "border-primary bg-primary/5" : "hover:bg-muted/40")}
                        onClick={() => { sourceChanged(); setCredentialMode(mode); }}>
                        <strong className="text-sm">{t(`providerRegistration.${mode}Credentials`)}</strong><span className="mt-1 block text-xs leading-5 text-muted-foreground">{t(`providerRegistration.${mode}Description`)}</span>
                      </button>)}
                    </div>
                  ) : null}
                  {credentialMode === "existing" ? (
                    <Field id="provider-credentials" label={t("providerRegistration.savedCredentials")}>
                      <Select value={providerId} disabled={pending} onValueChange={(id) => { sourceChanged(); setProviderId(id); }}>
                        <SelectTrigger id="provider-credentials" className="h-12 w-full"><SelectValue /></SelectTrigger>
                        <SelectContent position="popper">{providers.map((provider) => <SelectItem key={provider.id} value={provider.id}><span className="flex items-center gap-2"><ProviderMark provider={provider.name} kind={provider.kind} size="sm" />{provider.name}</span></SelectItem>)}</SelectContent>
                      </Select>
                      {activeProvider ? <p className="break-all font-mono text-xs text-muted-foreground">{activeProvider.baseUrl}</p> : null}
                      {activeProvider?.skipTlsVerify ? <p className="text-xs text-amber-700 dark:text-amber-400">{t("providerRegistration.tlsSkipped")}</p> : null}
                      <p className="text-xs leading-5 text-muted-foreground">{t("providerRegistration.credentialsStayOnServer")}</p>
                    </Field>
                  ) : (
                    <div className="space-y-5">
                      <section className="space-y-3 border-b pb-5">
                        <div className="flex items-start gap-2.5"><ServerCog className="mt-0.5 size-4 shrink-0" /><div><h3 className="text-sm font-semibold">{t("modelSettings.provider")}</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">{t("providerRegistration.chooseProvider")}</p></div></div>
                        <ProviderPicker value={presetId} disabled={pending} onChange={chooseProvider} />
                      </section>
                      {preset ? <section className="space-y-5">
                        <div className="flex items-start gap-2.5"><KeyRound className="mt-0.5 size-4 shrink-0" /><div><h3 className="text-sm font-semibold">{t("providerRegistration.credentialsEndpoint")}</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">{t("providerRegistration.credentialsStoredOnRegistration")}</p></div></div>
                        <Field id="provider-name" label={t("modelSettings.providerName")}><Input id="provider-name" className="h-11" required minLength={3} maxLength={80} value={draft.name} onChange={(event) => { sourceChanged(); setDraft({ ...draft, name: event.target.value }); }} /></Field>
                        {presetId === "qwen" ? <Field id="qwen-region" label={t("providerRegistration.endpointRegion")}><Select value={draft.baseUrl.includes("dashscope.aliyuncs.com") ? "cn" : "international"} disabled={pending} onValueChange={(region) => { sourceChanged(); setDraft({ ...draft, baseUrl: region === "cn" ? "https://dashscope.aliyuncs.com/compatible-mode/v1" : "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" }); }}><SelectTrigger id="qwen-region" className="h-11"><SelectValue /></SelectTrigger><SelectContent position="popper"><SelectItem value="international">{t("providerRegistration.international")}</SelectItem><SelectItem value="cn">{t("providerRegistration.mainlandChina")}</SelectItem></SelectContent></Select></Field> : null}
                        <Field id="provider-url" label={t("modelSettings.baseUrl")}><Input id="provider-url" className="h-11 font-mono" type="url" required pattern="https?://.*" value={draft.baseUrl} placeholder="https://api.example.com/v1" onChange={(event) => { sourceChanged(); setDraft({ ...draft, baseUrl: event.target.value, ...(event.target.value.startsWith("https:") ? {} : { skipTlsVerify: false }) }); }} /><p className="text-xs leading-5 text-muted-foreground">{t("modelSettings.baseUrlHint")}</p></Field>
                        {draft.baseUrl.startsWith("https:") ? <ProviderTlsControl checked={draft.skipTlsVerify === true} disabled={pending} onChange={(skipTlsVerify) => { sourceChanged(); setDraft({ ...draft, skipTlsVerify }); }} /> : null}
                        <Field id="provider-key" label={t("modelSettings.apiKey")}><Input id="provider-key" className="h-11" type="password" autoComplete="new-password" required={preset.keyRequired} value={draft.apiKey} onChange={(event) => { sourceChanged(); setDraft({ ...draft, apiKey: event.target.value }); }} /><p className="text-xs leading-5 text-muted-foreground">{t(preset.keyRequired ? "providerRegistration.keyRequired" : "modelSettings.apiKeyHint")}</p></Field>
                      </section> : null}
                    </div>
                  )}
                  {formError || discover.error ? <ErrorMessage>{formError || errorMessage(discover.error)}</ErrorMessage> : null}
                  {discover.error ? <Button type="button" variant="outline" className="min-h-11" onClick={() => { setDiscovery({ providerName: activeProvider?.name ?? draft.name, models: [] }); setModels([]); setManualDiscoveryError(errorMessage(discover.error)); setStep("models"); }}>{t("providerRegistration.continueManually")}</Button> : null}
                </fieldset>
              </form>
            ) : step === "models" && discovery ? (
              <fieldset disabled={pending} className="min-w-0 space-y-6">
                <div className={cn("border-l-2 px-4 py-3 text-sm", manualDiscoveryError ? "border-destructive bg-destructive/5" : "border-primary bg-primary/5")}>
                  <strong>{t(manualDiscoveryError ? "providerRegistration.manualRegistration" : "providerRegistration.liveCatalog")}</strong>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">{manualDiscoveryError || t("providerRegistration.reviewDescription", { provider: discovery.providerName })}</p>
                </div>
                <section aria-label={t("providerRegistration.selectedModels")} className="rounded-lg border border-primary/25 bg-card p-4">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-sm font-semibold">{t("providerRegistration.selectedModels")}</h3>
                    <span role="status" aria-live="polite" className="text-sm font-medium text-primary">{t("providerRegistration.selected", { count: models.length })}</span>
                  </div>
                  {models.length ? <ul className="mt-3 max-h-40 divide-y overflow-y-auto">{models.map((model) => (
                    <li key={model.model} className="flex min-h-11 items-center gap-2 py-1">
                      <CheckCircle2 className="size-4 shrink-0 text-primary" aria-hidden="true" />
                      <code className="min-w-0 flex-1 break-all text-xs">{model.model}</code>
                      {!discovery.models.some((item) => item.id === model.model) ? <span className="text-xs text-muted-foreground">{t("providerRegistration.manual")}</span> : null}
                      <Button type="button" size="icon" variant="ghost" className="size-11 shrink-0" disabled={pending} aria-label={t("providerRegistration.deselectModel", { model: model.model })} onClick={() => toggle(model.model)}><X /></Button>
                    </li>
                  ))}</ul> : <p className="mt-2 text-xs leading-5 text-muted-foreground">{t("providerRegistration.selectAtLeastOne")}</p>}
                </section>
                <section className="space-y-3">
                  <h3 className="text-sm font-semibold">{t("providerRegistration.discoveredModels")}</h3>
                  <Input className="h-11" aria-label={t("providerRegistration.searchModels")} placeholder={t("providerRegistration.searchModels")} value={search} onChange={(event) => setSearch(event.target.value)} />
                  <div className="max-h-64 divide-y overflow-y-auto rounded-lg border">
                    {catalog.map((item) => {
                      const model = models.find((candidate) => candidate.model === item.id);
                      const alreadyRegistered = existingIds.has(item.id);
                      return <div key={item.id} className={cn("border-l-2 border-l-transparent px-3 py-2", model && "border-l-primary bg-primary/10")}>
                        <button type="button" aria-label={`${item.name} ${item.id}${alreadyRegistered ? ` ${t("providerRegistration.registered")}` : ""}`} aria-pressed={Boolean(model)} disabled={alreadyRegistered || pending} onClick={() => toggle(item.id)} className="flex min-h-11 w-full items-center gap-3 text-left disabled:opacity-60">
                          <span className={cn("grid size-5 shrink-0 place-items-center border", (model || alreadyRegistered) && "border-primary bg-primary text-primary-foreground")}>{model || alreadyRegistered ? <Check className="size-3.5" /> : null}</span>
                          <span className="min-w-0 flex-1"><strong className="block break-words text-sm">{item.name}</strong><span className="block break-all font-mono text-xs text-muted-foreground">{item.id}</span></span>
                          {alreadyRegistered || model ? <span className={cn("shrink-0 text-xs font-medium", model ? "text-primary" : "text-muted-foreground")}>{t(alreadyRegistered ? "providerRegistration.registered" : "providerRegistration.selectedLabel")}</span> : null}
                        </button>
                      </div>;
                    })}
                    {!catalog.length ? <p className="p-4 text-sm text-muted-foreground">{t("providerRegistration.noModels")}</p> : null}
                  </div>
                </section>
                <section className="space-y-3 border bg-muted/10 p-4">
                  <h3 className="text-sm font-semibold">{t("providerRegistration.manualRegistration")}</h3>
                  <p className="text-xs leading-5 text-muted-foreground">{t("providerRegistration.manualHint")}</p>
                  <div className="flex gap-2"><Input aria-label={t("providerRegistration.manualModelId")} className="h-11 min-w-0 font-mono" maxLength={256} value={manualModelId} onChange={(event) => setManualModelId(event.target.value)} placeholder={t("modelSettings.modelId")} /><Button type="button" variant="outline" className="h-11" disabled={!manualModelId.trim() || existingIds.has(manualModelId.trim()) || models.some((item) => item.model === manualModelId.trim())} onClick={() => { setModels([...models, selection(manualModelId.trim())]); setManualModelId(""); setSearch(""); }}><Plus />{t("providerRegistration.add")}</Button></div>
                </section>
              </fieldset>
            ) : summary ? (
              <div className="space-y-6">
                <div className={cn("flex items-start gap-3 border p-4", needsAttention ? "bg-muted/30" : "bg-primary/5")}>
                  {needsAttention ? <TriangleAlert className="mt-0.5 size-5 shrink-0" /> : <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-primary" />}
                  <div><strong>{t(summary.models.length ? "providerRegistration.registrationComplete" : "providerRegistration.registrationFailed")}</strong><p className="mt-1 text-xs leading-5 text-muted-foreground">{t("providerRegistration.resultSummary", { provider: summary.providerName, count: summary.models.length })}</p></div>
                </div>
                {summary.models.length ? <section><h3 className="mb-2 text-sm font-semibold">{t("providerRegistration.readyModels")}</h3><p className="mb-3 text-xs leading-5 text-muted-foreground">{t("providerRegistration.configureLater")}</p><div className="divide-y border">{summary.models.map((model) => <div key={model.id} className="space-y-3 px-3 py-3"><div className="flex flex-wrap items-start justify-between gap-3"><span className="min-w-0 flex-1"><strong className="block break-words text-sm">{model.name}</strong><span className="break-all font-mono text-xs text-muted-foreground">{model.model}</span></span><ModelCallEvidence model={model} checking={retryConnection.isPending && retryConnection.variables === model.id} /></div>{model.connectionStatus !== "validated" ? <Button type="button" variant="outline" className="h-11" disabled={pending} aria-label={`${t("modelSettings.testCall")} ${model.name}`} onClick={() => retryConnection.mutate(model.id)}>{t("modelSettings.testCall")}</Button> : null}</div>)}</div></section> : null}
                {summary.failures.length ? <section><h3 className="mb-2 text-sm font-semibold">{t("providerRegistration.needsAttention")}</h3><div className="divide-y border border-destructive/30">{summary.failures.map((failure) => <div key={failure.model.model} className="p-3"><strong className="break-all text-sm">{failure.model.name}</strong><p className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-destructive">{failure.message}</p></div>)}</div><Button type="button" variant="outline" className="mt-3 h-11" disabled={pending} onClick={() => retryFailures.mutate()}>{t("providerRegistration.retryFailed")}</Button></section> : null}
              </div>
            ) : null}
            {register.error ? <div className="mt-4"><ErrorMessage>{errorMessage(register.error)}</ErrorMessage></div> : null}
            {retryConnection.error ? <div className="mt-4"><ErrorMessage>{errorMessage(retryConnection.error)}</ErrorMessage></div> : null}
            {pending ? <p role="status" className="mt-4 flex items-start gap-2 border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground"><LoaderCircle className="size-4 shrink-0 animate-spin" />{t(discover.isPending ? "modelSettings.discoveringModels" : "providerRegistration.registering")}</p> : null}
          </CreationFlow>
    </EntitySheet>
  );
}

function selection(id: string): ProviderModelSelection {
  const name = displayNameForModel(id).slice(0, 120);
  return { name: name.length >= 2 ? name : `Model ${id}`, model: id, profile: suggestedProfile(id), timeoutSeconds: 20, maxTokens: 512 };
}
function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return <div className="space-y-2"><Label htmlFor={id}>{label}</Label>{children}</div>;
}
function ErrorMessage({ children }: { children: ReactNode }) {
  return <p role="alert" className="whitespace-pre-wrap break-words border-l-2 border-destructive bg-destructive/5 px-3 py-2 text-sm text-destructive">{children}</p>;
}
function errorMessage(error: unknown) { return error instanceof Error ? error.message : "Request failed."; }
