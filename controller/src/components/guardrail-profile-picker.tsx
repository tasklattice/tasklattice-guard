import { useId } from "react";
import { useTranslation } from "react-i18next";
import { ChartNoAxesCombined, FilePlus2, Globe2, Headset, Landmark, ShieldCheck, type LucideIcon } from "lucide-react";
import type { GuardrailProfilePreview } from "@/lib/api";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import "./guardrail-profile-picker.scss";

const profileIcons: Record<string, LucideIcon> = {
  general: ShieldCheck,
  banking: Landmark,
  securities: ChartNoAxesCombined,
  internet: Headset,
  singapore_finance: Globe2,
  china_mainland: Globe2,
  china_banking: Landmark,
};

export function GuardrailProfilePicker({ presets, selected, pending, onSelect, onResolve }: {
  presets: GuardrailProfilePreview[]; selected: string; pending: string | null;
  onSelect: (id: string) => void; onResolve: (mode: "replace" | "add" | "cancel") => void;
}) {
  const { t: uiText } = useTranslation();
  const { t } = useTranslation();
  const id = useId();
  const profile = presets.find(item => item.id === (pending ?? selected));
  const knownCategories = ["general", "banking", "securities", "internet", "singapore_finance", "china_mainland", "china_banking"];
  const blankLabel = <span className="flex items-center gap-2"><FilePlus2 aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />{t("protection.blank")}</span>;
  const profileLabel = (item: GuardrailProfilePreview) => {
    const Icon = profileIcons[item.category ?? item.industry] ?? ShieldCheck;
    return <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-left">
    <span className="flex min-w-0 items-center gap-2 break-words"><Icon aria-hidden="true" className="size-4 shrink-0 text-primary" />{item.name}</span>
    {item.category && item.categoryName !== item.name ? <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-xs font-normal text-muted-foreground">{knownCategories.includes(item.category) ? t(`protection.profile.categories.${item.category}`) : item.categoryName ?? item.category}</Badge> : null}
    {item.availability?.available === false ? <Badge variant="destructive">{t("protection.profile.unavailable")}</Badge> : null}
    {item.isDefault ? <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-xs font-normal">{t("protection.profile.defaultTag")}</Badge> : null}
  </span>;
  };
  return <section className="space-y-3">
    <div className="space-y-2">
      <Label htmlFor={id} className="text-sm font-semibold">{uiText("uiCopy.profile")}</Label>
      <Select value={pending ?? selected} onValueChange={onSelect}>
        <SelectTrigger id={id} className="guardrail-profile-select field:min-h-11 field:h-auto w-full field:bg-card field:py-2.5 field:text-sm field:[&>span]:min-w-0 field:[&>span]:whitespace-normal field:[&>span]:text-left">
          <SelectValue>{profile ? profileLabel(profile) : blankLabel}</SelectValue>
        </SelectTrigger>
        <SelectContent position="popper" align="start" className="">
          <SelectItem value="blank" className="min-h-11">{blankLabel}</SelectItem>
          {presets.map(item => <SelectItem key={item.id} value={item.id} textValue={item.name} disabled={item.availability?.available === false} className="min-h-11 py-2.5">{profileLabel(item)}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
    {profile ? <div className="space-y-2 text-sm leading-6">
      <p>{profile.description}</p>
      {profile.version ? <p className="text-xs text-muted-foreground">{t("protection.profile.version", { version: profile.version, count: profile.bindings.length, rules: profile.bindings.reduce((sum, binding) => sum + binding.enabled_rule_ids.length, 0) })}</p> : null}
      {profile.availability?.available === false ? <p role="alert" className="text-destructive">{profile.availability.reason}</p> : null}
      {profile.limitations.length ? <details><summary className="cursor-pointer text-muted-foreground">{t("protection.profile.scope")}</summary><ul className="list-disc space-y-1 pl-5">{profile.limitations.map(item => <li key={item}>{item}</li>)}</ul></details> : null}
    </div> : null}
    {presets.some(item => item.availability?.available === false) ? <div role="status" className="text-sm text-amber-800">{presets.filter(item => item.availability?.available === false).map(item => <p key={item.id}>{item.name}: {item.availability?.reason}</p>)}</div> : null}
    {pending !== null ? <div className="space-y-3 rounded-lg border bg-card p-4">
      <p role="status" className="text-sm leading-6">{t("protection.wizard.switchHint")}</p>
      <div className="flex flex-wrap gap-2">
        {pending !== "blank" ? <Button className="min-h-11" variant="outline" onClick={() => onResolve("add")}>{t("protection.wizard.addPreset")}</Button> : null}
        <Button className="min-h-11" variant="outline" onClick={() => onResolve("replace")}>{t("protection.wizard.replacePreset")}</Button>
        <Button className="min-h-11" variant="ghost" onClick={() => onResolve("cancel")}>{t("common.cancel")}</Button>
      </div>
    </div> : null}
  </section>;
}
