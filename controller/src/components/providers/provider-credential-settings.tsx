import { useMutation } from "@tanstack/react-query";
import { KeyRound, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { EntitySheet } from "@/components/entity-sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { updateModelProviderCredential, type ModelProvider } from "@/lib/controller-api";

export function ProviderCredentialSettings({ provider, disabled, onChanged }: {
  provider: ModelProvider;
  disabled: boolean;
  onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const formId = `provider-credential-update-${provider.id}`;
  const inputId = `provider-new-credential-${provider.id}`;
  const [open, setOpen] = useState(false);
  const [credential, setCredential] = useState("");
  const update = useMutation({
    mutationFn: () => updateModelProviderCredential(provider.id, credential),
    onSuccess: async (result) => {
      setCredential("");
      await onChanged();
      if (result.status === "validated") {
        toast.success(t("modelSettings.credentialVerified"));
        setOpen(false);
      } else {
        toast.error(t("modelSettings.credentialVerificationFailed"));
      }
    },
  });
  const changeOpen = (next: boolean) => {
    if (update.isPending) return;
    setOpen(next);
    if (next) {
      setCredential("");
      update.reset();
    }
  };

  return <>
    <Button
      type="button"
      variant="outline"
      className="h-11"
      disabled={disabled}
      aria-label={`${t("modelSettings.updateCredential")} ${provider.name}`}
      onClick={() => changeOpen(true)}
    >
      <KeyRound />{t("modelSettings.credential")}
    </Button>
    <EntitySheet
      open={open}
      closeDisabled={update.isPending}
      onOpenChange={changeOpen}
      eyebrow={t("modelSettings.confirmChangeEyebrow")}
      title={`${t("modelSettings.updateCredential")} · ${provider.name}`}
      description={t("modelSettings.updateCredentialDescription")}
      width="md"
      density="compact"
      footer={<>
        <Button type="button" variant="outline" disabled={update.isPending} onClick={() => changeOpen(false)}>{t("common.cancel")}</Button>
        <Button type="submit" form={formId} disabled={disabled || update.isPending || !credential.trim()}>
          {update.isPending ? <LoaderCircle className="animate-spin motion-reduce:animate-none" /> : <KeyRound />}
          {t(update.isPending ? "modelSettings.verifyingCredential" : "modelSettings.saveAndVerifyCredential")}
        </Button>
      </>}
    >
      <form id={formId} className="space-y-5" onSubmit={(event) => { event.preventDefault(); update.mutate(); }}>
        <section className="rounded-lg border bg-muted/25 px-4 py-3">
          <h3 className="font-semibold">{provider.name}</h3>
          <code className="mt-1 block break-all text-xs text-muted-foreground">{provider.baseUrl}</code>
          <p className="mt-3 text-xs text-muted-foreground">{t("modelSettings.currentCredential", { credential: provider.credentialHint ?? t("modelSettings.notConfigured") })}</p>
        </section>
        <div className="space-y-2">
          <Label htmlFor={inputId}>{t("modelSettings.newCredential")}</Label>
          <Input
            id={inputId}
            className="h-11 font-mono"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            required
            maxLength={8_192}
            value={credential}
            onChange={(event) => { setCredential(event.target.value); update.reset(); }}
          />
          <p className="text-xs leading-5 text-muted-foreground">{t("modelSettings.credentialVerificationHint")}</p>
        </div>
        {update.error ? <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">{update.error.message}</p> : null}
        {update.data?.status === "failed" ? <p role="alert" className="whitespace-pre-wrap break-words rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {t("modelSettings.credentialSavedButRejected")} {update.data.validationMessage}
        </p> : null}
      </form>
    </EntitySheet>
  </>;
}
