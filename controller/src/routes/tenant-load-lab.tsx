import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Activity, ArrowDown, ArrowUp, ArrowUpRight, Check, CircleAlert, Clock3, Cpu, FlaskConical, Info, LoaderCircle, Pause, Play, RotateCcw, Server, Zap } from "lucide-react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { TenantAdmissionMonitorPanel } from "@/components/tenant-admission-monitor";
import { useAuth } from "@/lib/auth";
import { controlTenantLoadLab, getTenantLoadLabState, tenantLoadLabKey, type LabControl, type LabEvent, type LabMetric, type LabMode, type LabSample, type LabTenant, type LabTenantId, type TenantLoadLabState } from "@/lib/tenant-load-lab-api";
import type { TenantLoadLabCopy } from "@/tenant-load-lab-i18n";
import "./tenant-load-lab.scss";

const tenantIds: LabTenantId[] = ["tenantA", "tenantB", "tenantC"];
const tenantColors: Record<LabTenantId, string> = { tenantA: "#0f62fe", tenantB: "#009d9a", tenantC: "#8a3ffc" };
const tenantLetters: Record<LabTenantId, string> = { tenantA: "A", tenantB: "B", tenantC: "C" };
type Copy = TenantLoadLabCopy;

function measured(value: number | null | undefined): value is number { return typeof value === "number" && Number.isFinite(value); }
function value(value: number | null | undefined, digits = 0): string { return measured(value) ? value.toLocaleString(undefined, { maximumFractionDigits: digits }) : "—"; }
function ms(input: number | null | undefined): string { return measured(input) ? `${value(input)} ms` : "—"; }
function name(id: LabTenantId, copy: Copy) { return `${copy.tenantName} ${tenantLetters[id]}`; }
function time(input: number, language: string) { return new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(input); }
function tenantStyle(id: LabTenantId): CSSProperties { return { "--lab-tenant": tenantColors[id] } as CSSProperties; }

