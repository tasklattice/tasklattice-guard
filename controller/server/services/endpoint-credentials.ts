import { createHash, randomBytes, randomUUID } from "node:crypto";

export type StoredEndpointCredential = {
  id: string;
  sha256: string;
  keyHint: string;
  createdAt: string;
  revokedAt: string | null;
};

export type PublicEndpointCredential = Pick<StoredEndpointCredential, "id" | "keyHint" | "createdAt">;

export type IssuedEndpointCredential = {
  value: string;
  stored: StoredEndpointCredential;
  publicCredential: PublicEndpointCredential;
};

export type StoredEndpointVerification = {
  credentials: StoredEndpointCredential[];
};

export function issueEndpointCredential(now = new Date()): IssuedEndpointCredential {
  const value = `tg_${randomBytes(32).toString("base64url")}`;
  const stored = {
    id: randomUUID(),
    sha256: createHash("sha256").update(value).digest("hex"),
    keyHint: credentialHint(value),
    createdAt: now.toISOString(),
    revokedAt: null,
  } satisfies StoredEndpointCredential;
  return {
    value,
    stored,
    publicCredential: toPublicCredential(stored),
  };
}

export function activeEndpointCredentials(
  verification: unknown,
): StoredEndpointCredential[] {
  return structuredCredentials(verification)
    .filter((credential) => credential.revokedAt === null)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function publicEndpointCredentials(
  verification: unknown,
): PublicEndpointCredential[] {
  return activeEndpointCredentials(verification).map(toPublicCredential);
}

export function appendEndpointCredential(
  verification: unknown,
  credential: StoredEndpointCredential,
): StoredEndpointVerification {
  const structured = structuredCredentials(verification);
  return { credentials: [...structured, credential] };
}

export function revokeEndpointCredential(
  verification: unknown,
  credentialId: string,
  now: Date,
): StoredEndpointVerification | null {
  let found = false;
  const credentials = structuredCredentials(verification).map((credential) => {
    if (credential.id !== credentialId || credential.revokedAt !== null) return credential;
    found = true;
    return { ...credential, revokedAt: now.toISOString() };
  });
  return found ? { credentials } : null;
}

function structuredCredentials(verification: unknown): StoredEndpointCredential[] {
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

function toPublicCredential(credential: StoredEndpointCredential): PublicEndpointCredential {
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
