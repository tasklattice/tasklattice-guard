import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Braces, Check, LoaderCircle, ShieldCheck, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { CreationFlow } from "@/components/creation-flow";
import { ComplianceDocumentImport } from "@/components/compliance-document-import";
import { EntitySheet } from "@/components/entity-sheet";
import { PolicyBindingEditor, defaultPolicyBinding } from "@/components/policy-binding-editor";
import { ErrorNotice, InfoNotice } from "@/components/product-shell";
import { RuntimePostureFields } from "@/components/runtime-posture-fields";
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
  type GuardrailPolicyBinding,
  type ComplianceDocumentAnalysis,
  type OutputDelivery,
  type Policy,
  type SafetyLevel,
} from "@/lib/api";

const EMPTY_POLICIES: Policy[] = [];
const BOUNDARY_POLICY_IDS = new Set(["builtin-topic-safety", "builtin-company-policy"]);
const FULL_BUFFERED_POLICY_IDS = new Set(["builtin-system-prompt-leakage", "builtin-automated-reasoning"]);
const CATEGORY_ORDER = ["dataProtection", "interactionSafety", "businessAssurance", "custom"] as const;

type PolicyCategoryKey = typeof CATEGORY_ORDER[number];

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
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [purposeAudience, setPurposeAudience] = useState("");
  const [purposeTasks, setPurposeTasks] = useState("");
  const [purposeProtect, setPurposeProtect] = useState("");
  const [purposeOutOfScope, setPurposeOutOfScope] = useState("");
  const [allowed, setAllowed] = useState("");
  const [restricted, setRestricted] = useState("");
  const [bindings, setBindings] = useState<GuardrailPolicyBinding[]>([]);
  const [safetyLevel, setSafetyLevel] = useState<SafetyLevel>("balanced");
  const [outputDelivery, setOutputDelivery] = useState<OutputDelivery>("window_buffered");
  const [customRules, setCustomRules] = useState<CustomRuleRow[]>([]);
  const [documentImportReset, setDocumentImportReset] = useState(0);
  const [showBoundaries, setShowBoundaries] = useState(false);

  const steps = [
    { label: t("guardrailWizard.steps.intent"), description: t("guardrailWizard.steps.intentDescription") },
    { label: t("guardrailWizard.steps.categories"), description: t("guardrailWizard.steps.categoriesDescription") },
    { label: t("guardrailWizard.steps.controls"), description: t("guardrailWizard.steps.controlsDescription") },
    { label: t("guardrailWizard.steps.runtime"), description: t("guardrailWizard.steps.runtimeDescription") },
    { label: t("guardrailWizard.steps.review"), description: t("guardrailWizard.steps.reviewDescription") },
  ];

  useEffect(() => {
    if (!open) return;
    setStep(0);
    setName("");
    setPurpose("");
    setPurposeAudience("");
    setPurposeTasks("");
    setPurposeProtect("");
    setPurposeOutOfScope("");
    setAllowed("");
    setRestricted("");
    setBindings([]);
    setSafetyLevel("balanced");
    setOutputDelivery("window_buffered");
    setCustomRules([]);
    setDocumentImportReset((current) => current + 1);
    setShowBoundaries(false);
  }, [open]);

  const language = user?.preferred_language ?? (i18n.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en");
  const analyzeIntent = useMutation({
    mutationFn: () => analyzeGuardrailIntent({ purpose: purpose.trim(), language }),
    onSuccess: (analysis) => {
      setPurposeAudience(analysis.structured_purpose.audience);
      setPurposeTasks(analysis.structured_purpose.tasks);
      setPurposeProtect(analysis.structured_purpose.protect);
      setPurposeOutOfScope(analysis.structured_purpose.out_of_scope);
      setAllowed(analysis.allowed_topics.join("\n"));
      setRestricted(analysis.restricted_topics.join("\n"));
      toast.success(t("guardrailWizard.intentGenerated"));
    },
    onError: (error) => notifyError(error, t("guardrailWizard.operationFailed")),
  });

  const payload = useMemo(() => ({
    name: name.trim(),
    purpose: purpose.trim(),
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
    safety_level: safetyLevel,
    output_delivery: outputDelivery,
  }), [allowed, bindings, customRules, name, outputDelivery, purpose, purposeAudience, purposeOutOfScope, purposeProtect, purposeTasks, restricted, safetyLevel]);

  const preview = useMutation({ mutationFn: () => previewGuardrailCandidate(payload) });
  useEffect(() => {
    if (step === 4 && bindings.length && bindingsValid(bindings, policies)) preview.mutate();
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

  function applyDocumentAnalysis(analysis: ComplianceDocumentAnalysis) {
    setPurpose(analysis.summary);
    setAllowed(analysis.allowed_topics.join("\n"));
    setRestricted(analysis.restricted_topics.join("\n"));
    setBindings((current) => {
      const selected = new Set(current.map((binding) => binding.policy_id));
      const recommended = analysis.recommended_policy_ids
        .map((id) => policies.find((policy) => policy.id === id))
        .filter((policy): policy is Policy => Boolean(policy && (policy.source === "built_in" || policy.version !== "0")))
        .filter((policy) => !selected.has(policy.id))
        .map(defaultPolicyBinding);
      return [...current, ...recommended];
    });
    toast.success(t("guardrailWizard.documentAppliedMessage"));
  }

  const hasBoundaryPolicies = bindings.some((binding) => BOUNDARY_POLICY_IDS.has(binding.policy_id));
  const needsFullBuffered = bindings.some((binding) => FULL_BUFFERED_POLICY_IDS.has(binding.policy_id));
  const selectedPolicyNames = bindings.map((binding) => policies.find((policy) => policy.id === binding.policy_id)?.name ?? binding.policy_id);
  const boundaryLines = lines(allowed).length + lines(restricted).length;
  const boundariesUnused = Boolean(boundaryLines && !hasBoundaryPolicies);
  const fullBufferedMismatch = needsFullBuffered && outputDelivery !== "full_buffered";

  useEffect(() => {
    if (hasBoundaryPolicies || Boolean(boundaryLines)) setShowBoundaries(true);
  }, [boundaryLines, hasBoundaryPolicies]);

  const stepValid = [
    Boolean(name.trim() && purpose.trim()),
    Boolean(bindings.length),
    bindingsValid(bindings, policies),
    true,
    Boolean(preview.data && !preview.error),
  ];

  return (
    <EntitySheet
      open={open}
      onOpenChange={onOpenChange}
      eyebrow={t("guardrailWizard.eyebrow")}
      title={t("guardrailWizard.title")}
      description={t("guardrailWizard.description")}
      width="xl"
      bodyClassName="p-0 sm:p-0"
      footer={(
        <>
          <Button variant="outline" onClick={() => step ? setStep(step - 1) : onOpenChange(false)}>
            {step ? <><ArrowLeft />{t("common.previous")}</> : t("common.cancel")}
          </Button>
          {step < steps.length - 1 ? (
            <Button disabled={!stepValid[step]} onClick={() => setStep(step + 1)}>{t("common.next")}<ArrowRight /></Button>
          ) : (
            <Button disabled={!stepValid.every(Boolean) || create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? <LoaderCircle className="animate-spin" /> : <ShieldCheck />}{t(create.isPending ? "common.creating" : "guardrailWizard.create")}
            </Button>
          )}
        </>
      )}
    >
      <CreationFlow orientation="sidebar" currentStep={step} onStepChange={setStep} progressLabel={t("guardrailWizard.title")} steps={steps}>
        {step === 0 ? (
          <WizardSection title={t("guardrailWizard.intentTitle")} description={t("guardrailWizard.intentStepDescription")}>
            <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
              <div className="space-y-5">
                <Field label={`${t("guardrailWizard.name")} *`}>
                  <Input autoFocus className="min-h-11 bg-card" value={name} onChange={(event) => setName(event.target.value)} placeholder={t("guardrailWizard.namePlaceholder")} />
                </Field>
                <section className="space-y-4 rounded-xl border bg-card p-4">
                  <header>
                    <h4 className="text-sm font-semibold">{t("guardrailWizard.purposePrimaryTitle")}</h4>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("guardrailWizard.purposePrimaryDescription")}</p>
                  </header>
                  <Field label={`${t("guardrailWizard.purpose")} *`} hint={t("guardrailWizard.purposeHint")}>
                    <Textarea
                      className="min-h-32 bg-card"
                      value={purpose}
                      onChange={(event) => setPurpose(event.target.value)}
                      placeholder={t("guardrailWizard.purposePlaceholder")}
                    />
                  </Field>
                  <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-muted/15 p-4">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{t("guardrailWizard.structurePurposeTitle")}</p>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("guardrailWizard.structurePurposeDescription")}</p>
                    </div>
                    <Button variant="outline" disabled={purpose.trim().length < 20 || !intentStatusQuery.data?.available || analyzeIntent.isPending} onClick={() => analyzeIntent.mutate()}>
                      {analyzeIntent.isPending ? <LoaderCircle className="animate-spin" /> : <Sparkles />}
                      {t("guardrailWizard.structurePurpose")}
                    </Button>
                  </div>
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
                  <InfoNotice title={t("guardrailWizard.purposeStructuredTitle")}>{t("guardrailWizard.purposeStructuredDescription")}</InfoNotice>
                </section>

                <section className="space-y-4 rounded-xl border bg-muted/15 p-4">
                  <header>
                    <h4 className="text-sm font-semibold">{t("guardrailWizard.assistTitle")}</h4>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("guardrailWizard.assistDescription")}</p>
                  </header>
                  <ComplianceDocumentImport
                    available={Boolean(intentStatusQuery.data?.document_analysis_available)}
                    analystProvider={intentStatusQuery.data?.provider}
                    analystModel={intentStatusQuery.data?.model}
                    language={language}
                    policies={policies}
                    resetKey={documentImportReset}
                    onApply={applyDocumentAnalysis}
                  />
                  <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card p-4">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{t("guardrailWizard.structureBoundaryTitle")}</p>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("guardrailWizard.structureBoundaryDescription")}</p>
                    </div>
                    <Badge variant="secondary">{t("guardrailWizard.boundariesFromPurpose")}</Badge>
                  </div>
                  {!intentStatusQuery.isLoading && !intentStatusQuery.data?.available ? <InfoNotice title={t("guardrailWizard.intentUnavailable")}>{t("guardrailWizard.intentUnavailableDescription")}</InfoNotice> : null}
                </section>
              </div>

              <section className="space-y-4 rounded-xl border bg-card p-4">
                <header className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h4 className="text-sm font-semibold">{t("guardrailWizard.boundariesTitle")}</h4>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("guardrailWizard.boundariesDescription")}</p>
                  </div>
                  {!showBoundaries ? (
                    <Button variant="outline" onClick={() => setShowBoundaries(true)}>{t("guardrailWizard.addBoundaries")}</Button>
                  ) : null}
                </header>
                {showBoundaries ? (
                  <>
                    {hasBoundaryPolicies ? (
                      <InfoNotice title={t("guardrailWizard.boundariesActiveTitle")}>{t("guardrailWizard.boundariesActiveDescription")}</InfoNotice>
                    ) : (
                      <InfoNotice title={t("guardrailWizard.boundariesInactiveTitle")}>{t("guardrailWizard.boundariesInactiveDescription")}</InfoNotice>
                    )}
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label={t("guardrailWizard.allowedDomains")} hint={t("guardrailWizard.boundariesHint")}>
                        <Textarea className="min-h-28 bg-card" value={allowed} onChange={(event) => setAllowed(event.target.value)} placeholder={t("guardrailWizard.onePerLine")} />
                      </Field>
                      <Field label={t("guardrailWizard.restrictedDomains")} hint={t("guardrailWizard.boundariesHint")}>
                        <Textarea className="min-h-28 bg-card" value={restricted} onChange={(event) => setRestricted(event.target.value)} placeholder={t("guardrailWizard.onePerLine")} />
                      </Field>
                    </div>
                  </>
                ) : (
                  <div className="rounded-lg border border-dashed bg-muted/20 px-4 py-3">
                    <p className="text-sm font-medium">{t("guardrailWizard.boundariesCollapsedTitle")}</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("guardrailWizard.boundariesCollapsedDescription")}</p>
                  </div>
                )}
              </section>

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
            </div>
          </WizardSection>
        ) : null}

        {step === 1 ? (
          <WizardSection title={t("guardrailWizard.categoriesTitle")} description={t("guardrailWizard.categoriesDescription")}>
            {policiesQuery.isLoading ? <Skeleton className="h-80 rounded-xl" /> : policiesQuery.error ? <ErrorNotice error={policiesQuery.error} /> : (
              <PolicyCategoryPicker policies={policies} value={bindings} onChange={setBindings} />
            )}
          </WizardSection>
        ) : null}

        {step === 2 ? (
          <WizardSection title={t("guardrailWizard.controlsTitle")} description={t("guardrailWizard.controlsDescription")}>
            <div className="space-y-4">
              {boundariesUnused ? <InfoNotice title={t("guardrailWizard.boundariesInactiveTitle")}>{t("guardrailWizard.boundariesInactiveDescription")}</InfoNotice> : null}
              {bindings.length ? (
                <PolicyBindingEditor policies={policies} value={bindings} onChange={setBindings} showSelector={false} />
              ) : (
                <div className="rounded-lg border border-dashed bg-muted/20 px-4 py-3">
                  <p className="text-sm font-medium">{t("guardrailWizard.noPolicies")}</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("guardrailWizard.noPoliciesDescription")}</p>
                </div>
              )}
            </div>
          </WizardSection>
        ) : null}

        {step === 3 ? (
          <WizardSection title={t("guardrailWizard.runtimeTitle")} description={t("guardrailWizard.runtimeDescription")}>
            <div className="space-y-4">
              <RuntimePostureFields
                safetyLevel={safetyLevel}
                outputDelivery={outputDelivery}
                onSafetyLevelChange={setSafetyLevel}
                onOutputDeliveryChange={setOutputDelivery}
              />
              {fullBufferedMismatch ? <InfoNotice title={t("guardrailWizard.fullBufferedRequiredTitle")}>{t("guardrailWizard.fullBufferedRequiredDescription")}</InfoNotice> : null}
              {boundariesUnused ? <InfoNotice title={t("guardrailWizard.boundariesInactiveTitle")}>{t("guardrailWizard.boundariesInactiveDescription")}</InfoNotice> : null}
              <InfoNotice title={t("guardrailWizard.deploymentSeparateTitle")}>{t("guardrailWizard.deploymentSeparate")}</InfoNotice>
            </div>
          </WizardSection>
        ) : null}

        {step === 4 ? (
          <WizardSection title={t("guardrailWizard.reviewTitle")} description={t("guardrailWizard.reviewDescription")}>
            <div className="space-y-4">
              {boundariesUnused ? <InfoNotice title={t("guardrailWizard.boundariesInactiveTitle")}>{t("guardrailWizard.boundariesInactiveDescription")}</InfoNotice> : null}
              {fullBufferedMismatch ? <InfoNotice title={t("guardrailWizard.fullBufferedRequiredTitle")}>{t("guardrailWizard.fullBufferedRequiredDescription")}</InfoNotice> : null}
              <div className="grid gap-4 xl:grid-cols-2">
                <ReviewSection
                  title={t("guardrailWizard.reviewIntentTitle")}
                  items={[
                    { label: t("guardrailWizard.name"), value: name },
                    { label: t("guardrailWizard.purpose"), value: purpose },
                    { label: t("guardrailWizard.purposeAudience"), value: purposeAudience || "—" },
                    { label: t("guardrailWizard.purposeTasks"), value: purposeTasks || "—" },
                    { label: t("guardrailWizard.purposeProtect"), value: purposeProtect || "—" },
                    { label: t("guardrailWizard.purposeOutOfScope"), value: purposeOutOfScope || "—" },
                    { label: t("guardrailWizard.allowedDomains"), value: lines(allowed).join(", ") || "—" },
                    { label: t("guardrailWizard.restrictedDomains"), value: lines(restricted).join(", ") || "—" },
                  ]}
                />
                <ReviewSection
                  title={t("guardrailWizard.reviewControlsTitle")}
                  items={[
                    { label: t("guardrailWizard.policies"), value: selectedPolicyNames.join(", ") || "—" },
                    { label: t("guardrailWizard.selectedPolicyCount"), value: String(bindings.length) },
                    { label: t("guardrailWizard.policyRules"), value: String(bindings.reduce((total, binding) => total + binding.enabled_rule_ids.length, 0)) },
                    { label: "Custom phrase rules", value: customRules.length ? customRules.map((rule) => rule.mode === "transform" ? `${rule.phrase} -> ${rule.replacement || "[REDACTED]"}` : `${rule.phrase} -> block`).join(", ") : "—" },
                  ]}
                />
                <ReviewSection
                  title={t("guardrailWizard.reviewRuntimeTitle")}
                  items={[
                    { label: t("guardrailWizard.safetyLevel"), value: t(`guardrailWizard.safetyLevelOptions.${safetyLevel}`) },
                    { label: t("guardrailWizard.outputDelivery"), value: t(`guardrailWizard.outputDeliveryOptions.${outputDelivery}`) },
                  ]}
                />
                <ReviewSection
                  title={t("guardrailWizard.reviewAdvancedTitle")}
                  items={[
                    { label: t("guardrailWizard.runtimeProfile"), value: preview.data ? `${preview.data.engine} · Colang ${preview.data.colang_version}` : t("guardrailWizard.validatingPlan") },
                    { label: t("guardrailWizard.planIdentity"), value: preview.data?.checksum ?? "—", mono: true },
                  ]}
                />
              </div>
              {preview.isPending ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />{t("guardrailWizard.validatingPlan")}</div> : null}
              {preview.error ? <div><ErrorNotice error={preview.error} /></div> : null}
              {preview.data ? <div className="flex flex-wrap gap-2"><Badge variant="outline"><Braces />{preview.data.rails.length} Rails</Badge><Badge variant="outline">{preview.data.actions.length} Actions</Badge><Badge variant="outline">{preview.data.estimated_critical_path_ms} ms</Badge><Badge variant="outline"><Check />{t("guardrailWizard.planReady")}</Badge></div> : null}
            </div>
          </WizardSection>
        ) : null}
      </CreationFlow>
    </EntitySheet>
  );
}