export function TenantLoadLabPage() {
  const { i18n, t } = useTranslation();
  const language = i18n.language || "en";
  const copy = t("tenantLoadLab", { returnObjects: true }) as Copy;
  const auth = useAuth();
  const authorized = auth.user?.role === "admin";
  const queryClient = useQueryClient();
  const [duration, setDuration] = useState(30);
  const [focus, setFocus] = useState<LabTenantId>("tenantA");
  const [now, setNow] = useState(Date.now);
  const authority = useRef(authorized);
  authority.current = authorized;
  const query = useQuery({
    queryKey: tenantLoadLabKey,
    queryFn: ({ signal }) => getTenantLoadLabState(signal),
    enabled: authorized,
    staleTime: 0,
    retry: false,
    refetchInterval: current => current.state.data?.running ? 1_000 : false,
    refetchIntervalInBackground: false,
  });
  const control = useMutation({
    mutationFn: async (input: LabControl) => {
      await queryClient.cancelQueries({ queryKey: tenantLoadLabKey });
      return controlTenantLoadLab(input);
    },
    onSuccess: snapshot => { if (authority.current) queryClient.setQueryData(tenantLoadLabKey, snapshot); },
  });
  const data = query.data;
  useEffect(() => {
    if (!data?.running) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [data?.running]);
  function act(input: LabControl) { control.reset(); control.mutate(input); }
  const error = control.error || query.error;
  const disabled = control.isPending || !data;

  if (!authorized) return <section className="tenant-load-lab"><p role="alert">{copy.denied}</p></section>;
  return (
    <section className="tenant-load-lab">
      <header className="lab-page-heading">
        <div>
          <p className="lab-eyebrow"><FlaskConical size={14} aria-hidden="true" />{copy.eyebrow}<span className="lab-eyebrow-divider" />TASKLATTICE GUARD</p>
          <h1>{copy.title}</h1>
          <p className="lab-page-description">{copy.description}</p>
        </div>
        <div className="lab-environment"><span className="lab-test-mark">LAB</span><span>{copy.synthetic}</span></div>
      </header>

      <aside className="lab-mode-note" role="note" aria-label={copy.executionTitle}>
        <FlaskConical size={17} aria-hidden="true" />
        <div><strong>{copy.executionTitle}</strong><span>{copy.executionTargets}</span><span>{copy.executionPath}</span><span>{copy.executionScope}</span></div>
      </aside>

      <TenantAdmissionMonitorPanel />

      <div className="lab-controls">
        <ModeTabs mode={data?.mode ?? "shared"} onChange={mode => act({ action: "mode", mode })} disabled={disabled} copy={copy} />
        <div className="lab-controls-actions">
          <label className="lab-duration">{copy.duration}<select aria-label={copy.duration} value={duration} onChange={event => setDuration(Number(event.target.value))} disabled={control.isPending}>{[15, 30, 60].map(seconds => <option key={seconds} value={seconds}>{seconds} {copy.seconds}</option>)}</select></label>
          <Button variant="outline" onClick={() => act({ action: "reset" })} disabled={disabled}><RotateCcw size={16} />{copy.reset}</Button>
          <Button onClick={() => act({ action: data?.running ? "stop" : "start" })} disabled={disabled} className="lab-run-button">{control.isPending ? <LoaderCircle className="lab-spin" size={16} /> : data?.running ? <Pause size={16} /> : <Play size={16} />}{data?.running ? copy.pause : data?.history.length ? copy.resume : copy.start}</Button>
        </div>
      </div>

      {error ? <div className="lab-error" role="alert"><CircleAlert size={18} /><div><strong>{control.error ? copy.actionFailed : copy.failed}</strong><p>{error instanceof Error ? error.message : copy.unavailable}{query.data && query.error ? ` · ${copy.stale}` : ""}</p></div>{query.error ? <Button variant="ghost" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching}>{copy.refresh}</Button> : null}</div> : null}
      {query.isLoading ? <div className="lab-loading" role="status"><LoaderCircle className="lab-spin" size={20} /><span>{copy.loading}</span></div> : null}

      {data ? <>
        <div className="lab-mode-note" data-mode={data.mode}><Info size={17} aria-hidden="true" /><div><strong>{data.mode === "quota" ? copy.quotaLabel : copy.sharedLabel}</strong><span>{data.mode === "quota" ? copy.quotaDetail : copy.sharedDetail}</span></div><span className="lab-run-state" data-live={data.running}><i />{data.running ? copy.live : data.history.length ? copy.paused : copy.idle}</span></div>
        <HealthStrip data={data} copy={copy} />
        <GroupHealth data={data} copy={copy} />
        <div className="lab-tenant-grid">
          {tenantIds.map(id => <TenantCard key={id} tenant={data.tenants.find(item => item.id === id)} id={id} copy={copy} now={now} duration={duration} disabled={disabled || !data.running} onControl={act} />)}
        </div>
        <p className="lab-measurement-note"><Info size={14} aria-hidden="true" />{copy.decisionDetail}</p>
        <div className="lab-section-caption"><span>{copy.measuredWindow}</span><span><Clock3 size={13} />{copy.chartHint}</span></div>
        <div className="lab-chart-grid">
          <TrafficChart title={copy.occupancyChart} number="01" metric="occupancyPercent" samples={data.history} copy={copy} language={language} />
          <TrafficChart title={copy.latencyChart} number="02" metric="p95Ms" samples={data.history} copy={copy} language={language} />
        </div>
        <p className="lab-measurement-note"><Info size={14} aria-hidden="true" />{copy.occupancyDefinition}</p>
        <div className="lab-detail-grid">
          <StageChart samples={data.history} focus={focus} onFocus={setFocus} copy={copy} language={language} />
          <ImpactPanel data={data} now={now} copy={copy} />
        </div>
        <EventLog events={data.events} copy={copy} language={language} />
        <footer className="lab-footer"><span><span className="lab-footer-dot" />{copy.updated}: {data.history.length ? time(data.history[data.history.length - 1].time, language) : "—"}</span><span>{copy.limits}: {data.limits.maxRps} {copy.maxRate} · {data.limits.maxInflight} {copy.maxInflight} · {data.limits.queueLimit} {copy.queueLimit}</span></footer>
      </> : null}
    </section>
  );
}

