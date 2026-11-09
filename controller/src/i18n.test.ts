import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { tokenModules } from "../shared/access-tokens";

function runtimeUiSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return runtimeUiSources(path);
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
    return [path];
  });
}

describe("i18n source boundary", () => {
  it("resolves every navigation label in both languages without English fallback", async () => {
    const { default: i18n } = await import("./i18n");
    const sources = ["src/components/control-plane-sidebar.tsx", "src/routes/layout.tsx", "src/components/ui/sidebar.tsx"]
      .map(path => readFileSync(resolve(path), "utf8")).join("\n");
    const keys = [...new Set([...sources.matchAll(/"((?:nav|sidebar)\.[\w]+)"/g)].map(match => match[1]!))];
    for (const lng of ["en", "zh-CN"]) {
      const t = i18n.getFixedT(lng);
      for (const key of keys) {
        expect(i18n.exists(key, { lng, fallbackLng: false }), `${lng}: ${key}`).toBe(true);
        expect(t(key).trim(), `${lng}: ${key}`).not.toBe("");
        expect(t(key), `${lng}: ${key}`).not.toBe(key);
        if (lng === "zh-CN") expect(t(key), key).toMatch(/[\u3400-\u9fff]/u);
      }
    }
  });

  it("keeps platform page names aligned with the sidebar and localized terminology", async () => {
    const { default: i18n } = await import("./i18n");
    const zh = i18n.getFixedT("zh-CN");
    expect(zh("nav.providers")).toBe("模型提供商");
    expect(zh("nav.guardrailCatalog")).toBe("防护能力");
    expect(zh("nav.runner")).toBe("执行节点");
    expect(zh("nav.guardrailDesign")).toBe("护栏设计");
    expect(zh("modelSettings.capabilityColumn")).toBe("检测能力");
    expect(zh("modelSettings.controlPlane")).toBe("控制面");
    for (const lng of ["en", "zh-CN"]) {
      const t = i18n.getFixedT(lng);
      for (const [title, navigation] of [
        ["modelSettings.providersTitle", "nav.providers"],
        ["modelSettings.providers", "nav.providers"],
        ["modelSettings.catalogTitle", "nav.guardrailCatalog"],
        ["runners.pageTitle", "nav.runner"],
      ]) expect(t(title!)).toBe(t(navigation!));
    }
  });

  it("resolves Access Token copy in both languages without falling back", async () => {
    const { default: i18n } = await import("./i18n");
    const source = readFileSync(resolve("src/components/account/access-tokens.tsx"), "utf8");
    const keys = [...source.matchAll(/\bt\("([\w.]+)"/g)].map(match => match[1]);
    for (const module of tokenModules) {
      keys.push(`accessTokens.modules.${module}.name`, `accessTokens.modules.${module}.description`);
    }
    for (const lng of ["en", "zh-CN"]) {
      for (const key of keys) {
        expect(i18n.exists(key, { lng, fallbackLng: false, count: 2 }), `${lng}: ${key}`).toBe(true);
      }
    }
    expect(source).not.toMatch(/[\u3400-\u9fff]/u);
  });

  it("keeps localized Chinese copy out of runtime UI components", () => {
    const files = [
      ...runtimeUiSources(resolve("src/components")),
      ...runtimeUiSources(resolve("src/routes")),
    ];

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const runtimeCopy = source;
      expect(runtimeCopy, file).not.toMatch(/[\u3400-\u9fff]/u);
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
    expect(t("policyLibrary.jurisdictions.cn")).toBe("中国大陆");
    expect(t("policyLibrary.jurisdictions.eu")).toBe("欧盟");
    expect(t("policyLibrary.jurisdictions.sg")).toBe("新加坡");
    expect(t("policyLibrary.jurisdictions.uae")).toBe("阿联酋");
  });
});

describe("Controller operations translations", () => {
  it("explains project and administrator Guardrail deletion scope in both languages", async () => {
    const { default: i18n } = await import("./i18n");
    const en = i18n.getFixedT("en")("guardrails.deleteRetentionNote");
    const zh = i18n.getFixedT("zh-CN")("guardrails.deleteRetentionNote");
    expect(en).toContain("other projects' and unattributed runtime history are retained");
    expect(en).toContain("platform administrator");
    expect(en).toContain("runtime history for all projects and unattributed records is deleted");
    expect(zh).toContain("其他项目及归属不明的运行历史会保留");
    expect(zh).toContain("平台管理员删除时");
    expect(zh).toContain("将删除所有项目及归属不明的运行历史");
  });

  it("provides Playground mode copy for the page and Endpoint shortcut in both languages", async () => {
    const { default: i18n } = await import("./i18n");
    const en = i18n.getFixedT("en");
    const zh = i18n.getFixedT("zh-CN");
    expect(en("playground.advancedMode")).toBe("Advanced mode");
    expect(zh("playground.advancedMode")).toBe("高级模式");
    expect(en("playground.simpleMode")).toBe("Simple mode");
    expect(zh("playground.simpleMode")).toBe("普通模式");
    for (const language of ["en", "zh-CN"]) {
      for (const key of ["modeLabel", "advancedDescription"]) {
        expect(i18n.exists(`playground.${key}`, { lng: language, fallbackLng: false })).toBe(true);
      }
    }
  });

  it("keeps Runner and activity copy in the shared resource catalog", async () => {
    const { default: i18n } = await import("./i18n");
    const en = i18n.getFixedT("en");
    const zh = i18n.getFixedT("zh-CN");

    expect(en("runners.recommendation", { recommended: 3, desired: 2 })).toBe("Recommended 3 replicas; 2 currently desired");
    expect(zh("runners.removal.title")).toBe("移除此离线 Runner？");
    expect(en("nav.observability")).toBe("Observability");
    expect(zh("nav.observability")).toBe("可观测性");
    expect(en("logs.outcomes.allow")).toBe("Allow");
    expect(zh("logs.outcomes.allow")).toBe("允许");
    expect(Object.keys(en("logs.outcomes", { returnObjects: true }))).toEqual(["allow", "block", "transform"]);
  });
});

describe("Router and Endpoint product terminology", () => {
  it("uses the current entities in both languages, including onboarding and errors", async () => {
    const { default: i18n } = await import("./i18n");
    for (const language of ["en", "zh-CN"]) {
      const t = i18n.getFixedT(language);
      expect(t("nav.routers")).toBe(language === "en" ? "Routers" : "路由器");
      expect(t("nav.endpoints")).toMatch(/Endpoint|端点/);
      for (const key of ["endpoints.register", "endpoints.openEndpointDetails", "endpoints.deleteDialogTitle", "dashboard.attentionEndpoint"]) {
        expect(t(key), `${language}: ${key}`).toMatch(/endpoint|Endpoint|端点/);
        expect(t(key), `${language}: ${key}`).not.toMatch(/Integration|集成|Deployment/);
      }
    }
  });
});

describe("routing translation contract", () => {
  it("provides matching keys and interpolation parameters in both languages", async () => {
    const { routingEn, routingZh } = await import("./routing-i18n");
    const { uiCopyEn, uiCopyZh } = await import("./ui-copy-i18n");
    const flatten = (value: Record<string, unknown>, prefix = ""): Record<string, string> => Object.fromEntries(
      Object.entries(value).flatMap(([key, text]) => typeof text === "string"
        ? [[`${prefix}${key}`, text]]
        : Object.entries(flatten(text as Record<string, unknown>, `${prefix}${key}.`))),
    );
    const en = flatten({ routing: routingEn, uiCopy: uiCopyEn }), zh = flatten({ routing: routingZh, uiCopy: uiCopyZh });
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en)) {
      expect(zh[key]?.trim(), key).toBeTruthy();
      const parameters = (text: string) => [...text.matchAll(/{{\s*([\w]+)\s*}}/g)].map(m => m[1]).sort();
      expect(parameters(zh[key]!), key).toEqual(parameters(en[key]!));
    }
  });

  it("does not reintroduce inline bilingual helpers or untranslated Router labels", () => {
    const sources = [...runtimeUiSources(resolve("src/components")), ...runtimeUiSources(resolve("src/routes"))];
    for (const file of sources) {
      expect(readFileSync(file, "utf8"), file).not.toContain("useRoutingText");
    }
    const routerFiles = sources.filter(file => file.includes("traffic-routing") || /routes\/routers?(?:-detail)?\.tsx$/.test(file));
    for (const file of routerFiles) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/>\s*[A-Z][a-z]+(?:\s+[A-Za-z]+)+[.!?]?\s*</);
      expect(source, file).not.toMatch(/(?:title|description|placeholder|aria-label)="[A-Z][a-z]+(?:\s+[A-Za-z]+)+/);
    }
  });
});

