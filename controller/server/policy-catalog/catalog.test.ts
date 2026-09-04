import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { PolicyCatalog } from "./catalog.js";

const assetDirectory = resolve("../runner/toolkit/policy_library/assets");

describe("Policy catalog", () => {
  it("merges both canonical asset collections and applies focused overrides", () => {
    const catalog = PolicyCatalog.load(assetDirectory);
    const policies = catalog.list();

    expect(policies).toHaveLength(38);
    expect(new Set(policies.map((policy) => policy.id)).size).toBe(38);
    expect(catalog.get("competitor-mention-detection")).toMatchObject({
      name: "Competitor Name Blocking",
      implementation: "rules",
      source: "built_in",
    });
  });

  it("normalizes computed fields, Guardrail categories, and framework metadata", () => {
    const policy = PolicyCatalog.load(assetDirectory).get("pattern-matching");

    expect(policy).toBeDefined();
    expect(policy?.rails).toEqual(["input", "output"]);
    expect(policy?.effects).toEqual(["redact"]);
    expect(policy?.forms).toEqual(["regex"]);
    expect(policy?.test_count).toBe(policy?.test_cases.length);
    expect(policy?.tags).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "framework:owasp-llm-2025", label: "OWASP LLM 2025" }),
      expect.objectContaining({ id: "guardrail_category:pii_detection", label: "PII Detection" }),
    ]));
    expect(policy?.rules[0]).toMatchObject({
      context_max_gap_words: null,
      allow_word_numbers: false,
      identifiers: expect.any(Array),
      conditions: expect.any(Array),
    });
  });

  it("uses the reviewed Policy facets and canonical NeMo Rail terminology", () => {
    const tags = PolicyCatalog.load(assetDirectory).list().flatMap((policy) => policy.tags);
    const namespaces = new Set<string>(tags.map((tag) => tag.namespace));

    expect(namespaces.has("scope")).toBe(false);
    expect(namespaces.has("stage")).toBe(false);
    expect(namespaces.has("capability")).toBe(false);
    expect(namespaces.has("guardrail_category")).toBe(true);
    expect(namespaces.has("rail")).toBe(true);
    expect(tags).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "rail:input", label: "Input rail" }),
      expect.objectContaining({ id: "rail:output", label: "Output rail" }),
    ]));
  });

  it("fails fast with the configured asset path in the error", () => {
    const missingDirectory = resolve("../runner/toolkit/policy_library/missing-assets");
    expect(() => PolicyCatalog.load(missingDirectory)).toThrow(
      `Unable to load Policy catalog asset ${resolve(missingDirectory, "builtin_policies.json")}`,
    );
  });
});
