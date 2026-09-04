import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { jailbreakDetectEndpoint, jailbreakDetectProfile, jailbreakDetectResponse } from "./jailbreak-detect.js";
import { probeRequest } from "./service.js";

const endpoints = JSON.parse(readFileSync(resolve("../tests/fixtures/jailbreak-detect-endpoints.json"), "utf8")) as Array<[string, string]>;
describe("JailbreakDetect native protocol", () => {
  it.each(endpoints)("routes %s to the same endpoint as Runner", (base, expected) => {
    expect(jailbreakDetectEndpoint(base)).toBe(expected);
  });
  it.each(["https://user:secret@nim.test/v1", "https://nim.test/v1?token=secret", "https://nim.test/v1#fragment"])("rejects ambiguous endpoint %s", (base) => {
    expect(() => jailbreakDetectEndpoint(base)).toThrow();
  });
  it("does not build a chat request for the dedicated protocol", () => {
    expect(() => probeRequest({ model: "nvidia/nemoguard-jailbreak-detect", profile: jailbreakDetectProfile, maxTokens: 512 })).toThrow("classification API");
    expect(jailbreakDetectResponse.safeParse({ jailbreak: false, score: Infinity }).success).toBe(false);
  });

  it("accepts NVIDIA's signed confidence score", () => {
    expect(jailbreakDetectResponse.parse({ jailbreak: false, score: -0.9935975138523108 })).toEqual({
      jailbreak: false,
      score: -0.9935975138523108,
    });
    expect(jailbreakDetectResponse.safeParse({ jailbreak: false, score: -1.01 }).success).toBe(false);
  });
});
