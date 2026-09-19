import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { getModelConfiguration } from "@/lib/controller-api";
import { dependencyAssignment } from "@/lib/protection-dependencies";
import { Button } from "./ui/button";

export function useTopicControlAvailability(enabled: boolean) {
  const { t } = useTranslation();
  const query = useQuery({ queryKey: ["resources", "model-configuration"], queryFn: getModelConfiguration,
    enabled, retry: false, refetchInterval: enabled ? 10_000 : false });
  const assignment = query.data ? dependencyAssignment("topic_control.input", query.data) : null;
  const ready = query.isSuccess && assignment?.state === "active";
  const reason = ready ? null : query.isPending ? t("topicControl.availability.loading")
    : query.isError ? t("topicControl.availability.error")
    : t(`topicControl.availability.${assignment?.state ?? "missing"}`);
  return { ready, reason, pending: query.isPending, failed: query.isError, refreshing: query.isFetching, refresh: () => void query.refetch() };
}

export function TopicControlUnavailable({ availability }: { availability: ReturnType<typeof useTopicControlAvailability> }) {
  const { t } = useTranslation();
  return <section className="space-y-3 rounded-xl border bg-muted/15 p-4" aria-label={t("guardrailWizard.topicControl")}>
    <h4 className="text-base font-semibold">{t("topicControl.availability.title")}</h4>
    <p role="status" className="text-sm leading-6">{availability.reason}</p>
    <p className="text-xs leading-5 text-muted-foreground">{t("topicControl.availability.hint")}</p>
    <div className="flex flex-wrap items-center gap-3">
      <a className="inline-flex min-h-11 items-center text-sm text-primary underline underline-offset-4" href="/settings/guardrail-catalog" target="_blank" rel="noopener noreferrer">{t("protection.dependencies.configure")}</a>
      <Button variant="outline" className="min-h-11" disabled={availability.refreshing} onClick={availability.refresh}>{t("common.retry")}</Button>
    </div>
  </section>;
}
