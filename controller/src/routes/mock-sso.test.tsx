import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MockSsoPage } from "./mock-sso";

const mocks = vi.hoisted(() => ({ config: vi.fn(), login: vi.fn(), navigate: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  Link: ({ children }: { children: React.ReactNode }) => <a href="/dashboard">{children}</a>,
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ loginMockSso: mocks.login, mockSsoPending: false }) }));
vi.mock("@/lib/identity-api", () => ({ getMockSsoConfig: mocks.config }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MockSsoPage /></QueryClientProvider>);
}

describe("Mock SSO selector", () => {
  it("signs in the selected tenant identity", async () => {
    mocks.config.mockResolvedValue({ enabled: true });
    mocks.login.mockResolvedValue(undefined);
    renderPage();
    const select = await screen.findByLabelText("auth.mockSsoIdentity");
    fireEvent.change(select, { target: { value: "tenantB" } });
    fireEvent.click(screen.getByRole("button", { name: "auth.mockSsoSignIn" }));
    await waitFor(() => expect(mocks.login).toHaveBeenCalledWith("tenantB"));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith({ to: "/dashboard", replace: true }));
  });

  it("does not offer sign-in when the mock provider is disabled", async () => {
    mocks.config.mockResolvedValue({ enabled: false });
    renderPage();
    expect(await screen.findByText("auth.mockSsoUnavailable")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "auth.mockSsoSignIn" })).toBeNull();
  });
});
