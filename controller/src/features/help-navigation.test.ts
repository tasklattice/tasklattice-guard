import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { helpStructuralComponents } from "../components/help/document-blocks";
import { getHelpContent, searchHelpContent } from "./help-content";
import { documentHref, documentPath } from "./help-navigation";

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

});
