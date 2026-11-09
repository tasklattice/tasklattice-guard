import { z } from "zod";

const text = z.object({ en: z.string().min(1), zh: z.string().min(1) }).strict();
const reference = z.object({
  title: z.string().min(1),
  url: z.string().url().refine(value => new URL(value).protocol === "https:", "References must use HTTPS"),
  publisher: z.string().min(1),
  provision: z.string().min(1),
  relevance: text,
  rule_ids: z.array(z.string().min(1)).min(1),
}).strict();

/** Documentation is embedded in the Policy asset/snapshot, never looked up by latest policy ID. */
export const policyComplianceSchema = z.object({
  policy_version: z.string().min(1),
  summary: text,
  jurisdiction: text,
  provenance: text,
  maintainer: z.string().min(1),
  upstream_status: text,
  license_status: text,
  references: z.array(reference),
  coverage: z.array(z.object({ rule_ids: z.array(z.string().min(1)).min(1), description: text }).strict()),
  limitations: z.array(text).min(1),
  review: z.object({
    status: z.enum(["pending", "reviewed"]),
    reviewed_on: z.iso.date().nullable(),
    reviewer: z.string().nullable(),
    notes: text,
  }).strict(),
}).strict().superRefine((value, ctx) => {
  if (value.review.status === "reviewed" && (!value.review.reviewed_on || !value.review.reviewer?.trim())) {
    ctx.addIssue({ code: "custom", path: ["review"], message: "Reviewed documentation needs a date and reviewer" });
  }
});
export type PolicyCompliance = z.infer<typeof policyComplianceSchema>;
