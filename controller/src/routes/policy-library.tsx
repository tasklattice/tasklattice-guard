import { hasPermission } from "../../shared/rbac";
import { SecuritySeverityBadge } from "@/components/security-severity";
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  CheckCircle2,
  Check,
  X,
  ChevronDown,
  ChevronRight,
  FileCode2,
  BookOpen,
  Download,
  FlaskConical,
  LoaderCircle,
  Upload,
  RotateCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Workflow,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "@/components/ui/notifications";

import { DeclarativePolicyStudio } from "@/components/declarative-policy-studio";
import { policyDefinitionSchema, type PolicyDefinition } from "../../shared/policy-definition";
import { PolicyStudioSheet } from "@/components/policy-studio";
import { CreateSplitButton } from "@/components/create-split-button";
import { ConfirmationSheet } from "@/components/confirmation-sheet";
import { EntitySheet } from "@/components/entity-sheet";
import { ErrorNotice, InfoNotice, PageHeader } from "@/components/product-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { PolicyCompliancePanel } from "@/components/policy-compliance";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { queryKeys } from "@/features/query-keys";
import { useAuth } from "@/lib/auth";
import { deletePolicy, getPolicies, getPolicy, getGuardrailProfiles, type ProgrammablePolicy, type Policy, type PolicyRule, type PolicyTag } from "@/lib/api";
import { catalogDirectories, collectionAsPolicy, policyCollections, type CatalogItem, type PolicyCollection } from "@/lib/policy-collections";
import { CreateGuardrailWizard } from "./create-guardrail-wizard";
import {
  parsePolicyPackage,
  policyPackageFilename,
  PolicyPackageError,
  serializePolicyPackage,
  type PolicyImport,
} from "@/lib/policy-transfer";
import { cn } from "@/lib/utils";
import { protectionDirectories, type ProtectionDirectoryId } from "../../shared/protection-map";
import { declaredPolicyDirectory } from "@/lib/protection-composition";
import { boundPolicy } from "@/lib/bound-policy";

const POLICY_CARD_CLASS = "group flex min-w-0 flex-col rounded-xl border bg-card p-4 shadow-xs transition-[border-color,box-shadow] hover:border-primary/30 hover:shadow-sm";
const EMPTY_POLICIES: Policy[] = [];
const HIDDEN_POLICY_TAG_NAMESPACES = new Set(["engine", "scope", "stage", "implementation", "rail", "protection", "guardrail_category", "collection", "domain"]);
const HIDDEN_POLICY_FACET_NAMESPACES = new Set(["implementation", "rail", "protection", "guardrail_category", "collection", "domain"]);
const POLICY_FACET_ORDER = ["framework", "jurisdiction"];
type CatalogFacetTag = PolicyTag & { count?: number };
const JURISDICTION_FLAGS: Record<string, string> = {
  au: "🇦🇺",
  cn: "🇨🇳",
  eu: "🇪🇺",
  sg: "🇸🇬",
  uae: "🇦🇪",
};

/**
 * This environment's Policy Library: catalog Policies, Policy Studio Policies,
 * and Policy versions that arrived with an imported Guardrail. Administrators
 * maintain drafts while published versions stay immutable. Which Guardrails use a
 * Policy is a Guardrail's concern; a Guardrail version links to its Policies.
 */
