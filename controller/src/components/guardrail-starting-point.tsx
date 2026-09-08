import { useId } from "react";
import { useTranslation } from "react-i18next";
import { ChartNoAxesCombined, FilePlus2, Globe2, Headset, Landmark, ShieldCheck, type LucideIcon } from "lucide-react";
import type { Policy, ProtectionPresetPreview } from "@/lib/api";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

const presetIcons: Record<string, LucideIcon> = {
  "common-baseline": ShieldCheck,
  "banking-assistant": Landmark,
  "securities-assistant": ChartNoAxesCombined,
  "internet-customer-support": Headset,
  "singapore-financial-assistant": Globe2,
};

function presetIcon(preset: ProtectionPresetPreview): LucideIcon {
  return presetIcons[preset.id] ?? ({ banking: Landmark, securities: ChartNoAxesCombined, internet: Headset, general: ShieldCheck }[preset.industry] ?? ShieldCheck);
}

export function GuardrailStartingPoint({ presets, policies, selected, pending, onSelect, onResolve }: {
  presets: ProtectionPresetPreview[]; policies: Policy[]; selected: string; pending: string | null;
  onSelect: (id: string) => void; onResolve: (mode: "replace" | "add" | "cancel") => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const preset = presets.find(item => item.id === (pending ?? selected));
  const PresetIcon = preset ? presetIcon(preset) : FilePlus2;
  return <section className="space-y-3 border-t pt-5">
    <Label htmlFor={id}>{t("protection.preset")}</Label>
    <Select value={pending ?? selected} onValueChange={onSelect}>
      <SelectTrigger id={id} className="min-h-11 bg-card"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="blank" className="min-h-11"><FilePlus2 aria-hidden="true" className="size-4 text-muted-foreground" />{t("protection.blank")}</SelectItem>
        {presets.map(item => {
          const Icon = presetIcon(item);
          return <SelectItem key={item.id} value={item.id} className="min-h-11"><Icon aria-hidden="true" className="size-4 text-primary" />{item.name}</SelectItem>;
        })}
      </SelectContent>
    </Select>
    <p className="text-sm leading-6 text-muted-foreground">{t("protection.wizard.presetHint")}</p>
    {preset ? <div className="space-y-2 rounded-lg border p-4">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary"><PresetIcon aria-hidden="true" className="size-5" /></span>
        <div className="min-w-0">
          <h4 className="text-sm font-medium leading-6">{preset.name}</h4>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">{preset.description}</p>
        </div>
      </div>
      <details><summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">{t("protection.included")} · {preset.bindings.length}</summary>
        <ul className="list-disc space-y-2 pl-5 text-sm text-muted-foreground">{preset.bindings.map(binding => <li key={binding.policy_id}>{policies.find(policy => policy.id === binding.policy_id)?.name ?? binding.policy_id} · v{binding.policy_version}</li>)}</ul>
      </details>
      {preset.limitations.length ? <details><summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">{t("protection.limits")}</summary><ul className="list-disc space-y-2 pl-5 text-xs leading-5 text-muted-foreground">{preset.limitations.map(item => <li key={item}>{item}</li>)}</ul></details> : null}
    </div> : null}
    {pending !== null ? <div className="space-y-3 rounded-lg border p-4">
      <p role="status" className="text-sm leading-6">{t("protection.wizard.switchHint")}</p>
      <div className="flex flex-wrap gap-2">
        {pending !== "blank" ? <Button className="min-h-11" variant="outline" onClick={() => onResolve("add")}>{t("protection.wizard.addPreset")}</Button> : null}
        <Button className="min-h-11" variant="outline" onClick={() => onResolve("replace")}>{t("protection.wizard.replacePreset")}</Button>
        <Button className="min-h-11" variant="ghost" onClick={() => onResolve("cancel")}>{t("common.cancel")}</Button>
      </div>
    </div> : null}
  </section>;
}
