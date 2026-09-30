import i18n from "@/i18n";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routeTree } from "../app-router";
import { getHelpContent } from "../features/help-content";

// Exercise the real document routes and links without session/backend requests.
vi.mock("@/routes/layout", async () => {
  const { Outlet } = await import("@tanstack/react-router");
  return { ControlPlaneLayout: () => <Outlet /> };
});

const startPath = "/document/overview/quickstart-protection";
const policyPath = "/document/overview/glossary-definition";
const scrollIntoView = vi.fn();

async function mount(path: string) {
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createRouter({ routeTree, history, defaultPendingMinMs: 0 });
  await router.load();
  const view = render(<RouterProvider router={router} />);
  return { ...view, router, history };
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(scrollIntoView);
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); scrollIntoView.mockClear(); });

describe("document page navigation", () => {
  it("uses article paths, section fragments, and browser back/forward", async () => {
    const { container, router, history } = await mount(startPath);
    const content = getHelpContent("en");
    const quickstart = content.documents[0];
    const policy = content.documents.find(article => article.id === "glossary-definition")!;
    await screen.findByRole("heading", { level: 1, name: quickstart.title });
    const toc = within(container.querySelectorAll("aside")[1]);
    const steps = quickstart.sections.find(section => section.id === "quickstart-steps")!;
    const sectionLink = toc.getByRole("link", { name: steps.title });
    expect(sectionLink.getAttribute("href")).toBe(`${startPath}#quickstart-steps`);
    fireEvent.click(sectionLink);
    await waitFor(() => expect(router.state.location.href).toBe(`${startPath}#quickstart-steps`));
    await waitFor(() => expect(document.activeElement?.id).toBe("quickstart-steps"));
    // Clicking the same URL again still returns to the heading after scrolling.
    scrollIntoView.mockClear();
    fireEvent.click(sectionLink);
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    const directory = within(container.querySelector("aside")!);
    const articleLink = directory.getByRole("link", { name: policy.title });
    expect(articleLink.getAttribute("href")).toBe(policyPath);
    fireEvent.click(articleLink);
    await screen.findByRole("heading", { level: 1, name: policy.title });
    expect(router.state.location.href).toBe(policyPath);
    await act(async () => { history.back(); });
    await screen.findByRole("heading", { level: 1, name: quickstart.title });
    expect(router.state.location.hash).toBe("quickstart-steps");
    await act(async () => { history.forward(); });
    await screen.findByRole("heading", { level: 1, name: policy.title });
    expect(router.state.location.href).toBe(policyPath);
  });

  it("navigates search results and preserves article/section when switching language", async () => {
    const { container, router } = await mount(startPath);
    const directory = within(container.querySelector("aside")!);
    fireEvent.change(directory.getByRole("searchbox"), { target: { value: "text/regex" } });
    const result = directory.getAllByRole("link").find(link => link.getAttribute("href") === `${policyPath}#term-rule-implementation`)!;
    expect(result).toBeTruthy();
    fireEvent.click(result);
    await waitFor(() => expect(router.state.location.href).toBe(`${policyPath}#term-rule-implementation`));
    await waitFor(() => expect(document.activeElement?.id).toBe("term-rule-implementation"));
    await act(async () => { await i18n.changeLanguage("zh-CN"); });
    await screen.findByRole("heading", { level: 1, name: getHelpContent("zh-CN").documents.find(article => article.id === "glossary-definition")!.title });
    expect(router.state.location.href).toBe(`${policyPath}#term-rule-implementation`);
  });

  it.each([
    ["/document", startPath],
    ["/document#quickstart-protection", startPath],
    ["/document#concept-scenario", startPath],
    ["/document#term-rule-actions", `${policyPath}#term-rule-actions`],
  ])("redirects %s to its article address", async (from, to) => {
    const { router } = await mount(from);
    await waitFor(() => expect(router.state.location.href).toBe(to));
    await screen.findByRole("heading", { level: 1 });
  });

  it("opens a section directly, as on a refresh", async () => {
    const { router } = await mount(`${policyPath}#term-rule-implementation`);
    await waitFor(() => expect(document.activeElement?.id).toBe("term-rule-implementation"));
    expect(router.state.location.href).toBe(`${policyPath}#term-rule-implementation`);
  });

  it("does not let another article's fragment select the current article", async () => {
    const { router } = await mount(`${startPath}#term-rule-implementation`);
    await screen.findByRole("heading", { level: 1, name: getHelpContent("en").documents[0].title });
    expect(router.state.location.pathname).toBe(startPath);
    expect(document.querySelector("article")?.id).toBe("quickstart-protection");
  });

  it.each(["/document/overview/missing", "/document/missing/quickstart-protection", "/document#missing"])("shows a missing document for %s", async path => {
    await mount(path);
    await screen.findByRole("heading", { name: "Document not found" });
    expect(document.querySelector("article")).toBeNull();
  });
});
