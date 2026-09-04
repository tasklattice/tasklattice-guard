// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ControllerDatabase } from "../db/client.js";
import { OpenAICompatiblePlaygroundModel } from "../playground/service.js";
import { providerInputSchema, providerUpdateSchema } from "./domain.js";
import { providerFetch } from "./provider-fetch.js";
import { ModelConfigurationService } from "./service.js";

describe("Provider-scoped self-signed HTTPS", () => {
  let server: Server;
  let directory: string;
  let baseUrl: string;
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "guard-provider-tls-"));
    const key = join(directory, "key.pem");
    const cert = join(directory, "cert.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
    server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
      if (req.url === "/redirect") { res.writeHead(302, { location: "/v1/models" }); res.end(); return; }
      if (req.url === "/v1/classify") {
        res.setHeader("content-type", "application/json");
        req.resume();
        res.end(JSON.stringify({ jailbreak: false, score: 0.01 }));
        return;
      }
      req.resume();
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.url?.endsWith("/models") ? { data: [{ id: "internal-model" }] } : { choices: [{ message: { content: "OK" } }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    baseUrl = `https://127.0.0.1:${address.port}/v1`;
  });
  afterAll(async () => {
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (directory) rmSync(directory, { recursive: true });
  });

  it("defaults to verification and never applies creation defaults to PATCH", () => {
    expect(providerInputSchema.parse({ name: "Internal", kind: "openai", baseUrl }).skipTlsVerify).toBe(false);
    expect(providerUpdateSchema.parse({ name: "Renamed" })).toEqual({ name: "Renamed" });
    expect(providerUpdateSchema.parse({ skipTlsVerify: true })).toEqual({ skipTlsVerify: true });
    expect(providerUpdateSchema.safeParse({}).success).toBe(false);
  });

  it("discovers a self-signed Provider only after explicit opt-in, without weakening other Providers", async () => {
    const service = new ModelConfigurationService({} as ControllerDatabase, "test-secret", "");
    const draft = { name: "Internal", kind: "openai", baseUrl };
    await expect(service.discoverProviderDraft(draft)).rejects.toThrow("TLS certificate verification failed");
    expect(await service.discoverProviderDraft({ ...draft, skipTlsVerify: true })).toMatchObject({ models: [{ id: "internal-model" }] });
    await expect(service.discoverProviderDraft(draft)).rejects.toThrow("TLS certificate verification failed");
  });

  it("uses the same setting for actual Control Plane inference", async () => {
    const config = { provider: "Internal", baseUrl, apiKey: "test-key", model: "internal-model" };
    const input = { modelId: "internal-model", message: "Hello", history: [] };
    await expect(new OpenAICompatiblePlaygroundModel(config).complete(input)).rejects.toThrow();
    expect(await new OpenAICompatiblePlaygroundModel({ ...config, skipTlsVerify: true }).complete(input)).toMatchObject({ content: "OK" });
    await expect(new OpenAICompatiblePlaygroundModel(config).complete(input)).rejects.toThrow();
  });

  it("checks dedicated classifier connectivity over real self-signed TLS with no global bypass", async () => {
    const service = new ModelConfigurationService({} as ControllerDatabase, "test-secret", "");
    const draft = { name: "Private JailbreakDetect", kind: "custom-openai-compatible", baseUrl: `${baseUrl}/classify` };
    await expect(service.discoverProviderDraft(draft)).rejects.toThrow("TLS certificate verification failed");
    expect((await service.discoverProviderDraft({ ...draft, skipTlsVerify: true })).models[0]?.id).toBe("nvidia/nemoguard-jailbreak-detect");
    await expect(service.discoverProviderDraft(draft)).rejects.toThrow("TLS certificate verification failed");
  });

  it("does not carry an insecure transport across redirects", async () => {
    await expect(providerFetch(true)(baseUrl.replace("/v1", "/redirect"))).rejects.toThrow();
  });

  it("never injects an insecure dispatcher for HTTP or a secure Provider", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}));
    await providerFetch(true, fetcher)("http://internal.test/v1/models");
    await providerFetch(false, fetcher)("https://internal.test/v1/models");
    expect(fetcher.mock.calls.every(([, init]) => !init || !("dispatcher" in init))).toBe(true);
  });
});
