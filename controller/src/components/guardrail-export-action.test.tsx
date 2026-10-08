import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Guardrail } from "@/lib/api";
import { downloadGuardrailPackage, getControllerGuardrail, getDeploymentCapabilities } from "@/lib/controller-api";
import { GuardrailRowActions } from "./guardrail-row-actions";
import { toast } from "./ui/notifications";

const auth = vi.hoisted(() => ({ user: { role: "admin" } }));
vi.mock("@/lib/auth", () => ({ useAuth: () => auth }));
vi.mock("@/lib/controller-api", async original => ({ ...(await original<typeof import("@/lib/controller-api")>()),
  getControllerGuardrail: vi.fn(), downloadGuardrailPackage: vi.fn(), getDeploymentCapabilities: vi.fn() }));
vi.mock("./ui/notifications", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => values && "selected" in values ? `${key}:${values.selected}/${values.total}` : key, i18n: { language: "en" } }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); auth.user.role = "admin"; });

const LATEST = "20261007-010000.000Z", OLDER = "20261001-010000.000Z", LEGACY = "20260901-010000.000Z";
const version = (id: string, extra: Record<string, unknown> = {}) => ({ version: id, status: "ready", artifactId: `artifact-${id}`, validationRunId: `run-${id}`, createdAt: "2026-10-07T01:00:00.000Z", ...extra });
beforeEach(() => {
  vi.mocked(getDeploymentCapabilities).mockResolvedValue({ authoringEnabled: true, packageExport: { available: true, sourceId: "bank-uat" }, packageImport: { available: false } });
  vi.mocked(getControllerGuardrail).mockResolvedValue({ id: "guard-1", latestVersion: LATEST,
    versions: [version("20261008-010000.000Z", { status: "failed", artifactId: null }), version(LATEST), version(OLDER), version(LEGACY, { validationRunId: null })] } as never);
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
  const dialog = await screen.findByRole("dialog", { name: "guardrailPackage.exportTitle" });
  await within(dialog).findByText(LATEST);
  return dialog;
}
const checked = (dialog: HTMLElement) => within(dialog).getAllByRole("checkbox").filter(box => (box as HTMLInputElement).checked).map(box => box.getAttribute("aria-label"));

describe("Guardrail release package export", () => {
  it("opens a version choice defaulting to Latest and downloads one signed package", async () => {
    vi.mocked(downloadGuardrailPackage).mockResolvedValue("guard-1.guardrail.zip");
    const navigate = open();
    const dialog = await sheet();
    expect(downloadGuardrailPackage).not.toHaveBeenCalled();
    expect(within(dialog).queryByText("20261008-010000.000Z")).toBeNull();
    expect(checked(dialog)).toEqual([LATEST]);
    expect(within(dialog).getByText("guardrailPackage.selectedCount:1/2")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "guardrailPackage.exportDownload" }));
    await waitFor(() => expect(downloadGuardrailPackage).toHaveBeenCalledExactlyOnceWith("guard-1", [LATEST]));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(navigate).not.toHaveBeenCalled();
  });

  it("includes several versions in one package, for a first migration or a rollback target", async () => {
    vi.mocked(downloadGuardrailPackage).mockResolvedValue("guard-1-2-versions.guardrail.zip");
    open();
    const dialog = await sheet();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: OLDER }));
    expect(within(dialog).getByText("guardrailPackage.selectedCount:2/2")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "guardrailPackage.exportDownload" }));
    await waitFor(() => expect(downloadGuardrailPackage).toHaveBeenCalledExactlyOnceWith("guard-1", [OLDER, LATEST]));
  });

  it("explains why a version cannot travel instead of exporting an incomplete release", async () => {
    open();
    const dialog = await sheet();
    expect((within(dialog).getByRole("checkbox", { name: LEGACY }) as HTMLInputElement).disabled).toBe(true);
    expect(within(dialog).getByText("guardrailPackage.exportNoTest")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: LATEST }));
    expect((within(dialog).getByRole("button", { name: "guardrailPackage.exportDownload" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps the sheet open with the error so the export can be retried", async () => {
    vi.mocked(downloadGuardrailPackage).mockRejectedValueOnce(new Error("Version lacks test evidence"));
    open();
    const dialog = await sheet();
    fireEvent.click(within(dialog).getByRole("button", { name: "guardrailPackage.exportDownload" }));
    expect(await within(dialog).findByText("Version lacks test evidence")).toBeTruthy();
    vi.mocked(downloadGuardrailPackage).mockResolvedValue("guard-1.guardrail.zip");
    fireEvent.click(within(dialog).getByRole("button", { name: "guardrailPackage.exportDownload" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it("says so when this environment cannot sign packages", async () => {
    vi.mocked(getDeploymentCapabilities).mockResolvedValue({ authoringEnabled: true, packageExport: { available: false, sourceId: null }, packageImport: { available: false } });
    open();
    const dialog = await sheet();
    expect(await within(dialog).findByText("guardrailPackage.exportUnavailable")).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: "guardrailPackage.exportDownload" }) as HTMLButtonElement).disabled).toBe(true);
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
