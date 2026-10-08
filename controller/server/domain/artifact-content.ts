import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalJson } from "../../shared/canonical-json.js";

/**
 * Version 2 digests exclude the local delivery envelope (`id`, `generation`)
 * and use the cross-language canonical JSON encoding. The same promoted
 * content therefore keeps one digest in UAT and production.
 */
export const ARTIFACT_CONTENT_DIGEST_VERSION = 2;
export const ARTIFACT_CONTENT_CONTRACT = "tasklattice.artifact-content.v2";

/** Signed, environment-independent Artifact content. */
export type ArtifactContent = {
  guardrailId: string;
  guardrailVersion: string;
  compilerVersion: string;
  nemoVersion: string;
  runtimeProfile: string;
  plan: Record<string, unknown>;
  configYaml: string;
  colangContent: string;
  prompts: unknown[];
  actionBindings: unknown[];
  dependencyManifest: unknown[];
};

export function artifactContent(value: ArtifactContent): ArtifactContent {
  return {
    guardrailId: value.guardrailId,
    guardrailVersion: value.guardrailVersion,
    compilerVersion: value.compilerVersion,
    nemoVersion: value.nemoVersion,
    runtimeProfile: value.runtimeProfile,
    plan: value.plan,
    configYaml: value.configYaml,
    colangContent: value.colangContent,
    prompts: value.prompts,
    actionBindings: value.actionBindings,
    dependencyManifest: value.dependencyManifest,
  };
}

export function artifactContentDigest(value: ArtifactContent): string {
  return createHash("sha256").update(canonicalJson(artifactContent(value))).digest("hex");
}

/** Ed25519 signature over the hex digest, the form the Runner verifies. */
export function signArtifactDigest(digest: string, privateKeyPath: string): string {
  return sign(null, Buffer.from(digest, "utf8"), createPrivateKey(readFileSync(privateKeyPath))).toString("base64");
}

export function verifyArtifactDigest(digest: string, signature: string, publicKeyPem: string): boolean {
  return verify(null, Buffer.from(digest, "utf8"), createPublicKey(publicKeyPem), Buffer.from(signature, "base64"));
}
