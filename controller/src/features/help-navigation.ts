import type { HelpContent, HelpDocument } from "./help-content";

export function documentPath(document: Pick<HelpDocument, "categoryId" | "id">) {
  return `/document/${document.categoryId}/${document.id}`;
}

export function documentHref(document: Pick<HelpDocument, "categoryId" | "id">, anchor = "") {
  return documentPath(document) + (anchor && anchor !== document.id ? `#${encodeURIComponent(anchor)}` : "");
}

// Only the old /document#... entry point searches across articles. On an article
// route, fragments always belong to that article, even if another uses the same ID.
const legacyAnchors: Record<string, string> = {
  "concept-scenario": "quickstart-protection",
  "core-concepts": "term-guardrail",
  "guide-operator": "user-lifecycle",
  "guide-admin": "platform-runtime",
  "guide-user": "user-lifecycle",
  "guide-developer": "endpoint-setup",
  "glossary": "glossary-definition",
  "glossary-runtime": "term-endpoint",
  "developer-actions": "term-rule-actions",
  "how-one-request-is-protected": "overview",
};

export function decodeDocumentAnchor(hash: string) {
  const value = hash.replace(/^#/, "");
  try { return decodeURIComponent(value); }
  catch { return value; }
}

export function resolveLegacyDocument(content: HelpContent, hash: string) {
  const value = decodeDocumentAnchor(hash);
  const anchor = legacyAnchors[value] ?? value;
  const article = anchor ? content.documents.find(document => document.id === anchor) : content.documents[0];
  if (article) return { document: article, anchor: "" };
  const matches = content.documents.filter(document => document.sections.some(section => section.id === anchor));
  return matches.length === 1 ? { document: matches[0], anchor } : undefined;
}
