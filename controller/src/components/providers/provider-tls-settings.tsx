import { useMutation } from "@tanstack/react-query";
import { LoaderCircle, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { EntitySheet } from "@/components/entity-sheet";
import { Button } from "@/components/ui/button";
import { updateProviderTls, type ModelProvider } from "@/lib/controller-api";
import { ProviderTlsControl } from "./provider-tls-control";

export function ProviderTlsSettings({ provider, disabled, onChanged }: { provider: ModelProvider; disabled: boolean; onChanged: () => Promise<void> }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [skipTlsVerify, setSkipTlsVerify] = useState(provider.skipTlsVerify ?? false);
  const update = useMutation({
    mutationFn: () => updateProviderTls(provider.id, skipTlsVerify),
    onSuccess: async () => { await onChanged(); },
  });
  if (!provider.baseUrl.startsWith("https:")) return null;
  const changeOpen = (next: boolean) => {
    if (update.isPending) return;
    setOpen(next);
    if (next) { setSkipTlsVerify(provider.skipTlsVerify ?? false); update.reset(); }
  };
  return <>
    <Button type="button" variant="outline" className="h-11" disabled={disabled} aria-label={`${t("providerRegistration.tlsSettings")} ${provider.name}`} onClick={() => changeOpen(true)}><ShieldCheck />{t("providerRegistration.tlsSettings")}</Button>
    <EntitySheet
      open={open}
      closeDisabled={update.isPending}
      onOpenChange={changeOpen}
      eyebrow={t("modelSettings.confirmChangeEyebrow")}
      title={`${t("providerRegistration.tlsSettings")} · ${provider.name}`}
      description={t("providerRegistration.tlsSettingsDescription")}
      width="md"
      density="compact"
      footer={<>
        <Button type="button" variant="outline" disabled={update.isPending} onClick={() => changeOpen(false)}>{t("common.cancel")}</Button>
        <Button type="button" disabled={disabled || update.isPending || skipTlsVerify === (provider.skipTlsVerify ?? false)} onClick={() => update.mutate()}>{update.isPending ? <LoaderCircle className="animate-spin motion-reduce:animate-none" /> : <ShieldCheck />}{t("providerRegistration.saveTls")}</Button>
      </>}
    >
      <div className="space-y-4">
      <div><h3 className="font-semibold">{provider.name}</h3><code className="mt-1 block break-all text-xs text-muted-foreground">{provider.baseUrl}</code></div>
      <ProviderTlsControl checked={skipTlsVerify} disabled={disabled || update.isPending} onChange={(next) => { setSkipTlsVerify(next); update.reset(); }} />
      {update.error ? <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">{update.error.message}</p> : null}
      {update.data ? <p role={update.data.status === "failed" ? "alert" : "status"} className={update.data.status === "failed" ? "rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive" : "rounded-lg border bg-muted/35 px-4 py-3 text-sm text-muted-foreground"}>{t("providerRegistration.tlsSaved")} {update.data.validationMessage}</p> : null}
      </div>
    </EntitySheet>
  </>;
}
