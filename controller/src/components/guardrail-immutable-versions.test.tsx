import { useState, type ComponentProps } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImmutableVersionView } from "./guardrail-immutable-versions";
import type { GuardrailVersionDetail, ValidationRun } from "@/lib/api";
import { getControllerGuardrail, getGuardrailVersionDeletionImpact } from "@/lib/controller-api";

const auth = vi.hoisted(() => ({ user: { role: "admin" } }));
vi.mock("@/lib/auth", () => ({ useAuth: () => auth }));
vi.mock("react-i18next", () => ({ initReactI18next: { type: "3rdParty", init: () => undefined }, useTranslation: () => ({
  t: (key: string, values?: Record<string, unknown>) => Object.entries(values ?? {}).reduce((text, [key, value]) => `${text} ${key}:${value}`, key),
  i18n: { language: "en", exists: () => true },
}) }));
vi.mock("@/lib/controller-api", async original => ({ ...(await original<typeof import("@/lib/controller-api")>()), getControllerGuardrail: vi.fn(), getGuardrailVersionDeletionImpact: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));

function version(day: number): GuardrailVersionDetail {
  return {
    guardrail_id: "g1", version: `2026100${day}-010000.000Z`, created_at: `2026-10-0${day}T01:00:00Z`, latest: day === 3,
    source_draft_version: day, compiler_version: "compiler-v1", plan_checksum: "checksum", config_checksum: "checksum", execution_mode: "nemo_only", runtime_engine: "llmrails", compile_status: "ready",
    policy_count: 12, safety_level: "balanced", output_delivery: "full_buffered", runtime_profile: "auto", colang_version: "auto", rails: [], actions: [], models: [], features: [], dependencies: [], estimated_critical_path_ms: 30000,
    policy_bindings: Array.from({ length: 12 }, (_, index) => ({ policy_id: `policy-${day}-${index}`, policy_version: "1.0.0", action: null, enabled_rule_ids: ["rule"], enabled_rails: ["input"] })),
    artifacts: [{ path: "config.yml", language: "yaml", content: `version: ${day}` }],
  };
}
const versions = [version(1), version(3), version(2)];
type Props = ComponentProps<typeof ImmutableVersionView>;
function Harness(overrides: Partial<Props>) {
  const [selected, setSelected] = useState(versions[1]);
  return <ImmutableVersionView selectedVersion={selected} detail={selected} versions={versions} loading={false} comparisonActive={false} comparisonLoading={false} compareOptions={versions.filter(v => v.version !== selected.version)} guardrailId="g1" guardrailName="Example" validation={null} onChanged={async () => undefined} onOpenDraft={vi.fn()} onOpenValidation={vi.fn()} onSelectVersion={id => setSelected(versions.find(v => v.version === id)!)} onStartCompare={vi.fn()} onCompareBaseChange={vi.fn()} onCloseCompare={vi.fn()} {...overrides} />;
}
function mount(props: Partial<Props> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><Harness {...props} /></QueryClientProvider>);
}
function open(day = 3) {
  fireEvent.click(screen.getByRole("button", { name: `immutableVersions.view version:${version(day).version}` }));
  return screen.getByRole("dialog");
}
beforeEach(() => {
  vi.mocked(getControllerGuardrail).mockResolvedValue({ id: "g1", versions: versions.map(v => ({ version: v.version, createdAt: v.created_at, status: "ready", artifactId: v.version, validationRunId: `run-${v.version}` })) } as never);
  vi.mocked(getGuardrailVersionDeletionImpact).mockResolvedValue({ deletable: false, blockers: [{ code: "latest", until: null }], references: [], unrestorableRevisions: [] } as never);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); auth.user.role = "admin"; });

