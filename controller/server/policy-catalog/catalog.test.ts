import { resolve, join } from "node:path";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { policyComplianceSchema } from "../../shared/policy-compliance.js";

import { describe, expect, it } from "vitest";

import { PolicyCatalog } from "./catalog.js";

const assetDirectory = resolve("../runner/toolkit/policy_library/assets");

describe("Policy catalog", () => {
  it("documents every built-in Policy with version-bound sources and real Rule references", () => {
    const policies = PolicyCatalog.load(assetDirectory).list();
    expect(policies).toHaveLength(69);
    for (const policy of policies) {
      expect(policy.compliance?.policy_version, policy.id).toBe(policy.version);
      expect(policy.compliance?.provenance.en, policy.id).toBeTruthy();
      expect(policy.compliance?.provenance.zh, policy.id).toBeTruthy();
      expect(policy.compliance?.references.length, policy.id).toBeGreaterThan(0);
      const ids = new Set(policy.rules.map(rule => rule.id));
      for (const entry of [...policy.compliance!.references, ...policy.compliance!.coverage]) {
        expect(entry.rule_ids.length, policy.id).toBeGreaterThan(0);
        expect(entry.rule_ids.every(id => ids.has(id)), policy.id).toBe(true);
      }
    }
    expect(policies.filter(policy => policy.compliance).length).toBe(69);
    expect(PolicyCatalog.load(assetDirectory).get("builtin-content-safety")?.compliance?.references[0]?.url).toContain("docs.nvidia.com");
    expect(PolicyCatalog.load(assetDirectory).get("filter-denied-medical-advice")?.compliance?.references[0]?.url).toContain("github.com/BerriAI/litellm");
  });
  it("keeps the compressed documentation overhead bounded", () => {
    const policies = PolicyCatalog.load(assetDirectory).list();
    const withDocumentation = gzipSync(JSON.stringify(policies)).byteLength;
    const withoutDocumentation = gzipSync(JSON.stringify(policies.map(({ compliance: _compliance, ...policy }) => policy))).byteLength;
    expect(withDocumentation - withoutDocumentation).toBeLessThan(45_000);
  });

  it.each(["version", "rule"])("rejects stale compliance %s references", kind => {
    const directory = mkdtempSync(join(tmpdir(), "guard-compliance-"));
    try {
      cpSync(assetDirectory, directory, { recursive: true });
      const file = join(directory, "builtin_policies.json");
      const assets = JSON.parse(readFileSync(file, "utf8"));
      const policy = assets.find((item: { id: string }) => item.id === "advanced-au-pii-protection");
      if (kind === "version") policy.compliance.policy_version = "older-version";
      else policy.compliance.references[0].rule_ids = ["missing-rule"];
      writeFileSync(file, JSON.stringify(assets));
      expect(() => PolicyCatalog.load(directory)).toThrow(kind === "version" ? /version mismatch/ : /Unknown compliance Rule/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("requires safe links and evidence for reviewed documentation", () => {
    const documentation = PolicyCatalog.load(assetDirectory).get("advanced-au-pii-protection")!.compliance!;
    expect(policyComplianceSchema.safeParse({ ...documentation, review: { ...documentation.review, reviewer: null } }).success).toBe(false);
    expect(policyComplianceSchema.safeParse({ ...documentation, references: [{ ...documentation.references[0], url: "javascript:alert(1)" }] }).success).toBe(false);
  });

  it("merges both canonical asset collections and applies focused overrides", () => {
    const catalog = PolicyCatalog.load(assetDirectory);
    const policies = catalog.list();

    expect(policies).toHaveLength(69);
    expect(new Set(policies.map((policy) => policy.id)).size).toBe(69);
    expect(catalog.get("builtin-content-safety")).toMatchObject({ rails: ["input", "output"], test_count: 2 });
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

  it("keeps regulatory framework Policies discoverable in the default catalog", () => {
    const catalog = PolicyCatalog.load(assetDirectory);

    expect(catalog.get("eu-ai-act-article5")?.tags).toEqual(expect.arrayContaining([expect.objectContaining({ id: "framework:eu-ai-act" })]));
    expect(catalog.get("gdpr-eu-pii-protection")?.tags).toEqual(expect.arrayContaining([expect.objectContaining({ id: "framework:gdpr" })]));
    expect(catalog.get("mas-ai-risk-management")?.tags).toEqual(expect.arrayContaining([expect.objectContaining({ id: "framework:mas-ai-risk" })]));
    expect(catalog.get("pdpa-singapore")?.tags).toEqual(expect.arrayContaining([expect.objectContaining({ id: "framework:pdpa" })]));

    const jurisdictions = new Set(
      catalog.list().flatMap((policy) => policy.tags.filter((tag) => tag.namespace === "jurisdiction").map((tag) => tag.value)),
    );
    expect(jurisdictions).toEqual(new Set(["au", "eu", "sg", "singapore", "uae"]));
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
      `Unable to load protection contract ${resolve(missingDirectory, "protection-contracts.json")}`,
    );
  });
});