function ModeTabs({ mode, onChange, disabled, copy }: { mode: LabMode; onChange: (mode: LabMode) => void; disabled: boolean; copy: Copy }) {
  const group = useRef<HTMLDivElement>(null);
  return <div role="tablist" aria-label={copy.mode} className="lab-mode-tabs" ref={group}>
    {(["shared", "quota"] as const).map(item => <Button key={item} role="tab" aria-selected={mode === item} tabIndex={mode === item ? 0 : -1} disabled={disabled} variant="ghost" onClick={() => { if (item !== mode) onChange(item); }} onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? "shared" : event.key === "End" ? "quota" : item === "shared" ? "quota" : "shared";
      (group.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next === "shared" ? 0 : 1])?.focus();
      if (next !== mode) onChange(next);
    }}>{item === "shared" ? <Activity size={15} /> : <Server size={15} />}{copy[item]}</Button>)}
  </div>;
}

function HealthStrip({ data, copy }: { data: TenantLoadLabState; copy: Copy }) {
  const completedRps = data.tenants.reduce((sum, tenant) => sum + tenant.completedRps, 0);
  const errors = data.tenants.reduce((sum, tenant) => sum + tenant.errors, 0);
  return <div className="lab-health-strip lab-health-strip--overview">
    <section className="lab-health-tile lab-model-tile"><p className="lab-tile-label"><Zap size={15} />{copy.model}<span className="lab-small-status"><Check size={12} />{data.fakeLlm.fixedLatencyMs} ms</span></p><div className="lab-tile-value">{data.fakeLlm.fixedLatencyMs}<small>ms <span>{copy.fixed}</span></small></div><p>{copy.observedP95} <strong>{ms(data.fakeLlm.p95Ms)}</strong><span className="lab-inline-separator">·</span>{data.fakeLlm.active}/{data.fakeLlm.capacity} {copy.active}</p><span className="lab-tile-description">{copy.modelDetail}</span></section>
    <section className="lab-health-tile"><p className="lab-tile-label"><Activity size={15} />{copy.throughput}</p><div className="lab-tile-value">{value(completedRps, 1)}<small>{copy.perSecond}</small></div><p>{copy.totalErrors} <strong data-error={errors > 0}>{value(errors)}</strong></p><span className="lab-tile-description">{copy.trafficDetail}</span></section>
  </div>;
}

function GroupHealth({ data, copy }: { data: TenantLoadLabState; copy: Copy }) {
  const groups = data.groups ?? [];
  return <section className="lab-group-allocation" aria-label={copy.groupsTitle}>
    <header><h2>{copy.groupsTitle}</h2><span>{copy.groupMetrics}</span></header>
    {groups.length ? <div className="lab-group-grid">{groups.map(group => {
      const runner = group.runner;
      const available = runner.metricsAvailable;
      const color = group.tenantIds.length === 1 && tenantColors[group.tenantIds[0]] ? tenantColors[group.tenantIds[0]] : "#0f62fe";
      return <article key={group.id} className="lab-group-card" style={{ "--lab-group-color": color } as CSSProperties} aria-label={`${group.name} · ${copy.groupMetrics}`}>
        <div className="lab-group-heading"><Server size={18} aria-hidden="true" /><div><h3>{group.name}</h3><code>{group.id}</code></div><span className="lab-small-status" data-ready={runner.ready}>{runner.ready ? copy.ready : copy.unavailable}</span></div>
        <div className="lab-group-members"><span>{copy.testTenants}</span>{group.tenantIds.map(id => <span className="lab-group-tenant-chip" key={id} style={tenantStyle(id)}><i />{name(id, copy)}</span>)}<code>{copy.pool}: {group.poolIds.join(", ") || "—"}</code></div>
        <dl className="lab-group-metrics"><div><dt>{copy.inflight} / {copy.capacity}</dt><dd>{value(available ? runner.inflight : null)}<small>/ {value(available ? runner.capacity : null)}</small></dd></div><div><dt>{copy.runnerQueue}</dt><dd>{value(available ? runner.queue : null)}</dd></div><div><dt><Cpu size={12} />{copy.cpu}</dt><dd>{available && measured(runner.cpuPercent) ? `${value(runner.cpuPercent, 1)}%` : "—"}</dd></div><div><dt>{copy.memory}</dt><dd>{value(available ? runner.memoryMiB : null)}<small>{available && measured(runner.memoryMiB) ? " MiB" : ""}</small></dd></div></dl>
        {!available ? <p className="lab-group-unavailable">{copy.noResource}</p> : null}
      </article>;
    })}</div> : <div className="lab-group-missing">{copy.noGroups}</div>}
    <p className="lab-group-scope"><Info size={14} aria-hidden="true" />{copy.groupScope}</p>
  </section>;
}

