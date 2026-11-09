import { expect, it } from "vitest";
import {
  endpointRequest,
  importRequest,
  newHeader,
  routerRequest,
  serializeRequest,
} from "./path-request-model";
import { parseHttpRequest } from "../../../shared/playground-path";
it("keeps the selected Endpoint ID in generated Scan requests", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const request = parseHttpRequest(serializeRequest(endpointRequest(id, "scan")));
  expect(request.path).toBe(`/runtime/v1/endpoints/${id}/backend/v1/scans`);
  expect(request.method).toBe("POST");
  expect(JSON.parse(request.body).input).toBe("Hello, can you help me?");
});
it("serializes one editable document, excludes disabled headers, and preserves a header-free body", () => {
  const draft = routerRequest();
  draft.headers = [{ ...newHeader("X-Hidden", "secret"), enabled: false }];
  draft.body = "exact body";
  const parsed = parseHttpRequest(serializeRequest(draft));
  expect(parsed.body).toBe("exact body");
  expect(parsed.headers).not.toHaveProperty("x-hidden");
});
it("preserves repeated headers when importing and rejects header newline injection", () => {
  const draft = importRequest(
    "POST /chat HTTP/1.1\nX-Tag: a\nX-Tag: b\n\nhello",
  );
  expect(parseHttpRequest(serializeRequest(draft)).headers["x-tag"]).toEqual([
    "a",
    "b",
  ]);
  draft.headers[0].value = "a\nAuthorization: token";
  expect(() => serializeRequest(draft)).toThrow("newlines");
});
