import { TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

export function ProviderTlsControl({ checked, disabled, onChange }: { checked: boolean; disabled?: boolean; onChange: (value: boolean) => void }) {
  const { t } = useTranslation();
  return <div className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
    <div className="flex items-start justify-between gap-4">
      <div className="flex min-w-0 items-start gap-2.5">
        <TriangleAlert className="mt-3.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
        <div><Label htmlFor="provider-skip-tls-verify" className="min-h-11 cursor-pointer">{t("providerRegistration.skipTlsVerify")}</Label><p className="mt-1 text-xs leading-5 text-muted-foreground">{t("providerRegistration.skipTlsHint")}</p></div>
      </div>
      <div className="flex min-h-11 items-center"><Switch id="provider-skip-tls-verify" aria-label={t("providerRegistration.skipTlsVerify")} aria-describedby={checked ? "provider-tls-warning" : undefined} checked={checked} disabled={disabled} className="after:-inset-y-3.5" onCheckedChange={onChange} /></div>
    </div>
    {checked ? <p id="provider-tls-warning" role="status" className="border-l-2 border-amber-500 pl-3 text-xs leading-5 text-amber-800 dark:text-amber-300">{t("providerRegistration.skipTlsWarning")}</p> : null}
  </div>;
}
