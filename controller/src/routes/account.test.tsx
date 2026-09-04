import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IdentityUser } from "@/lib/identity-api";

import { AccountPage } from "./account";

const updateProfileMock = vi.fn();

const user: IdentityUser = {
  id: "user-admin",
  display_name: "Administrator",
  email: "admin@tasklattice.local",
  role: "admin",
  enabled: true,
  preferred_language: "en",
  last_login_at: "2026-08-14T08:00:00Z",
  created_at: "2026-08-01T08:00:00Z",
  updated_at: "2026-08-14T08:00:00Z",
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      "account.title": "Account",
      "account.description": "Manage your personal identity, interface preferences, and sign-in security.",
      "account.sections": "Account sections",
      "account.general": "General",
      "account.security": "Security",
      "account.profile": "Profile",
      "account.profileDescription": "Choose how your name appears.",
      "account.displayName": "Display name",
      "account.displayNameHint": "This name identifies your activity.",
      "account.email": "Work email",
      "account.emailReadOnly": "Your sign-in email is managed by an administrator.",
      "account.interfaceLanguage": "Interface language",
      "account.languageDescription": "Applies whenever you sign in.",
      "account.saveChanges": "Save changes",
      "account.saved": "Account updated.",
      "account.roleAccess": "Role & access",
      "account.roleAccessDescription": "Your organization controls these properties.",
      "account.accountRole": "Account role",
      "account.accountStatus": "Account status",
      "account.active": "Active",
      "account.lastSignIn": "Last sign-in",
      "account.created": "Created",
      "account.securityTitle": "Password & sessions",
      "account.securityDescription": "Manage the credential used to sign in.",
      "account.password": "Password",
      "account.passwordManagedLocally": "Changing it signs out other sessions.",
      "common.admin": "Administrator",
      "auth.changePassword": "Change password",
      "common.never": "Never",
      "common.saving": "Saving…",
    } as Record<string, string>)[key] ?? key,
    i18n: { language: "en", exists: () => false },
  }),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user, updateProfile: updateProfileMock }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function renderPage() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><AccountPage /></QueryClientProvider>);
}

describe("AccountPage", () => {
  beforeEach(() => updateProfileMock.mockReset().mockResolvedValue(undefined));
  afterEach(cleanup);

  it("persists an edited display name with the current account language", async () => {
    renderPage();

    const save = screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Guard Operator" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(updateProfileMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(updateProfileMock).toHaveBeenCalledWith({
      display_name: "Guard Operator",
      preferred_language: "en",
    }));
  });

  it("keeps password management in the Security section", async () => {
    renderPage();

    const general = screen.getByRole("tab", { name: "General" });
    general.focus();
    fireEvent.keyDown(general, { key: "ArrowRight", code: "ArrowRight" });

    expect(await screen.findByText("Password & sessions")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change password" })).toBeTruthy();
  });
});
