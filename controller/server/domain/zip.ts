import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import { ControllerError } from "./errors.js";

/**
 * Minimal ZIP support for Guardrail release packages. Writing is
 * deterministic (fixed timestamps, sorted entries) so the same content
 * exports to the same bytes. Reading trusts nothing in the archive: entry
 * count and names come from the central directory, sizes are bounded before
 * and during inflation, and anything but plain files is rejected.
 */

export type ZipLimits = { maxEntries: number; maxEntryBytes: number; maxTotalBytes: number };

const DOS_DATE = (1 << 5) | 1; // 1980-01-01, the earliest DOS date.
const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;

export function writeZip(files: ReadonlyMap<string, Buffer>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const name of [...files.keys()].sort()) {
    const data = files.get(name)!;
    const nameBytes = Buffer.from(name, "utf8");
    const compressed = deflateRawSync(data, { level: 9 });
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_HEADER, 0);
    central.writeUInt16LE(0x0314, 4); // Unix, ZIP 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, compressed);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

export function readZip(archive: Buffer, limits: ZipLimits): Map<string, Buffer> {
  const invalid = (detail: string) => new ControllerError(`The package is not a valid release archive: ${detail}`, 422, "guardrail_package_invalid");
  const endOffset = findEndOfCentralDirectory(archive);
  if (endOffset < 0) throw invalid("no ZIP directory was found.");
  const entries = archive.readUInt16LE(endOffset + 10);
  const directorySize = archive.readUInt32LE(endOffset + 12);
  const directoryOffset = archive.readUInt32LE(endOffset + 16);
  if (archive.readUInt16LE(endOffset + 4) !== 0 || archive.readUInt16LE(endOffset + 8) !== entries) throw invalid("multi-disk archives are not supported.");
  if (entries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) throw invalid("ZIP64 archives are not supported.");
  if (entries > limits.maxEntries) throw invalid(`more than ${limits.maxEntries} entries.`);
  if (directoryOffset + directorySize > endOffset) throw invalid("the directory is outside the archive.");
  const files = new Map<string, Buffer>();
  let total = 0;
  let cursor = directoryOffset;
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > endOffset || archive.readUInt32LE(cursor) !== CENTRAL_HEADER) throw invalid("a directory entry is corrupt.");
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const checksum = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const size = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const externalAttributes = archive.readUInt32LE(cursor + 38);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    cursor += 46 + nameLength + extraLength + commentLength;
    if (flags & 0x1) throw invalid(`${name} is encrypted.`);
    if (method !== 0 && method !== 8) throw invalid(`${name} uses an unsupported compression method.`);
    const mode = externalAttributes >>> 16;
    if ((mode & 0o170000) !== 0 && (mode & 0o170000) !== 0o100000) throw invalid(`${name} is not a regular file.`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(name) || name.split("/").some(part => part === "." || part === "..")) {
      throw invalid(`${JSON.stringify(name)} is not an allowed path.`);
    }
    if (files.has(name)) throw invalid(`${name} appears more than once.`);
    if (size > limits.maxEntryBytes || (total += size) > limits.maxTotalBytes) throw invalid(`${name} exceeds the size limit.`);
    if (localOffset + 30 > directoryOffset || archive.readUInt32LE(localOffset) !== LOCAL_HEADER) throw invalid(`${name} has no local header.`);
    const dataOffset = localOffset + 30 + archive.readUInt16LE(localOffset + 26) + archive.readUInt16LE(localOffset + 28);
    if (dataOffset + compressedSize > directoryOffset) throw invalid(`${name} extends beyond its data.`);
    const stored = archive.subarray(dataOffset, dataOffset + compressedSize);
    let data: Buffer;
    try {
      // maxOutputLength stops a decompression bomb before it allocates.
      data = method === 0 ? Buffer.from(stored) : inflateRawSync(stored, { maxOutputLength: limits.maxEntryBytes });
    } catch {
      throw invalid(`${name} could not be decompressed within the size limit.`);
    }
    if (data.length !== size || crc32(data) !== checksum) throw invalid(`${name} does not match its recorded size or checksum.`);
    files.set(name, data);
  }
  return files;
}

function findEndOfCentralDirectory(archive: Buffer): number {
  const earliest = Math.max(0, archive.length - 22 - 0xffff);
  for (let offset = archive.length - 22; offset >= earliest; offset -= 1) {
    if (archive.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY && offset + 22 + archive.readUInt16LE(offset + 20) === archive.length) return offset;
  }
  return -1;
}
