import { useMutation } from "@tanstack/react-query";
import { LoaderCircle, Save, Settings2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { EntitySheet } from "@/components/entity-sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { configureModelDefinition, type ModelDefinition } from "@/lib/controller-api";
import { profiles } from "./model-selection";

// An optional, advanced capability configuration step for model aliases whose
// response protocol cannot be inferred from their ID. Never part of registration.
export function ModelProtocolSettings({ models, disabled, onChanged }: {
  models: ModelDefinition[]; disabled: boolean; onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [model, setModel] = useState<ModelDefinition>();
  const save = useMutation({
    mutationFn: () => configureModelDefinition(model!.id, {
      profile: model!.profile, timeoutSeconds: model!.timeoutSeconds, maxTokens: model!.maxTokens,
    }),
    onSuccess: async () => { await onChanged(); setOpen(false); },
  });
  const changeOpen = (next: boolean) => {
    if (save.isPending) return;
    setOpen(next);
    if (next) { setModel(undefined); save.reset(); }
  };
  return <>
    <Button type="button" variant="outline" className="h-11" disabled={disabled || !models.length} onClick={() => changeOpen(true)}><Settings2 />{t("providerRegistration.configureModel")}</Button>
    <EntitySheet
      open={open}
      closeDisabled={save.isPending}
      onOpenChange={changeOpen}
      eyebrow={t("modelSettings.confirmChangeEyebrow")}
      title={t("providerRegistration.configureModel")}
      description={t("providerRegistration.configureModelDescription")}
      width="md"
      density="compact"
      footer={<>
        <Button type="button" variant="outline" disabled={save.isPending} onClick={() => changeOpen(false)}>{t("common.cancel")}</Button>
        <Button type="submit" form="model-protocol-form" disabled={disabled || !model || model.protocolEditable === false || save.isPending}>{save.isPending ? <LoaderCircle className="animate-spin motion-reduce:animate-none" /> : <Save />}{t("common.save")}</Button>
      </>}
    >
        <form id="model-protocol-form" className="space-y-5" onSubmit={(event) => { event.preventDefault(); if (model && model.protocolEditable !== false) save.mutate(); }}>
          <div className="space-y-2">
            <Label htmlFor="protocol-model">{t("modelSettings.model")}</Label>
            <Select value={model?.id ?? ""} disabled={save.isPending} onValueChange={(id) => { setModel(models.find((item) => item.id === id)); save.reset(); }}>
              <SelectTrigger id="protocol-model" className="h-11 w-full"><SelectValue placeholder={t("modelSettings.selectModel")} /></SelectTrigger>
              <SelectContent position="popper">{models.map((item) => <SelectItem key={item.id} value={item.id}>{item.name} · {item.providerName}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          {model ? <fieldset disabled={disabled || save.isPending || model.protocolEditable === false} className="space-y-5">
            <code className="block break-all text-xs text-muted-foreground">{model.model}</code>
            {model.protocolEditable === false ? <p role="status" className="text-sm text-muted-foreground">{t("providerRegistration.protocolInUse")}</p> : null}
            <div className="space-y-2">
              <Label htmlFor="model-protocol">{t("modelSettings.profile")}</Label>
              <Select value={model.profile} disabled={disabled || save.isPending || model.protocolEditable === false} onValueChange={(profile) => setModel({ ...model, profile: profile as ModelDefinition["profile"] })}>
                <SelectTrigger id="model-protocol" className="h-11 w-full"><SelectValue /></SelectTrigger>
                <SelectContent position="popper">{profiles.map((profile) => <SelectItem key={profile} value={profile}>{t(`modelSettings.profiles.${profile}`)}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-2"><Label htmlFor="model-timeout">{t("modelSettings.timeout")}</Label><Input id="model-timeout" type="number" className="h-11" required min={1} max={120} value={model.timeoutSeconds} onChange={(event) => setModel({ ...model, timeoutSeconds: Number(event.target.value) })} /></div>
            <div className="space-y-2"><Label htmlFor="model-token-limit">{t("modelSettings.maxTokens")}</Label><Input id="model-token-limit" type="number" className="h-11" required min={1} max={32768} value={model.maxTokens} onChange={(event) => setModel({ ...model, maxTokens: Number(event.target.value) })} /></div>
          </fieldset> : null}
          {save.error ? <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">{save.error.message}</p> : null}
        </form>
    </EntitySheet>
  </>;
}
