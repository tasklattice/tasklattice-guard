import type { ComponentType } from "react";
import type { MDXProps } from "mdx/types";
import en from "@/content/help/en/interface.json";
import zh from "@/content/help/zh-CN/interface.json";

export type HelpLocale = "en" | "zh-CN";
export type HelpSection = { id: string; title: string; text: string };
export type HelpDocument = {
  kind: "api" | "overview" | "guide" | "glossary";
  id: string;
  title: string;
  summary: string;
  label?: string;
  audience?: "user" | "developer" | "operator";
  outcome?: string;
  order: number;
  Content: ComponentType<MDXProps>;
  sections: HelpSection[];
  searchText: string;
};
type MdxModule = {
  default: ComponentType<MDXProps>;
  frontmatter: Omit<HelpDocument, "Content" | "sections" | "searchText">;
  sections: HelpSection[];
  searchText: string;
};

// Vite compiles repository-authored MDX ahead of time. No runtime Markdown parser
// or second copy of the document body is shipped to the browser.
const modules = import.meta.glob<MdxModule>("../content/help/*/*.mdx", { eager: true });
const labels = { en, "zh-CN": zh };
export function getHelpContent(locale: HelpLocale) {
  const documents = Object.entries(modules).filter(([path]) => path.includes(`/${locale}/`))
    .map(([, module]) => ({ ...module.frontmatter, Content: module.default, sections: module.sections, searchText: module.searchText }))
    .sort((a, b) => a.order - b.order);
  const ids = documents.flatMap(document => [document.id, ...document.sections.map(section => section.id)]);
  if (ids.length !== new Set(ids).size) throw new Error(`Duplicate Help anchor in ${locale}`);
  const api = documents.find(document => document.kind === "api");
  if (!api) throw new Error(`Missing API Help document in ${locale}`);
  return { labels: labels[locale], api, documents: documents.filter(document => document !== api), guides: documents.filter(document => document.kind === "guide") };
}
export type HelpContent = ReturnType<typeof getHelpContent>;
export type HelpSearchResult = HelpSection & { documentTitle: string };

function normalize(value: string) {
  return value.trim().toLocaleLowerCase().replace(/[，。、：；（）/·—_-]+/g, " ");
}
export function searchHelpContent(content: HelpContent, query: string): HelpSearchResult[] {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const matches = (text: string) => {
    const haystack = normalize(text);
    const tokens = haystack.split(/[^a-z0-9]+/).filter(Boolean);
    return words.every(word => /^[a-z0-9]+$/.test(word) ? tokens.includes(word) : haystack.includes(word));
  };
  return [content.api, ...content.documents].flatMap(document => {
    const sections = document.sections.length ? document.sections : [{ id: document.id, title: document.title, text: `${document.summary} ${document.searchText}` }];
    return sections.filter(section => matches(`${section.title} ${section.text}`))
      .map(section => ({ ...section, documentTitle: document.title }));
  });
}
