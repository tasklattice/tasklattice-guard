import { EndpointProtocolIcon } from "@/components/endpoint-protocol-icon";
import { Link } from "@tanstack/react-router";
import { useLayoutEffect, useRef, useState } from "react";
import { GitBranch, ShieldCheck } from "lucide-react";
import type { Endpoint } from "@/lib/api";
import type {
  RouterDraft,
  RouterRevision,
  TrafficRouter,
} from "@/lib/traffic-routing-api";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import {
  conditionCount,
  revisionLabel,
  selectorSummary,
} from "./router-view-model";
import { percent } from "./form";

type Names = Array<{ id: string; name: string }>;
export function RouterOverview({
  router,
  endpoints,
  guardrails,
  revisions,
  onRule,
  onEndpoints,
  onRevisions,
  canEdit,
}: {
  router: TrafficRouter;
  endpoints: Endpoint[];
  guardrails: Names;
  revisions: RouterRevision[];
  canEdit: boolean;
  onRule: (id: string) => void;
  onEndpoints: () => void;
  onRevisions: () => void;
}) {
  const snapshot = router.activeSnapshot;
  const revision = revisions.find((r) => r.revision === router.activeRevision);
  const versions = new Set(
    snapshot?.routes.flatMap((r) =>
      r.targets.map((t) => `${t.guardrailId}:${t.guardrailVersion}`),
    ) ?? [],
  );
  return (
    <div className="space-y-6">
      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Traffic Flow</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {snapshot
              ? `Published routing · ${revisionLabel(revision)}. All attached Endpoints share this ordered rule set.`
              : "No revision has been published. Draft rules are not serving traffic."}
          </p>
        </div>
        {!endpoints.length && (
          <div className="flex items-center justify-between gap-4 rounded-lg border border-dashed p-4">
            <p className="text-sm">No endpoints are attached to this router.</p>
            <Button variant="outline" onClick={onEndpoints}>
              {canEdit ? "Attach endpoint" : "View endpoints"}
            </Button>
          </div>
        )}
        {snapshot ? (
          <TrafficFlow
            snapshot={snapshot}
            endpoints={endpoints}
            guardrails={guardrails}
            onRule={onRule}
          />
        ) : (
          <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
            Publish the first revision to see the active traffic flow.
          </p>
        )}
      </section>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Summary title="Endpoints">
          <p>{endpoints.length} attached</p>
          <p className="text-muted-foreground">
            {endpoints.filter((e) => e.runtime_status === "healthy").length}{" "}
            healthy ·{" "}
            {endpoints.filter((e) => e.runtime_status === "unknown").length}{" "}
            unknown
          </p>
        </Summary>
        <Summary title="Routing">
          <p>
            {snapshot?.routes.filter((r) => r.kind === "normal").length ?? 0}{" "}
            rules
          </p>
          <p className="text-muted-foreground">
            {snapshot?.routes.filter((r) => r.kind === "fallback").length ?? 0}{" "}
            fallback
          </p>
        </Summary>
        <Summary title="Current deployment">
          <p>
            Revision{" "}
            {router.activeRevision ? `${revisionLabel(revision)}` : "—"}
          </p>
          <p className="break-words text-muted-foreground">
            Published by {revision?.createdBy ?? "—"}
          </p>
          <p className="text-muted-foreground">
            {revision
              ? new Date(revision.createdAt).toLocaleString()
              : "Not published"}
          </p>
          <p>{versions.size} pinned GuardRail versions</p>
        </Summary>
        <Summary title="Recent revisions">
          <Button variant="link" className="h-auto px-0" onClick={onRevisions}>
            View all
          </Button>
          {revisions.slice(0, 3).map((r) => (
            <p
              key={r.revision}
              className="flex flex-wrap justify-between gap-2"
            >
              <span className="break-all font-mono text-xs">
                {revisionLabel(r)}
              </span>
              <span className="text-muted-foreground">
                {r.revision === router.activeRevision
                  ? router.rolloutStatus === "active"
                    ? "Active"
                    : "Deploying"
                  : "Previous"}
              </span>
            </p>
          ))}
        </Summary>
      </div>
    </div>
  );
}
function Summary({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2 rounded-lg border p-4 text-sm">
      <h3 className="font-medium">{title}</h3>
      {children}
    </section>
  );
}

