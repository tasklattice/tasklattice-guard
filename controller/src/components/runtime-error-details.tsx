import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { RuntimeLogDiagnostic, RuntimeLogEntry } from "@/lib/api-types";
import { isModelClassificationDiagnostic } from "./execution-trace-errors";

function causeText(error: RuntimeLogDiagnostic, t: TFunction) {
  const category = error.category ?? "unknown";
  return t(`logs.diagnostics.causes.${category}`, {
    defaultValue: t(`logs.errorCategories.${category}`, { defaultValue: error.message ?? category }),
  });
}

export function RuntimeFailureSummary({ entry }: { entry: RuntimeLogEntry }) {
  const { t } = useTranslation();
  if (entry.execution_status !== "error") return null;
  const cause = entry.error_details?.find(error => error.category !== "uncovered" && error.affects_result);
  const message = entry.call_completion?.inferred ? t("logs.inferredTimeout")
    : cause ? causeText(cause, t) : entry.call_completion?.reason ?? t("logs.noErrorDetails");
  return <p className="mt-1 line-clamp-2 text-xs" title={message}>{message}</p>;
}

export function RuntimeErrorDetails({ entry }: { entry: RuntimeLogEntry }) {
  const { t, i18n } = useTranslation();
  const failed = entry.execution_status === "error";
  if (!failed && !entry.error_details?.length) return null;
  const completion = entry.call_completion;
  const causes = entry.error_details?.filter(error => error.category !== "uncovered") ?? [];
  const skipped = entry.error_details?.filter(error => error.category === "uncovered") ?? [];
  const summary = completion?.inferred ? t("logs.inferredTimeoutDescription", { seconds: entry.latency_ms / 1000 })
    : !failed ? t("logs.diagnostics.recovered")
    : entry.fail_closed && entry.outcome === "block" ? t("logs.diagnostics.failClosed")
    : entry.outcome ? t("logs.diagnostics.failedWithAction", { action: t(`logs.outcomes.${entry.outcome}`) })
    : t("logs.diagnostics.failedWithoutAction");
  return <section className="border p-4" aria-label={t("logs.errorDetails")}>
    <h4 className="text-sm font-semibold">{t(completion?.inferred ? "logs.inferredTimeout" : failed ? "logs.errorDetails" : "logs.diagnostics.title")}</h4>
    <p className="mt-2 text-sm leading-5">{summary}</p>
    <Facts items={[
      ["Call ID", entry.trace_id],
      [t("logs.diagnostics.termination"), entry.termination_reason],
      ...(completion ? [
        [t("logs.failureReason"), completion.reason],
        [t("logs.completedAt"), completion.completed_at && new Date(completion.completed_at).toLocaleString(i18n.language)],
        ["Decision ID", completion.decision_id], ["Route ID", completion.route_id],
        ["Target ID", completion.target_id], [t("routing.revision"), completion.router_revision?.toString()],
      ] : []),
    ]} />
    {causes.map((error, index) => <div key={`${error.span_id}:${index}`} className="mt-4 border-t pt-4">
      <p className="text-xs text-muted-foreground">{t(isModelClassificationDiagnostic(error.category)
        ? "logs.diagnostics.modelEvaluation" : `logs.errorSources.${error.source ?? "unknown"}`)} · {t(error.affects_result ? "logs.affectsResult" : "logs.diagnosticOnly")}</p>
      <h5 className="mt-2 break-words text-sm font-semibold">{causeText(error, t)}</h5>
      <p className="mt-2 text-sm leading-5"><span className="font-medium">{t("logs.diagnostics.nextCheck")}:</span> {t(`logs.diagnostics.guidance.${error.category ?? "unknown"}`, { defaultValue: t("logs.diagnostics.guidance.unknown") })}</p>
      <Facts items={[
        [t("logs.affectedChecks"), error.name], ["Policy", error.policy],
        ["Provider", error.provider], ["Model", error.model],
        ["HTTP", error.http_status?.toString()], [t("logs.modelResult"), error.model_result],
        [t("logs.failureReason"), error.error_type],
        [t("logs.timeout"), error.timed_out ? error.timeout_ms == null ? t("common.yes") : `${error.timeout_ms} ms` : null],
        [t("logs.spanId"), error.span_id], ["Model Call ID", error.model_call_id],
      ]} />
      {error.message ? <p className="mt-3 break-words text-xs leading-5 text-muted-foreground">{t("logs.diagnostics.recordedMessage")}: {error.message}</p> : null}
      {(error.related_spans?.length ?? 0) > 1 ? <details className="mt-2"><summary className="cursor-pointer text-xs focus-visible:outline-2 focus-visible:outline-ring">{t("logs.diagnostics.correlation", { count: error.related_spans!.length })}</summary><ul className="mt-2 space-y-1">{error.related_spans!.map(id => <li key={id} className="break-all font-mono text-xs">{id}</li>)}</ul></details> : null}
    </div>)}
    {!completion?.inferred && !completion?.reason && !causes.length ? <p className="mt-3 text-sm leading-5">{t(skipped.length ? "logs.diagnostics.onlyCoverage" : "logs.noErrorDetails")}</p> : null}
    {skipped.length ? <details className="mt-4 border-t pt-3"><summary className="cursor-pointer text-sm focus-visible:outline-2 focus-visible:outline-ring">{t("logs.diagnostics.skipped", { count: skipped.length })}</summary>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">{t("logs.diagnostics.skippedDescription")}</p>
      <ul className="mt-3 space-y-2">{skipped.map((error, index) => <li key={`${error.span_id}:${index}`} className="break-all font-mono text-xs">{error.span_id}</li>)}</ul>
    </details> : null}
  </section>;
}

function Facts({ items }: { items: (string | null | undefined)[][] }) {
  return <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3">{items.filter(([, value]) => value).map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 break-all font-mono text-xs leading-5">{value}</dd></div>)}</dl>;
}
