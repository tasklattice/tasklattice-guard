import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LoginPage } from "./login";

const mocks = vi.hoisted(() => ({ login: vi.fn(), navigate: vi.fn(), options: vi.fn(), sso: vi.fn() }));
vi.mock("@/lib/identity-api", () => ({getSignInOptions: () => mocks.options(), loginSso: (...args: unknown[]) => mocks.sso(...args)}));
function renderLogin(sso = false) { mocks.options.mockResolvedValue({password:true,sso:sso ? {providerId:"corporate-sso",displayName:"Keycloak"} : null}); return render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><LoginPage /></QueryClientProvider>); }
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ login: mocks.login, setLanguage: vi.fn(), loginPending: false }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }) }));

afterEach(() => { cleanup(); vi.resetAllMocks(); });

function submitCredentials() {
  fireEvent.change(screen.getByLabelText("auth.loginIdentifier"), { target: { value: "operator" } });
  fireEvent.change(screen.getByLabelText("common.password"), { target: { value: "test-password-only" } });
  fireEvent.click(screen.getByRole("button", { name: "auth.loginSubmit" }));
}

describe("Username and password sign-in", () => {
  it("submits credentials and opens the dashboard after successful authentication", async () => {
    mocks.login.mockResolvedValue(undefined);
    renderLogin();
    submitCredentials();
    await waitFor(() => expect(mocks.login).toHaveBeenCalledWith({ username: "operator", password: "test-password-only" }));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith({ to: "/dashboard", replace: true }));
  });

  it("shows authentication failures without navigating", async () => {
    mocks.login.mockRejectedValue(new Error("Invalid credentials"));
    renderLogin();
    submitCredentials();
    expect(await screen.findByText("Invalid credentials")).toBeTruthy();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("offers configured SSO and keeps local sign-in usable after an IdP failure", async () => {
    mocks.sso.mockRejectedValue(new Error("Identity provider unavailable"));
    mocks.login.mockResolvedValue(undefined);
    renderLogin(true);
    fireEvent.click(await screen.findByRole("button", {name: "auth.ssoSignIn"}));
    expect(await screen.findByText("auth.ssoFailed")).toBeTruthy();
    expect(mocks.sso).toHaveBeenCalledWith("corporate-sso");
    submitCredentials();
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith({to:"/dashboard",replace:true}));
  });
});
