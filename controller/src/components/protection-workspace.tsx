import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { boundPolicy } from "@/lib/bound-policy";
import { protectionDirectories, type ProtectionDirectoryId } from "../../shared/protection-map";
import { PolicyBindingEditor, defaultPolicyBinding } from "./policy-binding-editor";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { policyDirectory } from "@/lib/protection-composition";
import type { GuardrailPolicyBinding, Policy, ProtectionPresetPreview } from "@/lib/api";

export function ProtectionPresetPicker({ presets, policies, selected, onSelect, onApply }: {
  presets: ProtectionPresetPreview[]; policies: Policy[]; selected: string;
  onSelect: (id: string) => void; onApply: (preset: ProtectionPresetPreview) => void;
}) {
  const { t } = useTranslation();
  const preset = presets.find((item) => item.id === selected);
  return <section className="space-y-4 border-t pt-5">
    <label className="block space-y-2 text-sm font-medium">
      <span>{t("protection.preset")}</span>
      <Select value={selected} onValueChange={onSelect}>
        <SelectTrigger className="min-h-11 bg-card"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="blank">{t("protection.blank")}</SelectItem>
          {presets.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}
        </SelectContent>
      </Select>
    </label>
    <p className="text-sm leading-6 text-muted-foreground">{t("protection.presetHint")}</p>
    {preset ? <div className="overflow-hidden rounded-xl border bg-card">
      <div className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h4 className="font-semibold">{preset.name}</h4>
          <Badge variant="secondary">{t("protection.localBaseline")}</Badge>
        </div>
        <p className="text-sm leading-6 text-muted-foreground">{preset.description}</p>
        <dl className="divide-y">
          {protectionDirectories.map((directory) => {
            const items = preset.bindings.filter((binding) => policies.some((policy) => policy.id === binding.policy_id && policyDirectory(policy) === directory.id));
            return <div key={directory.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 py-2 text-sm">
              <dt>{t(`protection.directories.${directory.id}`)}</dt>
              <dd className={items.length ? "font-medium" : "text-muted-foreground"}>{items.length ? t("protection.presetIncludes", { count: items.length }) : t("protection.presetExcludes")}</dd>
            </div>;
          })}
        </dl>
        <details>
          <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">{t("protection.included")} · {preset.bindings.length}</summary>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">{preset.bindings.map((binding) => <li key={binding.policy_id}>{policies.find((item) => item.id === binding.policy_id)?.name ?? binding.policy_id} <span className="font-mono text-xs">v{binding.policy_version}</span></li>)}</ol>
        </details>
        <details>
          <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">{t("protection.limits")}</summary>
          <ul className="list-disc space-y-2 pl-5 text-xs leading-5 text-muted-foreground">{preset.limitations.map((item) => <li key={item}>{item}</li>)}</ul>
        </details>
        <Button className="min-h-11" onClick={() => onApply(preset)}><Plus />{t("protection.apply")}</Button>
      </div>
    </div> : null}
  </section>;
}

export function ProtectionDirectoryEditor({ directory, policies, bindings, onChange }: {
  directory: ProtectionDirectoryId; policies: Policy[]; bindings: GuardrailPolicyBinding[];
  onChange: (bindings: GuardrailPolicyBinding[]) => void;
}) {
  const { t } = useTranslation();
  const available = policies.filter((policy) => policyDirectory(policy) === directory && (policy.source === "built_in" || policy.version !== "0")
    && (!policy.protection?.legacyCollection || bindings.some((binding) => binding.policy_id === policy.id)));
  return <div className="space-y-5">
    {available.length ? <div className="divide-y overflow-hidden rounded-xl border bg-card">
      {available.map((policy) => {
        const selected = bindings.some((binding) => binding.policy_id === policy.id);
        const model = Boolean(policy.protection?.modelCapabilities.length);
        return <div key={policy.id} className={selected ? "bg-primary/[0.025]" : undefined}>
          <label className="flex min-h-16 w-full cursor-pointer items-start gap-3 px-4 py-3 text-left hover:bg-muted/40">
            <Checkbox className="mt-0.5 shrink-0" aria-label={policy.name} checked={selected}
              onCheckedChange={(checked) => onChange(checked ? [...bindings, defaultPolicyBinding(policy)] : bindings.filter((binding) => binding.policy_id !== policy.id))} />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1"><strong className="text-sm font-medium">{policy.name}</strong><span className="text-xs text-muted-foreground">v{policy.version}</span></span>
              <span className="mt-1 block text-xs leading-5 text-muted-foreground">{policy.description}</span>
              <span className="mt-2 flex flex-wrap gap-2">
                <Badge variant="secondary">{t(model ? "protection.model" : policy.protection?.execution === "local" ? "protection.local" : "protection.custom")}</Badge>
                {policy.rails.filter((rail) => rail === "input" || rail === "output").map((rail) => <Badge key={rail} variant="outline">{t(`protection.${rail}`)}</Badge>)}
                <span className="text-xs text-muted-foreground">{t("policyLibrary.testCount", { count: policy.test_count })}</span>
              </span>
            </span>
          </label>
          {selected && (model || policy.protection?.requiredContext.length || policy.protection?.limitations.length) ? <div className="space-y-2 px-4 pb-3 pl-12 text-xs leading-5 text-muted-foreground">
            {model ? <p>{t("protection.modelHint")}</p> : null}
            {policy.protection?.requiredContext.length ? <p>{t("protection.requiredContext", { context: policy.protection.requiredContext.join(", ") })}</p> : null}
            {policy.protection?.limitations.length ? <details><summary className="cursor-pointer py-1 font-medium">{t("protection.limits")}</summary><ul className="list-disc space-y-1 pl-4">{policy.protection.limitations.map((item) => <li key={item}>{item}</li>)}</ul></details> : null}
          </div> : null}
        </div>;
      })}
    </div> : <div className="rounded-lg border border-dashed p-5"><p className="text-sm font-medium">{t("protection.noAvailable")}</p><p className="mt-2 text-sm text-muted-foreground">{t("protection.noAvailableHint")}</p></div>}
    {bindings.length ? <PolicyBindingEditor policies={policies} value={bindings} onChange={onChange} showSelector={false} /> : null}
  </div>;
}

export function ProtectionOrderEditor({ bindings, policies, onChange }: {
  bindings: GuardrailPolicyBinding[]; policies: Policy[]; onChange: (bindings: GuardrailPolicyBinding[]) => void;
}) {
  const { t } = useTranslation();
  const movedControl = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    // Moving a keyed row can detach its focused button from the DOM.
    const button = movedControl.current;
    movedControl.current = null;
    if (button?.isConnected) button.focus();
  }, [bindings]);
  function move(index: number, offset: number, button: HTMLButtonElement) {
    if (index + offset < 0 || index + offset >= bindings.length) return;
    movedControl.current = document.activeElement === button ? button : null;
    const next = [...bindings];
    const [item] = next.splice(index, 1);
    next.splice(index + offset, 0, item!);
    onChange(next);
  }
  return <section className="space-y-3">
    <h4 className="text-sm font-semibold">{t("protection.order")}</h4>
    <p className="text-sm leading-6 text-muted-foreground">{t("protection.orderHint")}</p>
    <ol className="divide-y overflow-hidden rounded-xl border bg-card">
      {bindings.map((binding, index) => {
        const name = boundPolicy(policies, binding)?.name ?? binding.policy_id;
        return <li key={binding.policy_id} className="flex flex-wrap items-center gap-2 px-3 py-2">
          <span className="w-6 text-center font-mono text-xs text-muted-foreground">{index + 1}</span>
          <span className="min-w-0 flex-1 text-sm font-medium">{name}<span className="mt-0.5 block text-xs font-normal text-muted-foreground">{binding.enabled_rails.map((rail) => t(`protection.${rail}`)).join(" · ")} · v{binding.policy_version}</span></span>
          <div className="flex shrink-0 gap-1">
            <Button type="button" className="size-11 aria-disabled:opacity-50 aria-disabled:hover:bg-transparent" variant="ghost" size="icon" aria-disabled={index === 0} aria-label={t("protection.moveUp", { name })} onClick={event => move(index, -1, event.currentTarget)}><ArrowUp /></Button>
            <Button type="button" className="size-11 aria-disabled:opacity-50 aria-disabled:hover:bg-transparent" variant="ghost" size="icon" aria-disabled={index === bindings.length - 1} aria-label={t("protection.moveDown", { name })} onClick={event => move(index, 1, event.currentTarget)}><ArrowDown /></Button>
            <Button type="button" className="size-11" variant="ghost" size="icon" aria-label={t("protection.remove", { name })} onClick={() => onChange(bindings.filter((item) => item.policy_id !== binding.policy_id))}><Trash2 /></Button>
          </div>
        </li>;
      })}
    </ol>
  </section>;
}
