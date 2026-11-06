import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ModelProtocolSettings } from "./model-protocol-settings";
import { configureModelRuntimeSettings, configureModelDefinition, type ModelDefinition } from "@/lib/controller-api";
vi.mock("@/lib/controller-api", () => ({ configureModelRuntimeSettings: vi.fn(), configureModelDefinition: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });
it("updates concurrency for an assigned model without rewriting its locked protocol", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const model = { id: "registered-model", name: "Registered", providerName: "Provider", model: "judge", profile: "tali.qwen3guard.v1", timeoutSeconds: 20, maxTokens: 512, maxConcurrency: 2, protocolEditable: false } as ModelDefinition;
  vi.mocked(configureModelRuntimeSettings).mockResolvedValue({ ...model, maxConcurrency: 3 });
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const changed = vi.fn(async () => {});
  render(<QueryClientProvider client={client}><ModelProtocolSettings models={[model]} disabled={false} onChanged={changed} /></QueryClientProvider>);
  fireEvent.click(screen.getByRole("button", { name: "providerRegistration.configureModel" }));
  fireEvent.click(screen.getByRole("combobox"));
  fireEvent.click(await screen.findByRole("option", { name: "Registered · Provider" }));
  const concurrency = screen.getByLabelText("modelSettings.maxConcurrency");
  expect((concurrency as HTMLInputElement).disabled).toBe(false);
  expect(screen.queryByLabelText("modelSettings.lowerThreshold")).toBeNull();
  expect(screen.queryByText("providerRegistration.layaRequestMode")).toBeNull();
  fireEvent.change(concurrency, { target: { value: "3" } });
  fireEvent.click(screen.getByRole("button", { name: "common.save" }));
  await waitFor(() => expect(configureModelRuntimeSettings).toHaveBeenCalledWith("registered-model", { maxConcurrency: 3, rateLimitAttempts: 3, lowerThreshold: 0.1, upperThreshold: 0.9 }));
  expect(configureModelDefinition).not.toHaveBeenCalled();
  expect(changed).toHaveBeenCalled();
  client.clear();
});

it("validates a decision model's threshold pair and saves zero with independent retry settings", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const model = { id: "laya", name: "Laya", providerName: "Provider", providerKind: "laya", model: "auto", profile: "tali.laya.v1", timeoutSeconds: 20, maxTokens: 512, maxConcurrency: 2, protocolEditable: false } as ModelDefinition;
  vi.mocked(configureModelRuntimeSettings).mockResolvedValue(model);
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><ModelProtocolSettings models={[model]} disabled={false} onChanged={async () => {}} /></QueryClientProvider>);
  fireEvent.click(screen.getByRole("button", { name: "providerRegistration.configureModel" }));
  fireEvent.click(screen.getByRole("combobox"));
  fireEvent.click(await screen.findByRole("option", { name: "Laya · Provider" }));
  const lower = screen.getByLabelText("modelSettings.lowerThreshold");
  fireEvent.change(lower, { target: { value: "0.9" } });
  expect(screen.getByRole("alert").textContent).toBe("modelSettings.thresholdOrderError");
  expect((screen.getByRole("button", { name: "common.save" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(lower, { target: { value: "0" } });
  fireEvent.change(screen.getByLabelText("modelSettings.upperThreshold"), { target: { value: "0.85" } });
  fireEvent.change(screen.getByLabelText("modelSettings.rateLimitAttempts"), { target: { value: "1" } });
  fireEvent.click(screen.getByRole("button", { name: "common.save" }));
  await waitFor(() => expect(configureModelRuntimeSettings).toHaveBeenCalledWith("laya", {
    maxConcurrency: 2, rateLimitAttempts: 1, lowerThreshold: 0, upperThreshold: 0.85,
  }));
  expect(configureModelDefinition).not.toHaveBeenCalled();
  client.clear();
});

it("shows the stored Laya request mode read-only while the protocol stays locked", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const model = { id: "laya", name: "Laya", providerName: "Provider", providerKind: "laya", model: "auto", profile: "tali.laya.v1", timeoutSeconds: 20, maxTokens: 512, maxConcurrency: 2, protocolEditable: false, layaRequestMode: "native" } as ModelDefinition;
  vi.mocked(configureModelRuntimeSettings).mockResolvedValue(model);
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><ModelProtocolSettings models={[model]} disabled={false} onChanged={async () => {}} /></QueryClientProvider>);
  fireEvent.click(screen.getByRole("button", { name: "providerRegistration.configureModel" }));
  fireEvent.click(screen.getByRole("combobox"));
  fireEvent.click(await screen.findByRole("option", { name: "Laya · Provider" }));
  expect(screen.getByText("providerRegistration.layaRequestMode")).toBeTruthy();
  expect(screen.getByText("providerRegistration.layaRequestModeNative")).toBeTruthy();
  expect(screen.getByText("providerRegistration.layaRequestModeHint")).toBeTruthy();
  expect(screen.queryByText("providerRegistration.layaRequestModeNotDetected")).toBeNull();
  expect(screen.getAllByRole("combobox")[1]!.hasAttribute("disabled")).toBe(true);
  client.clear();
});

it("explains that a Laya request mode is not detected yet and is refreshed by Test call", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const model = { id: "laya-null", name: "Laya", providerName: "Provider", providerKind: "laya", model: "auto", profile: "tali.laya-topic.v1", timeoutSeconds: 20, maxTokens: 512, maxConcurrency: 2, protocolEditable: true, layaRequestMode: null } as ModelDefinition;
  vi.mocked(configureModelDefinition).mockResolvedValue(model);
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><ModelProtocolSettings models={[model]} disabled={false} onChanged={async () => {}} /></QueryClientProvider>);
  fireEvent.click(screen.getByRole("button", { name: "providerRegistration.configureModel" }));
  fireEvent.click(screen.getByRole("combobox"));
  fireEvent.click(await screen.findByRole("option", { name: "Laya · Provider" }));
  expect(screen.getByText("providerRegistration.layaRequestModeNotDetected")).toBeTruthy();
  expect(screen.getByText(/providerRegistration\.layaRequestModeNotDetectedHint/)).toBeTruthy();
  expect(screen.getByText("providerRegistration.layaRequestModeHint")).toBeTruthy();
  expect(screen.queryByText("providerRegistration.layaRequestModeNative")).toBeNull();
  client.clear();
});
