import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { helpStructuralComponents } from "../components/help/document-blocks";
import { getHelpContent, searchHelpContent, type HelpLocale } from "./help-content";
import { enforcementActionConflictOrder, enforcementActionDisplayOrder } from "../../shared/enforcement-action.generated";

const locales: HelpLocale[] = ["zh-CN", "en"];
const article = (locale: HelpLocale, id: string) => getHelpContent(locale).documents.find(document => document.id === id)!;
const section = (locale: HelpLocale, id: string) => getHelpContent(locale).documents.flatMap(document => document.sections).find(item => item.id === id)!;

describe("repository documentation", () => {
  it.each(locales)("loads %s categories and articles from directory names", locale => {
    const content = getHelpContent(locale);
    expect(content.categories.map(category => category.id)).toEqual(["overview", "operator", "admin", "developer", "api"]);
    expect(content.categories.every(category => category.articles.length >= 2)).toBe(true);
    expect(content.documents).toHaveLength(25);
    expect(content.documents[0].id).toBe("quickstart-protection");
    expect(content.categories[1].articles[0].id).toBe("user-lifecycle");
    expect(content.categories[2].articles[0].id).toBe("platform-runtime");
    expect(content.categories.at(-1)?.id).toBe("api");
    expect(article(locale, "term-guardrail").categoryId).toBe("overview");
    expect(content.categories[0].articles.map(document => document.id)).toEqual([
      "quickstart-protection", "term-guardrail", "glossary-definition",
      "concept-playground", "term-router", "term-endpoint",
    ]);
    expect(section(locale, "glossary-states").title).toBeTruthy();
    expect(section(locale, "state-router").title).toBeTruthy();
    expect(article(locale, "operator-create-policy").categoryId).toBe("operator");
    expect(article(locale, "gateway-connect").categoryId).toBe("developer");
    expect(content.categories[3].articles.map(document => document.id)).toEqual([
      "developer-endpoint", "developer-api-access", "developer-runtime",
      "gateway-connect", "gateway-stream", "gateway-failures",
    ]);
    expect(content.categories[2].articles.map(document => document.id)).toEqual([
      "platform-runtime", "platform-models", "platform-access", "concept-logs", "concept-audit",
    ]);
    expect(section(locale, "term-decision").title).toBeTruthy();
    expect(section(locale, "term-policy-version").title).toBeTruthy();
    expect(section(locale, "term-rail").title).toBeTruthy();
    for (const document of content.documents) {
      expect(document.title).toBeTruthy();
      expect(document.summary).toBeTruthy();
      expect(document.categoryTitle).toBeTruthy();
      const html = renderToStaticMarkup(createElement(document.Content, { components: helpStructuralComponents }));
      for (const item of document.sections) {
        expect(html).toContain(`id="${item.id}"`);
        expect(item.text).toContain(item.title);
        expect(item.depth).toBeGreaterThanOrEqual(2);
      }
    }
    for (const path of ["/account/access-tokens", "/api/docs", "/api/openapi.json", "/api/llms.txt"]) {
      const html = renderToStaticMarkup(createElement(article(locale, "api-access").Content));
      expect(html).toContain(`href="${path}"`);
    }
  });

  it("keeps article and section anchors aligned between languages", () => {
    const zh = getHelpContent("zh-CN");
    const en = getHelpContent("en");
    expect(zh.documents.map(document => document.id)).toEqual(en.documents.map(document => document.id));
    for (let index = 0; index < zh.documents.length; index++) {
      expect(zh.documents[index].sections.map(item => item.id)).toEqual(en.documents[index].sections.map(item => item.id));
    }
    expect(section("zh-CN", "overview").title).toBeTruthy();
    expect(section("zh-CN", "concept-lifecycle").title).toBeTruthy();
    expect(section("zh-CN", "term-policy-version").title).toBe("Policy Version");
  });

  it.each(locales)("keeps %s action documentation aligned with the wire contract", locale => {
    expect(article(locale, "glossary-definition").sections.map(item => item.id)).toContain("term-rule-actions");
    const text = section(locale, "term-rule-actions").text;
    for (const action of enforcementActionDisplayOrder) expect(text).toContain(action);
    expect(text).toContain(enforcementActionConflictOrder.join(" → "));
  });

  it("searches article introductions and section bodies", () => {
    const content = getHelpContent("zh-CN");
    expect(searchHelpContent(content, "Session").map(result => result.id)).toContain("developer-control-auth");
    expect(searchHelpContent(content, "GUARD_ACCESS_TOKEN").map(result => result.id)).toContain("developer-control-auth");
    expect(searchHelpContent(content, "Prometheus").map(result => result.id)).toContain("operator-metrics");
    expect(searchHelpContent(content, "Traffic Scope").map(result => result.id)).toContain("term-traffic-scope");
    expect(searchHelpContent(content, "不存在的搜索条目")).toEqual([]);
  });

  it.each(locales)("indexes %s state cards and renders them in their article", locale => {
    const content = getHelpContent(locale);
    for (const code of ["unpublished", "distributing", "active", "failed"]) {
      expect(searchHelpContent(content, code).map(result => result.id)).toContain("router-rollout-states");
    }
    const html = renderToStaticMarkup(createElement(article(locale, "term-router").Content, { components: helpStructuralComponents }));
    expect(html.match(/<dl /g)).toHaveLength(4);
    expect(html).toContain(locale === "zh-CN" ? "下一步" : "Next step");
  });

  it("keeps resource maps, Rule forms, and state diagrams with their parent concepts", () => {
    for (const locale of locales) {
      const map = renderToStaticMarkup(createElement(article(locale, "term-guardrail").Content, { components: helpStructuralComponents }));
      expect(map).toContain('src="/favicon.svg"');
      const definitions = renderToStaticMarkup(createElement(article(locale, "glossary-definition").Content, { components: helpStructuralComponents }));
      const container = document.createElement("div");
      container.innerHTML = definitions;
      const list = container.querySelector("#term-rule-implementation")?.nextElementSibling?.nextElementSibling;
      expect(list?.tagName).toBe("OL");
      expect(Array.from(list?.querySelectorAll(":scope > li") ?? []).map(item => item.querySelector("code")?.textContent)).toEqual([
        "regex", "keyword", "category", "code_block", "competitor_intent", "colang_flow",
      ]);
      const states = ["term-guardrail", "term-router", "term-endpoint", "platform-runtime"].map(id => renderToStaticMarkup(createElement(article(locale, id).Content, { components: helpStructuralComponents }))).join(" ");
      expect(states).toContain("<svg");
      expect(states).toContain("marker-end=");
      expect(states).toContain("protected");
      for (const tone of ["bg-amber-50", "bg-emerald-50", "bg-red-50"]) expect(states).toContain(tone);
    }
  });
});
