import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  Braces,
  Check,
  CircleAlert,
  FileText,
  LoaderCircle,
  MessageSquareText,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { ComplianceDocumentImport } from "@/components/compliance-document-import";
import { CreationFlow } from "@/components/creation-flow";
import { EntitySheet } from "@/components/entity-sheet";
import { PolicyBindingEditor, defaultPolicyBinding, getPolicyBindingValidation } from "@/components/policy-binding-editor";
import { ErrorNotice, InfoNotice } from "@/components/product-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { queryKeys } from "@/features/query-keys";
import { useAuth } from "@/lib/auth";
import {
  analyzeGuardrailIntent,
  createGuardrail,
  getIntentAnalysisStatus,
  getPolicies,
  previewGuardrailCandidate,
  type ComplianceDocumentAnalysis,
  type GuardrailPolicyBinding,
  type IntentAnalysis,
  type OutputDelivery,
  type Policy,
} from "@/lib/api";

const EMPTY_POLICIES: Policy[] = [];
const FULL_BUFFERED_POLICY_IDS = new Set(["builtin-system-prompt-leakage", "builtin-automated-reasoning"]);
type PolicyWorkspace = "main" | "intent" | "documents";
type BoundarySource = "intent" | "documents" | null;

export function CreateGuardrailWizard({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const policiesQuery = useQuery({ queryKey: queryKeys.policies, queryFn: getPolicies, enabled: open });
  const intentStatusQuery = useQuery({ queryKey: queryKeys.intentAnalysisStatus, queryFn: getIntentAnalysisStatus, enabled: open, retry: false });
  const policies = policiesQuery.data?.items ?? EMPTY_POLICIES;
  const [step, setStep] = useState(0);
  const [policyWorkspace, setPolicyWorkspace] = useState<PolicyWorkspace>("main");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [purposeAudience, setPurposeAudience] = useState("");
  const [purposeTasks, setPurposeTasks] = useState("");
  const [purposeProtect, setPurposeProtect] = useState("");
  const [purposeOutOfScope, setPurposeOutOfScope] = useState("");
  const [intentText, setIntentText] = useState("");
  const [intentProposal, setIntentProposal] = useState<IntentAnalysis | null>(null);
  const [allowed, setAllowed] = useState("");
  const [restricted, setRestricted] = useState("");
  const [boundarySource, setBoundarySource] = useState<BoundarySource>(null);
  const [bindings, setBindings] = useState<GuardrailPolicyBinding[]>([]);
  const [outputDelivery, setOutputDelivery] = useState<OutputDelivery>("window_buffered");
  const [customRules, setCustomRules] = useState<CustomRuleRow[]>([]);
  const [showBoundaries, setShowBoundaries] = useState(false);
  const [documentImportReset, setDocumentImportReset] = useState(0);
  const nextBlockedReasonId = useId();

  const steps = [
    { label: t("guardrailWizard.steps.details"), description: t("guardrailWizard.steps.detailsDescription") },
    { label: t("guardrailWizard.steps.policies"), description: t("guardrailWizard.steps.policiesDescription") },
    { label: t("guardrailWizard.steps.review"), description: t("guardrailWizard.steps.reviewDescription") },
  ];

  useEffect(() => {
    if (!open) return;
    setStep(0);
    setPolicyWorkspace("main");
    setName("");
    setDescription("");
    setPurposeAudience("");
    setPurposeTasks("");
    setPurposeProtect("");
    setPurposeOutOfScope("");
    setCustomRules([]);
    setShowBoundaries(false);
    setIntentText("");
    setIntentProposal(null);
    setAllowed("");
    setRestricted("");
    setBoundarySource(null);
    setBindings([]);
    setOutputDelivery("window_buffered");
    setDocumentImportReset((current) => current + 1);
  }, [open]);

  const language = user?.preferred_language ?? (i18n.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en");
  const analyzeIntent = useMutation({
    mutationFn: () => analyzeGuardrailIntent({ purpose: intentText.trim(), language }),
    onSuccess: (analysis) => setIntentProposal(analysis),
    onError: (error) => notifyError(error, t("guardrailWizard.operationFailed")),
  });

  const payload = useMemo(() => ({
    name: name.trim(),
    purpose: description.trim(),
    purpose_details: {
      audience: purposeAudience.trim(),
      tasks: purposeTasks.trim(),
      protect: purposeProtect.trim(),
      out_of_scope: purposeOutOfScope.trim(),
    },
    custom_content_rules: customRulesToDraft(customRules),
    allowed_topics: lines(allowed),
    restricted_topics: lines(restricted),
    policy_bindings: bindings,
    safety_level: "balanced" as const,
    output_delivery: outputDelivery,
  }), [allowed, bindings, customRules, description, name, outputDelivery, purposeAudience, purposeTasks, purposeProtect, purposeOutOfScope, restricted]);

  const preview = useMutation({ mutationFn: () => previewGuardrailCandidate(payload) });
  useEffect(() => {
    if (step === 2 && bindings.length && bindingsValid(bindings, policies)) preview.mutate();
    // The preview is a point-in-time review; edits happen on previous steps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const create = useMutation({
    mutationFn: () => createGuardrail(payload),
    onSuccess: (guardrail) => {
      toast.success(t("guardrailWizard.created", { name: guardrail.name }));
      onCreated(guardrail.id);
    },
    onError: (error) => notifyError(error, t("guardrailWizard.operationFailed")),
  });

  function addPolicies(policyIds: string[]) {
    setBindings((current) => {
      const selected = new Set(current.map((binding) => binding.policy_id));
      const additions = [...new Set(policyIds)]
        .map((id) => policies.find((policy) => policy.id === id))
        .filter(isBindablePolicy)
        .filter((policy) => !selected.has(policy.id))
        .map(defaultPolicyBinding);
      return [...current, ...additions];
    });
  }

  function applyIntentProposal() {
    if (!intentProposal) return;
    if (intentProposal.structured_purpose) {
      setPurposeAudience(intentProposal.structured_purpose.audience);
      setPurposeTasks(intentProposal.structured_purpose.tasks);
      setPurposeProtect(intentProposal.structured_purpose.protect);
      setPurposeOutOfScope(intentProposal.structured_purpose.out_of_scope);
    }
    setAllowed(intentProposal.allowed_topics.join("\n"));
    setRestricted(intentProposal.restricted_topics.join("\n"));
    setBoundarySource("intent");
    const topicPolicy = recommendedTopicPolicy(policies);
    if (topicPolicy) addPolicies([topicPolicy.id]);
    setPolicyWorkspace("main");
    toast.success(t("guardrailWizard.intentGenerated"));
  }

  function applyDocumentAnalysis(analysis: ComplianceDocumentAnalysis) {
    setAllowed(analysis.allowed_topics.join("\n"));
    setRestricted(analysis.restricted_topics.join("\n"));
    setBoundarySource("documents");
    addPolicies(analysis.recommended_policy_ids);
    setPolicyWorkspace("main");
    toast.success(t("guardrailWizard.documentAppliedMessage"));
  }

  function changeStep(next: number) {
    setPolicyWorkspace("main");
    setStep(next);
  }

  const hasOutputPolicy = bindings.some((binding) => binding.enabled_rails.includes("output"));
  const fullBufferedMismatch = bindings.some((binding) => FULL_BUFFERED_POLICY_IDS.has(binding.policy_id)) && outputDelivery !== "full_buffered";
  const policyBlocker = getPolicyBindingsBlocker(bindings, policies);
  const policyBlockedReason = policyBlocker ? t(policyBlocker.key, policyBlocker.values)
    : fullBufferedMismatch ? t("guardrailWizard.fullBufferedRequiredDescription") : null;
  const stepValid = [
    Boolean(name.trim()),
    !policyBlockedReason,
    Boolean(preview.data && !preview.error),
  ];
  const nextBlockedReason = step === 0 && !stepValid[0]
    ? t("guardrailWizard.nextBlocked.name")
    : step === 1 ? policyBlockedReason : null;
  const inPolicyWorkspace = step === 1 && policyWorkspace !== "main";

  return (
    <EntitySheet
      open={open}
      onOpenChange={onOpenChange}
      eyebrow={t("guardrailWizard.eyebrow")}
      title={t("guardrailWizard.title")}
      description={t("guardrailWizard.description")}
      width="xl"
      bodyClassName="p-0 sm:p-0"
      footer={inPolicyWorkspace ? (
        <Button className="mr-auto" variant="outline" onClick={() => setPolicyWorkspace("main")}>
          <ArrowLeft />{t("guardrailWizard.backToPolicies")}
        </Button>
      ) : (
        <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center">
          {nextBlockedReason ? (
            <p id={nextBlockedReasonId} role="status" className="mr-auto flex min-w-0 flex-1 items-start gap-2 text-left text-xs leading-5 text-amber-800">
              <CircleAlert className="mt-0.5 size-4 shrink-0" />
              <span>{nextBlockedReason}</span>
            </p>
          ) : null}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Button variant="outline" onClick={() => step ? changeStep(step - 1) : onOpenChange(false)}>
              {step ? <><ArrowLeft />{t("common.previous")}</> : t("common.cancel")}
            </Button>
            {step < steps.length - 1 ? (
              <Button
                aria-describedby={nextBlockedReason ? nextBlockedReasonId : undefined}
                disabled={!stepValid[step]}
                title={nextBlockedReason ?? undefined}
                onClick={() => changeStep(step + 1)}
              >
                {t("common.next")}<ArrowRight />
              </Button>
            ) : (
              <Button disabled={!stepValid.every(Boolean) || create.isPending} onClick={() => create.mutate()}>
                {create.isPending ? <LoaderCircle className="animate-spin" /> : <ShieldCheck />}
                {t(create.isPending ? "guardrailWizard.creatingDraft" : "guardrailWizard.createDraft")}
              </Button>
            )}
          </div>
        </div>
      )}
    >
      <CreationFlow orientation="sidebar" currentStep={step} onStepChange={changeStep} progressLabel={t("guardrailWizard.title")} steps={steps}>
        {step === 0 ? (
          <WizardSection title={t("guardrailWizard.detailsTitle")} description={t("guardrailWizard.detailsDescription")}>
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5">
              <Field label={`${t("guardrailWizard.name")} *`}>
                <Input autoFocus className="min-h-11 bg-card" value={name} onChange={(event) => setName(event.target.value)} placeholder={t("guardrailWizard.namePlaceholder")} />
              </Field>
              <Field label={t("guardrailWizard.descriptionLabel")} hint={t("guardrailWizard.descriptionHint")}>
                <Textarea className="min-h-28 bg-card" value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t("guardrailWizard.descriptionPlaceholder")} />
              </Field>
              <details className="rounded-xl border bg-card p-4">
                <summary className="min-h-11 cursor-pointer text-sm font-semibold">{t("guardrailWizard.purposeStructuredTitle")}</summary>
                <p className="mb-4 text-xs leading-5 text-muted-foreground">{t("guardrailWizard.purposeStructuredDescription")}</p>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label={t("guardrailWizard.purposeAudience")} hint={t("guardrailWizard.purposeAudienceHint")}>
                      <Input className="min-h-11 bg-card" value={purposeAudience} onChange={(event) => setPurposeAudience(event.target.value)} placeholder={t("guardrailWizard.purposeAudiencePlaceholder")} />
                    </Field>
                    <Field label={t("guardrailWizard.purposeTasks")} hint={t("guardrailWizard.purposeTasksHint")}>
                      <Textarea className="min-h-24 bg-card" value={purposeTasks} onChange={(event) => setPurposeTasks(event.target.value)} placeholder={t("guardrailWizard.purposeTasksPlaceholder")} />
                    </Field>
                    <Field label={t("guardrailWizard.purposeProtect")} hint={t("guardrailWizard.purposeProtectHint")}>
                      <Textarea className="min-h-24 bg-card" value={purposeProtect} onChange={(event) => setPurposeProtect(event.target.value)} placeholder={t("guardrailWizard.purposeProtectPlaceholder")} />
                    </Field>
                    <Field label={t("guardrailWizard.purposeOutOfScope")} hint={t("guardrailWizard.purposeOutOfScopeHint")}>
                      <Textarea className="min-h-24 bg-card" value={purposeOutOfScope} onChange={(event) => setPurposeOutOfScope(event.target.value)} placeholder={t("guardrailWizard.purposeOutOfScopePlaceholder")} />
                    </Field>
                  </div>
              </details>
              <InfoNotice title={t("guardrailWizard.draftOnlyTitle")}>{t("guardrailWizard.draftOnlyDescription")}</InfoNotice>
            </div>
          </WizardSection>
        ) : null}

        {step === 1 && policyWorkspace === "main" ? (
          <WizardSection title={t("guardrailWizard.policiesTitle")} description={t("guardrailWizard.policiesDescription")}>
            <div className="space-y-6">
              <section className="rounded-xl border bg-muted/15 p-4">
                <header className="mb-4">
                  <h4 className="text-sm font-semibold">{t("guardrailWizard.policyAssistantTitle")}</h4>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("guardrailWizard.policyAssistantDescription")}</p>
                </header>
                <div className="grid gap-3 sm:grid-cols-2">
                  <PolicyChoiceCard
                    icon={<MessageSquareText />}
                    title={t("guardrailWizard.generateFromIntent")}
                    description={t("guardrailWizard.generateFromIntentDescription")}
                    disabled={!intentStatusQuery.data?.available}
                    onClick={() => setPolicyWorkspace("intent")}
                  />
                  <PolicyChoiceCard
                    icon={<FileText />}
                    title={t("guardrailWizard.generateFromDocuments")}
                    description={t("guardrailWizard.generateFromDocumentsDescription")}
                    disabled={!intentStatusQuery.data?.document_analysis_available}
                    onClick={() => setPolicyWorkspace("documents")}
                  />
                </div>
                {!intentStatusQuery.isLoading && !intentStatusQuery.data?.available ? (
                  <p className="mt-3 text-xs leading-5 text-muted-foreground">{t("guardrailWizard.policyAssistantUnavailable")}</p>
                ) : null}
              </section>

              {showBoundaries || boundarySource || allowed.trim() || restricted.trim() ? (
                <TopicBoundaryEditor
                  allowed={allowed}
                  restricted={restricted}
                  source={boundarySource}
                  onAllowedChange={setAllowed}
                  onRestrictedChange={setRestricted}
                />
              ) : <Button variant="outline" onClick={() => setShowBoundaries(true)}>{t("guardrailWizard.addBoundaries")}</Button>}

              {policiesQuery.isLoading ? <Skeleton className="h-80 rounded-xl" /> : policiesQuery.error ? <ErrorNotice error={policiesQuery.error} /> : (
                <PolicyBindingEditor policies={policies} value={bindings} onChange={setBindings} />
              )}

              <section className="space-y-4 rounded-xl border bg-card p-4">
                <header className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h4 className="text-sm font-semibold">Custom phrase rules</h4>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      Add deterministic input rules for exact phrases. `Transform` replaces the matched phrase; `Block` rejects the request when the phrase appears.
                    </p>
                  </div>
                  <Button variant="outline" onClick={() => setCustomRules((current) => [...current, blankCustomRuleRow(current.length + 1)])}>
                    Add rule
                  </Button>
                </header>
                <div className="space-y-3">
                  {customRules.map((rule, index) => (
                    <div key={rule.id} className="grid gap-3 rounded-lg border bg-muted/15 p-3 sm:grid-cols-[minmax(0,1.2fr)_140px_minmax(0,1fr)_auto]">
                      <Field label="Match phrase">
                        <Input
                          className="min-h-11 bg-card"
                          value={rule.phrase}
                          onChange={(event) => setCustomRules((current) => replaceCustomRule(current, index, { ...rule, phrase: event.target.value }))}
                          placeholder="mama"
                        />
                      </Field>
                      <Field label="Action">
                        <Select value={rule.mode} onValueChange={(value) => setCustomRules((current) => replaceCustomRule(current, index, { ...rule, mode: value as "transform" | "block" }))}>
                          <SelectTrigger className="min-h-11 bg-card">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="transform">Transform</SelectItem>
                            <SelectItem value="block">Block</SelectItem>
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field label="Replacement">
                        <Input
                          className="min-h-11 bg-card"
                          disabled={rule.mode !== "transform"}
                          value={rule.replacement}
                          onChange={(event) => setCustomRules((current) => replaceCustomRule(current, index, { ...rule, replacement: event.target.value }))}
                          placeholder={rule.mode === "transform" ? "niulai" : "Not used for block"}
                        />
                      </Field>
                      <div className="flex items-end">
                        <Button variant="ghost" onClick={() => setCustomRules((current) => current.filter((_, itemIndex) => itemIndex !== index))}>
                          Remove
                        </Button>
                      </div>
                    </div>
                  ))}
                  {!customRules.length ? (
                    <div className="rounded-lg border border-dashed bg-muted/20 px-4 py-3">
                      <p className="text-sm font-medium">No custom phrase rules yet.</p>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">Add exact phrase rules here if you want transform or block behavior from the first draft.</p>
                    </div>
                  ) : null}
                </div>
              </section>

              {fullBufferedMismatch ? <InfoNotice title={t("guardrailWizard.fullBufferedRequiredTitle")}>{t("guardrailWizard.fullBufferedRequiredDescription")}</InfoNotice> : null}
              {hasOutputPolicy ? <OutputDeliveryField value={outputDelivery} onChange={setOutputDelivery} /> : null}
            </div>
          </WizardSection>
        ) : null}

        {step === 1 && policyWorkspace === "intent" ? (
          <IntentPolicyWorkspace
            available={Boolean(intentStatusQuery.data?.available)}
            intent={intentText}
            proposal={intentProposal}
            pending={analyzeIntent.isPending}
            error={analyzeIntent.error}
            onIntentChange={(value) => {
              setIntentText(value);
              setIntentProposal(null);
              analyzeIntent.reset();
            }}
            onAnalyze={() => analyzeIntent.mutate()}
            onApply={applyIntentProposal}
          />
        ) : null}

        {step === 1 && policyWorkspace === "documents" ? (
          <ComplianceDocumentImport
            available={Boolean(intentStatusQuery.data?.document_analysis_available)}
            analystProvider={intentStatusQuery.data?.provider}
            analystModel={intentStatusQuery.data?.model}
            language={language}
            policies={policies}
            resetKey={documentImportReset}
            onApply={applyDocumentAnalysis}
          />
        ) : null}

        {step === 2 ? (
          <WizardSection title={t("guardrailWizard.reviewTitle")} description={t("guardrailWizard.reviewDescription")}>
            <InfoNotice title={t("guardrailWizard.reviewDraftTitle")}>{t("guardrailWizard.reviewDraftDescription")}</InfoNotice>
            <section className="mt-4 overflow-hidden rounded-xl border bg-card">
              <ReviewRow label={t("guardrailWizard.name")} value={name} />
              <ReviewRow label={t("guardrailWizard.descriptionLabel")} value={description || t("guardrailWizard.notProvided")} />
              <ReviewRow label={t("guardrailWizard.purposeAudience")} value={purposeAudience} />
              <ReviewRow label={t("guardrailWizard.purposeTasks")} value={purposeTasks} />
              <ReviewRow label={t("guardrailWizard.purposeProtect")} value={purposeProtect} />
              <ReviewRow label={t("guardrailWizard.purposeOutOfScope")} value={purposeOutOfScope} />
              {customRules.length ? <ReviewRow label="Custom phrase rules" value={customRules.map((rule) => rule.mode === "transform" ? `${rule.phrase} → ${rule.replacement || "[REDACTED]"}` : `${rule.phrase} → block`).join(", ")} /> : null}
              <ReviewRow label={t("guardrailWizard.policies")} value={bindings.map((binding) => policies.find((policy) => policy.id === binding.policy_id)?.name ?? binding.policy_id).join(", ")} />
              <ReviewRow label={t("guardrailWizard.policyRules")} value={String(bindings.reduce((total, binding) => total + binding.enabled_rule_ids.length, 0))} />
              {boundarySource || allowed.trim() || restricted.trim() ? <ReviewRow label={t("guardrailWizard.topicControl")} value={t("guardrailWizard.topicControlSummary", { allowed: lines(allowed).length, restricted: lines(restricted).length })} /> : null}
              {hasOutputPolicy ? <ReviewRow label={t("guardrailWizard.outputDelivery")} value={t(`guardrailWizard.outputDeliveryOptions.${outputDelivery}`)} /> : null}
            </section>

            {preview.isPending ? <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />{t("guardrailWizard.validatingPlan")}</div> : null}
            {preview.error ? <div className="mt-4"><ErrorNotice error={preview.error} /></div> : null}
            {preview.data ? (
              <details className="mt-4 overflow-hidden rounded-xl border bg-card">
                <summary className="min-h-11 cursor-pointer list-none px-4 py-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                  {t("guardrailWizard.advancedRuntimePreview")}
                </summary>
                <div className="border-t">
                  <ReviewRow label={t("guardrailWizard.runtimeProfile")} value={`${preview.data.engine} · Colang ${preview.data.colang_version}`} mono />
                  <ReviewRow label={t("guardrailWizard.planIdentity")} value={preview.data.checksum} mono />
                  <div className="flex flex-wrap gap-2 p-4">
                    <Badge variant="outline"><Braces />{preview.data.rails.length} Rails</Badge>
                    <Badge variant="outline">{preview.data.actions.length} Actions</Badge>
                    <Badge variant="outline">{preview.data.estimated_critical_path_ms} ms</Badge>
                    <Badge variant="outline"><Check />{t("guardrailWizard.planReady")}</Badge>
                  </div>
                </div>
              </details>
            ) : null}
          </WizardSection>
        ) : null}
      </CreationFlow>
    </EntitySheet>
  );
}

