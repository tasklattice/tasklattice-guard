import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";

import i18n from "@/i18n";

import { ControlPlaneSidebar } from "./control-plane-sidebar";

const identity = vi.hoisted(() => ({ role: "admin" }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: identity.role } }) }));

const queryData = vi.hoisted(() => ({ value: { items: [] } as Record<string, unknown> }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: queryData.value }),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => string }) => select({ location: { pathname: "/policy-library" } }),
}));

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));

describe("ControlPlaneSidebar", () => {
  afterEach(() => { cleanup(); identity.role = "admin"; queryData.value = { items: [] }; });

  beforeEach(async () => { await i18n.changeLanguage("en"); });

  it("groups administrator pages by model services, platform operations and governance", () => {
    render(<SidebarProvider><TooltipProvider><ControlPlaneSidebar /></TooltipProvider></SidebarProvider>);
    const expected = {
      Providers: "/settings/providers",
      Models: "/settings/models", "Guardrail Catalog": "/settings/guardrail-catalog",
      Health: "/settings/health", Runner: "/settings/runner", Version: "/settings/version",
      "Users & access": "/access", "Audit log": "/audit-log",
    };
    for (const [label, path] of Object.entries(expected)) expect(screen.getByRole("link", { name: label }).getAttribute("href")).toBe(path);
    const groups = {
      "Models & detection": ["Providers", "Models", "Guardrail Catalog"],
      "Platform operations": ["Health", "Runner", "Version"],
      "Access & audit": ["Users & access", "Audit log"],
    };
    for (const [label, links] of Object.entries(groups)) {
      const group = screen.getByText(label).closest('[data-sidebar="group"]') as HTMLElement;
      expect(within(group).getAllByRole("link").map(link => link.textContent)).toEqual(links);
    }
    for (const label of ["Guardrails", "Playground", "Policy Library", "Routers", "Endpoints", "Runtime logs", "Settings", "Billing"]) expect(screen.queryByRole("link", { name: label })).toBeNull();
    expect(document.body.textContent).not.toContain("Guardrail Design");
    expect(document.body.textContent).not.toContain("Integration");
    expect(document.body.textContent).not.toContain("Runtime observability");
    expect(screen.getByRole("link", { name: "TaskLattice Guard" }).getAttribute("href")).toBe("/settings/providers");
    expect(screen.getByRole("link", { name: "Documentation" }).closest('[data-sidebar="footer"]')).toBeTruthy();
  });

  it("shows users workflow groups and runtime observations without platform audit", () => {
    identity.role = "user";
    render(<SidebarProvider><TooltipProvider><ControlPlaneSidebar /></TooltipProvider></SidebarProvider>);
    for (const name of ["Guardrails", "Playground", "Policy Library", "Routers", "Endpoints", "Runtime logs", "Billing", "Settings", "Documentation"]) expect(screen.getByRole("link", { name })).toBeTruthy();
    for (const name of ["Health", "Runner", "Providers", "Models", "Guardrail Catalog", "Version", "Users & access", "Audit log"]) expect(screen.queryByRole("link", { name })).toBeNull();
    expect(screen.getByRole("link", { name: "TaskLattice Guard" }).getAttribute("href")).toBe("/dashboard");
    expect(screen.getByRole("link", { name: "Runtime logs" }).getAttribute("href")).toBe("/logs");
    const observability = screen.getByText("Runtime observability").closest('[data-sidebar="group"]') as HTMLElement;
    expect(within(observability).getAllByRole("link").map(link => link.textContent)).toEqual(["Runtime logs", "Billing"]);
    expect(screen.getByRole("link", { name: "Billing" }).getAttribute("href")).toBe("/billing");
    expect(screen.getByRole("link", { name: "Settings" }).getAttribute("href")).toBe("/settings/health");
    expect(screen.getByRole("link", { name: "Settings" }).closest('[data-sidebar="footer"]')).toBeTruthy();
    expect(document.body.textContent).not.toContain("Platform");
  });

  it("keeps the dashboard reachable from the collapsed tenant sidebar", () => {
    identity.role = "user";
    render(<SidebarProvider defaultOpen={false}><TooltipProvider><ControlPlaneSidebar /></TooltipProvider></SidebarProvider>);
    expect(screen.getByRole("link", { name: "TaskLattice Guard" }).getAttribute("href")).toBe("/dashboard");
    expect(screen.getByRole("link", { name: "Guardrails" }).getAttribute("href")).toBe("/guardrails");
  });

  it("updates Chinese labels and collapsed accessible names when switching languages", async () => {
    render(<SidebarProvider><ControlPlaneSidebar /><SidebarTrigger /></SidebarProvider>);
    expect(screen.getByRole("link", { name: "Providers" })).toBeTruthy();
    await act(async () => { await i18n.changeLanguage("zh-CN"); });
    for (const name of ["模型与检测", "平台运行", "访问与审计"]) expect(screen.getByText(name)).toBeTruthy();
    const paths = { "模型提供商": "/settings/providers", "检测器目录": "/settings/guardrail-catalog", "健康": "/settings/health", "执行节点": "/settings/runner", "版本": "/settings/version" };
    for (const [name, path] of Object.entries(paths)) expect(screen.getByRole("link", { name }).getAttribute("href")).toBe(path);
    for (const name of ["Providers", "Provider", "Guardrail Catalog", "Runner"]) expect(screen.queryByRole("link", { name })).toBeNull();
    const rail = document.querySelector('[data-sidebar="rail"]');
    fireEvent.click(screen.getAllByRole("button", { name: "展开或收起导航" }).find(button => button !== rail)!);
    for (const name of Object.keys(paths)) expect(screen.getByRole("link", { name }).getAttribute("aria-label")).toBe(name);
    await act(async () => { await i18n.changeLanguage("en"); });
    for (const name of ["Providers", "Guardrail Catalog", "Health", "Runner", "Version"]) expect(screen.getByRole("link", { name }).getAttribute("aria-label")).toBe(name);
  });

  it("localizes every tenant navigation group and entry in Chinese", async () => {
    identity.role = "user";
    await i18n.changeLanguage("zh-CN");
    render(<SidebarProvider><ControlPlaneSidebar /></SidebarProvider>);
    for (const name of ["护栏设计", "集成", "运行观测"]) expect(screen.getByText(name)).toBeTruthy();
    for (const name of ["安全护栏", "调试场", "策略库", "路由器", "端点", "运行日志", "账单", "设置", "文档"]) expect(screen.getByRole("link", { name })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "审计日志" })).toBeNull();
  });

  it("preserves explicit collapse controls without expanding on hover", () => {
    const { container } = render(
      <SidebarProvider>
        <ControlPlaneSidebar />
        <SidebarTrigger />
      </SidebarProvider>,
    );
    const sidebar = container.querySelector('[data-slot="sidebar"]')!;
    const rail = container.querySelector<HTMLButtonElement>('[data-sidebar="rail"]')!;
    const toggle = screen.getAllByRole("button", { name: "Toggle navigation" }).find(button => button !== rail)!;
    expect(screen.getByRole("link", { name: "TaskLattice Guard" }).closest('[data-sidebar="header"]')).not.toBeNull();
    expect(sidebar.getAttribute("data-state")).toBe("expanded");
    fireEvent.click(toggle);
    expect(sidebar.getAttribute("data-state")).toBe("collapsed");
    fireEvent.mouseEnter(sidebar);
    expect(sidebar.getAttribute("data-state")).toBe("collapsed");
    fireEvent.click(rail);
    expect(sidebar.getAttribute("data-state")).toBe("expanded");
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(sidebar.getAttribute("data-state")).toBe("collapsed");
    fireEvent.keyDown(window, { key: "b", metaKey: true });
    expect(sidebar.getAttribute("data-state")).toBe("expanded");
  });

});
