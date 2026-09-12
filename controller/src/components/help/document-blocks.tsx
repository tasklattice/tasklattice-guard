import { Children, type ReactNode } from "react";
import { StateBadge } from "@/components/product-shell";

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

export const helpStructuralComponents = { StateCards, StateCard, StateDetail, FlowSteps, FlowStep };
