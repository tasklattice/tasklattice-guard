import { cleanup, render, screen } from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsNavigation } from "./settings-navigation";
const identity = vi.hoisted(() => ({ role: "user" }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: identity.role } }) }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => string }) => select({ location: { pathname: "/settings/runner" } }),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => { cleanup(); identity.role = "user"; });
it("offers exactly Health, Runner and Version to project users", () => {
  render(<SettingsNavigation />);
  expect(screen.getAllByRole("tab").map(tab => tab.getAttribute("href"))).toEqual(["/settings/health", "/settings/runner", "/settings/version"]);
  expect(screen.getByRole("tab", { name: "nav.runner" }).getAttribute("aria-selected")).toBe("true");
});
it("uses the administrator sidebar without repeating operational tabs", () => {
  identity.role = "admin";
  render(<SettingsNavigation />);
  expect(screen.queryByRole("tablist")).toBeNull();
});
