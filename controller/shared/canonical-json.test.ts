// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical-json.js";

type Vectors = { valid: Array<{ name: string; value: unknown; canonical: string }>; invalid: Array<{ name: string; value: unknown }> };
const vectors = JSON.parse(readFileSync(resolve("../tests/fixtures/canonical-json/vectors.json"), "utf8")) as Vectors;

describe("canonicalJson", () => {
  it.each(vectors.valid)("matches the Runner encoding: $name", ({ value, canonical }) => {
    expect(canonicalJson(value)).toBe(canonical);
  });

  it.each(vectors.invalid)("rejects values without one cross-language encoding: $name", ({ value }) => {
    expect(() => canonicalJson(value)).toThrow();
  });

  it("drops undefined object members like JSON and rejects non-plain objects", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe("{\"b\":1}");
    expect(canonicalJson({ at: new Date("2026-10-08T00:00:00.000Z") })).toBe("{\"at\":\"2026-10-08T00:00:00.000Z\"}");
    expect(() => canonicalJson(new Map())).toThrow(/plain objects/);
    expect(() => canonicalJson([undefined])).toThrow(/undefined/);
  });
});
