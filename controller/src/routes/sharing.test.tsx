import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SharingPage } from "./sharing";

const mocks = vi.hoisted(() => ({
  listTenants: vi.fn(), listShareableResources: vi.fn(), listShares: vi.fn(), createShare: vi.fn(), revokeShare: vi.fn(),
}));
vi.mock("@/lib/sharing-api", () => mocks);
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { tenant_id: "tenantA", role: "user" } }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }) }));
vi.mock("@/components/ui/notifications", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("Tenant sharing page", () => {
  it("shares an owned resource with another tenant and allows revocation", async () => {
    const share = { id: "share-1", resourceType: "router", resourceId: "router-1", recipientTenantId: "tenantB", createdAt: "2026-09-28T00:00:00.000Z" };
    let grants: typeof share[] = [];
    mocks.listTenants.mockResolvedValue({ items: [
      { id: "tenantA", name: "Tenant A" }, { id: "tenantB", name: "Tenant B" },
    ] });
    mocks.listShareableResources.mockResolvedValue({ items: [
      { resourceType: "router", resourceId: "router-1", name: "My Router" },
    ] });
    mocks.listShares.mockImplementation(async () => ({ items: grants }));
    mocks.createShare.mockImplementation(async () => { grants = [share]; return { share }; });
    mocks.revokeShare.mockImplementation(async () => { grants = []; });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharingPage /></QueryClientProvider>);
    await screen.findByRole("option", { name: "sharing.type.router · My Router" });
    fireEvent.change(screen.getByLabelText("sharing.resource"), { target: { value: "router:router-1" } });
    await screen.findByRole("option", { name: "Tenant B (tenantB)" });
    fireEvent.change(screen.getByLabelText("sharing.recipient"), { target: { value: "tenantB" } });
    fireEvent.click(screen.getByRole("button", { name: "sharing.share" }));
    await waitFor(() => expect(mocks.createShare).toHaveBeenCalledWith({ resourceType: "router", resourceId: "router-1", recipientTenantId: "tenantB" }));
    fireEvent.click(await screen.findByRole("button", { name: "sharing.revokeFor" }));
    await waitFor(() => expect(mocks.revokeShare).toHaveBeenCalledWith("share-1"));
  });
});
