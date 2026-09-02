import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";

function key(rootSecret: string): Buffer {
  return createHash("sha256")
    .update("tasklattice:guard:model-provider-credentials:v1\0", "utf8")
    .update(rootSecret, "utf8")
    .digest();
}

export function encryptModelCredential(value: string, rootSecret: string): string {
  if (!value) return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key(rootSecret), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [
    VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

export function decryptModelCredential(value: string, rootSecret: string): string {
  if (!value) return "";
  const [version, encodedIv, encodedTag, encodedCiphertext, ...rest] = value.split(":");
  if (version !== VERSION || !encodedIv || !encodedTag || encodedCiphertext === undefined || rest.length) {
    throw new Error("The stored model Provider credential has an unsupported format.");
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key(rootSecret), Buffer.from(encodedIv, "base64url"));
    decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encodedCiphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("The stored model Provider credential cannot be decrypted with the active deployment key.");
  }
}

export function credentialHint(value: string): string {
  if (!value) return "Not required";
  if (value.length < 10) return "Stored credential";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
