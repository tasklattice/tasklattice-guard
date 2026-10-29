import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { createModelDefinition, discoverModelProvider, discoverProviderDraft, registerProviderModels, revalidateModelDefinition, testModelConnection, type ModelDefinition, type ModelProvider } from "@/lib/controller-api";
import { RegisterModelsDrawer } from "./register-models-drawer";
import { createProviderDraft } from "./provider-ui-registry";
import { suggestedProfile } from "./model-selection";
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));

vi.mock("@/lib/controller-api", () => ({
  createModelDefinition: vi.fn(), discoverModelProvider: vi.fn(), discoverProviderDraft: vi.fn(),
  registerProviderModels: vi.fn(), revalidateModelDefinition: vi.fn(),
  testModelConnection: vi.fn(),
}));

const provider: ModelProvider = { id: "provider-1", name: "Saved NVIDIA", kind: "custom-openai-compatible", baseUrl: "https://provider.test/v1", credentialHint: "Stored", credentialConfigured: true, status: "validated", validationMessage: "Connected", validationLatencyMs: 1, validatedAt: null };
const ready: ModelDefinition = { id: "model-1", name: "Chat", model: "chat", profile: "generic-chat", providerId: provider.id, providerKind: provider.kind, providerName: provider.name, timeoutSeconds: 20, maxTokens: 512, status: "pending", validationMessage: "Registered", validatedAt: null, validationLatencyMs: null, connectionStatus: "validated", connectionCheckedAt: "2026-09-03T00:00:00Z", connectionLatencyMs: 23 };
let client: QueryClient;
const onChanged = vi.fn(async () => {});
const onOpenChange = vi.fn();
function mount(intent: "add-provider" | "register-models" = "register-models", models: ModelDefinition[] = [], providers = [provider]) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><RegisterModelsDrawer open intent={intent} providers={providers} registeredModels={models} onChanged={onChanged} onOpenChange={onOpenChange} /></QueryClientProvider>);
}
async function chooseProvider(name: string) {
  fireEvent.click(screen.getByRole("combobox", { name: "Select Provider" }));
  fireEvent.click(await screen.findByRole("option", { name: new RegExp(name) }));
}
describe("Relay registration workflow", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    await i18n.changeLanguage("en");
    vi.mocked(discoverModelProvider).mockResolvedValue({ providerId: provider.id, providerName: provider.name, models: [{ id: "chat", name: "Chat" }, { id: "Qwen/Qwen3Guard-Gen-8B", name: "Qwen Guard" }] });
    vi.mocked(discoverProviderDraft).mockResolvedValue({ providerName: "DeepSeek", models: [{ id: "chat", name: "Chat" }] });
    vi.mocked(createModelDefinition).mockImplementation(async (input) => ({ ...ready, ...input, id: input.model }));
    vi.mocked(registerProviderModels).mockResolvedValue({ provider, models: [ready], failures: [] });
  });
  afterEach(() => { cleanup(); client?.clear(); vi.unstubAllGlobals(); });

  it("uses Relay endpoint presets and retains the three NVIDIA/Qwen protocol adapters", () => {
    expect(createProviderDraft("nvidia-nim")).toMatchObject({ kind: "custom-openai-compatible", baseUrl: "https://integrate.api.nvidia.com/v1", apiKey: "" });
    expect(createProviderDraft("ollama").baseUrl).toBe("http://host.docker.internal:11434/v1");
    expect(suggestedProfile("nvidia/llama-3.1-nemotron-safety-guard-8b-v3")).toBe("tali.nemotron-safety-guard-v3.v1");
    expect(suggestedProfile("nvidia/llama-3.1-nemoguard-8b-topic-control")).toBe("tali.nemoguard-topic-control.v1");
    expect(suggestedProfile("nvidia/llama-3.1-nemoguard-8b-content-safety")).toBe("tali.nemotron-content-safety.v1");
    expect(suggestedProfile("Qwen/Qwen3Guard-Gen-8B")).toBe("tali.qwen3guard.v1");
  });

  it("discovers first, selects multiple models, and registers only on confirmation", async () => {
    mount();
    expect(discoverModelProvider).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discover models" }));
    await waitFor(() => expect(discoverModelProvider).toHaveBeenCalledWith(provider.id));
    await screen.findByRole("heading", { name: "Discovered models" });
    const second = await screen.findByRole("button", { name: /Qwen Guard Qwen\/Qwen3Guard/ });
    expect(screen.getByRole("button", { name: "Chat chat" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Chat chat" }));
    fireEvent.click(second);
    expect(createModelDefinition).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Compatibility profile")).toBeNull();
    expect(screen.queryByLabelText("Display name")).toBeNull();
    const selected = screen.getByRole("region", { name: "Selected models" });
    expect(within(selected).getByText("chat")).toBeTruthy();
    expect(within(selected).getByText("Qwen/Qwen3Guard-Gen-8B")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Search models…" }), { target: { value: "other search" } });
    expect(screen.queryByRole("button", { name: "Chat chat" })).toBeNull();
    expect(within(selected).getAllByRole("button", { name: /Deselect/ })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Register 2 models" }));
    await screen.findByText("Registration complete");
    expect(screen.getAllByText("Callable")).toHaveLength(2);
    expect(revalidateModelDefinition).not.toHaveBeenCalled();
    expect(createModelDefinition).toHaveBeenCalledTimes(2);
    expect(createModelDefinition).toHaveBeenCalledWith(expect.objectContaining({ providerId: provider.id, model: "Qwen/Qwen3Guard-Gen-8B", profile: "tali.qwen3guard.v1" }));
    expect(onOpenChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("offers Laya independently and registers its suggested decision model without catalog discovery", async () => {
    mount("add-provider");
    await chooseProvider("Laya");
    expect((screen.getByLabelText("Base URL") as HTMLInputElement).value).toBe("");
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://laya.test/v1" } });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "synthetic-laya-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Choose models" }));
    await screen.findByText("Choose a Laya decision model");
    expect(discoverProviderDraft).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^Register 1 model/ }));
    await waitFor(() => expect(registerProviderModels).toHaveBeenCalledWith({
      connection: { name: "Laya", kind: "laya", baseUrl: "https://laya.test/v1", apiKey: "synthetic-laya-key" },
      models: [expect.objectContaining({ model: "laya", profile: "tali.laya.v1" })],
    }));
  });

  it("keeps the provider catalog grouped and supports search and keyboard selection", async () => {
    mount("add-provider");
    const picker = screen.getByRole("combobox", { name: "Select Provider" });
    fireEvent.click(picker);
    expect(within(screen.getByRole("group", { name: "Popular" })).getByRole("option", { name: /OpenAI/ })).toBeTruthy();
    expect(within(screen.getByRole("group", { name: "Chinese Providers" })).getAllByRole("option")).toHaveLength(2);
    expect(within(screen.getByRole("group", { name: "Infrastructure" })).getByRole("option", { name: /NVIDIA/ })).toBeTruthy();
    expect(within(screen.getByRole("group", { name: "Self-Hosted \/ Custom" })).getAllByRole("option")).toHaveLength(3);
    fireEvent.change(picker, { target: { value: "NVIDIA" } });
    expect(screen.queryByRole("group", { name: "Popular" })).toBeNull();
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(picker, { key: "ArrowDown" });
    fireEvent.keyDown(picker, { key: "Enter" });
    expect((screen.getByLabelText("Base URL") as HTMLInputElement).value).toBe("https://integrate.api.nvidia.com/v1");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(registerProviderModels).not.toHaveBeenCalled();
    fireEvent.click(picker);
    fireEvent.change(picker, { target: { value: "missing-provider" } });
    expect(screen.getByRole("status").textContent).toBe("No providers match this search.");
    fireEvent.keyDown(picker, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect((picker as HTMLInputElement).value).toBe("NVIDIA NIM");
  });

  it("uses the branded provider catalog and does not save credentials at discovery", async () => {
    mount("add-provider");
    await chooseProvider("DeepSeek");
    expect((screen.getByLabelText("Base URL") as HTMLInputElement).value).toBe("https://api.deepseek.com/v1");
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "test-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Discover models" }));
    await screen.findByRole("heading", { name: "Discovered models" });
    expect(discoverProviderDraft).toHaveBeenCalledWith({ name: "DeepSeek", kind: "deepseek", baseUrl: "https://api.deepseek.com/v1", apiKey: "test-key" });
    expect(registerProviderModels).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Chat chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Register 1 model" }));
    await screen.findByText("Registration complete");
    expect(registerProviderModels).toHaveBeenCalledWith({ connection: { name: "DeepSeek", kind: "deepseek", baseUrl: "https://api.deepseek.com/v1", apiKey: "test-key" }, models: [expect.objectContaining({ model: "chat", profile: "generic-chat" })] });
  });

  it("registers a pinned Jev version without requiring discovery", async () => {
    mount("add-provider");
    await chooseProvider("TypeSafe AI");
    expect((screen.getByLabelText("Base URL") as HTMLInputElement).value).toBe("https://api.typesafe.ai/v1");
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "test-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Choose models" }));
    expect(screen.getByRole("heading", { name: "Model versions" })).toBeTruthy();
    expect(discoverProviderDraft).not.toHaveBeenCalled();
    expect(registerProviderModels).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Register 1 model" }));
    await screen.findByText("Registration complete");
    expect(registerProviderModels).toHaveBeenCalledWith({
      connection: { name: "TypeSafe AI", kind: "typesafe", baseUrl: "https://api.typesafe.ai/v1", apiKey: "test-key" },
      models: [expect.objectContaining({ model: "jev-1.13.0", profile: "tali.typesafe-jev.v1" })],
    });
  });

  it("preserves pinned and manual Jev versions when refreshing an alias-only catalog", async () => {
    mount("add-provider");
    await chooseProvider("TypeSafe AI");
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "test-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Choose models" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Manual model ID" }), { target: { value: "jev-custom" } });
    fireEvent.click(screen.getByRole("button", { name: "Add", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Fetch catalog (optional)" }));
    await screen.findByRole("button", { name: "Chat chat" });
    const selected = screen.getByRole("region", { name: "Selected models" });
    expect(within(selected).getByText("jev-1.13.0")).toBeTruthy();
    expect(within(selected).getByText("jev-custom")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Chat chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Register 3 models" }));
    await screen.findByText("Registration complete");
    expect(vi.mocked(registerProviderModels).mock.calls[0]?.[0].models).toEqual([
      expect.objectContaining({ model: "jev-1.13.0", profile: "tali.typesafe-jev.v1" }),
      expect.objectContaining({ model: "jev-custom", profile: "tali.typesafe-jev.v1" }),
      expect.objectContaining({ model: "chat", profile: "tali.typesafe-jev.v1" }),
    ]);
  });

  it("allows registration after optional TypeSafe discovery fails and preserves choices on Back", async () => {
    vi.mocked(discoverProviderDraft).mockRejectedValueOnce(new Error("Catalog unavailable"));
    mount("add-provider");
    await chooseProvider("TypeSafe AI");
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "test-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Choose models" }));
    fireEvent.click(screen.getByRole("button", { name: "Deselect jev-1.13.0" }));
    fireEvent.click(screen.getByRole("button", { name: "Jev latest jev-latest" }));
    fireEvent.click(screen.getByRole("button", { name: "Fetch catalog (optional)" }));
    await screen.findByText("Catalog unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose models" }));
    fireEvent.click(screen.getByRole("button", { name: "Register 1 model" }));
    await screen.findByText("Registration complete");
    expect(registerProviderModels).toHaveBeenCalledWith(expect.objectContaining({
      models: [expect.objectContaining({ model: "jev-latest", profile: "tali.typesafe-jev.v1" })],
    }));
  });

  it("does not preselect an already registered Jev version on a saved Provider", async () => {
    const typesafe: ModelProvider = { ...provider, kind: "typesafe", name: "Saved TypeSafe" };
    mount("register-models", [{ ...ready, model: "jev-1.13.0" }], [typesafe]);
    fireEvent.click(screen.getByRole("button", { name: "Choose models" }));
    expect((screen.getByRole("button", { name: "Jev 1.13.0 jev-1.13.0 Registered" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Register 0 models" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Jev latest jev-latest" }));
    fireEvent.click(screen.getByRole("button", { name: "Register 1 model" }));
    await screen.findByText("Registration complete");
    expect(discoverModelProvider).not.toHaveBeenCalled();
    expect(createModelDefinition).toHaveBeenCalledWith(expect.objectContaining({ model: "jev-latest", profile: "tali.typesafe-jev.v1" }));
  });

  it("retains a registered model whose call failed and retries it without registering twice", async () => {
    vi.mocked(createModelDefinition).mockResolvedValue({ ...ready, connectionStatus: "failed", connectionMessage: "Model not found: HTTP 404" });
    vi.mocked(testModelConnection).mockResolvedValue(ready);
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Discover models" }));
    await screen.findByRole("heading", { name: "Discovered models" });
    fireEvent.click(screen.getByRole("button", { name: "Chat chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Register 1 model" }));
    expect(await screen.findByText("Call failed")).toBeTruthy();
    expect(screen.queryByText("Model not found: HTTP 404")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View call error · Chat" }));
    expect(await screen.findByRole("dialog", { name: "Model call error" })).toBeTruthy();
    expect(screen.getByText("Model not found: HTTP 404")).toBeTruthy();
    fireEvent.click(within(screen.getByRole("dialog", { name: "Model call error" })).getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Test call Chat" }));
    expect(await screen.findByText("Callable")).toBeTruthy();
    expect(testModelConnection).toHaveBeenCalledWith("model-1", expect.anything());
    expect(createModelDefinition).toHaveBeenCalledOnce();
    expect(revalidateModelDefinition).not.toHaveBeenCalled();
  });

  it("makes HTTPS verification opt-out explicit and carries it through discovery and registration", async () => {
    mount("add-provider");
    await chooseProvider("DeepSeek");
    const toggle = screen.getByRole("switch", { name: "Skip TLS certificate verification" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(/Certificate-chain and hostname verification will be disabled/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "test-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Discover models" }));
    await screen.findByRole("heading", { name: "Discovered models" });
    expect(discoverProviderDraft).toHaveBeenCalledWith(expect.objectContaining({ skipTlsVerify: true }));
    fireEvent.click(screen.getByRole("button", { name: "Chat chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Register 1 model" }));
    await screen.findByText("Registration complete");
    expect(registerProviderModels).toHaveBeenCalledWith(expect.objectContaining({ connection: expect.objectContaining({ skipTlsVerify: true }) }));
  });

  it("clears TLS bypass when the endpoint becomes HTTP", async () => {
    mount("add-provider");
    await chooseProvider("DeepSeek");
    fireEvent.click(screen.getByRole("switch", { name: "Skip TLS certificate verification" }));
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "http://internal.test/v1" } });
    expect(screen.queryByRole("switch", { name: "Skip TLS certificate verification" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://internal.test/v1" } });
    expect(screen.getByRole("switch", { name: "Skip TLS certificate verification" }).getAttribute("aria-checked")).toBe("false");
  });

  it("searches Provider presets and clears another Provider's credentials on change", async () => {
    mount("add-provider");
    await chooseProvider("DeepSeek");
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "do-not-reuse" } });
    fireEvent.click(screen.getByRole("combobox", { name: "Select Provider" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Select Provider" }), { target: { value: "NVIDIA" } });
    expect(screen.queryByRole("option", { name: /OpenAI models/ })).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: /NVIDIA NIM/ }));
    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Base URL") as HTMLInputElement).value).toBe("https://integrate.api.nvidia.com/v1");
  });

  it("preserves a discovery failure and offers explicit manual model registration", async () => {
    vi.mocked(discoverModelProvider).mockRejectedValue(new Error("Catalog endpoint returned HTTP 404."));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Discover models" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Catalog endpoint returned HTTP 404.");
    fireEvent.click(screen.getByRole("button", { name: "Enter model IDs manually" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Manual model ID" }), { target: { value: "nvidia/llama-3.1-nemoguard-8b-topic-control" } });
    fireEvent.click(screen.getByRole("button", { name: "Add", exact: true }));
    expect(screen.getByText("Catalog endpoint returned HTTP 404.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Register 1 model" }));
    await waitFor(() => expect(createModelDefinition).toHaveBeenCalledWith(expect.objectContaining({ model: "nvidia/llama-3.1-nemoguard-8b-topic-control", profile: "tali.nemoguard-topic-control.v1" })));
  });

  it("keeps partial failures visible and retries without duplicating successful models", async () => {
    vi.mocked(createModelDefinition).mockImplementationOnce(async () => ready).mockRejectedValueOnce(new Error("Registration unavailable"));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Discover models" }));
    fireEvent.click(await screen.findByRole("button", { name: /Qwen Guard Qwen\/Qwen3Guard/ }));
    fireEvent.click(screen.getByRole("button", { name: "Chat chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Register 2 models" }));
    expect(await screen.findByText("Registration unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry failed models" }));
    await waitFor(() => expect(screen.queryByText("Registration unavailable")).toBeNull());
    expect(revalidateModelDefinition).not.toHaveBeenCalled();
    expect(createModelDefinition).toHaveBeenCalledTimes(3);
    expect(vi.mocked(createModelDefinition).mock.calls[2]![0].model).toBe("chat");
  });

  it("does not allow already registered models to be selected again", async () => {
    mount("register-models", [ready]);
    fireEvent.click(screen.getByRole("button", { name: "Discover models" }));
    const row = await screen.findByRole("button", { name: "Chat chat Registered" });
    expect(row.hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: /Qwen Guard Qwen\/Qwen3Guard/ }).getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps a failed new registration on the review step with the entered configuration", async () => {
    vi.mocked(registerProviderModels).mockRejectedValue(new Error("Registration could not be saved"));
    mount("add-provider");
    await chooseProvider("DeepSeek");
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "test-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Discover models" }));
    fireEvent.click(await screen.findByRole("button", { name: "Chat chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Register 1 model" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Registration could not be saved");
    expect(screen.getByRole("heading", { name: "Discovered models" })).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe("test-key");
  });

  it("deselects explicitly and explains why an empty selection cannot register", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Discover models" }));
    fireEvent.click(await screen.findByRole("button", { name: "Chat chat" }));
    expect(screen.getByRole("button", { name: "Register 1 model" }).hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Deselect chat" }));
    expect(screen.getByRole("button", { name: "Register 0 models" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getAllByText("Select at least one model to continue.").length).toBeGreaterThan(0);
  });

  it("prevents closing or changing source while discovery is pending", async () => {
    let finish!: (value: Awaited<ReturnType<typeof discoverModelProvider>>) => void;
    vi.mocked(discoverModelProvider).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Discover models" }));
    await screen.findByRole("status");
    expect(screen.getByRole("button", { name: "Close" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("combobox", { name: "Saved credentials" }).hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onOpenChange).not.toHaveBeenCalled();
    await act(async () => finish({ providerId: provider.id, providerName: provider.name, models: [] }));
    await screen.findAllByText("Select at least one model to continue.");
  });

  it.each([
    ["example/jailbreak-judge", "generic-chat"],
    ["nvidia/nemoguard-jailbreak-detect", "tali.nemoguard-jailbreak-detect.v1"],
  ])("registers %s manually and infers its protocol without assigning a capability", async (id, profile) => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Discover models" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Manual model ID" }), { target: { value: id } });
    fireEvent.click(screen.getByRole("button", { name: "Add", exact: true }));
    const selected = screen.getByRole("region", { name: "Selected models" });
    expect(within(selected).getByText(id)).toBeTruthy();
    expect(within(selected).getByText("Manual")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Register 1 model" }));
    await waitFor(() => expect(createModelDefinition).toHaveBeenCalledWith(expect.objectContaining({ model: id, profile })));
  });
});
