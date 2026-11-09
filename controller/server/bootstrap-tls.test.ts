// @vitest-environment node
import { createPrivateKey, X509Certificate } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { generateTls, validateTls } from "../scripts/runtime/bootstrap-tls.mjs";
import { ensureSecret } from "../scripts/runtime/bootstrap-secrets.mjs";

const spec = { name: "control-tls", kind: "mtls", serverDnsNames: ["controller", "controller.ns.svc.cluster.local"], runnerName: "runner", caKey: "ca.crt", serverCertificateKey: "tls.crt", serverPrivateKeyKey: "tls.key", clientCertificateKey: "runner.crt", clientPrivateKeyKey: "runner.key" };

describe("in-cluster mTLS initialization", () => {
  it("generates and reuses a valid CA and separate server/client certificates", async () => {
    const data = generateTls(spec);
    expect(Object.keys(data).sort()).toEqual(["ca.crt", "ca.key", "runner.crt", "runner.key", "tls.crt", "tls.key"]);
    expect(createPrivateKey(data["tls.key"]).asymmetricKeyType).toBe("ec");
    expect(new X509Certificate(data["tls.crt"]).checkHost("controller.ns.svc.cluster.local")).toBe("controller.ns.svc.cluster.local");
    expect(() => validateTls(spec, data)).not.toThrow();
    expect(new X509Certificate(data["ca.crt"]).checkPrivateKey(createPrivateKey(data["ca.key"]))).toBe(true);
    const reissued = generateTls(spec, data);
    expect(reissued["ca.crt"]).toBe(data["ca.crt"]);
    expect(reissued["ca.key"]).toBe(data["ca.key"]);
    expect(reissued["tls.crt"]).not.toBe(data["tls.crt"]);
    expect(() => validateTls(spec, reissued)).not.toThrow();
    expect(() => validateTls(spec, { ...data, "ca.key": data["tls.key"] })).toThrow();
    const owner = { apiVersion: "v1", kind: "Namespace", name: "namespace", uid: "stable-owner" };
    const request = vi.fn().mockResolvedValue({ status: 200, body: { metadata: { ownerReferences: [owner], annotations: { "helm.sh/resource-policy": "keep" }, labels: { "app.kubernetes.io/managed-by": "tali-guard-bootstrap", "tasklattice.io/release": "release" } }, data: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, Buffer.from(value).toString("base64")])) } });
    expect(await ensureSecret(request, "namespace", "release", spec, owner)).toBe("reused");
    expect(request).toHaveBeenCalledOnce();
    expect(() => validateTls({ ...spec, serverDnsNames: ["different-controller"] }, data)).toThrow("refusing automatic rotation");
    expect(() => validateTls(spec, { ...data, "tls.key": data["runner.key"] })).toThrow("refusing automatic rotation");
    expect(() => validateTls(spec, { ...data, "tls.crt": data["runner.crt"] })).toThrow("refusing automatic rotation");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3660 * 24 * 60 * 60 * 1000);
    try { expect(() => validateTls(spec, data)).toThrow("expired"); }
    finally { vi.restoreAllMocks(); }
  });

  it("rejects malformed certificate names before invoking OpenSSL", () => {
    expect(() => generateTls({ ...spec, serverDnsNames: ["controller\nCA:TRUE"] })).toThrow("Invalid mTLS certificate DNS");
  });
});
