import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ControlPlaneLayout } from "./layout";

vi.mock("@/components/project-initialization", () => ({ProjectInitializationGate: ({children}: {children: ReactNode}) => children}));
vi.mock("@/components/project-route-selection", () => ({ProjectRouteSelection: ({projectId}: {projectId: string}) => <div>Switch project {projectId}</div>}));

let pathname = "/test1";
let projectId: string | null = "test1";
let role = "user";
type SessionState = "authenticated" | "anonymous" | "loading" | "error";
let sessionState: SessionState = "authenticated";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
  Navigate: ({ to, params }: { to: string; params?: {projectId: string} }) => <div>Redirect {to.replace("$projectId", params?.projectId ?? "")}</div>,
  Outlet: () => <div>Page content</div>,
  useRouterState: ({select}: {select: (state: {location: {pathname: string}}) => unknown}) => select({location: {pathname}}),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    isLoading: sessionState === "loading",
    status: sessionState === "loading" || sessionState === "error" ? undefined : { authenticated: sessionState === "authenticated" },
    user: sessionState === "authenticated" ? { role, project_id: projectId } : null,
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
  afterEach(() => { cleanup(); pathname = "/test1"; projectId = "test1"; role = "user"; sessionState = "authenticated"; });

  it("lands administrators in Platform", () => {
    pathname = "/"; role = "admin"; projectId = null;
    render(<ControlPlaneLayout />);
    expect(screen.getByText("Redirect /settings/providers")).toBeTruthy();
    expect(screen.queryByText("Page content")).toBeNull();
  });

  it("lands users at their project root", () => {
    pathname = "/"; render(<ControlPlaneLayout />);
    expect(screen.getByText("Redirect /test1")).toBeTruthy();
  });

  it.each(["/test1", "/test1/guardrails", "/test1/playground", "/test1/policy-library", "/test1/integration/routers", "/test1/integration/endpoints", "/test1/logs", "/test1/billing", "/test1/sharing", "/test1/settings/health", "/test1/settings/runner", "/test1/settings/version", "/account", "/account/security", "/account/access-tokens"])("mounts authorized user page %s", path => {
    pathname = path; render(<ControlPlaneLayout />);
    expect(screen.getByText("Page content")).toBeTruthy();
  });

  it("uses the project page for breadcrumbs", () => {
    pathname = "/test1/guardrails"; render(<ControlPlaneLayout />);
    expect(screen.getByText("Guardrail Design")).toBeTruthy();
    expect(screen.getByText("Guardrails")).toBeTruthy();
  });

  it("resolves the URL project before mounting the sidebar and resource queries", () => {
    pathname = "/test2/playground"; render(<ControlPlaneLayout />);
    expect(screen.getByText("Switch project test2")).toBeTruthy();
    expect(screen.queryByText("Page content")).toBeNull();
    expect(screen.queryByText("Navigation")).toBeNull();
  });

  it.each(["/test1", "/test1/guardrails", "/test1/settings/runner"])("prevents administrators from mounting project page %s", path => {
    role = "admin"; projectId = null; pathname = path;
    render(<ControlPlaneLayout />);
    expect(screen.queryByText("Page content")).toBeNull();
    expect(screen.getByRole("link", { name: "Platform" }).getAttribute("href")).toBe("/settings/providers");
  });

  it.each(["/settings/models", "/settings/protection-capabilities", "/settings/runner", "/access/projects", "/access", "/audit-log"])("prevents users from mounting platform page %s", path => {
    pathname = path; render(<ControlPlaneLayout />);
    expect(screen.queryByText("Page content")).toBeNull();
    expect(screen.getByRole("link", { name: "Dashboard" }).getAttribute("href")).toBe("/");
  });

  it.each(["/settings/health", "/settings/runner", "/settings/version"])("allows administrators to open %s under platform operations", path => {
    pathname = path; role = "admin"; projectId = null; render(<ControlPlaneLayout />);
    expect(screen.getByText("Platform operations")).toBeTruthy();
    expect(screen.getByText("Page content")).toBeTruthy();
  });

  it.each<SessionState>(["anonymous", "loading", "error"])("does not mount resources with an %s session", state => {
    sessionState = state; render(<ControlPlaneLayout />);
    expect(screen.queryByText("Page content")).toBeNull();
    expect(screen.getByText(state === "loading" ? "Checking your session…" : "Sign in")).toBeTruthy();
  });

  describe.each<SessionState>(["authenticated", "anonymous", "loading", "error"])("documentation with an %s session", state => {
    it.each(["/document", "/document/", "/document/overview/quickstart-protection", "/document/operator/operator-create-policy"])("renders %s without authentication", path => {
      pathname = path; sessionState = state; render(<ControlPlaneLayout />);
      expect(screen.getByText("Standalone documentation")).toBeTruthy();
      expect(screen.queryByText("Sign in")).toBeNull();
      expect(screen.queryByText("Navigation")).toBeNull();
    });
  });
});
