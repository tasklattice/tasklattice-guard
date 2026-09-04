import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { updateProviderTls, type ModelProvider } from "@/lib/controller-api";
import { ProviderTlsSettings } from "./provider-tls-settings";

vi.mock("@/lib/controller-api", () => ({ updateProviderTls: vi.fn() }));
const provider: ModelProvider = { id: "internal", name: "Internal Provider", kind: "openai", baseUrl: "https://internal.test/v1", skipTlsVerify: false, status: "failed", credentialConfigured: true, credentialHint: "Stored", validationMessage: "TLS error", validatedAt: null, validationLatencyMs: null };
let client: QueryClient;
const onChanged = vi.fn(async () => {});
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  await i18n.changeLanguage("en");
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
});
afterEach(() => { cleanup(); client.clear(); vi.unstubAllGlobals(); });
function mount(value = provider, disabled = false) {
  return render(<QueryClientProvider client={client}><ProviderTlsSettings provider={value} disabled={disabled} onChanged={onChanged} /></QueryClientProvider>);
}
it("updates only the TLS choice on a saved Provider and refreshes displayed state", async () => {
  vi.mocked(updateProviderTls).mockResolvedValue({ ...provider, skipTlsVerify: true, status: "validated", validationMessage: "Connected" });
  mount();
  fireEvent.click(screen.getByRole("button", { name: "TLS settings Internal Provider" }));
  fireEvent.click(screen.getByRole("switch", { name: "Skip TLS certificate verification" }));
  fireEvent.click(screen.getByRole("button", { name: "Save & test connection" }));
  await waitFor(() => expect(updateProviderTls).toHaveBeenCalledWith("internal", true));
  expect(await screen.findByText("TLS setting saved. Connected")).toBeTruthy();
  expect(onChanged).toHaveBeenCalledOnce();
});
it("displays an unsuccessful save without claiming it was persisted", async () => {
  vi.mocked(updateProviderTls).mockRejectedValue(new Error("Unable to save"));
  mount();
  fireEvent.click(screen.getByRole("button", { name: "TLS settings Internal Provider" }));
  fireEvent.click(screen.getByRole("switch"));
  fireEvent.click(screen.getByRole("button", { name: "Save & test connection" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Unable to save");
  expect(onChanged).not.toHaveBeenCalled();
});
it("does not offer TLS bypass for plain HTTP or allow non-admin edits", () => {
  const view = mount({ ...provider, baseUrl: "http://internal.test/v1" });
  expect(screen.queryByRole("button")).toBeNull();
  view.unmount();
  mount(provider, true);
  expect(screen.getByRole("button", { name: "TLS settings Internal Provider" })).toHaveProperty("disabled", true);
});
