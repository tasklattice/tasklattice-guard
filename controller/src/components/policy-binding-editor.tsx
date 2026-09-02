import { useMemo } from "react";
import { ChevronDown, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MultiSelectCombobox, type MultiSelectOption } from "@/components/ui/multi-select-combobox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { EnforcementAction, GuardrailPolicyBinding, Policy } from "@/lib/api";

const ACTIONS: EnforcementAction[] = [
  "reject",
  "redact",
  "rewrite",
  "regenerate",
  "redirect",
  "fallback",
  "clarify",
  "pass",
];

export function PolicyBindingEditor({
  policies,
  value,
  onChange,
  showSelector = true,
}: {
  policies: Policy[];
  value: GuardrailPolicyBinding[];
  onChange: (next: GuardrailPolicyBinding[]) => void;
  showSelector?: boolean;
}) {
  const { t } = useTranslation();
  const selectedIds = value.map((binding) => binding.policy_id);
  const options = useMemo<MultiSelectOption[]>(() => policies.map((policy) => {
    const bindable = policy.source === "built_in" || policy.version !== "0";
    const frameworkLabels = policy.tags
      .filter((tag) => tag.namespace === "framework")
      .map((tag) => tag.label);
    return {
      value: policy.id,
      label: policy.name,
      description: policy.description,
      disabled: !bindable,
      keywords: [
        policy.id,
        ...policy.tags.map((tag) => tag.label),
        ...policy.rules.map((rule) => rule.name),
      ],
      meta: [
        ...frameworkLabels,
        `v${policy.version}`,
        t("policyLibrary.ruleCount", { count: policy.rules.length }),
        t("policyLibrary.testCount", { count: policy.test_count }),
        ...(!bindable ? [t("guardrailWizard.publishPolicyFirst")] : []),
      ].join(" · "),
    };
  }), [policies, t]);

  function selectPolicies(nextIds: string[]) {
    onChange(nextIds.map((policyId) => {
      const existing = value.find((binding) => binding.policy_id === policyId);
      if (existing) return existing;
      const policy = policies.find((item) => item.id === policyId);
      return policy ? defaultPolicyBinding(policy) : null;
    }).filter((binding): binding is GuardrailPolicyBinding => binding !== null));
  }

  function update(policyId: string, patch: Partial<GuardrailPolicyBinding>) {
    onChange(value.map((binding) => binding.policy_id === policyId ? { ...binding, ...patch } : binding));
  }

  return (
    <div className="min-w-0 space-y-5">
      {showSelector ? (
        <div className="min-w-0 space-y-2">
          <MultiSelectCombobox
            ariaLabel={t("guardrailWizard.selectPolicies")}
            value={selectedIds}
            options={options}
            placeholder={t("guardrailWizard.selectPolicies")}
            searchPlaceholder={t("guardrailWizard.searchPolicies")}
            emptyMessage={t("guardrailWizard.noMatchingPolicies")}
            emptyDescription={t("guardrailWizard.noMatchingPoliciesDescription")}
            noOptionsMessage={t("guardrailWizard.noPublishedPolicies")}
            noOptionsDescription={t("guardrailWizard.noPublishedPoliciesDescription")}
            onValueChange={selectPolicies}
          />
          <p className="text-xs leading-5 text-muted-foreground">{t("guardrailWizard.policyPickerHint")}</p>
        </div>
      ) : null}

      {value.length ? (
        <section className="min-w-0 overflow-hidden rounded-xl border bg-card">
          <header className="border-b bg-muted/25 px-4 py-3">
            <h3 className="text-sm font-semibold">{t("guardrailWizard.boundPolicies", { count: value.length })}</h3>
            <p className="mt-1 text-xs text-muted-foreground">{t("guardrailWizard.boundPoliciesDescription")}</p>
          </header>
          <div className="divide-y">
            {value.map((binding) => {
              const policy = policies.find((item) => item.id === binding.policy_id);
              if (!policy) return null;
              return (
                <details key={binding.policy_id} className="group">
                  <summary
                    aria-label={t("guardrailWizard.boundPolicyDetails", { name: policy.name })}
                    className="flex min-h-14 cursor-pointer list-none items-center gap-3 px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden"
                    onKeyDown={(event) => {
                      if (event.repeat || (event.key !== "Enter" && event.key !== " ")) return;
                      event.preventDefault();
                      const details = event.currentTarget.closest("details");
                      if (details) details.open = !details.open;
                    }}
                  >
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><ShieldCheck className="size-4" /></span>
                    <span className="min-w-0 flex-1"><strong className="block truncate text-sm">{policy.name}</strong><span className="font-mono text-xs text-muted-foreground">{binding.policy_id}@{binding.policy_version}</span></span>
                    <Badge variant="outline">{t("guardrailWizard.enabledRuleCount", { count: binding.enabled_rule_ids.length })}</Badge>
                    <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
                  </summary>
                  <div className="space-y-5 border-t bg-muted/[0.12] p-4">
                    <section className="space-y-3">
                      <div>
                        <h4 className="text-xs font-semibold">{t("guardrailWizard.behaviorTitle")}</h4>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("guardrailWizard.behaviorDescription")}</p>
                      </div>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <Field label={t("guardrailWizard.policyAction")}>
                          <Select value={binding.action ?? "policy_default"} onValueChange={(selected) => update(binding.policy_id, { action: selected === "policy_default" ? null : selected as EnforcementAction })}>
                            <SelectTrigger className="min-h-11 bg-card"><SelectValue /></SelectTrigger>
                            <SelectContent><SelectItem value="policy_default">{t("guardrailWizard.usePolicyBehavior")}</SelectItem>{ACTIONS.map((action) => <SelectItem key={action} value={action}>{action}</SelectItem>)}</SelectContent>
                          </Select>
                        </Field>
                        <div>
                          <Label>{t("guardrailWizard.enabledRails")}</Label>
                          <div className="mt-2 flex min-h-11 flex-wrap items-center gap-2">
                            {policy.stages.map((stage) => <Badge key={stage} variant="outline" className="font-mono uppercase">{stage}</Badge>)}
                          </div>
                        </div>
                      </div>
                    </section>

                    {policy.parameters.length || binding.policy_id === "builtin-automated-reasoning" ? (
                      <section className="space-y-3">
                        <div>
                          <h4 className="text-xs font-semibold">{t("guardrailWizard.inputsTitle")}</h4>
                          <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("guardrailWizard.inputsDescription")}</p>
                        </div>
                        {policy.parameters.length ? (
                          <div className="grid gap-4 sm:grid-cols-2">
                            {policy.parameters.map((parameter) => (
                              <Field key={parameter.name} label={`${parameter.label ?? parameter.name}${parameter.required ? " *" : ""}`} hint={parameter.description}>
                                {parameter.kind === "textarea" ? (
                                  <Textarea
                                    className="min-h-24 bg-card"
                                    value={binding.parameter_values[parameter.name] ?? parameter.default ?? ""}
                                    placeholder={parameter.placeholder}
                                    onChange={(event) => update(binding.policy_id, { parameter_values: { ...binding.parameter_values, [parameter.name]: event.target.value } })}
                                  />
                                ) : (
                                  <Input
                                    className="min-h-11 bg-card"
                                    type={parameter.kind === "secret" ? "password" : "text"}
                                    value={binding.parameter_values[parameter.name] ?? parameter.default ?? ""}
                                    placeholder={parameter.placeholder}
                                    onChange={(event) => update(binding.policy_id, { parameter_values: { ...binding.parameter_values, [parameter.name]: event.target.value } })}
                                  />
                                )}
                              </Field>
                            ))}
                          </div>
                        ) : null}

                        {binding.policy_id === "builtin-automated-reasoning" ? (
                          <div className="grid gap-4 rounded-lg border bg-card p-4 sm:grid-cols-3">
                            <Field label={t("guardrailWizard.reasoningPolicyId")}><Input className="min-h-11" value={binding.reasoning_policy?.policy_id ?? ""} onChange={(event) => update(binding.policy_id, { reasoning_policy: { policy_id: event.target.value, policy_version: binding.reasoning_policy?.policy_version ?? "", confidence_threshold: binding.reasoning_policy?.confidence_threshold ?? 0.8 } })} /></Field>
                            <Field label={t("guardrailWizard.reasoningPolicyVersion")}><Input className="min-h-11" value={binding.reasoning_policy?.policy_version ?? ""} onChange={(event) => update(binding.policy_id, { reasoning_policy: { policy_id: binding.reasoning_policy?.policy_id ?? "", policy_version: event.target.value, confidence_threshold: binding.reasoning_policy?.confidence_threshold ?? 0.8 } })} /></Field>
                            <Field label={t("guardrailWizard.confidenceThreshold")}><Input className="min-h-11" type="number" min={0} max={1} step={0.05} value={binding.reasoning_policy?.confidence_threshold ?? 0.8} onChange={(event) => update(binding.policy_id, { reasoning_policy: { policy_id: binding.reasoning_policy?.policy_id ?? "", policy_version: binding.reasoning_policy?.policy_version ?? "", confidence_threshold: Number(event.target.value) } })} /></Field>
                          </div>
                        ) : null}
                      </section>
                    ) : null}

                    <section className="space-y-3">
                      <div>
                        <h4 className="text-xs font-semibold">{t("guardrailWizard.coverageTitle")}</h4>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("guardrailWizard.coverageDescription")}</p>
                      </div>
                      <div className="divide-y rounded-lg border bg-card">
                        {policy.rules.map((rule) => {
                          const enabled = binding.enabled_rule_ids.includes(rule.id);
                          return (
                            <div key={rule.id} className="grid gap-3 p-3 sm:grid-cols-[2rem_minmax(0,1fr)_10rem] sm:items-center">
                              <Checkbox checked={enabled} onCheckedChange={(next) => update(binding.policy_id, { enabled_rule_ids: next ? [...binding.enabled_rule_ids, rule.id] : binding.enabled_rule_ids.filter((id) => id !== rule.id) })} />
                              <span className="min-w-0"><strong className="block truncate text-xs">{rule.name}</strong><span className="mt-1 block truncate font-mono text-xs text-muted-foreground">{rule.id}</span></span>
                              <Select value={binding.rule_actions[rule.id] ?? "policy_default"} disabled={!enabled} onValueChange={(selected) => { const next = { ...binding.rule_actions }; if (selected === "policy_default") delete next[rule.id]; else next[rule.id] = selected as EnforcementAction; update(binding.policy_id, { rule_actions: next }); }}>
                                <SelectTrigger className="min-h-11"><SelectValue /></SelectTrigger>
                                <SelectContent><SelectItem value="policy_default">{rule.effect}</SelectItem>{ACTIONS.map((action) => <SelectItem key={action} value={action}>{action}</SelectItem>)}</SelectContent>
                              </Select>
                            </div>
                          );
                        })}
                      </div>
                    </section>
                  </div>
                </details>
              );
            })}
          </div>
        </section>
      ) : (
        <div className="rounded-lg border border-dashed bg-muted/20 px-4 py-3"><p className="text-sm font-medium">{t("guardrailWizard.noPolicies")}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{t("guardrailWizard.noPoliciesDescription")}</p></div>
      )}
    </div>
  );
}

export function defaultPolicyBinding(policy: Policy): GuardrailPolicyBinding {
  return {
    policy_id: policy.id,
    policy_version: policy.version,
    action: null,
    parameter_values: Object.fromEntries(policy.parameters.filter((parameter) => parameter.default != null).map((parameter) => [parameter.name, parameter.default ?? ""])),
    enabled_rule_ids: policy.rules.map((rule) => rule.id),
    rule_actions: {},
    enabled_rails: policy.stages,
    reasoning_policy: policy.id === "builtin-automated-reasoning" ? { policy_id: "", policy_version: "", confidence_threshold: 0.8 } : null,
  };
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="grid gap-2"><Label>{label}</Label>{children}{hint ? <span className="text-xs leading-5 text-muted-foreground">{hint}</span> : null}</label>;
}
