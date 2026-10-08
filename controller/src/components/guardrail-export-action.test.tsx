import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Guardrail } from "@/lib/api";
import { getControllerGuardrail } from "@/lib/controller-api";
import { GuardrailRowActions } from "./guardrail-row-actions";
import { downloadGuardrailArtifact } from "@/lib/guardrail-export";
import { toast } from "./ui/notifications";

const auth = vi.hoisted(() => ({ user: { role: "admin" } }));
vi.mock("@/lib/auth", () => ({ useAuth: () => auth }));
vi.mock("@/lib/guardrail-export", () => ({ downloadGuardrailArtifact: vi.fn() }));
vi.mock("@/lib/controller-api", async original => ({ ...(await original<typeof import("@/lib/controller-api")>()), getControllerGuardrail: vi.fn() }));
vi.mock("./ui/notifications", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); auth.user.role = "admin"; });

const LATEST = "20261007-010000.000Z", OLDER = "20261001-010000.000Z";
const version = (id: string, status = "ready") => ({ version: id, status, artifactId: status === "ready" ? `artifact-${id}` : null, createdAt: "2026-10-07T01:00:00.000Z" });
beforeEach(() => {
  vi.mocked(getControllerGuardrail).mockResolvedValue({ id: "guard-1", latestVersion: LATEST,
    versions: [version("20261008-010000.000Z", "compiling"), version(LATEST), version(OLDER)] } as never);
});

function open(latest: string | null = LATEST) {
  const guardrail = { id: "guard-1", name: "Support", latest_version: latest, published_current: false } as Guardrail;
  const navigate = vi.fn();
  render(<QueryClientProvider client={new QueryClient()}><div onClick={navigate}><div onClick={event => event.stopPropagation()}><GuardrailRowActions guardrail={guardrail} /></div></div></QueryClientProvider>);
  fireEvent.click(screen.getByRole("button", { name: "routing.actions: Support" }));
  return navigate;
}
async function sheet() {
  fireEvent.click(screen.getByRole("menuitem", { name: "guardrails.exportEllipsis" }));
  const dialog = await screen.findByRole("dialog", { name: "guardrails.exportTitle" });
  await within(dialog).findByText(LATEST);
  return dialog;
}

describe("Guardrail export action", () => {
  it("opens a version choice instead of downloading, defaulting to the Latest version", async () => {
    vi.mocked(downloadGuardrailArtifact).mockResolvedValue();
    const navigate = open();
    const dialog = await sheet();
    expect(downloadGuardrailArtifact).not.toHaveBeenCalled();
    expect(within(dialog).queryByText("20261008-010000.000Z")).toBeNull();
    const radios = within(dialog).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map(radio => [radio.value, radio.checked])).toEqual([[LATEST, true], [OLDER, false]]);
    fireEvent.click(within(dialog).getByRole("button", { name: "guardrails.downloadArtifact" }));
    await waitFor(() => expect(downloadGuardrailArtifact).toHaveBeenCalledExactlyOnceWith("guard-1", LATEST));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(navigate).not.toHaveBeenCalled();
  });

  it("exports the chosen historical version", async () => {
    vi.mocked(downloadGuardrailArtifact).mockResolvedValue();
    open();
    const dialog = await sheet();
    fireEvent.click(within(dialog).getAllByRole("radio")[1]!);
    expect(within(dialog).getByText(`guard-1-${OLDER}.artifact.json`)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "guardrails.downloadArtifact" }));
    await waitFor(() => expect(downloadGuardrailArtifact).toHaveBeenCalledExactlyOnceWith("guard-1", OLDER));
  });

  it("keeps the sheet open with the error so the export can be retried", async () => {
    vi.mocked(downloadGuardrailArtifact).mockRejectedValueOnce(new Error("Artifact unavailable"));
    open();
    const dialog = await sheet();
    fireEvent.click(within(dialog).getByRole("button", { name: "guardrails.downloadArtifact" }));
    expect(await within(dialog).findByText("Artifact unavailable")).toBeTruthy();
    vi.mocked(downloadGuardrailArtifact).mockResolvedValue();
    fireEvent.click(within(dialog).getByRole("button", { name: "guardrails.downloadArtifact" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it("disables export before first publication", () => {
    open(null);
    const item = screen.getByRole("menuitem", { name: "guardrails.exportEllipsis" });
    expect(item.getAttribute("disabled")).not.toBeNull();
  });

  it("keeps export available to readers without exposing write actions", () => {
    auth.user.role = "viewer";
    open();
    expect(screen.getByRole("menuitem", { name: "guardrails.exportEllipsis" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "routing.delete" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "routing.duplicate" })).toBeNull();
  });
});
