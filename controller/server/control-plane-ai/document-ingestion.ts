import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";

import JSZip from "jszip";
import mammoth from "mammoth";

import { ValidationError } from "../domain/errors.js";

export const MAX_DOCUMENTS = 3;
export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_EXTRACTED_CHARACTERS = 120_000;
const MAX_DOCX_MEMBERS = 500;
const MAX_DOCX_UNCOMPRESSED_BYTES = 25 * 1024 * 1024;

export type DocumentSection = { reference: string; heading: string; text: string };
export type ExtractedDocument = {
  id: string;
  name: string;
  format: "doc" | "docx" | "txt";
  size_bytes: number;
  sha256: string;
  character_count: number;
  section_count: number;
  sections: DocumentSection[];
};

const execute = promisify(execFile);

export async function extractDocuments(files: File[]): Promise<ExtractedDocument[]> {
  if (!files.length || files.length > MAX_DOCUMENTS) throw new ValidationError(`Upload between 1 and ${MAX_DOCUMENTS} documents.`);
  const total = files.reduce((value, file) => value + file.size, 0);
  if (total > MAX_TOTAL_BYTES) throw new ValidationError("The combined document size exceeds 10 MB.");
  const documents = await Promise.all(files.map((file, index) => extractDocument(file, index + 1)));
  if (documents.reduce((value, item) => value + item.character_count, 0) > MAX_EXTRACTED_CHARACTERS) {
    throw new ValidationError("The documents contain too much text for one analysis. Split them into smaller files.");
  }
  return documents;
}

export function documentAnalysisText(document: ExtractedDocument): string {
  return [
    `DOCUMENT ${document.id}: ${document.name}`,
    ...document.sections.flatMap((section) => [
      `[SOURCE ${section.reference}${section.heading ? ` | ${section.heading}` : ""}]`,
      section.text,
    ]),
  ].join("\n");
}

async function extractDocument(file: File, index: number): Promise<ExtractedDocument> {
  const name = basename(file.name || "document").trim();
  const extension = extname(name).toLocaleLowerCase("en-US");
  if (![".doc", ".docx", ".txt"].includes(extension)) {
    throw new ValidationError("Unsupported document type. Upload Word (.doc or .docx) or plain text (.txt).");
  }
  if (!file.size) throw new ValidationError(`${name} is empty.`);
  if (file.size > MAX_DOCUMENT_BYTES) throw new ValidationError(`${name} exceeds the 5 MB file limit.`);
  const bytes = Buffer.from(await file.arrayBuffer());
  const id = `document-${index}`;
  const sections = extension === ".docx"
    ? await docxSections(id, name, bytes)
    : extension === ".doc"
      ? await docSections(id, name, bytes)
      : textSections(id, name, decodeText(name, bytes));
  const characterCount = sections.reduce((value, item) => value + item.text.length, 0);
  if (characterCount < 20) throw new ValidationError(`${name} does not contain enough readable text to analyze.`);
  if (characterCount > MAX_EXTRACTED_CHARACTERS) throw new ValidationError(`${name} contains too much text for one analysis.`);
  return {
    id,
    name,
    format: extension.slice(1) as ExtractedDocument["format"],
    size_bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    character_count: characterCount,
    section_count: sections.length,
    sections,
  };
}

async function docxSections(id: string, name: string, bytes: Buffer): Promise<DocumentSection[]> {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new ValidationError(`${name} is not a valid DOCX document.`);
  try {
    const archive = await JSZip.loadAsync(bytes, { checkCRC32: true });
    const members = Object.values(archive.files);
    if (members.length > MAX_DOCX_MEMBERS) throw new ValidationError(`${name} contains too many embedded files.`);
    let uncompressed = 0;
    for (const member of members) {
      if (member.dir) continue;
      const size = (member as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
      if (!Number.isSafeInteger(size) || (size ?? 0) < 0) {
        throw new ValidationError(`${name} contains an unreadable ZIP member.`);
      }
      uncompressed += size ?? 0;
      if (uncompressed > MAX_DOCX_UNCOMPRESSED_BYTES) throw new ValidationError(`${name} expands beyond the safe DOCX limit.`);
    }
    const result = await mammoth.extractRawText({ buffer: bytes });
    return textSections(id, name, result.value);
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError(`${name} could not be read as DOCX.`);
  }
}

async function docSections(id: string, name: string, bytes: Buffer): Promise<DocumentSection[]> {
  if (!bytes.subarray(0, 8).equals(Buffer.from("d0cf11e0a1b11ae1", "hex"))) {
    throw new ValidationError(`${name} is not a valid Word .doc file.`);
  }
  const directory = await mkdtemp(join(tmpdir(), "tasklattice-doc-"));
  const source = join(directory, "source.doc");
  try {
    await writeFile(source, bytes, { mode: 0o600 });
    const result = await execute("antiword", [source], { timeout: 10_000, maxBuffer: MAX_EXTRACTED_CHARACTERS * 4 });
    return textSections(id, name, result.stdout);
  } catch {
    throw new ValidationError("Word .doc conversion is unavailable. Save the file as .docx and retry.");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function textSections(id: string, _name: string, raw: string): DocumentSection[] {
  const lines = raw.split(/\r?\n/);
  const sections: DocumentSection[] = [];
  for (let start = 0; start < lines.length; start += 20) {
    const text = cleanText(lines.slice(start, start + 20).join("\n"));
    if (!text) continue;
    sections.push({ reference: `${id}:lines-${start + 1}-${Math.min(start + 20, lines.length)}`, heading: "", text });
  }
  return sections;
}

function decodeText(name: string, bytes: Buffer): string {
  for (const encoding of ["utf-8", "utf-16le", "gb18030"] as const) {
    try {
      const value = new TextDecoder(encoding, { fatal: true }).decode(bytes);
      if (!value.includes("\0")) return value.replace(/^\uFEFF/, "");
    } catch { /* try the next reviewed encoding */ }
  }
  throw new ValidationError(`${name} is not valid UTF-8, UTF-16, or GB18030 text.`);
}

function cleanText(value: string): string {
  return value.split(/\r?\n/).map((line) => line.replace(/[ \t]+/g, " ").trim()).filter(Boolean).join("\n").trim();
}
