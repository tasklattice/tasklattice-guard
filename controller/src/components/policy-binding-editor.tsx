import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronDown, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { parsePhraseEntries } from "../../shared/phrase-policy";
import { PhrasePolicyEditor } from "./phrase-policy-editor";
import { boundPolicy } from "@/lib/bound-policy";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MultiSelectCombobox, type MultiSelectOption } from "@/components/ui/multi-select-combobox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { enforcementActions, type EnforcementAction, type GuardrailPolicyBinding, type Policy } from "@/lib/api";

export function PolicyBindingEditor({
  policies,
  value,
  onChange,
  showSelector = true,
  embedded = false,
}: {
  policies: Policy[];
  value: GuardrailPolicyBinding[];
  onChange: (next: GuardrailPolicyBinding[]) => void;
  showSelector?: boolean;
  /** The containing Policy row already owns the disclosure and heading. */
  embedded?: boolean;
}) {
  const { t } = useTranslation();
  const movedControl = useRef<HTMLButtonElement | null>(null);
  const [announcement, setAnnouncement] = useState("");
  useLayoutEffect(() => {
    const button = movedControl.current;
    movedControl.current = null;
    if (button?.isConnected) button.focus();
  }, [value]);
  function rememberFocus(button: HTMLButtonElement) {
    movedControl.current = document.activeElement === button ? button : null;
  }
  function movePolicy(index: number, offset: number, button: HTMLButtonElement) {
    const target = index + offset;
    if (target < 0 || target >= value.length) return;
    rememberFocus(button);
    const next = [...value];
    const [binding] = next.splice(index, 1);
    next.splice(target, 0, binding!);
    onChange(next);
    setAnnouncement(t("protection.movedPolicy", { name: boundPolicy(policies, binding!)?.name ?? binding!.policy_id, position: target + 1, count: value.length }));
  }
  const selectedIds = value.map((binding) => binding.policy_id);
  const options = useMemo<MultiSelectOption[]>(() => policies.map((catalogPolicy) => {
    const binding = value.find((item) => item.policy_id === catalogPolicy.id);
    const policy = binding ? boundPolicy(policies, binding) : catalogPolicy;
    if (!policy) return {
      value: catalogPolicy.id,
      label: `${catalogPolicy.id}@${binding!.policy_version}`,
      description: t("guardrailWizard.nextBlocked.policyUnavailable", { name: `${catalogPolicy.id}@${binding!.policy_version}` }),
    };
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
  }), [policies, value, t]);

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
      <p className="sr-only" role="status">{announcement}</p>
      {showSelector ? (
        <div className="min-w-0 space-y-2">
          <MultiSelectCombobox
            ariaLabel={t("guardrailWizard.selectPolicies")}
            showSelectedValues={false}
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
          <header hidden={embedded} className="border-b bg-muted/25 px-4 py-3">
            <h3 className="text-sm font-semibold">{t("guardrailWizard.boundPolicies", { count: value.length })}</h3>
            <p className="mt-1 text-xs text-muted-foreground">{t("protection.nestedOrderHint")}</p>
          </header>
          <ol aria-label={t("protection.order")} className="divide-y">
            {value.map((binding, policyIndex) => {
              const policy = boundPolicy(policies, binding);
              if (!policy) return <li key={binding.policy_id} role="alert" className="flex min-w-0 flex-wrap items-center justify-between gap-3 p-4 text-sm text-destructive">
                <p className="min-w-0 flex-1 break-words">{t("guardrailWizard.nextBlocked.policyUnavailable", { name: `${binding.policy_id}@${binding.policy_version}` })}</p>
                <Button variant="outline" className="min-h-11" onClick={() => onChange(value.filter((item) => item.policy_id !== binding.policy_id))}>{t("common.remove")}</Button>
              </li>;
              const validation = getPolicyBindingValidation(binding, policy);
              const validationLabel = validation.missingRequiredParameters.length
                ? t("guardrailWizard.missingRequiredFieldCount", { count: validation.missingRequiredParameters.length })
                : validation.missingReasoningPolicy
                  ? t("guardrailWizard.reasoningConfigurationRequired")
                  : validation.missingRules
                    ? t("guardrailWizard.noEnabledRules")
                    : validation.missingRails
                      ? t("protection.selectDirection")
                    : null;
              const orderedRuleIds = [...new Set([...(binding.rule_order ?? []), ...policy.rules.map((rule) => rule.id)])];
              const orderedRules = orderedRuleIds.flatMap((id) => policy.rules.filter((rule) => rule.id === id));
              function moveRule(index: number, offset: number, button: HTMLButtonElement) {
                if (index + offset < 0 || index + offset >= orderedRules.length) return;
                rememberFocus(button);
                const ids = orderedRules.map((rule) => rule.id);
                const [moved] = ids.splice(index, 1);
                ids.splice(index + offset, 0, moved!);
                update(binding.policy_id, { rule_order: ids });
                setAnnouncement(t("protection.movedRule", { name: orderedRules[index]!.name, policy: policy!.name, position: index + offset + 1, count: ids.length }));
              }
              return (
                <PolicyOrderRow key={binding.policy_id} embedded={embedded} autoOpen={Boolean(validationLabel)}
                  label={t(validationLabel ? "guardrailWizard.boundPolicyDetailsRequiresConfiguration" : "guardrailWizard.boundPolicyDetails", { name: policy.name })}
                  controls={<>
                    <Button type="button" variant="ghost" size="icon" className="size-11 aria-disabled:opacity-50 aria-disabled:hover:bg-transparent" aria-disabled={policyIndex === 0} aria-label={t("protection.moveUp", { name: policy.name })} onClick={(event) => movePolicy(policyIndex, -1, event.currentTarget)}><ArrowUp /></Button>
                    <Button type="button" variant="ghost" size="icon" className="size-11 aria-disabled:opacity-50 aria-disabled:hover:bg-transparent" aria-disabled={policyIndex === value.length - 1} aria-label={t("protection.moveDown", { name: policy.name })} onClick={(event) => movePolicy(policyIndex, 1, event.currentTarget)}><ArrowDown /></Button>
                    <Button type="button" variant="ghost" size="icon" className="size-11" aria-label={t("protection.remove", { name: policy.name })} onClick={() => onChange(value.filter((item) => item.policy_id !== binding.policy_id))}><Trash2 /></Button>
                  </>}
                  summary={<>
                    <span className="w-6 shrink-0 text-center font-mono text-sm text-muted-foreground">{policyIndex + 1}</span>
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-1">
                        <strong className="min-w-0 truncate text-sm">{policy.name}</strong>
                        {validationLabel ? (
                          <span
                            aria-hidden="true"
                            className="-translate-y-0.5 shrink-0 text-base font-semibold leading-none text-destructive"
                            data-testid="required-configuration-indicator"
                          >
                            *
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-1 block text-xs text-muted-foreground">{binding.enabled_rails.map((rail) => t(`protection.${rail}`)).join(" · ")} · v{binding.policy_version} · {t("guardrailWizard.enabledRuleCount", { count: binding.enabled_rule_ids.length })}</span>
                      {validationLabel ? <span className="mt-1 block text-xs font-medium text-destructive">{validationLabel}</span> : null}
                    </span>
                  </>}
                >
                  <div className="space-y-5 border-t bg-muted/[0.12] p-4">
                    <section className="space-y-3">
                      <div>
                        <h4 className="text-xs font-semibold">{t("protection.ruleOrder")}</h4>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("protection.ruleOrderHint")}</p>
                      </div>
                      <div className="divide-y rounded-lg border bg-card">
                        {orderedRules.map((rule, ruleIndex) => {
                          const enabled = binding.enabled_rule_ids.includes(rule.id);
                          const inheritedActionLabel = binding.action != null
                            ? t("protection.ruleInheritedAction", { action: binding.action })
                            : rule.implementation?.detector === "configured_phrases"
                              ? t("protection.phrases.useEntryActions")
                              : t("protection.ruleDefaultAction", { action: rule.effect });
                          return (
                            <div key={rule.id} className="grid grid-cols-[1.25rem_minmax(0,1fr)] items-center gap-3 p-3 lg:grid-cols-[1.25rem_minmax(0,1fr)_10rem_auto]">
                              <Checkbox aria-label={`${policy.name}: ${rule.name}`} checked={enabled} onCheckedChange={(next) => update(binding.policy_id, { enabled_rule_ids: next ? [...binding.enabled_rule_ids, rule.id] : binding.enabled_rule_ids.filter((id) => id !== rule.id) })} />
                              <span className="min-w-0"><span className="mb-1 block font-mono text-xs text-muted-foreground">{embedded ? ruleIndex + 1 : `${policyIndex + 1}.${ruleIndex + 1}`}</span><strong className="block truncate text-xs">{rule.name}</strong><span className="mt-1 block truncate font-mono text-xs text-muted-foreground">{rule.id}</span></span>
                              <div className="col-start-2 min-w-0 lg:col-auto">
                              <Select value={binding.rule_actions[rule.id] ?? "policy_default"} disabled={!enabled} onValueChange={(selected) => { const next = { ...binding.rule_actions }; if (selected === "policy_default") delete next[rule.id]; else next[rule.id] = selected as EnforcementAction; update(binding.policy_id, { rule_actions: next }); }}>
                                <SelectTrigger aria-label={t("protection.ruleAction", { name: rule.name })} className="min-h-11"><SelectValue /></SelectTrigger>
                                <SelectContent><SelectItem value="policy_default">{inheritedActionLabel}</SelectItem>{enforcementActions.map((action) => <SelectItem key={action} value={action}>{action}</SelectItem>)}</SelectContent>
                              </Select>
                              </div>
                              <div className="col-start-2 flex justify-end gap-1 lg:col-auto">
                                <Button variant="ghost" size="icon" className="size-11 aria-disabled:opacity-50 aria-disabled:hover:bg-transparent" aria-disabled={ruleIndex === 0} aria-label={t("protection.moveRuleUp", { name: rule.name, policy: policy.name })} onClick={(event) => moveRule(ruleIndex, -1, event.currentTarget)}><ArrowUp /></Button>
                                <Button variant="ghost" size="icon" className="size-11 aria-disabled:opacity-50 aria-disabled:hover:bg-transparent" aria-disabled={ruleIndex === orderedRules.length - 1} aria-label={t("protection.moveRuleDown", { name: rule.name, policy: policy.name })} onClick={(event) => moveRule(ruleIndex, 1, event.currentTarget)}><ArrowDown /></Button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </section>
                    <section className="space-y-3">
                      <div>
                        <h4 className="text-xs font-semibold">{t("guardrailWizard.behaviorTitle")}</h4>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("guardrailWizard.behaviorDescription")}</p>
                      </div>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <Field label={t("guardrailWizard.policyAction")}>
                          <Select value={binding.action ?? "policy_default"} onValueChange={(selected) => update(binding.policy_id, { action: selected === "policy_default" ? null : selected as EnforcementAction })}>
                            <SelectTrigger className="min-h-11 bg-card"><SelectValue /></SelectTrigger>
                            <SelectContent><SelectItem value="policy_default">{t("guardrailWizard.usePolicyBehavior")}</SelectItem>{enforcementActions.map((action) => <SelectItem key={action} value={action}>{action}</SelectItem>)}</SelectContent>
                          </Select>
                        </Field>
                        <div>
                          <Label>{t("protection.inspectDirection")}</Label>
                          <div className="mt-2 flex min-h-11 flex-wrap items-center gap-2">
                            {policy.rails.filter((rail) => rail === "input" || rail === "output").map((rail) => <label key={rail} className="flex min-h-11 items-center gap-2 rounded-md border bg-card px-3 text-xs">
                              <Checkbox aria-label={`${policy.name}: ${t(`protection.${rail}`)}`} checked={binding.enabled_rails.includes(rail)} onCheckedChange={(enabled) => update(binding.policy_id, { enabled_rails: enabled ? [...new Set([...binding.enabled_rails, rail])] : binding.enabled_rails.filter((item) => item !== rail) })} />
                              {t(`protection.${rail}`)}
                            </label>)}
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
                            {policy.parameters.map((parameter) => parameter.kind === "phrase_entries" ? (
                              <PhrasePolicyEditor key={parameter.name} value={binding.parameter_values[parameter.name] ?? ""}
                                onChange={(value) => update(binding.policy_id, { parameter_values: { ...binding.parameter_values, [parameter.name]: value } })} />
                            ) : (
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


                  </div>
                </PolicyOrderRow>
              );
            })}
          </ol>
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
    enabled_rails: policy.rails,
    reasoning_policy: policy.id === "builtin-automated-reasoning" ? { policy_id: "", policy_version: "", confidence_threshold: 0.8 } : null,
  };
}

export function getPolicyBindingValidation(binding: GuardrailPolicyBinding, policy: Policy) {
  const missingRequiredParameters = policy.parameters.filter((parameter) => {
    const value = binding.parameter_values[parameter.name] ?? parameter.default ?? "";
    if (parameter.kind === "phrase_entries") {
      try { parsePhraseEntries(value); return false; } catch { return true; }
    }
    return parameter.required && !value.trim();
  });
  return {
    missingRequiredParameters,
    missingReasoningPolicy: binding.policy_id === "builtin-automated-reasoning"
      && !(binding.reasoning_policy?.policy_id.trim() && binding.reasoning_policy.policy_version.trim()),
    missingRules: binding.enabled_rule_ids.length === 0,
    missingRails: binding.enabled_rails.length === 0,
  };
}

function PolicyOrderRow({ embedded, autoOpen, label, summary, controls, children }: {
  embedded: boolean; autoOpen: boolean; label: string; summary: ReactNode; controls: ReactNode; children: ReactNode;
}) {
  const [open, setOpen] = useState(autoOpen);
  const contentId = useId();
  useEffect(() => {
    if (autoOpen) setOpen(true);
  }, [autoOpen]);
  return <li>
    <div hidden={embedded} className="flex flex-wrap items-center gap-x-2 px-3 py-2">
      <button type="button" aria-label={label} aria-expanded={open} aria-controls={contentId}
        className="flex min-h-14 min-w-0 flex-1 basis-48 items-center gap-3 rounded-md py-2 pr-2 text-left hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-ring"
        onClick={() => setOpen(!open)}>
        {summary}<ChevronDown className={`size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`} />
      </button>
      <div className="ml-auto flex shrink-0 gap-1">{controls}</div>
    </div>
    <div id={contentId} hidden={!embedded && !open}>{children}</div>
  </li>;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="grid gap-2"><Label>{label}</Label>{children}{hint ? <span className="text-xs leading-5 text-muted-foreground">{hint}</span> : null}</label>;
}
