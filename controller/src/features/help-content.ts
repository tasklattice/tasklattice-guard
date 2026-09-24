import type { ComponentType } from "react";
import type { MDXProps } from "mdx/types";
import en from "@/content/help/en/interface.json";
import zh from "@/content/help/zh-CN/interface.json";

export type HelpLocale = "en" | "zh-CN";
export type HelpSection = { id: string; title: string; text: string; depth: number };
export type HelpDocument = {
  id: string;
  title: string;
  summary: string;
  outcome?: string;
  order: number;
  categoryId: string;
  categoryTitle: string;
  Content: ComponentType<MDXProps>;
  sections: HelpSection[];
  searchText: string;
  introText: string;
};
export type HelpCategory = {
  id: string;
  title: string;
  description: string;
  order: number;
  articles: HelpDocument[];
};
type MdxModule = {
  default: ComponentType<MDXProps>;
  frontmatter: Pick<HelpDocument, "id" | "title" | "summary" | "order" | "outcome">;
  sections: HelpSection[];
  searchText: string;
  introText: string;
};
type CategoryModule = { default: Pick<HelpCategory, "title" | "description" | "order"> };

// Directory names are the category IDs. MDX is compiled at build time, including
// when its source lives outside the controller package.
const articleModules = import.meta.glob<MdxModule>("../../../docs/document/*/*/*.mdx", { eager: true });
const categoryModules = import.meta.glob<CategoryModule>("../../../docs/document/*/*/_category.json", { eager: true });
const labels = { en, "zh-CN": zh };
const categoryPath = /\/docs\/document\/(en|zh-CN)\/([^/]+)\//;

export function getHelpContent(locale: HelpLocale) {
  const categories = Object.entries(categoryModules).flatMap(([path, module]) => {
    const match = path.match(categoryPath);
    if (!match || match[1] !== locale) return [];
    const id = match[2];
    const articles = Object.entries(articleModules).flatMap(([articlePath, articleModule]) => {
      const articleMatch = articlePath.match(categoryPath);
      if (!articleMatch || articleMatch[1] !== locale || articleMatch[2] !== id) return [];
      return [{ ...articleModule.frontmatter, categoryId: id, categoryTitle: module.default.title, Content: articleModule.default, sections: articleModule.sections, searchText: articleModule.searchText, introText: articleModule.introText }];
    }).sort((a, b) => a.order - b.order);
    if (articles.length < 2) throw new Error(`Document category ${locale}/${id} needs at least two articles`);
    return [{ id, ...module.default, articles }];
  }).sort((a, b) => a.order - b.order);
  const documents = categories.flatMap(category => category.articles);
  const ids = documents.flatMap(document => [document.id, ...document.sections.map(section => section.id)]);
  if (ids.length !== new Set(ids).size) throw new Error(`Duplicate document anchor in ${locale}: ${ids.filter((id, index) => ids.indexOf(id) !== index).join(", ")}`);
  if (!categories.some(category => category.id === "api")) throw new Error(`Missing API document category in ${locale}`);
  return { labels: labels[locale], categories, documents };
}
export type HelpContent = ReturnType<typeof getHelpContent>;
export type HelpSearchResult = { id: string; title: string; documentTitle: string; categoryTitle: string };

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
  return content.documents.flatMap(document => {
    const article = matches(`${document.title} ${document.summary} ${document.introText}`)
      ? [{ id: document.id, title: document.title, documentTitle: document.title, categoryTitle: document.categoryTitle }]
      : [];
    const sections = document.sections.filter(section => matches(`${section.title} ${section.text}`))
      .map(section => ({ id: section.id, title: section.title, documentTitle: document.title, categoryTitle: document.categoryTitle }));
    return [...article, ...sections];
  });
}
