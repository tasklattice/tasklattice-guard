import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { list, parse, record, resultEvidence, text, type EvidenceRecord, type ValidationCheck } from "@/lib/validation-evidence";

const key = "modelSettings.evidence.";
export function EvidenceField({ label, value }: { label: string; value: unknown }) {
  const content = text(value);
  return content ? <div className="min-w-0"><dt className="mb-1 text-xs text-muted-foreground">{label}</dt><dd className="whitespace-pre-wrap [overflow-wrap:anywhere]">{content}</dd></div> : null;
}
function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="min-w-0"><h4 className="mb-2 text-sm font-semibold">{title}</h4>{children}</section>;
}
function SummaryTable({ columns, rows, numeric = [] }: { columns: string[]; rows: ReactNode[][]; numeric?: number[] }) {
  return <table className="w-full text-left text-sm"><thead><tr className="border-b text-muted-foreground">{columns.map((column, i) => <th key={i} className={`px-3 py-2 font-normal first:pl-0 ${numeric.includes(i) ? "text-right" : ""}`}>{column}</th>)}</tr></thead><tbody>{rows.map((row, i) => <tr key={i} className="border-b">{row.map((cell, j) => <td key={j} className={`px-3 py-2 align-top tabular-nums first:pl-0 [overflow-wrap:anywhere] ${numeric.includes(j) ? "text-right" : ""}`}>{cell}</td>)}</tr>)}</tbody></table>;
}

