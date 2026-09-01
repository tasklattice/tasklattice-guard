import { describe, expect, it } from "vitest";

import { getHelpContent, searchHelpContent } from "@/features/help-content";
import { enforcementActionConflictOrder, enforcementActionDisplayOrder } from "../../shared/enforcement-action.generated";

describe("help center content", () => {
  it("provides a complete role path for users, developers, and operators in both locales", () => {
    for (const locale of ["zh-CN", "en"] as const) {
      const content = getHelpContent(locale);

      expect(content.guides.map((guide) => guide.id)).toEqual(["user", "developer", "operator"]);
      expect(content.guides.every((guide) => guide.articles.length >= 3)).toBe(true);
      expect(content.architecture.length).toBeGreaterThanOrEqual(6);
    }
  });

  it("documents every Policy Studio runtime concept and unsafe action", () => {
    const content = getHelpContent("zh-CN");
    const developer = content.guides.find((guide) => guide.id === "developer");
    const runtime = developer?.articles.find((article) => article.id === "developer-policy-runtime");
    const actions = developer?.articles.find((article) => article.id === "developer-actions");

    expect(runtime?.terms?.map((term) => term.name)).toEqual(expect.arrayContaining([
      "Rail",
      "Flow 名称",
      "执行模式：detect",
      "执行模式：mutate",
      "高级运行设置",
      "Action 依赖",
      "绑定参数",
    ]));
    expect(runtime?.paragraphs?.join(" ")).toContain("自动使用 Colang 2.x");
    expect(actions?.terms?.map((term) => term.name)).toEqual(enforcementActionDisplayOrder);
    expect(actions?.note).toContain(enforcementActionConflictOrder.join(" → "));
  });

  it("keeps lifecycle, runtime, routing, and evidence concepts discoverable", () => {
    const content = getHelpContent("zh-CN");
    const ids = content.glossary.map((entry) => entry.id);

    expect(ids).toEqual(expect.arrayContaining([
      "policy",
      "rule",
      "test-case",
      "guardrail",
      "policy-binding",
      "policy-version",
      "guardrail-version",
      "rail",
      "flow",
      "colang",
      "action",
      "enforcement-action",
      "action-reference",
      "parameter",
      "validation-run",
      "deployment",
      "integration",
      "traffic-scope",
      "evidence",
      "runtime-profile",
      "checksum",
      "failure-mode",
      "output-delivery",
      "decision",
    ]));
  });

  it("searches articles and the glossary across aliases and descriptions", () => {
    const chinese = getHelpContent("zh-CN");
    const railResults = searchHelpContent(chinese, "Rail");
    const deploymentResults = searchHelpContent(chinese, "部署 路由");

    expect(railResults.guides.flatMap((result) => result.articles.map((article) => article.id))).toContain("developer-policy-runtime");
    expect(railResults.guides.flatMap((result) => result.articles.map((article) => article.id))).not.toContain("user-lifecycle");
    expect(railResults.glossary.map((entry) => entry.id)).toContain("rail");
    expect(railResults.glossary.map((entry) => entry.id)).not.toContain("guardrail");
    expect(deploymentResults.glossary.map((entry) => entry.id)).toContain("deployment");
    expect(deploymentResults.guides.flatMap((result) => result.articles.map((article) => article.id))).toContain("operator-routing");
  });
});
