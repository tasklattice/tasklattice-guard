import { modelParameterFields, policyBindingParameterIssues } from "../../shared/policy-parameters";
import { PolicyParameterEditor, PolicyTestParameters, ModelParameterInput, withModelParameters } from "./policy-parameter-editor";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Plus, Trash2, Play, Save, Upload, Download, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, LoaderCircle, CheckCircle2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { CreationFlow, WizardSection, ReviewList } from "./creation-flow";
import { EntitySheet } from "./entity-sheet";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { NativeSelect } from "./ui/native-select";
import { Textarea } from "./ui/textarea";
import { Badge } from "./ui/badge";
import { toast } from "./ui/notifications";
import { requestController } from "@/lib/controller-api";
import { useAuth } from "@/lib/auth";
import { definitionIssues, emptyPolicyDefinition, policyDefinitionSchema, detectorRefs, type PolicyDefinition, type PolicyResource, type DefinitionRule, type DefinitionTest, type ResourceValidation } from "../../shared/policy-definition";

const endpoint = (id: string) => `/api/v1/policies/${encodeURIComponent(id)}/definition`;
const write = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const uid = () => crypto.randomUUID();

export function DeclarativePolicyStudio({ policyId, imported, onClose, onSaved, returnFocusRef }: {
  policyId: string | null; imported?: PolicyDefinition | undefined; onClose: () => void; onSaved: (id: string) => Promise<void>; returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation();
  const l = (key: string) => t(`declarativePolicy.${key}`);
  const { user } = useAuth();
  const [definition, setDefinition] = useState<PolicyDefinition>(() => imported ?? emptyPolicyDefinition());
  const [revision, setRevision] = useState(0);
  const [saved, setSaved] = useState(Boolean(policyId));
  const [dirty, setDirty] = useState(!policyId);
  const [maintainer, setMaintainer] = useState(user?.username ?? "Platform administrators");
  const [selected, setSelected] = useState(0);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(Boolean(policyId));
  const [loaded, setLoaded] = useState(!policyId);
  const [report, setReport] = useState<ResourceValidation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [definitionError, setDefinitionError] = useState(false);
  const [detectorError, setDetectorError] = useState(false);
  const invalidEditor = definitionError || detectorError;
  const mounted = useRef(true);
  const editSerial = useRef(0);
  useEffect(() => {
    mounted.current = true;
    if (policyId) requestController<PolicyResource>(endpoint(policyId)).then(resource => {
      if (!mounted.current) return;
      setDefinition(resource.definition); setRevision(resource.revision); setMaintainer(resource.maintainer); setLoaded(true);
      if (resource.validation?.revision === resource.revision) setReport(resource.validation);
    }).catch(e => { if (mounted.current) setError(String(e)); }).finally(() => { if (mounted.current) setBusy(false); });
    return () => { mounted.current = false; };
  }, [policyId]);
  useEffect(() => {
    if (!report || !["queued", "running"].includes(report.status)) return;
    const timer = window.setTimeout(() => {
      const serial = editSerial.current;
      requestController<ResourceValidation>(`${endpoint(definition.metadata.id)}/test-runs/${encodeURIComponent(report.id)}`).then(result => {
        if (mounted.current && editSerial.current === serial && result?.id === report.id) setReport(result);
      }).catch(e => { if (mounted.current && editSerial.current === serial) { setError(String(e)); setReport(null); } });
    }, 1500);
    return () => clearTimeout(timer);
  }, [report, definition.metadata.id]);
  const testing = Boolean(report && ["queued", "running"].includes(report.status));
  function change(next: PolicyDefinition) { editSerial.current++; setDefinition(next); setDirty(true); setReport(null); setNotice(""); setError(null); }
  function changeRule(next: DefinitionRule) { change({ ...definition, rules: definition.rules.map((r, i) => i === selected ? next : r) }); }
  const issues = definitionIssues(definition);
  const testParameterIssues = policyBindingParameterIssues(definition, definition.testing?.parameters ?? {}, definition.rules.map(rule => rule.id));
  const rule = definition.rules[selected];
  useEffect(() => setDetectorError(false), [rule?.id, rule?.detector.ref]);
  async function persist() {
    const resource = await requestController<PolicyResource>(endpoint(definition.metadata.id), write("PUT", { definition, maintainer, expectedRevision: revision, create: !saved }));
    if (mounted.current) { setRevision(resource.revision); setSaved(true); setDirty(false); }
    await onSaved(resource.id);
    return resource;
  }
  async function action(kind: "save" | "test" | "publish") {
    setBusy(true); setError(null); setNotice("");
    if (kind === "test") setReport(null);
    try {
      if (kind === "publish") {
        await requestController(`${endpoint(definition.metadata.id)}/publish`, write("POST", { expectedRevision: revision }));
        await onSaved(definition.metadata.id);
        if (mounted.current) {
          toast.success(l("publishedGuardrailsCanBindThisVersion"));
          onClose();
        }
      } else {
        const resource = await persist();
        if (!mounted.current) return;
        if (kind === "test") {
          const result = await requestController<ResourceValidation>(`${endpoint(resource.id)}/test-runs`, write("POST"));
          if (mounted.current) setReport(result);
        }
        else setNotice(l("draftSavedToThePolicyLibrary"));
      }
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (mounted.current) setBusy(false); }
  }
  function addRule() {
    const id = `rule-${uid()}`;
    change({ ...definition, rules: [...definition.rules, { id, name: l("newRule"), description: "", stages: ["input"], detector: { ref: "text/keyword", version: "1.0.0", parameters: { detector_options: { terms: [] } } }, on_match: { action: "block" }, risk_level: "medium", metadata: { taxonomy_ids: ["TALI-BUSINESS-POLICY"] } }] });
    setSelected(definition.rules.length);
  }
  function addTest(stage: "input" | "output") {
    if (!rule) return;
    const test: DefinitionTest = { id: `test-${uid()}`, name: `${rule.name} · ${stage}`, description: "", phase: stage, content: "", expected_decision: rule.on_match.action, covered_rule_ids: [rule.id], kind: "rule_acceptance", scope: "rule", required: true, parameter_names: [], group: "Policy tests", ...(rule.on_match.action === "transform" ? { expected_text: "" } : {}) };
    if (rule.detector.ref.startsWith("agent/")) test.context = { target_source: "retrieved_content", trusted_instruction: "", query: "", grounding_sources: [], expected_reasoning_result: null };
    change({ ...definition, tests: [...definition.tests, test] });
  }
  function updateTest(next: DefinitionTest) { change({ ...definition, tests: definition.tests.map(t => t.id === next.id ? next : t) }); }
  function moveRule(offset: number) {
    const rules = [...definition.rules]; const target = selected + offset;
    if (target < 0 || target >= rules.length) return;
    [rules[target], rules[selected]] = [rules[selected]!, rules[target]!]; change({ ...definition, rules }); setSelected(target);
  }
  function exportDefinition() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(definition, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${definition.metadata.id}.policy.json`; anchor.click(); URL.revokeObjectURL(url);
  }
  const steps = ["basics", "rules", "tests", "review"].map(key => ({ label: l(key), description: l(`${key}Hint`) }));
  const identityReady = Boolean(definition.metadata.name.trim() && maintainer.trim());
  const canTest = loaded && !busy && !testing && !invalidEditor && !issues.length && !testParameterIssues.length && identityReady;
  const canPublish = loaded && !busy && !dirty && !invalidEditor && report?.status === "passed" && report.revision === revision;
  const blockedReason = invalidEditor ? l("fixJson") : !identityReady ? l("provideIdentity")
    : step === 1 && !definition.rules.length ? l("addYourFirstRuleToChooseADetector")
    : step >= 2 && (issues.length || testParameterIssues.length) ? `${l("publicationRequirements")} · ${issues.length + testParameterIssues.length}`
    : step === 3 && !busy && !canPublish ? l(testing ? "testsRunning" : "passBeforePublish") : null;
  function navigate(next: number) {
    if (busy) return;
    if (invalidEditor) { setError(l("fixJson")); return; }
    setStep(next);
  }
  const ruleSelector = <div className="mb-5 flex items-end gap-3">
    <div className="min-w-0 flex-1"><Field label={l("selectedRule")}><NativeSelect className="field:h-11 w-full" value={selected} onChange={e => setSelected(Number(e.target.value))}>
      {definition.rules.map((r, i) => <option key={r.id} value={i}>{i + 1}. {r.name} · {definition.tests.filter(test => test.covered_rule_ids.includes(r.id)).length} {l("tests")}</option>)}
    </NativeSelect></Field></div>
    {step === 1 ? <Button variant="outline" className="min-h-11" onClick={addRule}><Plus />{l("addRule")}</Button> : null}
  </div>;
  const requirements = issues.length ? <details className="rounded-lg border p-4 text-sm"><summary className="cursor-pointer">{l("publicationRequirements")} · {issues.length}</summary><ul className="mt-3 list-disc space-y-2 pl-5 text-xs">{issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul></details> : null;
  const testSummary = report ? <div role="status" className="rounded-lg border bg-muted/20 p-4 text-sm">
    <div className="flex items-center gap-2">{testing ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : report.status === "passed" ? <CheckCircle2 className="size-4 shrink-0 text-emerald-700" aria-hidden="true" /> : null}<strong>{l("testRun")}: {l(report.status)}</strong><span>· {report.results.filter(r => r.passed).length}/{report.results.length || definition.tests.length}</span></div>
    {report.failureReason ? <p className="mt-2 text-destructive">{report.failureReason}</p> : null}
  </div> : null;
  return <EntitySheet open onOpenChange={open => { if (!open && !busy) onClose(); }} closeDisabled={busy} returnFocusRef={returnFocusRef} width="workflow" bodyClassName="overflow-hidden p-0 sm:p-0"
    eyebrow="Policy Studio" title={definition.metadata.name || l("newPolicy")}
    description={l("composeDetectorsIntoOrderedRulesVerifyEachRule")}
    footer={<div className="flex w-full items-center gap-4">
      <div className="mr-auto min-w-0 text-xs text-muted-foreground"><p>{definition.rules.length} Rules · {definition.tests.length} Test Cases{saved ? ` · ${l("revision")} ${revision}` : ""}{dirty ? ` · ${l("unsaved")}` : ""}</p>{blockedReason ? <p id="policy-studio-blocker" role="status" className="mt-1 text-amber-800">{blockedReason}</p> : null}</div>
      <Button variant="outline" disabled={busy} onClick={() => step ? navigate(step - 1) : onClose()}>{step ? <><ArrowLeft />{t("common.previous")}</> : t("common.cancel")}</Button>
      <Button variant="outline" disabled={!loaded || busy || invalidEditor || !identityReady} onClick={() => void action("save")}><Save />{l("saveDraft")}</Button>
      {step === 2 ? <Button variant="testing" disabled={!canTest} aria-describedby={blockedReason ? "policy-studio-blocker" : undefined} onClick={() => void action("test")}>{testing ? <LoaderCircle className="animate-spin" /> : <Play />}{l("runTests")}</Button> : null}
      {step < 3 ? <Button variant={step === 2 ? "outline" : "default"} disabled={!loaded || busy || invalidEditor || step === 0 && !identityReady || step === 1 && !definition.rules.length} onClick={() => navigate(step + 1)}>{step === 2 ? l("review") : t("common.next")}<ArrowRight /></Button>
        : <Button disabled={!canPublish} aria-describedby={blockedReason ? "policy-studio-blocker" : undefined} onClick={() => void action("publish")}><Upload />{l("publish")}</Button>}
    </div>}
  >
    <CreationFlow orientation="sidebar" freelyNavigable contained currentStep={step} onStepChange={navigate} progressLabel="Policy Studio" steps={steps}>
      {error ? <p role="alert" className="mb-4 whitespace-pre-wrap rounded-lg border border-destructive/30 p-3 text-sm text-destructive">{error}</p> : null}
      {notice ? <p role="status" className="mb-4 rounded-lg border p-3 text-sm">{notice}</p> : null}
      {!loaded && busy ? <p role="status" className="mb-4 flex items-center gap-2 text-sm"><LoaderCircle className="size-4 animate-spin" />{l("loading")}</p> : null}
      <fieldset disabled={busy || !loaded} className="min-w-0">
        <WizardSection title={steps[step]!.label}>
          {step === 0 ? <div className="max-w-3xl space-y-5">
            <Field label={l("policyName")}><Input className="field:h-11" value={definition.metadata.name} onChange={e => change({ ...definition, metadata: { ...definition.metadata, name: e.target.value } })} /></Field>
            <Field label={l("description")}><Textarea value={definition.metadata.description} onChange={e => change({ ...definition, metadata: { ...definition.metadata, description: e.target.value } })} /></Field>
            <Field label={l("maintenanceMaintainer")}><Input className="field:h-11" value={maintainer} onChange={e => { editSerial.current++; setMaintainer(e.target.value); setDirty(true); setReport(null); setNotice(""); }} /></Field>
            <p className="text-xs leading-5 text-muted-foreground">{l("administratorsCanMaintainThisPolicyPublishingCreatesA")}</p>
          </div> : null}
          {step === 1 ? <PolicyParameterEditor definition={definition} change={change} l={l} /> : null}
          {step === 2 ? <><PolicyTestParameters definition={definition} change={change} l={l} />{testParameterIssues.length ? <ul role="alert" className="mb-4 list-disc pl-5 text-xs text-destructive">{testParameterIssues.map(issue => <li key={issue}>{issue}</li>)}</ul> : null}</> : null}
          {step === 1 || step === 2 ? <>
            {definition.rules.length ? ruleSelector : <div className="space-y-4 rounded-lg border border-dashed p-8"><p className="text-sm text-muted-foreground">{l("addYourFirstRuleToChooseADetector")}</p><Button variant="outline" onClick={() => { addRule(); setStep(1); }}><Plus />{l("addFirstRule")}</Button></div>}
            {rule && step === 1 ? <section className="space-y-5" key={rule.id}>
              <div className="flex items-center justify-between border-b pb-3"><h3 className="font-medium">{rule.name}</h3><div className="flex gap-1"><Button className="size-11" size="icon" variant="ghost" aria-label={l("moveRuleUp")} disabled={selected === 0} onClick={() => moveRule(-1)}><ArrowUp /></Button><Button className="size-11" size="icon" variant="ghost" aria-label={l("moveRuleDown")} disabled={selected === definition.rules.length - 1} onClick={() => moveRule(1)}><ArrowDown /></Button><Button className="size-11" size="icon" variant="ghost" aria-label={l("deleteRuleAndItsTests")} onClick={() => { change({ ...definition, rules: definition.rules.filter(r => r.id !== rule.id), tests: definition.tests.filter(test => !test.covered_rule_ids.includes(rule.id)) }); setSelected(Math.max(0, selected - 1)); }}><Trash2 /></Button></div></div>
              <div className="grid grid-cols-2 gap-5">
                <Field label={l("ruleName")}><Input className="field:h-11" value={rule.name} onChange={e => changeRule({ ...rule, name: e.target.value })} /></Field>
                <Field label="Detector"><NativeSelect className="field:h-11 w-full" value={rule.detector.ref} onChange={e => {
                  const ref = e.target.value as DefinitionRule["detector"]["ref"];
                  const next: DefinitionRule = { ...rule, detector: { ref, version: "1.0.0", parameters: detectorDefaults(ref) }, stages: [ref === "model/grounding" || ref === "service/formal-verification" ? "output" : "input"], on_match: { action: "block" } };
                  change(withModelParameters(definition, next, l));
                }}>{detectorRefs.map(ref => <option key={ref}>{ref}</option>)}</NativeSelect></Field>
                <fieldset><legend className="text-xs font-medium">{l("checkStages")}</legend><div className="mt-2 flex h-11 items-center gap-5">{(["input", "output"] as const).map(stage => <label key={stage} className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={rule.stages.includes(stage)} disabled={rule.detector.ref.startsWith("agent/")} onChange={e => changeRule({ ...rule, stages: e.target.checked ? [...rule.stages, stage] : rule.stages.filter(s => s !== stage) })} />{l(stage)}</label>)}</div></fieldset>
                <Field label={l("onMatch")}><NativeSelect className="field:h-11 w-full" value={rule.on_match.action} onChange={e => changeRule({ ...rule, on_match: { ...rule.on_match, action: e.target.value as DefinitionRule["on_match"]["action"] } })}>{["block", "allow", ...(["text/keyword", "text/regex"].includes(rule.detector.ref) || rule.on_match.action === "transform" ? ["transform"] : [])].map(action => <option key={action}>{action}</option>)}</NativeSelect></Field>
              </div>
              <DetectorFields rule={rule} parameters={definition.parameters} change={changeRule} onModelChange={next => change(withModelParameters(definition, next, l))} l={l} onError={setDetectorError} />
              {rule.on_match.action === "transform" ? <Field label={l("replacementText")}><Input className="field:h-11" value={rule.on_match.replacement ?? ""} onChange={e => changeRule({ ...rule, on_match: { ...rule.on_match, replacement: e.target.value } })} /></Field> : null}
            </section> : null}
            {rule && step === 2 ? <div className="space-y-4">
              {testSummary}
              <div className="flex items-center justify-between gap-5"><p className="text-xs leading-5 text-muted-foreground">{l("eachStageNeedsARequiredAcceptanceCaseRule")}</p><div className="flex shrink-0 gap-2">{rule.stages.map(stage => <Button key={stage} className="min-h-11" variant="outline" onClick={() => addTest(stage)}><Plus />{l(stage)}</Button>)}</div></div>
              {definition.tests.filter(test => test.covered_rule_ids.includes(rule.id)).map(test => <TestEditor key={test.id} test={test} rule={rule} update={updateTest} remove={() => change({ ...definition, tests: definition.tests.filter(t => t.id !== test.id) })} l={l} />)}
              {requirements}
            </div> : null}
          </> : null}
          {step === 1 ? <details className="mt-6 rounded-lg border p-4"><summary className="cursor-pointer text-sm">{l("advancedDefinitionParametersAndReusableConditions")}</summary><p className="my-3 text-xs text-muted-foreground">{l("jsonUsesTheSamePortableDslAsExport")}</p><JsonEditor value={definition} onValid={value => { const next = policyDefinitionSchema.parse(value); if (saved && next.metadata.id !== definition.metadata.id) throw new Error("A saved Policy ID cannot be changed."); change(next); setSelected(Math.min(selected, Math.max(0, next.rules.length - 1))); }} onError={setDefinitionError} /></details> : null}
          {step === 3 ? <div className="space-y-5">
            <ReviewList items={[{ label: l("policyName"), value: definition.metadata.name || "—" }, { label: l("maintenanceMaintainer"), value: maintainer }, { label: "Rules / Test Cases", value: `${definition.rules.length} / ${definition.tests.length}` }, { label: "Detectors", value: [...new Set(definition.rules.map(r => r.detector.ref))].join(", ") || "—", mono: true }]} />
            {testSummary ?? <p className="text-sm text-muted-foreground">{l("passBeforePublish")}</p>}
            {report?.results.length ? <section aria-label={l("testResults")} className="divide-y rounded-lg border">{report.results.map(result => <div key={result.caseId} className="space-y-2 p-4 text-sm"><div className="flex items-start justify-between gap-4"><strong>{result.name}</strong><Badge variant="outline">{l(result.passed ? "passed" : "failed")}</Badge></div><p className="text-xs text-muted-foreground">{result.reason}{result.modelInvocations != null ? ` · ${l("modelCalls")}: ${result.modelInvocations}` : ""}</p><details className="text-xs"><summary className="cursor-pointer">{l("actualResult")} · {result.actualDecision}</summary><p className="mt-2 whitespace-pre-wrap break-words rounded-md bg-muted/30 p-3">{result.outputContent || "—"}</p><p className="mt-2 break-all text-muted-foreground">{l("matchedRules")}: {result.matchedRuleIds.join(", ") || "—"}</p>{result.actualReasoningResult ? <p className="mt-2">{l("proofResult")}: {result.actualReasoningResult}</p> : null}{result.findings?.length ? <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 p-3">{JSON.stringify(result.findings, null, 2)}</pre> : null}</details></div>)}</section> : null}
            {requirements}
            <div className="flex gap-3"><Button variant="testing" onClick={() => navigate(2)}><Play />{l("editAndRunTests")}</Button><Button variant="outline" disabled={invalidEditor} onClick={exportDefinition}><Download />{l("exportDefinition")}</Button></div>
            <p className="text-xs leading-5 text-muted-foreground">{l("immutableVersionHint")}</p>
          </div> : null}
        </WizardSection>
      </fieldset>
    </CreationFlow>
  </EntitySheet>;
}

function detectorDefaults(ref: DefinitionRule["detector"]["ref"]): Record<string, unknown> {
  switch (ref) {
    case "agent/indirect-injection":
    case "agent/memory-poisoning": return {};
    case "text/regex": return { expression: "" };
    case "text/conditions": return { detector_options: { match: { contains: [] } } };
    case "code/fenced-block": return { detector_options: { languages: ["python", "javascript"] } };
    case "model/classifier": return { profile: "safety-classification" };
    case "model/grounding": return { grounding_threshold: 0.7, relevance_threshold: 0.7 };
    case "service/formal-verification": return { policy_id: "", policy_version: "", confidence_threshold: 0.8 };
    default: return { detector_options: { terms: [] } };
  }
}

function TestEditor({ test, rule, update, remove, l }: { test: DefinitionTest; rule: DefinitionRule; update: (test: DefinitionTest) => void; remove: () => void; l: (key: string) => string }) {
  const context = test.context ?? { trusted_instruction: "", query: "", grounding_sources: [], expected_reasoning_result: null };
  const external = rule.detector.ref.startsWith("model/") || rule.detector.ref.startsWith("service/");
  const boundary = rule.detector.ref.startsWith("agent/");
  return <section className="space-y-4 rounded-lg border p-4">
    <div className="flex items-center gap-3"><Input className="field:h-11" aria-label={l("testName")} value={test.name} onChange={e => update({ ...test, name: e.target.value })} /><Badge variant="outline">{test.phase}</Badge><Button className="size-11 shrink-0" size="icon" variant="ghost" aria-label={l("deleteTest")} onClick={remove}><Trash2 /></Button></div>
    <div className="grid grid-cols-2 gap-4"><Field label={l("inputText")}><Textarea value={test.content} onChange={e => update({ ...test, content: e.target.value })} /></Field><div className="space-y-3"><Field label={l("expectedDecision")}><NativeSelect className="field:h-11 w-full" value={test.expected_decision} onChange={e => update({ ...test, expected_decision: e.target.value as DefinitionTest["expected_decision"] })}>{["allow", "block", "transform", "intervene"].map(action => <option key={action}>{action}</option>)}</NativeSelect></Field><label className="flex min-h-11 items-center gap-2 text-xs"><input type="checkbox" checked={test.kind === "rule_acceptance"} onChange={e => update({ ...test, kind: e.target.checked ? "rule_acceptance" : "scenario", scope: e.target.checked ? "rule" : "policy" })} />{l("ruleAcceptanceMustMatch")}</label></div></div>
    {test.expected_decision === "transform" || test.expected_text != null ? <Field label={l("expectedCompleteOutput")}><Textarea value={test.expected_text ?? ""} onChange={e => update({ ...test, expected_text: e.target.value })} /></Field> : null}
    {external || boundary ? <details open={boundary || ["model/grounding", "service/formal-verification"].includes(rule.detector.ref)} className="border-t pt-3"><summary className="cursor-pointer text-xs font-medium">{l("testContext")}</summary><div className="mt-4 space-y-4">
      {boundary ? <Field label={l("targetSource")}><NativeSelect className="field:h-11 w-full" value={context.target_source ?? "user_input"} onChange={e => update({ ...test, context: { ...context, target_source: e.target.value as "user_input" | "retrieved_content" | "tool_output" } })}>{["user_input", "retrieved_content", "tool_output"].map(source => <option key={source} value={source}>{l(source)}</option>)}</NativeSelect></Field> : null}
      {external ? <Field label={l("trustedInstruction")}><Textarea value={context.trusted_instruction} onChange={e => update({ ...test, context: { ...context, trusted_instruction: e.target.value } })} /></Field> : null}
      {boundary || ["model/grounding", "service/formal-verification"].includes(rule.detector.ref) ? <Field label={l("query")}><Input className="field:h-11" value={context.query} onChange={e => update({ ...test, context: { ...context, query: e.target.value } })} /></Field> : null}
      {rule.detector.ref === "model/grounding" ? <><Field label={l("groundingSources")}><Textarea value={context.grounding_sources.join("\n")} onChange={e => update({ ...test, context: { ...context, grounding_sources: e.target.value.split("\n") } })} /></Field></> : null}
      {rule.detector.ref === "service/formal-verification" ? <Field label={l("expectedReasoningResult")}><NativeSelect className="field:h-11 w-full" value={context.expected_reasoning_result ?? ""} onChange={e => update({ ...test, context: { ...context, expected_reasoning_result: e.target.value || null } })}><option value="">{l("selectProofResult")}</option>{["valid", "invalid", "satisfiable", "impossible", "translation_ambiguous", "too_complex", "no_translations"].map(value => <option key={value}>{value}</option>)}</NativeSelect></Field> : null}
    </div></details> : null}
  </section>;
}

function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="grid min-w-0 gap-2"><span className="text-xs font-medium">{label}</span>{children}</label>; }
function JsonEditor({ value, onValid, onError }: { value: unknown; onValid: (value: unknown) => void; onError?: (error: boolean) => void }) {
  const [text, setText] = useState(JSON.stringify(value, null, 2)); const [error, setError] = useState("");
  useEffect(() => { setText(JSON.stringify(value, null, 2)); setError(""); onError?.(false); }, [value, onError]);
  return <><Textarea aria-label="JSON definition" className="min-h-40 font-mono text-xs" value={text} onChange={e => { setText(e.target.value); try { const parsed: unknown = JSON.parse(e.target.value); onValid(parsed); setError(""); onError?.(false); } catch (e) { setError(String(e)); onError?.(true); } }} />{error ? <p role="alert" className="mt-2 text-xs text-destructive">{error}</p> : null}</>;
}
function DetectorFields({ rule, parameters, change, onModelChange, l, onError }: { rule: DefinitionRule; parameters: PolicyDefinition["parameters"]; change: (rule: DefinitionRule) => void; onModelChange: (rule: DefinitionRule) => void; l: (key: string) => string; onError: (error: boolean) => void }) {
  const p = rule.detector.parameters;
  const options = (p.detector_options ?? {}) as Record<string, unknown>;
  const update = (parameters: Record<string, unknown>) => change({ ...rule, detector: { ...rule.detector, parameters } });
  if (rule.detector.ref.startsWith("agent/")) return <p className="text-xs leading-5 text-muted-foreground">{l("boundaryHint")}</p>;
  if (rule.detector.ref === "model/classifier" || rule.detector.ref === "model/grounding" || rule.detector.ref === "service/formal-verification") return <div className="space-y-4">
    <p className="text-xs leading-5 text-muted-foreground">{l("externalBindingHint")}</p>
    {rule.detector.ref === "model/classifier" ? <>
      <Field label={l("classificationProfile")}><NativeSelect className="field:h-11 w-full" value={String(p.profile ?? "safety-classification")} onChange={e => {
        const profile = e.target.value;
        onModelChange({ ...rule, stages: ["jailbreak-classification", "topic-classification"].includes(profile) ? ["input"] : rule.stages, detector: { ...rule.detector, parameters: { profile } } });
      }}>{["safety-classification", "jailbreak-classification", "pii-classification", "topic-classification"].map(profile => <option key={profile} value={profile}>{l(profile)}</option>)}</NativeSelect></Field>
    </> : null}
    {rule.detector.ref === "service/formal-verification" ? <p className="text-xs text-muted-foreground">{l("formalPolicyHint")}</p> : null}
    <div className="grid grid-cols-2 gap-4">{modelParameterFields(rule).map(field => <ModelParameterInput key={field.key} field={field} value={p[field.key]} parameters={parameters} update={value => update({ ...p, [field.key]: value })} l={l} />)}</div>
  </div>;
  if (rule.detector.ref === "text/regex") return <><Field label={l("regularExpressionPythonSyntax")}><Input className="field:h-11 field:font-mono" value={String(p.expression ?? "")} onChange={e => update({ ...p, expression: e.target.value })} /></Field><Field label={l("contextExpressionOptional")}><Input className="field:h-11 field:font-mono" value={String(p.context_expression ?? "")} onChange={e => update({ ...p, context_expression: e.target.value || null })} /></Field></>;
  if (rule.detector.ref === "text/keyword" && !rule.expand && !p.keywords && (!options.terms || Array.isArray(options.terms) && options.terms.every(t => typeof t === "string"))) return <Field label={l("matchingWordsOrPhrasesOnePerLine")}><Textarea value={(options.terms as string[] | undefined ?? []).join("\n")} onChange={e => update({ ...p, detector_options: { ...options, terms: e.target.value.split("\n") } })} /></Field>;
  if (rule.detector.ref === "code/fenced-block") return <Field label={l("codeLanguagesOnePerLine")}><Textarea value={(Array.isArray(options.languages) ? options.languages : []).join("\n")} onChange={e => update({ ...p, detector_options: { ...options, languages: e.target.value.split("\n") } })} /></Field>;
  if (rule.detector.ref === "text/conditions") {
    const match = options.match as Record<string, unknown> | undefined;
    if (match && Object.keys(match).length === 1 && Array.isArray(match.contains) && match.contains.every(x => typeof x === "string")) return <Field label={l("containsAnyTextOnePerLine")}><Textarea value={(match.contains as string[]).join("\n")} onChange={e => update({ ...p, detector_options: { ...options, match: { contains: e.target.value.split("\n") } } })} /></Field>;
  }
  return <Field label={l("detectorParameters")}><JsonEditor value={p} onError={onError} onValid={value => { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Parameters must be an object."); update(value as Record<string, unknown>); }} /></Field>;
}
