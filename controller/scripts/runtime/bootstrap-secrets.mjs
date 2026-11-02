import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import https from "node:https";
import { generateTls, tlsFields, validateTls } from "./bootstrap-tls.mjs";

export function secretData(spec) {
  if (spec.kind === "account") return accountData(spec);
  if (spec.kind === "database") {
    const value = randomBytes(32).toString("hex");
    return { [databaseKey(spec)]: value, POSTGRES_PASSWORD: value,
      [spec.urlKey ?? "database-url"]: databaseUrl(spec, value) };
  }
  if (spec.kind === "litellm") return {
    "master-key": `sk-${randomBytes(32).toString("hex")}`,
    "salt-key": randomBytes(32).toString("hex"),
    "ui-username": spec.username,
    "ui-password": randomBytes(32).toString("hex"),
  };
  if (spec.kind === "mtls") return generateTls(spec);
  if (spec.kind === "ed25519") {
    const pair = generateKeyPairSync("ed25519", {
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    return { [spec.privateKey]: pair.privateKey, [spec.publicKey]: pair.publicKey };
  }
  if (!["tokens", "encryption"].includes(spec.kind)) throw new Error("Unsupported bootstrap Secret type.");
  return Object.fromEntries(spec.keys.map(key => [key, randomBytes(32).toString(spec.kind === "tokens" ? "hex" : "base64")]));
}

const databaseKey = spec => spec.credentialKey || (spec.profile === "litellm" ? "password" : "postgres-password");
const databaseUrl = (spec, value) => `postgresql://${encodeURIComponent(spec.username)}:${encodeURIComponent(value)}@${spec.host}:5432/${encodeURIComponent(spec.database)}`;
const decodeData = secret => Object.fromEntries(Object.entries(secret.data ?? {}).map(([key, value]) => [key, Buffer.from(value, "base64").toString("utf8")]));

function accountData(spec) {
  return { [spec.usernameKey || "username"]: spec.username,
    [spec.nameKey || "name"]: spec.displayName,
    [spec.credentialKey || "password"]: "password", revision: randomUUID() };
}

function validateExisting(spec, secret) {
  const data = decodeData(secret);
  if (spec.kind === "database") {
    const value = data[databaseKey(spec)];
    let matches = false;
    try {
      const url = new URL(data[spec.urlKey ?? "database-url"]);
      matches = url.protocol === "postgresql:" && decodeURIComponent(url.username) === spec.username && decodeURIComponent(url.password) === value &&
        url.hostname === spec.host && url.port === "5432" && decodeURIComponent(url.pathname.slice(1)) === spec.database && !url.search && !url.hash;
    } catch { /* Invalid database URLs must never trigger credential replacement. */ }
    if (!value || data.POSTGRES_PASSWORD !== value || !matches) {
      throw new Error(`Secret ${spec.name} has inconsistent database fields; refusing to replace it.`);
    }
    return;
  }
  if (spec.kind === "account") {
    if (!data[spec.usernameKey || "username"] || !data[spec.nameKey || "name"] || !data[spec.credentialKey || "password"]) {
      throw new Error(`Secret ${spec.name} has invalid account fields.`);
    }
    return;
  }
  if (spec.kind === "litellm") {
    if (["master-key", "salt-key", "ui-username", "ui-password", "database-url", "UI_PASSWORD"].some(key => !data[key]) || data.UI_PASSWORD !== data["ui-password"]) {
      throw new Error(`Secret ${spec.name} has invalid gateway fields; refusing to replace it.`);
    }
    return;
  }
  const fields = spec.kind === "mtls" ? tlsFields(spec).filter(key => key !== (spec.caPrivateKeyKey ?? "ca.key") || secret.data?.[key]) : spec.kind === "ed25519" ? [spec.privateKey, spec.publicKey] : spec.keys;
  if (fields.some(key => !secret.data?.[key])) throw new Error(`Secret ${spec.name} is missing required fields; refusing to replace it.`);
  if (spec.kind === "mtls") validateTls(spec, Object.fromEntries(fields.map(key => [key, Buffer.from(secret.data[key], "base64").toString("utf8")])));
  if (spec.kind === "ed25519") {
    try {
      const privateKey = createPrivateKey(Buffer.from(secret.data[spec.privateKey], "base64"));
      const publicKey = createPublicKey(Buffer.from(secret.data[spec.publicKey], "base64"));
      if (privateKey.asymmetricKeyType !== "ed25519" || publicKey.asymmetricKeyType !== "ed25519" ||
          !createPublicKey(privateKey).export({ type: "spki", format: "der" }).equals(publicKey.export({ type: "spki", format: "der" }))) {
        throw new Error("Invalid key pair");
      }
    } catch {
      throw new Error(`Secret ${spec.name} does not contain a matching Ed25519 key pair; refusing to replace it.`);
    }
  }
}

function belongsToRelease(metadata, namespace, release) {
  const annotations = metadata?.annotations ?? {};
  const labels = metadata?.labels ?? {};
  return (annotations["meta.helm.sh/release-name"] === release && annotations["meta.helm.sh/release-namespace"] === namespace)
    || (labels["app.kubernetes.io/managed-by"] === "tali-guard-bootstrap" && (labels["tasklattice.io/release"] ?? labels["app.kubernetes.io/instance"]) === release);
}

export async function namespaceOwner(request, namespace) {
  const response = await request("GET", `/api/v1/namespaces/${encodeURIComponent(namespace)}`);
  if (response.status !== 200) throw new Error(`Cannot read credential Namespace owner: HTTP ${response.status}.`);
  if (response.body?.metadata?.name !== namespace || !response.body.metadata.uid || response.body.metadata.deletionTimestamp) throw new Error("Credential Namespace is missing or deleting.");
  return { apiVersion: "v1", kind: "Namespace", name: namespace, uid: response.body.metadata.uid, controller: false, blockOwnerDeletion: false };
}

async function reuseSecret(request, path, namespace, release, spec, secret, owner) {
  if (spec.kind !== "account") validateExisting(spec, secret);
  if (spec.kind === "litellm") {
    const database = await request("GET", `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets/${encodeURIComponent(spec.databaseSecret)}`);
    if (database.status !== 200 || database.body.data?.["database-url"] !== secret.data["database-url"]) {
      throw new Error(`Secret ${spec.name} no longer matches its database; refusing to replace it.`);
    }
  }
  const references = secret.metadata?.ownerReferences ?? [];
  const owned = references.length === 1 && references[0].uid === owner.uid && references[0].name === owner.name && references[0].kind === owner.kind && references[0].apiVersion === owner.apiVersion;
  if (!belongsToRelease(secret.metadata, namespace, release) || (references.length && !owned)) {
    throw new Error(`Secret ${spec.name} belongs to another owner; use existingSecret instead of adopting it.`);
  }
  if (spec.kind === "account") {
    const data = accountData(spec);
    const patched = await request("PATCH", path, {
      metadata: { resourceVersion: secret.metadata.resourceVersion, ownerReferences: [owner],
        annotations: { "helm.sh/resource-policy": "keep", "argocd.argoproj.io/compare-options": "IgnoreExtraneous", "argocd.argoproj.io/sync-options": "Prune=false,Delete=false" } },
      // JSON merge patch removes former email/hash fields as well as custom keys.
      data: Object.fromEntries([...Object.keys(secret.data ?? {}).map(key => [key, null]),
        ...Object.entries(data).map(([key, value]) => [key, Buffer.from(value).toString("base64")])]),
    });
    if (patched.status !== 200) throw new Error(`Cannot reset account Secret ${spec.name}: HTTP ${patched.status}. Retry initialization.`);
    return "updated";
  }
  if (owned && secret.metadata.annotations?.["helm.sh/resource-policy"] === "keep") return "reused";
  const patched = await request("PATCH", path, { metadata: { resourceVersion: secret.metadata.resourceVersion, ownerReferences: [owner], annotations: { "helm.sh/resource-policy": "keep", "argocd.argoproj.io/compare-options": "IgnoreExtraneous", "argocd.argoproj.io/sync-options": "Prune=false,Delete=false" } } });
  if (patched.status !== 200) throw new Error(`Cannot attach owner to Secret ${spec.name}: HTTP ${patched.status}. Retry initialization; key data was not changed.`);
  return "reused";
}

export async function ensureSecret(request, namespace, release, spec, owner) {
  if (!owner?.uid || owner.kind !== "Namespace" || owner.apiVersion !== "v1" || owner.name !== namespace) throw new Error("The installation Namespace owner is required.");
  const path = `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets`;
  const itemPath = `${path}/${encodeURIComponent(spec.name)}`;
  const existing = await request("GET", itemPath);
  if (existing.status === 200) {
    return reuseSecret(request, itemPath, namespace, release, spec, existing.body, owner);
  }
  if (existing.status !== 404) throw new Error(`Cannot read Secret ${spec.name}: HTTP ${existing.status}.`);
  const data = await secretData(spec);
  if (spec.kind === "litellm") {
    const database = await request("GET", `${path}/${encodeURIComponent(spec.databaseSecret)}`);
    if (database.status !== 200) throw new Error(`Cannot read gateway database Secret: HTTP ${database.status}.`);
    const url = decodeData(database.body)["database-url"];
    if (!url || (data["database-url"] && data["database-url"] !== url)) throw new Error("Gateway database credentials do not match; refusing to replace them.");
    data["database-url"] = url;
    data.UI_PASSWORD = data["ui-password"];
  }
  if (Object.values(data).some(value => typeof value !== "string" || !value)) throw new Error(`Secret ${spec.name} has missing fields; refusing to create it.`);
  validateExisting(spec, { data: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, Buffer.from(value).toString("base64")])) });
  const created = await request("POST", path, {
    apiVersion: "v1", kind: "Secret", type: "Opaque",
    metadata: { name: spec.name, namespace, ownerReferences: [owner],
      annotations: {
        "helm.sh/resource-policy": "keep",
        "argocd.argoproj.io/compare-options": "IgnoreExtraneous",
        "argocd.argoproj.io/sync-options": "Prune=false,Delete=false",
      }, labels: {
      "tasklattice.io/release": release,
      "app.kubernetes.io/managed-by": "tali-guard-bootstrap",
      "app.kubernetes.io/part-of": "tasklattice-guard",
    } },
    stringData: data,
  });
  if (created.status === 409) {
    // Another bootstrap won the race. Validate its value, never overwrite it.
    const concurrent = await request("GET", `${path}/${encodeURIComponent(spec.name)}`);
    if (concurrent.status !== 200) throw new Error(`Cannot read concurrent Secret ${spec.name}: HTTP ${concurrent.status}.`);
    return reuseSecret(request, itemPath, namespace, release, spec, concurrent.body, owner);
  }
  if (created.status !== 201) throw new Error(`Cannot create Secret ${spec.name}: HTTP ${created.status}.`);
  return "created";
}

