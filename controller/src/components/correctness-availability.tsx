import { useTranslation } from "react-i18next";
import type { Policy } from "@/lib/api";
import { policyCorrectnessCapabilities } from "@/lib/protection-requirements";
import { ModelCapabilityUnavailable, useModelCapabilityAvailability } from "./model-capability-availability";

export function useCorrectnessAvailability(enabled: boolean) {
  const { t } = useTranslation();
  const contextual_grounding = useModelCapabilityAvailability(enabled, "contextual_grounding.output", "protection.correctness.availability", t("protection.correctness.contextual_grounding"));
  const automated_reasoning = useModelCapabilityAvailability(enabled, "automated_reasoning.output", "protection.correctness.availability", t("protection.correctness.automated_reasoning"));
  const capabilities = { contextual_grounding, automated_reasoning };
  const readyCount = Object.values(capabilities).filter(state => state.ready).length;
  const status: "available" | "partial" | "unavailable" = readyCount === 2 ? "available" : readyCount === 1 ? "partial" : "unavailable";
  return { capabilities, status, reason: (policy: Policy | undefined) => policyCorrectnessCapabilities(policy)
    .map(capability => capabilities[capability].reason).filter(Boolean).join(" ") || null };
}

export function CorrectnessUnavailable({ availability }: { availability: ReturnType<typeof useCorrectnessAvailability> }) {
  const { t } = useTranslation();
  return <div className="space-y-3">{Object.entries(availability.capabilities).filter(([, state]) => !state.ready).map(([capability, state]) =>
    <ModelCapabilityUnavailable key={capability} availability={state} label={t(`protection.correctness.${capability}`)}
      title={t(`protection.correctness.${capability}`)} hint={t(`protection.correctness.${capability}Hint`)} />)}</div>;
}
