import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PolicyCatalog } from "../../server/policy-catalog/catalog";
import { PolicyCompliancePanel } from "./policy-compliance";

const locale = vi.hoisted(() => ({ language: "en" }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: locale }) }));
afterEach(() => { cleanup(); locale.language = "en"; });
const policy = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).get("advanced-au-pii-protection")!;

it("renders version-bound provenance, blue external references, Rules, limits and review evidence", () => {
  render(<PolicyCompliancePanel policy={policy} />);
  expect(screen.getByText(policy.compliance!.summary.en)).toBeTruthy();
  expect(screen.getByText("policyLibrary.compliance.reviewed")).toBeTruthy();
  expect(screen.getByText("TaskLattice Engineering")).toBeTruthy();
  expect(screen.getAllByText("TFN (Australian Tax File Number)").length).toBeGreaterThan(0);
  for (const reference of policy.compliance!.references) {
    const link = screen.getByRole("link", { name: new RegExp(reference.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
    expect(link.getAttribute("href")).toBe(reference.url);
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.className).toContain("text-blue-700");
  }
  expect(screen.getByText(policy.compliance!.limitations[0]!.en)).toBeTruthy();
});
it("labels external links and renders Chinese documentation without claiming certification", () => {
  locale.language = "zh-CN";
  render(<PolicyCompliancePanel policy={policy} />);
  expect(screen.getByText(policy.compliance!.summary.zh)).toBeTruthy();
  expect(screen.getByText(policy.compliance!.review.notes.zh)).toBeTruthy();
  expect(screen.getAllByText("policyLibrary.compliance.externalLink")).toHaveLength(policy.compliance!.references.length);
});
it("explains when a customer-authored Policy declares no external references", () => {
  render(<PolicyCompliancePanel policy={{ ...policy, compliance: { ...policy.compliance!, references: [] } }} />);
  expect(screen.getByText("policyLibrary.compliance.noExternalReferences")).toBeTruthy();
  expect(screen.queryByRole("link")).toBeNull();
});
it.each(["missing", "other-version"])("shows the empty state for %s documentation", mode => {
  const { compliance, ...rest } = policy;
  render(<PolicyCompliancePanel policy={mode === "missing" ? rest : { ...policy, version: "historical-version" }} />);
  expect(screen.getByText("policyLibrary.compliance.empty")).toBeTruthy();
  expect(screen.queryByRole("link")).toBeNull();
});
