import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileCode2,
  Download,
  FlaskConical,
  LoaderCircle,
  Plus,
  RotateCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Upload,
  Workflow,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { PolicyStudioSheet } from "@/components/policy-studio";
import { EntitySheet } from "@/components/entity-sheet";
import { ErrorNotice, InfoNotice, PageHeader } from "@/components/product-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { queryKeys } from "@/features/query-keys";
import { useAuth } from "@/lib/auth";
import { deleteProgrammablePolicy, getPolicies, getPolicy, type ProgrammablePolicy, type Policy, type PolicyRule, type PolicyTag } from "@/lib/api";
import {
  parsePolicyPackage,
  policyPackageFilename,
  PolicyPackageError,
  serializePolicyPackage,
  type PolicyImport,
} from "@/lib/policy-transfer";
import { cn } from "@/lib/utils";

const EMPTY_POLICIES: Policy[] = [];
const HIDDEN_POLICY_TAG_NAMESPACES = new Set(["engine", "scope", "stage"]);
const POLICY_FACET_ORDER = ["source", "capability", "collection", "domain", "framework", "implementation", "jurisdiction", "rail"];
type CatalogFacetTag = Omit<PolicyTag, "namespace"> & { namespace: PolicyTag["namespace"] | "source" };
const JURISDICTION_FLAGS: Record<string, string> = {
  au: "🇦🇺",
  eu: "🇪🇺",
  sg: "🇸🇬",
  uae: "🇦🇪",
};