export function PolicyLibraryPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const searchParams = useSearch({ strict: false }) as { policy?: string; version?: string; collection?: string };
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const canManage = hasPermission(user?.role, "policies", "write");
  const query = useQuery({ queryKey: queryKeys.policies, queryFn: getPolicies });
  const profilesQuery = useQuery({ queryKey: queryKeys.guardrailProfiles, queryFn: getGuardrailProfiles, retry: false });
  const policies = query.data?.items ?? EMPTY_POLICIES;
  const collections = useMemo(() => policyCollections(profilesQuery.data?.items ?? [], policies).map(item => ({ ...item, name: t(`policyLibrary.collections.names.${item.id}`, { defaultValue: item.name }) })), [profilesQuery.data, policies, t]);
  const [collectionId, setCollectionId] = useState<string | null>(null);
  const collection = collections.find(item => item.id === collectionId) ?? null;
  const [createFromProfile, setCreateFromProfile] = useState<string | null>(null);
  const catalogItems: CatalogItem[] = useMemo(() => [...collections, ...policies].sort((a, b) => a.name.localeCompare(b.name)), [policies, collections]);
  const editable = (policy: Policy | null) => Boolean(policy);
  const canExportNativePolicy = (policy: Policy | null) => Boolean(policy?.implementation === "nemo_native");
  const [declarativeId, setDeclarativeId] = useState<string | null | undefined>(undefined);
  const [importedDefinition, setImportedDefinition] = useState<PolicyDefinition | undefined>();
  const [search, setSearch] = useState("");
  const [directory, setDirectory] = useState<ProtectionDirectoryId | null>(null);
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Policy | null>(null);
  const [studioPolicy, setStudioPolicy] = useState<ProgrammablePolicy | null | undefined>(undefined);
  const [policyImport, setPolicyImport] = useState<PolicyImport | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Policy | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const studioOpenerRef = useRef<HTMLElement | null>(null);
  const catalogOpenerRef = useRef<HTMLElement | null>(null);
  const collectionOpenerRef = useRef<HTMLElement | null>(null);

  const deleteMutation = useMutation({
    mutationFn: (policy: Policy) => deletePolicy(policy.id),
    onSuccess: async (_, policy) => {
      if (selected?.id === policy.id) closePolicy();
      queryClient.removeQueries({ queryKey: queryKeys.policy(policy.id) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.policies });
      setPendingDelete(null);
      toast.success(t("policyLibrary.deleted", { name: policy.name }));
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : t("policyLibrary.deleteFailed"));
    },
  });

  useEffect(() => {
    if (!searchParams.policy) {
      setSelected(null);
      return;
    }
    const policy = searchParams.version
      ? boundPolicy(policies, { policy_id: searchParams.policy, policy_version: searchParams.version })
      : policies.find((item) => item.id === searchParams.policy);
    setSelected(policy ?? null);
  }, [policies, searchParams.policy, searchParams.version]);

  useEffect(() => { setCollectionId(searchParams.collection ?? null); }, [searchParams.collection]);

  function openPolicy(policy: Policy, version?: string) {
    setCollectionId(null);
    setSelected(policy);
    navigate({ to: "/policy-library", search: { policy: policy.id, version }, replace: true });
  }

  function closePolicy() {
    setSelected(null);
    navigate({ to: "/policy-library", search: { policy: undefined, version: undefined }, replace: true });
  }

  function closeCollection() {
    setCollectionId(null);
    navigate({ to: "/policy-library", search: { policy: undefined, version: undefined }, replace: true });
  }
  const facets = useMemo(() => tagFacets(catalogItems, directory, selectedTags, search), [catalogItems, directory, selectedTags, search]);
  const filtered = filterCatalogPolicies(catalogItems, directory, selectedTags, search);
  const directoryPolicies = useMemo(() => filterCatalogPolicies(catalogItems, null, selectedTags, search), [catalogItems, selectedTags, search]);
  const activeCount = selectedTags.size + Number(Boolean(directory));
  function clearFilters() { setDirectory(null); setSelectedTags(new Set()); }
  const filterPanel = <CatalogFilters policies={directoryPolicies} facets={facets} directory={directory} onDirectoryChange={setDirectory} selected={selectedTags} onChange={setSelectedTags} onClear={clearFilters} />;
  const mobileFilterPanel = filterPanel;

  async function refresh(policyId?: string) {
    await queryClient.invalidateQueries({ queryKey: queryKeys.policies });
    if (policyId) await queryClient.invalidateQueries({ queryKey: queryKeys.policy(policyId) });
  }

  async function importPolicy(file: File) {
    try {
      const content = await file.text();
      const parsed = policyDefinitionSchema.safeParse(JSON.parse(content));
      if (parsed.success) { setImportedDefinition({ ...parsed.data, metadata: { ...parsed.data.metadata, id: `policy-${crypto.randomUUID()}`, version: "0" } }); setDeclarativeId(null); return; }
      const imported = parsePolicyPackage(content);
      setStudioPolicy(undefined);
      setPolicyImport(imported);
      toast.success(t("policyStudio.importReady"));
    } catch (error) {
      toast.error(error instanceof PolicyPackageError ? t(`policyStudio.importErrors.${error.code}`) : t("policyStudio.importFailed"));
    }
  }

  function exportPolicy(policy: Policy) {
    const programmable = policy.implementation_detail;
    if (!programmable) return;
    const blob = new Blob([serializePolicyPackage(programmable)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = policyPackageFilename(programmable);
    anchor.click();
    URL.revokeObjectURL(url);
    toast.success(t("policyStudio.exported"));
  }

  function requestPolicyDelete(policy: Policy) {
    deleteMutation.reset();
    setPendingDelete(policy);
  }

  function cancelPolicyDelete() {
    if (deleteMutation.isPending) return;
    deleteMutation.reset();
    setPendingDelete(null);
  }

  return (
    <section className="py-6 sm:py-8">
      <PageHeader
        title={t("pages.policyLibrary.title")}
        description={t("pages.policyLibrary.description")}
        action={canManage ? (
          <div className="shrink-0">
            <CreateSplitButton label={t("policyLibrary.newPolicy")} importLabel={t("policyStudio.importPolicy")}
              onCreate={(trigger) => { studioOpenerRef.current = trigger; setPolicyImport(null); setImportedDefinition(undefined); setDeclarativeId(null); }}
              onImport={(trigger) => { studioOpenerRef.current = trigger; importInputRef.current?.click(); }} />
            <input ref={importInputRef} hidden type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importPolicy(file); event.target.value = ""; }} />
          </div>
        ) : undefined}
      />

      <div className="mt-6 flex flex-col gap-3 border-y py-4 sm:flex-row sm:items-center sm:justify-between">
        <label className="relative block w-full sm:max-w-xl">
          <span className="sr-only">{t("policyLibrary.searchCatalog")}</span>
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="field:min-h-11 field:bg-card field:pl-9"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("policyLibrary.catalogSearchPlaceholder")}
          />
        </label>
        <div className="flex flex-wrap items-center gap-4">
          <p className="shrink-0 text-xs text-muted-foreground" aria-live="polite">{t("policyLibrary.catalogResults", { shown: filtered.length, total: catalogItems.length })}</p>
        </div>
      </div>

      {query.error ? <div className="mt-5"><ErrorNotice error={query.error} /><Button variant="outline" onClick={() => void query.refetch()}>{t("protection.retryCatalog")}</Button></div> : null}
      {profilesQuery.error ? <div className="mt-5" role="alert"><p className="text-sm">{t("policyLibrary.collections.loadFailed")}</p><Button variant="outline" onClick={() => void profilesQuery.refetch()}>{t("policyLibrary.collections.retry")}</Button></div> : null}
      {profilesQuery.isLoading ? <p role="status" className="mt-4 text-sm text-muted-foreground">{t("policyLibrary.collections.loading")}</p> : null}
      {searchParams.collection && profilesQuery.isSuccess && query.isSuccess && !collection ? <div role="alert" className="mt-4"><p>{t("policyLibrary.collections.notFound")}</p><Button variant="outline" onClick={closeCollection}>{t("common.close")}</Button></div> : null}
      {searchParams.version && searchParams.policy && query.isSuccess && !selected ? <div role="alert" className="mt-5 flex flex-wrap items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        <span className="min-w-0 flex-1 break-words">{t("protection.pinnedVersionUnavailable", { name: `${searchParams.policy}@${searchParams.version}` })}</span>
        <Button className="min-h-11" variant="outline" onClick={closePolicy}>{t("common.close")}</Button>
      </div> : null}
      {query.isLoading ? <CatalogSkeleton /> : (
        <div className="mt-5 grid min-w-0 gap-5 lg:grid-cols-[17rem_minmax(0,1fr)] lg:items-start">
          <aside className="sticky top-20 hidden max-h-[calc(100dvh-6rem)] overflow-y-auto border-r pr-5 lg:block" aria-label={t("policyLibrary.filters")}>
            {filterPanel}
          </aside>

          <div className="min-w-0">
            <details className="mb-4 overflow-hidden rounded-xl border bg-card lg:hidden">
              <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 px-4 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                <SlidersHorizontal className="size-4 text-primary" />
                <span>{t("policyLibrary.filters")}</span>
                {activeCount ? <Badge className="ml-auto">{activeCount}</Badge> : <span className="ml-auto text-xs font-normal text-muted-foreground">{t("policyLibrary.optional")}</span>}
                <ChevronDown className="size-4 text-muted-foreground" />
              </summary>
              <div className="border-t p-4">{mobileFilterPanel}</div>
            </details>

            {activeCount ? <div className="mb-4 flex flex-wrap items-center gap-2" aria-label={t("policyLibrary.activeFilters")}>
              {directory ? <Button variant="outline" size="sm" className="min-h-11 gap-2 bg-card font-normal" onClick={() => setDirectory(null)} aria-label={t("policyLibrary.removeFilter", { name: t(`protection.directories.${directory}`) })}>{t(`protection.directories.${directory}`)}<X className="size-3.5" /></Button> : null}
              {[...facets.values()].flat().filter((tag) => selectedTags.has(tag.id)).map((tag) => <Button key={tag.id} variant="outline" size="sm" className="min-h-11 gap-2 bg-card font-normal" onClick={() => setSelectedTags(new Set([...selectedTags].filter((id) => id !== tag.id)))} aria-label={t("policyLibrary.removeFilter", { name: tag.label })}><PolicyTagLabel tag={tag} /><X className="size-3.5" /></Button>)}
            </div> : null}

            {filtered.length ? (
              <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3" aria-label={t("policyLibrary.catalogLabel")}>
                {filtered.map(item => "profile" in item ? (
                  <CollectionCard key={`profile:${item.id}`} collection={item} onOpen={trigger => {
                    collectionOpenerRef.current = trigger; setCollectionId(item.id); setSelected(null);
                    navigate({ to: "/policy-library", search: { policy: undefined, version: undefined, collection: item.id }, replace: true });
                  }} />
                ) : (
                  <PolicyCard
                    key={`policy:${item.id}`}
                    policy={item}
                    onOpen={trigger => { catalogOpenerRef.current = trigger; openPolicy(item); }}
                    onExport={canExportNativePolicy(item) ? () => exportPolicy(item) : undefined}
                    onDelete={canManage && item.deletable ? () => requestPolicyDelete(item) : undefined}
                  />
                ))}
              </div>
            ) : !profilesQuery.isLoading && !profilesQuery.isError && !query.isError ? (
              <div className="flex min-h-80 flex-col items-center justify-center rounded-xl border border-dashed bg-card px-6 text-center">
                <Workflow className="size-8 text-muted-foreground" />
                <h2 className="mt-3 text-sm font-semibold">{t("policyLibrary.noCatalogResults")}</h2>
                <p className="mt-1 max-w-md text-xs leading-5 text-muted-foreground">{t("policyLibrary.noCatalogResultsDescription")}</p>
                <Button className="mt-4" variant="outline" onClick={() => { setSearch(""); setSelectedTags(new Set()); setDirectory(null); }}><RotateCcw />{t("policyLibrary.resetCatalog")}</Button>
              </div>
            ) : null}
          </div>
        </div>
      )}

      {collection ? <CollectionDetail collection={collection} returnFocusRef={collectionOpenerRef} onClose={closeCollection}
        onUse={hasPermission(user?.role, "guardrails", "write") && query.isSuccess && profilesQuery.isSuccess ? () => { closeCollection(); setCreateFromProfile(collection.id); } : undefined} /> : null}
      {createFromProfile ? <CreateGuardrailWizard open initialProfileId={createFromProfile} returnFocusRef={collectionOpenerRef}
        onOpenChange={open => { if (!open) setCreateFromProfile(null); }}
        onCreated={id => { setCreateFromProfile(null); navigate({ to: "/guardrails/$guardrailId", params: { guardrailId: id } }); }} /> : null}

      <PolicyDetail
        policy={selected}
        onClose={closePolicy}
        onExport={!searchParams.version && canExportNativePolicy(selected) ? exportPolicy : undefined}
        onDelete={!searchParams.version && canManage && selected?.deletable ? requestPolicyDelete : undefined}
        onEdit={!searchParams.version && canManage && editable(selected) ? (policy, trigger) => { studioOpenerRef.current = policy.implementation === "rules" ? catalogOpenerRef.current : trigger; setPolicyImport(null); if (policy.implementation === "rules") { setImportedDefinition(undefined); setDeclarativeId(policy.id); closePolicy(); } else setStudioPolicy(policy.implementation_detail ?? null); } : undefined}
      />
      <DeletePolicyDialog
        policy={pendingDelete}
        deleting={deleteMutation.isPending}
        error={deleteMutation.error}
        onCancel={cancelPolicyDelete}
        onConfirm={() => { if (pendingDelete) deleteMutation.mutate(pendingDelete); }}
      />
      {declarativeId !== undefined ? <DeclarativePolicyStudio key={declarativeId ?? "new"} policyId={declarativeId} imported={importedDefinition} returnFocusRef={studioOpenerRef} onClose={() => setDeclarativeId(undefined)} onSaved={async id => { await refresh(id); }} /> : null}
      <PolicyStudioSheet
        returnFocusRef={studioOpenerRef}
        policy={studioPolicy === undefined ? null : studioPolicy}
        imported={policyImport}
        open={studioPolicy !== undefined || policyImport !== null}
        onOpenChange={(open) => { if (!open) { setStudioPolicy(undefined); setPolicyImport(null); } }}
        onSaved={async (policyId, isCurrent) => {
          await refresh(policyId);
          const next = await queryClient.fetchQuery({ queryKey: queryKeys.policy(policyId), queryFn: () => getPolicy(policyId) });
          if (!isCurrent()) return;
          setStudioPolicy(undefined);
          setPolicyImport(null);
          setSelected(next);
          navigate({ to: "/policy-library", search: { policy: policyId, version: undefined }, replace: true });
        }}
      />
    </section>
  );
}