function TenantCard({ tenant, id, copy, now, duration, disabled, onControl }: { tenant?: LabTenant; id: LabTenantId; copy: Copy; now: number; duration: number; disabled: boolean; onControl: (input: LabControl) => void }) {
  const peak = Boolean(tenant?.peakUntil && tenant.peakUntil > now);
  const remaining = peak && tenant?.peakUntil ? Math.max(0, Math.ceil((tenant.peakUntil - now) / 1_000)) : 0;
  const occupancy = tenant?.occupancyPercent;
  const titleId = useId();
  const peakLabel = `${copy.peakFor} ${duration}${copy.peakSeconds}`;
  return <article className="lab-tenant-card" style={tenantStyle(id)} aria-labelledby={titleId} data-peak={peak}>
    <header><span className="lab-tenant-avatar">{tenantLetters[id]}</span><div><h2 id={titleId}>{name(id, copy)}</h2><span className="lab-tenant-account">{id} · {copy.testAccount}</span></div><span className="lab-tenant-phase" data-peak={peak}>{peak ? <><Zap size={12} />{copy.peak}</> : copy.baseline}</span></header>
    <div className="lab-tenant-placement"><span>{copy.group}: <strong>{tenant?.groupName || copy.unknownGroup}</strong></span><code title={tenant?.poolId}>{copy.pool}: {tenant?.poolId || "—"}</code></div>
    <div className="lab-occupancy-heading"><p>{copy.reference}</p><span>{value(tenant?.inflight)} / {value(tenant?.slotBudget)} {copy.referenceSlots}</span></div>
    <div className="lab-occupancy-value">{value(occupancy)}<small>%</small><span>{value(tenant?.inflight)} {copy.inflight}</span></div>
    <div className="lab-occupancy-track" role="progressbar" aria-label={`${name(id, copy)} ${copy.reference}`} aria-valuenow={measured(occupancy) ? occupancy : undefined} aria-valuemin={0} aria-valuemax={Math.max(100, occupancy ?? 0)}><span style={{ width: `${Math.min(100, Math.max(0, occupancy ?? 0))}%` }} /><i /></div>
    <dl className="lab-tenant-metrics"><div><dt>{copy.latency}</dt><dd>{ms(tenant?.p95Ms)}</dd></div><div><dt>{copy.queue}</dt><dd>{value(tenant?.queued)}<small>{copy.queued}</small></dd></div><div><dt>{copy.offered}</dt><dd>{value(tenant?.offeredRps, 1)}<small>{copy.perSecond}</small></dd></div><div><dt>{copy.completed}</dt><dd>{value(tenant?.completedRps, 1)}<small>{copy.perSecond}</small></dd></div></dl>
    <div role="group" aria-label={`${name(id, copy)} · ${copy.decisions}`}>
      <p className="lab-tile-description">{copy.decisions}</p>
      <dl className="lab-tenant-metrics"><div><dt>{copy.blocked}</dt><dd>{value(tenant ? tenant.blocked ?? 0 : undefined)}</dd></div><div><dt>{copy.transformed}</dt><dd>{value(tenant ? tenant.transformed ?? 0 : undefined)}</dd></div><div><dt>{copy.inputBlocked}</dt><dd>{value(tenant ? tenant.inputBlocked ?? 0 : undefined)}</dd></div><div><dt>{copy.outputBlocked}</dt><dd>{value(tenant ? tenant.outputBlocked ?? 0 : undefined)}</dd></div></dl>
    </div>
    <footer><span className="lab-tenant-totals">{value(tenant?.completed)} {copy.requests}<span>·</span><strong data-error={Boolean(tenant?.errors)}>{value(tenant?.errors)} {copy.errors}</strong></span><Button size="sm" variant={peak ? "secondary" : "outline"} disabled={disabled || !tenant} aria-label={`${peak ? copy.release : peakLabel} · ${name(id, copy)}`} onClick={() => onControl(peak ? { action: "release", tenantId: id } : { action: "peak", tenantId: id, durationSeconds: duration })}>{peak ? <><Pause size={14} />{copy.release}<span className="lab-peak-countdown">{remaining}{copy.seconds}</span></> : <><Zap size={14} />{peakLabel}</>}</Button></footer>
  </article>;
}