export function PolicyLibraryPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const searchParams = useSearch({ strict: false }) as { policy?: string };
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const canManage = user?.role === "admin";
  const query = useQuery({ queryKey: queryKeys.policies, queryFn: getPolicies });
  const policies = query.data?.items ?? EMPTY_POLICIES;
  const [search, setSearch] = useState("");
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Policy | null>(null);
  const [studioPolicy, setStudioPolicy] = useState<ProgrammablePolicy | null | undefined>(undefined);
  const [policyImport, setPolicyImport] = useState<PolicyImport | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Policy | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  const deleteMutation = useMutation({
    mutationFn: (policy: Policy) => deleteProgrammablePolicy(policy.id),
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
    const policy = policies.find((item) => item.id === searchParams.policy);
    if (policy) setSelected(policy);
  }, [policies, searchParams.policy]);

  function openPolicy(policy: Policy) {
    setSelected(policy);
    navigate({ to: "/policy-library", search: { policy: policy.id }, replace: true });
  }

  function closePolicy() {
    setSelected(null);
    navigate({ to: "/policy-library", search: { policy: undefined }, replace: true });
  }

  const facets = useMemo(() => tagFacets(policies), [policies]);
  const filtered = useMemo(() => {
    const words = search.trim().toLocaleLowerCase();
    return policies.filter((policy) => {
      const ids = new Set([...policy.tags.map((tag) => tag.id), `source:${policy.source}`]);
      if ([...selectedTags].some((tag) => !ids.has(tag))) return false;
      if (!words) return true;
      return policySearchText(policy).includes(words);
    });
  }, [policies, search, selectedTags]);

  async function refresh(policyId?: string) {
    await queryClient.invalidateQueries({ queryKey: queryKeys.policies });
    if (policyId) await queryClient.invalidateQueries({ queryKey: queryKeys.policy(policyId) });
  }

  async function importPolicy(file: File) {
    try {
      const imported = parsePolicyPackage(await file.text());
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
      />
      <div className="mt-5 flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0 flex-1"><InfoNotice title={t("policyLibrary.catalogManagedTitle")}>{t("policyLibrary.catalogManagedDescription")}</InfoNotice></div>
        {canManage ? (
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button variant="outline" onClick={() => importInputRef.current?.click()}><Upload />{t("policyStudio.importPolicy")}</Button>
            <Button onClick={() => { setPolicyImport(null); setStudioPolicy(null); }}><Plus />{t("policyLibrary.newPolicy")}</Button>
            <input ref={importInputRef} hidden type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importPolicy(file); event.target.value = ""; }} />
          </div>
        ) : null}
      </div>

      <div className="mt-6 flex flex-col gap-3 border-y py-4 sm:flex-row sm:items-center sm:justify-between">
        <label className="relative block w-full sm:max-w-xl">
          <span className="sr-only">{t("policyLibrary.searchCatalog")}</span>
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="min-h-11 bg-card pl-9"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("policyLibrary.catalogSearchPlaceholder")}
          />
        </label>
        <p className="shrink-0 text-xs text-muted-foreground" aria-live="polite">
          {t("policyLibrary.catalogResults", { shown: filtered.length, total: policies.length })}
        </p>
      </div>

      {query.error ? <div className="mt-5"><ErrorNotice error={query.error} /></div> : null}
      {query.isLoading ? <CatalogSkeleton /> : (
        <div className="mt-5 grid min-w-0 gap-5 lg:grid-cols-[19rem_minmax(0,1fr)] lg:items-start">
          <aside className="sticky top-20 hidden max-h-[calc(100dvh-6rem)] overflow-y-auto border-r pr-5 lg:block" aria-label={t("policyLibrary.filters")}>
            <TagFilters facets={facets} selected={selectedTags} onChange={setSelectedTags} />
          </aside>

          <div className="min-w-0">
            <details className="mb-4 overflow-hidden rounded-xl border bg-card lg:hidden">
              <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 px-4 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                <SlidersHorizontal className="size-4 text-primary" />
                <span>{t("policyLibrary.filters")}</span>
                {selectedTags.size ? <Badge className="ml-auto">{selectedTags.size}</Badge> : <span className="ml-auto text-xs font-normal text-muted-foreground">{t("policyLibrary.optional")}</span>}
                <ChevronDown className="size-4 text-muted-foreground" />
              </summary>
              <div className="border-t p-4"><TagFilters facets={facets} selected={selectedTags} onChange={setSelectedTags} /></div>
            </details>

            {filtered.length ? (
              <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3" aria-label={t("policyLibrary.catalogLabel")}>
                {filtered.map((policy) => (
                  <PolicyCard
                    key={policy.id}
                    policy={policy}
                    onOpen={() => openPolicy(policy)}
                    onExport={policy.source === "custom" ? () => exportPolicy(policy) : undefined}
                    onDelete={canManage && policy.source === "custom" ? () => requestPolicyDelete(policy) : undefined}
                  />
                ))}
              </div>
            ) : (
              <div className="flex min-h-80 flex-col items-center justify-center rounded-xl border border-dashed bg-card px-6 text-center">
                <Workflow className="size-8 text-muted-foreground" />
                <h2 className="mt-3 text-sm font-semibold">{t("policyLibrary.noCatalogResults")}</h2>
                <p className="mt-1 max-w-md text-xs leading-5 text-muted-foreground">{t("policyLibrary.noCatalogResultsDescription")}</p>
                <Button className="mt-4" variant="outline" onClick={() => { setSearch(""); setSelectedTags(new Set()); }}><RotateCcw />{t("policyLibrary.resetCatalog")}</Button>
              </div>
            )}
          </div>
        </div>
      )}

      <PolicyDetail
        policy={selected}
        onClose={closePolicy}
        onExport={selected?.source === "custom" ? exportPolicy : undefined}
        onDelete={canManage && selected?.source === "custom" ? requestPolicyDelete : undefined}
        onEdit={canManage && selected?.source === "custom" ? (policy) => { setPolicyImport(null); setStudioPolicy(policy.implementation_detail ?? null); } : undefined}
      />
      <DeletePolicyDialog
        policy={pendingDelete}
        deleting={deleteMutation.isPending}
        error={deleteMutation.error}
        onCancel={cancelPolicyDelete}
        onConfirm={() => { if (pendingDelete) deleteMutation.mutate(pendingDelete); }}
      />
      <PolicyStudioSheet
        policy={studioPolicy === undefined ? null : studioPolicy}
        imported={policyImport}
        open={studioPolicy !== undefined || policyImport !== null}
        onOpenChange={(open) => { if (!open) { setStudioPolicy(undefined); setPolicyImport(null); } }}
        onSaved={async (policyId) => {
          await refresh(policyId);
          setStudioPolicy(undefined);
          setPolicyImport(null);
          const next = await queryClient.fetchQuery({ queryKey: queryKeys.policy(policyId), queryFn: () => getPolicy(policyId) });
          setSelected(next);
          navigate({ to: "/policy-library", search: { policy: policyId }, replace: true });
        }}
      />
    </section>
  );
}

