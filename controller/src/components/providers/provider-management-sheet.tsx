import { useMutation } from "@tanstack/react-query";
import {
  ArrowLeft,
  ChevronRight,
  KeyRound,
  LoaderCircle,
  PackagePlus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { EntitySheet } from "@/components/entity-sheet";
import { StateBadge } from "@/components/product-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  deleteModelProvider,
  revalidateModelProvider,
  updateModelProviderCredential,
  updateProviderTls,
  type ModelDefinition,
  type ModelProvider,
} from "@/lib/controller-api";

import { ProviderMark } from "./provider-mark";
import { ProviderTlsControl } from "./provider-tls-control";

type ManagementView = "overview" | "credential" | "tls" | "retest" | "remove";

export function ProviderManagementSheet({
  administrator,
  models,
  onChanged,
  onOpenChange,
  onRegisterModels,
  open,
  provider,
}: {
  administrator: boolean;
  models: ModelDefinition[];
  onChanged: () => Promise<void>;
  onOpenChange: (open: boolean) => void;
  onRegisterModels: () => void;
  open: boolean;
  provider: ModelProvider;
}) {
  const { t, i18n } = useTranslation();
  const [view, setView] = useState<ManagementView>("overview");
  const [credential, setCredential] = useState("");
  const [skipTlsVerify, setSkipTlsVerify] = useState(provider.skipTlsVerify ?? false);

  const credentialMutation = useMutation({
    mutationFn: () => updateModelProviderCredential(provider.id, credential),
    onSuccess: async (result) => {
      await onChanged();
      if (result.status === "validated") {
        toast.success(t("modelSettings.credentialVerified"));
        setCredential("");
        setView("overview");
      } else {
        toast.error(t("modelSettings.credentialVerificationFailed"));
      }
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const tlsMutation = useMutation({
    mutationFn: () => updateProviderTls(provider.id, skipTlsVerify),
    onSuccess: async (result) => {
      await onChanged();
      if (result.status === "validated") {
        toast.success(t("providerRegistration.tlsSaved"));
        setView("overview");
      } else {
        toast.error(result.validationMessage ?? t("modelSettings.connectionFailed"));
      }
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const retestMutation = useMutation({
    mutationFn: () => revalidateModelProvider(provider.id),
    onSuccess: async (result) => {
      await onChanged();
      if (result.status === "validated") {
        toast.success(t("modelSettings.connectionRetested"));
        setView("overview");
      } else {
        toast.error(result.validationMessage ?? t("modelSettings.connectionFailed"));
      }
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const deleteMutation = useMutation({
    mutationFn: () => deleteModelProvider(provider.id),
    onSuccess: async () => {
      toast.success(t("modelSettings.resourceRemoved"));
      onOpenChange(false);
      await onChanged();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const pending = credentialMutation.isPending || tlsMutation.isPending || retestMutation.isPending || deleteMutation.isPending;
  const providerModels = models.filter((model) => model.providerId === provider.id);
  const removalBlocked = providerModels.length > 0;
  const isHttps = provider.baseUrl.startsWith("https:");

  useEffect(() => {
    if (!open) return;
    setView("overview");
    setCredential("");
    setSkipTlsVerify(provider.skipTlsVerify ?? false);
    credentialMutation.reset();
    tlsMutation.reset();
    retestMutation.reset();
    deleteMutation.reset();
    // Mutations are intentionally reset only when the selected Provider or sheet changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, provider.id]);

  const changeView = (next: ManagementView) => {
    if (pending) return;
    setView(next);
    credentialMutation.reset();
    tlsMutation.reset();
    retestMutation.reset();
    deleteMutation.reset();
    if (next === "credential") setCredential("");
    if (next === "tls") setSkipTlsVerify(provider.skipTlsVerify ?? false);
  };
  const changeOpen = (next: boolean) => {
    if (pending) return;
    onOpenChange(next);
  };
  const checkedAt = provider.validatedAt
    ? new Date(provider.validatedAt).toLocaleString(i18n.language, { dateStyle: "medium", timeStyle: "short" })
    : null;
  const title = view === "overview"
    ? provider.name
    : view === "credential"
      ? t("modelSettings.updateCredential")
      : view === "tls"
        ? t("providerRegistration.tlsSettings")
        : view === "retest"
          ? t("modelSettings.providerRetestConfirmationTitle", { name: provider.name })
          : t("modelSettings.removeResourceTitle", { name: provider.name });
  const description = view === "overview"
    ? t("modelSettings.manageProviderDescription")
    : view === "credential"
      ? t("modelSettings.updateCredentialDescription")
      : view === "tls"
        ? t("providerRegistration.tlsSettingsDescription")
        : view === "retest"
          ? t("modelSettings.providerRetestConfirmationDescription")
          : t("modelSettings.removeResourceDescription");

  return (
    <EntitySheet
      open={open}
      closeDisabled={pending}
      onOpenChange={changeOpen}
      eyebrow={view === "overview" ? t("modelSettings.providerInspectorEyebrow") : t("modelSettings.providerActionEyebrow")}
      title={title}
      description={description}
      width="md"
      bodyClassName="bg-muted/20"
      footer={view === "overview" ? (
        <Button type="button" variant="outline" onClick={() => changeOpen(false)}>{t("common.close")}</Button>
      ) : (
        <>
          <Button type="button" variant="outline" disabled={pending} onClick={() => changeView("overview")}>
            <ArrowLeft />{t("common.back")}
          </Button>
          {view === "credential" ? (
            <Button type="submit" form={`provider-credential-${provider.id}`} disabled={!administrator || pending || !credential.trim()}>
              {credentialMutation.isPending ? <LoaderCircle className="animate-spin motion-reduce:animate-none" /> : <KeyRound />}
              {t(credentialMutation.isPending ? "modelSettings.verifyingCredential" : "modelSettings.saveAndVerifyCredential")}
            </Button>
          ) : null}
          {view === "tls" ? (
            <Button type="button" disabled={!administrator || pending || skipTlsVerify === (provider.skipTlsVerify ?? false)} onClick={() => tlsMutation.mutate()}>
              {tlsMutation.isPending ? <LoaderCircle className="animate-spin motion-reduce:animate-none" /> : <ShieldCheck />}
              {t("providerRegistration.saveTls")}
            </Button>
          ) : null}
          {view === "retest" ? (
            <Button type="button" disabled={!administrator || pending} onClick={() => retestMutation.mutate()}>
              {retestMutation.isPending ? <LoaderCircle className="animate-spin motion-reduce:animate-none" /> : <RefreshCw />}
              {t(retestMutation.isPending ? "modelSettings.retestingProvider" : "modelSettings.providerRetestConfirmationAction")}
            </Button>
          ) : null}
          {view === "remove" ? (
            <Button type="button" variant="destructive" disabled={!administrator || pending || removalBlocked} onClick={() => deleteMutation.mutate()}>
              {deleteMutation.isPending ? <LoaderCircle className="animate-spin motion-reduce:animate-none" /> : <Trash2 />}
              {t(deleteMutation.isPending ? "modelSettings.removingResource" : "common.remove")}
            </Button>
          ) : null}
        </>
      )}
    >
      {view === "overview" ? (
        <div className="space-y-4">
          <section className="rounded-xl border bg-card p-4 shadow-sm">
            <div className="flex items-start gap-3">
              <ProviderMark provider={provider.name} kind={provider.kind} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-semibold">{provider.name}</h2>
                  <StateBadge
                    state={provider.status === "validated" ? "ready" : provider.status === "failed" ? "failed" : "not evaluated"}
                    label={t(provider.status === "validated" ? "modelSettings.connected" : provider.status === "failed" ? "modelSettings.connectionFailed" : "modelSettings.notChecked")}
                  />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{provider.kind}</p>
                <code className="mt-3 block break-all rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">{provider.baseUrl}</code>
                {checkedAt ? <p className="mt-2 text-xs text-muted-foreground">{t("modelSettings.lastChecked", { time: checkedAt, latency: provider.validationLatencyMs ?? "—" })}</p> : null}
                {provider.validationMessage && provider.status === "failed" ? <p role="alert" className="mt-3 break-words text-sm leading-5 text-destructive">{provider.validationMessage}</p> : null}
              </div>
            </div>
          </section>

          <ActionCard
            icon={<RefreshCw />}
            title={t("modelSettings.connectionCardTitle")}
            description={t("modelSettings.connectionCardDescription")}
            actionLabel={t("modelSettings.retest")}
            disabled={!administrator || pending}
            onAction={() => changeView("retest")}
          />
          <ActionCard
            icon={<KeyRound />}
            title={t("modelSettings.credentialCardTitle")}
            description={t("modelSettings.currentCredential", { credential: provider.credentialHint ?? t("modelSettings.notConfigured") })}
            actionLabel={t("modelSettings.updateCredential")}
            disabled={!administrator || pending}
            onAction={() => changeView("credential")}
          />
          {isHttps ? <ActionCard
            icon={<ShieldCheck />}
            title={t("modelSettings.transportSecurityCardTitle")}
            description={t(provider.skipTlsVerify ? "modelSettings.tlsVerificationDisabled" : "modelSettings.tlsVerificationEnabled")}
            badge={provider.skipTlsVerify ? t("providerRegistration.tlsSkipped") : undefined}
            badgeVariant={provider.skipTlsVerify ? "warning" : undefined}
            actionLabel={t("providerRegistration.tlsSettings")}
            disabled={!administrator || pending}
            onAction={() => changeView("tls")}
          /> : null}
          <ActionCard
            icon={<PackagePlus />}
            title={t("modelSettings.registeredModelsCardTitle", { count: providerModels.length })}
            description={providerModels.length ? providerModels.slice(0, 3).map((model) => model.name).join(" · ") : t("modelSettings.noRegisteredModelsDescription")}
            actionLabel={t("providerRegistration.registerModels")}
            disabled={!administrator || pending}
            onAction={() => {
              onOpenChange(false);
              onRegisterModels();
            }}
          />

          <section className="rounded-xl border border-destructive/25 bg-card p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-destructive">{t("modelSettings.dangerZone")}</p>
            <div className="mt-3 flex items-start justify-between gap-4">
              <div>
                <h3 className="text-sm font-semibold">{t("modelSettings.removeProvider")}</h3>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{removalBlocked ? t("modelSettings.providerRemovalModelCount", { count: providerModels.length }) : t("modelSettings.removeProviderDescription")}</p>
              </div>
              <Button type="button" variant="destructive" className="h-11" disabled={!administrator || pending} onClick={() => changeView("remove")}>
                <Trash2 />{t("common.remove")}
              </Button>
            </div>
          </section>
        </div>
      ) : null}

      {view === "credential" ? (
        <form id={`provider-credential-${provider.id}`} className="space-y-5 rounded-xl border bg-card p-4" onSubmit={(event) => { event.preventDefault(); credentialMutation.mutate(); }}>
          <div>
            <h3 className="font-semibold">{provider.name}</h3>
            <code className="mt-1 block break-all text-xs text-muted-foreground">{provider.baseUrl}</code>
            <p className="mt-3 text-xs text-muted-foreground">{t("modelSettings.currentCredential", { credential: provider.credentialHint ?? t("modelSettings.notConfigured") })}</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor={`provider-new-credential-${provider.id}`}>{t("modelSettings.newCredential")}</Label>
            <Input
              id={`provider-new-credential-${provider.id}`}
              className="h-11 font-mono"
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              required
              maxLength={8_192}
              value={credential}
              onChange={(event) => { setCredential(event.target.value); credentialMutation.reset(); }}
            />
            <p className="text-xs leading-5 text-muted-foreground">{t("modelSettings.credentialVerificationHint")}</p>
          </div>
          <MutationError error={credentialMutation.error} />
          {credentialMutation.data?.status === "failed" ? <p role="alert" className="whitespace-pre-wrap break-words rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">{t("modelSettings.credentialSavedButRejected")} {credentialMutation.data.validationMessage}</p> : null}
        </form>
      ) : null}

      {view === "tls" ? (
        <div className="space-y-4 rounded-xl border bg-card p-4">
          <div><h3 className="font-semibold">{provider.name}</h3><code className="mt-1 block break-all text-xs text-muted-foreground">{provider.baseUrl}</code></div>
          <ProviderTlsControl checked={skipTlsVerify} disabled={!administrator || pending} onChange={(next) => { setSkipTlsVerify(next); tlsMutation.reset(); }} />
          <MutationError error={tlsMutation.error} />
          {tlsMutation.data?.status === "failed" ? <p role="alert" className="whitespace-pre-wrap break-words rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">{tlsMutation.data.validationMessage}</p> : null}
        </div>
      ) : null}

      {view === "retest" ? (
        <div className="space-y-4">
          <Alert variant="info"><RefreshCw /><AlertTitle>{t("modelSettings.providerRetestConfirmationSummary")}</AlertTitle><AlertDescription>{t("modelSettings.providerRetestConfirmationImpact")}</AlertDescription></Alert>
          <section className="rounded-xl border bg-card p-4"><h3 className="font-semibold">{provider.name}</h3><code className="mt-1 block break-all text-xs text-muted-foreground">{provider.baseUrl}</code></section>
          <MutationError error={retestMutation.error} />
          {retestMutation.data?.status === "failed" ? <p role="alert" className="whitespace-pre-wrap break-words rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">{retestMutation.data.validationMessage}</p> : null}
        </div>
      ) : null}

      {view === "remove" ? (
        <div className="space-y-4">
          <Alert variant={removalBlocked ? "destructive" : "info"}>
            <ShieldCheck />
            <AlertTitle>{t("modelSettings.removalProtectionTitle")}</AlertTitle>
            <AlertDescription>{removalBlocked ? t("modelSettings.providerRemovalModelCount", { count: providerModels.length }) : t("modelSettings.removalProtectionDescription")}</AlertDescription>
          </Alert>
          {providerModels.length ? <section className="rounded-xl border bg-card p-4"><h3 className="text-sm font-semibold">{t("modelSettings.registeredModels")}</h3><div className="mt-3 flex flex-wrap gap-2">{providerModels.map((model) => <Badge key={model.id} variant="secondary">{model.name}</Badge>)}</div></section> : null}
          <MutationError error={deleteMutation.error} />
        </div>
      ) : null}
    </EntitySheet>
  );
}

function ActionCard({ actionLabel, badge, badgeVariant, description, disabled, icon, onAction, title }: {
  actionLabel: string;
  badge?: string;
  badgeVariant?: "warning";
  description: string;
  disabled: boolean;
  icon: ReactNode;
  onAction: () => void;
  title: string;
}) {
  return (
    <section className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-4" aria-hidden="true">{icon}</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold">{title}</h3>{badge ? <Badge variant={badgeVariant === "warning" ? "outline" : "secondary"} className={badgeVariant === "warning" ? "border-amber-500/40 text-amber-700 dark:text-amber-300" : undefined}>{badge}</Badge> : null}</div>
            <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">{description}</p>
          </div>
        </div>
        <Button type="button" variant="outline" className="h-11 w-full justify-between sm:w-auto" disabled={disabled} onClick={onAction}>
          {actionLabel}<ChevronRight />
        </Button>
      </div>
    </section>
  );
}

function MutationError({ error }: { error: Error | null }) {
  return error ? <p role="alert" className="whitespace-pre-wrap break-words rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">{errorMessage(error)}</p> : null;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Request failed.";
}