function ChartEmpty({ title, description }: { title: string; description: string }) { return <div className="lab-chart-empty"><Activity size={23} aria-hidden="true" /><strong>{title}</strong><span>{description}</span></div>; }
function ChartLegend({ copy }: { copy: Copy }) { return <div className="lab-chart-legend">{tenantIds.map(id => <span key={id}><i style={{ background: tenantColors[id] }} />{name(id, copy)}</span>)}</div>; }
function TrafficChart({ title, number, metric, samples, copy, language }: { title: string; number: string; metric: "occupancyPercent" | "p95Ms"; samples: LabSample[]; copy: Copy; language: string }) {
  const hasData = samples.some(sample => tenantIds.some(id => measured(sample[id]?.[metric])));
  const occupancy = metric === "occupancyPercent";
  return <section className="lab-chart-panel" aria-label={title}>
    <header><div><span className="lab-panel-number">{number}</span><h2>{title}</h2><span className="lab-chart-unit">{occupancy ? "%" : "ms"}</span></div><ChartLegend copy={copy} /></header>
    <div className="lab-main-chart" role="img" aria-label={`${title} · ${hasData ? copy.measuredWindow : copy.noSamples}`}>
      {hasData ? <ResponsiveContainer width="100%" height="100%"><LineChart data={samples} syncId="tenant-load-lab" margin={{ top: 16, right: 20, left: -8, bottom: 0 }} accessibilityLayer>
        <CartesianGrid vertical={false} stroke="var(--lab-grid)" strokeDasharray="3 3" />
        <XAxis dataKey="time" type="number" domain={["dataMin", "dataMax"]} tickFormatter={input => time(Number(input), language)} tick={{ fontSize: 10, fill: "var(--lab-muted)" }} tickLine={false} axisLine={false} minTickGap={38} />
        <YAxis domain={occupancy ? [0, (maximum: number) => Math.max(100, Math.ceil(maximum / 25) * 25)] : [0, "auto"]} tick={{ fontSize: 10, fill: "var(--lab-muted)" }} tickLine={false} axisLine={false} width={54} tickFormatter={input => `${input}${occupancy ? "%" : ""}`} />
        {occupancy ? <ReferenceLine y={100} stroke="#8d8d8d" strokeDasharray="4 4" /> : null}
        <Tooltip labelFormatter={input => time(Number(input), language)} formatter={(input, label) => [`${value(Number(input))}${occupancy ? "%" : " ms"}`, label]} contentStyle={tooltipStyle} />
        {tenantIds.map(id => <Line key={id} name={name(id, copy)} dataKey={`${id}.${metric}`} type="linear" stroke={tenantColors[id]} strokeWidth={2.25} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "#fff" }} isAnimationActive={false} connectNulls={false} />)}
      </LineChart></ResponsiveContainer> : <ChartEmpty title={occupancy ? copy.noSamples : copy.noLatency} description={occupancy ? copy.noSamplesDetail : copy.noLatencyDetail} />}
    </div>
  </section>;
}
const tooltipStyle: CSSProperties = { border: "1px solid #c6c6c6", borderRadius: 0, background: "#fff", fontSize: 12, padding: "10px 12px", boxShadow: "0 2px 8px #00000012" };