export function ValidationResultSummary({ sample, output }: { sample: NonNullable<ValidationCheck["cases"]>[number]; output: EvidenceRecord }) {
  const { t } = useTranslation();
  const data = resultEvidence(output);
  const context = record(output.validation_context);
  const parameters = record(context.parameters);
  const inputContext = list(context.input_context).map(record);
  const policy = record(output.formal_policy);
  const error = record(output.error);
  const reason = sample.reason || text(output.reason) || text(error.message);
  const probability = data.judgments.some(item => typeof item.probability === "number");
  const thresholds = data.judgments.some(item => Object.keys(item.thresholds).length > 0);
  const pii = context.profile === "tali.openai-compatible-pii.v1";
  return <div className="space-y-5 text-sm">
    <dl className="flex flex-wrap gap-x-12 gap-y-3">
      <EvidenceField label={t(key + "expected")} value={sample.expectedDecision} />
      <EvidenceField label={t(key + "actual")} value={sample.actualDecision} />
      <EvidenceField label={t(key + "verdict")} value={data.verdict} />
      <EvidenceField label={t(key + "errorType")} value={error.type} />
    </dl>
    {reason ? <p className={`border-l-2 py-2 pl-3 leading-6 whitespace-pre-wrap [overflow-wrap:anywhere] ${sample.passed ? "border-border" : "border-destructive bg-destructive/5"}`}>{reason}</p> : null}
    <Section title={t(key + "input")}><p className="bg-muted/30 px-3 py-2 leading-6 whitespace-pre-wrap [overflow-wrap:anywhere]">{sample.inputContent}</p></Section>
    {inputContext.length > 0 || output.query || parameters.allowed_topics ? <dl className="grid grid-cols-2 gap-4 border-l-2 pl-3">
      <EvidenceField label={t(key + "allowedTopics")} value={parameters.allowed_topics} />
      <EvidenceField label={t(key + "topicMode")} value={parameters.topic_mode} />
      <EvidenceField label={t(key + "query")} value={output.query} />
      {inputContext.filter(item => !(output.query && item.role === "query")).map((item, i) => <EvidenceField key={i} label={t(key + (item.role === "query" ? "query" : "source"))} value={item.text} />)}
    </dl> : null}
    {data.judgments.length > 0 ? <Section title={t(key + "judgments")}><SummaryTable numeric={[...(probability ? [2] : []), ...(thresholds ? [probability ? 3 : 2] : [])]} columns={[t(key + "question"), t(key + "answer"), ...(probability ? [t(key + "probability")] : []), ...(thresholds ? [t(key + "thresholds")] : [])]}
      rows={data.judgments.map(item => [item.question, text(item.answer) || "—", ...(probability ? [text(item.probability) || "—"] : []), ...(thresholds ? [`${text(item.thresholds.lower) || "—"} / ${text(item.thresholds.upper) || "—"}`] : [])])} /></Section> : null}
    {data.answers.length > 0 ? <Section title={t(key + "reviewAnswers")}><SummaryTable columns={[t(key + "question"), t(key + "answer")]} rows={data.answers.map(item => [item.question, text(item.answer)])} /></Section> : null}
    {data.native.map((item, i) => <dl key={i} className="flex flex-wrap gap-x-12 gap-y-3">
      <EvidenceField label={t(key + (item.topic_verdict != null ? "topicVerdict" : pii ? "piiVerdict" : "nativeVerdict"))} value={item.topic_verdict ?? (pii && item.native_verdict === "unsafe" ? "pii" : pii && item.native_verdict === "uncertain" ? "unknown" : item.native_verdict)} />
      <EvidenceField label={t(key + "categories")} value={list(item.native_categories).map(text).join(", ")} />
      <EvidenceField label={t(key + "jailbreak")} value={item.jailbreak} />
      <EvidenceField label={t(key + "signedScore")} value={item.score} />
    </dl>)}
    {data.grounding.length > 0 ? <Section title={t(key + "grounding")}><SummaryTable numeric={[1, 2]} columns={[t(key + "metric"), t(key + "score"), t(key + "threshold"), t(key + "detected")]} rows={data.grounding.map(item => [text(item.type), text(item.score), text(item.threshold), text(item.detected)])} /></Section> : null}
    {data.claims.length > 0 ? <Section title={t(key + "claims")}><SummaryTable numeric={[2]} columns={[t(key + "claim"), t(key + "support"), t(key + "confidence"), t(key + "source")]} rows={data.claims.map(item => [<div>{text(item.claim)}{item.rationale ? <p className="mt-1 text-muted-foreground">{text(item.rationale)}</p> : null}</div>, text(item.support), text(item.confidence), list(item.source_block_ids).map(text).join(", ") || "—"])} /></Section> : null}
    {Object.keys(policy).length > 0 ? <dl className="flex flex-wrap gap-8"><EvidenceField label={t(key + "policy")} value={policy.policy_id} /><EvidenceField label={t(key + "policyVersion")} value={policy.policy_version} /><EvidenceField label={t(key + "confidenceThreshold")} value={policy.confidence_threshold} /></dl> : null}
    {data.reasoning.length > 0 ? <Section title={t(key + "proof")}>
      {data.reasoning.map((item, i) => <article key={i} className="space-y-3 border-b py-3 first:pt-0">
        <dl className="flex flex-wrap gap-8"><EvidenceField label={t(key + "proofResult")} value={item.result} /><EvidenceField label={t(key + "confidence")} value={item.confidence} /></dl>
        {item.message ? <p>{text(item.message)}</p> : null}
        {list(item.supporting_rules).length + list(item.contradicting_rules).length > 0 ? <details><summary className="w-fit cursor-pointer">{t(key + "rules")}</summary><SummaryTable columns={[t(key + "relation"), t(key + "rule"), t(key + "expression")]} rows={[
          ...list(item.supporting_rules).map(record).map(rule => [t(key + "supporting"), text(rule.id), `${text(rule.expression)}${rule.description ? ` · ${text(rule.description)}` : ""}`]),
          ...list(item.contradicting_rules).map(record).map(rule => [t(key + "contradicting"), text(rule.id), `${text(rule.expression)}${rule.description ? ` · ${text(rule.description)}` : ""}`]),
        ]} /></details> : null}
        {["claims_true_scenario", "claims_false_scenario"].filter(name => list(record(item[name]).variable_values).length > 0).map(name => <details key={name}><summary className="w-fit cursor-pointer">{t(key + name)}</summary><SummaryTable columns={[t(key + "variable"), t(key + "value")]} rows={list(record(item[name]).variable_values).map(pair => list(pair).map(text))} /></details>)}
        {Object.keys(record(item.translation)).length > 0 ? <details><summary className="w-fit cursor-pointer">{t(key + "translation")}</summary><dl className="mt-3 grid grid-cols-2 gap-4">{["premises", "claims", "untranslated"].map(name => <EvidenceField key={name} label={t(key + name)} value={list(record(item.translation)[name]).map(text).join("\n")} />)}</dl></details> : null}
      </article>)}
    </Section> : null}
    {!Object.keys(parse(sample.outputContent)).length && sample.outputContent ? <Section title={t(key + "diagnostic")}><p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{sample.outputContent}</p></Section> : null}
  </div>;
}
