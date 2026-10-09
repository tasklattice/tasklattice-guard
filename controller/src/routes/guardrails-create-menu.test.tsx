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
describe("Create Guardrail entry", () => {
  it("creates directly from the button", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "guardrails.create" }));
    expect(await screen.findByRole("dialog", { name: "create-wizard" })).toBeTruthy();
  });

  it("keeps importing a release package behind the arrow, closed until asked", async () => {
    mount();
    await screen.findByRole("button", { name: "guardrails.create" });
    expect(screen.queryByRole("menuitem", { name: "guardrailPackage.importPackage" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "common.moreCreateOptions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "guardrailPackage.importPackage" }));
    expect(await screen.findByRole("dialog", { name: "import-sheet" })).toBeTruthy();
  });

  it("offers no create entry to non-administrators", async () => {
    session.role = "viewer";
    mount();
    await waitFor(() => expect(api.getGuardrails).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "guardrails.create" })).toBeNull();
  });
});
