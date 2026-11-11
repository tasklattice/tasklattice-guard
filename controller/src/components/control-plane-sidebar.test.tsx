import { setCurrentProjectId } from "@/lib/project-context";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useQuery } from "@tanstack/react-query";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";

import i18n from "@/i18n";

import { ControlPlaneSidebar } from "./control-plane-sidebar";
import * as controllerApi from "@/lib/controller-api";

const identity = vi.hoisted(() => ({ role: "admin", project_id: "projectA" }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: identity.role, project_id: identity.project_id } }) }));

const queryData = vi.hoisted(() => ({ value: { items: [] } as Record<string, unknown> }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(() => ({ data: queryData.value })),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; params?: { projectId: string }; children: ReactNode }) => <a href={to.replace("$projectId", params?.projectId ?? "")} {...props}>{children}</a>,
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => string }) => select({ location: { pathname: "/policy-library" } }),
}));

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));

describe("ControlPlaneSidebar", () => {
  afterEach(() => { cleanup(); identity.role = "admin"; identity.project_id = "projectA"; vi.clearAllMocks(); queryData.value = { items: [] }; });

  beforeEach(async () => { setCurrentProjectId("projectA"); await i18n.changeLanguage("en"); });

  it("groups administrator pages by people and projects, model services and platform operations", () => {
    render(<SidebarProvider><TooltipProvider><ControlPlaneSidebar /></TooltipProvider></SidebarProvider>);
    const expected = {
      Providers: "/settings/providers",
      Models: "/settings/models", "Protection Capabilities": "/settings/protection-capabilities",
      Health: "/settings/health", Runner: "/settings/runner", Version: "/settings/version",
      Projects: "/access/projects", "Users": "/access", "Audit log": "/audit-log",
    };
    for (const [label, path] of Object.entries(expected)) expect(screen.getByRole("link", { name: label }).getAttribute("href")).toBe(path);
    const groups = {
      "Models & detection": ["Providers", "Models", "Protection Capabilities"],
      "Platform operations": ["Runner", "Health", "Audit log", "Version"],
      "People & projects": ["Users", "Projects"],
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
    for (const name of ["Sharing", "Runner", "Health", "Models", "Providers", "Protection Capabilities", "Project runtime groups", "Version", "Users", "Audit log"]) expect(screen.queryByRole("link", { name })).toBeNull();
    expect(screen.getByRole("link", { name: "TaskLattice Guard" }).getAttribute("href")).toBe("/projectA");
    expect(screen.getByRole("link", { name: "Runtime logs" }).getAttribute("href")).toBe("/projectA/logs");
    const observability = screen.getByText("Runtime observability").closest('[data-sidebar="group"]') as HTMLElement;
    expect(within(observability).getAllByRole("link").map(link => link.textContent)).toEqual(["Runtime logs", "Billing"]);
    expect(screen.getByRole("link", { name: "Billing" }).getAttribute("href")).toBe("/projectA/billing");
    expect(screen.queryByText("System")).toBeNull();
    expect(screen.getByRole("link", { name: "Settings" }).getAttribute("href")).toBe("/projectA/settings/health");
    expect(document.body.textContent).not.toContain("Platform");
  });

  it("refreshes the active project and scopes count queries when the identity changes", () => {
    identity.role = "user";
    queryData.value = { items: [{ id: "projectA-private" }, { id: "projectA-shared" }] };
    const view = render(<SidebarProvider><ControlPlaneSidebar /></SidebarProvider>);
    expect(screen.getByRole("button", { name: "Switch project: projectA" })).toBeTruthy();
    expect(screen.queryByText("Active project")).toBeNull();
    identity.project_id = "projectB";
    queryData.value = { items: [{ id: "projectB-owned" }] };
    view.rerender(<SidebarProvider><ControlPlaneSidebar /></SidebarProvider>);
    expect(screen.getByRole("button", { name: "Switch project: projectB" })).toBeTruthy();
    expect(screen.queryByText("projectA")).toBeNull();
    const calls = vi.mocked(useQuery).mock.calls;
    for (const [options] of calls.slice(-3)) expect(options.queryKey).toContain("projectB");
    expect([...document.querySelectorAll('[data-sidebar="menu-badge"]')].map(badge => badge.textContent)).toEqual(["1", "1", "1"]);
  });

  it("keeps the dashboard reachable from the collapsed project sidebar", () => {
    identity.role = "user";
    render(<SidebarProvider defaultOpen={false}><TooltipProvider><ControlPlaneSidebar /></TooltipProvider></SidebarProvider>);
    expect(screen.getByRole("link", { name: "TaskLattice Guard" }).getAttribute("href")).toBe("/projectA");
    expect(screen.getByRole("link", { name: "Guardrails" }).getAttribute("href")).toBe("/projectA/guardrails");
  });

  it("loads selector definitions for badges without billing or endpoint activity", async () => {
    identity.role = "user";
    const options = vi.spyOn(controllerApi, "listGuardrailOptions").mockResolvedValue({ items: [], count: 0 });
    try {
      render(<SidebarProvider><ControlPlaneSidebar /></SidebarProvider>);
      const queries = vi.mocked(useQuery).mock.calls.map(([query]) => query);
      const guard = queries.find(query => query.queryKey.includes("options"))!;
      await (guard.queryFn as (context: { signal: AbortSignal }) => Promise<unknown>)({ signal: new AbortController().signal });
      expect(options).toHaveBeenCalledOnce();
      expect(queries.find(query => query.queryKey.includes("definitions"))!.queryFn).toBe(controllerApi.listControllerEndpoints);
    } finally { options.mockRestore(); }
  });

  it("updates Chinese labels and collapsed accessible names when switching languages", async () => {
    render(<SidebarProvider><ControlPlaneSidebar /><SidebarTrigger /></SidebarProvider>);
    expect(screen.getByRole("link", { name: "Providers" })).toBeTruthy();
    await act(async () => { await i18n.changeLanguage("zh-CN"); });
    for (const name of ["模型与检测", "平台运行", "人员与项目"]) expect(screen.getByText(name)).toBeTruthy();
    const paths = { "模型提供商": "/settings/providers", "防护能力": "/settings/protection-capabilities", "健康": "/settings/health", "执行节点": "/settings/runner", "版本": "/settings/version" };
    for (const [name, path] of Object.entries(paths)) expect(screen.getByRole("link", { name }).getAttribute("href")).toBe(path);
    for (const name of ["Providers", "Provider", "Protection Capabilities", "Runner"]) expect(screen.queryByRole("link", { name })).toBeNull();
    const rail = document.querySelector('[data-sidebar="rail"]');
    fireEvent.click(screen.getAllByRole("button", { name: "展开或收起导航" }).find(button => button !== rail)!);
    for (const name of Object.keys(paths)) expect(screen.getByRole("link", { name }).getAttribute("aria-label")).toBe(name);
    await act(async () => { await i18n.changeLanguage("en"); });
    for (const name of ["Providers", "Protection Capabilities", "Health", "Runner", "Version"]) expect(screen.getByRole("link", { name }).getAttribute("aria-label")).toBe(name);
  });

  it("localizes every project navigation group and entry in Chinese", async () => {
    identity.role = "user";
    await i18n.changeLanguage("zh-CN");
    render(<SidebarProvider><ControlPlaneSidebar /></SidebarProvider>);
    for (const name of ["护栏设计", "集成", "运行观测"]) expect(screen.getByText(name)).toBeTruthy();
    for (const name of ["安全护栏", "调试场", "策略库", "路由器", "端点", "运行日志", "账单", "设置", "文档"]) expect(screen.getByRole("link", { name })).toBeTruthy();
    expect(screen.queryByText("系统")).toBeNull();
    for (const name of ["资源共享", "执行节点"]) expect(screen.queryByRole("link", { name })).toBeNull();
    expect(screen.queryByRole("link", { name: "模型" })).toBeNull();
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
