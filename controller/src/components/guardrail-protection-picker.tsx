import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { BadgeCheck, ChevronDown, LockKeyhole, MessagesSquare, SlidersHorizontal, ShieldCheck, Fingerprint } from "lucide-react";
import { useTranslation } from "react-i18next";
import { boundPolicy } from "@/lib/bound-policy";
import { policyDirectory } from "@/lib/protection-composition";
import { policyRequiresTopicModel } from "@/lib/protection-requirements";
import type { GuardrailPolicyBinding, Policy } from "@/lib/api";
import { PolicyBindingEditor, defaultPolicyBinding } from "./policy-binding-editor";
import { Checkbox } from "./ui/checkbox";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Input } from "./ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

export type ProtectionSection = "safety" | "privacy" | "business" | "topics" | "reliability";
const sections = [
  { id: "safety", icon: ShieldCheck },
  { id: "privacy", icon: Fingerprint },
  { id: "business", icon: SlidersHorizontal },
  { id: "topics", icon: MessagesSquare },
  { id: "reliability", icon: BadgeCheck },
] as const;

export function protectionSection(policy: Policy): ProtectionSection {
  if (policyRequiresTopicModel(policy)) return "topics";
  const directory = policyDirectory(policy);
  if (directory === "privacy") return "privacy";
  if (directory === "answer_reliability") return "reliability";
  if (["content_safety", "attacks_and_abuse", "application_injection"].includes(directory)) return "safety";
  return "business";
}


