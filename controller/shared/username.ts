import { z } from "zod";

export const usernamePattern = /^[a-z0-9_.-]{3,64}$/;
export const normalizeUsername = (value: string) => value.trim().toLowerCase();
export const usernameSchema = z.string().transform(normalizeUsername).pipe(
  z.string().regex(usernamePattern, "Use 3–64 letters, digits, dots, underscores or hyphens."),
);

export function parseUsername(value: string): string {
  const result = usernameSchema.safeParse(value);
  if (!result.success) throw new Error("Use a username of 3–64 letters, digits, dots, underscores or hyphens.");
  return result.data;
}

// Better Auth requires an email in its core user model. This internal value is
// never used to sign in, send mail, or resolve usernames during authentication.
export const internalAccountEmail = (username: string) => `${username}@users.guard.invalid`;
