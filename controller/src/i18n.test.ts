import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

function runtimeUiSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return runtimeUiSources(path);
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
    return [path];
  });
}

describe("i18n source boundary", () => {
  it("keeps localized Chinese copy out of runtime UI components", () => {
    const files = [
      ...runtimeUiSources(resolve("src/components")),
      ...runtimeUiSources(resolve("src/routes")),
    ];

    for (const file of files) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/[\u3400-\u9fff]/u);
    }
  });
});

describe("Policy Library jurisdiction translations", () => {
  it("uses natural Simplified Chinese labels", async () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: () => undefined,
      },
    });
    const { default: i18n } = await import("./i18n");
    const t = i18n.getFixedT("zh-CN");

    expect(t("policyLibrary.tagNamespaces.jurisdiction")).toBe("适用地区");
    expect(t("policyLibrary.jurisdictions.au")).toBe("澳大利亚");
    expect(t("policyLibrary.jurisdictions.eu")).toBe("欧盟");
    expect(t("policyLibrary.jurisdictions.sg")).toBe("新加坡");
    expect(t("policyLibrary.jurisdictions.uae")).toBe("阿联酋");
  });
});

describe("Controller operations translations", () => {
  it("keeps Runner and activity copy in the shared resource catalog", async () => {
    const { default: i18n } = await import("./i18n");
    const en = i18n.getFixedT("en");
    const zh = i18n.getFixedT("zh-CN");

    expect(en("runners.recommendation", { recommended: 3, desired: 2 })).toBe("Recommended 3 replicas; 2 currently desired");
    expect(zh("runners.removal.title")).toBe("移除此离线 Runner？");
    expect(en("nav.observability")).toBe("Observability");
    expect(zh("nav.observability")).toBe("可观测性");
    expect(en("logs.systemEvents")).toBe("System events");
    expect(zh("logs.systemEvents")).toBe("系统事件");
  });
});
