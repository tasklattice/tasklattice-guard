import type { HelpDocument } from "./help-content";

export function documentPath(document: Pick<HelpDocument, "categoryId" | "id">) {
  return `/document/${document.categoryId}/${document.id}`;
}

export function documentHref(document: Pick<HelpDocument, "categoryId" | "id">, anchor = "") {
  return documentPath(document) + (anchor && anchor !== document.id ? `#${encodeURIComponent(anchor)}` : "");
}

export function decodeDocumentAnchor(hash: string) {
  const value = hash.replace(/^#/, "");
  try { return decodeURIComponent(value); }
  catch { return value; }
}
