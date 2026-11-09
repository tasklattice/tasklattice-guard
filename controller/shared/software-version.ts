import { z } from "zod";

export const softwareVersionSchema = z.object({
  version: z.string(),
  commit: z.string().nullable(),
  branch: z.string().nullable(),
  dirty: z.boolean().nullable(),
  source: z.enum(["workspace", "build", "unknown"]),
});
export type SoftwareVersion = z.infer<typeof softwareVersionSchema>;
export const unknownSoftwareVersion = (version = "unknown"): SoftwareVersion => ({ version, commit: null, branch: null, dirty: null, source: "unknown" });
export function parseSoftwareVersion(value: string | undefined, fallback = "unknown"): SoftwareVersion {
  try {
    const result = softwareVersionSchema.safeParse(JSON.parse(value ?? ""));
    if (result.success) return result.data;
  } catch { /* Older images may not carry Git metadata. */ }
  return unknownSoftwareVersion(fallback);
}
