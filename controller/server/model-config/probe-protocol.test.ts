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

  it("uses NVIDIA's constrained inference shape for TopicControl", () => {
    const request = probeRequest({
      model: "nvidia/llama-3.1-nemoguard-8b-topic-control",
      profile: "tali.nemoguard-topic-control.v1",
      maxTokens: 512,
    });
    expect(request).toMatchObject({
      max_tokens: 20,
      top_p: 1,
      n: 1,
      stream: false,
      frequency_penalty: 0,
    });
    expect(request.messages[0]?.content).toMatch(/You must respond with "on-topic" or "off-topic"\.$/);
  });

  it("uses the review runtime's Lightning options and typed answers in its connection probe", () => {
    const request = probeRequest({
      model: "nvidia/nemotron-3.5-lightning-30b-a3b",
      profile: "tali.classifier-review.v1",
      maxTokens: 256,
    });
    expect(request).toHaveProperty("chat_template_kwargs.enable_thinking", false);
    for (const content of ['{"answers":{"unsafe_content":"no"}}', '{"unsafe_content":"yes"}']) {
      expect(() => validateProbeContent("tali.classifier-review.v1", content)).not.toThrow();
    }
    for (const content of ['{}', 'OK', '{"unsafe_content":true}', '{"unsafe_content":"no","extra":"yes"}']) {
      expect(() => validateProbeContent("tali.classifier-review.v1", content)).toThrow();
    }
  });
});

it("requires a typed PII verdict instead of accepting arbitrary JSON", () => {
  for (const verdict of ["safe", "pii", "unknown"]) {
    expect(() => validateProbeContent("tali.openai-compatible-pii.v1", JSON.stringify({ verdict }))).not.toThrow();
  }
  for (const content of ['{}', '{"verdict":true}', '{"verdict":"pii","replacement":"raw text"}', 'SAFE']) {
    expect(() => validateProbeContent("tali.openai-compatible-pii.v1", content)).toThrow();
  }
});
