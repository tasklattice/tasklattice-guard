import { Children, type ReactNode } from "react";
import { StateBadge } from "@/components/product-shell";
import { StateMachineDiagram } from "@/components/help/state-machine-diagram";
import { resourceMapCopy, stateLegendCopy, type Tone } from "@/features/help-visual-copy";

const toneClasses: Record<Tone, string> = {
  neutral: "border-border bg-muted/40 text-foreground",
  change: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200",
  healthy: "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200",
  error: "border-red-300 bg-red-50 text-red-900 dark:border-red-700 dark:bg-red-950/40 dark:text-red-200",
};

function ResourceMap({ locale }: { locale: "en" | "zh-CN" }) {
  const { title, implementation, testCases, caption, lanes } = resourceMapCopy(locale);
  return <figure className="mx-auto my-6 max-w-[50rem] overflow-x-auto rounded-xl border bg-card p-4 sm:p-6" aria-label={title}>
    <div className="min-w-[720px] space-y-6">
      {lanes.map(lane => <div key={lane.title}>
        <p className="mb-3 text-xs font-semibold text-primary">{lane.title}</p>
        <div className="flex items-stretch gap-2">
          {lane.nodes.map((node, index) => <div key={`${lane.title}-${node.title}`} className="contents">
            {index > 0 ? <span aria-hidden="true" className="flex shrink-0 items-center text-lg text-primary">→</span> : null}
            <div className={`min-w-0 rounded-lg border p-3 ${node.title === "Policy" ? "flex-[1.55]" : "flex-1"} ${node.logo ? "border-primary/30 bg-primary/5" : "bg-background"}`}>
              <div className="flex items-center gap-2">{node.logo ? <img src="/favicon.svg" alt="" width={20} height={20} className="size-5" /> : null}<strong className="text-xs leading-5 text-foreground">{node.title}</strong></div>
              <p className="mt-1 text-[11px] leading-5 text-muted-foreground">{node.detail}</p>
              {node.title === "Policy" ? <div className="mt-2 space-y-1 rounded-md border border-dashed bg-muted/30 p-2 text-[11px] leading-4 text-foreground">
                <div><strong>Rule</strong> <span aria-hidden="true">→</span> {implementation}</div>
                <div className="font-mono text-[10px] text-muted-foreground">regex · keyword · category<br />code_block · competitor_intent<br />colang_flow</div>
                <div>{testCases}</div>
              </div> : null}
            </div>
          </div>)}
        </div>
      </div>)}
    </div>
    <figcaption className="mt-4 text-xs leading-5 text-muted-foreground">{caption}</figcaption>
  </figure>;
}

function StateLegend({ locale }: { locale: "en" | "zh-CN" }) {
  const { title, items } = stateLegendCopy(locale);
  return <div className="my-5 flex flex-wrap gap-2" aria-label={title}>{items.map(item => <span key={item.tone} className={`rounded-md border px-2.5 py-1.5 text-xs font-medium ${toneClasses[item.tone]}`}>{item.label}</span>)}</div>;
}

function StateCards({ children }: { children: ReactNode }) {
  return <div className="my-5 grid gap-4 xl:grid-cols-2">{children}</div>;
}

function StateCard({ title, code, state = code, children }: { title: string; code: string; state?: string; children: ReactNode }) {
  return <section className="min-w-0 rounded-xl border bg-card p-5">
    <header className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="font-semibold">{title}</h4>
      <StateBadge state={state} label={code} />
    </header>
    <dl className="mt-4 space-y-3">{children}</dl>
  </section>;
}

function StateDetail({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt className="text-xs font-medium text-muted-foreground">{label}</dt><dd className="mt-1 text-sm leading-6 [&>p]:mt-0">{children}</dd></div>;
}

function FlowSteps({ children }: { children: ReactNode }) {
  return <ol className="my-5 grid gap-3 [counter-reset:step] xl:grid-cols-3">
    {Children.toArray(children).filter(child => typeof child !== "string").map((child, index) => <li key={index} className="min-w-0 rounded-lg border bg-card p-4 [counter-increment:step] before:mb-2 before:block before:font-mono before:text-xs before:text-primary before:content-[counter(step,decimal-leading-zero)]">{child}</li>)}
  </ol>;
}

function FlowStep({ title, children }: { title: string; children: ReactNode }) {
  return <><h4 className="text-sm font-semibold">{title}</h4><div className="text-sm leading-6 text-muted-foreground [&>p]:mt-2">{children}</div></>;
}

function WorkflowDiagram({ src, alt, openLabel, children }: { src: string; alt: string; openLabel: string; children: ReactNode }) {
  return <figure className="mx-auto my-6 max-w-5xl">
    <a href={src} target="_blank" rel="noopener noreferrer" aria-label={`${openLabel}: ${alt}`} className="block overflow-hidden rounded-lg border bg-white outline-none focus-visible:ring-2 focus-visible:ring-primary">
      <img src={src} alt={alt} width={1536} height={1024} loading="lazy" decoding="async" className="block h-auto w-full" />
    </a>
    <figcaption className="mt-3 text-sm leading-6 text-muted-foreground [&>p]:mt-0">
      {children}
      <a href={src} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center rounded-md text-primary underline underline-offset-4 focus-visible:outline-primary">{openLabel}</a>
    </figcaption>
  </figure>;
}

export const helpStructuralComponents = { StateCards, StateCard, StateDetail, FlowSteps, FlowStep, WorkflowDiagram, ResourceMap, StateLegend, StateMachineDiagram };