function IntentPolicyWorkspace({
  available,
  intent,
  proposal,
  pending,
  error,
  onIntentChange,
  onAnalyze,
  onApply,
}: {
  available: boolean;
  intent: string;
  proposal: IntentAnalysis | null;
  pending: boolean;
  error: unknown;
  onIntentChange: (value: string) => void;
  onAnalyze: () => void;
  onApply: () => void;
}) {
  const { t } = useTranslation();
  return (
    <WizardSection title={t("guardrailWizard.intentWorkspaceTitle")} description={t("guardrailWizard.intentWorkspaceDescription")}>
      <div className="space-y-4">
        {!available ? <InfoNotice title={t("guardrailWizard.intentUnavailable")}>{t("guardrailWizard.intentUnavailableDescription")}</InfoNotice> : null}
        <Field label={t("guardrailWizard.intentInputLabel")} hint={t("guardrailWizard.intentInputHint")}>
          <Textarea
            autoFocus
            className="min-h-40 bg-card"
            disabled={!available || pending}
            value={intent}
            onChange={(event) => onIntentChange(event.target.value)}
            placeholder={t("guardrailWizard.intentInputPlaceholder")}
          />
        </Field>
        {error ? <ErrorNotice error={error} /> : null}
        {!proposal ? (
          <div className="flex justify-end">
            <Button disabled={!available || intent.trim().length < 20 || pending} onClick={onAnalyze}>
              {pending ? <LoaderCircle className="animate-spin" /> : <Sparkles />}
              {t(pending ? "guardrailWizard.intentAnalyzing" : "guardrailWizard.intentAnalyze")}
            </Button>
          </div>
        ) : (
          <section className="overflow-hidden rounded-xl border bg-card" aria-live="polite">
            <header className="flex items-start justify-between gap-3 border-b bg-muted/20 p-4">
              <div>
                <h4 className="text-sm font-semibold">{t("guardrailWizard.intentProposalTitle")}</h4>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("guardrailWizard.intentProposalDescription")}</p>
              </div>
              <Badge variant="outline"><Sparkles />{t("guardrailWizard.aiProposal")}</Badge>
            </header>
            <div className="space-y-4 p-4">
              <p className="text-sm leading-6">{proposal.summary}</p>
              {proposal.structured_purpose ? <div className="rounded-lg border">
                <ReviewRow label={t("guardrailWizard.purposeAudience")} value={proposal.structured_purpose.audience} />
                <ReviewRow label={t("guardrailWizard.purposeTasks")} value={proposal.structured_purpose.tasks} />
                <ReviewRow label={t("guardrailWizard.purposeProtect")} value={proposal.structured_purpose.protect} />
                <ReviewRow label={t("guardrailWizard.purposeOutOfScope")} value={proposal.structured_purpose.out_of_scope} />
              </div> : null}
              <BoundaryPreview label={t("guardrailWizard.allowedDomains")} values={proposal.allowed_topics} />
              <BoundaryPreview label={t("guardrailWizard.restrictedDomains")} values={proposal.restricted_topics} />
              {proposal.review_notes.length ? <InfoNotice title={t("guardrailWizard.documentReviewNotes")}>{proposal.review_notes.join(" · ")}</InfoNotice> : null}
              <div className="flex flex-col gap-2 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs leading-5 text-muted-foreground">{t("guardrailWizard.intentApplyDescription")}</p>
                <Button onClick={onApply}><Check />{t("guardrailWizard.applyProposal")}</Button>
              </div>
            </div>
          </section>
        )}
      </div>
    </WizardSection>
  );
}

