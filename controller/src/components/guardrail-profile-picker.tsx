import { useId } from "react";
import { useTranslation } from "react-i18next";
import { ChartNoAxesCombined, FilePlus2, Globe2, Headset, Landmark, ShieldCheck, type LucideIcon } from "lucide-react";
import type { GuardrailProfilePreview } from "@/lib/api";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

const profileIcons: Record<string, LucideIcon> = {
  general: ShieldCheck,
  banking: Landmark,
  securities: ChartNoAxesCombined,
  internet: Headset,
  singapore_finance: Globe2,
};

export function GuardrailProfilePicker({ presets, selected, pending, onSelect, onResolve }: {
  presets: GuardrailProfilePreview[]; selected: string; pending: string | null;
  onSelect: (id: string) => void; onResolve: (mode: "replace" | "add" | "cancel") => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const profile = presets.find(item => item.id === (pending ?? selected));
  const knownCategories = ["general", "banking", "securities", "internet", "singapore_finance"];
  const blankLabel = <span className="flex items-center gap-2"><FilePlus2 aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />{t("protection.blank")}</span>;
  const profileLabel = (item: GuardrailProfilePreview) => {
    const Icon = profileIcons[item.category ?? item.industry] ?? ShieldCheck;
    return <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-left">
    <span className="flex min-w-0 items-center gap-2 break-words"><Icon aria-hidden="true" className="size-4 shrink-0 text-primary" />{item.name}</span>
    {item.category ? <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-xs font-normal text-muted-foreground">{knownCategories.includes(item.category) ? t(`protection.profile.categories.${item.category}`) : item.categoryName ?? item.category}</Badge> : null}
    {item.isDefault ? <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-xs font-normal">{t("protection.profile.defaultTag")}</Badge> : null}
  </span>;
  };
  return <section className="space-y-3">
    <div className="space-y-2">
      <Label htmlFor={id} className="text-sm font-semibold">Profile</Label>
      <Select value={pending ?? selected} onValueChange={onSelect}>
        <SelectTrigger id={id} className="min-h-11 h-auto w-full bg-card py-2.5 text-sm [&>span]:min-w-0 [&>span]:whitespace-normal [&>span]:text-left">
          <SelectValue>{profile ? profileLabel(profile) : blankLabel}</SelectValue>
        </SelectTrigger>
        <SelectContent position="popper" align="start" className="w-(--radix-select-trigger-width)">
          <SelectItem value="blank" className="min-h-11">{blankLabel}</SelectItem>
          {presets.map(item => <SelectItem key={item.id} value={item.id} textValue={item.name} className="min-h-11 py-2.5">{profileLabel(item)}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
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
