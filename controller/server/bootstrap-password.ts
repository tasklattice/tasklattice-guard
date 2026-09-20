// Better Auth's default scrypt encoding: 16-byte salt and 64-byte derived key,
// both encoded as lowercase hex. Use better-auth/crypto to generate this value.
export const bootstrapPasswordHashPattern = /^[0-9a-f]{32}:[0-9a-f]{128}$/;
