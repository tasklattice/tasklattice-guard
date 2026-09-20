/** Topic lists belong to a versioned Policy binding. Guardrail-root fields are legacy only. */
export const TOPIC_POLICY_ID = "builtin-topic-safety";
export const TOPIC_POLICY_VERSION = "2.0.0";
export const TOPIC_ALLOW_RULE = "topic/allowlist";
export const TOPIC_DENY_RULE = "topic/denylist";
export const TOPIC_LEGACY_RULE = "model/topic-control";
export type TopicMode = "strict" | "permissive";
export const isSplitTopicPolicy = (id: string, version: string) => id === TOPIC_POLICY_ID && version === TOPIC_POLICY_VERSION;
export const topicLines = (value: string) => value.split("\n").map(item => item.trim()).filter(Boolean);
export function topicPolicyValues(parameters: Record<string, string>) {
  return { allowed: parameters.allowed_topics ?? "", denied: parameters.denied_topics ?? "", mode: parameters.topic_mode === "strict" ? "strict" as const : "permissive" as const };
}
export function topicMissingParameters(parameters: Record<string, string>, enabled: string[]) {
  const values = topicPolicyValues(parameters);
  return [
    ...(enabled.includes(TOPIC_ALLOW_RULE) && values.mode === "strict" && !topicLines(values.allowed).length ? ["allowed_topics"] : []),
    ...(enabled.includes(TOPIC_DENY_RULE) && !topicLines(values.denied).length ? ["denied_topics"] : []),
  ];
}
