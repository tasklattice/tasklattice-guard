// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readZip, writeZip, type ZipLimits } from "./zip.js";

const limits: ZipLimits = { maxEntries: 8, maxEntryBytes: 1024, maxTotalBytes: 2048 };
const files = () => new Map([["b.json", Buffer.from("{\"b\":1}\n")], ["versions/v/a.json", Buffer.from("{}\n")]]);

/** Rewrite one central-directory field of the first entry. */
function patchCentral(archive: Buffer, offset: number, write: (buffer: Buffer, at: number) => void): Buffer {
  const copy = Buffer.from(archive);
  const at = copy.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  write(copy, at + offset);
  return copy;
}

describe("release package archives", () => {
  it("round-trips and writes byte-identical archives for identical content", () => {
    const archive = writeZip(files());
    expect(writeZip(files()).equals(archive)).toBe(true);
    expect(readZip(archive, limits)).toEqual(files());
  });

  it.each([
    ["path traversal", "../escape.json"],
    ["absolute path", "/etc/passwd"],
    ["backslash path", "versions\\v\\a.json"],
    ["dot segment", "versions/./a.json"],
  ])("rejects %s", (_name, path) => {
    expect(() => readZip(writeZip(new Map([[path, Buffer.from("{}")]])), limits)).toThrow(/not an allowed path/);
  });

  it("rejects duplicate names that extractors would silently collapse", () => {
    const archive = writeZip(new Map([["a.json", Buffer.from("1")], ["b.json", Buffer.from("2")]]));
    // Rename the second entry to the first in both headers.
    const copy = Buffer.from(archive);
    let index = -1;
    while ((index = copy.indexOf("b.json", index + 1)) >= 0) copy.write("a.json", index);
    expect(() => readZip(copy, limits)).toThrow(/more than once|checksum/);
  });

  it("rejects symlinks and encrypted entries", () => {
    const archive = writeZip(files());
    expect(() => readZip(patchCentral(archive, 38, (b, at) => b.writeUInt32LE((0o120777 << 16) >>> 0, at)), limits)).toThrow(/not a regular file/);
    expect(() => readZip(patchCentral(archive, 8, (b, at) => b.writeUInt16LE(0x0801, at)), limits)).toThrow(/encrypted/);
  });

  it("stops a decompression bomb before allocating it, whatever the declared size", () => {
    const bomb = writeZip(new Map([["bomb.json", Buffer.alloc(64 * 1024, 0x20)]]));
    expect(() => readZip(bomb, limits)).toThrow(/size limit/);
    const understated = patchCentral(bomb, 24, (b, at) => b.writeUInt32LE(10, at));
    expect(() => readZip(understated, limits)).toThrow(/size limit|does not match/);
  });

  it("enforces entry count and total size", () => {
    expect(() => readZip(writeZip(new Map(Array.from({ length: 9 }, (_, i) => [`f${i}.json`, Buffer.from("{}")]))), limits)).toThrow(/more than 8 entries/);
    expect(() => readZip(writeZip(new Map(Array.from({ length: 3 }, (_, i) => [`f${i}.json`, Buffer.alloc(1000, 0x20)]))), limits)).toThrow(/size limit/);
  });

  it("rejects truncated or non-ZIP input", () => {
    expect(() => readZip(Buffer.from("not a zip"), limits)).toThrow(/no ZIP directory/);
    const archive = writeZip(files());
    expect(() => readZip(archive.subarray(0, archive.length - 5), limits)).toThrow();
  });
});
