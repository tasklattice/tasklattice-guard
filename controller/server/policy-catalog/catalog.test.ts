import { resolve, join } from "node:path";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { policyComplianceSchema } from "../../shared/policy-compliance.js";

import { describe, expect, it } from "vitest";

import { PolicyCatalog } from "./catalog.js";
import { buildGuardrailPlan } from "../domain/guardrail-plan.js";
import { defaultGuardrailDraft } from "../domain/defaults.js";

const assetDirectory = resolve("../runner/toolkit/policy_library/assets");

describe("Policy catalog", () => {
  it("removes aviation-only templates and facets while moving regional composition to Profiles", () => {
    const catalog = PolicyCatalog.load(assetDirectory);
    for (const id of ["airline-off-topic-restriction", "airline-passenger-data-protection-uae", "aviation-operations-security", "local-travel-identifiers"]) {
      expect(catalog.get(id)).toBeUndefined();
    }
    const tags = catalog.list().flatMap(policy => policy.tags);
    expect(tags.some(tag => tag.value === "aviation")).toBe(false);
    expect(tags.some(tag => tag.namespace === "jurisdiction" && tag.value === "uae")).toBe(true);
    expect(catalog.list().flatMap(policy => policy.compliance?.references ?? []).some(reference => reference.url.includes("iata.org"))).toBe(false);
    const removedRules = new Set(["pattern/airline_pnr", "pattern/skywards_number", "pattern/flight_number"]);
    expect(catalog.list().flatMap(policy => policy.rules).some(rule => removedRules.has(rule.id))).toBe(false);
  });

  it("ships only V1 builtin Policies with no bundled history", () => {
    const catalog = PolicyCatalog.load(assetDirectory);
    // Versions advance with reviewed Rule fixes; the shipped catalog stays on V1.
    expect(catalog.list().every(policy => policy.version.startsWith("1."))).toBe(true);
    expect(catalog.list().every(policy => !policy.retired && !policy.published_versions?.length)).toBe(true);
    expect(catalog.get("local-bank-account-formats")).toBeUndefined();
  });

  it("documents every built-in Policy and separates implementation lineage from industry context", () => {
    const catalog = PolicyCatalog.load(assetDirectory);
    const policies = catalog.list().filter(policy => policy.source === "built_in");
    expect(policies).toHaveLength(21);
    for (const policy of policies) {
      expect(policy.compliance?.policy_version, policy.id).toBe(policy.version);
      expect(policy.compliance?.provenance.en, policy.id).toBeTruthy();
      expect(policy.compliance?.provenance.zh, policy.id).toBeTruthy();
      const ids = new Set(policy.rules.map(rule => rule.id));
      for (const entry of [...policy.compliance!.references, ...policy.compliance!.coverage]) {
        expect(entry.rule_ids.length, policy.id).toBeGreaterThan(0);
        expect(entry.rule_ids.every(id => ids.has(id)), policy.id).toBe(true);
      }
    }
    expect(policies.filter(policy => policy.compliance).length).toBe(policies.length);
    expect(policies.filter(policy => policy.compliance?.references.length).length).toBeGreaterThan(0);
    for (const removed of ["pdpa-singapore", "china-personal-identifiers", "china-banking-assistant-boundaries", "topic-filtering"]) {
      expect(catalog.list().some(p => p.id === removed)).toBe(false);
    }

  });

  it("never presents software dependencies, the retired MAS page, or AI Verify as compliance references", () => {
    const references = PolicyCatalog.load(assetDirectory).list().flatMap(policy => policy.compliance?.references ?? []);
    const urls = references.map(reference => reference.url);
    expect(urls.some(url => /github\.com\/BerriAI|docs\.nvidia\.com|aiverifyfoundation\.sg/.test(url))).toBe(false);
    expect(urls).not.toEqual(expect.arrayContaining([
      "https://www.mas.gov.sg/publications/monographs-or-information-paper/2018/feat-principles",
      "https://www.imda.gov.sg/resources/press-releases-factsheets-and-speeches/factsheets/2024/model-ai-governance-framework-for-generative-ai",
    ]));
    expect(references.every(reference => /NIST|OWASP|WHO|UNICEF|EUR-Lex|Government|Commission|Authority|Council|Committee|Organization|Foundation|Register|Association/.test(`${reference.publisher} ${reference.title}`))).toBe(true);
  });
  it("keeps the compressed documentation overhead bounded", () => {
    const policies = PolicyCatalog.load(assetDirectory).list().filter(policy => policy.source === "built_in");
    const withDocumentation = gzipSync(JSON.stringify(policies)).byteLength;
    const withoutDocumentation = gzipSync(JSON.stringify(policies.map(({ compliance: _compliance, ...policy }) => policy))).byteLength;
    // This is a transfer-size budget, not a byte-exact compression snapshot.
    // Supported Node/zlib builds compress the same catalog differently: about
    // 45.2 KB locally and 46.2 KB on CI's Node 24. Keep a 48 KiB ceiling with
    // modest compressor headroom, and report the runtime if it is exceeded.
    expect(withDocumentation - withoutDocumentation,
      `Compliance gzip overhead (Node ${process.versions.node}, zlib ${process.versions.zlib})`,
    ).toBeLessThan(48 * 1024);
  });

  it("requires safe links and evidence for reviewed documentation", () => {
    const documentation = PolicyCatalog.load(assetDirectory).get("application-injection")!.compliance!;
    expect(policyComplianceSchema.safeParse({ ...documentation, review: { ...documentation.review, reviewer: null } }).success).toBe(false);
    expect(policyComplianceSchema.safeParse({ ...documentation, references: [{ ...documentation.references[0], url: "javascript:alert(1)" }] }).success).toBe(false);
  });

  it("ships one compiled catalog", () => {
    const catalog = PolicyCatalog.load(assetDirectory);
    const policies = catalog.list();

    expect(policies.filter(policy => policy.source === "built_in")).toHaveLength(21);
    expect(new Set(policies.map((policy) => policy.id)).size).toBe(policies.length);
    expect(catalog.get("content-safety-model")).toMatchObject({ rails: ["input", "output"], test_count: 2 });
    expect(catalog.get("content-filters")).toMatchObject({
      name: "Content Filters",
      implementation: "rules",
      source: "built_in",
    });
  });

  it("normalizes computed fields, Guardrail categories, and framework metadata", () => {
    const policy = PolicyCatalog.load(assetDirectory).get("contact-data");

    expect(policy).toBeDefined();
    expect(policy?.rails).toEqual(["input", "output"]);
    expect(policy?.effects).toEqual(["transform"]);
    expect(policy?.detectors).toEqual(["text/regex"]);
    expect(policy?.test_count).toBe(policy?.test_cases.length);
    expect(policy?.tags).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "framework:owasp-llm-2025", label: "OWASP LLM 2025" }),
      expect.objectContaining({ id: "protection:privacy" }),
    ]));
    expect(policy?.rules[0]).toMatchObject({
      context_max_gap_words: null,
      allow_word_numbers: false,
      identifiers: expect.any(Array),
      conditions: expect.any(Array),
    });
  });

  it("preserves region and framework discovery on shared capabilities", () => {
    const catalog = PolicyCatalog.load(assetDirectory);
    const tags = catalog.list().flatMap(p => p.tags);
    expect([...new Set(tags.filter(t => t.namespace === "jurisdiction").map(t => t.value))].sort()).toEqual(["au", "cn", "eu", "sg", "uae"]);
    expect(tags.filter(t => t.namespace === "framework").map(t => t.value)).toEqual(expect.arrayContaining(["gdpr", "pdpa", "pipl-cn", "jr-t-0221-2021", "eu-ai-act", "owasp-llm-2025"]));
    expect(catalog.get("content-safety-local")?.rules.some(r => r.id === "category/harmful_child_safety")).toBe(true);
  });

  it("uses the reviewed Policy facets and canonical NeMo Rail terminology", () => {
    const tags = PolicyCatalog.load(assetDirectory).list().flatMap((policy) => policy.tags);
    const namespaces = new Set<string>(tags.map((tag) => tag.namespace));

    expect(namespaces.has("scope")).toBe(false);
    expect(namespaces.has("stage")).toBe(false);
    expect(namespaces.has("capability")).toBe(false);
    expect(namespaces.has("protection")).toBe(true);
    expect(namespaces.has("framework")).toBe(true);
    expect(namespaces.has("jurisdiction")).toBe(true);
  });

  it("fails fast with the configured asset path in the error", () => {
    const missingDirectory = resolve("../runner/toolkit/policy_library/missing-assets");
    expect(() => PolicyCatalog.load(missingDirectory)).toThrow(
      `Unable to load protection contract ${resolve(missingDirectory, "protection-contracts.json")}`,
    );
  });
});
