import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Policy } from "@/lib/api";
import { PolicyLibraryPage } from "./policy-library";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const catalog = vi.hoisted(() => ({ items: [] as Policy[], search: {} as { policy?: string } }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), useSearch: () => catalog.search }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { email: "author@example.test", role: "admin" } }) }));
vi.mock("@/lib/api", async original => ({ ...await original<typeof import("@/lib/api")>(),
  getPolicies: async () => ({ items: catalog.items }), getActionCatalog: async () => ({ items: [] }),
}));
vi.mock("@/lib/policy-transfer", async original => ({ ...await original<typeof import("@/lib/policy-transfer")>(),
  parsePolicyPackage: () => ({ name: "Imported local Policy", description: "Focus regression", owner: "author@example.test",
    draft: { guardrail_category: "pii_detection", sources: [{ path: "main.co", content: "flow check_request $text\n  pass" }],
      parameter_schema: [], action_references: [], evaluation_contracts: [], prompt_dependencies: [], execution_contract: [], rail_bindings: [], test_cases: [] } }),
}));
afterEach(cleanup);
beforeEach(() => { catalog.items = []; catalog.search = {}; });

describe("Policy Library actual Studio opener", () => {
  it("returns to the Edit button in the underlying Policy inspector", async () => {
    const draft = { guardrail_category: "pii_detection", sources: [{ path: "main.co", content: "flow check_request $text\n  pass" }],
      parameter_schema: [], action_references: [], evaluation_contracts: [], prompt_dependencies: [], execution_contract: [], rail_bindings: [], test_cases: [] };
    catalog.items = [{ id: "custom", name: "Local Policy", description: "Focus regression", source: "custom", implementation: "nemo_native",
      version: "1", tags: [], parameters: [], rails: [], effects: [], forms: [], rules: [], test_count: 0, test_cases: [],
      safety_level: "balanced", output_delivery: "full_buffered",
      implementation_detail: { id: "custom", name: "Local Policy", description: "Focus regression", owner: "author@example.test", draft },
    } as Policy];
    catalog.search = { policy: "custom" };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><PolicyLibraryPage /></QueryClientProvider>);
    const opener = await screen.findByRole("button", { name: "policyLibrary.editPolicy" });
    fireEvent.click(opener);
    await screen.findByRole("dialog", { name: "policyStudio.editTitle" });
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "policyStudio.editTitle" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(screen.getByRole("dialog", { name: "Local Policy" })).toBeTruthy();
  });
  it.each(["Escape", "common.close", "common.cancel"])("restores the new/import button after %s", async action => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(<QueryClientProvider client={client}><PolicyLibraryPage /></QueryClientProvider>);
    for (const name of ["policyLibrary.newPolicy", "policyStudio.importPolicy"]) {
      const opener = screen.getByRole("button", { name, exact: true });
      // Pointer clicks need not focus a button on macOS; do not pre-focus it.
      fireEvent.click(opener);
      if (name === "policyStudio.importPolicy") {
        fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [{ text: async () => "{}" }] } });
      }
      const dialog = await screen.findByRole("dialog");
      await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
      if (action === "Escape") fireEvent.keyDown(document.activeElement!, { key: "Escape" });
      else fireEvent.click(screen.getByRole("button", { name: action, exact: true }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(opener));
    }
  });
});