export function GuardrailProtectionPicker({ policies, bindings, onChange, issueFor, expanded, onExpand, businessControls, correctnessControls, correctnessStatus, unavailableReason, section, onSectionChange, topicUnavailable = false }: {
  policies: Policy[];
  bindings: GuardrailPolicyBinding[];
  onChange: (bindings: GuardrailPolicyBinding[]) => void;
  issueFor: (binding: GuardrailPolicyBinding) => string | null;
  expanded: string | null;
  onExpand: (id: string | null) => void;
  businessControls: ReactNode;
  correctnessControls?: ReactNode;
  correctnessStatus?: "available" | "partial" | "unavailable";
  unavailableReason?: (policy: Policy) => string | null;
  section: ProtectionSection;
  onSectionChange: (section: ProtectionSection) => void;
  topicUnavailable?: boolean;
}) {
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  const previousSection = useRef(section);
  const prefix = useId();
  const [query, setQuery] = useState("");
  const [selectedOnly, setSelectedOnly] = useState(bindings.length > 0);

  useEffect(() => {
    if (previousSection.current === section) return;
    previousSection.current = section;
    root.current?.scrollIntoView?.({ block: "start" });
  }, [section]);

  useEffect(() => {
    if (!expanded) return;
    setQuery("");
    const policy = policies.find(item => item.id === expanded);
    if (policy) { onSectionChange(protectionSection(policy)); }
  }, [expanded, policies, onSectionChange]);
  useEffect(() => {
    if (!expanded) return;
    const target = Array.from(root.current?.querySelectorAll<HTMLButtonElement>("[data-configure-policy]") ?? [])
      .find(element => element.dataset.configurePolicy === expanded);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView?.({ block: "nearest" });
  }, [expanded, section]);

  const available = policies.filter(policy => bindings.some(binding => binding.policy_id === policy.id)
    || (policy.source === "built_in" || policy.version !== "0"));
  const missing = bindings.filter(binding => !policies.some(policy => policy.id === binding.policy_id));
  const sectionItems = available.filter(policy => protectionSection(policy) === section);
  const groupItems = sectionItems;
  const items = groupItems.filter(policy => (!selectedOnly || bindings.some(binding => binding.policy_id === policy.id))
    && (!query.trim() || `${policy.name} ${policy.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) || expanded === policy.id));
  const selectedCount = (id: ProtectionSection) => bindings.filter(binding => {
    const policy = boundPolicy(policies, binding);
    return policy && protectionSection(policy) === id;
  }).length;

  return <div ref={root} className="space-y-4">
    {missing.map(binding => <div key={binding.policy_id} className="flex flex-wrap items-center gap-3 rounded-lg border p-4">
      <p className="min-w-0 flex-1 break-words text-sm text-destructive">{issueFor(binding)}</p>
      <Button className="min-h-11 h-auto max-w-full whitespace-normal break-words" variant="outline" onClick={() => onChange(bindings.filter(item => item.policy_id !== binding.policy_id))}>{t("protection.remove", { name: binding.policy_id })}</Button>
    </div>)}
    <Tabs value={section} onValueChange={value => { onSectionChange(value as ProtectionSection); onExpand(null); setQuery(""); }} className="gap-5">
      <TabsList aria-label={t("protection.wizard.sections.navigation")} className="grid h-auto w-full grid-cols-2 gap-1 sm:sticky sm:top-0 sm:z-10 md:grid-cols-3 xl:grid-cols-5 rounded-lg border bg-background p-1 shadow-sm">
        {sections.map(({ id, icon: Icon }) => <TabsTrigger key={id} value={id} className="h-auto min-h-16 min-w-0 flex-col items-start gap-2 rounded-md px-2 py-3 whitespace-normal text-left data-[state=active]:bg-primary/10 data-[state=active]:text-primary after:hidden last:col-span-2 md:last:col-span-1 sm:px-3">
          <span className="flex items-center gap-2 text-sm font-semibold sm:text-base"><Icon className="hidden size-4 sm:block" />{t(`protection.wizard.sections.${id}`)}</span>
          {(id === "topics" && topicUnavailable) || (id === "reliability" && correctnessStatus === "unavailable")
            ? <Badge variant="destructive"><LockKeyhole aria-hidden="true" />{t("protection.wizard.sections.unavailable")}</Badge>
            : id === "reliability" && correctnessStatus === "partial"
              ? <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400">{t("protection.wizard.sections.partial")}</Badge>
              : <span className="text-xs font-normal text-muted-foreground">{t("protection.wizard.sections.selected", { count: selectedCount(id) })}</span>}
        </TabsTrigger>)}
      </TabsList>
      <TabsContent value={section} className="space-y-5">
        <header className="space-y-1 border-b pb-4">
          <h4 className="text-xl font-semibold tracking-tight">{t(`protection.wizard.sections.${section}`)}</h4>
          <p className="text-sm leading-6 text-muted-foreground">{t(`protection.wizard.sections.${section}Hint`)}</p>
        </header>
        {section === "topics" ? businessControls : section === "reliability" ? correctnessControls : null}
        {sectionItems.length ? <>
          <div className="flex flex-wrap gap-2">
            <Input className="min-h-11 min-w-0 flex-1 basis-48 bg-card" aria-label={t("protection.wizard.search")} placeholder={t("protection.wizard.search")} value={query} onChange={event => setQuery(event.target.value)} />
            <Button className="min-h-11" variant={selectedOnly ? "outline" : "secondary"} aria-pressed={!selectedOnly} onClick={() => setSelectedOnly(false)}>{t("protection.wizard.all")}</Button>
            <Button className="min-h-11" variant={selectedOnly ? "secondary" : "outline"} aria-pressed={selectedOnly} onClick={() => setSelectedOnly(true)}>{t("protection.wizard.selectedOnly", { count: selectedCount(section) })}</Button>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">{t("protection.wizard.sections.selectionHint")}</p>
        </> : null}
        {items.length ? <div className="divide-y overflow-hidden rounded-lg border bg-card">
          {items.map(policy => {
            const binding = bindings.find(item => item.policy_id === policy.id);
            const pinned = binding ? boundPolicy(policies, binding) : policy;
            const issue = binding ? issueFor(binding) : null;
            const unavailable = unavailableReason?.(pinned ?? policy);
            const isOpen = expanded === policy.id && Boolean(binding) && !unavailable;
            const panelId = `${prefix}-${policy.id}-config`;
            return <div key={policy.id} className={binding ? "border-l-2 border-l-primary bg-primary/5" : "border-l-2 border-l-transparent"}>
              <div className="flex flex-wrap items-center gap-x-2 px-4 py-3 sm:flex-nowrap">
                <label className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-start gap-3 py-1">
                  <Checkbox className="mt-0.5" aria-label={policy.name} aria-describedby={unavailable ? `${panelId}-unavailable` : undefined} disabled={Boolean(unavailable) && !binding} checked={Boolean(binding)} onCheckedChange={checked => {
                    if (checked) { if (unavailable) return; onChange([...bindings, defaultPolicyBinding(policy)]); }
                    else { onChange(bindings.filter(item => item.policy_id !== policy.id)); if (isOpen) onExpand(null); }
                  }} />
                  <span className="min-w-0 space-y-1">
                    <strong className="block text-sm font-semibold">{pinned?.name ?? policy.name}</strong>
                    <span className="block text-sm leading-6 text-muted-foreground">{pinned?.description ?? policy.description}</span>
                    <span className="block text-xs leading-5 text-muted-foreground">{binding
                      ? `${binding.enabled_rails.map(rail => t(`protection.${rail}`)).join(" · ")} · ${t(issue ? "protection.needsSetup" : "protection.wizard.configured")}`
                      : t("protection.wizard.sections.notEnabled")}</span>
                    {unavailable ? <span id={`${panelId}-unavailable`} className="block text-xs leading-5 text-muted-foreground">{unavailable}</span> : null}
                  </span>
                </label>
                {binding ? <Button variant="ghost" className="ml-auto min-h-11 shrink-0" aria-label={t("protection.wizard.configurePolicy", { name: policy.name })}
                  disabled={Boolean(unavailable)}
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
                <h5 className="text-sm font-semibold">{t("protection.wizard.sections.configuration")}</h5>
                <PolicyBindingEditor policies={policies} value={[binding]} showSelector={false} embedded onChange={next => {
                  // A local edit must preserve every other binding and global order.
                  onChange(bindings.flatMap(item => item.policy_id === binding.policy_id ? next.filter(value => value.policy_id === binding.policy_id) : [item]));
                }} />
              </div> : null}
            </div>;
          })}
        </div> : section !== "topics" || !topicUnavailable ? <p className="text-sm text-muted-foreground">{t(groupItems.length ? "protection.wizard.noMatches" : "protection.wizard.emptyGroup")}</p> : null}
      </TabsContent>
    </Tabs>
  </div>;
}
