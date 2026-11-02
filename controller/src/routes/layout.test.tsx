import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ControlPlaneLayout } from "./layout";

let pathname = "/dashboard";
let role = "admin";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
  Navigate: ({ to }: { to: string }) => <div>Redirect {to}</div>,
  Outlet: () => <div>Page content</div>,
  useRouterState: () => pathname,
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    isLoading: false,
    status: { authenticated: true },
    user: { role, display_name: "Administrator" },
  }),
}));

vi.mock("@/components/account-menu", () => ({
  AccountMenu: ({ placement }: { placement?: string }) => <button type="button">Account menu · {placement}</button>,
}));
vi.mock("@/components/control-plane-sidebar", () => ({ ControlPlaneSidebar: () => <aside>Navigation</aside> }));
vi.mock("@/components/ui/notifications", () => ({ Toaster: () => null }));
vi.mock("@/components/ui/sidebar", () => ({
  SidebarProvider: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarInset: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarTrigger: () => <button type="button">Toggle navigation</button>,
}));
vi.mock("@/routes/login", () => ({ LoginPage: () => null }));
vi.mock("@/routes/help-layout", () => ({ HelpLayout: () => <main>Standalone documentation</main> }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      "nav.home": "Home",
      "nav.dashboard": "Dashboard",
      "nav.guardrailDesign": "Guardrail Design",
      "nav.guardrails": "Guardrails",
      "nav.platform": "Platform",
      "nav.settings": "Settings",
      "nav.platformOperations": "Platform operations",
      "nav.modelServices": "Models & detection",
      "nav.accessAudit": "Access & audit",
      "nav.runtimeObservations": "Observability",
      "nav.runner": "Runner",
      "nav.tenantLoadLab": "Tenant load lab",
      "nav.tenantGroups": "Tenant groups",
      "auth.sessionLoading": "Checking your session…",
    } as Record<string, string>)[key] ?? key,
  }),
}));

describe("ControlPlaneLayout", () => {
  afterEach(() => { cleanup(); pathname = "/dashboard"; role = "admin"; });

  it("lands administrators in Platform", () => {
    render(<ControlPlaneLayout />);
    expect(screen.getByText("Redirect /settings/providers")).toBeTruthy();
    expect(screen.queryByText("Page content")).toBeNull();
  });

  it.each(["/guardrails", "/guardrails/id", "/playground", "/policy-library", "/integration/routers", "/integration/endpoints", "/logs", "/billing", "/sharing"])("prevents administrators from mounting %s", path => {
    pathname = path; render(<ControlPlaneLayout />);
    expect(screen.queryByText("Page content")).toBeNull();
    expect(screen.getByRole("link", { name: "Platform" }).getAttribute("href")).toBe("/settings/providers");
  });

  it("starts sidebar-page breadcrumbs at the navigation group", () => {
    pathname = "/guardrails"; role = "user";
    render(<ControlPlaneLayout />);

    expect(screen.getByText("Guardrail Design")).toBeTruthy();
    expect(screen.getByText("Guardrails")).toBeTruthy();
    expect(screen.queryByText("TaskLattice Guard")).toBeNull();
  });

  it("applies the ordinary authoring boundary to Default", () => {
    pathname = "/guardrails/guardrail-default"; role = "admin";
    render(<ControlPlaneLayout />);
    expect(screen.queryByText("Page content")).toBeNull();
  });

  it.each(["/settings/models", "/settings/guardrail-catalog", "/settings/tenant-load-lab", "/settings/tenant-load-lab/", "/settings/tenant-groups", "/settings/tenant-groups/", "/access", "/audit-log"])("prevents a user from mounting %s", path => {
    role = "user"; pathname = path;
    render(<ControlPlaneLayout />);
    expect(screen.queryByText("Page content")).toBeNull();
    expect(screen.getByRole("link", { name: "Guardrails" }).getAttribute("href")).toBe("/guardrails");
  });
  it.each(["/guardrails", "/playground", "/policy-library", "/integration/routers", "/integration/endpoints", "/logs", "/billing", "/models", "/sharing", "/account", "/settings", "/settings/health", "/settings/runner", "/settings/version"])("allows a user to mount %s", path => {
    role = "user"; pathname = path; render(<ControlPlaneLayout />);
    expect(screen.getByText("Page content")).toBeTruthy();
  });
  it("lands users on Guardrails instead of the platform dashboard", () => {
    role = "user"; render(<ControlPlaneLayout />);
    expect(screen.getByText("Redirect /guardrails")).toBeTruthy();
    expect(screen.queryByText("Page content")).toBeNull();
  });

  it.each([["admin", "Platform operations"], ["user", "Settings"]])("labels the Runner page under the %s navigation group", (accountRole, group) => {
    pathname = "/settings/runner";
    role = accountRole;
    render(<ControlPlaneLayout />);

    expect(screen.getByText(group)).toBeTruthy();
    expect(screen.getByText("Runner")).toBeTruthy();
  });

  it("labels Tenant load lab under Platform operations and mounts the administrator workspace", () => {
    pathname = "/settings/tenant-load-lab";
    render(<ControlPlaneLayout />);
    expect(screen.getByText("Platform operations")).toBeTruthy();
    expect(screen.getByText("Tenant load lab")).toBeTruthy();
    expect(screen.queryByText("Dashboard")).toBeNull();
    expect(screen.getByText("Page content")).toBeTruthy();
  });

  it.each(["/document", "/document/", "/document/overview/quickstart-protection", "/document/operator/operator-create-policy"])("renders %s without the management shell", (path) => {
    pathname = path;
    render(<ControlPlaneLayout />);

    expect(screen.getByText("Standalone documentation")).toBeTruthy();
    expect(screen.queryByText("Navigation")).toBeNull();
    expect(screen.queryByRole("button", { name: "Account menu · header" })).toBeNull();
  });
});
