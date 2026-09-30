import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { helpStructuralComponents } from "../components/help/document-blocks";
import { getHelpContent, searchHelpContent } from "./help-content";
import { documentHref, documentPath, resolveLegacyDocument } from "./help-navigation";

describe("document addresses", () => {
  it.each(["en", "zh-CN"] as const)("keeps every %s article and section link valid", locale => {
    const content = getHelpContent(locale);
    const byPath = new Map(content.documents.map(article => [documentPath(article), article]));
    for (const article of content.documents) {
      const element = document.createElement("div");
      element.innerHTML = renderToStaticMarkup(createElement(article.Content, { components: helpStructuralComponents }));
      for (const link of element.querySelectorAll("a[href]")) {
        const href = link.getAttribute("href")!;
        expect(href, article.id).not.toMatch(/^\/(?:document|help)#/);
        if (!href.startsWith("#") && !href.startsWith("/document/")) continue;
        const url = new URL(href, `https://guard.example${documentPath(article)}`);
        const target = byPath.get(url.pathname);
        expect(target, `${article.id}: ${href}`).toBeDefined();
        const anchor = decodeURIComponent(url.hash.slice(1));
        if (anchor) expect([target!.id, ...target!.sections.map(section => section.id)], href).toContain(anchor);
      }
    }
  });

  it("includes the owning article in section search results", () => {
    const content = getHelpContent("en");
    const result = searchHelpContent(content, "text/regex").find(result => result.id === "term-rule-implementation");
    expect(result?.href).toBe("/document/overview/glossary-definition#term-rule-implementation");
    expect(documentHref(content.documents[0])).toBe("/document/overview/quickstart-protection");
  });

  it("resolves old article, section, and alias links without hiding missing targets", () => {
    const content = getHelpContent("en");
    expect(resolveLegacyDocument(content, "quickstart-protection")?.anchor).toBe("");
    expect(resolveLegacyDocument(content, "#term-rule-actions")).toMatchObject({ document: { id: "glossary-definition" }, anchor: "term-rule-actions" });
    expect(resolveLegacyDocument(content, "concept-scenario")?.document.id).toBe("quickstart-protection");
    expect(resolveLegacyDocument(content, "no-such-article")).toBeUndefined();
    expect(resolveLegacyDocument(content, "%E0%A4%A")).toBeUndefined();
    const sharedSection = { id: "introduction", title: "Introduction", depth: 2, text: "Introduction" };
    const documents = content.documents.slice(0, 2).map(article => ({ ...article, sections: [sharedSection] }));
    expect(new Set(documents.map(article => documentHref(article, "introduction"))).size).toBe(2);
    expect(resolveLegacyDocument({ ...content, documents }, "introduction")).toBeUndefined();
  });
});
