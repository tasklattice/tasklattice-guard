import { useId } from "react";
import { graph, type StateMachineKind, type Tone } from "@/features/help-visual-copy";

export type { StateMachineKind } from "@/features/help-visual-copy";

const nodeWidth = 160;
const nodeHeight = 54;
const nodeTone: Record<Tone, string> = {
  neutral: "fill-slate-50 stroke-slate-300 dark:fill-slate-900 dark:stroke-slate-600",
  change: "fill-amber-50 stroke-amber-400 dark:fill-amber-950 dark:stroke-amber-600",
  healthy: "fill-emerald-50 stroke-emerald-400 dark:fill-emerald-950 dark:stroke-emerald-600",
  error: "fill-red-50 stroke-red-400 dark:fill-red-950 dark:stroke-red-600",
};

export function StateMachineDiagram({ kind, locale }: { kind: StateMachineKind; locale: "en" | "zh-CN" }) {
  const spec = graph(kind, locale === "zh-CN");
  const markerId = `state-arrow-${useId().replaceAll(":", "")}`;
  return <figure className="mx-auto my-5 max-w-[50rem] overflow-x-auto rounded-xl border bg-card p-3 sm:p-5" aria-label={spec.title}>
    <svg className="block h-auto min-w-[720px] max-w-full" viewBox={`0 0 900 ${spec.height}`} role="img" aria-labelledby={`${markerId}-title ${markerId}-desc`}>
      <title id={`${markerId}-title`}>{spec.title}</title>
      <desc id={`${markerId}-desc`}>{spec.nodes.map(node => node.id).join(", ")}. {spec.edges.map(edge => edge.label).join("; ")}</desc>
      <defs><marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" className="fill-muted-foreground" /></marker></defs>
      {spec.edges.map((edge, index) => <g key={`${edge.path}-${index}`}>
        <path d={edge.path} fill="none" strokeWidth="1.8" markerEnd={`url(#${markerId})`} className="stroke-muted-foreground" />
        <text x={edge.x} y={edge.y} textAnchor="middle" paintOrder="stroke" strokeWidth="5" className="fill-foreground stroke-card text-[11px] font-medium">{edge.label}</text>
      </g>)}
      {spec.nodes.map(node => <g key={node.id}>
        <rect x={node.x} y={node.y} width={nodeWidth} height={nodeHeight} rx="10" strokeWidth="1.5" className={nodeTone[node.tone]} />
        <text x={node.x + nodeWidth / 2} y={node.y + nodeHeight / 2 + 1} textAnchor="middle" dominantBaseline="middle" className="fill-foreground font-mono text-xs font-semibold">{node.id}</text>
      </g>)}
    </svg>
    <figcaption className="mt-2 text-xs leading-5 text-muted-foreground">{spec.caption}</figcaption>
  </figure>;
}