export function TagFilters({ facets, selected, onChange }: { facets: Map<string, CatalogFacetTag[]>; selected: Set<string>; onChange: (next: Set<string>) => void }) {
  const { t } = useTranslation();
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };
  return (
    <div className="pb-4">
      <div className="flex min-h-11 items-center justify-between gap-3">
        <h2 className="text-base font-semibold">{t("policyLibrary.filters")}</h2>
        <Button size="sm" variant="ghost" className="min-h-11 px-2 text-muted-foreground shadow-none" disabled={!selected.size} onClick={() => onChange(new Set())}>{t("policyLibrary.clearFilters")}</Button>
      </div>
      {[...facets].map(([namespace, tags]) => (
        <details key={namespace} open className="group mt-5 border-t pt-4 first-of-type:mt-3 first-of-type:border-t-0 first-of-type:pt-1">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            {t(`policyLibrary.tagNamespaces.${namespace}`, { defaultValue: namespace })}<ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
          </summary>
          <div className="flex flex-wrap gap-2 pb-1">
            {tags.map((tag) => (
              <button
                key={tag.id}
                type="button"
                className={cn(
                  "inline-flex min-h-11 min-w-11 items-center gap-2 rounded-lg bg-secondary px-3 text-left text-xs text-secondary-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
                  tag.namespace === "rail" && "w-full justify-start border bg-card py-2.5",
                  selected.has(tag.id) && "border-primary/30 bg-primary/10 text-primary ring-1 ring-primary/25",
                )}
                aria-pressed={selected.has(tag.id)}
                onClick={() => toggle(tag.id)}
              >
                <PolicyTagLabel tag={tag} truncate showRailHint={tag.namespace === "rail"} />
              </button>
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}

export function PolicyCard({ policy, onOpen, onExport, onDelete }: { policy: Policy; onOpen: () => void; onExport?: () => void; onDelete?: () => void }) {
  const { t } = useTranslation();
  const custom = policy.source === "custom";
  const SourceIcon = custom ? FileCode2 : ShieldCheck;
  return (
    <article className={cn("group flex min-h-64 min-w-0 flex-col rounded-xl border bg-card p-4 shadow-xs transition-[border-color,box-shadow] hover:border-primary/30 hover:shadow-sm", custom && "border-primary/35 bg-primary/[0.025] ring-1 ring-primary/10")}>
      <div className="flex items-start justify-between gap-3">
        <span className={cn("grid size-10 shrink-0 place-items-center rounded-lg border text-primary", custom ? "border-primary/25 bg-primary/10" : "bg-muted/40")}><SourceIcon className="size-4" /></span>
        <PolicySourceBadge source={policy.source} />
      </div>
      <div className="mt-4 min-w-0">
        <h3 className="truncate text-sm font-semibold">{policy.name}</h3>
        <p className="mt-1 line-clamp-2 min-h-10 text-xs leading-5 text-muted-foreground">{policy.description}</p>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {visiblePolicyTags(policy.tags).filter((tag) => !["implementation", "rail"].includes(tag.namespace)).slice(0, 3).map((tag) => <Badge key={tag.id} variant="secondary" className="font-normal"><PolicyTagLabel tag={tag} /></Badge>)}
      </div>
      <div className="mt-auto pt-5">
        <div className="grid grid-cols-2 gap-2 rounded-lg bg-muted/35 p-3 text-xs">
          <Metric label={t("policyLibrary.rules")} value={policy.rules.length} />
          <Metric label={t("policyLibrary.testCases")} value={policy.test_count} />
        </div>
        <div className="mt-3 flex min-h-11 items-center justify-between gap-3 border-t pt-3">
          <span className="font-mono text-xs text-muted-foreground">v{policy.version}</span>
          <div className="flex items-center gap-1">
            {onDelete ? <Button size="icon-sm" variant="ghost" className="min-h-11 min-w-11 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" aria-label={t("policyLibrary.deletePolicyAria", { name: policy.name })} title={t("policyLibrary.deleteAction")} onClick={onDelete}><Trash2 /></Button> : null}
            {onExport ? <Button size="sm" variant="outline" className="min-h-11" aria-label={t("policyLibrary.exportPolicyAria", { name: policy.name })} onClick={onExport}><Download />{t("policyLibrary.exportAction")}</Button> : null}
            <Button size="sm" variant="ghost" className="min-h-11" onClick={onOpen}>{t("policyLibrary.inspectPolicy")}<ChevronRight /></Button>
          </div>
        </div>
      </div>
    </article>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return <div><span className="block text-[10px] text-muted-foreground">{label}</span><strong className="mt-0.5 block font-mono font-medium">{value}</strong></div>;
}

export function PolicyDetail({ policy, onClose, onEdit, onExport, onDelete }: { policy: Policy | null; onClose: () => void; onEdit?: (policy: Policy) => void; onExport?: (policy: Policy) => void; onDelete?: (policy: Policy) => void }) {
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
      footer={policy.implementation === "nemo_native" ? <>{onDelete ? <Button className="mr-auto" variant="destructive" onClick={() => onDelete(policy)}><Trash2 />{t("policyLibrary.deleteAction")}</Button> : null}{onExport ? <Button variant="outline" onClick={() => onExport(policy)}><Download />{t("policyStudio.exportPolicy")}</Button> : null}{onEdit ? <Button onClick={() => onEdit(policy)}>{t("policyLibrary.editPolicy")}</Button> : <Button variant="outline" onClick={onClose}>{t("common.close")}</Button>}</> : <Button variant="outline" onClick={onClose}>{t("common.close")}</Button>}
    >
      <div className="flex flex-wrap gap-2">
        <PolicySourceBadge source={policy.source} />
        {visiblePolicyTags(policy.tags).map((tag) => <Badge key={tag.id} variant={tag.source === "derived" ? "outline" : "secondary"}><PolicyTagLabel tag={tag} /></Badge>)}
      </div>
      <Tabs key={policy.id} defaultValue="policy" className="mt-5">
        <div className="overflow-x-auto">
          <TabsList aria-label={t("policyLibrary.detailViews")} className="min-w-max">
            <TabsTrigger value="policy">{t("policyLibrary.tabs.policy")}</TabsTrigger>
            <TabsTrigger value="validation">{t("policyLibrary.tabs.testCases")}</TabsTrigger>
            <TabsTrigger aria-label={t("policyLibrary.tabs.implementation")} value="implementation"><span aria-hidden className="sm:hidden">{t("policyLibrary.tabs.implementationShort")}</span><span aria-hidden className="hidden sm:inline">{t("policyLibrary.tabs.implementation")}</span></TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="policy" className="pt-3 sm:pt-4"><RuleList policy={policy} /></TabsContent>
        <TabsContent value="validation" className="pt-3 sm:pt-4"><PolicyTestCases policy={policy} /></TabsContent>
        <TabsContent value="implementation" className="pt-3 sm:pt-4"><Implementation policy={policy} /></TabsContent>
      </Tabs>
    </EntitySheet>
  );
}

export function DeletePolicyDialog({ policy, deleting, error, onCancel, onConfirm }: { policy: Policy | null; deleting: boolean; error: Error | null; onCancel: () => void; onConfirm: () => void }) {
  const { t } = useTranslation();
  return (
    <AlertDialog open={Boolean(policy)} onOpenChange={(open) => { if (!open && !deleting) onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("policyLibrary.deleteDialogTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("policyLibrary.deleteDialogDescription", { name: policy?.name ?? "" })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="rounded-lg border bg-muted/35 px-4 py-3 text-xs leading-5 text-muted-foreground">
          {t("policyLibrary.deleteDialogGuardrailNote")}
        </div>
        {error ? <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-xs leading-5 text-destructive">{error.message}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel asChild><Button variant="outline" disabled={deleting}>{t("common.cancel")}</Button></AlertDialogCancel>
          <AlertDialogAction asChild>
            <Button variant="destructive" disabled={deleting} onClick={(event) => { event.preventDefault(); onConfirm(); }}>
              {deleting ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
              {t(deleting ? "policyLibrary.deleting" : "policyLibrary.deleteConfirm")}
            </Button>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function RuleList({ policy }: { policy: Policy }) {
  const { t } = useTranslation();
  return (
    <section>
      <h3 className="text-sm font-semibold">{t("policyLibrary.ruleListTitle", { count: policy.rules.length })}</h3>
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
        <Badge variant="outline">{t(`policyLibrary.effects.${rule.effect}`, { defaultValue: rule.effect })}</Badge>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t bg-muted/15 px-4 py-4 text-xs">
        <p className="leading-5 text-muted-foreground">{rule.description || t("policyLibrary.noRuleDescription")}</p>
        <dl className="mt-3 grid gap-3 sm:grid-cols-3">
          <Fact label={t("policyLibrary.ruleForm")} value={t(`policyLibrary.forms.${rule.form}`)} />
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
      <h3 className="text-sm font-semibold">{t("policyLibrary.testCasesTitle", { count: policy.test_count })}</h3>
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
                    <pre className="whitespace-pre-wrap rounded-md border bg-background p-3 font-mono text-xs leading-5">{testCase.content}</pre>
                    <p className="mt-3 text-xs text-muted-foreground">{t("policyLibrary.coveredRules")}: {testCase.covered_rule_ids.map((id) => ruleNames.get(id) ?? id).join(", ")}</p>
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

function Implementation({ policy }: { policy: Policy }) {
  const { t } = useTranslation();
  return (
    <section>
      <h3 className="text-sm font-semibold">{t("policyLibrary.implementationTitle")}</h3>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("policyLibrary.implementationDescription")}</p>
      <dl className="mt-4 grid gap-3 rounded-lg border bg-muted/15 p-4 sm:grid-cols-2">
        <Fact label={t("policyLibrary.railTypesLabel")} value={policy.rails.map((railType) => t(`policyLibrary.railTypes.${railType}`)).join(", ")} />
        <Fact label={t("policyLibrary.ruleForms")} value={policy.forms.map((form) => t(`policyLibrary.forms.${form}`)).join(", ")} />
      </dl>
      <div className="mt-4 divide-y overflow-hidden rounded-lg border">
        {policy.rules.map((rule) => {
          const implementation = rule.implementation.flow_name ?? rule.implementation.detector ?? rule.form;
          return (
            <div key={rule.id} className="grid items-center gap-x-5 gap-y-2 px-4 py-3 text-xs sm:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_minmax(8rem,0.75fr)]">
              <div className="min-w-0"><strong className="block truncate font-medium">{rule.name}</strong><span className="mt-1 block truncate font-mono text-xs text-muted-foreground">{rule.implementation.binding_id}</span></div>
              <span className="min-w-0 truncate font-mono text-muted-foreground" title={implementation}>{implementation}</span>
              {rule.implementation.action_name ? (
                <code className="min-w-0 truncate text-muted-foreground sm:text-right" title={rule.implementation.action_name}>{rule.implementation.action_name}</code>
              ) : (
                <span className="min-w-0 truncate text-muted-foreground sm:text-right" title={t("policyLibrary.runtimeManaged")}>{t("policyLibrary.runtimeManaged")}</span>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-[10px] text-muted-foreground">{label}</dt><dd className="mt-1 text-xs font-medium">{value}</dd></div>;
}

function CatalogSkeleton() {
  return <div className="mt-5 grid gap-5 lg:grid-cols-[19rem_minmax(0,1fr)]"><Skeleton className="hidden h-[36rem] rounded-xl lg:block" /><div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">{Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-64 rounded-xl" />)}</div></div>;
}

function tagFacets(policies: Policy[]) {
  const facets = new Map<string, Map<string, CatalogFacetTag>>();
  for (const policy of policies) {
    const sourceTag: CatalogFacetTag = { id: `source:${policy.source}`, namespace: "source", value: policy.source, label: policy.source, source: "derived" };
    for (const tag of [sourceTag, ...visiblePolicyTags(policy.tags)]) {
      const values = facets.get(tag.namespace) ?? new Map<string, CatalogFacetTag>();
      values.set(tag.id, tag);
      facets.set(tag.namespace, values);
    }
  }
  return new Map(
    [...facets]
      .sort(([left], [right]) => facetOrder(left) - facetOrder(right) || left.localeCompare(right))
      .map(([namespace, values]) => [namespace, [...values.values()].sort((left, right) => left.label.localeCompare(right.label))]),
  );
}

function visiblePolicyTags(tags: PolicyTag[]) {
  return tags.filter((tag) => !HIDDEN_POLICY_TAG_NAMESPACES.has(tag.namespace));
}

function PolicyTagLabel({ tag, truncate = false, showRailHint = false }: { tag: CatalogFacetTag; truncate?: boolean; showRailHint?: boolean }) {
  const { t } = useTranslation();
  const jurisdiction = tag.namespace === "jurisdiction";
  const source = tag.namespace === "source";
  const rail = tag.namespace === "rail";
  const label = source
    ? t(`policyLibrary.sourceLabels.${tag.value}`, { defaultValue: tag.label })
    : jurisdiction
    ? t(`policyLibrary.jurisdictions.${tag.value}`, { defaultValue: tag.label })
    : rail
    ? t(`policyLibrary.railTypes.${tag.value}`, { defaultValue: tag.label })
    : tag.label;
  const flag = jurisdiction ? JURISDICTION_FLAGS[tag.value] : undefined;
  if (rail && showRailHint) {
    return (
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className={cn("font-medium", truncate && "max-w-52 truncate")}>{label}</span>
        <span className="text-[10px] leading-4 text-muted-foreground">{t(`policyLibrary.railTiming.${tag.value}`)}</span>
      </span>
    );
  }
  return (
    <>
      {flag ? <span aria-hidden="true" className="shrink-0 text-base leading-none">{flag}</span> : null}
      <span className={cn(truncate && "max-w-52 truncate")}>{label}</span>
    </>
  );
}

function PolicySourceBadge({ source }: { source: Policy["source"] }) {
  const { t } = useTranslation();
  const custom = source === "custom";
  const SourceIcon = custom ? FileCode2 : ShieldCheck;
  return (
    <Badge
      variant="outline"
      className={cn(custom ? "border-primary/30 bg-primary/10 font-semibold text-primary" : "bg-muted/30 font-normal text-muted-foreground")}
    >
      <SourceIcon />
      {t(`policyLibrary.sourceLabels.${source}`)}
    </Badge>
  );
}

function facetOrder(namespace: string) {
  const index = POLICY_FACET_ORDER.indexOf(namespace);
  return index === -1 ? POLICY_FACET_ORDER.length : index;
}

function policySearchText(policy: Policy) {
  return [
    policy.id,
    policy.name,
    policy.description,
    policy.source,
    ...visiblePolicyTags(policy.tags).flatMap((tag) => [tag.id, tag.label]),
    ...policy.rules.flatMap((rule) => [rule.id, rule.name, rule.description]),
    ...policy.test_cases.flatMap((testCase) => [testCase.group, testCase.name, testCase.content]),
  ].join(" ").toLocaleLowerCase();
}
