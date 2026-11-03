import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { admissionMonitorKey, getAdmissionMonitor, type AdmissionMonitorEntity } from "@/lib/admission-monitor-api";
import "./tenant-admission-monitor.scss";

const colors = ["#0f62fe", "#8a3ffc", "#009d9a", "#d12771", "#8a5b00"];
const number = (value: number | null | undefined, digits = 1) => value === null || value === undefined ? "—" : value.toLocaleString(undefined, { maximumFractionDigits: digits });
function status(entity: AdmissionMonitorEntity, failed: boolean) {
  if (failed) return "Connection unavailable";
  if (entity.available) return entity.intervalAvailable ? "Measured" : "Gauges measured · waiting for valid interval";
  return ({ offline: "Runner offline", stale: "Heartbeat stale", disabled: "Admission monitoring disabled", tenant_group_mismatch: "Allocation/report mismatch",
    missing_current_session_report: "Waiting for current session", no_registered_runners: "No registered Runners", not_configured: "Tenant budget unavailable",
    runner_syncing: "Runner synchronizing", cardinality_limit: "Monitoring cardinality limit", payload_limit: "Monitoring payload limit" } as Record<string, string>)[entity.reason ?? ""] ?? "Measurements unavailable";
}

/** Independent from the optional traffic generator: every value comes from an
 * authenticated Runner heartbeat. The browser never scrapes a metrics URL. */
export function TenantAdmissionMonitorPanel() {
  const [poolId, setPoolId] = useState("");
  const query = useQuery({ queryKey: [...admissionMonitorKey, poolId], queryFn: ({ signal }) => getAdmissionMonitor(poolId || undefined, signal),
    retry: false, throwOnError: false, staleTime: 0, refetchInterval: 5000, refetchIntervalInBackground: false });
  const state = query.data, failed = query.isError;
  const choices = useRef(state?.pools ?? []);
  if (!poolId && state) choices.current = state.pools;
  return <section className="admission-monitor" aria-label="Measured tenant admission">
    <header><div><h2>Measured tenant admission</h2><p>Actual Endpoint permits and queues from authenticated Runner heartbeats.</p></div>
      <label>Source pool<select aria-label="Admission source pool" value={poolId} onChange={event => setPoolId(event.target.value)}><option value="">All allocated pools</option>
        {choices.current.map(pool => <option key={pool.id} value={pool.id}>{pool.name} · {pool.id}</option>)}</select></label></header>
    {query.isLoading ? <p role="status">Waiting for admission measurements…</p> : null}
    {failed ? <p role="alert">Admission measurements are unavailable. Historical charts retain their recorded values.</p> : null}
    {state ? <>
      {!state.available && !failed ? <p role="status">Current measurements unavailable{state.reason === "inventory_limit" ? ": monitoring inventory limit reached. Select a source pool." : ": enable local admission and wait for current Runner heartbeats."}</p> : null}
      <div className="admission-monitor-groups">{state.groups.map(group => <article key={group.id} aria-label={`Measured group ${group.name}`}>
        <h3>{group.name}</h3><p>{group.tenantIds.join(" + ") || "No tenants"} · {group.poolIds.join(", ") || "No pools"}</p>
        <strong>{number(failed ? null : group.values.active, 0)} / {number(failed ? null : group.values.capacity, 0)} permits</strong>
        <span>Queue {number(failed ? null : group.values.queued, 0)} · wait p95 {number(failed ? null : group.values.waitP95Ms)} ms</span>
        <small>{status(group, failed)} · {group.reportingSources}/{group.expectedSources} sources</small>
      </article>)}</div>
      <div className="admission-monitor-charts"><GroupChart groups={state.groups} metric="occupancyPercent" title="Group permit occupancy" unit="%" />
        <GroupChart groups={state.groups} metric="waitP95Ms" title="Group admission wait p95 · histogram estimate" unit=" ms" /></div>
      <div className="admission-monitor-table"><table><caption>Tenant measurements · counters cover current Runner processes</caption><thead><tr>
        <th>Tenant / group</th><th>Permits / cap</th><th>Queue</th><th>Attempts</th><th>Admitted</th><th>Rejected</th><th>Admitted/s</th><th>Wait p95</th><th>Held p95</th><th>Coverage</th>
      </tr></thead><tbody>{state.tenants.map(tenant => <tr key={tenant.id}><th>{tenant.name}<small>{tenant.id} · {state.groups.find(group => group.id === tenant.groupId)?.name ?? tenant.groupId}</small></th>
        <td>{number(failed ? null : tenant.values.active, 0)} / {number(failed ? null : tenant.values.capacity, 0)}</td><td>{number(failed ? null : tenant.values.queued, 0)}</td>
        <td>{number(failed ? null : tenant.values.attempts, 0)}</td><td>{number(failed ? null : tenant.values.admitted, 0)}</td><td>{number(failed ? null : tenant.values.rejected, 0)}</td>
        <td>{number(failed ? null : tenant.values.admittedPerSecond)}</td><td>{number(failed ? null : tenant.values.waitP95Ms)} ms</td><td>{number(failed ? null : tenant.values.heldP95Ms)} ms</td>
        <td>{status(tenant, failed)}</td></tr>)}</tbody></table></div>
      <p className="admission-monitor-note">Caps are local limits and do not reserve group capacity. Wait measures admission to a permit; held time includes distributed rate checks and cleanup.
        Rejected counts include queue/rate/availability denials; cancelled attempts are separate. p95 uses bucket deltas from the latest valid heartbeat intervals; empty, reset and open-ended buckets produce gaps.
        History is local to this Controller and clears on restart or allocation/session changes.</p>
      <p className="admission-monitor-note">Last Controller observation: {new Date(state.observedAt).toLocaleTimeString()} · source freshness limit {state.staleAfterMs / 1000}s</p>
    </> : null}
  </section>;
}

function GroupChart({ groups, metric, title, unit }: { groups: AdmissionMonitorEntity[]; metric: "occupancyPercent" | "waitP95Ms"; title: string; unit: string }) {
  const frames = new Map<number, Record<string, number | null>>();
  groups.forEach((group, index) => group.history.forEach(point => {
    const row = frames.get(point.at) ?? { at: point.at }; row[`g${index}`] = point.values[metric]; frames.set(point.at, row);
  }));
  const data = [...frames.values()].sort((left, right) => Number(left.at) - Number(right.at));
  return <figure aria-label={title}><figcaption>{title}</figcaption><div className="admission-monitor-chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={data}>
    <CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="at" tickFormatter={value => new Date(value).toLocaleTimeString()} /><YAxis unit={unit} />
    <Tooltip labelFormatter={value => new Date(Number(value)).toLocaleTimeString()} />
    {groups.map((group, index) => <Line key={group.id} name={group.name} dataKey={`g${index}`} stroke={colors[index % colors.length]} connectNulls={false} dot={false} isAnimationActive={false} />)}
  </LineChart></ResponsiveContainer></div><div className="admission-monitor-legend">{groups.map((group, index) => <span key={group.id}><i style={{ background: colors[index % colors.length] }} />{group.name}</span>)}</div></figure>;
}
