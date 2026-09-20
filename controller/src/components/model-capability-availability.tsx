import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { LockKeyhole } from "lucide-react";
import type { CapabilityBindingId } from "../../shared/guardrail-catalog";
import { getModelConfiguration } from "@/lib/controller-api";
import { dependencyAssignment } from "@/lib/protection-dependencies";
import { Button } from "./ui/button";

export function useModelCapabilityAvailability(enabled: boolean, binding: CapabilityBindingId, translationPrefix: string, capability?: string) {
  const { t } = useTranslation();
  const query = useQuery({ queryKey: ["resources", "model-configuration"], queryFn: getModelConfiguration,
    enabled, retry: false, refetchInterval: enabled ? 10_000 : false });
  const assignment = query.data ? dependencyAssignment(binding, query.data) : null;
  const ready = query.isSuccess && assignment?.state === "active";
  const state = query.isPending ? "loading" : query.isError ? "error" : assignment?.state ?? "missing";
  const reason = ready ? null : t(`${translationPrefix}.${state}`, { capability });
  return { ready, reason, pending: query.isPending, failed: query.isError, refreshing: query.isFetching, refresh: () => void query.refetch() };
}

export function ModelCapabilityUnavailable({ availability, label, title, hint }: {
  availability: ReturnType<typeof useModelCapabilityAvailability>;
  label: string;
  title: string;
  hint: string;
}) {
  const { t } = useTranslation();
  return <section className={`space-y-3 rounded-xl border p-4 ${availability.pending ? "bg-muted/15" : "border-destructive/25 bg-destructive/5"}`} aria-label={label}>
    <h4 className="flex items-center gap-2 text-base font-semibold">{!availability.pending ? <LockKeyhole aria-hidden="true" className="size-4 shrink-0 text-destructive" /> : null}{title}</h4>
    <p role="status" className={`text-sm leading-6 ${availability.pending ? "" : "text-destructive"}`}>{availability.reason}</p>
    <p className="text-xs leading-5 text-muted-foreground">{hint}</p>
    <div className="flex flex-wrap items-center gap-3">
      <a className="inline-flex min-h-11 items-center text-sm text-primary underline underline-offset-4" href="/settings/guardrail-catalog" target="_blank" rel="noopener noreferrer">{t("protection.dependencies.configure")}</a>
      <Button variant="outline" className="min-h-11" disabled={availability.refreshing} onClick={availability.refresh}>{t("common.retry")}</Button>
    </div>
  </section>;
}