function StageChart({ samples, focus, onFocus, copy, language }: { samples: LabSample[]; focus: LabTenantId; onFocus: (id: LabTenantId) => void; copy: Copy; language: string }) {
  const series = [{ key: "queueP95Ms", label: copy.queueStage, color: "#8d8d8d" }, { key: "guardP95Ms", label: copy.guard, color: tenantColors[focus] }, { key: "modelP95Ms", label: copy.modelStage, color: "#24a148" }];
  const hasData = samples.some(sample => series.some(item => measured(sample[focus]?.[item.key as keyof LabMetric])));
  return <section className="lab-stage-panel">
    <header className="lab-detail-heading"><div><h2>{copy.detail}</h2><p>{copy.stageHint}</p></div><label className="lab-focus-select"><span className="sr-only">{copy.focus}</span><select aria-label={copy.focus} value={focus} onChange={event => onFocus(event.target.value as LabTenantId)}>{tenantIds.map(id => <option key={id} value={id}>{name(id, copy)}</option>)}</select></label></header>
    <div className="lab-stage-legend">{series.map(item => <span key={item.key}><i style={{ background: item.color }} />{item.label}</span>)}</div>
    <div className="lab-stage-chart" role="img" aria-label={`${copy.detail} · ${name(focus, copy)}`}>
      {hasData ? <ResponsiveContainer width="100%" height="100%"><LineChart data={samples} syncId="tenant-load-lab" margin={{ top: 10, right: 18, left: -8, bottom: 0 }} accessibilityLayer><CartesianGrid vertical={false} stroke="var(--lab-grid)" strokeDasharray="3 3" /><XAxis dataKey="time" type="number" domain={["dataMin", "dataMax"]} tickFormatter={input => time(Number(input), language)} tick={{ fontSize: 10, fill: "var(--lab-muted)" }} tickLine={false} axisLine={false} minTickGap={45} /><YAxis width={54} tick={{ fontSize: 10, fill: "var(--lab-muted)" }} tickLine={false} axisLine={false} /><Tooltip labelFormatter={input => time(Number(input), language)} formatter={(input, label) => [ms(Number(input)), label]} contentStyle={tooltipStyle} />{series.map(item => <Line key={item.key} name={item.label} dataKey={`${focus}.${item.key}`} stroke={item.color} strokeWidth={2} strokeDasharray={item.key === "modelP95Ms" ? "5 3" : undefined} dot={false} type="linear" isAnimationActive={false} connectNulls={false} />)}</LineChart></ResponsiveContainer> : <ChartEmpty title={copy.noLatency} description={copy.noLatencyDetail} />}
    </div>
  </section>;
}