function bindingsValid(bindings: GuardrailPolicyBinding[], policies: Policy[]) {
  if (!bindings.length) return false;
  return bindings.every((binding) => {
    const policy = policies.find((item) => item.id === binding.policy_id);
    if (!policy || !binding.enabled_rule_ids.length) return false;
    if (policy.parameters.some((parameter) => parameter.required && !(binding.parameter_values[parameter.name] ?? parameter.default ?? "").trim())) return false;
    if (binding.policy_id === "builtin-automated-reasoning") return Boolean(binding.reasoning_policy?.policy_id.trim() && binding.reasoning_policy.policy_version.trim());
    return true;
  });
}

function WizardSection({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <section><header className="mb-5"><h3 className="text-lg font-semibold">{title}</h3><p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p></header>{children}</section>;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="grid gap-2"><Label>{label}</Label>{children}{hint ? <span className="text-xs leading-5 text-muted-foreground">{hint}</span> : null}</label>;
}

function ReviewSection({ title, items }: { title: string; items: Array<{ label: string; value: string; mono?: boolean }> }) {
  return (
    <section className="overflow-hidden rounded-xl border bg-card">
      <header className="border-b bg-muted/20 px-4 py-3">
        <h4 className="text-sm font-semibold">{title}</h4>
      </header>
      {items.map((item) => (
        <div key={`${title}-${item.label}`} className="grid gap-1 border-b p-4 last:border-b-0 sm:grid-cols-[12rem_minmax(0,1fr)]">
          <span className="text-xs text-muted-foreground">{item.label}</span>
          <strong className={item.mono ? "break-all font-mono text-xs font-medium" : "text-sm font-medium"}>{item.value || "—"}</strong>
        </div>
      ))}
    </section>
  );
}

function lines(value: string) { return value.split("\n").map((item) => item.trim()).filter(Boolean); }
function notifyError(error: unknown, fallback: string) { toast.error(error instanceof Error ? error.message : fallback); }

function PolicyCategoryPicker({
  policies,
  value,
  onChange,
}: {
  policies: Policy[];
  value: GuardrailPolicyBinding[];
  onChange: (next: GuardrailPolicyBinding[]) => void;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const selectedIds = new Set(value.map((binding) => binding.policy_id));
  const groups = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = policies.filter((policy) => {
      if (!query) return true;
      const haystack = [
        policy.id,
        policy.name,
        policy.description,
        ...policy.tags.map((tag) => tag.label),
        ...policy.rules.map((rule) => rule.name),
      ].join(" ").toLowerCase();
      return haystack.includes(query);
    });
    return CATEGORY_ORDER.map((category) => ({
      category,
      items: filtered.filter((policy) => classifyPolicy(policy) === category),
    })).filter((group) => group.items.length);
  }, [policies, search]);

  function togglePolicy(policy: Policy) {
    const bindable = policy.source === "built_in" || policy.version !== "0";
    if (!bindable) return;
    const selected = selectedIds.has(policy.id);
    if (selected) {
      onChange(value.filter((binding) => binding.policy_id !== policy.id));
      return;
    }
    onChange([...value, defaultPolicyBinding(policy)]);
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-2">
        <Field label={t("guardrailWizard.searchPolicies")}>
          <Input className="min-h-11 bg-card" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("guardrailWizard.searchPolicies")} />
        </Field>
        <p className="text-xs leading-5 text-muted-foreground">{t("guardrailWizard.categoriesHint", { count: value.length })}</p>
      </div>

      {groups.length ? groups.map((group) => (
        <section key={group.category} className="space-y-3">
          <header>
            <h4 className="text-sm font-semibold">{t(`guardrailWizard.policyCategories.${group.category}.title`)}</h4>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{t(`guardrailWizard.policyCategories.${group.category}.description`)}</p>
          </header>
          <div className="grid gap-3 xl:grid-cols-2">
            {group.items.map((policy) => {
              const bindable = policy.source === "built_in" || policy.version !== "0";
              const selected = selectedIds.has(policy.id);
              return (
                <button
                  key={policy.id}
                  type="button"
                  disabled={!bindable}
                  aria-pressed={selected}
                  onClick={() => togglePolicy(policy)}
                  className={[
                    "rounded-xl border bg-card p-4 text-left transition",
                    selected ? "border-primary ring-1 ring-primary/25" : "hover:border-primary/40",
                    !bindable ? "cursor-not-allowed opacity-60" : "",
                  ].join(" ")}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <strong className="block text-sm">{policy.name}</strong>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">{policy.description}</p>
                    </div>
                    <Badge variant={selected ? "default" : "outline"}>{t(selected ? "guardrailWizard.selected" : "guardrailWizard.available")}</Badge>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Badge variant="outline" className="font-mono text-[11px]">v{policy.version}</Badge>
                    <Badge variant="outline">{t("policyLibrary.ruleCount", { count: policy.rules.length })}</Badge>
                    <Badge variant="outline">{policy.stages.join(" / ")}</Badge>
                    {!bindable ? <Badge variant="outline">{t("guardrailWizard.publishPolicyFirst")}</Badge> : null}
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      )) : (
        <div className="rounded-lg border border-dashed bg-muted/20 px-4 py-3">
          <p className="text-sm font-medium">{t("guardrailWizard.noMatchingPolicies")}</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("guardrailWizard.noMatchingPoliciesDescription")}</p>
        </div>
      )}
    </div>
  );
}

function classifyPolicy(policy: Policy): PolicyCategoryKey {
  if (policy.source === "custom") return "custom";
  if (["builtin-secrets", "builtin-pii", "builtin-system-prompt-leakage"].includes(policy.id)) return "dataProtection";
  if (["builtin-prompt-injection", "builtin-indirect-prompt-injection", "builtin-jailbreak", "builtin-content-safety"].includes(policy.id)) return "interactionSafety";
  if (["builtin-topic-safety", "builtin-company-policy", "builtin-contextual-grounding", "builtin-automated-reasoning"].includes(policy.id)) return "businessAssurance";
  const id = policy.id.toLowerCase();
  if (id.includes("secret") || id.includes("pii") || id.includes("prompt-leak")) return "dataProtection";
  if (id.includes("prompt") || id.includes("jailbreak") || id.includes("content")) return "interactionSafety";
  if (id.includes("topic") || id.includes("policy") || id.includes("grounding") || id.includes("reasoning")) return "businessAssurance";
  return "custom";
}

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