describe("Immutable version list and detail drawer", () => {
  it("opens the requested version when navigating from a Testing report", () => {
    const handled = vi.fn();
    mount({ selectedVersion: version(2), detail: version(2), openRequested: true, onOpenRequestHandled: handled });
    expect(screen.getByRole("dialog").textContent).toContain(version(2).version);
    expect(handled).toHaveBeenCalledOnce();
  });

  it("distinguishes an empty list from a failed request", () => {
    const view = mount({ versions: [], selectedVersion: undefined, detail: undefined });
    expect(screen.getByText("guardrails.noPublishedVersion")).toBeTruthy();
    view.unmount();
    const retry = vi.fn();
    mount({ versions: [], selectedVersion: undefined, error: new Error("Cannot load versions"), onRetry: retry });
    expect(screen.queryByText("guardrails.noPublishedVersion")).toBeNull();
    expect(screen.getByText("Cannot load versions")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "immutableVersions.retry" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("keeps comparison and its recovery inside the same drawer", () => {
    const close = vi.fn();
    mount({ comparisonActive: true, comparisonDetail: version(1), onCloseCompare: close });
    open();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByText("guardrails.versionComparison")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "guardrails.backToVersionDetail" }));
    expect(close).toHaveBeenCalled();
  });

  it("starts with a sorted three-version list and opens only the selected snapshot", () => {
    mount();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getAllByRole("button", { name: /^immutableVersions.view version:/ }).map(button => button.textContent)).toEqual([version(3).version, version(2).version, version(1).version]);
    expect(screen.queryByText("immutableVersions.requestHandling")).toBeNull();
    const dialog = open(2);
    expect(dialog.textContent).toContain(version(2).version);
    expect(dialog.textContent).toContain("immutableVersions.readOnly");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("navigates all three versions without changing the active detail tab", () => {
    mount(); open();
    fireEvent.click(screen.getByRole("tab", { name: /immutableVersions.files/ }));
    expect(screen.getByRole("region", { name: "guardrails.generatedFile: config.yml" }).textContent).toBe("version: 3");
    expect(screen.getByRole("button", { name: "immutableVersions.previous" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "immutableVersions.next" }));
    expect(screen.getByRole("region", { name: "guardrails.generatedFile: config.yml" }).textContent).toBe("version: 2");
    fireEvent.click(screen.getByRole("button", { name: "immutableVersions.next" }));
    expect(screen.getByRole("region", { name: "guardrails.generatedFile: config.yml" }).textContent).toBe("version: 1");
    expect(screen.getByRole("button", { name: "immutableVersions.next" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "immutableVersions.previous" }));
    expect(screen.getByRole("region", { name: "guardrails.generatedFile: config.yml" }).textContent).toBe("version: 2");
  });

  it("paginates Policies and replaces details with export, returning to the same tab", async () => {
    mount(); open(2);
    fireEvent.click(screen.getByRole("tab", { name: /immutableVersions.policies/ }));
    expect(screen.getByText("policy-2-0")).toBeTruthy();
    expect(screen.queryByText("policy-2-10")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "immutableVersions.nextPage" }));
    expect(screen.getByText("policy-2-10")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "uiCopy.versionActions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "guardrails.exportEllipsis" }));
    const dialog = await screen.findByRole("dialog", { name: /guardrailPackage.exportTitle/ });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(dialog.textContent).toContain("guardrailPackage.exportTitle");
    await waitFor(() => expect(within(dialog).getAllByRole("checkbox")).toHaveLength(3));
    const chosen = within(dialog).getAllByRole("checkbox").filter(box => (box as HTMLInputElement).checked);
    expect(chosen.map(box => box.getAttribute("aria-label"))).toEqual([version(2).version]);
    fireEvent.click(within(dialog).getByRole("button", { name: "common.cancel" }));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("tab", { name: /immutableVersions.policies/ }).getAttribute("data-state")).toBe("active");
    expect(screen.getByText("policy-2-10")).toBeTruthy();
  });

  it("keeps export in the menu for viewers and hides administrative actions", () => {
    auth.user.role = "viewer";
    mount(); open(2);
    expect(screen.queryByRole("button", { name: "guardrails.exportEllipsis" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "uiCopy.versionActions" }));
    expect(screen.getByRole("menuitem", { name: "guardrails.exportEllipsis" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "uiCopy.delete" })).toBeNull();
  });

  it("shows the most recent version-scoped test even when an earlier test passed", () => {
    const run = (id: string, status: string, date: string, target = version(3).version) => ({ id, status, created_at: date, guardrail_version: target }) as ValidationRun;
    mount({ validationRuns: [run("passed", "passed", "2026-10-01"), run("failed", "failed", "2026-10-02"), run("other", "passed", "2026-10-03", "draft")] });
    const row = screen.getByRole("button", { name: `immutableVersions.view version:${version(3).version}` }).closest("tr")!;
    expect(within(row).getByText("states.failed")).toBeTruthy();
    expect(within(row).queryByText("states.passed")).toBeNull();
  });

  it("keeps the list visible while details fail and offers retry inside the drawer", () => {
    const retry = vi.fn();
    mount({ detailError: new Error("Snapshot unavailable"), detail: undefined, onRetry: retry });
    expect(screen.getAllByRole("button", { name: /^immutableVersions.view version:/ })).toHaveLength(3);
    open();
    expect(screen.getByText("Snapshot unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "immutableVersions.retry" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it.each(["compiling", "failed"] as const)("keeps other versions accessible when a version is %s", status => {
    const pending = { ...version(3), compile_status: status, failure_reason: "Compiler unavailable" };
    mount({ versions: [pending, version(2), version(1)], selectedVersion: pending, detail: undefined }); open();
    expect(screen.getByRole("dialog").textContent).toContain(status === "failed" ? "Compiler unavailable" : "guardrails.compilationPendingDetail");
    fireEvent.click(screen.getByRole("button", { name: "uiCopy.versionActions" }));
    expect(screen.getByRole("menuitem", { name: "guardrails.exportEllipsis" }).hasAttribute("disabled")).toBe(true);
  });

  it("offers no pointer to move: a version is only exported, deleted or pinned elsewhere", () => {
    mount(); open(2);
    fireEvent.click(screen.getByRole("button", { name: "uiCopy.versionActions" }));
    expect(screen.getAllByRole("menuitem").map(item => item.textContent)).toEqual(["guardrails.exportEllipsis", "uiCopy.delete"]);
  });

  it("opens a row action without opening details and preserves deletion blockers", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: `immutableVersions.versionActions version:${version(3).version}` }));
    fireEvent.click(screen.getByRole("menuitem", { name: "uiCopy.delete" }));
    await waitFor(() => expect(getGuardrailVersionDeletionImpact).toHaveBeenCalledWith("g1", version(3).version));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "uiCopy.deleteVersion" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "common.cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
