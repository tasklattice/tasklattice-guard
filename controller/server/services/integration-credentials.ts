import { createHash, randomBytes, randomUUID } from "node:crypto";

export type StoredIntegrationCredential = {
  id: string;
  sha256: string;
  keyHint: string;
  createdAt: string;
  revokedAt: string | null;
};

export type PublicIntegrationCredential = Pick<StoredIntegrationCredential, "id" | "keyHint" | "createdAt">;

export type IssuedIntegrationCredential = {
  value: string;
  stored: StoredIntegrationCredential;
  publicCredential: PublicIntegrationCredential;
};

export type StoredIntegrationVerification = {
  credentials: StoredIntegrationCredential[];
};

export function issueIntegrationCredential(now = new Date()): IssuedIntegrationCredential {
  const value = `tg_${randomBytes(32).toString("base64url")}`;
  const stored = {
    id: randomUUID(),
    sha256: createHash("sha256").update(value).digest("hex"),
    keyHint: credentialHint(value),
    createdAt: now.toISOString(),
    revokedAt: null,
  } satisfies StoredIntegrationCredential;
  return {
    value,
    stored,
    publicCredential: toPublicCredential(stored),
  };
}

export function activeIntegrationCredentials(
  verification: unknown,
): StoredIntegrationCredential[] {
  return structuredCredentials(verification)
    .filter((credential) => credential.revokedAt === null)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function publicIntegrationCredentials(
  verification: unknown,
): PublicIntegrationCredential[] {
  return activeIntegrationCredentials(verification).map(toPublicCredential);
}

export function appendIntegrationCredential(
  verification: unknown,
  credential: StoredIntegrationCredential,
): StoredIntegrationVerification {
  const structured = structuredCredentials(verification);
  return { credentials: [...structured, credential] };
}

export function revokeIntegrationCredential(
  verification: unknown,
  credentialId: string,
  now: Date,
): StoredIntegrationVerification | null {
  let found = false;
  const credentials = structuredCredentials(verification).map((credential) => {
    if (credential.id !== credentialId || credential.revokedAt !== null) return credential;
    found = true;
    return { ...credential, revokedAt: now.toISOString() };
  });
  return found ? { credentials } : null;
}

function structuredCredentials(verification: unknown): StoredIntegrationCredential[] {
  if (!isRecord(verification) || !Array.isArray(verification.credentials)) return [];
  return verification.credentials.flatMap((value) => {
    if (!isRecord(value)) return [];
    const id = nonEmptyString(value.id);
    const sha256 = nonEmptyString(value.sha256);
    const keyHint = nonEmptyString(value.keyHint);
    const createdAt = nonEmptyString(value.createdAt);
    if (!id || !sha256 || !keyHint || !createdAt) return [];
    const revokedAt = value.revokedAt === null || value.revokedAt === undefined
      ? null
      : nonEmptyString(value.revokedAt);
    if (value.revokedAt !== null && value.revokedAt !== undefined && !revokedAt) return [];
    return [{ id, sha256, keyHint, createdAt, revokedAt }];
  });
}

function toPublicCredential(credential: StoredIntegrationCredential): PublicIntegrationCredential {
  return {
    id: credential.id,
    keyHint: credential.keyHint,
    createdAt: credential.createdAt,
  };
}

function credentialHint(value: string): string {
  return `${value.slice(0, 7)}…${value.slice(-4)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
