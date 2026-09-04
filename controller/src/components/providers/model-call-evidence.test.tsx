import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import i18n from "@/i18n";
import type { ModelDefinition } from "@/lib/controller-api";
import { ModelCallEvidence } from "./model-call-evidence";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const error = `Model call returned HTTP 500: ${"long-upstream-error-".repeat(100)}`;
const model: ModelDefinition = {
  id: "topic", name: "Topic Control", model: "nvidia/topic", providerId: "nvidia", providerName: "NVIDIA", providerKind: "custom-openai-compatible",
  profile: "tali.nemoguard-topic-control.v1", timeoutSeconds: 20, maxTokens: 512,
  status: "pending", validationMessage: "Not checked", validatedAt: null, validationLatencyMs: null,
  connectionStatus: "failed", connectionMessage: error, connectionCheckedAt: "2026-09-03T13:53:00Z", connectionLatencyMs: 753,
};
const writeText = vi.fn();
const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");

describe("model call error disclosure", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    writeText.mockResolvedValue(undefined);
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
    else Reflect.deleteProperty(navigator, "clipboard");
  });

  it("keeps long errors outside the table and opens full details in a dismissible inspector", async () => {
    const { container } = render(<table><tbody><tr><td><ModelCallEvidence model={model} /></td></tr></tbody></table>);
    expect(screen.queryByText(error)).toBeNull();
    const trigger = screen.getByRole("button", { name: "View call error · Topic Control" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Model call error" });
    expect(within(dialog).getByText(error)).toBeTruthy();
    expect(container.querySelector("table")?.textContent).not.toContain(error);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("shows a bounded error preview on keyboard focus without opening a dialog", async () => {
    render(<ModelCallEvidence model={model} />);
    fireEvent.focus(screen.getByRole("button", { name: "View call error · Topic Control" }));
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain(`${error.slice(0, 240)}…`);
    expect(tooltip.textContent).not.toContain(error);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("copies the entire error and reports clipboard failure without losing the details", async () => {
    render(<ModelCallEvidence model={model} />);
    fireEvent.click(screen.getByRole("button", { name: "View call error · Topic Control" }));
    const copy = await screen.findByRole("button", { name: "Copy error details" });
    fireEvent.click(copy);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(error));
    expect(toast.success).toHaveBeenCalledWith("Error details copied");
    writeText.mockRejectedValue(new Error("denied"));
    fireEvent.click(copy);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not copy. Select and copy the error text manually."));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("does not show stale errors during a retry, after success, or before a call", () => {
    const { rerender } = render(<ModelCallEvidence model={model} checking />);
    expect(screen.getByText("Testing call…")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    for (const connectionStatus of ["validated", "pending"] as const) {
      rerender(<ModelCallEvidence model={{ ...model, connectionStatus }} />);
      expect(screen.queryByRole("button")).toBeNull();
      expect(screen.queryByText(error)).toBeNull();
    }
  });

  it("explains failed calls without an upstream error message", async () => {
    render(<ModelCallEvidence model={{ ...model, connectionMessage: "" }} />);
    fireEvent.click(screen.getByRole("button", { name: "View call error · Topic Control" }));
    expect(await screen.findByText("No error details were returned. Test the model call again to refresh the result.")).toBeTruthy();
  });
});