describe("Provider registration translation contract", () => {
  it("preserves keys and interpolation parameters while localizing Provider and Catalog copy", async () => {
    const { providerRegistrationEn, providerRegistrationZh } = await import("./provider-registration-i18n");
    const flatten = (value: Record<string, unknown>, prefix = ""): Record<string, string> => Object.fromEntries(
      Object.entries(value).flatMap(([key, text]) => typeof text === "string"
        ? [[`${prefix}${key}`, text]]
        : Object.entries(flatten(text as Record<string, unknown>, `${prefix}${key}.`))),
    );
    const en = flatten(providerRegistrationEn), zh = flatten(providerRegistrationZh);
    // Chinese uses the base key where English has singular/plural variants.
    const baseKey = (key: string) => key.replace(/_(zero|one|two|few|many|other)$/, "");
    expect([...new Set(Object.keys(zh).map(baseKey))].sort()).toEqual([...new Set(Object.keys(en).map(baseKey))].sort());
    for (const key of Object.keys(en)) {
      const translated = zh[key] ?? zh[baseKey(key)]!;
      const parameters = (text: string) => [...text.matchAll(/{{\s*([\w]+)\s*}}/g)].map(match => match[1]).sort();
      expect(parameters(translated), key).toEqual(parameters(en[key]!));
      expect(translated, key).not.toMatch(/\bProvider\b|Guardrail Catalog|Protection Capabilities/);
    }
  });
});


describe("Immutable version workspace translations", () => {
  it("resolves list, drawer and recovery copy in both languages", async () => {
    const { default: i18n } = await import("./i18n");
    const { immutableVersionsEn } = await import("./immutable-versions-i18n");
    for (const lng of ["en", "zh-CN"]) {
      for (const key of Object.keys(immutableVersionsEn)) {
        expect(i18n.exists(`immutableVersions.${key}`, { lng, fallbackLng: false }), `${lng}: ${key}`).toBe(true);
      }
    }
  });
});
