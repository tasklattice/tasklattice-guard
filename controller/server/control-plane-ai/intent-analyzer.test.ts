import { describe, expect, it, vi } from "vitest";

import {
  IntentAnalysisError,
  OpenAICompatibleIntentAnalyzer,
  intentAnalysisPrompt,
} from "./intent-analyzer.js";

describe("OpenAI-compatible intent analyzer", () => {
  it("requests structured JSON and returns validated Topic boundaries", async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: "Bearer test-key" });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        model: "deepseek-test",
        temperature: 0,
        max_tokens: 1_200,
        response_format: { type: "json_object" },
        thinking: { type: "disabled" },
      });
      return Response.json({
        choices: [{
          message: {
            content: JSON.stringify({
              summary: "Finance data analysis only.",
              structured_purpose: {
                audience: "Finance analysts",
                tasks: "Approved reporting and data analysis",
                protect: "Internal financial data and approval boundaries",
                out_of_scope: "Biomedical or chemical-process guidance",
              },
              allowed_topics: ["Financial data analysis", "SQL and Python for finance"],
              restricted_topics: ["Biomedical research advice", "Chemical refining instructions"],
              review_notes: ["Confirm whether general statistics is allowed."],
            }),
          },
        }],
      });
    }) as typeof fetch;
    const analyzer = new OpenAICompatibleIntentAnalyzer({
      provider: "DeepSeek",
      baseUrl: "https://api.deepseek.test/",
      model: "deepseek-test",
      apiKey: "test-key",
      fetcher,
    });

    const result = await analyzer.analyze({
      purpose: "Finance analysts use this model for approved data analysis only.",
      language: "en",
    });

    expect(fetcher).toHaveBeenCalledWith("https://api.deepseek.test/chat/completions", expect.any(Object));
    expect(result.allowed_topics[0]).toBe("Financial data analysis");
    expect(result.restricted_topics.at(-1)).toBe("Chemical refining instructions");
  });

  it("rejects overlapping or malformed model output", async () => {
    const fetcher = vi.fn(async () => Response.json({
      choices: [{
        message: {
          content: "```json\n" + JSON.stringify({
            summary: "Draft.",
            structured_purpose: {
              audience: "Finance",
              tasks: "SQL",
              protect: "",
              out_of_scope: "",
            },
            allowed_topics: ["Finance", "SQL"],
            restricted_topics: ["finance", "Biomedicine"],
            review_notes: [],
          }) + "\n```",
        },
      }],
    })) as typeof fetch;
    const analyzer = new OpenAICompatibleIntentAnalyzer({
      provider: "DeepSeek",
      baseUrl: "https://api.deepseek.test",
      model: "deepseek-test",
      apiKey: "test-key",
      fetcher,
    });

    await expect(analyzer.analyze({ purpose: "A sufficiently detailed business purpose.", language: "en" }))
      .rejects.toThrow(/overlapping/);
  });

  it("maps provider and response failures to a stable Controller error", async () => {
    const analyzer = new OpenAICompatibleIntentAnalyzer({
      provider: "DeepSeek",
      baseUrl: "https://api.deepseek.test",
      model: "deepseek-test",
      apiKey: "test-key",
      fetcher: vi.fn(async () => new Response(null, { status: 401 })) as typeof fetch,
    });

    await expect(analyzer.analyze({ purpose: "A sufficiently detailed business purpose.", language: "en" }))
      .rejects.toBeInstanceOf(IntentAnalysisError);
  });

  it("pins primary-intent semantics and output language in the prompt", () => {
    expect(intentAnalysisPrompt("zh-CN")).toContain("primary business task");
    expect(intentAnalysisPrompt("zh-CN")).toContain("financial analysis of a chemical company");
    expect(intentAnalysisPrompt("zh-CN")).toContain("Simplified Chinese");
  });
});
