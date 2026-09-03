import { describe, expect, it } from "vitest";

import { credentialHint, decryptModelCredential, encryptModelCredential } from "./secret-crypto.js";

describe("Model credential encryption", () => {
  const rootSecret = "controller-root-secret-with-more-than-thirty-two-characters";

  it("round-trips without embedding the plaintext", () => {
    const credential = "sk-model-provider-super-secret";
    const ciphertext = encryptModelCredential(credential, rootSecret);
    expect(ciphertext).not.toContain(credential);
    expect(decryptModelCredential(ciphertext, rootSecret)).toBe(credential);
    expect(credentialHint(credential)).toBe("sk-m…cret");
  });

  it("rejects a modified encrypted value", () => {
    const ciphertext = encryptModelCredential("secret", rootSecret);
    expect(() => decryptModelCredential(`${ciphertext.slice(0, -2)}xx`, rootSecret)).toThrow();
  });
});
