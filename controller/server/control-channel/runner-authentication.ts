import { timingSafeEqual } from "node:crypto";
import type { ControllerConfig } from "../config.js";

/** A null poolId is the intentionally unrestricted legacy principal. */
export function authenticateRunnerPrincipal(value: unknown, config: ControllerConfig): { poolId: string | null } | null {
  if (typeof value !== "string" || !value.startsWith("Bearer ")) return null;
  const token = value.slice(7);
  const sameSecret = (left: string, right: string) => {
    const a = Buffer.from(left), b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  if (config.runnerPoolTokens == null) {
    return sameSecret(token, config.runnerToken) ? { poolId: null } : null;
  }
  let matchedPool: string | null = null;
  // Check every configured value and never log token material.
  for (const [poolId, secret] of config.runnerPoolTokens) {
    if (sameSecret(token, secret)) matchedPool = poolId;
  }
  return matchedPool === null ? null : { poolId: matchedPool };
}
