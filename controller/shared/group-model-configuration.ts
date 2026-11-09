import { z } from "zod";

const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const groupModelConfigurationInput = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("scoped"), expectedVersion: version, sourceRevisionId: z.string().uuid(), expectedSourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ mode: z.literal("blocked"), expectedVersion: version }).strict(),
  z.object({ mode: z.literal("platform"), expectedVersion: version }).strict(),
]);
export type GroupModelConfigurationMode = "platform" | "scoped" | "blocked";
export type GroupModelConfigurationView = {
  groupId: string; mode: GroupModelConfigurationMode; version: number; grantId: string | null;
  sourceRevisionId: string | null; sourceFingerprint: string | null; generation: number | null;
  modelIds: string[]; providerIds: string[]; updatedAt: string | null;
};
