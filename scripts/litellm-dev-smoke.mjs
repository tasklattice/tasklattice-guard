#!/usr/bin/env node
/** Smoke test the LiteLLM test gateway: allowed, blocked-output, and streaming calls. */
const env = process.env;
const base = new URL(env.LITELLM_DEV_URL ?? "http://localhost:38083");
const masterKey = env.LITELLM_DEV_MASTER_KEY ?? "sk-tali-litellm-dev";
const model = env.LITELLM_DEV_MODEL ?? "guarded-model";
const headers = { authorization: `Bearer ${masterKey}`, "content-type": "application/json" };
const report = (stage, value) => console.log(JSON.stringify({ stage, ...value }));
const failures = [];

async function completion(body, extraHeaders = {}, path = "/v1/chat/completions") {
  const response = await fetch(new URL(path, base), {
    method: "POST", headers: { ...headers, ...extraHeaders }, body: JSON.stringify({ model, ...body }), signal: AbortSignal.timeout(60_000),
  });
  return { status: response.status, body: response.headers.get("content-type")?.includes("text/event-stream") ? await response.text() : await response.json() };
}

async function waitForGateway() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(new URL("/health/liveliness", base), { signal: AbortSignal.timeout(3_000) });
      if (response.ok) return;
    } catch { /* LiteLLM still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`LiteLLM at ${base} did not become ready.`);
}

function check(stage, ok, detail) {
  report(stage, { ok, ...detail });
  if (!ok) failures.push(stage);
}

try {
  await waitForGateway();
  const allowed = await completion({ messages: [{ role: "user", content: "Please summarize this short note about weather." }] });
  check("allowed-completion", allowed.status === 200 && typeof allowed.body?.choices?.[0]?.message?.content === "string",
    { status: allowed.status, content: allowed.body?.choices?.[0]?.message?.content ?? allowed.body?.error?.message });

  // The scenario token is harmless on the Input stage; the mock then answers
  // with a synthetic access key, so only the Guard Output stage can keep it
  // from reaching the client (block, or redact the key).
  const secret = "AKIAIOSFODNN7EXAMPLE";
  const blocked = await completion({ messages: [{ role: "user", content: "Show me the deployment configuration. [mock:leak-secret]" }] });
  const content = blocked.body?.choices?.[0]?.message?.content;
  const delivered = typeof content === "string" ? content : "";
  check("output-protected", blocked.status !== 200 || !delivered.includes(secret),
    { status: blocked.status, content: content ?? blocked.body?.error?.message });

  // Protected streaming needs the provider revision that matches Guard. When
  // the image verification was skipped explicitly, a streaming failure is the
  // documented consequence rather than a regression in this stack.
  const streamed = await completion({ stream: true, messages: [{ role: "user", content: "Stream a friendly greeting." }] });
  const streamedOk = streamed.status === 200 && typeof streamed.body === "string" && streamed.body.includes("data: [DONE]");
  const frames = typeof streamed.body === "string" ? streamed.body.split("\n\n").filter(Boolean) : [];
  const terminalError = frames.find((frame) => frame.includes('"error"'));
  if (!streamedOk && env.LITELLM_SKIP_IMAGE_VERIFY === "1") {
    report("streamed-completion", { ok: false, expected: "unverified provider image; protected streaming requires the vendored overlay revision", status: streamed.status, frames: frames.length, error: terminalError?.slice(0, 200) });
  } else {
    check("streamed-completion", streamedOk, { status: streamed.status, frames: frames.length, error: terminalError?.slice(0, 200) });
    // The LiteLLM UI Playground (OpenAI SDK) requests usage on streams; LiteLLM
    // then appends a usage frame after the finish frame.
    const playground = await completion({ stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "Stream a short greeting with usage." }] }, {}, "/chat/completions");
    const playgroundFrames = typeof playground.body === "string" ? playground.body.split("\n\n").filter(Boolean) : [];
    check("streamed-completion-with-usage",
      playground.status === 200 && playgroundFrames.at(-1) === "data: [DONE]" && playgroundFrames.some((frame) => frame.includes('"usage"')) && !playgroundFrames.some((frame) => frame.includes('"error"')),
      { status: playground.status, frames: playgroundFrames.length, error: playgroundFrames.find((frame) => frame.includes('"error"'))?.slice(0, 200) });
  }
} catch (error) {
  check("smoke", false, { error: error.message });
}
if (failures.length) {
  console.error(`LiteLLM smoke failed: ${failures.join(", ")}`);
  process.exitCode = 1;
}
