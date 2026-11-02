import { useId, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Cable, Check, Info, LoaderCircle, Pencil, Plus, RefreshCw, Server, Trash2, UsersRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "@tanstack/react-router";
import { EntitySheet } from "@/components/entity-sheet";
import { GroupModelConfigurationSheet } from "@/components/group-model-configuration";
import { EmptyState, ErrorNotice, PageHeader } from "@/components/product-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "@/components/ui/notifications";
import { useAuth } from "@/lib/auth";
import { listRunnerPools, type RunnerPool } from "@/lib/controller-api";
import { assignRunnerPoolGroup, assignTenantGroup, createTenantGroup, deleteTenantGroup, getTenantGroups, registerGroupRunnerPool, renameTenantGroup, tenantGroupsKey, updateRunnerPoolConnectivity, type GroupRunnerPool, type GroupTenant, type TenantGroup, type TenantGroupDirectory } from "@/lib/tenant-groups-api";
import { tenantGroupsEn, tenantGroupsZh, type TenantGroupsCopy } from "@/tenant-groups-i18n";
import "./tenant-groups.scss";

type Editor = { kind: "models"; group: TenantGroup } | { kind: "group"; group?: TenantGroup } | { kind: "delete"; group: TenantGroup } | { kind: "assignment"; resource: "tenant" | "pool"; item: GroupTenant | GroupRunnerPool } | { kind: "pool"; groupId: string } | { kind: "connectivity"; pool: GroupRunnerPool };
const emptyDirectory: TenantGroupDirectory = { items: [], tenants: [], pools: [] };
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const defaultPool = (pool: GroupTenant | GroupRunnerPool) => pool.id === "default" || ("isDefault" in pool && pool.isDefault);
function validOrigin(input: string): boolean {
  try { const url = new URL(input); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/" && !/\s/.test(input); } catch { return false; }
}
function connected(pool: GroupRunnerPool) { return pool.instances?.filter(instance => instance.status !== "offline").length; }

export function TenantGroupsPage() {
  const { i18n } = useTranslation();
  const copy = i18n.language?.toLowerCase().startsWith("zh") ? tenantGroupsZh : tenantGroupsEn;
  const { user } = useAuth();
  const administrator = user?.role === "admin";
  const client = useQueryClient();
  const query = useQuery({ queryKey: tenantGroupsKey, queryFn: ({ signal }) => getTenantGroups(signal), enabled: administrator, retry: false });
  const live = useQuery({ queryKey: ["resources", "runner-pools"], queryFn: ({ signal }) => listRunnerPools(signal), enabled: administrator, retry: false, refetchInterval: 10_000 });
  const [editor, setEditor] = useState<Editor | null>(null);
  const directory = query.data ?? emptyDirectory;
  const data = { ...directory, pools: directory.pools.map(pool => ({ ...pool, instances: live.data?.items.find(item => item.id === pool.id)?.instances ?? pool.instances })) };
  const groupName = (id: string) => data.items.find(group => group.id === id)?.name ?? id;
  async function saved(message: string) {
    setEditor(null);
    await Promise.all([
      client.invalidateQueries({ queryKey: tenantGroupsKey }),
      client.invalidateQueries({ queryKey: ["resources", "runner-pools"] }),
      client.invalidateQueries({ queryKey: ["resources", "endpoints"] }),
    ]);
    toast.success(message);
  }
  async function reviewAssignment() {
    if (editor?.kind !== "assignment") return;
    const result = await query.refetch();
    if (!result.data) return;
    const item = (editor.resource === "tenant" ? result.data.tenants : result.data.pools).find(item => item.id === editor.item.id);
    if (item) setEditor({ ...editor, item });
  }
  if (!administrator) return <section className="tenant-groups-page"><EmptyState title={copy.adminOnly} description={copy.groupAccess} /></section>;

  return <section className="tenant-groups-page">
    <PageHeader title={copy.title} description={copy.description} action={<div className="tenant-groups-header-actions"><Button variant="outline" onClick={() => { void query.refetch(); void live.refetch(); }} disabled={query.isFetching || live.isFetching}><RefreshCw className={query.isFetching || live.isFetching ? "animate-spin motion-reduce:animate-none" : undefined} />{copy.refresh}</Button><Button onClick={() => setEditor({ kind: "group" })} disabled={!query.data}><Plus />{copy.create}</Button></div>} />
    <div className="tenant-groups-boundary"><Info size={18} aria-hidden="true" /><p>{copy.boundary}</p></div>
    {query.error ? <div className="tenant-groups-error"><ErrorNotice error={query.error} /><Button variant="outline" onClick={() => void query.refetch()} disabled={query.isFetching}>{copy.retry}</Button></div> : null}
    {query.isLoading ? <div className="tenant-groups-loading" role="status"><LoaderCircle className="animate-spin motion-reduce:animate-none" />{copy.loading}</div> : null}
    {query.data ? <>
      <dl className="tenant-groups-summary">{[{ label: copy.groupCount, count: data.items.length, icon: Building2 }, { label: copy.tenantCount, count: data.tenants.length, icon: UsersRound }, { label: copy.poolCount, count: data.pools.length, icon: Server }].map(item => <div key={item.label}><dt><item.icon size={16} aria-hidden="true" />{item.label}</dt><dd>{item.count}</dd></div>)}</dl>
      <GroupCapacity groups={data.items} pools={live.data?.items} unavailable={live.isError} copy={copy} />
      <Tabs defaultValue="groups" className="tenant-groups-tabs">
        <TabsList aria-label={copy.overview}><TabsTrigger value="groups">{copy.groups}</TabsTrigger><TabsTrigger value="tenants">{copy.membership}</TabsTrigger><TabsTrigger value="pools">{copy.allocation}</TabsTrigger></TabsList>
        <TabsContent value="groups"><section className="tenant-groups-table-panel"><header><h2>{copy.groups}</h2><span>{data.items.length}</span></header>{data.items.length ? <Table aria-label={copy.groups}><TableHeader><TableRow><TableHead>{copy.group}</TableHead><TableHead>{copy.tenantCount}</TableHead><TableHead>{copy.poolCount}</TableHead><TableHead>{copy.actions}</TableHead></TableRow></TableHeader><TableBody>{data.items.map(group => <TableRow key={group.id}><TableCell><Identity name={group.name} id={group.id} />{group.isDefault ? <span className="tenant-group-default"><Check size={12} />{copy.default}</span> : null}</TableCell><TableCell><Associations ids={group.tenantIds} names={data.tenants} empty={copy.noTenants} /></TableCell><TableCell><Associations ids={group.poolIds} names={data.pools} empty={copy.noPools} warning={!group.poolIds.length && group.tenantIds.length > 0} /></TableCell><TableCell><div className="tenant-group-row-actions"><Button variant="ghost" size="sm" aria-label={`${copy.runtimeModels} · ${group.name}`} onClick={() => setEditor({ kind: "models", group })}>{copy.runtimeModels}</Button><Button variant="ghost" size="sm" aria-label={`${copy.rename} · ${group.name}`} onClick={() => setEditor({ kind: "group", group })}><Pencil size={15} />{copy.rename}</Button><Button variant="ghost" size="sm" aria-label={`${copy.registerPool} · ${group.name}`} onClick={() => setEditor({ kind: "pool", groupId: group.id })}><Plus size={15} />{copy.registerPool}</Button><Button variant="ghost" size="sm" aria-label={`${copy.remove} · ${group.name}`} disabled={group.isDefault || Boolean(group.tenantIds.length || group.poolIds.length)} title={group.isDefault ? copy.defaultProtected : group.tenantIds.length || group.poolIds.length ? copy.occupiedProtected : undefined} onClick={() => setEditor({ kind: "delete", group })}><Trash2 size={15} /></Button></div></TableCell></TableRow>)}</TableBody></Table> : <EmptyState title={copy.noGroups} description={copy.noGroupsHint} />}</section></TabsContent>
        <TabsContent value="tenants"><section className="tenant-groups-table-panel"><header><h2>{copy.membership}</h2><span>{data.tenants.length}</span></header>{data.tenants.length ? <Table aria-label={copy.membership}><TableHeader><TableRow><TableHead>{copy.tenant}</TableHead><TableHead>{copy.group}</TableHead><TableHead>{copy.poolCount}</TableHead><TableHead>{copy.actions}</TableHead></TableRow></TableHeader><TableBody>{data.tenants.map(tenant => <TableRow key={tenant.id}><TableCell><Identity name={tenant.name} id={tenant.id} /></TableCell><IdentityCell name={groupName(tenant.groupId)} id={tenant.groupId} /><TableCell><Associations ids={data.items.find(group => group.id === tenant.groupId)?.poolIds ?? []} names={data.pools} empty={copy.noPools} warning /></TableCell><TableCell><Button variant="ghost" size="sm" onClick={() => setEditor({ kind: "assignment", resource: "tenant", item: tenant })} aria-label={`${copy.changeGroup} · ${tenant.name}`}>{copy.changeGroup}</Button></TableCell></TableRow>)}</TableBody></Table> : <EmptyState title={copy.noTenants} description={copy.noTenantsHint} />}</section></TabsContent>
        <TabsContent value="pools"><section className="tenant-groups-table-panel"><header><h2>{copy.allocation}</h2><Button variant="outline" size="sm" onClick={() => setEditor({ kind: "pool", groupId: data.items.find(group => group.isDefault)?.id ?? data.items[0]?.id ?? "" })} disabled={!data.items.length}><Plus />{copy.registerPool}</Button></header>{data.pools.length ? <Table aria-label={copy.allocation}><TableHeader><TableRow><TableHead>{copy.pool}</TableHead><TableHead>{copy.group}</TableHead><TableHead>{copy.connectivity}</TableHead><TableHead>{copy.instances}</TableHead><TableHead>{copy.actions}</TableHead></TableRow></TableHeader><TableBody>{data.pools.map(pool => <TableRow key={pool.id}><TableCell><Identity name={pool.name} id={pool.id} />{defaultPool(pool) ? <span className="tenant-group-default">{copy.default}</span> : null}</TableCell><IdentityCell name={groupName(pool.groupId)} id={pool.groupId} /><TableCell><div className="tenant-group-urls"><span>{copy.runtime}<code>{pool.runtimeUrl || (defaultPool(pool) ? copy.inherited : copy.notConfigured)}</code></span><span>{copy.public}<code>{pool.publicUrl || (defaultPool(pool) ? copy.inherited : copy.notConfigured)}</code></span></div></TableCell><TableCell><span className="tenant-group-instance-status">{connected(pool) === undefined ? copy.statusUnavailable : connected(pool) ? `${connected(pool)} ${copy.online}` : copy.noneConnected}</span></TableCell><TableCell><div className="tenant-group-row-actions"><Button variant="ghost" size="sm" onClick={() => setEditor({ kind: "connectivity", pool })} aria-label={`${copy.connectivity} · ${pool.name}`}><Cable size={15} />{copy.connectivity}</Button><Button variant="ghost" size="sm" disabled={defaultPool(pool)} title={defaultPool(pool) ? copy.defaultPoolProtected : undefined} onClick={() => setEditor({ kind: "assignment", resource: "pool", item: pool })} aria-label={`${copy.changeGroup} · ${pool.name}`}>{copy.changeGroup}</Button></div></TableCell></TableRow>)}</TableBody></Table> : <EmptyState title={copy.noPools} description={copy.noPoolsHint} />}</section><p className="tenant-group-deployment-hint"><Info size={15} />{copy.deploymentHint}</p></TabsContent>
      </Tabs>
    </> : null}
    {editor?.kind === "models" ? <GroupModelConfigurationSheet key={editor.group.id} group={editor.group} copy={copy} onClose={() => setEditor(null)} /> : null}
    {editor?.kind === "group" ? <GroupEditor key={editor.group?.id ?? "new"} group={editor.group} copy={copy} onClose={() => setEditor(null)} onSaved={saved} /> : null}
    {editor?.kind === "delete" ? <DeleteGroupSheet group={editor.group} copy={copy} onClose={() => setEditor(null)} onSaved={saved} /> : null}
    {editor?.kind === "assignment" ? <AssignmentSheet key={`${editor.resource}:${editor.item.id}:${editor.item.groupId}`} resource={editor.resource} item={editor.item} data={data} copy={copy} onClose={() => setEditor(null)} onReview={reviewAssignment} onSaved={saved} /> : null}
    {editor?.kind === "pool" ? <PoolEditor groupId={editor.groupId} data={data} copy={copy} onClose={() => setEditor(null)} onSaved={saved} /> : null}
    {editor?.kind === "connectivity" ? <ConnectivitySheet pool={editor.pool} copy={copy} onClose={() => setEditor(null)} onSaved={saved} /> : null}
  </section>;
}

function Identity({ name, id }: { name: string; id: string }) { return <span className="tenant-group-identity"><strong>{name}</strong><code>{id}</code></span>; }
function GroupCapacity({ groups, pools, unavailable, copy }: { groups: TenantGroup[]; pools?: RunnerPool[]; unavailable: boolean; copy: TenantGroupsCopy }) {
  return <section className="tenant-group-live" aria-label={copy.liveTitle}><header><div><h2>{copy.liveTitle}</h2><p>{copy.liveHint}</p></div><Link className="tenant-group-monitor-link" to="/settings/runner">{copy.monitoring}</Link></header><div className="tenant-group-live-grid">{groups.map(group => {
    const allocated = pools?.filter(pool => group.poolIds.includes(pool.id));
    const instances = allocated?.flatMap(pool => pool.instances);
    const serving = instances?.filter(instance => ["ready", "busy", "saturated"].includes(instance.status) && instance.load != null);
    const observed = !unavailable && Boolean(serving?.length);
    const inflight = serving?.reduce((sum, instance) => sum + instance.load!.inflight, 0) ?? 0;
    const capacity = serving?.reduce((sum, instance) => sum + instance.load!.maxConcurrency, 0) ?? 0;
    const queue = serving?.reduce((sum, instance) => sum + instance.load!.queueDepth, 0) ?? 0;
    const measuredLatency = serving?.filter(instance => instance.load!.requestsDelta > 0).map(instance => instance.load!.latencyP95Ms) ?? [];
    const p95 = measuredLatency.length ? Math.max(...measuredLatency) : null;
    return <article key={group.id} aria-label={`${copy.liveTitle} · ${group.name}`}><div className="tenant-group-live-heading"><strong>{group.name}</strong><span>{unavailable || !instances ? "—" : `${instances.filter(instance => instance.status !== "offline").length} ${copy.liveRunners}`}</span></div><dl><div><dt>{copy.inflightCapacity}</dt><dd>{observed ? `${inflight} / ${capacity}` : "—"}</dd></div><div><dt>{copy.queueDepth}</dt><dd>{observed ? queue : "—"}</dd></div><div><dt>{copy.highestP95}</dt><dd>{observed && p95 !== null ? `${Math.round(p95)} ms` : "—"}</dd></div></dl>{!observed ? <p>{unavailable ? copy.metricsUnavailable : copy.waitingMetrics}</p> : null}</article>;
  })}</div><p className="tenant-group-live-updates">{copy.liveUpdates}</p></section>;
}
function IdentityCell(props: { name: string; id: string }) { return <TableCell><Identity {...props} /></TableCell>; }
function Associations({ ids, names, empty, warning }: { ids: string[]; names: Array<{ id: string; name: string }>; empty: string; warning?: boolean }) { return ids.length ? <div className="tenant-group-associations">{ids.map(id => <span key={id} title={id}>{names.find(item => item.id === id)?.name ?? id}</span>)}</div> : <span className={warning ? "tenant-group-empty-warning" : "tenant-group-empty"}>{empty}</span>; }
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) { return <label className="tenant-group-field"><span>{label}</span>{children}{hint ? <small>{hint}</small> : null}</label>; }
function Note({ children, warning = false }: { children: ReactNode; warning?: boolean }) { return <div className="tenant-group-note" data-warning={warning}><Info size={17} aria-hidden="true" /><p>{children}</p></div>; }
type SheetProps = { copy: TenantGroupsCopy; onClose: () => void; onSaved: (message: string) => Promise<void> };
function FormFooter({ copy, pending, valid, submit, onClose, label }: { copy: TenantGroupsCopy; pending: boolean; valid: boolean; submit: () => void; onClose: () => void; label?: string }) { return <><Button variant="outline" disabled={pending} onClick={onClose}>{copy.cancel}</Button><Button disabled={pending || !valid} onClick={submit}>{pending ? <LoaderCircle className="animate-spin motion-reduce:animate-none" /> : null}{pending ? copy.saving : label ?? copy.save}</Button></>; }

function GroupEditor({ group, copy, onClose, onSaved }: SheetProps & { group?: TenantGroup }) {
  const [name, setName] = useState(group?.name ?? "");
  const [id, setId] = useState("");
  const mutation = useMutation({ mutationFn: () => group ? renameTenantGroup(group.id, name.trim()) : createTenantGroup({ name: name.trim(), ...(id.trim() ? { id: id.trim() } : {}) }), onSuccess: () => onSaved(group ? copy.renamed : copy.created) });
  const valid = Boolean(name.trim()) && name.trim().length <= 160 && (!id || (slug.test(id) && id.length <= 63)) && (!group || name.trim() !== group.name);
  return <EntitySheet open onOpenChange={open => { if (!open) onClose(); }} closeDisabled={mutation.isPending} eyebrow={copy.manageGroup} title={group ? copy.renameTitle : copy.createTitle} description={group ? copy.renameHint : copy.createHint} width="md" footer={<FormFooter copy={copy} pending={mutation.isPending} valid={valid} submit={() => mutation.mutate()} onClose={onClose} label={group ? copy.save : copy.create} />}>
    <div className="tenant-group-form">{mutation.error ? <ErrorNotice error={mutation.error} /> : null}<Field label={copy.name}><Input autoFocus aria-label={copy.name} value={name} onChange={event => setName(event.target.value)} maxLength={160} disabled={mutation.isPending} /></Field>{group ? <dl className="tenant-group-facts"><div><dt>{copy.groupIdLabel}</dt><dd><code>{group.id}</code></dd></div></dl> : <Field label={`${copy.groupId} (${copy.optional})`} hint={copy.immutableId}><Input aria-label={copy.groupId} value={id} onChange={event => setId(event.target.value)} maxLength={63} disabled={mutation.isPending} /></Field>}</div>
  </EntitySheet>;
}

function DeleteGroupSheet({ group, copy, onClose, onSaved }: SheetProps & { group: TenantGroup }) {
  const [confirmation, setConfirmation] = useState("");
  const protectedGroup = group.isDefault || Boolean(group.tenantIds.length || group.poolIds.length);
  const mutation = useMutation({ mutationFn: () => deleteTenantGroup(group.id), onSuccess: () => onSaved(copy.deleted) });
  return <EntitySheet open onOpenChange={open => { if (!open) onClose(); }} closeDisabled={mutation.isPending} eyebrow={copy.manageGroup} title={copy.deleteTitle} description={copy.deleteHint} width="md" footer={<><Button variant="outline" disabled={mutation.isPending} onClick={onClose}>{copy.cancel}</Button><Button variant="destructive" disabled={protectedGroup || confirmation !== group.id || mutation.isPending} onClick={() => mutation.mutate()}><Trash2 />{mutation.isPending ? copy.deleting : copy.remove}</Button></>}>
    <div className="tenant-group-form">{mutation.error ? <ErrorNotice error={mutation.error} /> : null}<Identity name={group.name} id={group.id} /><Note warning>{protectedGroup ? group.isDefault ? copy.defaultProtected : copy.occupiedProtected : copy.deleteNote}</Note><Field label={copy.deleteConfirmation}><Input aria-label={copy.deleteConfirmation} value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={protectedGroup || mutation.isPending} /></Field></div>
  </EntitySheet>;
}

function AssignmentSheet({ resource, item, data, copy, onClose, onSaved, onReview }: SheetProps & { resource: "tenant" | "pool"; item: GroupTenant | GroupRunnerPool; data: TenantGroupDirectory; onReview: () => Promise<void> }) {
  const [groupId, setGroupId] = useState(item.groupId);
  const mutation = useMutation({ mutationFn: () => resource === "tenant" ? assignTenantGroup(item.id, groupId, item.groupId) : assignRunnerPoolGroup(item.id, groupId, item.groupId), onSuccess: () => onSaved(copy.assigned) });
  const sourcePools = resource === "tenant" ? data.pools.filter(pool => pool.groupId === item.groupId) : data.pools.filter(pool => pool.id === item.id);
  const online = sourcePools.some(pool => (connected(pool) ?? 0) > 0);
  const target = data.items.find(group => group.id === groupId);
  const locked = resource === "pool" && defaultPool(item);
  return <EntitySheet open onOpenChange={open => { if (!open) onClose(); }} closeDisabled={mutation.isPending} eyebrow={resource === "tenant" ? copy.membership : copy.allocation} title={resource === "tenant" ? copy.tenantAssignTitle : copy.poolAssignTitle} description={copy.assignmentHint} width="md" footer={<FormFooter copy={copy} pending={mutation.isPending} valid={!online && !locked && Boolean(target) && groupId !== item.groupId} submit={() => mutation.mutate()} onClose={onClose} label={copy.apply} />}>
    <div className="tenant-group-form"><Identity name={item.name} id={item.id} />{mutation.error ? <><ErrorNotice error={mutation.error} /><Note warning>{copy.conflictHint}</Note><Button variant="outline" onClick={() => { void onReview().then(() => mutation.reset()); }}>{copy.review}</Button></> : null}<dl className="tenant-group-facts"><div><dt>{copy.currentGroup}</dt><dd>{data.items.find(group => group.id === item.groupId)?.name ?? item.groupId}<code>{item.groupId}</code></dd></div></dl><Field label={copy.targetGroup}><select aria-label={copy.targetGroup} value={groupId} disabled={locked || mutation.isPending} onChange={event => setGroupId(event.target.value)}>{data.items.map(group => <option key={group.id} value={group.id}>{group.name} ({group.id})</option>)}</select></Field><Note warning={online || locked}>{locked ? copy.defaultPoolProtected : online ? copy.runnersOnline : resource === "tenant" ? copy.tenantMoveHint : copy.poolMoveHint}</Note>{resource === "tenant" && target && !target.poolIds.length ? <Note warning>{copy.targetNoPools}</Note> : null}</div>
  </EntitySheet>;
}

function PoolEditor({ groupId: initialGroupId, data, copy, onClose, onSaved }: SheetProps & { groupId: string; data: TenantGroupDirectory }) {
  const [groupId, setGroupId] = useState(initialGroupId);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [runtimeUrl, setRuntimeUrl] = useState("");
  const [publicUrl, setPublicUrl] = useState("");
  const mutation = useMutation({ mutationFn: () => registerGroupRunnerPool(groupId, { id: id.trim(), name: name.trim(), runtimeUrl: runtimeUrl.trim(), publicUrl: publicUrl.trim() || null }), onSuccess: () => onSaved(copy.poolRegistered) });
  const valid = Boolean(groupId && name.trim() && name.trim().length <= 160 && slug.test(id) && id.length <= 63) && validOrigin(runtimeUrl.trim()) && (!publicUrl.trim() || validOrigin(publicUrl.trim()));
  return <EntitySheet open onOpenChange={open => { if (!open) onClose(); }} closeDisabled={mutation.isPending} eyebrow={copy.allocation} title={copy.poolCreateTitle} description={copy.poolCreateHint} width="md" footer={<FormFooter copy={copy} pending={mutation.isPending} valid={valid} submit={() => mutation.mutate()} onClose={onClose} label={copy.registerPool} />}>
    <div className="tenant-group-form">{mutation.error ? <ErrorNotice error={mutation.error} /> : null}<Field label={copy.group}><select aria-label={copy.group} value={groupId} disabled={mutation.isPending} onChange={event => setGroupId(event.target.value)}>{data.items.map(group => <option key={group.id} value={group.id}>{group.name} ({group.id})</option>)}</select></Field><Field label={copy.poolId} hint={copy.slugHint}><Input autoFocus aria-label={copy.poolId} value={id} onChange={event => setId(event.target.value)} maxLength={63} disabled={mutation.isPending} /></Field><Field label={copy.name}><Input aria-label={copy.name} value={name} onChange={event => setName(event.target.value)} maxLength={160} disabled={mutation.isPending} /></Field><ConnectivityFields runtimeUrl={runtimeUrl} publicUrl={publicUrl} onRuntime={setRuntimeUrl} onPublic={setPublicUrl} pending={mutation.isPending} copy={copy} /><Note>{copy.deploymentHint}</Note></div>
  </EntitySheet>;
}

function ConnectivitySheet({ pool, copy, onClose, onSaved }: SheetProps & { pool: GroupRunnerPool }) {
  const [runtimeUrl, setRuntimeUrl] = useState(pool.runtimeUrl ?? "");
  const [publicUrl, setPublicUrl] = useState(pool.publicUrl ?? "");
  const mutation = useMutation({ mutationFn: () => updateRunnerPoolConnectivity(pool.id, { runtimeUrl: runtimeUrl.trim() || null, publicUrl: publicUrl.trim() || null }), onSuccess: () => onSaved(copy.connectivitySaved) });
  const valid = (validOrigin(runtimeUrl.trim()) || (defaultPool(pool) && !runtimeUrl.trim())) && (!publicUrl.trim() || validOrigin(publicUrl.trim())) && (runtimeUrl.trim() !== (pool.runtimeUrl ?? "") || publicUrl.trim() !== (pool.publicUrl ?? ""));
  return <EntitySheet open onOpenChange={open => { if (!open) onClose(); }} closeDisabled={mutation.isPending} eyebrow={copy.allocation} title={copy.connectivityTitle} description={copy.connectivityHint} width="md" footer={<FormFooter copy={copy} pending={mutation.isPending} valid={valid} submit={() => mutation.mutate()} onClose={onClose} />}>
    <div className="tenant-group-form"><Identity name={pool.name} id={pool.id} />{mutation.error ? <ErrorNotice error={mutation.error} /> : null}<ConnectivityFields runtimeUrl={runtimeUrl} publicUrl={publicUrl} onRuntime={setRuntimeUrl} onPublic={setPublicUrl} pending={mutation.isPending} copy={copy} /><Note>{defaultPool(pool) ? copy.defaultUrlHint : copy.requiredUrlHint}</Note></div>
  </EntitySheet>;
}
function ConnectivityFields({ runtimeUrl, publicUrl, onRuntime, onPublic, pending, copy }: { runtimeUrl: string; publicUrl: string; onRuntime: (value: string) => void; onPublic: (value: string) => void; pending: boolean; copy: TenantGroupsCopy }) {
  const runtimeError = runtimeUrl.trim() && !validOrigin(runtimeUrl.trim());
  const publicError = publicUrl.trim() && !validOrigin(publicUrl.trim());
  const id = useId();
  return <><Field label={copy.runtimeUrl} hint={copy.runtimeHint}><Input aria-label={copy.runtimeUrl} aria-invalid={Boolean(runtimeError)} aria-describedby={runtimeError ? `${id}-runtime-error` : undefined} value={runtimeUrl} onChange={event => onRuntime(event.target.value)} disabled={pending} />{runtimeError ? <span className="tenant-group-field-error" id={`${id}-runtime-error`}>{copy.invalidOrigin}</span> : null}</Field><Field label={`${copy.publicUrl} (${copy.optional})`} hint={copy.publicHint}><Input aria-label={copy.publicUrl} aria-invalid={Boolean(publicError)} aria-describedby={publicError ? `${id}-public-error` : undefined} value={publicUrl} onChange={event => onPublic(event.target.value)} disabled={pending} />{publicError ? <span className="tenant-group-field-error" id={`${id}-public-error`}>{copy.invalidOrigin}</span> : null}</Field></>;
}
