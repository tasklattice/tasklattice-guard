import { useMemo, useState } from "react";
import { ChevronRight, FileCode2, Workflow } from "lucide-react";
import { useTranslation } from "react-i18next";
import { StateBadge } from "@/components/product-shell";
import { Button } from "@/components/ui/button";
import type { RouterTraceStep, RuntimeTraceStep } from "@/lib/api";

export type ExecutionTraceStep = Pick<RouterTraceStep, "id" | "parent_id" | "detail" | "kind" | "name" | "outcome" | "latency_ms"> & { parallel_group?: string | null };

export function playgroundTraceSteps(steps: RuntimeTraceStep[]): ExecutionTraceStep[] {
  return steps.map((step) => ({
    id: step.id, parent_id: step.parent_id, detail: step.detail,
    kind: step.kind ?? "action", name: step.name,
    outcome: step.outcome ?? step.status, latency_ms: step.duration_ms,
    parallel_group: step.parallel_group,
  }));
}

export type TraceNode = { step: ExecutionTraceStep; children: TraceNode[] };

// Only recorded parent links establish hierarchy. Break cycles and keep orphaned spans visible.
export function buildTraceForest(steps: ExecutionTraceStep[]): TraceNode[] {
  const nodes = steps.map((step) => ({ step, children: [] as TraceNode[] }));
  const byId = new Map(nodes.map((node) => [node.step.id, node]));
  const roots: TraceNode[] = [];
  for (const node of nodes) {
    const parent = node.step.parent_id ? byId.get(node.step.parent_id) : undefined;
    const visited = new Set([node.step.id]);
    let ancestor = parent;
    while (ancestor && !visited.has(ancestor.step.id)) {
      visited.add(ancestor.step.id);
      ancestor = ancestor.step.parent_id ? byId.get(ancestor.step.parent_id) : undefined;
    }
    if (parent && !ancestor) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export function ExecutionTrace({ steps }: { steps: ExecutionTraceStep[] }) {
  const { t } = useTranslation();
  const roots = useMemo(() => buildTraceForest(steps), [steps]);
  const hasHierarchy = roots.some((node) => node.children.length > 0);
  return <section className="min-w-0 border-t pt-4">
    <div className="flex items-center justify-between gap-3"><h4 className="text-sm font-semibold">{t("logs.executionTrace")}</h4><span className="text-xs text-muted-foreground">{t("logs.traceSpans", { count: steps.length })}</span></div>
    <p className="mt-1 text-xs leading-5 text-muted-foreground">{t(!steps.length ? "logs.traceEmpty" : hasHierarchy ? "logs.traceTreeDescription" : "logs.traceFlatDescription")}</p>
    <ol className="mt-3">{roots.map((node, index) => <TraceBranch key={`${node.step.id}:${index}`} node={node} />)}</ol>
  </section>;
}

function TraceBranch({ node }: { node: TraceNode }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const [showDetails, setShowDetails] = useState(false);
  const { step, children } = node;
  return <li className="relative min-w-0">
    <div className="flex min-h-11 items-start gap-1 rounded-md py-1 hover:bg-muted/30">
      {children.length ? <Button variant="ghost" size="icon" className="size-11 shrink-0" aria-expanded={expanded} aria-label={t(expanded ? "logs.collapseSpan" : "logs.expandSpan", { name: step.name })} onClick={() => setExpanded(!expanded)}><ChevronRight className={`size-4 ${expanded ? "rotate-90" : ""}`} /></Button> : <span className="grid size-11 shrink-0 place-items-center text-muted-foreground">{step.kind === "rail" ? <Workflow className="size-4" /> : <FileCode2 className="size-4" />}</span>}
      <button type="button" aria-label={t("logs.inspectSpan", { name: step.name })} aria-expanded={showDetails} className="min-h-11 min-w-0 flex-1 rounded-sm py-2 text-left focus-visible:outline-2 focus-visible:outline-ring" onClick={() => setShowDetails(!showDetails)}>
        <span className="block break-all text-xs font-medium leading-5">{step.name}</span><span className="block text-[11px] text-muted-foreground">{step.kind}{step.parallel_group ? ` · ${t("logs.parallelGroup")}: ${step.parallel_group}` : ""}</span>
      </button>
      <div className="flex shrink-0 flex-col items-end gap-1 px-2 py-2"><StateBadge state={step.outcome} /><span className="font-mono text-[11px] tabular-nums text-muted-foreground">{step.latency_ms} ms</span></div>
    </div>
    {showDetails ? <dl className="mb-3 ml-3 grid gap-2 border-l-2 px-3 py-2 text-xs"><div><dt className="text-muted-foreground">{t("logs.spanId")}</dt><dd className="mt-1 break-all font-mono">{step.id}</dd></div><div><dt className="text-muted-foreground">{t("logs.checkpointDetail")}</dt><dd className="mt-1 break-words leading-5">{step.detail || t("logs.noSpanDetail")}</dd></div>{step.parent_id ? <div><dt className="text-muted-foreground">{t("logs.parentSpan")}</dt><dd className="mt-1 break-all font-mono">{step.parent_id}</dd></div> : null}</dl> : null}
    {children.length && expanded ? <ol className="ml-3 border-l border-border pl-2 sm:ml-5 sm:pl-3 [&>li]:before:absolute [&>li]:before:top-6 [&>li]:before:-left-2 [&>li]:before:w-2 [&>li]:before:border-t [&>li]:before:border-border sm:[&>li]:before:-left-3 sm:[&>li]:before:w-3">{children.map((child, index) => <TraceBranch key={`${child.step.id}:${index}`} node={child} />)}</ol> : null}
  </li>;
}

