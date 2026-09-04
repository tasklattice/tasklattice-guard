import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  Braces,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  FileCode2,
  FlaskConical,
  GitBranch,
  LoaderCircle,
  LockKeyhole,
  Network,
  PackageCheck,
  Plus,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { CreationFlow } from "@/components/creation-flow";
import { EntitySheet } from "@/components/entity-sheet";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { queryKeys } from "@/features/query-keys";
import { useAuth } from "@/lib/auth";
import { compilerLocation } from "@/lib/compiler-location";
import type { PolicyImport } from "@/lib/policy-transfer";
import {
  createProgrammablePolicy,
  enforcementActions,
  getActionCatalog,
  publishProgrammablePolicy,
  runProgrammablePolicyValidation,
  updateProgrammablePolicy,
  validateProgrammablePolicy,
  type ActionDefinition,
  type PolicyActionReference,
  type PolicyDraftParameter,
  type PolicyRailBinding,
  type PolicyDraftTestCase,
  type PolicyDraftValidationRun,
  type ProgrammablePolicy,
  type ProgrammablePolicyDraft,
  type NativeRailType,
  type PolicyRailType,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { defaultGuardrailCategory, guardrailCategoryIds, type GuardrailCategoryId } from "../../shared/guardrail-catalog";

const RAILS: PolicyRailType[] = ["input", "output"];
const DEFAULT_COLANG = `flow check_request $text
  # A Policy Flow can invoke one or more registered Actions.
  $result = await GuardCustomerIdentifierAction(text=$text)
  if $result["detected"]
    $recorded = await GuardRecordPolicyAction(flow_name="check_request", safe=False, text=$text, replacement=$result["redacted"])
  else
    $recorded = await GuardRecordPolicyAction(flow_name="check_request", safe=True, text=$text)
`;

export function PolicyStudioSheet({ policy, imported = null, open, onOpenChange, onSaved }: { policy: ProgrammablePolicy | null | undefined; imported?: PolicyImport | null; open: boolean; onOpenChange: (open: boolean) => void; onSaved: (id: string) => Promise<void> }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const actionsQuery = useQuery({ queryKey: queryKeys.actionCatalog, queryFn: getActionCatalog, enabled: open });
  const actions = actionsQuery.data?.items ?? [];
  const [step, setStep] = useState(0);
  const [policyId, setPolicyId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [owner, setOwner] = useState("");
  const [draft, setDraft] = useState<ProgrammablePolicyDraft>(emptyDraft());
  const [compileError, setCompileError] = useState<string | null>(null);
  const [validatedRevision, setValidatedRevision] = useState<number | null>(null);
  const [validationRun, setTestRun] = useState<PolicyDraftValidationRun | null>(null);

  useEffect(() => {
    if (!open) return;
    setStep(0);
    setPolicyId(policy?.id ?? null);
    setName(policy?.name ?? imported?.name ?? "");
    setDescription(policy?.description ?? imported?.description ?? "");
    setOwner(policy?.owner ?? imported?.owner ?? user?.email ?? "security-platform");
    setDraft(policy ? cloneDraft(policy.draft) : imported ? cloneDraft(imported.draft) : emptyDraft());
    setCompileError(null);
    setValidatedRevision(null);
    setTestRun(null);
  }, [policy, imported, open, user?.email]);

  function invalidateRelease() {
    setCompileError(null);
    setValidatedRevision(null);
    setTestRun(null);
  }

  function changeDraft(next: ProgrammablePolicyDraft) {
    invalidateRelease();
    setDraft(next);
  }

  async function persistDraft() {
    const payload = { name: name.trim(), description: description.trim(), owner: owner.trim(), draft };
    const saved = policyId
      ? await updateProgrammablePolicy(policyId, payload)
      : await createProgrammablePolicy(payload);
    setPolicyId(saved.id);
    return saved;
  }

  const testMutation = useMutation({
    mutationFn: async () => {
      const saved = await persistDraft();
      await validateProgrammablePolicy(saved.id);
      return runProgrammablePolicyValidation(saved.id);
    },
    onSuccess: (result) => {
      setCompileError(null);
      setTestRun(result);
      setValidatedRevision(result.draft_revision ?? null);
      if (result.status === "passed") {
        toast.success(t("policyStudio.validationPassed"));
      } else toast.error(t("policyStudio.validationFailed"));
    },
    onError: (error) => {
      const message = errorMessage(error, t("policyStudio.validationFailed"));
      setCompileError(message);
      toast.error(message);
    },
  });
  const publishMutation = useMutation({
    mutationFn: async () => {
      if (!policyId) throw new Error(t("policyStudio.saveFirst"));
      return publishProgrammablePolicy(policyId);
    },
    onSuccess: async (version) => {
      toast.success(t("policyStudio.published", { version: version.version }));
      await onSaved(version.policy_id);
    },
    onError: (error) => toast.error(errorMessage(error, t("policyStudio.publishFailed"))),
  });

  const steps = (["author", "runtime", "release"] as const).map((key) => ({ label: t(`policyStudio.steps.${key}`), description: t(`policyStudio.stepDescriptions.${key}`) }));
  const canContinue = [
    Boolean(name.trim() && description.trim() && owner.trim() && draft.sources.length > 0 && draft.sources.every((source) => source.path.trim() && source.content.trim())),
    draft.rail_bindings.length > 0 && draft.rail_bindings.every(railReady) && draft.parameter_schema.every(parameterReady),
    draft.test_cases.length > 0 && draft.test_cases.every((test) => testReady(test, draft.rail_bindings)) && allRulesCovered(draft.rail_bindings, draft.test_cases),
  ];
  const currentRevisionPassed = validationRun?.status === "passed" && validationRun.draft_revision === validatedRevision;
  const busy = testMutation.isPending || publishMutation.isPending;

  return (
    <EntitySheet
      open={open}
      onOpenChange={onOpenChange}
      eyebrow={t("policyStudio.builderEyebrow")}
      title={policy ? t("policyStudio.editTitle", { name: policy.name }) : imported ? t("policyStudio.importTitle") : t("policyStudio.createTitle")}
      description={imported ? t("policyStudio.importDescription") : t("policyStudio.createDescription")}
      width="xl"
      bodyClassName="p-0 sm:p-0"
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={() => step ? setStep(step - 1) : onOpenChange(false)}>{step ? <><ArrowLeft />{t("common.previous")}</> : t("common.cancel")}</Button>
          {step < 2 ? <Button disabled={!canContinue[step] || busy} onClick={() => setStep(step + 1)}>{t("common.next")}<ArrowRight /></Button> : null}
          {step === 2 && !currentRevisionPassed ? <Button disabled={!canContinue.every(Boolean) || busy} onClick={() => testMutation.mutate()}>{testMutation.isPending ? <LoaderCircle className="animate-spin" /> : <PackageCheck />}{t("policyStudio.validateAndRun")}</Button> : null}
          {step === 2 && currentRevisionPassed ? <Button disabled={busy} onClick={() => publishMutation.mutate()}>{publishMutation.isPending ? <LoaderCircle className="animate-spin" /> : <ShieldCheck />}{t("policyStudio.publish")}</Button> : null}
        </>
      }
    >
      <CreationFlow orientation="sidebar" currentStep={step} onStepChange={setStep} progressLabel={t("policyStudio.createTitle")} steps={steps}>
        {step === 0 ? <div className="space-y-8">
          {imported ? <Alert variant="info"><PackageCheck /><AlertTitle>{t("policyStudio.transferNoticeTitle")}</AlertTitle><AlertDescription>{t("policyStudio.transferNoticeDescription")}</AlertDescription></Alert> : null}
          <StudioSection title={t("policyStudio.definitionTitle")} description={t("policyStudio.definitionDescription")}><div className="grid gap-5"><Field label={`${t("policyStudio.name")} *`}><Input autoFocus className="min-h-11" value={name} onChange={(event) => { invalidateRelease(); setName(event.target.value); }} /></Field><Field label={`${t("policyStudio.guardrailCategory")} *`} hint={t("policyStudio.guardrailCategoryHint")}><Select value={draft.guardrail_category} onValueChange={(value) => changeDraft({ ...draft, guardrail_category: value as GuardrailCategoryId })}><SelectTrigger className="min-h-11"><SelectValue /></SelectTrigger><SelectContent>{guardrailCategoryIds.map((category) => <SelectItem key={category} value={category}>{t(`modelSettings.categories.${category}.title`)}</SelectItem>)}</SelectContent></Select></Field><Field label={`${t("policyStudio.description")} *`}><Textarea className="min-h-28" value={description} onChange={(event) => { invalidateRelease(); setDescription(event.target.value); }} /></Field><Field label={`${t("policyStudio.owner")} *`}><Input className="min-h-11" value={owner} onChange={(event) => { invalidateRelease(); setOwner(event.target.value); }} /></Field></div></StudioSection>
          <ColangEditor version={draft.colang_version} sources={draft.sources} error={compileError} onChange={(sources) => changeDraft({ ...draft, sources })} />
        </div> : null}
        {step === 1 ? <div className="space-y-8"><RailEditor rails={draft.rail_bindings} onChange={(rail_bindings) => changeDraft({ ...draft, rail_bindings })} /><ActionEditor actions={actions} selected={draft.action_references} onChange={(action_references) => changeDraft({ ...draft, action_references })} loading={actionsQuery.isLoading} /><ParameterEditor parameters={draft.parameter_schema} onChange={(parameter_schema) => changeDraft({ ...draft, parameter_schema })} /></div> : null}
        {step === 2 ? <div className="space-y-8"><ReleaseStatus run={validationRun} error={compileError} running={testMutation.isPending} /><TestEditor rails={draft.rail_bindings} testCases={draft.test_cases} run={validationRun} error={compileError} onChange={(test_cases) => changeDraft({ ...draft, test_cases })} />{currentRevisionPassed ? <PublishReview name={name} draft={draft} run={validationRun} /> : null}</div> : null}
      </CreationFlow>
    </EntitySheet>
  );
}

function RailEditor({ rails, onChange }: { rails: PolicyRailBinding[]; onChange: (rails: PolicyRailBinding[]) => void }) {
  const { t } = useTranslation();
  return <StudioSection title={t("policyStudio.railsTitle")} description={t("policyStudio.railsDescription")} action={<Button variant="outline" onClick={() => onChange([...rails, emptyRail(rails.length)])}><Plus />{t("policyStudio.addRail")}</Button>}><div className="space-y-4">{rails.map((rail, index) => <section key={index} className="rounded-lg border bg-card"><header className="flex items-center justify-between border-b bg-muted/20 px-4 py-3"><div className="flex items-center gap-2"><GitBranch className="size-4 text-primary" /><strong className="text-sm">{t("policyStudio.railBinding", { number: index + 1 })}</strong></div><Button size="icon" variant="ghost" aria-label={t("common.remove")} onClick={() => onChange(rails.filter((_, itemIndex) => itemIndex !== index))}><Trash2 /></Button></header><div className="grid gap-4 p-4 sm:grid-cols-2"><Field label={`${t("policyStudio.rail")} *`}><Select value={rail.rail_type} onValueChange={(value) => replaceAt(rails, index, { ...rail, rail_type: value as PolicyRailType }, onChange)}><SelectTrigger className="min-h-11"><SelectValue /></SelectTrigger><SelectContent>{RAILS.map((item) => <SelectItem key={item} value={item}>{t(`policyStudio.railNames.${item}`)}</SelectItem>)}</SelectContent></Select></Field><Field label={`${t("policyStudio.flowName")} *`}><Input className="min-h-11 font-mono text-xs" value={rail.flow_name} onChange={(event) => replaceAt(rails, index, { ...rail, flow_name: event.target.value }, onChange)} /></Field><Field label={t("policyStudio.executionMode")}><Select value={rail.execution_mode} onValueChange={(value) => replaceAt(rails, index, { ...rail, execution_mode: value as "detect" | "mutate" }, onChange)}><SelectTrigger className="min-h-11"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="detect">{t("policyStudio.detect")}</SelectItem><SelectItem value="mutate">{t("policyStudio.mutate")}</SelectItem></SelectContent></Select></Field><Field label={t("policyStudio.unsafeAction")}><Select value={rail.on_unsafe} onValueChange={(value) => replaceAt(rails, index, { ...rail, on_unsafe: value as PolicyRailBinding["on_unsafe"] }, onChange)}><SelectTrigger className="min-h-11"><SelectValue /></SelectTrigger><SelectContent>{enforcementActions.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent></Select></Field><details className="group rounded-md border bg-muted/10 sm:col-span-2"><summary className="flex min-h-11 cursor-pointer list-none items-center justify-between px-3 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"><span>{t("policyStudio.advancedRuntime")}</span><span className="text-muted-foreground group-open:hidden">{rail.timeout_ms}ms</span><ChevronRight className="size-4 text-muted-foreground transition-transform group-open:rotate-90" /></summary><div className="grid gap-4 border-t p-3 sm:grid-cols-2"><Field label={t("policyStudio.parallelGroup")} hint={t("policyStudio.parallelHint")}><Input className="min-h-11 font-mono text-xs" value={rail.parallel_group ?? ""} onChange={(event) => replaceAt(rails, index, { ...rail, parallel_group: event.target.value || null }, onChange)} /></Field><Field label={t("policyStudio.timeout")}><Input className="min-h-11" type="number" min={1} max={120000} value={rail.timeout_ms} onChange={(event) => replaceAt(rails, index, { ...rail, timeout_ms: Number(event.target.value) }, onChange)} /></Field></div></details></div></section>)}</div></StudioSection>;
}

function ColangEditor({ version, sources, error, onChange }: { version: ProgrammablePolicyDraft["colang_version"]; sources: ProgrammablePolicyDraft["sources"]; error: string | null; onChange: (sources: ProgrammablePolicyDraft["sources"]) => void }) {
  const { t } = useTranslation();
  const source = sources[0] ?? { path: "main.co", content: "" };
  const location = error ? compilerLocation(error) : null;
  return <StudioSection title={t("policyStudio.colangTitle")} description={t("policyStudio.colangDescription")} action={<div className="text-right"><Badge variant="outline">Colang {version} · {t("policyStudio.automatic")}</Badge><p className="mt-1 max-w-64 text-xs leading-4 text-muted-foreground">{t("policyStudio.automaticVersionDescription")}</p></div>}><div className="overflow-hidden rounded-lg border bg-[#111827] text-slate-100"><div className="flex items-center justify-between border-b border-white/10 px-3 py-2"><div className="flex items-center gap-2"><FileCode2 className="size-4 text-blue-400" /><Input aria-label={t("policyStudio.sourcePath")} className="h-9 w-52 border-white/10 bg-white/5 font-mono text-xs text-white" value={source.path} onChange={(event) => onChange([{ ...source, path: event.target.value }])} /></div><Badge variant="outline" className="border-white/15 bg-white/5 text-slate-300">Colang</Badge></div><div className="grid grid-cols-[3rem_minmax(0,1fr)]"><pre aria-hidden="true" className="select-none overflow-hidden border-r border-white/10 py-3 text-right font-mono text-xs leading-5 text-slate-500">{lineNumbers(source.content)}</pre><Textarea aria-label={t("policyStudio.colangSource")} wrap="off" spellCheck={false} className="min-h-[25rem] resize-y overflow-x-auto rounded-none border-0 bg-transparent px-3 py-3 font-mono text-xs leading-5 whitespace-pre text-slate-100 shadow-none focus-visible:ring-0" value={source.content} onChange={(event) => onChange([{ ...source, content: event.target.value }])} /></div><div className="flex items-center justify-between border-t border-white/10 px-3 py-2 font-mono text-xs text-slate-400"><span>{source.content.split("\n").length} {t("policyStudio.lines")}</span><span>{location ? `${location.path}:${location.line}:${location.column}` : t("policyStudio.compileReady")}</span></div></div>{error ? <Alert variant="destructive" className="mt-4"><CircleAlert /><AlertTitle>{t("policyStudio.compileError")}{location ? ` · ${location.path}:${location.line}:${location.column}` : ""}</AlertTitle><AlertDescription className="break-words font-mono text-xs">{error}</AlertDescription></Alert> : null}</StudioSection>;
}

function ActionEditor({ actions, selected, onChange, loading }: { actions: ActionDefinition[]; selected: PolicyActionReference[]; onChange: (actions: PolicyActionReference[]) => void; loading: boolean }) {
  const { t } = useTranslation();
  return <details className="group rounded-lg border bg-card"><summary className="flex min-h-20 cursor-pointer list-none items-center gap-4 px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden"><div className="min-w-0 flex-1"><h3 className="text-base font-semibold">{t("policyStudio.actionsTitle")}</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">{t("policyStudio.actionsDescription")}</p></div><Badge variant="secondary" className="shrink-0">{t("policyStudio.selectedCount", { count: selected.length })}</Badge><ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" /></summary><div className="border-t p-4"><Alert variant="info" className="mb-4"><LockKeyhole /><AlertTitle>{t("policyStudio.registeredOnly")}</AlertTitle><AlertDescription>{t("policyStudio.noPython")}</AlertDescription></Alert>{loading ? <Skeleton className="h-64" /> : <div className="divide-y rounded-lg border">{actions.map((action) => { const checked = selected.some((item) => item.name === action.name && item.version === action.version); return <label key={`${action.name}@${action.version}`} className="grid min-h-20 cursor-pointer grid-cols-[2rem_minmax(0,1fr)] gap-3 p-4 hover:bg-muted/20 sm:grid-cols-[2rem_minmax(0,1fr)_12rem]"><Checkbox className="mt-0.5" checked={checked} onCheckedChange={(value) => onChange(value ? [...selected, { name: action.name, version: action.version }] : selected.filter((item) => item.name !== action.name || item.version !== action.version))} /><span className="min-w-0"><code className="block truncate text-xs font-medium" title={action.name}>{action.name}@{action.version}</code><span className="mt-1 flex flex-wrap gap-1.5">{action.supported_rails.map((rail) => <RailBadge key={rail} rail={rail} />)}{action.concurrent ? <Badge variant="outline">{t("policyStudio.concurrent")}</Badge> : null}{action.network_access ? <Badge variant="outline"><Network />{t("policyStudio.network")}</Badge> : null}</span></span><span className="text-xs text-muted-foreground sm:text-right"><Clock3 className="mr-1 inline size-3" />{action.timeout_ms}ms<br />{action.failure_mode}</span></label>; })}</div>}</div></details>;
}

function ParameterEditor({ parameters, onChange }: { parameters: PolicyDraftParameter[]; onChange: (parameters: PolicyDraftParameter[]) => void }) {
  const { t } = useTranslation();
  return <details className="group rounded-lg border bg-card"><summary className="flex min-h-20 cursor-pointer list-none items-center gap-4 px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden"><div className="min-w-0 flex-1"><h3 className="text-base font-semibold">{t("policyStudio.parametersTitle")}</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">{t("policyStudio.parametersDescription")}</p></div><Badge variant="secondary" className="shrink-0">{t("policyStudio.parameterCount", { count: parameters.length })}</Badge><ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" /></summary><div className="border-t p-4"><div className="mb-4 flex justify-end"><Button variant="outline" onClick={() => onChange([...parameters, { name: "", kind: "string", required: false, default: null, description: "" }])}><Plus />{t("policyStudio.addParameter")}</Button></div><div className="space-y-3">{parameters.length ? parameters.map((parameter, index) => <section key={index} className="grid gap-3 rounded-lg border p-4 sm:grid-cols-[minmax(0,1fr)_9rem_10rem_2.5rem]"><Field label={t("policyStudio.parameterName")}><Input className="min-h-11 font-mono text-xs" value={parameter.name} onChange={(event) => replaceAt(parameters, index, { ...parameter, name: event.target.value }, onChange)} /></Field><Field label={t("policyStudio.type")}><Select value={parameter.kind} onValueChange={(value) => replaceAt(parameters, index, { ...parameter, kind: value as PolicyDraftParameter["kind"] }, onChange)}><SelectTrigger className="min-h-11"><SelectValue /></SelectTrigger><SelectContent>{["string", "number", "boolean", "secret"].map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent></Select></Field><Field label={t("policyStudio.defaultValue")}><Input className="min-h-11" disabled={parameter.kind === "secret"} value={parameter.default ?? ""} onChange={(event) => replaceAt(parameters, index, { ...parameter, default: event.target.value || null }, onChange)} /></Field><Button className="mt-6" size="icon" variant="ghost" aria-label={t("common.remove")} onClick={() => onChange(parameters.filter((_, itemIndex) => itemIndex !== index))}><Trash2 /></Button><label className="flex min-h-11 items-center gap-2 sm:col-span-4"><Checkbox checked={parameter.required} onCheckedChange={(value) => replaceAt(parameters, index, { ...parameter, required: Boolean(value) }, onChange)} /><span className="text-xs">{t("policyStudio.requiredAtBinding")}</span></label></section>) : <EmptyInline icon={Braces} text={t("policyStudio.noParameters")} />}</div></div></details>;
}

function TestEditor({ rails, testCases, run, error, onChange }: { rails: PolicyRailBinding[]; testCases: PolicyDraftTestCase[]; run: PolicyDraftValidationRun | null; error: string | null; onChange: (testCases: PolicyDraftTestCase[]) => void }) {
  const { t } = useTranslation();
  const defaultRail = rails[0];
  const missingRules = rulesMissingCoverage(rails, testCases);
  const addCase = () => onChange([...testCases, {
    id: `case-${testCases.length + 1}`,
    description: "",
    name: "",
    rail_type: defaultRail?.rail_type ?? "input",
    content: "",
    expected_decision: "allow",
    covered_rule_ids: defaultRail ? [policyRuleId(defaultRail)] : [],
    case_type: "unit",
    required: true,
    expected_failure: null,
    concurrency_group: null,
    trusted_instruction: "",
    use_guardrail_instruction: false,
    for_each: null,
    target_source: "user_input",
    query: "",
    grounding_sources: [],
    expected_reasoning_result: null,
  }]);
  return (
    <StudioSection title={t("policyStudio.testsTitle")} description={t("policyStudio.testsDescription")} action={<Button variant="outline" onClick={addCase}><Plus />{t("policyStudio.addCase")}</Button>}>
      {error ? <Alert variant="destructive" className="mb-4"><CircleAlert /><AlertTitle>{t("policyStudio.cannotRun")}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
      {testCases.length && missingRules.length ? <Alert variant="info" className="mb-4"><CircleAlert /><AlertTitle>{t("policyStudio.rulesNeedTests")}</AlertTitle><AlertDescription>{t("policyStudio.rulesNeedTestsDescription", { rules: missingRules.map((rule) => rule.flow_name).join(", ") })}</AlertDescription></Alert> : null}
      <div className="space-y-3">
        {testCases.map((test, index) => {
          const result = run?.results?.[index];
          const availableRules = rails.filter((rail) => rail.rail_type === test.rail_type);
          return (
            <section key={index} className={cn("rounded-lg border bg-card", result && (result.passed ? "border-emerald-200" : "border-destructive/30"))}>
              <header className="flex items-center justify-between border-b bg-muted/20 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2"><strong className="text-sm">{t("policyStudio.testCase", { number: index + 1 })}</strong><Badge variant="outline">{test.case_type}</Badge>{test.required ? null : <Badge variant="secondary">{t("policyStudio.optional")}</Badge>}</div>
                <Button size="icon" variant="ghost" aria-label={t("common.remove")} onClick={() => onChange(testCases.filter((_, itemIndex) => itemIndex !== index))}><Trash2 /></Button>
              </header>
              <div className="grid gap-4 p-4 sm:grid-cols-2">
                <Field label={`${t("policyStudio.caseName")} *`}><Input className="min-h-11" value={test.name} onChange={(event) => replaceAt(testCases, index, { ...test, name: event.target.value }, onChange)} /></Field>
                <Field label={t("policyStudio.caseType")}><Select value={test.case_type} onValueChange={(value) => replaceAt(testCases, index, { ...test, case_type: value as PolicyDraftTestCase["case_type"], expected_failure: value === "timeout" || value === "provider_failure" ? value : null }, onChange)}><SelectTrigger className="min-h-11"><SelectValue /></SelectTrigger><SelectContent>{["unit", "input_rail", "output_rail", "timeout", "provider_failure", "concurrency"].map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent></Select></Field>
                <Field label={t("policyStudio.rail")}><Select value={test.rail_type} onValueChange={(value) => { const railType = value as PolicyRailType; const firstRule = rails.find((rail) => rail.rail_type === railType); replaceAt(testCases, index, { ...test, rail_type: railType, covered_rule_ids: firstRule ? [policyRuleId(firstRule)] : [] }, onChange); }}><SelectTrigger className="min-h-11"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="input">Input</SelectItem><SelectItem value="output">Output</SelectItem></SelectContent></Select></Field>
                <Field label={t("policyStudio.expectedDecision")}><Select value={test.expected_decision} onValueChange={(value) => replaceAt(testCases, index, { ...test, expected_decision: value as PolicyDraftTestCase["expected_decision"] }, onChange)}><SelectTrigger className="min-h-11"><SelectValue /></SelectTrigger><SelectContent>{["allow", "block", "transform"].map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent></Select></Field>
                <Field label={`${t("policyStudio.content")} *`}><Textarea className="min-h-24" value={test.content} onChange={(event) => replaceAt(testCases, index, { ...test, content: event.target.value }, onChange)} /></Field>
                <div className="grid content-start gap-4">
                  <label className="flex min-h-11 items-center gap-2"><Checkbox checked={test.required} onCheckedChange={(value) => replaceAt(testCases, index, { ...test, required: Boolean(value) }, onChange)} /><span className="text-xs">{t("policyStudio.requiredGate")}</span></label>
                  {test.case_type === "concurrency" ? <Field label={t("policyStudio.concurrencyGroup")} hint={t("policyStudio.concurrencyGroupHint")}><Input className="min-h-11 font-mono text-xs" value={test.concurrency_group ?? ""} onChange={(event) => replaceAt(testCases, index, { ...test, concurrency_group: event.target.value || null }, onChange)} /></Field> : null}
                  {test.expected_failure ? <p className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">{t("policyStudio.expectedFailure", { failure: test.expected_failure })}</p> : null}
                </div>
                <fieldset className="rounded-lg border p-3 sm:col-span-2">
                  <legend className="px-1 text-xs font-medium">{t("policyStudio.coveredRules")}</legend>
                  <p className="mb-2 text-xs text-muted-foreground">{t("policyStudio.coveredRulesDescription")}</p>
                  <div className="grid gap-1 sm:grid-cols-2">
                    {availableRules.map((rail) => { const ruleId = policyRuleId(rail); const checked = test.covered_rule_ids.includes(ruleId); return <label key={ruleId} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-2 hover:bg-muted/30"><Checkbox checked={checked} onCheckedChange={(value) => replaceAt(testCases, index, { ...test, covered_rule_ids: value ? [...test.covered_rule_ids, ruleId] : test.covered_rule_ids.filter((item) => item !== ruleId) }, onChange)} /><span className="min-w-0"><strong className="block truncate text-xs">{rail.flow_name}</strong><code className="block truncate text-[10px] text-muted-foreground">{ruleId}</code></span></label>; })}
                  </div>
                </fieldset>
                {result ? <div className="sm:col-span-2"><Alert variant={result.passed ? "default" : "destructive"}>{result.passed ? <Check /> : <X />}<AlertTitle>{result.passed ? t("policyStudio.casePassed") : t("policyStudio.caseFailed")}</AlertTitle><AlertDescription><span className="block">{result.actual_decision}{result.actual_failure ? ` · ${result.actual_failure}` : ""} · {result.latency_ms}ms{result.reason ? ` · ${result.reason}` : ""}</span><span className="mt-1 block font-mono text-xs">{t("policyStudio.ruleEvidence", { covered: result.covered_rule_ids.join(", "), matched: result.matched_rule_ids.join(", ") || t("policyStudio.noRuleMatched") })}</span></AlertDescription></Alert></div> : null}
              </div>
            </section>
          );
        })}
        {!testCases.length ? <EmptyInline icon={FlaskConical} text={t("policyStudio.noTests")} /> : null}
      </div>
    </StudioSection>
  );
}

function ReleaseStatus({ run, error, running }: { run: PolicyDraftValidationRun | null; error: string | null; running: boolean }) {
  const { t } = useTranslation();
  if (running) return <Alert variant="info"><LoaderCircle className="animate-spin" /><AlertTitle>{t("policyStudio.releaseRunning")}</AlertTitle><AlertDescription>{t("policyStudio.releaseRunningDescription")}</AlertDescription></Alert>;
  if (error) return <Alert variant="destructive"><CircleAlert /><AlertTitle>{t("policyStudio.compilerValidationFailed")}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>;
  if (run?.status === "passed") return <Alert><Check /><AlertTitle>{t("policyStudio.releasePassed")}</AlertTitle><AlertDescription>{t("policyStudio.releasePassedDescription")}</AlertDescription></Alert>;
  if (run?.status === "failed") return <Alert variant="destructive"><X /><AlertTitle>{t("policyStudio.validationFailed")}</AlertTitle><AlertDescription>{t("policyStudio.releaseFailedDescription")}</AlertDescription></Alert>;
  return <Alert variant="info"><PackageCheck /><AlertTitle>{t("policyStudio.releaseNotRun")}</AlertTitle><AlertDescription>{t("policyStudio.releaseNotRunDescription")}</AlertDescription></Alert>;
}
function PublishReview({ name, draft, run }: { name: string; draft: ProgrammablePolicyDraft; run: PolicyDraftValidationRun | null }) { const { t } = useTranslation(); return <StudioSection title={t("policyStudio.publishTitle")} description={t("policyStudio.publishDescription")}><Alert className="mb-4"><LockKeyhole /><AlertTitle>{t("policyStudio.immutableTitle")}</AlertTitle><AlertDescription>{t("policyStudio.immutableDescription")}</AlertDescription></Alert><ReviewGrid items={[{ label: t("policyStudio.policy"), value: name }, { label: t("policyStudio.guardrailCategory"), value: t(`modelSettings.categories.${draft.guardrail_category}.title`) }, { label: t("policyStudio.rails"), value: uniqueRailBindings(draft.rail_bindings).join(", ") }, { label: t("policyStudio.actions"), value: String(draft.action_references.length) }, { label: t("policyStudio.validationRun"), value: run?.status ?? "not_run" }, { label: t("policyStudio.testCases"), value: String(draft.test_cases.length) }, { label: t("policyStudio.timeoutBudget"), value: `${criticalPath(draft.rail_bindings)}ms` }]} /></StudioSection>; }

function StudioSection({ title, description, action, children }: { title: string; description: string; action?: ReactNode; children: ReactNode }) { return <section><header className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><h3 className="text-lg font-semibold">{title}</h3><p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p></div>{action}</header>{children}</section>; }
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) { return <label className="grid gap-2"><Label>{label}</Label>{children}{hint ? <span className="text-xs leading-5 text-muted-foreground">{hint}</span> : null}</label>; }
function RailBadge({ rail }: { rail: NativeRailType }) { return <Badge variant="outline" className="font-mono text-[10px] uppercase">{rail}</Badge>; }
function EmptyInline({ icon: Icon, text }: { icon: typeof Braces; text: string }) { return <div className="rounded-lg border border-dashed p-8 text-center"><Icon className="mx-auto size-7 text-muted-foreground" /><p className="mt-2 text-xs text-muted-foreground">{text}</p></div>; }
function ReviewGrid({ items }: { items: Array<{ label: string; value: string; mono?: boolean }> }) { return <dl className="divide-y rounded-lg border bg-card px-4">{items.map((item) => <div key={item.label} className="grid gap-1 py-3 text-sm sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-5"><dt className="text-muted-foreground">{item.label}</dt><dd className={cn("min-w-0 break-words font-medium", item.mono && "font-mono text-xs")}>{item.value || "—"}</dd></div>)}</dl>; }

function emptyDraft(): ProgrammablePolicyDraft { return { guardrail_category: defaultGuardrailCategory, colang_version: "2.x", sources: [{ path: "main.co", content: DEFAULT_COLANG }], parameter_schema: [], rail_bindings: [emptyRail(0)], action_references: [{ name: "GuardCustomerIdentifierAction", version: "1.0.0" }, { name: "GuardRecordPolicyAction", version: "1.0.0" }], evaluation_contracts: [], prompt_dependencies: [], execution_contract: [], test_cases: [] }; }
function emptyRail(index: number): PolicyRailBinding { return { rail_type: index ? "output" : "input", flow_name: index ? "check_response" : "check_request", execution_mode: index ? "mutate" : "detect", on_unsafe: index ? "redact" : "reject", parallel_group: index ? null : "primary-detection", priority: index ? 100 : null, timeout_ms: 500, failure_mode: "fail_closed", required: true, depends_on: [] }; }
function cloneDraft(draft: ProgrammablePolicyDraft): ProgrammablePolicyDraft { return JSON.parse(JSON.stringify(draft)) as ProgrammablePolicyDraft; }
function replaceAt<T>(items: T[], index: number, item: T, onChange: (items: T[]) => void) { onChange(items.map((current, currentIndex) => currentIndex === index ? item : current)); }
function railReady(rail: PolicyRailBinding) { return Boolean(rail.flow_name.trim() && rail.timeout_ms > 0); }
function parameterReady(parameter: PolicyDraftParameter) { return Boolean(parameter.name.trim() && (!parameter.required || parameter.kind === "secret" || parameter.default !== "")); }
function testReady(test: PolicyDraftTestCase, rails: PolicyRailBinding[]) { const available = new Set(rails.filter((rail) => rail.rail_type === test.rail_type).map(policyRuleId)); return Boolean(test.name.trim() && test.content.trim() && test.covered_rule_ids.length && test.covered_rule_ids.every((ruleId) => available.has(ruleId))); }
function policyRuleId(rail: PolicyRailBinding) { return `flow/${rail.rail_type}/${rail.flow_name}`; }
function rulesMissingCoverage(rails: PolicyRailBinding[], testCases: PolicyDraftTestCase[]) { const covered = new Set(testCases.filter((test) => test.required).flatMap((test) => test.covered_rule_ids)); return rails.filter((rail) => !covered.has(policyRuleId(rail))); }
function allRulesCovered(rails: PolicyRailBinding[], testCases: PolicyDraftTestCase[]) { return rulesMissingCoverage(rails, testCases).length === 0; }
function uniqueRailBindings(rails: PolicyRailBinding[]) { return [...new Set(rails.map((item) => item.rail_type))]; }
function criticalPath(rails: PolicyRailBinding[]) { const groups = new Map<string, number>(); for (const rail of rails) { const key = rail.parallel_group || `${rail.rail_type}:${rail.flow_name}`; groups.set(key, Math.max(groups.get(key) ?? 0, rail.timeout_ms)); } return [...groups.values()].reduce((total, value) => total + value, 0); }
function lineNumbers(content: string) { return Array.from({ length: content.split("\n").length }, (_, index) => index + 1).join("\n"); }
function errorMessage(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }
