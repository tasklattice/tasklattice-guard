import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessTokens } from "./access-tokens";
import i18n from "@/i18n";
const state = vi.hoisted(() => ({ role: "user", list: vi.fn(), create: vi.fn(), revoke: vi.fn() }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: "owner", role: state.role, project_id: "projectA" } }) }));
vi.mock("@/lib/access-tokens-api", () => ({ listAccessTokens: state.list, createAccessToken: state.create, revokeAccessToken: state.revoke }));
const token = { id: "token", name: "CI", prefix: "tlg_pat_abcdefg", permissions: { routers: "read" }, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), lastUsedAt: null, revokedAt: null };
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><AccessTokens /></QueryClientProvider>);
  return client;
}
beforeEach(async () => { await i18n.changeLanguage("en"); vi.clearAllMocks(); state.role = "user"; state.list.mockResolvedValue({ items: [] }); state.create.mockResolvedValue({ token, secret: "synthetic-one-time-secret" }); state.revoke.mockResolvedValue(undefined); });
afterEach(async () => { cleanup(); await i18n.changeLanguage("en"); });
describe("Access token management", () => {
  it("updates the open drawer when the language changes and preserves form values", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));
    fireEvent.change(screen.getByLabelText("Name", { exact: true }), { target: { value: "CI" } });
    fireEvent.change(screen.getByLabelText("Policy Library", { exact: true }), { target: { value: "read" } });
    expect(screen.getByText("1 module selected. The token will be shown only once after creation.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Routers", { exact: true }), { target: { value: "read" } });
    expect(screen.getByText("2 modules selected. The token will be shown only once after creation.")).toBeTruthy();

    await act(async () => { await i18n.changeLanguage("zh-CN"); });
    expect(screen.getByRole("heading", { name: "创建 Access Token" })).toBeTruthy();
    expect(screen.getByText("账户")).toBeTruthy();
    expect((screen.getByLabelText("名称", { exact: true }) as HTMLInputElement).value).toBe("CI");
    expect((screen.getByLabelText("策略库", { exact: true }) as HTMLSelectElement).value).toBe("read");
    expect(screen.getByRole("option", { name: "30 天", exact: true })).toBeTruthy();
    expect(screen.getByText("策略配置、验证与发布")).toBeTruthy();
    expect(screen.getByText("已选择 2 个模块。Token 明文仅在创建后展示一次。")).toBeTruthy();
    expect(state.create).not.toHaveBeenCalled();
  });
  it("translates the revocation label and interpolates the token name in the confirmation", async () => {
    await i18n.changeLanguage("zh-CN");
    state.list.mockResolvedValue({ items: [token] });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "撤销 CI" }));
    expect(screen.getByRole("heading", { name: "撤销 CI？" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "撤销 Token" })).toBeTruthy();
    expect(state.revoke).not.toHaveBeenCalled();
  });

  it("requires explicit permissions, sends selected modules, and clears the one-time secret after closing", async () => {
    const client = mount(); await screen.findByText("No access tokens yet");
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));
    const sheet = screen.getByRole("dialog");
    const submit = within(sheet).getByRole("button", { name: "Create token" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Name", { exact: true }), { target: { value: "CI" } });
    fireEvent.change(screen.getByLabelText("Routers", { exact: true }), { target: { value: "read" } });
    fireEvent.change(screen.getByLabelText("GuardRails", { exact: true }), { target: { value: "write" } });
    fireEvent.click(submit);
    await screen.findByText("Token created");
    expect(state.create).toHaveBeenCalledWith({ name: "CI", expiresInDays: 30, permissions: { routers: "read", guardrails: "write" } });
    expect((screen.getByLabelText("Access Token") as HTMLInputElement).value).toBe("synthetic-one-time-secret");
    expect(JSON.stringify(client.getMutationCache().getAll().map(m => m.state.data))).not.toContain("synthetic-one-time-secret");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByLabelText("Access Token")).toBeNull());
  });
  it("preserves the creation form on failure and supports retry", async () => {
    state.create.mockRejectedValueOnce(new Error("Temporary failure")); mount();
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));
    fireEvent.change(screen.getByLabelText("Name", { exact: true }), { target: { value: "CI" } });
    fireEvent.change(screen.getByLabelText("Routers", { exact: true }), { target: { value: "read" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Create token" }));
    await screen.findByText("Temporary failure");
    expect((screen.getByLabelText("Name", { exact: true }) as HTMLInputElement).value).toBe("CI");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Create token" }));
    await screen.findByText("Token created");
  });
  it("offers users workflow write scopes and read-only Runner access while hiding platform scopes", async () => {
    state.role = "user"; mount();
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));
    expect(within(screen.getByLabelText("Routers", { exact: true })).getByRole("option", { name: "Read and write" })).toBeTruthy();
    expect(within(screen.getByLabelText("Model configuration", { exact: true })).getByRole("option", { name: "Read and write" })).toBeTruthy();
    expect(within(screen.getByLabelText("Runners", { exact: true })).getAllByRole("option").map(option => option.getAttribute("value"))).toEqual(["none", "read"]);
    for (const label of ["Platform settings", "Audit log"]) expect(screen.queryByLabelText(label, { exact: true })).toBeNull();
  });
  it("confirms revocation, shows errors, then updates the list after success", async () => {
    state.list.mockResolvedValue({ items: [token] }); state.revoke.mockRejectedValueOnce(new Error("Revoke failed")); mount();
    fireEvent.click(await screen.findByRole("button", { name: "Revoke CI" }));
    expect(state.revoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Revoke token" }));
    await screen.findByText("Revoke failed");
    state.list.mockResolvedValue({ items: [{ ...token, revokedAt: new Date().toISOString() }] });
    fireEvent.click(screen.getByRole("button", { name: "Revoke token" }));
    await screen.findByText("Revoked");
    expect(state.revoke).toHaveBeenCalledWith("token");
  });
  it("recovers a failed list request", async () => {
    state.list.mockRejectedValueOnce(new Error("List unavailable")); mount();
    await screen.findByText("List unavailable"); fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("No access tokens yet");
  });
});