export function TrafficFlow({
  snapshot,
  endpoints,
  guardrails,
  onRule,
}: {
  snapshot: RouterDraft;
  endpoints: Endpoint[];
  guardrails: Names;
  onRule: (id: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<
    Array<{ d: string; label?: string; x: number; y: number }>
  >([]);
  const normal = snapshot.routes.filter((r) => r.kind === "normal");
  const fallback = snapshot.routes.find((r) => r.kind === "fallback");
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const update = () => {
      const bounds = el.getBoundingClientRect();
      const result: typeof lines = [];
      const node = (id: string) =>
        Array.from(el.querySelectorAll<HTMLElement>("[data-flow-node]"))
          .find((n) => n.dataset.flowNode === id)
          ?.getBoundingClientRect();
      const connect = (from: string, to: string, label?: string) => {
        const a = node(from),
          b = node(to);
        if (!a || !b) return;
        const x1 = a.right - bounds.left,
          y1 = a.top + a.height / 2 - bounds.top,
          x2 = b.left - bounds.left,
          y2 = b.top + b.height / 2 - bounds.top;
        const mid = (x1 + x2) / 2;
        result.push({
          d: `M ${x1} ${y1} H ${mid} V ${y2} H ${x2}`,
          label,
          x: x2 - 28,
          y: y2 - 7,
        });
      };
      for (const r of normal) {
        if (r.enabled) connect("sources", r.id);
        for (const t of r.targets) connect(r.id, t.id, percent(t.weightBps));
      }
      if (!normal.length && fallback) connect("sources", "unmatched");
      if (fallback) {
        connect("unmatched", fallback.id);
        for (const t of fallback.targets)
          connect(fallback.id, t.id, percent(t.weightBps));
      }
      setLines(result);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    el.querySelectorAll("[data-flow-node]").forEach((n) => observer.observe(n));
    return () => observer.disconnect();
  }, [snapshot, endpoints, guardrails]);
  const nodeClass =
    "relative z-10 min-w-0 rounded-lg border bg-card p-4 text-left text-sm shadow-xs";
  return (
    <div
      className="overflow-x-auto rounded-xl border bg-muted/10"
      tabIndex={0}
      aria-label="Traffic flow, scroll horizontally on smaller screens"
    >
      <div
        ref={root}
        className="relative grid min-w-[880px] grid-cols-[minmax(220px,28fr)_minmax(50px,5fr)_minmax(220px,30fr)_minmax(64px,5fr)_minmax(240px,32fr)] gap-y-5 p-5"
      >
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full text-slate-300"
          aria-hidden="true"
        >
          {lines.map((l, i) => (
            <g key={i}>
              <path
                d={l.d}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <text
                x={l.x}
                y={l.y}
                textAnchor="middle"
                className="fill-muted-foreground text-[11px]"
              >
                {l.label}
              </text>
            </g>
          ))}
        </svg>
        <h3 className="col-start-1 text-xs font-medium text-muted-foreground">
          Endpoints
        </h3>
        <h3 className="col-start-3 text-xs font-medium text-muted-foreground">
          Routing rules · first match wins
        </h3>
        <h3 className="col-start-5 text-xs font-medium text-muted-foreground">
          GuardRails · pinned versions
        </h3>
        <div
          data-flow-node="sources"
          className="col-start-1 space-y-3 self-center"
          style={{ gridRow: `2 / span ${Math.max(normal.length, 1)}` }}
        >
          {endpoints.map((e) => (
            <Link
              key={e.id}
              to="/integration/endpoint"
              search={{ endpointId: e.id }}
              className={`${nodeClass} block hover:border-primary/40`}
            >
              <div className="flex items-center gap-2">
                <EndpointProtocolIcon protocol={e.protocol} size="sm" />
                <span className="line-clamp-2 font-medium" title={e.name}>
                  {e.name}
                </span>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                ●{" "}
                {e.runtime_status === "healthy"
                  ? "Healthy"
                  : e.runtime_status === "degraded"
                    ? "Unhealthy"
                    : e.enabled
                      ? "Health unknown"
                      : "Disabled"}
              </p>
            </Link>
          ))}
          {!endpoints.length && (
            <p className={`${nodeClass} text-muted-foreground`}>
              No attached Endpoints
            </p>
          )}
        </div>
        {normal.map((r, i) => (
          <div key={r.id} className="contents">
            <button
              data-flow-node={r.id}
              style={{ gridRow: i + 2 }}
              className={`${nodeClass} col-start-3 self-center hover:border-primary/40`}
              onClick={() => onRule(r.id)}
            >
              <span className="flex items-center gap-2 font-medium">
                <GitBranch className="size-4" />
                {String(i + 1).padStart(2, "0")} · {r.name}
              </span>
              <span
                title={selectorSummary(r.selector.expression)}
                className="mt-2 line-clamp-2 block text-xs text-muted-foreground"
              >
                {selectorSummary(r.selector.expression)}
              </span>
              <span className="mt-2 block text-xs text-muted-foreground">
                {conditionCount(r.selector.expression)} conditions
                {!r.enabled ? " · Disabled" : ""}
              </span>
            </button>
            <div
              style={{ gridRow: i + 2 }}
              className="col-start-5 space-y-3 self-center"
            >
              {r.targets.map((t) => (
                <a
                  key={t.id}
                  data-flow-node={t.id}
                  href={`/guardrails/${encodeURIComponent(t.guardrailId)}`}
                  className={`${nodeClass} block hover:border-primary/40`}
                >
                  <span className="flex items-start gap-2">
                    <ShieldCheck className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 break-words font-medium">
                      {guardrails.find((g) => g.id === t.guardrailId)?.name ??
                        "GuardRail unavailable"}
                    </span>
                  </span>
                  <Badge
                    variant="secondary"
                    className="mt-2 max-w-full break-all whitespace-normal"
                  >
                    {t.guardrailVersion || "Version unavailable"}
                  </Badge>
                </a>
              ))}
            </div>
          </div>
        ))}
        {fallback && (
          <div className="contents">
            <div
              data-flow-node="unmatched"
              style={{ gridRow: Math.max(normal.length, 1) + 2 }}
              className={`${nodeClass} col-start-1 self-center border-dashed bg-muted/30`}
            >
              Unmatched traffic
            </div>
            <button
              data-flow-node={fallback.id}
              style={{ gridRow: Math.max(normal.length, 1) + 2 }}
              className={`${nodeClass} col-start-3 self-center border-dashed bg-muted/30`}
              onClick={() => onRule(fallback.id)}
            >
              <span className="font-medium">Fallback</span>
              <span className="mt-1 block text-xs text-muted-foreground">
                Used when no routing rules match.
              </span>
            </button>
            <div
              style={{ gridRow: Math.max(normal.length, 1) + 2 }}
              className="col-start-5 space-y-3"
            >
              {fallback.targets.map((t) => (
                <a
                  data-flow-node={t.id}
                  key={t.id}
                  href={`/guardrails/${encodeURIComponent(t.guardrailId)}`}
                  className={`${nodeClass} block border-dashed bg-muted/30`}
                >
                  <span className="flex items-center gap-2">
                    <ShieldCheck className="size-4" />
                    {guardrails.find((g) => g.id === t.guardrailId)?.name ??
                      "GuardRail unavailable"}
                  </span>
                  <Badge
                    variant="secondary"
                    className="mt-2 max-w-full break-all whitespace-normal"
                  >
                    {t.guardrailVersion}
                  </Badge>
                </a>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
