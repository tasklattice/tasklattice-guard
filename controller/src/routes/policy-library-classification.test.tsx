import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CatalogFilters, tagFacets } from "./policy-library";
import type { Policy } from "@/lib/api";

// The target catalog is the one the Console serves. Render the real reviewable
// data so a catalog rebuild cannot silently drop a navigation group again.
const targetPolicies: Policy[] = JSON.parse(readFileSync(
  resolve(import.meta.dirname, "../../../runner/toolkit/policy_library/assets/policies.json"),
  "utf8",
)).map((policy: Policy) => ({
  ...policy,
  tags: policy.tags.map(tag => ({ ...tag, id: `${tag.namespace}:${tag.value}` })),
}));

describe("Policy Library classification", () => {
  it("keeps the protection map, framework and jurisdiction groups", () => {
    const facets = tagFacets(targetPolicies);
    const labels = (namespace: string) => [...(facets.get(namespace) ?? [])].map(tag => tag.label);

    expect(labels("framework")).toEqual(expect.arrayContaining([
      "OWASP LLM 2025", "EU AI Act", "GDPR", "JR/T 0221-2021", "PIPL (China)", "Singapore PDPA",
    ]));
    expect(labels("jurisdiction")).toEqual(expect.arrayContaining([
      "Australia", "China mainland", "European Union", "Singapore", "United Arab Emirates",
    ]));

    render(<CatalogFilters policies={targetPolicies} facets={facets} directory={null}
      onDirectoryChange={() => {}} selected={new Set()} onChange={() => {}} onClear={() => {}} />);

    expect(screen.getByText("Protection map")).toBeTruthy();
    expect(screen.getByText("Frameworks & regulations")).toBeTruthy();
    expect(screen.getByText("Jurisdiction")).toBeTruthy();
  });
});
