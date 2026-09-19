import { ExecutionTrace, playgroundTraceSteps } from "@/components/execution-trace";
import { CheckCircle2, CircleAlert, SearchCheck, ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { PlaygroundCheckResult } from "@/lib/api";
import { cn } from "@/lib/utils";

export function EvaluatedPoliciesPanel({ result }: { result: PlaygroundCheckResult | null }) {
  const { t } = useTranslation();
  return (
    <section className="overflow-hidden rounded-xl border bg-card shadow-xs">
      <PanelHeader icon={<SearchCheck />} title={t("playground.evaluatedPolicies")} meta={result ? t("playground.policyCount", { count: result.policies.length }) : undefined} />
      {result ? result.policies.length ? (
        <div className="divide-y">
          {result.policies.map((policy) => {
            const matched = policy.status === "matched";
            return <div key={policy.id} className={cn("grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3", matched ? "bg-red-50/50" : "text-muted-foreground")}><div className="min-w-0"><strong className={cn("block truncate text-sm font-medium", matched && "text-foreground")}>{policy.name}</strong><span className={cn("mt-1 inline-flex items-center gap-1.5 text-[11px]", matched ? "text-red-700" : policy.status === "error" ? "text-amber-700" : "text-muted-foreground")}>
              {matched ? <ShieldAlert className="size-3.5" /> : policy.status === "error" ? <CircleAlert className="size-3.5" /> : <CheckCircle2 className="size-3.5 text-emerald-600" />}
              {t(`playground.policyStates.${policy.status}`)}
            </span></div><span className="font-mono text-xs tabular-nums text-muted-foreground">{policy.duration_ms} ms</span></div>;
          })}
        </div>
      ) : <PanelEmpty text={t("playground.noPoliciesEvaluated")} /> : <PanelEmpty text={t("playground.runToSeePolicies")} />}
    </section>
  );
}

export function FindingsPanel({ result }: { result: PlaygroundCheckResult | null }) {
  const { t } = useTranslation();
  return (
    <section className="overflow-hidden rounded-xl border bg-card shadow-xs">
      <PanelHeader icon={<ShieldAlert />} title={t("playground.findings")} meta={result ? String(result.findings.length) : undefined} />
      {result ? result.findings.length ? <div className="divide-y">{result.findings.map((finding) => <article key={finding.id} className="px-4 py-3.5"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><span className={cn("inline-flex rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase", finding.severity === "high" ? "border-red-200 bg-red-50 text-red-700" : finding.severity === "medium" ? "border-amber-200 bg-amber-50 text-amber-700" : "border-slate-200 bg-slate-50 text-slate-600")}>{t(`playground.severity.${finding.severity}`)}</span><h3 className="mt-2 text-sm font-medium leading-5">{finding.title}</h3></div><span className="shrink-0 font-mono text-xs text-muted-foreground">{finding.confidence === null ? "—" : `${Math.round(finding.confidence * 100)}%`}</span></div><p className="mt-1.5 text-xs leading-5 text-muted-foreground">{finding.detail}</p></article>)}</div> : <PanelEmpty icon={<CheckCircle2 className="text-emerald-600" />} text={t("playground.noFindings")} /> : <PanelEmpty text={t("playground.runToSeeFindings")} />}
    </section>
  );
}

export function ExecutionTracePanel({ result }: { result: PlaygroundCheckResult | null }) {
  const { t } = useTranslation();
  return result
    ? <ExecutionTrace key={result.trace_id} steps={playgroundTraceSteps(result.trace)} />
    : <PanelEmpty text={t("playground.runToSeeTrace")} />;
}

function PanelHeader({ icon, title, meta }: { icon: ReactNode; title: string; meta?: string }) {
  return <header className="flex min-h-14 items-center gap-3 border-b bg-muted/20 px-4"><span className="text-muted-foreground [&_svg]:size-4">{icon}</span><h2 className="min-w-0 flex-1 text-sm font-semibold">{title}</h2>{meta ? <span className="font-mono text-[11px] text-muted-foreground">{meta}</span> : null}</header>;
}

function PanelEmpty({ icon, text }: { icon?: ReactNode; text: string }) {
  return <div className="flex min-h-28 flex-col items-center justify-center px-5 py-6 text-center">{icon ? <span className="mb-2 [&_svg]:size-5">{icon}</span> : null}<p className="max-w-xs text-xs leading-5 text-muted-foreground">{text}</p></div>;
}
