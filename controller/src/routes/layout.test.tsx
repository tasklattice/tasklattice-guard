import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ControlPlaneLayout } from "./layout";

vi.mock("@tanstack/react-router", () => ({
  Outlet: () => <div>Page content</div>,
  useRouterState: () => "/dashboard",
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    isLoading: false,
    status: { authenticated: true },
    user: { role: "admin", display_name: "Administrator" },
  }),
}));

vi.mock("@/components/account-menu", () => ({
  AccountMenu: ({ placement }: { placement?: string }) => <button type="button">Account menu · {placement}</button>,
}));
vi.mock("@/components/control-plane-sidebar", () => ({ ControlPlaneSidebar: () => <aside>Navigation</aside> }));
vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("@/components/ui/sidebar", () => ({
  SidebarProvider: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarInset: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarTrigger: () => <button type="button">Toggle navigation</button>,
}));
vi.mock("@/routes/login", () => ({ LoginPage: () => null }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      "nav.home": "Home",
      "nav.dashboard": "Dashboard",
      "auth.sessionLoading": "Checking your session…",
    } as Record<string, string>)[key] ?? key,
  }),
}));

describe("ControlPlaneLayout", () => {
  afterEach(cleanup);

  it("places the account avatar menu in the top application header", () => {
    render(<ControlPlaneLayout />);

    expect(screen.getByRole("button", { name: "Account menu · header" })).toBeTruthy();
    expect(screen.getByText("Page content")).toBeTruthy();
  });
});
