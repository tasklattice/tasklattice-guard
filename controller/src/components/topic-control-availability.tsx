import { useTranslation } from "react-i18next";
import { ModelCapabilityUnavailable, useModelCapabilityAvailability } from "./model-capability-availability";

export function useTopicControlAvailability(enabled: boolean) {
  return useModelCapabilityAvailability(enabled, "topic_control.input", "topicControl.availability");
}

export function TopicControlUnavailable({ availability }: { availability: ReturnType<typeof useTopicControlAvailability> }) {
  const { t } = useTranslation();
  return <ModelCapabilityUnavailable availability={availability} label={t("guardrailWizard.topicControl")}
    title={t("topicControl.availability.title")} hint={t("topicControl.availability.hint")} />;
}
