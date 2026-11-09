import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { parsePhraseEntries, type PhraseEntry } from "../../shared/phrase-policy";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

/** Structured editing of a Policy parameter; no separate Guardrail rule state. */
export function PhrasePolicyEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useTranslation();
  let entries: PhraseEntry[] = [];
  let malformed = false;
  try {
    const parsed = JSON.parse(value || "[]");
    if (!Array.isArray(parsed) || parsed.some((entry) => !entry || typeof entry.phrase !== "string" || typeof entry.id !== "string")) malformed = true;
    else entries = parsed;
  } catch { malformed = true; }
  let invalid = false;
  try { parsePhraseEntries(value); } catch { invalid = true; }
  const save = (next: PhraseEntry[]) => onChange(JSON.stringify(next));
  const update = (index: number, patch: Partial<PhraseEntry>) => save(entries.map((entry, i) => i === index ? { ...entry, ...patch } : entry));
  function move(index: number, offset: number) {
    const next = [...entries];
    const [entry] = next.splice(index, 1);
    next.splice(index + offset, 0, entry!);
    save(next);
  }
  return <section className="min-w-0 space-y-3 sm:col-span-2" aria-label={t("protection.phrases.title")}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h5 className="text-sm font-medium">{t("protection.phrases.title")}</h5>
      <Button type="button" variant="outline" className="min-h-11" disabled={malformed || entries.length >= 50} onClick={() => save([...entries, { id: crypto.randomUUID(), phrase: "", action: "block", replacement: "[REDACTED]" }])}><Plus />{t("protection.phrases.add")}</Button>
    </div>
    <p className="text-xs leading-5 text-muted-foreground">{t("protection.phrases.hint")}</p>
    {malformed ? <p role="alert" className="text-sm text-destructive">{t("protection.phrases.malformed")}</p> : <ol className="divide-y rounded-lg border bg-card">
      {entries.map((entry, index) => <li key={entry.id} className="space-y-3 p-3">
        <div className="flex flex-wrap items-end gap-2">
          <label className="grid min-w-0 flex-[1_1_12rem] gap-2 text-xs font-medium">{t("protection.phrases.match", { index: index + 1 })}
            <Input className="field:min-h-11" value={entry.phrase} maxLength={240} onChange={(event) => update(index, { phrase: event.target.value })} />
          </label>
          <div className="ml-auto flex gap-1">
            <Button type="button" size="icon" variant="ghost" className="size-11" aria-label={t("protection.phrases.up", { index: index + 1 })} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp /></Button>
            <Button type="button" size="icon" variant="ghost" className="size-11" aria-label={t("protection.phrases.down", { index: index + 1 })} disabled={index === entries.length - 1} onClick={() => move(index, 1)}><ArrowDown /></Button>
            <Button type="button" size="icon" variant="ghost" className="size-11" aria-label={t("protection.phrases.remove", { index: index + 1 })} onClick={() => save(entries.filter((_, i) => i !== index))}><Trash2 /></Button>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
          <label className="grid gap-2 text-xs font-medium">{t("protection.phrases.action")}
            <Select value={entry.action} onValueChange={(action) => update(index, { action: action as PhraseEntry["action"] })}>
              <SelectTrigger className="field:min-h-11"><SelectValue /></SelectTrigger>
              <SelectContent>{(["allow", "block", "transform"] as const).map(action => <SelectItem key={action} value={action}>{t(`securityEvents.actions.${action}`)}</SelectItem>)}</SelectContent>
            </Select>
          </label>
          {entry.action === "transform" ? <label className="grid gap-2 text-xs font-medium">{t("protection.phrases.replacement")}
            <Input className="field:min-h-11" value={entry.replacement} maxLength={240} onChange={(event) => update(index, { replacement: event.target.value })} />
          </label> : null}
        </div>
      </li>)}
      {!entries.length ? <li className="p-4 text-sm text-muted-foreground">{t("protection.phrases.empty")}</li> : null}
    </ol>}
    {invalid && !malformed ? <p role="status" className="text-xs text-destructive">{t("protection.phrases.incomplete")}</p> : null}
  </section>;
}
