import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Guardrail } from "@/lib/api";
import { GuardrailRowActions } from "./guardrail-row-actions";
import { downloadGuardrailArtifact } from "@/lib/guardrail-export";
import { toast } from "./ui/notifications";

const auth = vi.hoisted(() => ({ user: { role: "admin" } }));
vi.mock("@/lib/auth", () => ({ useAuth: () => auth }));
vi.mock("@/lib/guardrail-export", () => ({ downloadGuardrailArtifact: vi.fn() }));
vi.mock("./ui/notifications", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); auth.user.role = "admin"; });

function show(version: string | null = "20261007-010000.000Z") {
  const guardrail = { id: "guard-1", name: "Support", active_version: version, published_current: false } as Guardrail;
  const navigate = vi.fn();
  render(<QueryClientProvider client={new QueryClient()}><div onClick={navigate}><div onClick={event => event.stopPropagation()}><GuardrailRowActions guardrail={guardrail} /></div></div></QueryClientProvider>);
  fireEvent.click(screen.getByRole("button", { name: "routing.actions: Support" }));
  return navigate;
}

describe("Guardrail export action", () => {
  it("exports the published version even when the draft has changes, without opening the row", async () => {
    vi.mocked(downloadGuardrailArtifact).mockResolvedValue();
    const navigate = show();
    fireEvent.click(screen.getByRole("menuitem", { name: "guardrails.export" }));
    await waitFor(() => expect(downloadGuardrailArtifact).toHaveBeenCalledWith("guard-1", "20261007-010000.000Z"));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(navigate).not.toHaveBeenCalled();
  });

  it("disables export and explains why before first publication", () => {
    show(null);
    const item = screen.getByRole("menuitem", { name: "guardrails.export" });
    expect(item.getAttribute("disabled")).not.toBeNull();
    expect(screen.getByText("guardrails.exportRequiresPublish")).toBeTruthy();
    fireEvent.click(item);
    expect(downloadGuardrailArtifact).not.toHaveBeenCalled();
  });

  it("keeps export available to readers without exposing write actions", () => {
    auth.user.role = "viewer";
    show();
    expect(screen.getByRole("menuitem", { name: "guardrails.export" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "routing.delete" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "routing.duplicate" })).toBeNull();
  });

  it("shows a recoverable download error and permits retry", async () => {
    vi.mocked(downloadGuardrailArtifact).mockRejectedValueOnce(new Error("Artifact unavailable"));
    show();
    fireEvent.click(screen.getByRole("menuitem", { name: "guardrails.export" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("guardrails.exportFailed: Artifact unavailable"));
    const trigger = screen.getByRole("button", { name: "routing.actions: Support" });
    expect(trigger.hasAttribute("disabled")).toBe(false);
    vi.mocked(downloadGuardrailArtifact).mockResolvedValue();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "guardrails.export" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it("prevents repeated downloads while the request is pending", async () => {
    let finish!: () => void;
    vi.mocked(downloadGuardrailArtifact).mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
    show();
    fireEvent.click(screen.getByRole("menuitem", { name: "guardrails.export" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "routing.actions: Support" }).hasAttribute("disabled")).toBe(true));
    expect(downloadGuardrailArtifact).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    await waitFor(() => expect(screen.getByRole("button", { name: "routing.actions: Support" }).hasAttribute("disabled")).toBe(false));
  });
});
