import { z } from "zod";

/** Operator-supplied examples for a versioned policy in the external proof service. */
export const formalValidationSchema = z.object({
  policyId: z.string().trim().min(1).max(256),
  policyVersion: z.string().trim().min(1).max(100),
  confidenceThreshold: z.number().min(0).max(1).default(0.8),
  query: z.string().trim().min(1).max(10_000),
  validResponse: z.string().trim().min(1).max(10_000),
  invalidResponse: z.string().trim().min(1).max(10_000),
}).strict().refine(value => value.validResponse !== value.invalidResponse, "Provide distinct valid and invalid examples.");
export type FormalValidation = z.infer<typeof formalValidationSchema>;
