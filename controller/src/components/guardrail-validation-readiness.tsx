import { useQuery } from "@tanstack/react-query";
import { CircleAlert, LoaderCircle, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { GuardrailPolicyBinding, Policy } from "@/lib/api-types";
import { getModelConfiguration } from "@/lib/controller-api";
import { dependencyAssignment, selectedModelDependencies } from "@/lib/protection-dependencies";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";

export function useGuardrailValidationReadiness({ bindings, policies, enabled = true, policiesReady = true, policiesError = false }: {
  bindings: GuardrailPolicyBinding[]; policies: Policy[]; enabled?: boolean; policiesReady?: boolean; policiesError?: boolean;
}) {
  const { t } = useTranslation();
  const dependencies = selectedModelDependencies(bindings, policies);
  const needsModels = dependencies.required.length > 0;
  const query = useQuery({ queryKey: ["resources", "model-configuration"], queryFn: getModelConfiguration,
    enabled: enabled && policiesReady && needsModels, retry: false, refetchInterval: enabled && needsModels ? 10_000 : false });
  const unavailable = policiesError || needsModels && query.isError;
  const checking = !unavailable && (!policiesReady || needsModels && query.isPending);
  const blockers = policiesReady && !unavailable && query.data ? dependencies.required.flatMap(item => {
    const assignment = dependencyAssignment(item.id, query.data);
    return assignment.state === "active" ? [] : [{ ...item, ...assignment }];
  }) : [];
  const blocked = checking || unavailable || blockers.length > 0;
  const hasTopicBlocker = blockers.some(item => item.id === "topic_control.input");
  const reason = checking ? t("protection.validationReadiness.checking") : unavailable ? t("protection.validationReadiness.unavailable")
    : blockers.length ? t(hasTopicBlocker ? "protection.validationReadiness.topicFix" : "protection.validationReadiness.fix") : null;
  return { checking, unavailable, blockers, blocked, hasTopicBlocker, reason, unknownPolicies: dependencies.unknownPolicies,
    refreshing: query.isFetching, refresh: () => void query.refetch() };
}

export function GuardrailValidationReadiness({ readiness, onEdit, onRetry, onRemoveTopic }: {
  readiness: ReturnType<typeof useGuardrailValidationReadiness>; onEdit?: () => void; onRetry?: () => void; onRemoveTopic?: () => void;
}) {
  const { t } = useTranslation();
  if (!readiness.blocked && !readiness.unknownPolicies.length) return null;
  const error = readiness.blockers.length > 0;
  return <Alert variant={error ? "destructive" : readiness.checking ? "default" : "warning"} role={error ? "alert" : "status"}>
    {error ? <CircleAlert /> : readiness.checking ? <LoaderCircle className="animate-spin motion-reduce:animate-none" /> : <TriangleAlert />}
    <AlertTitle className="leading-6">{t(`protection.validationReadiness.${error ? "blockedTitle" : readiness.checking ? "checking" : "warningTitle"}`)}</AlertTitle>
    <AlertDescription className="min-w-0 space-y-3 text-current">
      {readiness.blockers.length ? <ul className="space-y-2">{readiness.blockers.map(item => {
        const [capability, rail] = item.id.split(".");
        return <li key={item.id} className="break-words"><strong>{t(`protection.dependencies.capabilities.${capability}`)} · {t(`protection.${rail}`)}</strong>
          <span> — {t(`protection.validationReadiness.states.${item.state}`)}</span>
          <span className="block text-xs leading-5">{t("protection.validationReadiness.policies", { names: item.policyNames.join(" · ") })}</span>
        </li>;
      })}</ul> : null}
      {!readiness.checking && readiness.reason ? <p>{readiness.reason}</p> : null}
      {!readiness.checking && !readiness.unavailable && readiness.unknownPolicies.length ? <p>{t("protection.dependencies.unknownPolicy", { policies: readiness.unknownPolicies.join(", ") })}</p> : null}
      {!readiness.checking ? <div className="flex flex-wrap gap-2">
        {error && onEdit ? <Button variant="outline" className="min-h-11 h-auto whitespace-normal" onClick={onEdit}>{t(readiness.hasTopicBlocker ? "protection.validationReadiness.editTopic" : "protection.validationReadiness.edit")}</Button> : null}
        {readiness.hasTopicBlocker && onRemoveTopic ? <Button variant="outline" className="min-h-11 h-auto whitespace-normal" onClick={onRemoveTopic}>{t("protection.validationReadiness.removeTopic")}</Button> : null}
        {readiness.blocked ? <Button variant="outline" className="min-h-11" disabled={readiness.refreshing} onClick={onRetry ?? readiness.refresh}>{t("protection.validationReadiness.retry")}</Button> : null}
      </div> : null}
    </AlertDescription>
  </Alert>;
}