function CollectionCard({ collection, onOpen }: { collection: PolicyCollection; onOpen: (trigger: HTMLElement) => void }) {
  const { t } = useTranslation();
  return <PolicyCard policy={collectionAsPolicy(collection)} onOpen={onOpen}
    notice={collection.unavailable.length ? <p className="mt-2 text-xs text-destructive">{t("policyLibrary.collections.incomplete")}</p> : undefined} />;
}

export function CollectionDetail({ collection, onClose, onUse, returnFocusRef }: {
  collection: PolicyCollection; onClose: () => void; onUse?: () => void; returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation();
  return <PolicyDetail policy={collectionAsPolicy(collection)} onClose={onClose} returnFocusRef={returnFocusRef}
    notice={collection.unavailable.length ? <div role="alert" className="mt-4 text-sm text-destructive"><p>{t("policyLibrary.collections.incomplete")}</p><ul className="mt-2 list-disc pl-5">{collection.unavailable.map(id => <li key={id}>{id}</li>)}</ul></div> : undefined}
    footer={<><Button variant="outline" onClick={onClose}>{t("common.close")}</Button>{onUse ? <Button disabled={Boolean(collection.unavailable.length) || !collection.ruleCount} onClick={onUse}>{t("policyLibrary.collections.use")}</Button> : null}</>} />;
}

export function CatalogFilters({ policies, facets, directory, onDirectoryChange, selected, onChange, onClear }: {
  policies: CatalogItem[]; facets: Map<string, CatalogFacetTag[]>; directory: ProtectionDirectoryId | null;
  onDirectoryChange: (value: ProtectionDirectoryId | null) => void; selected: Set<string>;
  onChange: (value: Set<string>) => void; onClear: () => void;
}) {
  const { t } = useTranslation();
  const count = selected.size + Number(Boolean(directory));
  return <div>
    <div className="mb-3 flex min-h-11 items-center justify-between gap-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold"><SlidersHorizontal className="size-4 text-muted-foreground" />{t("policyLibrary.filters")}{count ? <span className="text-xs tabular-nums text-primary">{count}</span> : null}</h2>
      <Button size="sm" variant="ghost" className="min-h-11 px-2 text-xs text-muted-foreground" disabled={!count} onClick={onClear}>{t("policyLibrary.clearFilters")}</Button>
    </div>
    <TagFilters facets={facets} selected={selected} onChange={onChange} />
    <ProtectionDirectoryNav policies={policies} value={directory} onChange={onDirectoryChange} />
  </div>;
}

function ProtectionDirectoryNav({ policies, value, onChange }: { policies: CatalogItem[]; value: ProtectionDirectoryId | null; onChange: (value: ProtectionDirectoryId | null) => void }) {
  const { t } = useTranslation();
  const items = protectionDirectories.map((directory) => ({ id: directory.id, label: t(`protection.directories.${directory.id}`), count: policies.filter((policy) => catalogDirectories(policy).includes(directory.id)).length }));
  return <details open className="group border-t py-3">
    <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
      {t("protection.overview")}<ChevronDown className="size-3.5 text-muted-foreground group-open:rotate-180" />
    </summary>
    <div role="group" aria-label={t("protection.overview")} className="space-y-0.5">
      {items.map((item) => <button key={item.id ?? "all"} type="button" aria-pressed={value === item.id} onClick={() => onChange(item.id)} className={cn("flex min-h-11 w-full items-center justify-between gap-3 rounded-md px-3 text-left text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring", value === item.id ? "bg-primary/5 font-medium text-primary" : "text-muted-foreground")}>
        <span className="flex min-w-0 items-center gap-3">
          <span aria-hidden="true" className={cn("flex size-4 shrink-0 items-center justify-center rounded-[4px] border", value === item.id ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background")}>
            {value === item.id ? <Check className="size-3" /> : null}
          </span>
          <span>{item.label}</span>
        </span>
        <span className="text-xs tabular-nums text-muted-foreground">{item.count}</span>
      </button>)}
    </div>
  </details>;
}

export function TagFilters({ facets, selected, onChange }: { facets: Map<string, CatalogFacetTag[]>; selected: Set<string>; onChange: (next: Set<string>) => void }) {
  const { t } = useTranslation();
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };
  return <div className="pb-2">
    {[...facets].filter(([namespace]) => POLICY_FACET_ORDER.includes(namespace)).map(([namespace, tags]) => (
      <details key={namespace} open className="group border-t py-3">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          {t(`policyLibrary.tagNamespaces.${namespace}`, { defaultValue: namespace })}<ChevronDown className="size-3.5 text-muted-foreground group-open:rotate-180" />
        </summary>
        <div className="space-y-0.5">
          {tags.map((tag) => <label key={tag.id} className={cn("flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-3 text-sm hover:bg-muted", selected.has(tag.id) ? "bg-primary/5 text-foreground" : "text-muted-foreground")}>
            <Checkbox checked={selected.has(tag.id)} onCheckedChange={() => toggle(tag.id)} />
            <span className="flex min-w-0 flex-1 items-center gap-2"><PolicyTagLabel tag={tag} /></span>
            <span className="text-xs tabular-nums text-muted-foreground">{tag.count}</span>
          </label>)}
        </div>
      </details>
    ))}
  </div>;
}

export function PolicyCard({ policy, onOpen, onExport, onDelete, notice }: { policy: Policy; onOpen: (trigger: HTMLElement) => void; onExport?: () => void; onDelete?: () => void; notice?: ReactNode }) {
  const { t } = useTranslation();
  const directory = declaredPolicyDirectory(policy);
  return (
    <article className={POLICY_CARD_CLASS}>
      <div className="flex min-w-0 items-start justify-between gap-3">
        <h3 className="line-clamp-2 min-w-0 flex-1 text-sm leading-5 font-semibold">{policy.name}</h3>
        {policy.version === "0" ? <Badge variant="outline">Draft</Badge> : null}
      </div>
      <p className="mt-2 line-clamp-2 min-h-10 text-xs leading-5 text-muted-foreground">{policy.description}</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {directory ? <Badge variant="secondary">{t(`protection.directories.${directory}`)}</Badge> : null}
        {visiblePolicyTags(policy.tags).slice(0, 3).map((tag) => <Badge key={tag.id} variant="secondary" className="font-normal"><PolicyTagLabel tag={tag} /></Badge>)}
      </div>
      <div className="mt-auto pt-5">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs">
          <Metric label={t("policyLibrary.rules")} value={policy.rules.length} />
          <Metric label={t("policyLibrary.testCases")} value={policy.test_count} />
        </div>
        <div className="mt-3 flex min-h-11 items-center justify-between gap-3 border-t pt-3">
          <span className="flex min-w-0 items-center gap-3"><span className="font-mono text-xs text-muted-foreground">v{policy.version}</span></span>
          <div className="flex items-center gap-1">
            {onDelete ? <Button size="icon-sm" variant="destructive" className="min-h-11 min-w-11" aria-label={t("policyLibrary.deletePolicyAria", { name: policy.name })} title={t("policyLibrary.deleteAction")} onClick={onDelete}><Trash2 /></Button> : null}
            {onExport ? <Button size="sm" variant="outline" className="min-h-11" aria-label={t("policyLibrary.exportPolicyAria", { name: policy.name })} onClick={onExport}><Download />{t("policyLibrary.exportAction")}</Button> : null}
            <Button size="sm" variant="ghost" className="min-h-11" onClick={event => onOpen(event.currentTarget)}>{t("policyLibrary.inspectPolicy")}<ChevronRight /></Button>
          </div>
        </div>
      </div>
      {notice}
    </article>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return <div className="inline-flex items-baseline gap-1.5"><span className="text-muted-foreground">{label}</span><strong className="font-mono font-medium">{value}</strong></div>;
}

export function PolicyDetail({ policy, onClose, onEdit, onExport, onDelete, notice, footer, returnFocusRef }: {
  policy: Policy | null; onClose: () => void; onEdit?: (policy: Policy, trigger: HTMLButtonElement) => void;
  onExport?: (policy: Policy) => void; onDelete?: (policy: Policy) => void;
  notice?: ReactNode; footer?: ReactNode; returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation();
  if (!policy) return null;
  return (
    <EntitySheet
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      eyebrow={t("policyLibrary.detailEyebrow")}
      title={policy.name}
      description={policy.description}
      width="xl"
      returnFocusRef={returnFocusRef}
      footer={footer ?? <>{onDelete ? <Button className="mr-auto" variant="destructive" onClick={() => onDelete(policy)}><Trash2 />{t("policyLibrary.deleteAction")}</Button> : null}{onExport ? <Button variant="outline" onClick={() => onExport(policy)}><Download />{t("policyStudio.exportPolicy")}</Button> : null}{onEdit ? <Button variant="edit" onClick={(event) => onEdit(policy, event.currentTarget)}>{t("policyLibrary.editPolicy")}</Button> : <Button variant="outline" onClick={onClose}>{t("common.close")}</Button>}</>}
    >
      <div className="flex flex-wrap gap-2">
        {policy.protection ? <Badge variant="secondary">{t(`protection.directories.${policy.protection.directory}`)}</Badge> : null}
        {policy.version === "0" ? <Badge variant="outline">Draft</Badge> : null}
        {visiblePolicyTags(policy.tags).map((tag) => <Badge key={tag.id} variant={tag.source === "derived" ? "outline" : "secondary"}><PolicyTagLabel tag={tag} /></Badge>)}
      </div>

      {notice}
      <Tabs key={`${policy.id}@${policy.version}`} defaultValue="policy" className="mt-5">
        <div className="overflow-x-auto">
          <TabsList aria-label={t("policyLibrary.detailViews")} className="min-w-max">
            <TabsTrigger value="policy"><ShieldCheck aria-hidden="true" /><span className="flex items-center gap-2">{t("policyLibrary.tabs.policy")}<Badge variant="outline" className="font-mono text-[10px]">{policy.rules.length}</Badge></span></TabsTrigger>
            <TabsTrigger value="validation"><FlaskConical aria-hidden="true" /><span className="flex items-center gap-2">{t("policyLibrary.tabs.testCases")}<Badge variant="outline" className="font-mono text-[10px]">{policy.test_count}</Badge></span></TabsTrigger>
            <TabsTrigger value="compliance"><BookOpen aria-hidden="true" />{t("policyLibrary.tabs.compliance")}</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="policy" className="space-y-5 pt-3 sm:pt-4">
          {policy.protection ? <section className="space-y-3 text-xs leading-5">
            {policy.protection.requiredContext.length ? <p>{t("protection.requiredContext", { context: policy.protection.requiredContext.join(", ") })}</p> : null}
            {policy.protection.outputStreaming === "complete_response" ? <p>{t("protection.completeResponse")}</p> : null}
            {policy.protection.limitations.length ? <details><summary className="cursor-pointer font-medium">{t("protection.limits")}</summary><ul className="mt-2 list-disc space-y-1 pl-4 text-muted-foreground">{policy.protection.limitations.map((item) => <li key={item}>{item}</li>)}</ul></details> : null}
          </section> : null}
          <RuleList policy={policy} />
        </TabsContent>
        <TabsContent value="validation" className="pt-3 sm:pt-4"><PolicyTestCases policy={policy} /></TabsContent>
        <TabsContent value="compliance" className="pt-3 sm:pt-4">{policy.origin === "imported" ? <ImportedBadge source={policy.source_id} /> : null}{policy.maintenance ? <p className="mb-4 text-sm">Maintenance: {policy.maintenance.maintainer}</p> : null}<PolicyCompliancePanel policy={policy} /></TabsContent>
      </Tabs>
    </EntitySheet>
  );
}

export function DeletePolicyDialog({ policy, deleting, error, onCancel, onConfirm }: { policy: Policy | null; deleting: boolean; error: Error | null; onCancel: () => void; onConfirm: () => void }) {
  const { t } = useTranslation();
  return (
    <ConfirmationSheet
      open={Boolean(policy)}
      onOpenChange={(open) => { if (!open && !deleting) onCancel(); }}
      eyebrow={t("policyLibrary.deleteAction")}
      title={t("policyLibrary.deleteDialogTitle")}
      description={t("policyLibrary.deleteDialogDescription", { name: policy?.name ?? "" })}
      cancelLabel={t("common.cancel")}
      confirmLabel={t("policyLibrary.deleteConfirm")}
      pendingLabel={t("policyLibrary.deleting")}
      pending={deleting}
      variant="destructive"
      onConfirm={onConfirm}
    >
        <div className="rounded-lg border bg-muted/35 px-4 py-3 text-xs leading-5 text-muted-foreground">
          {t("policyLibrary.deleteDialogGuardrailNote")}
        </div>
        {error ? <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-xs leading-5 text-destructive">{error.message}</p> : null}
    </ConfirmationSheet>
  );
}

function RuleList({ policy }: { policy: Policy }) {
  const { t } = useTranslation();
  return (
    <section>
      <h3 className="text-sm font-semibold">{t("policyLibrary.ruleListTitle")}</h3>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("policyLibrary.ruleListDescription")}</p>
      <div className="mt-4 divide-y overflow-hidden rounded-lg border">
        {policy.rules.map((rule) => <RuleRow key={rule.id} rule={rule} />)}
      </div>
    </section>
  );
}

function RuleRow({ rule }: { rule: PolicyRule }) {
  const { t } = useTranslation();
  return (
    <details className="group bg-card">
      <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <CheckCircle2 className="size-4 shrink-0 text-primary" />
        <span className="min-w-0 flex-1"><strong className="block truncate text-sm font-medium">{rule.name}</strong><span className="mt-1 block truncate font-mono text-xs text-muted-foreground">{rule.id}</span></span>
        <SecuritySeverityBadge severity={rule.risk_severity} /><Badge variant="outline">{t(`policyLibrary.effects.${rule.effect}`, { defaultValue: rule.effect })}</Badge>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t bg-muted/15 px-4 py-4 text-xs">
        <p className="leading-5 text-muted-foreground">{rule.description || t("policyLibrary.noRuleDescription")}</p>
        <dl className="mt-3 grid gap-3 sm:grid-cols-3">
          <Fact label={t("policyLibrary.detector")} value={`${rule.detector.ref}@${rule.detector.version}`} />
          <Fact label={t("policyLibrary.railTypesLabel")} value={rule.rails.map((railType) => t(`policyLibrary.railTypes.${railType}`)).join(", ")} />
          <Fact label={t("policyLibrary.effectLabel")} value={t(`policyLibrary.effects.${rule.effect}`, { defaultValue: rule.effect })} />
        </dl>
      </div>
    </details>
  );
}

function PolicyTestCases({ policy }: { policy: Policy }) {
  const { t } = useTranslation();
  const ruleNames = new Map(policy.rules.map((rule) => [rule.id, rule.name]));
  const groups = Array.from(new Set(policy.test_cases.map((testCase) => testCase.group)));
  return (
    <section>
      <h3 className="text-sm font-semibold">{t("policyLibrary.testCasesTitle")}</h3>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("policyLibrary.testCasesDescription")}</p>
      <div className="mt-4 space-y-4">
        {groups.map((group) => (
          <section key={group} className="overflow-hidden rounded-lg border">
            <div className="border-b bg-muted/20 px-4 py-3"><h4 className="text-sm font-medium">{group}</h4></div>
            <div className="divide-y">
              {policy.test_cases.filter((testCase) => testCase.group === group).map((testCase) => (
                <details key={testCase.id} className="group bg-card">
                  <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                    <FlaskConical className="size-4 shrink-0 text-primary" />
                    <span className="min-w-0 flex-1"><strong className="block truncate text-sm font-medium">{testCase.name}</strong><span className="mt-1 block text-[10px] text-muted-foreground">{t(`policyLibrary.testKinds.${testCase.kind}`)}</span></span>
                    <Badge variant="secondary">{t(`policyLibrary.expectedDecisions.${testCase.expected_decision}`)}</Badge>
                    <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
                  </summary>
                  <div className="border-t bg-muted/15 px-4 py-4">
                    {testCase.content ? <pre className="mb-3 whitespace-pre-wrap rounded-md border bg-background p-3 font-mono text-xs leading-5">{testCase.content}</pre> : null}
                    {testCase.covered_rule_ids.length ? <p className="text-xs text-muted-foreground">{t("policyLibrary.coveredRules")}: {testCase.covered_rule_ids.map((id) => ruleNames.get(id) ?? id).join(", ")}</p> : null}
                  </div>
                </details>
              ))}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-[10px] text-muted-foreground">{label}</dt><dd className="mt-1 text-xs font-medium">{value}</dd></div>;
}

function CatalogSkeleton() {
  return <div className="mt-5 grid gap-5 lg:grid-cols-[17rem_minmax(0,1fr)]"><Skeleton className="hidden h-[36rem] rounded-xl lg:block" /><div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">{Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-64 rounded-xl" />)}</div></div>;
}

function normalizeCatalogTag(tag: PolicyTag): PolicyTag {
  return tag.namespace === "jurisdiction" && tag.value === "singapore"
    ? { ...tag, id: "jurisdiction:sg", value: "sg" } : tag;
}

export function filterCatalogPolicies<T extends CatalogItem>(policies: T[], directory: ProtectionDirectoryId | null, selected: Set<string>, search = "") {
  const groups = new Map<string, string[]>();
  for (const id of selected) {
    const namespace = id.split(":")[0];
    groups.set(namespace, [...(groups.get(namespace) ?? []), id]);
  }
  const words = search.trim().toLocaleLowerCase();
  return policies.filter((policy) => {
    if (directory && !catalogDirectories(policy).includes(directory)) return false;
    const ids = new Set(policy.tags.map((tag) => normalizeCatalogTag(tag).id));
    if ([...groups.values()].some((group) => !group.some((id) => ids.has(id)))) return false;
    return !words || policySearchText(policy).includes(words);
  });
}

export function tagFacets(policies: CatalogItem[], directory: ProtectionDirectoryId | null = null, selected = new Set<string>(), search = "") {
  const facets = new Map<string, Map<string, CatalogFacetTag>>();
  for (const policy of policies) {
    for (const tag of new Map(visiblePolicyTags(policy.tags).map(normalizeCatalogTag).map((tag) => [tag.id, tag])).values()) {
      if (HIDDEN_POLICY_FACET_NAMESPACES.has(tag.namespace)) continue;
      const values = facets.get(tag.namespace) ?? new Map<string, CatalogFacetTag>();
      values.set(tag.id, { ...tag, count: (values.get(tag.id)?.count ?? 0) + 1 });
      facets.set(tag.namespace, values);
    }
  }
  for (const [namespace, values] of facets) {
    const candidates = filterCatalogPolicies(policies, directory, new Set([...selected].filter((id) => !id.startsWith(`${namespace}:`))), search);
    for (const [id, tag] of values) values.set(id, { ...tag, count: filterCatalogPolicies(candidates, null, new Set([id])).length });
  }
  return new Map(
    [...facets]
      .sort(([left], [right]) => facetOrder(left) - facetOrder(right) || left.localeCompare(right))
      .map(([namespace, values]) => [namespace, [...values.values()].sort((left, right) => Number(right.id === "framework:owasp-llm-2025") - Number(left.id === "framework:owasp-llm-2025") || left.label.localeCompare(right.label))]),
  );
}

function visiblePolicyTags(tags: PolicyTag[]) {
  return tags.filter((tag) => !HIDDEN_POLICY_TAG_NAMESPACES.has(tag.namespace));
}

function PolicyTagLabel({ tag: rawTag, truncate = false }: { tag: CatalogFacetTag; truncate?: boolean }) {
  const tag = rawTag.namespace === "jurisdiction" ? normalizeCatalogTag(rawTag as PolicyTag) : rawTag;
  const { t } = useTranslation();
  const jurisdiction = tag.namespace === "jurisdiction";
  const rail = tag.namespace === "rail";
  const guardrailCategory = tag.namespace === "guardrail_category";
  const label = guardrailCategory
      ? t(`modelSettings.categories.${tag.value}.title`, { defaultValue: tag.label })
    : jurisdiction
    ? t(`policyLibrary.jurisdictions.${tag.value}`, { defaultValue: tag.label })
    : rail
    ? t(`policyLibrary.railTypes.${tag.value}`, { defaultValue: tag.label })
    : tag.label;
  const flag = jurisdiction ? JURISDICTION_FLAGS[tag.value] : undefined;
  return (
    <>
      {flag ? <span aria-hidden="true" className="shrink-0 text-base leading-none">{flag}</span> : null}
      <span className={cn(truncate && "max-w-52 truncate")}>{label}</span>
    </>
  );
}

/** Import provenance, shown only alongside compliance information. */
function ImportedBadge({ source }: { source?: string | null | undefined }) {
  const { t } = useTranslation();
  return <Badge variant="outline" className="font-normal text-muted-foreground"><Upload />{t("policyLibrary.importedFrom", { source: source ?? "" })}</Badge>;
}

function facetOrder(namespace: string) {
  const index = POLICY_FACET_ORDER.indexOf(namespace);
  return index === -1 ? POLICY_FACET_ORDER.length : index;
}

function policySearchText(policy: CatalogItem) {
  if ("profile" in policy) return [policy.id, policy.name, policy.description, ...policy.tags.flatMap(tag => [tag.id, tag.label]), policy.profile.industry,
    ...policy.groups.flatMap(group => [group.policy?.name ?? group.binding.policy_id, ...group.rules.flatMap(rule => [rule.id, rule.name, rule.description])])].join(" ").toLocaleLowerCase();
  return [
    policy.id,
    policy.name,
    policy.description,
    ...visiblePolicyTags(policy.tags).map(normalizeCatalogTag).flatMap((tag) => [tag.id, tag.label]),
    ...policy.rules.flatMap((rule) => [rule.id, rule.name, rule.description]),
    ...policy.test_cases.flatMap((testCase) => [testCase.group, testCase.name, testCase.content]),
  ].join(" ").toLocaleLowerCase();
}