function TopicBoundaryEditor({
  allowed,
  restricted,
  source,
  onAllowedChange,
  onRestrictedChange,
}: {
  allowed: string;
  restricted: string;
  source: BoundarySource;
  onAllowedChange: (value: string) => void;
  onRestrictedChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="rounded-xl border bg-card p-4">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold">{t("guardrailWizard.topicControl")}</h4>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("guardrailWizard.topicControlDescription")}</p>
        </div>
        {source ? <Badge variant="secondary"><Sparkles />{t(`guardrailWizard.boundarySources.${source}`)}</Badge> : null}
      </header>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("guardrailWizard.allowedDomains")}><Textarea className="min-h-28 bg-card" value={allowed} onChange={(event) => onAllowedChange(event.target.value)} placeholder={t("guardrailWizard.onePerLine")} /></Field>
        <Field label={t("guardrailWizard.restrictedDomains")}><Textarea className="min-h-28 bg-card" value={restricted} onChange={(event) => onRestrictedChange(event.target.value)} placeholder={t("guardrailWizard.onePerLine")} /></Field>
      </div>
    </section>
  );
}

function OutputDeliveryField({ value, onChange }: { value: OutputDelivery; onChange: (value: OutputDelivery) => void }) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <section className="rounded-xl border bg-card p-4">
      <Label htmlFor={id}>{t("guardrailWizard.outputDelivery")}</Label>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("guardrailWizard.outputDeliveryConditionalDescription")}</p>
      <Select value={value} onValueChange={(next) => onChange(next as OutputDelivery)}>
        <SelectTrigger id={id} className="mt-3 min-h-11 bg-card"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="interruptible">{t("guardrailWizard.outputDeliveryOptions.interruptible")}</SelectItem>
          <SelectItem value="window_buffered">{t("guardrailWizard.outputDeliveryOptions.window_buffered")}</SelectItem>
          <SelectItem value="full_buffered">{t("guardrailWizard.outputDeliveryOptions.full_buffered")}</SelectItem>
        </SelectContent>
      </Select>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">{t(`guardrailWizard.outputDeliveryDescriptions.${value}`)}</p>
    </section>
  );
}

