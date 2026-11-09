import { hasPermission } from "../../shared/rbac";
import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";
import { MenuItem, MenuItemDivider } from "@carbon/react";
import { EntitySheet } from "./entity-sheet";
import { ErrorNotice, StateBadge } from "./product-shell";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group";
import { Textarea } from "./ui/textarea";
import { toast } from "./ui/notifications";
import { useAuth } from "@/lib/auth";
import type { Guardrail } from "@/lib/api";
import { updateGuardrailProtectionMode } from "@/lib/guardrails-api";
import { protectionModes, type ProtectionMode, type ProtectionModeSettings } from "../../shared/protection-mode";

const modeTextClasses: Record<ProtectionMode, string> = {
  enforce: "text-[var(--success)]",
  monitor: "text-[var(--warning)]",
  bypass: "text-destructive",
};

// Keep mutation controls at the detail-page level so Actions works from every tab.
export function useGuardrailProtectionActions(guardrail: Guardrail | undefined, onChanged: () => Promise<unknown>) {
  const { t } = useTranslation();
  const canEdit = hasPermission(useAuth().user?.role, "guardrails", "write");
  const settings = guardrail?.protection;
  const menuRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState<ProtectionModeSettings | null>(null);
  const [mode, setMode] = useState<ProtectionMode>("enforce");
  const [reason, setReason] = useState("");
  const mutation = useMutation({
    mutationFn: (input: { mode: ProtectionMode; expectedGeneration: number; reason: string }) => {
      if (!guardrail) throw new Error(t("protectionMode.unavailable"));
      return updateGuardrailProtectionMode(guardrail.id, input);
    },
    onSuccess: async () => { setEditing(null); toast.success(t("protectionMode.submitted")); await onChanged(); },
  });
  const open = () => { if (settings?.ready && canEdit && !mutation.isPending) { returnFocusRef.current = menuRef.current?.querySelector("button") ?? null; mutation.reset(); setEditing(settings); setMode(settings.mode); setReason(""); } };
  const editable = Boolean(settings?.ready && canEdit);
  const retrying = editing?.status !== "applied" && mode === editing?.mode;

  return {
    menuRef,
    menuItems: canEdit ? [
      <MenuItem key="change-mode" label={t("protectionMode.change")} aria-label={t("protectionMode.change")} renderIcon={ShieldCheck} disabled={!editable || mutation.isPending} onClick={open} />,
      <MenuItemDivider key="mode-divider" />,
    ] : null,
    feedback: canEdit ? <>
    {editing && guardrail ? <EntitySheet open width="md" returnFocusRef={returnFocusRef} closeDisabled={mutation.isPending} onOpenChange={value => { if (!value) setEditing(null); }}
      eyebrow={guardrail.name} title={t("protectionMode.change")} description={t("protectionMode.scope")}
      footer={<><Button variant="outline" disabled={mutation.isPending} onClick={() => setEditing(null)}>{t("common.cancel")}</Button>
        <Button disabled={mutation.isPending || (mode === editing.mode && !retrying) || !editable} onClick={() => mutation.mutate({ mode, expectedGeneration: editing.generation, reason })}>
          {mutation.isPending ? <LoaderCircle className="animate-spin motion-reduce:animate-none" /> : retrying ? <RefreshCw /> : null}
          {t(mutation.isPending ? "common.saving" : retrying ? "protectionMode.retry" : mode === "bypass" ? "protectionMode.enableBypass" : "protectionMode.apply")}
        </Button></>}>
      <div className="space-y-6">
        <RadioGroup value={mode} onValueChange={value => { setMode(value as ProtectionMode); mutation.reset(); }} orientation="vertical" disabled={mutation.isPending} legendText={t("protectionMode.title")}>
          {protectionModes.map(value => <div key={value} className="flex min-h-11 items-start gap-3 py-3">
            <RadioGroupItem id={`protection-${value}`} value={value} aria-label={t(`states.${value}`)} />
            <div><Label htmlFor={`protection-${value}`}><span className={`font-sans text-sm font-semibold ${modeTextClasses[value]}`}>{t(`states.${value}`)}</span></Label><p className="mt-1 text-sm leading-6 text-muted-foreground">{t(`protectionMode.descriptions.${value}`)}</p></div>
          </div>)}
        </RadioGroup>
        <div className="space-y-2"><Label htmlFor="protection-reason">{t("protectionMode.reason")}</Label><Textarea id="protection-reason" value={reason} maxLength={500} disabled={mutation.isPending} onChange={event => setReason(event.target.value)} /></div>
        {mutation.error ? <><ErrorNotice error={mutation.error} /><Button variant="outline" disabled={mutation.isPending} onClick={async () => { await onChanged(); setEditing(null); }}>{t("resourceList.refresh")}</Button></> : null}
      </div>
    </EntitySheet> : null}
    </> : null,
  };
}

export function GuardrailProtectionMode({ guardrail }: { guardrail: Guardrail }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const settings = guardrail.protection;
  const pending = settings?.ready && settings.status !== "applied";
  return <>
    <div className="flex flex-wrap items-center gap-2">
      {settings?.ready ? <button ref={triggerRef} type="button" className="inline-flex min-h-11 items-center rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary" aria-label={t("protectionMode.details")} title={t("protectionMode.details")} onClick={() => setOpen(true)}><StateBadge state={guardrail.status} /></button> : <StateBadge state={guardrail.status} />}
      {pending ? <span role="status" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        {settings.status !== "failed" ? <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
        {t(`protectionMode.states.${settings.status}`)} · {t("protectionMode.switching", { mode: t(`states.${settings.mode}`) })} · {t("protectionMode.progress", settings)}
      </span> : null}
    </div>
    {open && settings ? <EntitySheet open width="md" returnFocusRef={triggerRef} onOpenChange={setOpen} eyebrow={guardrail.name} title={t("protectionMode.details")} description={null} footer={<Button variant="outline" onClick={() => setOpen(false)}>{t("common.close")}</Button>}>
      <div className="space-y-4 text-sm">
        <p>{t(`protectionMode.states.${settings.status}`)} · {t("protectionMode.progress", settings)}</p>
        <ul className="divide-y border-y">{settings.runners.map(runner => <li key={runner.runnerId} className="flex items-start justify-between gap-5 py-3">
          <span className="font-mono text-xs">{runner.runnerId}</span><span>{t(`protectionMode.runners.${runner.status}`)}{runner.reason ? ` · ${runner.reason}` : ""}</span>
        </li>)}</ul>
        {settings.updatedAt ? <p className="text-xs text-muted-foreground">{t("protectionMode.updated", { time: new Date(settings.updatedAt).toLocaleString(i18n.language), actor: settings.updatedBy ?? t("protectionMode.system") })}</p> : null}
        {settings.reason ? <p className="text-xs text-muted-foreground">{t("protectionMode.reasonValue", { reason: settings.reason })}</p> : null}
      </div>
    </EntitySheet> : null}
  </>;
}
