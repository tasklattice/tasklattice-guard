/** Topic lists belong to a versioned Policy binding. Each Rule owns its parameters. */
export const TOPIC_POLICY_ID = "business-topics";
export const TOPIC_POLICY_VERSION = "1.0.0";
export const TOPIC_ALLOW_RULE = "topic/allowlist";
export const TOPIC_DENY_RULE = "topic/denylist";
export type TopicMode = "strict" | "permissive";
export const isSplitTopicPolicy = (id: string, version: string) => id === TOPIC_POLICY_ID && version === TOPIC_POLICY_VERSION;
/** Topic semantics follow the Rules, not a renamed Policy identity. */
export const hasTopicRules = (rules: ReadonlyArray<{ id: string }>) => rules.some(rule => rule.id === TOPIC_DENY_RULE || rule.id === TOPIC_ALLOW_RULE);
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
