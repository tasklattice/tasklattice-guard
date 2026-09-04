import { ArrowLeft, ArrowRight, GitCompareArrows, History } from "lucide-react";
import { useTranslation } from "react-i18next";

import { StateBadge } from "@/components/product-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { GuardrailVersion, GuardrailVersionDetail } from "@/lib/api";
import { cn } from "@/lib/utils";

export type VersionDiffKind = "added" | "removed" | "changed";
export type VersionDiffCategory = "posture" | "policies" | "runtime";

export type VersionDiffChange = {
  category: VersionDiffCategory;
  kind: VersionDiffKind;
  field: string;
  subject?: string;
  before?: string;
  after?: string;
};

export function GuardrailVersionNavigator({ versions, selectedVersion, onSelect }: {
  versions: GuardrailVersion[];
  selectedVersion: string;
  onSelect: (version: string) => void;
}) {
  const { t, i18n } = useTranslation();
  return (
    <aside className="overflow-hidden rounded-xl border bg-card lg:sticky lg:top-20 lg:self-start">
      <header className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold">{t("guardrails.versions")}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("guardrails.versionCount", { count: versions.length })}</p>
      </header>
      <ol className="relative max-h-[42rem] overflow-y-auto py-1 before:absolute before:top-8 before:bottom-8 before:left-[1.65rem] before:w-px before:bg-border">
        {versions.map((version) => {
          const selected = version.version === selectedVersion;
          const releaseId = version.version;
          return (
            <li key={version.version} className="relative px-1.5">
              <button
                type="button"
                className={cn(
                  "group relative flex min-h-20 w-full items-start gap-3 rounded-lg px-3 py-3 text-left transition-colors hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring",
                  selected && "bg-primary/[0.07] hover:bg-primary/[0.09]",
                )}
                aria-current={selected ? "true" : undefined}
                aria-label={t("guardrails.selectVersion", { version: releaseId })}
                onClick={() => onSelect(version.version)}
              >
                <span className={cn("relative z-10 mt-1 size-3 shrink-0 rounded-full border-2 border-card bg-muted-foreground/40 ring-1 ring-border", version.active && "bg-emerald-500", selected && "bg-primary ring-primary/30")} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-xs font-semibold text-foreground">{releaseId}</span>
                  <time className="mt-1 block text-[11px] text-muted-foreground" dateTime={version.created_at}>{new Date(version.created_at).toLocaleString(i18n.language)}</time>
                  <span className="mt-1.5 flex items-center gap-2">
                    {version.active ? <StateBadge state="active" /> : <span className="text-[11px] text-muted-foreground">{t("guardrails.historicalVersion")}</span>}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

export function GuardrailVersionComparison({ base, target, baseOptions, onBaseChange, onClose }: {
  base: GuardrailVersionDetail;
  target: GuardrailVersionDetail;
  baseOptions: GuardrailVersion[];
  onBaseChange: (version: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const changes = buildGuardrailVersionDiff(base, target);
  const grouped = (["posture", "policies", "runtime"] as VersionDiffCategory[])
    .map((category) => ({ category, changes: changes.filter((change) => change.category === category) }))
    .filter((group) => group.changes.length);

  return (
    <Card className="gap-0 overflow-hidden py-0 shadow-none">
      <CardHeader className="border-b px-5 py-4">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <div className="flex items-center gap-2"><GitCompareArrows className="size-4 text-primary" /><CardTitle>{t("guardrails.versionComparison")}</CardTitle></div>
            <CardDescription className="mt-1.5">{t("guardrails.versionComparisonDescription")}</CardDescription>
          </div>
          <Button variant="outline" className="min-h-11 self-start" onClick={onClose}><ArrowLeft />{t("guardrails.backToVersionDetail")}</Button>
        </div>
        <div className="mt-4 grid gap-3 rounded-lg border bg-muted/20 p-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-end">
          <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
            {t("guardrails.baseVersion")}
            <Select value={base.version} onValueChange={onBaseChange}>
              <SelectTrigger className="min-h-11 bg-card" aria-label={t("guardrails.baseVersion")}><SelectValue /></SelectTrigger>
              <SelectContent>{baseOptions.map((version) => <SelectItem key={version.version} value={version.version}>{version.version}</SelectItem>)}</SelectContent>
            </Select>
          </label>
          <ArrowRight className="mb-3 hidden size-4 text-muted-foreground sm:block" />
          <div className="grid min-h-11 gap-1 rounded-lg border bg-card px-3 py-2">
            <span className="text-xs font-medium text-muted-foreground">{t("guardrails.targetVersion")}</span>
            <span className="truncate font-mono text-xs font-semibold">{target.version}</span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-0 py-0">
        <div className="flex items-center justify-between gap-3 px-5 py-3">
          <p className="text-sm font-semibold">{t("guardrails.versionChanges", { count: changes.length })}</p>
          <span className="text-xs text-muted-foreground">{t("guardrails.unchangedHidden")}</span>
        </div>
        {grouped.length ? grouped.map((group) => (
          <section key={group.category} className="border-t px-5 py-4">
            <h3 className="text-sm font-semibold">{t(`guardrails.versionDiffCategories.${group.category}`)}</h3>
            <div className="mt-3 overflow-hidden rounded-lg border">
              {group.changes.map((change, index) => <VersionChangeRow key={`${change.field}:${change.subject ?? ""}:${index}`} change={change} />)}
            </div>
          </section>
        )) : <div className="border-t px-5 py-12 text-center"><History className="mx-auto size-5 text-muted-foreground" /><p className="mt-3 text-sm font-medium">{t("guardrails.noVersionChanges")}</p><p className="mt-1 text-xs text-muted-foreground">{t("guardrails.noVersionChangesDescription")}</p></div>}
        <ArtifactComparison base={base} target={target} />
      </CardContent>
    </Card>
  );
}

function VersionChangeRow({ change }: { change: VersionDiffChange }) {
  const { t } = useTranslation();
  const label = t(`guardrails.versionDiffFields.${change.field}`);
  return (
    <div className="grid gap-2 border-b px-3 py-3 last:border-b-0 lg:grid-cols-[7.5rem_minmax(0,1fr)] lg:items-start">
      <div className="flex min-w-0 items-center gap-2">
        <Badge variant="outline" className={cn(
          "h-5 rounded-sm px-1.5 text-[10px]",
          change.kind === "added" && "border-emerald-200 bg-emerald-50 text-emerald-700",
          change.kind === "removed" && "border-red-200 bg-red-50 text-red-700",
          change.kind === "changed" && "border-amber-200 bg-amber-50 text-amber-700",
        )}>{t(`guardrails.versionDiffKinds.${change.kind}`)}</Badge>
        <span className="truncate text-xs font-medium">{label}</span>
      </div>
      <div className="min-w-0">
        {change.subject ? <p className="mb-1 font-mono text-[11px] font-medium">{change.subject}</p> : null}
        {change.kind === "added" ? <code className="block break-words text-[11px] text-emerald-700">{change.after}</code> : null}
        {change.kind === "removed" ? <code className="block break-words text-[11px] text-red-700 line-through">{change.before}</code> : null}
        {change.kind === "changed" ? <div className="grid gap-1.5 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-center"><code className="break-words rounded bg-red-50 px-2 py-1 text-[11px] text-red-700">{change.before}</code><ArrowRight className="hidden size-3.5 text-muted-foreground sm:block" /><code className="break-words rounded bg-emerald-50 px-2 py-1 text-[11px] text-emerald-700">{change.after}</code></div> : null}
      </div>
    </div>
  );
}

function ArtifactComparison({ base, target }: { base: GuardrailVersionDetail; target: GuardrailVersionDetail }) {
  const { t } = useTranslation();
  const baseArtifacts = new Map(base.artifacts.map((artifact) => [artifact.path, artifact]));
  const targetArtifacts = new Map(target.artifacts.map((artifact) => [artifact.path, artifact]));
  const changedPaths = [...new Set([...baseArtifacts.keys(), ...targetArtifacts.keys()])].filter((path) => baseArtifacts.get(path)?.content !== targetArtifacts.get(path)?.content).sort();
  if (!changedPaths.length) return null;
  return (
    <details className="group border-t">
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-5 py-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
        <span>{t("guardrails.artifactDiff", { count: changedPaths.length })}</span>
        <Badge variant="outline">{changedPaths.length}</Badge>
      </summary>
      <div className="space-y-3 border-t bg-muted/10 p-4">
        {changedPaths.map((path) => {
          const before = baseArtifacts.get(path)?.content ?? "";
          const after = targetArtifacts.get(path)?.content ?? "";
          return <details key={path} className="overflow-hidden rounded-lg border bg-card"><summary className="min-h-11 cursor-pointer px-3 py-3 font-mono text-xs font-medium focus-visible:outline-2 focus-visible:outline-ring">{path}</summary><div className="grid border-t lg:grid-cols-2"><ArtifactPane label={t("guardrails.before")} content={before} tone="removed" /><ArtifactPane label={t("guardrails.after")} content={after} tone="added" /></div></details>;
        })}
      </div>
    </details>
  );
}

function ArtifactPane({ label, content, tone }: { label: string; content: string; tone: "added" | "removed" }) {
  return <section className="min-w-0 border-b last:border-b-0 lg:border-r lg:border-b-0 lg:last:border-r-0"><p className={cn("border-b px-3 py-2 text-[11px] font-medium", tone === "added" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700")}>{label}</p><pre className="max-h-80 overflow-auto p-3 font-mono text-[11px] leading-5 whitespace-pre">{content || "—"}</pre></section>;
}

export function buildGuardrailVersionDiff(base: GuardrailVersionDetail, target: GuardrailVersionDetail) {
  const changes: VersionDiffChange[] = [];
  addScalarChange(changes, "posture", "safetyLevel", base.safety_level, target.safety_level);
  addScalarChange(changes, "posture", "outputDelivery", base.output_delivery, target.output_delivery);
  addScalarChange(changes, "posture", "runtimeEngine", base.runtime_engine, target.runtime_engine);
  addScalarChange(changes, "posture", "runtimeProfile", base.runtime_profile, target.runtime_profile);
  addScalarChange(changes, "posture", "compiler", base.compiler_version, target.compiler_version);
  addScalarChange(changes, "posture", "colangVersion", base.colang_version, target.colang_version);
  addScalarChange(changes, "posture", "criticalPath", `${base.estimated_critical_path_ms} ms`, `${target.estimated_critical_path_ms} ms`);

  const basePolicies = new Map(base.policy_bindings.map((binding) => [binding.policy_id, binding]));
  const targetPolicies = new Map(target.policy_bindings.map((binding) => [binding.policy_id, binding]));
  for (const policyId of [...new Set([...basePolicies.keys(), ...targetPolicies.keys()])].sort()) {
    const before = basePolicies.get(policyId);
    const after = targetPolicies.get(policyId);
    addEntityChange(changes, "policies", "policy", policyId, before && describePolicy(before), after && describePolicy(after));
  }

  addSetChanges(changes, "runtime", "rail", base.rails.map((rail) => `${rail.rail_type}:${rail.flow}`), target.rails.map((rail) => `${rail.rail_type}:${rail.flow}`));
  const baseActions = new Map(base.actions.map((action) => [action.name, describeAction(action)]));
  const targetActions = new Map(target.actions.map((action) => [action.name, describeAction(action)]));
  for (const actionName of [...new Set([...baseActions.keys(), ...targetActions.keys()])].sort()) addEntityChange(changes, "runtime", "action", actionName, baseActions.get(actionName), targetActions.get(actionName));
  addSetChanges(changes, "runtime", "model", base.models, target.models);
  addSetChanges(changes, "runtime", "feature", base.features, target.features);
  addSetChanges(changes, "runtime", "dependency", base.dependencies.map(describeDependency), target.dependencies.map(describeDependency));
  return changes;
}

function addScalarChange(changes: VersionDiffChange[], category: VersionDiffCategory, field: string, before: string, after: string) {
  if (before !== after) changes.push({ category, kind: "changed", field, before, after });
}

function addEntityChange(changes: VersionDiffChange[], category: VersionDiffCategory, field: string, subject: string, before?: string, after?: string) {
  if (before === after) return;
  if (before === undefined) changes.push({ category, kind: "added", field, subject, after });
  else if (after === undefined) changes.push({ category, kind: "removed", field, subject, before });
  else changes.push({ category, kind: "changed", field, subject, before, after });
}

function addSetChanges(changes: VersionDiffChange[], category: VersionDiffCategory, field: string, beforeValues: string[], afterValues: string[]) {
  const before = new Set(beforeValues);
  const after = new Set(afterValues);
  for (const value of [...after].filter((item) => !before.has(item)).sort()) changes.push({ category, kind: "added", field, subject: value, after: value });
  for (const value of [...before].filter((item) => !after.has(item)).sort()) changes.push({ category, kind: "removed", field, subject: value, before: value });
}

function describePolicy(binding: GuardrailVersionDetail["policy_bindings"][number]) {
  return `v${binding.policy_version} · ${binding.action ?? "pass"} · rules:[${[...binding.enabled_rule_ids].sort().join(",")}] · rails:[${[...binding.enabled_rails].sort().join(",")}]`;
}

function describeAction(action: GuardrailVersionDetail["actions"][number]) {
  return `${action.version ? `v${action.version}` : "unversioned"} · ${[...action.phases].sort().join(",")} · ${action.timeout_ms} ms · ${action.failure_mode}`;
}

function describeDependency(dependency: GuardrailVersionDetail["dependencies"][number]) {
  return `${dependency.kind}:${dependency.name}@${dependency.version}`;
}
