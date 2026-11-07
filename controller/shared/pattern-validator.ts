import { z } from "zod";

const characters = z.string().min(2).max(128)
  .regex(/^[!-~]+$/)
  .refine(value => value === value.toUpperCase(), "Checksum characters must be uppercase ASCII");

/** Technical candidate checks. Business identity and format remain in the Rule. */
export const patternValidatorSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("date"),
    start: z.number().int().nonnegative().default(0),
    format: z.literal("YYYYMMDD").default("YYYYMMDD"),
  }),
  z.strictObject({
    type: z.literal("weighted_checksum"),
    alphabet: characters.refine(value => new Set(value).size === value.length, "Checksum alphabet must contain unique characters"),
    weights: z.array(z.number().int().min(0).max(1_000_000_000)).min(1).max(256),
    check_characters: characters,
  }),
  z.strictObject({
    type: z.literal("modulus_checksum"),
    weights: z.array(z.number().int().min(0).max(1_000_000_000)).min(1).max(256),
    modulus: z.number().int().min(2).max(1_000_000),
    offset: z.number().int().min(-1_000_000_000).max(1_000_000_000).default(0),
  }),
  z.strictObject({ type: z.literal("luhn") }),
]);

export type PatternValidator = z.output<typeof patternValidatorSchema>;
