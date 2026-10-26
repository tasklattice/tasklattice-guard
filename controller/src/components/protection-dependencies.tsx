import { isPlatformAdministrator } from "../../shared/rbac";
import { useAuth } from "@/lib/auth";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { getModelReadiness } from "@/lib/controller-api";
import { selectedModelDependencies, dependencyAssignment } from "@/lib/protection-dependencies";
import type { GuardrailPolicyBinding, Policy } from "@/lib/api-types";

export function ProtectionDependencies({ bindings, policies }: { bindings: GuardrailPolicyBinding[]; policies: Policy[] }) {
  const { t } = useTranslation();
  const administrator = isPlatformAdministrator(useAuth().user?.role);
  const dependencies = selectedModelDependencies(bindings, policies);
  const query = useQuery({ queryKey: ["resources", "model-readiness"], queryFn: getModelReadiness,
    enabled: dependencies.required.length > 0, retry: false, refetchInterval: 10_000 });
  if (!dependencies.required.length && !dependencies.unknownPolicies.length) return null;
  return <section aria-label={t("protection.dependencies.title")} className="space-y-3 rounded-lg border bg-card p-4">
    <h4 className="text-sm font-semibold">{t("protection.dependencies.title")}</h4>
    <p className="text-xs leading-5 text-muted-foreground">{t("protection.dependencies.hint")}</p>
    {dependencies.unknownPolicies.length ? <p role="status" className="text-sm text-amber-800">{t("protection.dependencies.unknownPolicy", { policies: dependencies.unknownPolicies.join(", ") })}</p> : null}
    {dependencies.required.length ? <>
      {query.isPending ? <p role="status" className="text-sm">{t("protection.dependencies.loading")}</p> : query.isError || !query.data ? <div role="alert" className="space-y-2">
        <p className="text-sm text-destructive">{t("protection.dependencies.unavailable")}</p>
        <Button type="button" className="min-h-11" variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>{t("protection.dependencies.retry")}</Button>
      </div> : <ul className="divide-y">
        {dependencies.required.map(item => {
          const assignment = dependencyAssignment(item.id, query.data!);
          const [capability, rail] = item.id.split(".");
          return <li key={item.id} className="space-y-1 py-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">{t(`protection.dependencies.capabilities.${capability}`)} · {t(`protection.${rail}`)}</span>
              <Badge variant={assignment.state === "failed" ? "destructive" : "outline"}>{t(`protection.dependencies.states.${assignment.state}`)}</Badge>
            </div>
            {assignment.modelName ? <p className="break-words">{assignment.modelName}</p> : null}
            {assignment.state === "active" ? <p className="text-xs text-muted-foreground">{t(`protection.dependencies.validation.${assignment.validation}`)}</p> : null}
            <p className="text-xs text-muted-foreground">{item.policyNames.join(" · ")}</p>
            {assignment.checkedAt ? <p className="text-xs text-muted-foreground">{t("protection.dependencies.checked", { revision: assignment.revision, time: new Date(assignment.checkedAt).toLocaleString() })}</p> : null}
          </li>;
        })}
      </ul>}
      {administrator ? <a className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline" href="/settings/guardrail-catalog" target="_blank" rel="noopener noreferrer">{t("protection.dependencies.configure")}</a> : <p className="text-sm text-muted-foreground">{t("auth.platformSetupRequired")}</p>}
    </> : null}
  </section>;
}
