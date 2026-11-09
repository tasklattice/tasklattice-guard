import { useQuery } from "@tanstack/react-query";
import { ChevronDown, FlaskConical, LockKeyhole } from "lucide-react";
import { useTranslation } from "react-i18next";
import { CopyableChecksum } from "@/components/copyable-checksum";
import { ErrorNotice, InfoNotice } from "@/components/product-shell";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { queryKeys } from "@/features/query-keys";
import { getGuardrailVersionTestSuite, type FrozenTestCase } from "@/lib/controller-api";

/**
 * The Test Cases frozen into one version, read only. With its Policies they
 * are the version's static definition: the same suite runs wherever the
 * version is tested.
 */
export function VersionTestSuite({ guardrailId, version }: { guardrailId: string; version: string }) {
  const { t } = useTranslation();
  const query = useQuery({ queryKey: queryKeys.guardrailVersionTestSuite(guardrailId, version), queryFn: () => getGuardrailVersionTestSuite(guardrailId, version) });
  if (query.isPending) return <div role="status" className="space-y-3"><p className="text-sm text-muted-foreground">{t("immutableVersions.testSuiteLoading")}</p><Skeleton className="h-40" /></div>;
  if (query.error) return <ErrorNotice error={query.error} />;
  const suite = query.data;
  if (!suite.recorded) return <InfoNotice>{t("immutableVersions.testSuiteNotRecorded")}</InfoNotice>;
  // Group Policy-generated cases by their Policy; Guardrail-specific cases last.
  const groups = new Map<string, FrozenTestCase[]>();
  for (const item of suite.items) {
    const key = item.origin === "custom" ? "" : item.sourcePolicyId ?? item.policyId;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const ordered = [...groups].sort(([left], [right]) => (left === "" ? 1 : 0) - (right === "" ? 1 : 0) || left.localeCompare(right));
  return <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <p className="flex max-w-3xl items-start gap-2 text-sm text-muted-foreground"><LockKeyhole className="mt-0.5 size-3.5 shrink-0" />{t("immutableVersions.testSuiteDescription")}</p>
      {suite.digest ? <div className="shrink-0"><p className="mb-1 text-xs text-muted-foreground">{t("immutableVersions.testSuiteDigest")}</p><CopyableChecksum value={suite.digest} /></div> : null}
    </div>
    {ordered.map(([policyId, cases]) => <section key={policyId || "guardrail"} className="overflow-hidden rounded-lg border">
      <h4 className="flex items-center justify-between gap-3 border-b bg-muted/20 px-4 py-3 text-sm font-medium">
        <span className="min-w-0 truncate font-mono">{policyId || t("immutableVersions.testSuiteGuardrailGroup")}</span>
        <Badge variant="outline">{cases.length}</Badge>
      </h4>
      <div className="divide-y">{cases.map(item => <TestCaseRow key={item.id} item={item} />)}</div>
    </section>)}
  </div>;
}

function TestCaseRow({ item }: { item: FrozenTestCase }) {
  const { t } = useTranslation();
  const expected = item.expectationOverride?.expectedDecision ?? item.expectedDecision;
  return <details className="group bg-card">
    <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
      <FlaskConical className="size-4 shrink-0 text-primary" />
      <span className="min-w-0 flex-1"><strong className="block truncate text-sm font-medium">{item.name}</strong>
        <span className="mt-1 block text-xs text-muted-foreground">{t(`policyLibrary.railTypes.${item.phase}`, { defaultValue: item.phase })}</span></span>
      <Badge variant="secondary" className="whitespace-nowrap">{t(`policyLibrary.expectedDecisions.${expected}`, { defaultValue: expected })}</Badge>
      <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
    </summary>
    <div className="space-y-3 border-t bg-muted/15 px-4 py-4 text-xs">
      <pre className="whitespace-pre-wrap rounded-md border bg-background p-3 font-mono leading-5">{item.content}</pre>
      {item.expectationOverride ? <p className="text-muted-foreground">{t("immutableVersions.testSuiteOverride", { reason: item.expectationOverride.reason })}</p> : null}
      {item.coveredRuleIds.length ? <p className="break-all font-mono text-muted-foreground">{item.coveredRuleIds.join(" · ")}</p> : null}
    </div>
  </details>;
}
