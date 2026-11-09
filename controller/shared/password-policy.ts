import { z } from "zod";

export const PASSWORD_MAX_LENGTH = 128;
export const passwordPolicySchema = z.object({
  minLength: z.number().int().min(8).max(PASSWORD_MAX_LENGTH),
  maxLength: z.literal(PASSWORD_MAX_LENGTH),
});
export type PasswordPolicy = z.infer<typeof passwordPolicySchema>;
export const passwordMeetsPolicy = (password: string, policy: PasswordPolicy) =>
  password.length >= policy.minLength && password.length <= policy.maxLength;
