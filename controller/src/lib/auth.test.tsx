import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "./auth";
import { queryKeys } from "@/features/query-keys";
import type { AuthStatus, IdentityUser } from "./identity-api";

const mocks = vi.hoisted(() => ({ getAuthStatus: vi.fn(), login: vi.fn() }));
vi.mock("./identity-api", () => ({
  getAuthStatus: mocks.getAuthStatus, login: mocks.login, logout: vi.fn(), updateMe: vi.fn(),
}));
vi.mock("@/i18n", () => ({ default: { language: "en" }, setApplicationLanguage: vi.fn() }));

const user: IdentityUser = { id: "first", display_name: "First", username: "first", role: "admin",
  enabled: true, preferred_language: "en", last_login_at: null, created_at: "2026-09-06", updated_at: "2026-09-06" };
function Probe() { const auth = useAuth(); return <><p>{auth.user ? `${auth.user.id}:${auth.user.role}` : "signed-out"}</p>
  <button onClick={() => void auth.login({ username: "second", password: "test-only" })}>Sign in</button></>; }
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("Authenticated cache boundaries", () => {
  it.each([
    { authenticated: false, user: null },
    { authenticated: true, user: { ...user, id: "second" } },
    { authenticated: true, user: { ...user, role: "user" as const } },
  ])("clears prior resource data before exposing changed identity $user.id", async (next: AuthStatus) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKeys.auth, { authenticated: true, user });
    client.setQueryData(queryKeys.guardrails, { items: ["prior-private-guardrail"] });
    client.setQueryData(queryKeys.users, { users: ["prior-private-user"] });
    mocks.getAuthStatus.mockResolvedValue(next);
    render(<QueryClientProvider client={client}><AuthProvider><Probe /></AuthProvider></QueryClientProvider>);
    expect(screen.getByText("first:admin")).toBeTruthy();
    window.dispatchEvent(new CustomEvent("tasklattice:unauthorized"));
    await waitFor(() => expect(screen.getByText(next.user ? `${next.user.id}:${next.user.role}` : "signed-out")).toBeTruthy());
    expect(client.getQueryData(queryKeys.guardrails)).toBeUndefined();
    expect(client.getQueryData(queryKeys.users)).toBeUndefined();
    expect(client.getQueryData(queryKeys.auth)).toEqual(next);
    client.clear();
  });

  it("keeps resource data when the same authorized identity is refreshed", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKeys.auth, { authenticated: true, user });
    client.setQueryData(queryKeys.guardrails, { items: ["retained"] });
    mocks.getAuthStatus.mockResolvedValue({ authenticated: true, user: { ...user, display_name: "Renamed" } });
    render(<QueryClientProvider client={client}><AuthProvider><Probe /></AuthProvider></QueryClientProvider>);
    await client.invalidateQueries({ queryKey: queryKeys.auth });
    expect(client.getQueryData(queryKeys.guardrails)).toEqual({ items: ["retained"] });
    client.clear();
  });

  it("does not restore a cancelled prior-account query when its response arrives late", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKeys.auth, { authenticated: true, user });
    let finish!: (value: unknown) => void;
    const pending = client.fetchQuery({ queryKey: queryKeys.guardrails, queryFn: () => new Promise(resolve => { finish = resolve; }) }).catch(() => undefined);
    mocks.getAuthStatus.mockResolvedValue({ authenticated: false, user: null });
    render(<QueryClientProvider client={client}><AuthProvider><Probe /></AuthProvider></QueryClientProvider>);
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.auth }); });
    finish({ items: ["late-private-data"] });
    await pending;
    await waitFor(() => expect(screen.getByText("signed-out")).toBeTruthy());
    expect(client.getQueryData(queryKeys.guardrails)).toBeUndefined();
    client.clear();
  });

  it("clears resource caches on explicit account login and ignores an older session response", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKeys.auth, { authenticated: true, user });
    client.setQueryData(queryKeys.users, { users: ["prior-private-user"] });
    let finish!: (value: AuthStatus) => void;
    mocks.getAuthStatus.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    mocks.login.mockResolvedValue({ user: { ...user, id: "second" } });
    render(<QueryClientProvider client={client}><AuthProvider><Probe /></AuthProvider></QueryClientProvider>);
    const pending = client.invalidateQueries({ queryKey: queryKeys.auth });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.getByText("second:admin")).toBeTruthy());
    expect(client.getQueryData(queryKeys.users)).toBeUndefined();
    client.setQueryData(queryKeys.guardrails, { items: ["second-account-data"] });
    await act(async () => { finish({ authenticated: true, user }); await pending; });
    expect(screen.getByText("second:admin")).toBeTruthy();
    expect(client.getQueryData(queryKeys.guardrails)).toEqual({ items: ["second-account-data"] });
    client.clear();
  });
});
