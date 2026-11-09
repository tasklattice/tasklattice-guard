/** Advertise the same HTTP(S) origin used to reach the Controller.
 * The ingress must overwrite X-Forwarded-Host/Proto with the external address.
 * This value is response-only: internal Runtime calls still use Service DNS.
 */
export function endpointRequestOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || url.host;
  const protocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.slice(0, -1);
  if (!/^https?$/.test(protocol) || /[\s\\/@?#]/.test(host)) return url.origin;
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return url.origin;
  }
}
