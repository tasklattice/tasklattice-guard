/** Optional Guardrail configuration, never defaults in the reusable Topic Policy. */
export const generalTopicRestrictions = [
  { topic: "News and current events", examples: ["news today", "latest news", "what happened in"] },
  { topic: "Elections and political campaigning", examples: ["election results", "political campaign"] },
  { topic: "Sports results and scores", examples: ["who won the", "sports scores", "sports score"] },
  { topic: "Weather forecasts", examples: ["weather forecast"] },
  { topic: "Stock market updates and prices", examples: ["stock market", "stock price"] },
  { topic: "Jokes", examples: ["tell me a joke"] },
  { topic: "Movie recommendations", examples: ["movie recommendation"] },
  { topic: "Celebrity gossip", examples: ["celebrity gossip"] },
  { topic: "Cryptocurrency advice", examples: ["cryptocurrency advice"] },
] as const;

export function appendGeneralTopicRestrictions(current: string): string {
  const lines = current.split("\n").map(line => line.trim()).filter(Boolean);
  const known = new Set(lines.map(line => line.toLowerCase()));
  return [...lines, ...generalTopicRestrictions.map(item => item.topic).filter(topic => !known.has(topic.toLowerCase()))].join("\n");
}
