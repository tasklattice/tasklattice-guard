import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PolicyCatalog } from "../../server/policy-catalog/catalog";
import { PolicyCompliancePanel } from "./policy-compliance";

const locale = vi.hoisted(() => ({ language: "en" }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: locale }) }));
afterEach(() => { cleanup(); locale.language = "en"; });
const policy = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).get("advanced-au-pii-protection")!;

it("renders version-bound provenance, official references, Rules, limits and a pending review", () => {
  render(<PolicyCompliancePanel policy={policy} />);
  expect(screen.getByText(policy.compliance!.summary.en)).toBeTruthy();
  expect(screen.getByText("policyLibrary.compliance.pending")).toBeTruthy();
  expect(screen.getAllByText("policyLibrary.compliance.notReviewed")).toHaveLength(2);
  expect(screen.getAllByText("TFN (Australian Tax File Number)").length).toBeGreaterThan(0);
  for (const reference of policy.compliance!.references) {
    const link = screen.getByRole("link", { name: new RegExp(reference.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
    expect(link.getAttribute("href")).toBe(reference.url);
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  }
  expect(screen.getByText(policy.compliance!.limitations[0]!.en)).toBeTruthy();
});
it("renders Chinese documentation without claiming certification", () => {
  locale.language = "zh-CN";
  render(<PolicyCompliancePanel policy={policy} />);
  expect(screen.getByText(policy.compliance!.summary.zh)).toBeTruthy();
  expect(screen.getByText(policy.compliance!.review.notes.zh)).toBeTruthy();
});
it.each(["missing", "other-version"])("shows the empty state for %s documentation", mode => {
  const { compliance, ...rest } = policy;
  render(<PolicyCompliancePanel policy={mode === "missing" ? rest : { ...policy, version: "historical-version" }} />);
  expect(screen.getByText("policyLibrary.compliance.empty")).toBeTruthy();
  expect(screen.queryByRole("link")).toBeNull();
});
