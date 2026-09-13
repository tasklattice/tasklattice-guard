import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { helpStructuralComponents } from "../components/help/document-blocks";
import { getHelpContent, searchHelpContent } from "./help-content";
import { enforcementActionConflictOrder, enforcementActionDisplayOrder } from "../../shared/enforcement-action.generated";

describe("MDX Help documents", () => {
  it.each(["zh-CN", "en"] as const)("compiles %s content with stable anchors and matching search sections", locale => {
    const content = getHelpContent(locale);
    expect(content.guides.map(guide => guide.audience)).toEqual(["user", "developer", "operator"]);
    expect(content.documents).toHaveLength(5);
    for (const doc of [content.api, ...content.documents]) {
      expect(doc.title).toBeTruthy();
      const html = renderToStaticMarkup(createElement(doc.Content, { components: helpStructuralComponents }));
      for (const section of doc.sections) {
        expect(html).toContain(`id="${section.id}"`);
        expect(section.text).toContain(section.title);
      }
    }
    const api = renderToStaticMarkup(createElement(content.api.Content));
    for (const path of ["/account/access-tokens", "/api/docs", "/api/openapi.json", "/api/llms.txt"]) expect(api).toContain(`href="${path}"`);
  });
  it.each(["zh-CN", "en"] as const)("keeps %s action documentation aligned with the wire contract", locale => {
    const section = getHelpContent(locale).guides.find(guide => guide.audience === "developer")!.sections.find(section => section.id === "developer-actions")!;
    for (const action of enforcementActionDisplayOrder) expect(section.text).toContain(action);
    expect(section.text).toContain(enforcementActionConflictOrder.join(" → "));
  });
  it("finds Markdown body text, aliases, API paths and code examples without a manual index", () => {
    const content = getHelpContent("zh-CN");
    expect(searchHelpContent(content, "Session").map(result => result.id)).toContain("developer-api-access");
    expect(searchHelpContent(content, "GUARD_ACCESS_TOKEN").map(result => result.id)).toContain("developer-api-access");
    expect(searchHelpContent(content, "Prometheus").map(result => result.id)).toContain("operator-metrics");
    expect(searchHelpContent(content, "Traffic Scope").map(result => result.id)).toContain("term-traffic-scope");
    expect(searchHelpContent(content, "不存在的搜索条目")).toEqual([]);
  });
  it.each(["zh-CN", "en"] as const)("indexes %s state card titles and wire codes from MDX", locale => {
    const content = getHelpContent(locale);
    for (const code of ["unpublished", "distributing", "active", "failed"]) {
      expect(searchHelpContent(content, code).map(result => result.id)).toContain("router-rollout-states");
    }
    expect(searchHelpContent(content, "compiling").map(result => result.id)).toContain("guardrail-build-states");
    const operator = content.guides.find(guide => guide.audience === "operator")!;
    const html = renderToStaticMarkup(createElement(operator.Content, { components: helpStructuralComponents }));
    expect(html.match(/<dl /g)).toHaveLength(7);
    expect(html).toContain(locale === "zh-CN" ? "下一步" : "Next step");
  });
});
