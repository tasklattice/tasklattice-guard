import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import i18n from "@/i18n";
import { ProjectSwitcher } from "./project-switcher";

const mocks = vi.hoisted(() => ({
  user: { id: "member", role: "user", project_id: "test1" as string | null },
  list: vi.fn(), select: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock("@/lib/projects-api", () => ({ listMyProjects: (...args: unknown[]) => mocks.list(...args), selectProject: (...args: unknown[]) => mocks.select(...args) }));
// jsdom has no geometry: exercise Carbon's focus behavior here, and its floating
// placement/visibility in the real desktop browser.
vi.mock("@carbon/react", async importOriginal => {
  const carbon = await importOriginal<typeof import("@carbon/react")>();
  return { ...carbon, Popover: (props: ComponentProps<typeof carbon.Popover>) => <carbon.Popover {...props} autoAlign={false} /> };
});
let client: QueryClient;
function mount(collapsed = false) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><ProjectSwitcher collapsed={collapsed} /></QueryClientProvider>);
}
const project = (id: string) => ({ id, name: id });
const trigger = () => screen.getByRole("button", { name: "Switch project: test1" });
beforeEach(async () => {
  await i18n.changeLanguage("en");
  mocks.user.role = "user"; mocks.user.project_id = "test1";
  mocks.list.mockResolvedValue({ items: [project("test1"), project("test2")], nextCursor: null });
});
afterEach(() => { cleanup(); client?.clear(); vi.resetAllMocks(); });

it("loads a bounded directory only when opened and keeps choosing the current project a no-op", async () => {
  mount();
  expect(mocks.list).not.toHaveBeenCalled();
  fireEvent.click(trigger());
  const current = await screen.findByRole("button", { name: "test1", exact: true });
  expect(current.getAttribute("aria-current")).toBe("true");
  expect(mocks.list).toHaveBeenCalledWith({ q: "", cursor: undefined, limit: 25 }, expect.any(AbortSignal));
  expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
  fireEvent.click(current);
  expect(mocks.select).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger());
});

it("pages on the server and resets the cursor when searching", async () => {
  mocks.list.mockImplementation(async ({ q, cursor }) => q
    ? { items: [project("matching-project")], nextCursor: null }
    : cursor ? { items: [project("test2")], nextCursor: null }
    : { items: [project("test1")], nextCursor: "test1" });
  mount(); fireEvent.click(trigger());
  fireEvent.click(await screen.findByRole("button", { name: "Next" }));
  expect(await screen.findByRole("button", { name: "test2" })).toBeTruthy();
  expect(mocks.list).toHaveBeenLastCalledWith({ q: "", cursor: "test1", limit: 25 }, expect.any(AbortSignal));
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "matching" } });
  expect(await screen.findByRole("button", { name: "matching-project" })).toBeTruthy();
  expect(mocks.list).toHaveBeenLastCalledWith({ q: "matching", cursor: undefined, limit: 25 }, expect.any(AbortSignal));
  expect(screen.queryByRole("button", { name: "Previous" })).toBeNull();
});

it("keeps the current identity after a failed switch and allows retry without concurrent requests", async () => {
  mocks.select.mockRejectedValueOnce(new Error("Session update failed"));
  mount(); fireEvent.click(trigger());
  fireEvent.click(await screen.findByRole("button", { name: "test2" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Could not switch project. Try again.");
  expect(trigger()).toBeTruthy();
  mocks.select.mockImplementationOnce(() => new Promise(() => {}));
  fireEvent.click(screen.getByRole("button", { name: "test2" }));
  await waitFor(() => expect(mocks.select).toHaveBeenCalledTimes(2));
  expect(mocks.select).toHaveBeenLastCalledWith("test2");
  expect(screen.getByRole("searchbox")).toHaveProperty("disabled", true);
  for (const button of within(screen.getByRole("dialog")).getAllByRole("button")) expect(button).toHaveProperty("disabled", true);
});

it("supports keyboard navigation and restores focus after Escape, including when collapsed", async () => {
  mount(true); fireEvent.click(trigger());
  const second = await screen.findByRole("button", { name: "test2" });
  const input = screen.getByRole("searchbox");
  expect(document.activeElement).toBe(input);
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(document.activeElement?.getAttribute("aria-current")).toBe("true");
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  expect(document.activeElement).toBe(second);
  fireEvent.keyDown(second, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger());
  expect(trigger().getAttribute("title")).toBe("test1");
});

it("offers retry after a directory error and explains an empty membership list", async () => {
  mocks.list.mockRejectedValueOnce(new Error("Unavailable"));
  mount(); fireEvent.click(trigger());
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Could not load projects.");
  mocks.list.mockResolvedValueOnce({ items: [], nextCursor: null });
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("No projects available. Contact your administrator for access.")).toBeTruthy();
});

it("does not expose a Project switcher or request memberships for platform administrators", () => {
  mocks.user.role = "admin";
  mount();
  expect(screen.queryByRole("button")).toBeNull();
  expect(mocks.list).not.toHaveBeenCalled();
});
