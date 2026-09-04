import { describe, expect, it } from "vitest";

import { guardrailVersionId, isGuardrailVersionId } from "../../shared/guardrail-version.js";

describe("Guardrail Version IDs", () => {
  it("uses one millisecond UTC timestamp for storage, APIs, and display", () => {
    expect(guardrailVersionId("2026-09-04T07:30:00.123Z")).toBe("20260904-073000.123Z");
  });

  it("sorts chronologically with ordinary string ordering", () => {
    const earlier = guardrailVersionId("2026-09-04T07:30:00.123Z");
    const later = guardrailVersionId("2026-09-04T07:30:00.124Z");

    expect(earlier < later).toBe(true);
  });

  it("rejects invalid timestamps", () => {
    expect(() => guardrailVersionId("not-a-timestamp")).toThrow("valid timestamp");
    expect(isGuardrailVersionId("20260904-073000.123Z")).toBe(true);
    expect(isGuardrailVersionId("20261304-073000.123Z")).toBe(false);
    expect(isGuardrailVersionId("3")).toBe(false);
  });
});
