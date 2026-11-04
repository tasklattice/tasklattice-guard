import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountMenu } from "./account-menu";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to: _to, ...props }: { children: ReactNode; to?: string } & AnchorHTMLAttributes<HTMLAnchorElement>) => <a href="/account" {...props}>{children}</a>,
}));

const identity = vi.hoisted(() => ({ role: "admin", project_id: null as string | null }));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: {
      display_name: "Local Administrator",
      username: "admin",
      role: identity.role,
      project_id: identity.project_id,
    },
    logout: vi.fn(),
    logoutPending: false,
  }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { name?: string; project?: string }) => ({
      "sidebar.accountMenuFor": `Open account menu for ${values?.name}`,
      "account.fallbackName": "User",
      "account.localAccount": "Local account",
      "account.projectLabel": `Project: ${values?.project}`,
      "sidebar.platformIdentity": "Platform administrator",
      "account.title": "Account",
      "auth.manageUsers": "Manage users",
      "auth.signOut": "Sign out",
    } as Record<string, string>)[key] ?? key,
  }),
}));

vi.mock("@/components/ui/notifications", () => ({ toast: { error: vi.fn() } }));

describe("AccountMenu", () => {
  afterEach(() => { cleanup(); identity.role = "admin"; identity.project_id = null; });

  it("uses an avatar-only header trigger and reveals identity details in the menu", () => {
    render(<AccountMenu placement="header" />);

    const trigger = screen.getByRole("button", { name: "Open account menu for Local Administrator" });
    expect(trigger.textContent).toBe("LA");

    fireEvent.click(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });

    expect(screen.getByText("Local Administrator")).toBeTruthy();
    expect(screen.getByText("admin")).toBeTruthy();
    expect(screen.getByText("Platform administrator")).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Account" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Manage users" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeTruthy();
  });

  it("shows the project identity without platform user management", () => {
    identity.role = "user";
    identity.project_id = "projectC";
    render(<AccountMenu placement="header" />);
    fireEvent.click(screen.getByRole("button", { name: "Open account menu for Local Administrator" }));
    expect(screen.getByText("Project: projectC")).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Manage users" })).toBeNull();
    expect(screen.queryByText("Platform administrator")).toBeNull();
  });
});
