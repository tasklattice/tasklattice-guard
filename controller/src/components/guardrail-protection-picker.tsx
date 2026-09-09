import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { boundPolicy } from "@/lib/bound-policy";
import { policyDirectory } from "@/lib/protection-composition";
import type { GuardrailPolicyBinding, Policy } from "@/lib/api";
import { PolicyBindingEditor, defaultPolicyBinding } from "./policy-binding-editor";
import { Checkbox } from "./ui/checkbox";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const groups = [
  { id: "safety", directories: ["content_safety", "attacks_and_abuse", "application_injection"] },
  { id: "privacy", directories: ["privacy"] },
  { id: "business", directories: ["business_topics", "content_filters", "business_rules"] },
  { id: "reliability", directories: ["answer_reliability"] },
] as const;

export function GuardrailProtectionPicker({ policies, bindings, onChange, issueFor, expanded, onExpand, businessControls }: {
  policies: Policy[];
  bindings: GuardrailPolicyBinding[];
  onChange: (bindings: GuardrailPolicyBinding[]) => void;
  issueFor: (binding: GuardrailPolicyBinding) => string | null;
  expanded: string | null;
  onExpand: (id: string | null) => void;
  businessControls: ReactNode;
}) {
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  const prefix = useId();
  const [query, setQuery] = useState("");
  const [selectedOnly, setSelectedOnly] = useState(bindings.length > 0);
  useEffect(() => {
    if (!expanded) return;
    setQuery("");
    const target = Array.from(root.current?.querySelectorAll<HTMLButtonElement>("[data-configure-policy]") ?? [])
      .find(element => element.dataset.configurePolicy === expanded);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView?.({ block: "nearest" });
  }, [expanded]);

  // Include unavailable pinned bindings so they can be removed explicitly.
  const available = policies.filter(policy => bindings.some(binding => binding.policy_id === policy.id)
    || (policy.source === "built_in" || policy.version !== "0"));
  const missing = bindings.filter(binding => !policies.some(policy => policy.id === binding.policy_id));
  return <div ref={root} className="space-y-7">
    <div className="flex flex-wrap gap-2">
      <Input className="min-h-11 min-w-0 flex-1 basis-48" aria-label={t("protection.wizard.search")} placeholder={t("protection.wizard.search")} value={query} onChange={event => setQuery(event.target.value)} />
      <Button className="min-h-11" variant={selectedOnly ? "outline" : "secondary"} aria-pressed={!selectedOnly} onClick={() => setSelectedOnly(false)}>{t("protection.wizard.all")}</Button>
      <Button className="min-h-11" variant={selectedOnly ? "secondary" : "outline"} aria-pressed={selectedOnly} onClick={() => setSelectedOnly(true)}>{t("protection.wizard.selectedOnly", { count: bindings.length })}</Button>
    </div>
    {missing.map(binding => <div key={binding.policy_id} className="flex flex-wrap items-center gap-3 rounded-lg border p-4">
      <p className="min-w-0 flex-1 break-words text-sm text-destructive">{issueFor(binding)}</p>
      <Button className="min-h-11 h-auto max-w-full whitespace-normal break-words" variant="outline" onClick={() => onChange(bindings.filter(item => item.policy_id !== binding.policy_id))}>{t("protection.remove", { name: binding.policy_id })}</Button>
    </div>)}
    {groups.map(group => {
      const groupItems = available.filter(policy => (group.directories as readonly string[]).includes(policyDirectory(policy)));
      const items = groupItems.filter(policy => (!selectedOnly || bindings.some(binding => binding.policy_id === policy.id))
        && (!query.trim() || `${policy.name} ${policy.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) || expanded === policy.id));
      return <section key={group.id} aria-labelledby={`${prefix}-${group.id}`} className="space-y-3">
        <h4 id={`${prefix}-${group.id}`} className="text-sm font-semibold">{t(`protection.wizard.groups.${group.id}`)}</h4>
        {group.id === "business" ? businessControls : null}
        {items.length ? <div className="divide-y overflow-hidden rounded-lg border">
          {items.map(policy => {
            const binding = bindings.find(item => item.policy_id === policy.id);
            const pinned = binding ? boundPolicy(policies, binding) : policy;
            const issue = binding ? issueFor(binding) : null;
            const isOpen = expanded === policy.id && Boolean(binding);
            const panelId = `${prefix}-${policy.id}-config`;
            return <div key={policy.id}>
              <div className="flex flex-wrap items-center gap-x-2 px-3 py-2 sm:flex-nowrap">
                <label className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-start gap-3 py-2">
                  <Checkbox className="mt-0.5" aria-label={policy.name} checked={Boolean(binding)} onCheckedChange={checked => {
                    if (checked) onChange([...bindings, defaultPolicyBinding(policy)]);
                    else { onChange(bindings.filter(item => item.policy_id !== policy.id)); if (isOpen) onExpand(null); }
                  }} />
                  <span className="min-w-0 space-y-1">
                    <strong className="block text-sm font-medium">{pinned?.name ?? policy.name}</strong>
                    <span className="block text-xs leading-5 text-muted-foreground">{pinned?.description ?? policy.description}</span>
                    <span className="block text-xs leading-5 text-muted-foreground">{binding
                      ? `${binding.enabled_rails.map(rail => t(`protection.${rail}`)).join(" · ")} · ${t(issue ? "protection.needsSetup" : "protection.wizard.configured")}`
                      : t("protection.unset")}</span>
                  </span>
                </label>
                {binding ? <Button variant="ghost" className="ml-auto min-h-11 shrink-0" aria-label={t("protection.wizard.configurePolicy", { name: policy.name })}
                  data-configure-policy={policy.id} aria-expanded={isOpen} aria-controls={isOpen ? panelId : undefined}
                  onClick={() => onExpand(isOpen ? null : policy.id)}>
                  {t(issue ? "protection.needsSetup" : "protection.wizard.configure")}<ChevronDown className={isOpen ? "rotate-180" : ""} />
                </Button> : null}
              </div>
              {isOpen && binding ? <div id={panelId} className="space-y-3 border-t bg-muted/15 p-3 sm:p-4">
                {issue ? <p role="status" className="text-sm text-destructive">{issue}</p> : null}
                {pinned?.protection?.modelCapabilities.length ? <p className="text-xs leading-5 text-muted-foreground">{t("protection.modelHint")}</p> : null}
                {pinned?.protection?.requiredContext.length ? <p className="text-xs leading-5 text-muted-foreground">{t("protection.requiredContext", { context: pinned.protection.requiredContext.join(", ") })}</p> : null}
                {pinned?.protection?.limitations.length ? <details><summary className="min-h-11 cursor-pointer py-3 text-sm">{t("protection.limits")}</summary><ul className="list-disc space-y-2 pl-5 text-xs leading-5 text-muted-foreground">{pinned.protection.limitations.map(item => <li key={item}>{item}</li>)}</ul></details> : null}
                <PolicyBindingEditor policies={policies} value={[binding]} showSelector={false} embedded onChange={next => {
                  // A local edit must preserve every other binding and global order.
                  onChange(bindings.flatMap(item => item.policy_id === binding.policy_id ? next.filter(value => value.policy_id === binding.policy_id) : [item]));
                }} />
              </div> : null}
            </div>;
          })}
        </div> : <p className="text-xs leading-5 text-muted-foreground">{t(groupItems.length ? "protection.wizard.noMatches" : "protection.wizard.emptyGroup")}</p>}
      </section>;
    })}
  </div>;
}