function median(values: number[]) { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; }
function impactWindow(data: TenantLoadLabState, now: number) {
  const peak = [...data.events].filter(event => event.kind === "peak" && event.tenantId && tenantIds.includes(event.tenantId)).sort((a, b) => b.time - a.time)[0];
  if (!peak?.tenantId) return null;
  const release = data.events.filter(event => event.tenantId === peak.tenantId && event.time > peak.time && ["release", "peak_end", "peak_expired"].includes(event.kind)).sort((a, b) => a.time - b.time)[0];
  const activeEnd = data.tenants.find(tenant => tenant.id === peak.tenantId)?.peakUntil;
  // Without an end marker or an active peak, avoid relabeling recovery samples as peak traffic.
  const end = release?.time ?? (activeEnd && activeEnd > peak.time ? Math.min(activeEnd, now) : null);
  if (end === null) return null;
  return { peak, before: data.history.filter(sample => sample.time >= peak.time - 15_000 && sample.time < peak.time), during: data.history.filter(sample => sample.time >= peak.time && sample.time <= end) };
}
function ImpactPanel({ data, now, copy }: { data: TenantLoadLabState; now: number; copy: Copy }) {
  const window = useMemo(() => impactWindow(data, now), [data, now]);
  const enough = window && window.before.length >= 3 && window.during.length >= 3;
  return <section className="lab-impact-panel"><header className="lab-detail-heading"><div><h2>{copy.impact}</h2><p>{copy.impactHint}</p></div><ArrowUpRight size={18} aria-hidden="true" /></header>{enough ? <>
    <div className="lab-impact-context" style={tenantStyle(window.peak.tenantId!)}><span className="lab-legend-dot" />{copy.peakOf}: <strong>{name(window.peak.tenantId!, copy)}</strong><span>{window.before.length} / {window.during.length} {copy.sampleCount}</span></div>
    <table className="lab-impact-table"><thead><tr><th>{copy.peer}</th><th>{copy.baselineColumn}</th><th>{copy.peakColumn}</th><th>{copy.change}</th></tr></thead><tbody>{tenantIds.filter(id => id !== window.peak.tenantId).map(id => {
      const before = window.before.map(sample => sample[id].p95Ms).filter(measured);
      const during = window.during.map(sample => sample[id].p95Ms).filter(measured);
      const baseline = before.length >= 3 ? median(before) : null;
      const peak = during.length >= 3 ? median(during) : null;
      const delta = measured(baseline) && baseline > 0 && measured(peak) ? ((peak - baseline) / baseline) * 100 : null;
      const beforeRate = median(window.before.map(sample => sample[id].completedRps).filter(measured));
      const peakRate = median(window.during.map(sample => sample[id].completedRps).filter(measured));
      const peerGroup = data.tenants.find(tenant => tenant.id === id)?.groupId;
      const peakGroup = data.tenants.find(tenant => tenant.id === window.peak.tenantId)?.groupId;
      const relation = peerGroup && peakGroup ? peerGroup === peakGroup ? "same" : "separate" : "unknown";
      return <tr key={id}><th><span className="lab-peer-name"><i style={{ background: tenantColors[id] }} />{name(id, copy)}</span><span className="lab-peer-group" data-relation={relation}>{relation === "same" ? copy.sameGroup : relation === "separate" ? copy.separateGroup : copy.unknownGroup}</span><small>{copy.peerRate}: {value(beforeRate, 1)} → {value(peakRate, 1)} {copy.perSecond}</small></th><td>{ms(baseline)}</td><td>{ms(peak)}</td><td><span className="lab-delta" data-direction={measured(delta) ? delta > 5 ? "up" : delta < -5 ? "down" : "flat" : "unknown"}>{measured(delta) ? <>{delta > 0 ? <ArrowUp size={12} /> : delta < 0 ? <ArrowDown size={12} /> : null}{delta > 0 ? "+" : ""}{value(delta, 0)}%</> : "—"}</span></td></tr>;
    })}</tbody></table><p className="lab-impact-footnote">{copy.comparisonWindow}</p>
  </> : <div className="lab-impact-empty"><span className="lab-impact-empty-icon"><ArrowUpRight size={23} /></span><strong>{copy.noImpact}</strong><p>{copy.noImpactDetail}</p></div>}</section>;
}

function EventLog({ events, copy, language }: { events: LabEvent[]; copy: Copy; language: string }) {
  const ordered = [...events].sort((a, b) => b.time - a.time).slice(0, 30);
  return <section className="lab-events-panel"><header><div><h2>{copy.events}</h2><p>{copy.eventHint}</p></div><span className="lab-event-count">{events.length}</span></header>{ordered.length ? <ol>{ordered.map(event => <li key={event.id}><time dateTime={new Date(event.time).toISOString()}>{time(event.time, language)}</time><i style={{ background: event.tenantId && tenantColors[event.tenantId] ? tenantColors[event.tenantId] : "#8d8d8d" }} /><span className="lab-event-tenant">{event.tenantId && tenantIds.includes(event.tenantId) ? name(event.tenantId, copy) : "LAB"}</span><span>{event.message}</span></li>)}</ol> : <p className="lab-events-empty">{copy.noEvents}</p>}</section>;
}