async function main() {
  const credentials = "/var/run/secrets/kubernetes.io/serviceaccount";
  const ca = readFileSync(`${credentials}/ca.crt`);
  const token = readFileSync(`${credentials}/token`, "utf8").trim();
  const request = (method, path, body) => new Promise((resolve, reject) => {
    const req = https.request({
      hostname: process.env.KUBERNETES_SERVICE_HOST,
      port: Number(process.env.KUBERNETES_SERVICE_PORT_HTTPS || 443),
      method, path, ca, timeout: 15_000,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": method === "PATCH" ? "application/merge-patch+json" : "application/json" },
    }, res => {
      let content = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { content += chunk; });
      res.on("error", () => reject(new Error("Kubernetes API response failed.")));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: content ? JSON.parse(content) : {} }); }
        catch { reject(new Error("Invalid Kubernetes API response.")); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("Kubernetes API request timed out.")));
    req.on("error", () => reject(new Error("Kubernetes API request failed.")));
    req.end(body ? JSON.stringify(body) : undefined);
  });
  const owner = await namespaceOwner(request, process.env.BOOTSTRAP_NAMESPACE);
  for (const spec of JSON.parse(process.env.BOOTSTRAP_SECRETS)) {
    const result = await ensureSecret(request, process.env.BOOTSTRAP_NAMESPACE, process.env.BOOTSTRAP_RELEASE, spec, owner);
    console.log(`Secret ${spec.name}: ${result}`);
  }
}

if (process.env.BOOTSTRAP_SECRETS) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
