import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LoginPage } from "./login";

const mocks = vi.hoisted(() => ({ config: vi.fn(), navigate: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ login: vi.fn(), setLanguage: vi.fn(), loginPending: false }) }));
vi.mock("@/lib/identity-api", () => ({ getMockSsoConfig: mocks.config }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }) }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><LoginPage /></QueryClientProvider>);
}

describe("Login page demo SSO entry", () => {
  it("routes to the separate identity chooser only when enabled", async () => {
    mocks.config.mockResolvedValue({ enabled: true });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "auth.mockSsoContinue" }));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith({ to: "/mock-sso" }));
  });

  it("hides the chooser entry when the provider is disabled", async () => {
    mocks.config.mockResolvedValue({ enabled: false });
    renderPage();
    await screen.findByRole("button", { name: "auth.loginSubmit" });
    expect(screen.queryByRole("button", { name: "auth.mockSsoContinue" })).toBeNull();
  });
});
