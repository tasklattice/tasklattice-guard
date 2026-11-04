import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SharingPage } from "./sharing";

const mocks = vi.hoisted(() => ({
  listProjects: vi.fn(), listShareableResources: vi.fn(), listShares: vi.fn(), createShare: vi.fn(), revokeShare: vi.fn(),
}));
vi.mock("@/lib/sharing-api", () => mocks);
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { project_id: "projectA", role: "user" } }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }) }));
vi.mock("@/components/ui/notifications", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("Project sharing page", () => {
  it("shares an owned resource with another project and allows revocation", async () => {
    const share = { id: "share-1", resourceType: "router", resourceId: "router-1", recipientProjectId: "projectB", createdAt: "2026-09-28T00:00:00.000Z" };
    let grants: typeof share[] = [];
    mocks.listProjects.mockResolvedValue({ items: [
      { id: "projectB", name: "Project B" },
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
    fireEvent.click(await screen.findByRole("radio",{name:"Project B"}));
    fireEvent.click(screen.getByRole("button", { name: "sharing.share" }));
    await waitFor(() => expect(mocks.createShare).toHaveBeenCalledWith({ resourceType: "router", resourceId: "router-1", recipientProjectId: "projectB" }));
    fireEvent.click(await screen.findByRole("button", { name: "sharing.revokeFor" }));
    await waitFor(() => expect(mocks.revokeShare).toHaveBeenCalledWith("share-1"));
  });
});
