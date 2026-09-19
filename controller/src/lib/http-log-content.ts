import type { RuntimeHttpRequest } from "@/lib/api-types";

export function httpBodyBytes(request: RuntimeHttpRequest): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(request.bodyBase64), character => character.charCodeAt(0));
}

/** Preserve the captured body bytes and repeated headers; display formatting never changes downloads. */
export function httpRequestBytes(request: RuntimeHttpRequest): Uint8Array<ArrayBuffer> {
  const head = `${request.method} ${request.target} HTTP/${request.httpVersion}\r\n${request.headers.map(([name, value]) => `${name}: ${value}\r\n`).join("")}\r\n`;
  // ASGI exposes HTTP header bytes as Latin-1, so restore those bytes without UTF-8 re-encoding.
  const header = Uint8Array.from(head, character => character.charCodeAt(0));
  const body = httpBodyBytes(request);
  const bytes = new Uint8Array(header.length + body.length);
  bytes.set(header);
  bytes.set(body, header.length);
  return bytes;
}

export type JsonToken = { text: string; kind: "key" | "string" | "number" | "literal" | "punctuation" | "space" };

/** Validate JSON, then format its original tokens to avoid rounding large numbers or changing escapes. */
export function formattedJsonTokens(body: string): JsonToken[] | null {
  try { JSON.parse(body); } catch { return null; }
  const tokens = body.match(/"(?:\\[\s\S]|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\],:]/g) ?? [];
  if (tokens.length > 8000) return null;
  const result: JsonToken[] = [];
  let depth = 0;
  const newline = () => result.push({ text: `\n${"  ".repeat(depth)}`, kind: "space" });
  for (const [index, text] of tokens.entries()) {
    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    if (text === "}" || text === "]") {
      depth--;
      if (previous !== "{" && previous !== "[") newline();
    }
    const kind = text.startsWith('"') ? next === ":" ? "key" : "string"
      : /^-?\d/.test(text) ? "number" : /^(true|false|null)$/.test(text) ? "literal" : "punctuation";
    result.push({ text, kind });
    if (text === "{" || text === "[") {
      depth++;
      if (depth > 64) return null;
      if (next !== "}" && next !== "]") newline();
    } else if (text === ",") newline();
    else if (text === ":") result.push({ text: " ", kind: "space" });
  }
  return result;
}

export function downloadLogFile(bytes: Uint8Array<ArrayBuffer>, filename: string, mimeType: string) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
