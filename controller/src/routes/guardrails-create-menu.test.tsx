import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import { GuardrailsPage } from "./guardrails";

const session = vi.hoisted(() => ({ role: "admin" }));
vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en", exists: () => false } }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to?: string }) => <a href={to}>{children}</a>,
  useNavigate: () => vi.fn(), useParams: () => ({}), useSearch: () => ({}),
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: session.role } }) }));
vi.mock("@/routes/create-guardrail-wizard", () => ({ CreateGuardrailWizard: ({ open }: { open: boolean }) => open ? <div role="dialog" aria-label="create-wizard" /> : null }));
vi.mock("@/components/guardrail-import-sheet", () => ({ ImportGuardrailSheet: () => <div role="dialog" aria-label="import-sheet" />, EnvironmentStatus: () => null }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); session.role = "admin"; });

function mount() {
  vi.spyOn(api, "getGuardrails").mockResolvedValue({ items: [], count: 0 });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><GuardrailsPage /></QueryClientProvider>);
}
async function choose(item: string) {
  fireEvent.click(await screen.findByRole("button", { name: "guardrails.create" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: item }));
}

describe("Create Guardrail entry", () => {
  it("offers a new Guardrail and an imported release package from one menu", async () => {
    mount();
    await choose("guardrails.createNew");
    expect(await screen.findByRole("dialog", { name: "create-wizard" })).toBeTruthy();
  });

  it("opens the release package import from the same menu", async () => {
    mount();
    await choose("guardrailPackage.importPackage");
    expect(await screen.findByRole("dialog", { name: "import-sheet" })).toBeTruthy();
  });

  it("offers no create entry to non-administrators", async () => {
    session.role = "viewer";
    mount();
    await waitFor(() => expect(api.getGuardrails).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "guardrails.create" })).toBeNull();
  });
});
