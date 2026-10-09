import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importGuardrailPackage, uploadGuardrailPackage, type PackagePreview } from "@/lib/controller-api";
import { ImportGuardrailSheet } from "./guardrail-import-sheet";
import { toast } from "./ui/notifications";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("@/lib/controller-api", async original => ({ ...(await original<typeof import("@/lib/controller-api")>()), uploadGuardrailPackage: vi.fn(), importGuardrailPackage: vi.fn() }));
vi.mock("./ui/notifications", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => values ? `${key}:${JSON.stringify(values)}` : key, i18n: { language: "en", exists: () => false } }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const V1 = "20261001-010000.000Z", V2 = "20261007-010000.000Z";
const evidence = { status: "passed" as const, testedAt: "2026-10-07T01:00:00.000Z", completedAt: null, publishedAt: "2026-10-07T01:05:00.000Z", metrics: { total: 12, passed: 12 }, source: { id: "bank-uat", name: "Bank UAT" }, validationRunId: "run" };
const requirements = { contentContract: "tasklattice.artifact-content.v2", runtime: { nemoVersion: "0.24.0", runtimeProfile: "llmrails_colang1_standard", compilerVersion: "c", planCompilerVersion: "p" }, actions: [], models: [], evaluationContracts: [] };
const preview = (overrides: Partial<PackagePreview> = {}): PackagePreview => ({
  packageId: "a".repeat(64), source: { id: "bank-uat", name: "Bank UAT" }, keyId: "uat-2026", exportedAt: "2026-10-08T00:00:00.000Z",
  guardrail: { id: "bank-assistant", name: "Bank assistant", exists: true }, blockers: [],
  versions: [
    { version: V1, state: "existing", contentDigest: "1".repeat(64), evidence, requirements, environment: null },
    { version: V2, state: "new", contentDigest: "2".repeat(64), evidence, requirements, environment: { status: "missing", checkedAt: "2026-10-08T00:00:00.000Z",
      pools: [{ poolId: "default", runnerId: "runner-0", admitted: false, unavailable: false, reason: "NeMo Action providers are unavailable for: GuardTopicJudgeAction@1.0.0.", nemoVersion: "0.24.0", modelRevisionId: "" }] } },
  ],
  ...overrides,
});

function mount() {
  const onClose = vi.fn();
  render(<QueryClientProvider client={new QueryClient()}><ImportGuardrailSheet onClose={onClose} /></QueryClientProvider>);
  const dialog = screen.getByRole("dialog", { name: "guardrailPackage.importTitle" });
  const choose = (name = "bank-assistant.guardrail.zip") => fireEvent.change(within(dialog).getByLabelText("guardrailPackage.chooseFile"), { target: { files: [new File(["zip"], name, { type: "application/zip" })] } });
  return { dialog, choose, onClose };
}

describe("Guardrail package import", () => {
  it("previews source, evidence and environment, then imports only what is new", async () => {
    vi.mocked(uploadGuardrailPackage).mockResolvedValue(preview());
    vi.mocked(importGuardrailPackage).mockResolvedValue({ guardrailId: "bank-assistant", imported: [V2], existing: [V1] });
    const { dialog, choose, onClose } = mount();
    expect(within(dialog).getByText("guardrailPackage.noProductionTesting")).toBeTruthy();
    choose();
    expect(await within(dialog).findByText(V2)).toBeTruthy();
    expect(within(dialog).getByText(/GuardTopicJudgeAction/)).toBeTruthy();
    expect(within(dialog).getByText("guardrailPackage.stateExisting")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "guardrailPackage.importOne" }));
    await waitFor(() => expect(importGuardrailPackage).toHaveBeenCalledExactlyOnceWith("a".repeat(64)));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith(`guardrailPackage.imported:${JSON.stringify({ imported: 1, existing: 1 })}`);
    expect(navigate).toHaveBeenCalledWith({ to: "/guardrails/$guardrailId", params: { guardrailId: "bank-assistant" }, search: { tab: "immutable" } });
  });

  it("shows why a package cannot be imported and offers no import", async () => {
    vi.mocked(uploadGuardrailPackage).mockResolvedValue(preview({ blockers: [{ code: "guardrail_ownership_conflict", message: "Guardrail bank-assistant belongs to source bank-uat." }] }));
    const { dialog, choose } = mount();
    choose();
    expect(await within(dialog).findByText("Guardrail bank-assistant belongs to source bank-uat.")).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: "guardrailPackage.importOne" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("reports an already imported package as nothing to import", async () => {
    vi.mocked(uploadGuardrailPackage).mockResolvedValue(preview({ versions: preview().versions.map(item => ({ ...item, state: "existing" as const })) }));
    const { dialog, choose } = mount();
    choose();
    await within(dialog).findByText(V2);
    expect((within(dialog).getByRole("button", { name: "guardrailPackage.nothingToImport" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps a rejected upload visible so another file can be chosen", async () => {
    vi.mocked(uploadGuardrailPackage).mockRejectedValueOnce(new Error("No signature on this package verifies with a trusted key."));
    const { dialog, choose } = mount();
    choose("tampered.guardrail.zip");
    expect(await within(dialog).findByText("No signature on this package verifies with a trusted key.")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "guardrailPackage.chooseAnother" })).toBeTruthy();
    expect(importGuardrailPackage).not.toHaveBeenCalled();
  });
});
