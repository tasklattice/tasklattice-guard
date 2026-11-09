import i18n from "@/i18n";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routeTree } from "../app-router";
import { getHelpContent } from "../features/help-content";
import { AuthProvider } from "@/lib/auth";

// Keep the real authentication boundary and document layouts. Only the session
// service is stubbed so these navigation tests run as an anonymous reader.
const mocks = vi.hoisted(() => ({ getAuthStatus: vi.fn() }));
vi.mock("@/lib/identity-api", () => ({
  getAuthStatus: mocks.getAuthStatus, login: vi.fn(), logout: vi.fn(), updateMe: vi.fn(),
}));

const startPath = "/document/overview/quickstart-protection";
const policyPath = "/document/overview/glossary-definition";
const scrollIntoView = vi.fn();
let documentScrollTop = 0;
const queryClients: QueryClient[] = [];

async function mount(path: string) {
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createRouter({ routeTree, history, defaultPendingMinMs: 0 });
  await router.load();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClients.push(client);
  const view = render(<QueryClientProvider client={client}><AuthProvider><RouterProvider router={router} /></AuthProvider></QueryClientProvider>);
  await act(async () => { await new Promise(requestAnimationFrame); });
  return { ...view, router, history };
}

beforeEach(async () => {
  mocks.getAuthStatus.mockResolvedValue({ authenticated: false, user: null });
  await i18n.changeLanguage("en");
  documentScrollTop = 0;
  // jsdom gives every section top=0. The scroll observer would then select
  // the last chapter as soon as its animation frame runs, racing navigation.
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const article = this.closest("article");
    if (article && this.id) {
      const anchors = [article, ...article.querySelectorAll("[id]")];
      return new DOMRect(0, 200 + anchors.indexOf(this) * 200 - documentScrollTop, 800, 32);
    }
    return originalRect.call(this);
  });
  scrollIntoView.mockImplementation(function (this: HTMLElement) {
    documentScrollTop += this.getBoundingClientRect().top - 120;
    window.dispatchEvent(new Event("scroll"));
  });
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(scrollIntoView);
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  queryClients.splice(0).forEach(client => client.clear());
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("document page navigation", () => {
  it.each(getHelpContent("en").documents)("opens $categoryId/$id without a session", async article => {
    const { router } = await mount(`/document/${article.categoryId}/${article.id}`);
    await screen.findByRole("heading", { level: 1, name: article.title });
    expect(router.state.location.pathname).toBe(`/document/${article.categoryId}/${article.id}`);
    expect(mocks.getAuthStatus).toHaveBeenCalled();
  });

  it.each(["loading", "error"])("opens a section while the session service is %s", async state => {
    if (state === "loading") mocks.getAuthStatus.mockImplementation(() => new Promise(() => {}));
    else mocks.getAuthStatus.mockRejectedValue(new Error("Session unavailable"));
    const { router } = await mount(`${policyPath}#term-rule-implementation`);
    await screen.findByRole("heading", { level: 1, name: getHelpContent("en").documents.find(article => article.id === "glossary-definition")!.title });
    await waitFor(() => expect(document.activeElement?.id).toBe("term-rule-implementation"));
    expect(router.state.location.href).toBe(`${policyPath}#term-rule-implementation`);
  });

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

  it("opens the documentation index at the current quickstart article", async () => {
    const { router } = await mount("/document");
    await waitFor(() => expect(router.state.location.href).toBe(startPath));
    await screen.findByRole("heading", { level: 1 });
  });

  it("opens a section directly, as on a refresh", async () => {
    const { router } = await mount(`${policyPath}#term-rule-implementation`);
    await waitFor(() => expect(document.activeElement?.id).toBe("term-rule-implementation"));
    expect(router.state.location.href).toBe(`${policyPath}#term-rule-implementation`);
  });

  it("expands the current chapter and lets readers browse another chapter without navigating", async () => {
    const gatewayPath = "/document/developer/gateway-connect";
    const { container, router, history } = await mount(`${gatewayPath}#gateway-request-fields`);
    const outline = within(container.querySelectorAll("aside")[1]);
    await waitFor(() => expect(outline.getByRole("button", { name: "Collapse section: Non-streaming inspection: input and complete output" }).getAttribute("aria-expanded")).toBe("true"));
    expect(outline.getByRole("link", { name: "Request fields" }).getAttribute("aria-current")).toBe("location");
    expect(outline.queryByRole("link", { name: "Messages sent to Guard: start, delta and end" })).toBeNull();

    fireEvent.click(outline.getByRole("button", { name: "Expand section: Streaming inspection: output only" }));
    expect(router.state.location.href).toBe(`${gatewayPath}#gateway-request-fields`);
    expect(outline.queryByRole("link", { name: "Request fields" })).toBeNull();
    fireEvent.click(outline.getByRole("link", { name: "Messages sent to Guard: start, delta and end" }));
    await waitFor(() => expect(document.activeElement?.id).toBe("gateway-stream-request"));
    expect(router.state.location.href).toBe(`${gatewayPath}#gateway-stream-request`);

    await act(async () => { history.back(); });
    await waitFor(() => expect(outline.getByRole("link", { name: "Request fields" }).getAttribute("aria-current")).toBe("location"));
    expect(outline.queryByRole("link", { name: "Messages sent to Guard: start, delta and end" })).toBeNull();
  });

  it("keeps complete chapter names and opens nested sections from a direct link", async () => {
    const { container } = await mount("/document/developer/gateway-connect#gateway-grounding-context");
    const outline = within(container.querySelectorAll("aside")[1]);
    const chapterName = "Non-streaming inspection: input and complete output";
    expect(outline.getByRole("link", { name: chapterName }).getAttribute("href")).toBe("/document/developer/gateway-connect#gateway-checks");
    await waitFor(() => expect(outline.getByRole("link", { name: "Supply a query and reference sources for answer verification" }).getAttribute("aria-current")).toBe("location"));
    const collapse = outline.getByRole("button", { name: `Collapse section: ${chapterName}` });
    const target = document.getElementById(collapse.getAttribute("aria-controls")!);
    expect(target?.hidden).toBe(false);
    fireEvent.click(collapse);
    expect(target?.hidden).toBe(true);
    expect(document.activeElement?.id).toBe("gateway-grounding-context");
    fireEvent.click(outline.getByRole("button", { name: `Expand section: ${chapterName}` }));
    expect(target?.hidden).toBe(false);
  });

  it("tracks the visible chapter when scrolling without changing the URL", async () => {
    const gatewayPath = "/document/developer/gateway-connect";
    const { container, router } = await mount(`${gatewayPath}#gateway-request-fields`);
    const outline = within(container.querySelectorAll("aside")[1]);
    const target = document.getElementById("gateway-stream-request")!;
    documentScrollTop += target.getBoundingClientRect().top - 120;
    fireEvent.scroll(window);
    await waitFor(() => expect(outline.getByRole("link", { name: "Messages sent to Guard: start, delta and end" }).getAttribute("aria-current")).toBe("location"));
    expect(outline.queryByRole("link", { name: "Request fields" })).toBeNull();
    expect(router.state.location.href).toBe(`${gatewayPath}#gateway-request-fields`);
  });

  it("does not let another article's fragment select the current article", async () => {
    const { router } = await mount(`${startPath}#term-rule-implementation`);
    await screen.findByRole("heading", { level: 1, name: getHelpContent("en").documents[0].title });
    expect(router.state.location.pathname).toBe(startPath);
    expect(document.querySelector("article")?.id).toBe("quickstart-protection");
  });

  it.each(["/document/overview/missing", "/document/missing/quickstart-protection"])("shows a missing document for %s", async path => {
    await mount(path);
    await screen.findByRole("heading", { name: "Document not found" });
    expect(document.querySelector("article")).toBeNull();
  });
});
