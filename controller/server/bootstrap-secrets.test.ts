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

function clusterFixture(initial: Record<string, any> = {}) {
  const stored = new Map(Object.entries(initial));
  const request = vi.fn(async (method: string, path: string, body?: any) => {
    const name = decodeURIComponent(path.split("/").at(-1)!);
    if (method === "GET") return stored.has(name) ? { status: 200, body: stored.get(name) } : { status: 404 };
    if (method === "PATCH") {
      const secret = stored.get(name);
      const data = { ...secret.data, ...body.data };
      for (const [key, value] of Object.entries(data)) if (value === null) delete data[key];
      stored.set(name, { ...secret, metadata: { ...secret.metadata, ...body.metadata }, data });
      return { status: 200 };
    }
    if (method !== "POST") throw new Error(`Unexpected mutation ${method}`);
    if (stored.has(body.metadata.name)) return { status: 409 };
    stored.set(body.metadata.name, { metadata: body.metadata, data: encode(body.stringData) });
    return { status: 201 };
  });
  return { stored, request };
}
const dbSpec = { name: "db-init", legacyName: "db", kind: "database", host: "postgres", username: "guard", database: "guard" };
const legacyMetadata = { annotations: { "meta.helm.sh/release-name": "release", "meta.helm.sh/release-namespace": "namespace" } };

describe("database, account and gateway bootstrap", () => {
  it("creates matching database fields once and preserves them on retry", async () => {
    const { stored, request } = clusterFixture();
    expect(await ensureSecret(request, "namespace", "release", dbSpec, owner)).toBe("created");
    const original = stored.get(dbSpec.name);
    const value = Buffer.from(original.data["postgres-password"], "base64").toString();
    expect(value).toMatch(/^[a-f0-9]{64}$/);
    expect(original.data.POSTGRES_PASSWORD).toBe(original.data["postgres-password"]);
    expect(Buffer.from(original.data["database-url"], "base64").toString()).toBe(`postgresql://guard:${value}@postgres:5432/guard`);
    expect(await ensureSecret(request, "namespace", "release", dbSpec, owner)).toBe("reused");
    expect(stored.get(dbSpec.name)).toBe(original);
    expect(request.mock.calls.filter(([method]) => method === "POST")).toHaveLength(1);
  });
  it("copies legacy data to a distinct name without modifying the original", async () => {
    const legacy = { metadata: legacyMetadata, data: encode({ "postgres-password": "legacy", "database-url": "postgresql://guard:legacy@postgres:5432/guard" }) };
    const { stored, request } = clusterFixture({ db: legacy });
    await ensureSecret(request, "namespace", "release", dbSpec, owner);
    expect(stored.get("db")).toBe(legacy);
    expect(stored.get("db-init").data["postgres-password"]).toBe(legacy.data["postgres-password"]);
    expect(stored.get("db-init").data["database-url"]).toBe(legacy.data["database-url"]);
    expect(stored.get("db-init").metadata.ownerReferences).toEqual([owner]);
    expect(request.mock.calls.every(([method]) => ["GET", "POST"].includes(method))).toBe(true);
  });
  it("refuses foreign, incomplete and inconsistent legacy data without creating a replacement", async () => {
    for (const legacy of [
      { metadata: {}, data: encode({ "postgres-password": "key" }) },
      { metadata: legacyMetadata, data: {} },
      { metadata: legacyMetadata, data: encode({ "postgres-password": "key", "database-url": "postgresql://guard:other@postgres:5432/guard" }) },
    ]) {
      const { stored, request } = clusterFixture({ db: legacy });
      await expect(ensureSecret(request, "namespace", "release", dbSpec, owner)).rejects.toThrow();
      expect(stored.has("db-init")).toBe(false);
      expect(request.mock.calls.every(([method]) => method === "GET")).toBe(true);
    }
  });
  it("creates debuggable username/password account data without hash import", async () => {
    const data = await secretData({ kind: "account", username: "admin", displayName: "Admin" });
    expect(data).toMatchObject({ username: "admin", name: "Admin", password: "password" });
    expect(data.revision).toMatch(/^[a-f0-9-]{36}$/);
  });
  it("migrates the LiteLLM database and gateway together and retains their keys", async () => {
    const database = { ...dbSpec, profile: "litellm" };
    const url = "postgresql://guard:legacy@postgres:5432/guard";
    const gateway = { name: "gateway-init", legacyName: "gateway", kind: "litellm", username: "admin", databaseSecret: "db-init" };
    const data = { "master-key": "sk-legacy", "salt-key": "legacy-salt", "ui-username": "admin", "ui-password": "legacy-ui", "database-url": url };
    const { stored, request } = clusterFixture({ db: { metadata: legacyMetadata, data: encode({ password: "legacy" }) }, gateway: { metadata: legacyMetadata, data: encode(data) } });
    await ensureSecret(request, "namespace", "release", database, owner);
    await ensureSecret(request, "namespace", "release", gateway, owner);
    const original = stored.get(gateway.name);
    for (const [key, value] of Object.entries(data)) expect(original.data[key]).toBe(Buffer.from(value).toString("base64"));
    expect(original.data.UI_PASSWORD).toBe(original.data["ui-password"]);
    expect(await ensureSecret(request, "namespace", "release", gateway, owner)).toBe("reused");
    expect(stored.get(gateway.name)).toBe(original);
  });
  it("generates a new gateway against its initialized database", async () => {
    const { stored, request } = clusterFixture();
    await ensureSecret(request, "namespace", "release", dbSpec, owner);
    await ensureSecret(request, "namespace", "release", { name: "gateway-init", kind: "litellm", username: "admin", databaseSecret: "db-init" }, owner);
    const gateway = stored.get("gateway-init").data;
    expect(gateway["database-url"]).toBe(stored.get("db-init").data["database-url"]);
    expect(gateway.UI_PASSWORD).toBe(gateway["ui-password"]);
    expect(Buffer.from(gateway["master-key"], "base64").toString()).toMatch(/^sk-[a-f0-9]{64}$/);
  });
});

