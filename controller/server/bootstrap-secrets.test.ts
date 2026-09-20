// @vitest-environment node
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { namespaceOwner, ensureSecret, secretData } from "../scripts/runtime/bootstrap-secrets.mjs";

const spec = { name: "signing", kind: "ed25519", privateKey: "private.pem", publicKey: "public.pem" };
const owner = { apiVersion: "v1", kind: "Namespace", name: "namespace", uid: "owner-uid", controller: false, blockOwnerDeletion: false };
const metadata = { ownerReferences: [owner], annotations: { "helm.sh/resource-policy": "keep" }, labels: { "app.kubernetes.io/managed-by": "tali-guard-bootstrap", "tasklattice.io/release": "release" } };
const encode = (data: Record<string, string>) => Object.fromEntries(Object.entries(data).map(([key, value]) => [key, Buffer.from(value).toString("base64")]));

describe("in-cluster Secret bootstrap", () => {
  it("generates an Ed25519 key pair, tokens and a 32-byte encryption key", () => {
    const keys = secretData(spec);
    const privateKey = createPrivateKey(keys[spec.privateKey]);
    const publicKey = createPublicKey(keys[spec.publicKey]);
    expect(privateKey.asymmetricKeyType).toBe("ed25519");
    expect(verify(null, Buffer.from("artifact"), publicKey, sign(null, Buffer.from("artifact"), privateKey))).toBe(true);
    expect(secretData(spec)).not.toEqual(keys);
    expect(secretData({ kind: "tokens", keys: ["runner"] }).runner).toMatch(/^[a-f0-9]{64}$/);
    expect(Buffer.from(secretData({ kind: "encryption", keys: ["key"] }).key, "base64")).toHaveLength(32);
  });

  it("creates once and reuses the same keys across subsequent syncs", async () => {
    let stored: unknown;
    const request = vi.fn(async (method: string, _path: string, body?: { stringData: Record<string, string> }) => {
      if (method === "GET") return stored ? { status: 200, body: stored } : { status: 404 };
      stored = { metadata, data: encode(body!.stringData) };
      return { status: 201 };
    });
    expect(await ensureSecret(request, "namespace", "release", spec, owner)).toBe("created");
    const original = stored;
    expect(await ensureSecret(request, "namespace", "release", spec, owner)).toBe("reused");
    expect(stored).toBe(original);
    expect(request.mock.calls.filter(([method]) => method === "POST")).toHaveLength(1);
    const created = request.mock.calls.find(([method]) => method === "POST")![2] as any;
    expect(created.metadata.ownerReferences).toEqual([owner]);
    expect(created.metadata.labels).not.toHaveProperty("app.kubernetes.io/instance");
    expect(created.metadata.annotations["argocd.argoproj.io/sync-options"]).toBe("Prune=false,Delete=false");
    expect(request.mock.calls[0]![1]).toBe("/api/v1/namespaces/namespace/secrets/signing");
  });

  it("does not overwrite a concurrently created Secret", async () => {
    const request = vi.fn().mockResolvedValueOnce({ status: 404 })
      .mockResolvedValueOnce({ status: 409 })
      .mockResolvedValueOnce({ status: 200, body: { metadata, data: encode(secretData(spec)) } });
    expect(await ensureSecret(request, "namespace", "release", spec, owner)).toBe("reused");
    expect(request.mock.calls.map(([method]) => method)).toEqual(["GET", "POST", "GET"]);
  });

  it("fails on authorization errors without generating or replacing a Secret", async () => {
    const request = vi.fn().mockResolvedValue({ status: 403 });
    await expect(ensureSecret(request, "namespace", "release", spec, owner)).rejects.toThrow("HTTP 403");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("refuses incomplete or mismatched existing keys instead of rotating them", async () => {
    const keys = secretData(spec);
    for (const data of [{}, encode({ ...keys, [spec.publicKey]: secretData(spec)[spec.publicKey] })]) {
      const request = vi.fn().mockResolvedValue({ status: 200, body: { data } });
      await expect(ensureSecret(request, "namespace", "release", spec, owner)).rejects.toThrow(/refusing to replace/);
      expect(request).toHaveBeenCalledTimes(1);
    }
  });

  it("attaches the stable owner to legacy release Secrets without changing credentials", async () => {
    const secret = { metadata: { resourceVersion: "7", labels: { "app.kubernetes.io/managed-by": "tali-guard-bootstrap", "tasklattice.io/release": "release" } }, data: encode(secretData(spec)) };
    const request = vi.fn().mockResolvedValueOnce({ status: 200, body: secret }).mockResolvedValueOnce({ status: 200 });
    expect(await ensureSecret(request, "namespace", "release", spec, owner)).toBe("reused");
    expect(request.mock.calls[1]).toEqual(["PATCH", "/api/v1/namespaces/namespace/secrets/signing", { metadata: { resourceVersion: "7", ownerReferences: [owner], annotations: { "helm.sh/resource-policy": "keep", "argocd.argoproj.io/compare-options": "IgnoreExtraneous", "argocd.argoproj.io/sync-options": "Prune=false,Delete=false" } } }]);
  });

  it("never takes over another owner's Secret", async () => {
    for (const metadata of [{}, { ownerReferences: [{ ...owner, uid: "another-uid" }] }]) {
      const request = vi.fn().mockResolvedValue({ status: 200, body: { metadata, data: encode(secretData(spec)) } });
      await expect(ensureSecret(request, "namespace", "release", spec, owner)).rejects.toThrow("another owner");
      expect(request).toHaveBeenCalledOnce();
    }
  });

  it("reads only the installation Namespace UID for ownership", async () => {
    const request = vi.fn().mockResolvedValue({ status: 200, body: { metadata: { name: "namespace", uid: owner.uid } } });
    expect(await namespaceOwner(request, "namespace")).toEqual(owner);
    expect(request).toHaveBeenCalledWith("GET", "/api/v1/namespaces/namespace");
    for (const response of [{ status: 403 }, { status: 200, body: { metadata: { name: "namespace", uid: owner.uid, deletionTimestamp: "2026-01-01" } } }]) {
      await expect(namespaceOwner(vi.fn().mockResolvedValue(response), "namespace")).rejects.toThrow();
    }
  });

  it("migrates this release's old ConfigMap ownership without touching data", async () => {
    const secret = { metadata: { ...metadata, resourceVersion: "8", ownerReferences: [{ apiVersion: "v1", kind: "ConfigMap", name: "controller-config", uid: "old-owner" }] }, data: encode(secretData(spec)) };
    const request = vi.fn().mockResolvedValueOnce({ status: 200, body: secret }).mockResolvedValueOnce({ status: 200 });
    expect(await ensureSecret(request, "namespace", "release", spec, owner, "controller-config")).toBe("reused");
    const patch = request.mock.calls[1][2];
    expect(patch.metadata.ownerReferences).toEqual([owner]);
    expect(patch).not.toHaveProperty("data");
    expect(patch).not.toHaveProperty("stringData");
  });
});
