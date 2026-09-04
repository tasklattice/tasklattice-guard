import { describe, expect, it } from "vitest";

import { probeRequest, validateProbeContent } from "./service.js";

describe("replaceable model probe protocols", () => {
  it("uses the OpenAI-compatible chat envelope for DeepSeek Flash", () => {
    const request = probeRequest({
      model: "deepseek-v4-flash",
      profile: "generic-chat",
      maxTokens: 128,
    });

    expect(request.model).toBe("deepseek-v4-flash");
    expect(request.temperature).toBe(0);
    expect(request.messages).toEqual([{ role: "user", content: "Reply with exactly OK." }]);
    expect(() => validateProbeContent("generic-chat", "OK")).not.toThrow();
  });

  it.each([
    {
      model: "nvidia/llama-3.1-nemotron-safety-guard-8b-v3",
      profile: "tali.nemotron-safety-guard-v3.v1" as const,
      marker: "<BEGIN UNSAFE CONTENT CATEGORIES>",
      response: '{"User Safety":"safe"}',
    },
    {
      model: "nvidia/llama-3.1-nemoguard-8b-topic-control",
      profile: "tali.nemoguard-topic-control.v1" as const,
      marker: "Kubernetes administration",
      response: "on-topic",
    },
    {
      model: "example/jailbreak-judge",
      profile: "tali.openai-compatible-jailbreak.v1" as const,
      marker: "SAFE or JAILBREAK",
      response: "SAFE",
    },
  ])("validates the configured protocol for $model", ({ model, profile, marker, response }) => {
    const request = probeRequest({ model, profile, maxTokens: 128 });
    expect(JSON.stringify(request.messages)).toContain(marker);
    expect(() => validateProbeContent(profile, response)).not.toThrow();
  });

  it("validates the Qwen3Guard mock protocol as a single multi-capability model", () => {
    const request = probeRequest({
      model: "Qwen/Qwen3Guard-Gen-8B",
      profile: "tali.qwen3guard.v1",
      maxTokens: 128,
    });
    expect(request.model).toBe("Qwen/Qwen3Guard-Gen-8B");
    expect(() => validateProbeContent(
      "tali.qwen3guard.v1",
      "Safety: Unsafe\nCategories: Jailbreak",
    )).not.toThrow();
  });
});
