import { useTranslation } from "react-i18next";
import type { RuntimeLogEntry } from "@/lib/api-types";

export function RuntimeErrorDetails({ entry }: { entry: RuntimeLogEntry }) {
  const { t, i18n } = useTranslation();
  if (entry.execution_status !== "error") return null;
  const completion = entry.call_completion;
  const facts = completion ? [
    [t("logs.failureReason"), completion.reason],
    [t("logs.completedAt"), completion.completed_at && new Date(completion.completed_at).toLocaleString(i18n.language)],
    ["Decision ID", completion.decision_id],
    ["Route ID", completion.route_id],
    ["Target ID", completion.target_id],
    [t("routing.revision"), completion.router_revision?.toString()],
  ] : [];
  return <section className="rounded-md border border-destructive/30 p-3" aria-label={t("logs.errorDetails")}>
    <h4 className="text-sm font-semibold">{t(completion?.inferred ? "logs.inferredTimeout" : "logs.errorDetails")}</h4>
    <p className="mt-1 text-xs leading-5 text-muted-foreground">{completion?.inferred
      ? t("logs.inferredTimeoutDescription", { seconds: entry.latency_ms / 1000 })
      : t("logs.errorDebugHint")}</p>
    {completion ? <dl className="mt-3 grid grid-cols-2 gap-3">{facts.filter(([, value]) => value).map(([label, value]) => <div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 break-all font-mono text-xs">{value}</dd></div>)}</dl> : null}
    {entry.error_details?.map((error, index) => <div key={`${error.span_id}:${index}`} className="mt-3 border-t pt-3">
      <p className="text-sm font-medium">{error.name}{error.error_type ? <code className="ml-2 text-xs">{error.error_type}</code> : null}</p>
      <dl className="mt-2 grid grid-cols-2 gap-3">{[
        [t("logs.spanId"), error.span_id], ["Provider", error.provider], ["Model", error.model], ["Policy", error.policy],
        [t("logs.timeout"), error.timed_out ? error.timeout_ms === null ? t("common.yes") : `${error.timeout_ms} ms` : null],
      ].filter(([, value]) => value).map(([label, value]) => <div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 break-all font-mono text-xs">{value}</dd></div>)}</dl>
    </div>)}
    {!completion?.inferred && !completion?.reason && !entry.error_details?.length ? <p className="mt-2 text-xs text-muted-foreground">{t("logs.noErrorDetails")}</p> : null}
  </section>;
}
