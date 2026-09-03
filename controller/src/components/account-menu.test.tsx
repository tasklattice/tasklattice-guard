import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountMenu } from "./account-menu";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to: _to, ...props }: { children: ReactNode; to?: string } & AnchorHTMLAttributes<HTMLAnchorElement>) => <a href="/account" {...props}>{children}</a>,
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: {
      display_name: "Local Administrator",
      email: "admin@tasklattice.local",
      role: "admin",
    },
    logout: vi.fn(),
    logoutPending: false,
  }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { name?: string }) => ({
      "sidebar.accountMenuFor": `Open account menu for ${values?.name}`,
      "account.fallbackName": "User",
      "account.localAccount": "Local account",
      "account.title": "Account",
      "auth.manageUsers": "Manage users",
      "auth.signOut": "Sign out",
    } as Record<string, string>)[key] ?? key,
  }),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

describe("AccountMenu", () => {
  afterEach(cleanup);

  it("uses an avatar-only header trigger and reveals identity details in the menu", () => {
    render(<AccountMenu placement="header" />);

    const trigger = screen.getByRole("button", { name: "Open account menu for Local Administrator" });
    expect(trigger.textContent).toBe("LA");

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });

    expect(screen.getByText("Local Administrator")).toBeTruthy();
    expect(screen.getByText("admin@tasklattice.local")).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Account" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Manage users" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeTruthy();
  });
});
