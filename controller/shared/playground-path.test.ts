import { describe, expect, it } from "vitest";
import {
  parseHttpRequest,
  requestSource,
  redactHttpRequest,
} from "./playground-path.js";
describe("HTTP path test input", () => {
  it("parses HTTP and keeps repeated headers and body without interpreting shell text", () => {
    const input = parseHttpRequest(
      "POST /chat?q=a HTTP/1.1\r\nHost: example.com:443\r\nX-Tag: a\r\nX-Tag: b\r\nAuthorization: secret\r\n\r\n$(touch /tmp/no)",
    );
    expect(input.body).toBe("$(touch /tmp/no)");
    expect(requestSource(input)).toMatchObject({
      "x-tag": ["a", "b"],
      ":host": ["example.com"],
      ":path": ["/chat"],
    });
    expect(requestSource(input)).not.toHaveProperty("authorization");
  });
  it("imports curl as data and removes credentials from history", () => {
    const source = `curl 'https://example.com/chat' -H 'X-Api-Key: secret' --data-raw '{"message":"hello"}'`;
    expect(parseHttpRequest(source)).toMatchObject({
      method: "POST",
      path: "/chat",
      body: '{"message":"hello"}',
    });
    expect(redactHttpRequest(source)).not.toContain("secret");
  });
  it.each([
    "curl https://example.com --data @secret.txt",
    "curl https://example.com --proxy localhost",
    "curl 'unterminated",
    "POST file:///secret HTTP/1.1",
    "not a request",
  ])("rejects unsupported or malformed input: %s", (input) => {
    expect(() => parseHttpRequest(input)).toThrow();
  });
});
