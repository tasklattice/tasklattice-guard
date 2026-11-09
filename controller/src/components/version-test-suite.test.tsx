import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getGuardrailVersionTestSuite, type FrozenTestCase } from "@/lib/controller-api";
import { VersionTestSuite } from "./version-test-suite";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => values && "reason" in values ? `${key}:${values.reason}` : key }) }));
vi.mock("@/lib/controller-api", async original => ({ ...(await original<typeof import("@/lib/controller-api")>()), getGuardrailVersionTestSuite: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const testCase = (id: string, extra: Partial<FrozenTestCase> = {}): FrozenTestCase => ({
  id, name: `Case ${id}`, origin: "generated", policyId: "pii", phase: "input", content: `content ${id}`, expectedDecision: "block",
  caseType: "scenario", required: true, sourcePolicyId: "pii", sourcePolicyVersion: "1.0.0", sourceCaseId: id, coveredRuleIds: ["pii/email"],
  expectationOverride: null, ...extra,
});
function mount() {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><VersionTestSuite guardrailId="guard" version="20261009-120000.000Z" /></QueryClientProvider>);
}

describe("A version's frozen test suite", () => {
  it("lists the frozen cases by Policy, Guardrail-specific last, read only, with their expected decisions", async () => {
    vi.mocked(getGuardrailVersionTestSuite).mockResolvedValue({ guardrailId: "guard", version: "20261009-120000.000Z", recorded: true, digest: "a".repeat(64), count: 3, items: [
      testCase("custom-1", { origin: "custom", sourcePolicyId: null, name: "Bank card number" }),
      testCase("pii-1"),
      testCase("pii-2", { expectedDecision: "block", expectationOverride: { reason: "Reviewed by risk", expectedDecision: "allow", sourcePolicyVersion: "1.0.0" } }),
    ] });
    mount();
    const groups = await screen.findAllByRole("heading", { level: 4 });
    expect(groups.map(item => item.textContent)).toEqual(["pii2", "immutableVersions.testSuiteGuardrailGroup1"]);
    // An overridden expectation is what the case asserts.
    const overridden = screen.getByText("Case pii-2").closest("details")!;
    expect(within(overridden).getByText("policyLibrary.expectedDecisions.allow")).toBeTruthy();
    fireEvent.click(within(overridden).getByText("Case pii-2"));
    expect(within(overridden).getByText("immutableVersions.testSuiteOverride:Reviewed by risk")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /edit|delete/i })).toBeNull();
  });

  it("says so when a version was published before suites were frozen", async () => {
    vi.mocked(getGuardrailVersionTestSuite).mockResolvedValue({ guardrailId: "guard", version: "v", recorded: false, digest: null, count: 0, items: [] });
    mount();
    expect(await screen.findByText("immutableVersions.testSuiteNotRecorded")).toBeTruthy();
  });
});
