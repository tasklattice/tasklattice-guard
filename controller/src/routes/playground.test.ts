import { describe, expect, it } from "vitest";

import type { GuardrailVersion } from "@/lib/api";

import { resolvePublishedVersion } from "./playground";

function version(day: number): GuardrailVersion {
  const id = `202608${String(10 + day).padStart(2, "0")}-080000.000Z`;
  return {
    guardrail_id: "guardrail-1",
    version: id,
    source_draft_version: day,
    compiler_version: "nemo-native-v1",
    plan_checksum: `plan-${day}`,
    created_at: `2026-08-${String(10 + day).padStart(2, "0")}T08:00:00Z`,
    active: day === 3,
    runtime_engine: "llmrails",
    config_checksum: `config-${day}`,
    execution_mode: "nemo_only",
  };
}

describe("resolvePublishedVersion", () => {
  const versions = [version(2), version(3), version(1)];

  it("defaults to the latest published version", () => {
    expect(resolvePublishedVersion(versions, "")).toBe(versions[1].version);
  });

  it("preserves an explicitly selected historical published version", () => {
    expect(resolvePublishedVersion(versions, versions[2].version)).toBe(versions[2].version);
  });

  it("does not invent a version when nothing has been published", () => {
    expect(resolvePublishedVersion([], "20260814-080000.000Z")).toBe("");
  });
});
