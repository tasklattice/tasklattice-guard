import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ControlPlaneLayout } from "./layout";

vi.mock("@/components/project-initialization", () => ({ProjectInitializationGate: ({children}: {children: ReactNode}) => children}));

let pathname = "/dashboard";
let role = "admin";
type SessionState = "authenticated" | "anonymous" | "loading" | "error";
let sessionState: SessionState = "authenticated";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
  Navigate: ({ to }: { to: string }) => <div>Redirect {to}</div>,
  Outlet: () => <div>Page content</div>,
  useRouterState: () => pathname,
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    isLoading: sessionState === "loading",
    status: sessionState === "loading" || sessionState === "error" ? undefined : { authenticated: sessionState === "authenticated" },
    user: sessionState === "authenticated" ? { role, display_name: "Administrator" } : null,
    error: sessionState === "error" ? new Error("Session unavailable") : null,
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
vi.mock("@/routes/login", () => ({ LoginPage: () => <main>Sign in</main> }));
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
      "nav.peopleProjects": "People & projects",
      "nav.runtimeObservations": "Observability",
      "nav.runner": "Runner",
      "auth.sessionLoading": "Checking your session…",
    } as Record<string, string>)[key] ?? key,
  }),
}));

describe("ControlPlaneLayout", () => {
  afterEach(() => { cleanup(); pathname = "/dashboard"; role = "admin"; sessionState = "authenticated"; });

  it("lands administrators in Platform", () => {
    render(<ControlPlaneLayout />);
    expect(screen.getByText("Redirect /settings/providers")).toBeTruthy();
    expect(screen.queryByText("Page content")).toBeNull();
  });

  it.each(["/dashboard/", "/guardrails", "/guardrails/id", "/playground", "/policy-library", "/integration/routers", "/integration/endpoints", "/logs", "/billing", "/sharing"])("prevents administrators from mounting %s", path => {
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

  it.each(["/settings/models", "/settings/guardrail-catalog", "/access/projects", "/access", "/audit-log"])("prevents a user from mounting %s", path => {
    role = "user"; pathname = path;
    render(<ControlPlaneLayout />);
    expect(screen.queryByText("Page content")).toBeNull();
    expect(screen.getByRole("link", { name: "Guardrails" }).getAttribute("href")).toBe("/guardrails");
  });
  it.each(["/guardrails", "/playground", "/policy-library", "/integration/routers", "/integration/endpoints", "/logs", "/billing", "/sharing", "/account", "/account/security", "/account/access-tokens", "/settings", "/settings/", "/settings/health", "/settings/runner", "/settings/runner/", "/settings/version"])("allows a user to mount %s", path => {
    role = "user"; pathname = path; render(<ControlPlaneLayout />);
    expect(screen.getByText("Page content")).toBeTruthy();
  });
  it.each(["/dashboard", "/dashboard/"])("mounts the project dashboard at %s without redirecting to Guardrails", path => {
    pathname = path;
    role = "user"; render(<ControlPlaneLayout />);
    expect(screen.getByText("Page content")).toBeTruthy();
    expect(screen.getByText("Dashboard")).toBeTruthy();
    expect(screen.queryByText("Redirect /guardrails")).toBeNull();
  });

  it("keeps the root landing route separate from the dashboard", () => {
    pathname = "/"; role = "user"; render(<ControlPlaneLayout />);
    expect(screen.getByText("Redirect /guardrails")).toBeTruthy();
    expect(screen.queryByText("Page content")).toBeNull();
  });

  it.each<SessionState>(["anonymous", "loading", "error"])("does not mount dashboard data with an %s session", state => {
    role = "user"; sessionState = state; render(<ControlPlaneLayout />);
    expect(screen.queryByText("Page content")).toBeNull();
    expect(screen.getByText(state === "loading" ? "Checking your session…" : "Sign in")).toBeTruthy();
  });

  it("unmounts the dashboard when runtime permission is revoked", () => {
    role = "user";
    const view = render(<ControlPlaneLayout />);
    expect(screen.getByText("Page content")).toBeTruthy();
    role = "admin";
    view.rerender(<ControlPlaneLayout />);
    expect(screen.queryByText("Page content")).toBeNull();
    expect(screen.getByText("Redirect /settings/providers")).toBeTruthy();
  });

  it.each(["/settings/health", "/settings/runner", "/settings/version"])("allows administrators to open %s under platform operations", path => {
    pathname = path;
    role = "admin";
    render(<ControlPlaneLayout />);

    expect(screen.getByText("Platform operations")).toBeTruthy();
    expect(screen.getByText("Page content")).toBeTruthy();
  });


  describe.each<SessionState>(["authenticated", "anonymous", "loading", "error"])("documentation with an %s session", state => {
    it.each(["/document", "/document/", "/document/overview/quickstart-protection", "/document/operator/operator-create-policy"])("renders %s without waiting for authentication", path => {
      pathname = path;
      sessionState = state;
      render(<ControlPlaneLayout />);

      expect(screen.getByText("Standalone documentation")).toBeTruthy();
      expect(screen.queryByText("Sign in")).toBeNull();
      expect(screen.queryByText("Checking your session…")).toBeNull();
      expect(screen.queryByText("Navigation")).toBeNull();
      expect(screen.queryByRole("button", { name: "Account menu · header" })).toBeNull();
    });
  });

  it.each(["/guardrails", "/account", "/settings/providers", "/document-private", "/help", "/help/", "/help-private"])("requires login outside documentation at %s", path => {
    pathname = path;
    sessionState = "anonymous";
    render(<ControlPlaneLayout />);

    expect(screen.getByText("Sign in")).toBeTruthy();
    expect(screen.queryByText("Standalone documentation")).toBeNull();
    expect(screen.queryByText("Page content")).toBeNull();
  });

  it("waits for the session before mounting a management page", () => {
    pathname = "/guardrails";
    sessionState = "loading";
    render(<ControlPlaneLayout />);

    expect(screen.getByText("Checking your session…")).toBeTruthy();
    expect(screen.queryByText("Page content")).toBeNull();
  });
});
