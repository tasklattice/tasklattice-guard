import { expect, it } from "vitest";
import { endpointRequestOrigin } from "./endpoint-origin.js";

it.each([
  ["https://guard.example.test:8443/api/v1/endpoints", {}, "https://guard.example.test:8443"],
  ["http://localhost:38081/api/v1/endpoints", {}, "http://localhost:38081"],
  ["http://controller:8080/api/v1/endpoints", { "x-forwarded-proto": "https" }, "https://controller:8080"],
  ["http://controller:8080/api/v1/endpoints", { "x-forwarded-proto": "https, http", "x-forwarded-host": "guard.example.test:8443, proxy.internal" }, "https://guard.example.test:8443"],
  ["http://controller:8080/api/v1/endpoints", { "x-forwarded-proto": "https", "x-forwarded-host": "[2001:db8::1]:8443" }, "https://[2001:db8::1]:8443"],
  // Origin identifies the caller, which may be a different app, not the Controller.
  ["https://guard.example.test/api/v1/endpoints", { origin: "https://another-app.test", referer: "https://another-app.test/page" }, "https://guard.example.test"],
] as const)("derives the external origin for %s with %j", (url, headers, expected) => {
  expect(endpointRequestOrigin(new Request(url, { headers }))).toBe(expected);
});

it.each([
  { "x-forwarded-host": "user@evil.test" },
  { "x-forwarded-host": "evil.test/path" },
  { "x-forwarded-host": "evil.test?query" },
  { "x-forwarded-host": "evil.test#fragment" },
  { "x-forwarded-host": "evil.test\\path" },
  { "x-forwarded-host": "guard.test:99999" },
  { "x-forwarded-proto": "javascript" },
])("ignores malformed forwarding headers %j", headers => {
  expect(endpointRequestOrigin(new Request("https://guard.example.test:8443/api/v1/endpoints", { headers })))
    .toBe("https://guard.example.test:8443");
});
