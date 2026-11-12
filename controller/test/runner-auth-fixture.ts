const defaultControlToken = "test-default-pool-control-token-32-characters";

export function runnerAuthEnv(control: string | Record<string, string> = defaultControlToken,
  http?: Record<string, string>) {
  const controlTokens = typeof control === "string" ? { default: control } : { default: defaultControlToken, ...control };
  const httpTokens = http ?? Object.fromEntries(Object.keys(controlTokens).map(poolId => [
    poolId, `test-${poolId}-controller-http-token-32-characters`,
  ]));
  return {
    CONTROLLER_RUNNER_POOL_TOKENS_JSON: JSON.stringify(controlTokens),
    CONTROLLER_RUNNER_HTTP_TOKENS_JSON: JSON.stringify(httpTokens),
  };
}
