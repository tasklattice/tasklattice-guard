import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { ControllerConfig } from "../config.js";
import { ControllerError } from "../domain/errors.js";
import type { PackageSignature } from "../domain/guardrail-package.js";

/**
 * Trusted package sources are deployment configuration, mounted read-only
 * and changed through the customer's change process. A public key shipped
 * inside a package is never trusted.
 */
const trustSchema = z.object({
  sources: z.array(z.object({
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(120),
    keys: z.array(z.object({ id: z.string().min(1).max(120), publicKeyPem: z.string().min(1) }).strict()).min(1),
    // Reserved system resources (such as the Default Guardrail) a source may supply.
    reservedGuardrailIds: z.array(z.string().min(1)).default([]),
  }).strict()),
}).strict();
export type TrustedSource = z.output<typeof trustSchema>["sources"][number];

export function loadPackageTrust(path: string | null): TrustedSource[] {
  if (!path) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ControllerError(`The package trust file ${path} cannot be read: ${(error as Error).message}`, 503, "package_trust_unavailable");
  }
  const parsed = trustSchema.safeParse(raw);
  if (!parsed.success) throw new ControllerError(`The package trust file ${path} is invalid.`, 503, "package_trust_unavailable", { issues: parsed.error.issues.slice(0, 5) });
  return parsed.data.sources;
}

/** Return the trusted key that signed the manifest, or reject the package. */
export function verifyPackageSignatures(sources: TrustedSource[], sourceId: string, manifest: Buffer, signatures: PackageSignature[]) {
  const source = sources.find(item => item.id === sourceId);
  if (!source) throw new ControllerError(`Packages from source ${sourceId} are not trusted in this environment.`, 422, "guardrail_package_untrusted", { sourceId });
  for (const signature of signatures) {
    const key = source.keys.find(item => item.id === signature.keyId);
    if (!key) continue;
    try {
      if (verify(null, manifest, createPublicKey(key.publicKeyPem), Buffer.from(signature.signature, "base64"))) return { source, signature };
    } catch {
      // A malformed signature is simply not a valid one.
    }
  }
  throw new ControllerError(`No signature on this package verifies with a trusted key for source ${sourceId}.`, 422, "guardrail_package_untrusted", { sourceId, keyIds: signatures.map(item => item.keyId) });
}

export type PackageSigner = {
  sourceId: string;
  sourceName: string;
  keyId: string;
  sign: (manifest: Buffer) => PackageSignature[];
};

export function packageSigner(config: ControllerConfig): PackageSigner {
  const exported = config.packageExport;
  if (!exported) throw new ControllerError("Package export is not configured. Set CONTROLLER_PACKAGE_SOURCE_ID and CONTROLLER_PACKAGE_SIGNING_KEY_PATH.", 503, "package_export_unavailable");
  const privateKey = createPrivateKey(readFileSync(exported.signingKeyPath));
  const keyId = exported.signingKeyId ?? packageKeyId(createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString());
  return {
    sourceId: exported.sourceId,
    sourceName: exported.sourceName,
    keyId,
    sign: manifest => [{ keyId, algorithm: "ed25519", signature: sign(null, manifest, privateKey).toString("base64") }],
  };
}

/** Stable key ID derived from a public key, for operators who do not set one. */
export function packageKeyId(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return `ed25519:${createHash("sha256").update(der).digest("hex").slice(0, 16)}`;
}