it("overwrites old account Secrets on every initialization and removes hash fields", async () => {
  const spec = { name: "account-init", legacyName: "account", kind: "account", username: "admin", displayName: "Admin" };
  const legacy = { metadata: legacyMetadata, data: encode({ email: "old@example.com", "password-hash": "old-hash" }) };
  const { stored, request } = clusterFixture({ account: legacy });
  expect(await ensureSecret(request, "namespace", "release", spec, owner)).toBe("created");
  expect(stored.get("account-init").data).toEqual({ ...encode({ username: "admin", name: "Admin", password: "password" }), revision: expect.any(String) });
  const revision = stored.get("account-init").data.revision;
  stored.get("account-init").data = encode({ email: "old@example.com", "password-hash": "old-hash", password: "different" });
  expect(await ensureSecret(request, "namespace", "release", spec, owner)).toBe("updated");
  expect(stored.get("account-init").data).toEqual({ ...encode({ username: "admin", name: "Admin", password: "password" }), revision: expect.any(String) });
  expect(stored.get("account-init").data.revision).not.toBe(revision);
  expect(stored.get("account")).toBe(legacy);
});

it("does not overwrite an account Secret belonging to another release", async () => {
  const spec = { name: "account-init", kind: "account", username: "admin", displayName: "Admin" };
  const { request } = clusterFixture({ "account-init": { metadata: {}, data: {} } });
  await expect(ensureSecret(request, "namespace", "release", spec, owner)).rejects.toThrow("another owner");
  expect(request.mock.calls.every(([method]) => method === "GET")).toBe(true);
});

it("refuses to reuse a gateway when its database credentials differ", async () => {
  const { stored, request } = clusterFixture();
  await ensureSecret(request, "namespace", "release", dbSpec, owner);
  const spec = { name: "gateway-init", kind: "litellm", username: "admin", databaseSecret: "db-init" };
  await ensureSecret(request, "namespace", "release", spec, owner);
  stored.get("db-init").data["database-url"] = Buffer.from("different").toString("base64");
  await expect(ensureSecret(request, "namespace", "release", spec, owner)).rejects.toThrow("no longer matches");
});
