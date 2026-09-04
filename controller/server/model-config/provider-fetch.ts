import { Agent } from "undici";

// Same per-request approach as Relay. Never weaken the process-wide TLS
// defaults: the dispatcher is used only by an explicitly opted-in Provider.
const insecureProviderDispatcher = new Agent({ connect: { rejectUnauthorized: false } });

export function providerFetch(skipTlsVerify = false, fetcher: typeof fetch = globalThis.fetch): typeof fetch {
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const request = {
      ...init,
      ...(skipTlsVerify && url.protocol === "https:" ? {
        dispatcher: insecureProviderDispatcher,
        // Do not carry the insecure transport or credentials to another host.
        redirect: "error" as const,
      } : {}),
    };
    // Node's undici-types can lag the installed dispatcher typings.
    return fetcher(input, request as RequestInit);
  };
}

const certificateErrors = new Set([
  "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

export function providerTlsError(error: unknown): string | undefined {
  const cause = error instanceof Error ? error.cause : undefined;
  const code = cause && typeof cause === "object" && "code" in cause ? String(cause.code) : "";
  if (certificateErrors.has(code)) {
    return `TLS certificate verification failed (${code}). Enable Skip TLS certificate verification in Provider settings only if you trust this endpoint.`;
  }
}
