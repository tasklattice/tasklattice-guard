import { useId, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { TOPIC_ALLOW_RULE, TOPIC_DENY_RULE, topicPolicyValues } from "../../shared/topic-policy";
import { analyzeGuardrailIntent, getIntentAnalysisStatus, type GuardrailPolicyBinding, type Policy } from "@/lib/api";
import { queryKeys } from "@/features/query-keys";
import { Checkbox } from "./ui/checkbox";
import { Textarea } from "./ui/textarea";
import { Button } from "./ui/button";
import { TopicModeField } from "./topic-control-fields";
import { TopicControlUnavailable, useTopicControlAvailability } from "./topic-control-availability";
import { ComplianceDocumentImport } from "./compliance-document-import";
import { ErrorNotice } from "./product-shell";

export function TopicPolicyRules({ binding, policy, onChange }: {
  binding: GuardrailPolicyBinding; policy: Policy; onChange: (patch: Partial<GuardrailPolicyBinding>) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const values = topicPolicyValues(binding.parameter_values);
  const [helperOpen, setHelperOpen] = useState(false);
  function parameters(patch: Record<string, string>) { onChange({ parameter_values: { ...binding.parameter_values, ...patch } }); }
  return <section className="space-y-4">
    <p className="text-xs leading-5 text-muted-foreground">{t("protection.topicRules.independent")}</p>
    {[TOPIC_DENY_RULE, TOPIC_ALLOW_RULE].map(ruleId => {
      const deny = ruleId === TOPIC_DENY_RULE;
      const enabled = binding.enabled_rule_ids.includes(ruleId);
      const label = t(`protection.topicRules.${deny ? "deny" : "allow"}`);
      return <section key={ruleId} className="rounded-lg border bg-card p-4">
        <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-semibold">
          <Checkbox aria-label={`${policy.name}: ${label}`} checked={enabled} onCheckedChange={checked => onChange({ enabled_rule_ids: checked ? [...new Set([...binding.enabled_rule_ids, ruleId])] : binding.enabled_rule_ids.filter(item => item !== ruleId) })} />{label}
        </label>
        <p className="mb-3 text-xs leading-5 text-muted-foreground">{t(`protection.topicRules.${deny ? "denyHint" : "allowHint"}`)}</p>
        {enabled ? <div className="space-y-4">
          <label htmlFor={`${id}-${deny ? "deny" : "allow"}`} className="block text-sm font-medium">{t(deny ? "topicControl.denied" : "topicControl.allowed")}</label>
          <Textarea id={`${id}-${deny ? "deny" : "allow"}`} className="min-h-28" value={deny ? values.denied : values.allowed} placeholder={t("guardrailWizard.onePerLine")} onChange={event => parameters({ [deny ? "denied_topics" : "allowed_topics"]: event.target.value })} />
          {!deny ? <TopicModeField mode={values.mode} onChange={mode => parameters({ topic_mode: mode })} /> : null}
        </div> : <p className="text-xs text-muted-foreground">{t("protection.topicRules.disabled")}</p>}
      </section>;
    })}
    <details className="rounded-lg border bg-card px-4" onToggle={event => setHelperOpen(event.currentTarget.open)}>
      <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">{t("protection.topicRules.helper")}</summary>
      {helperOpen ? <TopicPolicyHelper binding={binding} policy={policy} onApply={parameters} /> : null}
    </details>
  </section>;
}

function TopicPolicyHelper({ binding, policy, onApply }: { binding: GuardrailPolicyBinding; policy: Policy; onApply: (parameters: Record<string, string>) => void }) {
  const { t, i18n } = useTranslation();
  const [intent, setIntent] = useState("");
  const [documents, setDocuments] = useState(false);
  const [applied, setApplied] = useState(false);
  const availability = useTopicControlAvailability(true);
  const status = useQuery({ queryKey: queryKeys.intentAnalysisStatus, queryFn: getIntentAnalysisStatus, retry: false });
  const mode = topicPolicyValues(binding.parameter_values).mode;
  const language = i18n.language.startsWith("zh") ? "zh-CN" : "en";
  const analyze = useMutation({
    mutationFn: () => analyzeGuardrailIntent({ purpose: intent.trim(), topicControlMode: mode, language }),
    networkMode: "always", retry: false,
    onSuccess: () => setApplied(false),
  });
  if (!availability.ready) return <div className="pb-4"><TopicControlUnavailable availability={availability} /></div>;
  const available = Boolean(status.data?.available);
  return <div className="space-y-4 pb-4">
    <p className="text-xs leading-5 text-muted-foreground">{t("protection.topicRules.helperHint")}</p>
    {status.error ? <ErrorNotice error={status.error} /> : null}
    {!status.isPending && !available ? <p className="text-sm text-muted-foreground">{t("guardrailWizard.policyAssistantUnavailable")}</p> : null}
    <label className="grid gap-2 text-sm font-medium">{t("guardrailWizard.intentInputLabel")}
      <Textarea maxLength={2000} className="min-h-40 font-normal leading-6" value={intent} placeholder={t("guardrailWizard.intentInputPlaceholder")} disabled={!available || analyze.isPending} onChange={event => { setIntent(event.target.value); analyze.reset(); setApplied(false); }} />
    </label>
    <Button disabled={!available || !intent.trim() || analyze.isPending} onClick={() => analyze.mutate()}>{t(analyze.isPending ? "guardrailWizard.intentAnalyzing" : "guardrailWizard.intentAnalyze")}</Button>
    {analyze.error ? <ErrorNotice error={analyze.error} /> : null}
    {analyze.data ? <section aria-live="polite" className="space-y-3 rounded-lg border p-4">
      <p className="text-sm">{analyze.data.summary}</p>
      {[["topicControl.allowed", analyze.data.allowed_topics], ["topicControl.denied", analyze.data.restricted_topics]].map(([label, items]) => <div key={label as string}><strong className="text-sm">{t(label as string)}</strong><p className="whitespace-pre-wrap text-sm text-muted-foreground">{(items as string[]).join("\n") || t("topicControl.empty")}</p></div>)}
      <Button disabled={applied || !available} onClick={() => { onApply({ allowed_topics: analyze.data!.allowed_topics.join("\n"), denied_topics: analyze.data!.restricted_topics.join("\n") }); setApplied(true); }}>{t(applied ? "guardrailWizard.documentApplied" : "guardrailWizard.applyProposal")}</Button>
    </section> : null}
    <details onToggle={event => setDocuments(event.currentTarget.open)}><summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">{t("guardrailWizard.generateFromDocuments")}</summary>
      {documents ? <ComplianceDocumentImport topicOnly available={Boolean(status.data?.document_analysis_available)} analystProvider={status.data?.provider} analystModel={status.data?.model} language={language} policies={[policy]} resetKey={0} onApply={analysis => onApply({ allowed_topics: analysis.allowed_topics.join("\n"), denied_topics: analysis.restricted_topics.join("\n") })} /> : null}
    </details>
  </div>;
}
