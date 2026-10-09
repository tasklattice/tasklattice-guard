import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteControllerGuardrailVersion, getGuardrailVersionDeletionImpact, type GuardrailVersionDeletionImpact } from "@/lib/controller-api";
import { DeleteGuardrailVersionSheet } from "./guardrail-version-delete-sheet";

vi.mock("@/lib/controller-api", () => ({ getGuardrailVersionDeletionImpact: vi.fn(), deleteControllerGuardrailVersion: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children, params }: { children: React.ReactNode; params: { routerId: string } }) => <a href={`/integration/routers/${params.routerId}`}>{children}</a> }));
vi.mock("react-i18next", async original => ({ ...(await original<typeof import("react-i18next")>()), useTranslation: () => ({ t: (key: string, values?: Record<string, string>) => values?.ticket ? `${key} ${values.ticket}` : key }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const base: GuardrailVersionDeletionImpact = { guardrailId: "guard", version: "v1", deletable: true, references: [], blockers: [], unrestorableRevisions: [] };
function mount(impact: GuardrailVersionDeletionImpact) {
  vi.mocked(getGuardrailVersionDeletionImpact).mockResolvedValue(impact);
  const onDeleted = vi.fn().mockResolvedValue(undefined);
  render(<QueryClientProvider client={new QueryClient()}><DeleteGuardrailVersionSheet guardrailId="guard" version="v1" onDeleted={onDeleted} onClose={vi.fn()} /></QueryClientProvider>);
  return onDeleted;
}
const confirm = () => screen.getByRole("button", { name: "uiCopy.deleteVersion" });

describe("Guardrail version deletion", () => {
  it("lists every reference with a link to its Router and blocks deletion", async () => {
    mount({ ...base, deletable: false, references: [
      { kind: "baseline" },
      { kind: "router_active", routerId: "r1", routerName: "Payments", revision: 2 },
      { kind: "change_request", routerId: "r2", routerName: "Cards", changeRequestId: "c", ticket: "CHG-9" },
    ] });
    const list = await screen.findByRole("region", { name: "guardrails.versionReferences" });
    expect(within(list).getByText("guardrails.versionReference.baseline")).toBeTruthy();
    expect(within(list).getByRole("link", { name: "Payments" }).getAttribute("href")).toBe("/integration/routers/r1");
    expect(within(list).getByText(/guardrails.versionReference.change_request CHG-9/)).toBeTruthy();
    expect(confirm().hasAttribute("disabled")).toBe(true);
  });

  it("explains blockers and lets the operator check again", async () => {
    mount({ ...base, deletable: false, blockers: [{ code: "recently_served", until: "2026-10-08T10:05:00.000Z" }] });
    expect(await screen.findByText("guardrails.versionBlocker.recently_served")).toBeTruthy();
    vi.mocked(getGuardrailVersionDeletionImpact).mockResolvedValue(base);
    fireEvent.click(screen.getByRole("button", { name: "guardrails.checkAgain" }));
    await waitFor(() => expect(confirm().hasAttribute("disabled")).toBe(false));
  });

  it("deletes an unreferenced version and names the history that becomes unrestorable", async () => {
    vi.mocked(deleteControllerGuardrailVersion).mockResolvedValue(undefined);
    const onDeleted = mount({ ...base, unrestorableRevisions: [{ routerId: "r1", routerName: "Payments", revision: 1, createdAt: "2026-10-01T08:00:00.000Z" }] });
    expect(await screen.findByText("20261001-080000.000Z")).toBeTruthy();
    fireEvent.click(confirm());
    await waitFor(() => expect(deleteControllerGuardrailVersion).toHaveBeenCalledExactlyOnceWith("guard", "v1"));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledOnce());
  });
});
