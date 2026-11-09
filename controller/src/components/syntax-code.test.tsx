import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SyntaxCode } from "./syntax-code";

afterEach(cleanup);

describe("immutable file syntax highlighting", () => {
  it("distinguishes JSON keys, strings, numbers and literals without rewriting the source", () => {
    const source = '{\r\n  "id": 9007199254740993, "escaped": "a\\nb\\\"c", "enabled": true, "empty": null\r\n}\n';
    const { container } = render(<SyntaxCode content={source} language="JSON" label="plan.json" />);
    expect(container.querySelector("code")!.textContent).toBe(source);
    expect(container.querySelector(".token.property")!.textContent).toBe('"id"');
    expect(container.querySelector(".token.number")!.textContent).toBe("9007199254740993");
    expect(container.querySelector(".token.string")!.textContent).toBe('"a\\nb\\\"c"');
    expect(container.querySelector(".token.boolean")!.textContent).toBe("true");
    expect(container.querySelector(".token.null")!.textContent).toBe("null");
  });

  it("highlights YAML keys, quoted strings, comments and literals without changing indentation", () => {
    const source = '# Config\nrails:\n  enabled: false\n  timeout: 30000\n  version: "1.0"\n';
    const { container } = render(<SyntaxCode content={source} language="yaml" label="config.yml" />);
    expect(container.querySelector("code")!.textContent).toBe(source);
    expect(container.querySelector(".token.key")!.textContent).toBe("rails");
    expect(container.querySelector(".token.boolean")!.textContent).toBe("false");
    expect(container.querySelector(".token.number")!.textContent).toBe("30000");
    expect(container.querySelector(".token.string")!.textContent).toBe('"1.0"');
    expect(container.querySelector(".token.comment")!.textContent).toBe("# Config");
  });

  it("highlights generated Colang flow statements and preserves strings containing hash marks", () => {
    const source = 'define subflow check input\n  # Run detection\n  $result = execute DetectAction(value=32)\n  if $result == True\n    bot say "blocked # reason"\n';
    const { container } = render(<SyntaxCode content={source} language="colang" label="rails.co" />);
    expect(container.querySelector("code")!.textContent).toBe(source);
    expect(container.querySelector(".token.keyword")!.textContent).toBe("define subflow");
    expect(container.querySelector(".token.variable")!.textContent).toBe("$result");
    expect(container.querySelector(".token.string")!.textContent).toBe('"blocked # reason"');
  });

  it.each(["json", "yaml", "colang", "plain"])("keeps HTML-looking file contents inert in %s", language => {
    const source = '{"html": "<img src=x onerror=alert(1) /><script>alert(1)</script>"}';
    const { container } = render(<SyntaxCode content={source} language={language} label="File content" />);
    expect(container.querySelector("code")!.textContent).toBe(source);
    expect(container.querySelector("img, script")).toBeNull();
    if (language === "plain") expect(container.querySelector(".token")).toBeNull();
  });
});

describe("Documentation code fences", () => {
  it.each([
    ["bash", "curl -sS -H \"Authorization: Bearer $TOKEN\" https://example.test # send", ".function"],
    ["sh", "export URL='https://example.test'", ".builtin"],
    ["http", "POST /backend/v1/scans HTTP/1.1\nContent-Type: application/json", ".method"],
    ["jsonl", "{\"input\":\"text\",\"flagOnly\":false}", ".property"],
  ])("highlights %s", (language, content, token) => {
    const { container, unmount } = render(<SyntaxCode content={content} language={language} label="example" />);
    expect(container.querySelector(token)).not.toBeNull();
    unmount();
  });

  it("keeps an unknown fence language as plain text", () => {
    const { container } = render(<SyntaxCode content="plain words" language="text" label="example" />);
    expect(container.querySelector(".token")).toBeNull();
    expect(container.textContent).toBe("plain words");
  });
});