function PolicyChoiceCard({ icon, title, description, disabled, onClick }: { icon: ReactNode; title: string; description: string; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      className="group flex min-h-28 items-start gap-3 rounded-xl border bg-card p-4 text-left transition-colors hover:border-primary/50 hover:bg-primary/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      onClick={onClick}
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary [&_svg]:size-4">{icon}</span>
      <span className="min-w-0">
        <strong className="block text-sm font-semibold">{title}</strong>
        <span className="mt-1 block text-xs leading-5 text-muted-foreground">{description}</span>
      </span>
      <ArrowRight className="ml-auto mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}

function BoundaryPreview({ label, values }: { label: string; values: string[] }) {
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="mt-2 flex flex-wrap gap-2">{values.map((value) => <Badge key={value} variant="secondary">{value}</Badge>)}</div>
    </div>
  );
}

function recommendedTopicPolicy(policies: Policy[]) {
  const preferred = ["builtin-topic-safety", "builtin-company-policy"];
  for (const id of preferred) {
    const policy = policies.find((item) => item.id === id);
    if (policy && isBindablePolicy(policy)) return policy;
  }
  return undefined;
}

function isBindablePolicy(policy: Policy | undefined): policy is Policy {
  return Boolean(policy && (policy.source === "built_in" || policy.version !== "0"));
}

function getPolicyBindingsBlocker(bindings: GuardrailPolicyBinding[], policies: Policy[]) {
  if (!bindings.length) return { key: "guardrailWizard.nextBlocked.selectPolicy" };
  for (const binding of bindings) {
    const policy = policies.find((item) => item.id === binding.policy_id);
    if (!policy) return { key: "guardrailWizard.nextBlocked.policyUnavailable", values: { name: binding.policy_id } };
    const validation = getPolicyBindingValidation(binding, policy);
    if (validation.missingRules) return { key: "guardrailWizard.nextBlocked.enableRules", values: { name: policy.name } };
    if (validation.missingRequiredParameters.length) {
      return {
        key: "guardrailWizard.nextBlocked.requiredFields",
        values: {
          name: policy.name,
          fields: validation.missingRequiredParameters.map((parameter) => parameter.label ?? parameter.name).join(", "),
        },
      };
    }
    if (validation.missingReasoningPolicy) return { key: "guardrailWizard.nextBlocked.reasoningPolicy", values: { name: policy.name } };
  }
  return null;
}

function bindingsValid(bindings: GuardrailPolicyBinding[], policies: Policy[]) {
  return !getPolicyBindingsBlocker(bindings, policies);
}

function WizardSection({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <section><header className="mb-5"><h3 className="text-lg font-semibold">{title}</h3><p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p></header>{children}</section>;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="grid gap-2"><Label>{label}</Label>{children}{hint ? <span className="text-xs leading-5 text-muted-foreground">{hint}</span> : null}</label>;
}

function ReviewRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="grid gap-1 border-b p-4 last:border-b-0 sm:grid-cols-[12rem_minmax(0,1fr)]"><span className="text-xs text-muted-foreground">{label}</span><strong className={mono ? "break-all font-mono text-xs font-medium" : "text-sm font-medium"}>{value || "—"}</strong></div>;
}

function lines(value: string) { return value.split("\n").map((item) => item.trim()).filter(Boolean); }
function notifyError(error: unknown, fallback: string) { toast.error(error instanceof Error ? error.message : fallback); }

type CustomRuleRow = {
  id: string;
  phrase: string;
  mode: "transform" | "block";
  replacement: string;
};

function blankCustomRuleRow(index: number): CustomRuleRow {
  return {
    id: `custom-rule-${index}`,
    phrase: "",
    mode: "transform",
    replacement: "",
  };
}

function replaceCustomRule(rows: CustomRuleRow[], index: number, next: CustomRuleRow): CustomRuleRow[] {
  return rows.map((row, rowIndex) => rowIndex === index ? next : row);
}

function customRulesToDraft(rows: CustomRuleRow[]) {
  return rows
    .map((rule, index) => ({
      id: rule.id || `custom-rule-${index + 1}`,
      phases: ["input"] as Array<"input">,
      detector: "keyword" as const,
      keywords: [rule.phrase.trim()].filter(Boolean),
      action: rule.mode === "block" ? "reject" as const : "redact" as const,
      ...(rule.mode === "transform" && rule.replacement.trim() ? { replacement: rule.replacement.trim() } : {}),
    }))
    .filter((rule) => rule.keywords.length);
}
