// @vitest-environment jsdom
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getModelConfiguration, type ModelConfigurationView } from "@/lib/controller-api";
import { getGroupModelConfiguration, groupModelConfigurationKey, updateGroupModelConfiguration, type GroupModelConfigurationView } from "@/lib/project-groups-api";
import { projectGroupsEn } from "@/project-groups-i18n";
import { GroupModelConfigurationSheet } from "./group-model-configuration";

vi.mock("@/lib/controller-api", async original => ({ ...await original<typeof import("@/lib/controller-api")>(), getModelConfiguration: vi.fn() }));
vi.mock("@/lib/project-groups-api", async original => ({ ...await original<typeof import("@/lib/project-groups-api")>(), getGroupModelConfiguration: vi.fn(), updateGroupModelConfiguration: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a> }));
vi.mock("@/components/entity-sheet", () => ({ EntitySheet: ({ children, footer, title }: { children: ReactNode; footer: ReactNode; title: ReactNode }) => <section role="dialog" aria-label={String(title)}>{children}{footer}</section> }));

let client: QueryClient;
let policy: GroupModelConfigurationView;
let catalog: ModelConfigurationView;
const fingerprint = "a".repeat(64);
const sourceId = "00000000-0000-4000-8000-000000000001";
const onClose = vi.fn();
const group = { id: "ab", name: "A + B" };
function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><GroupModelConfigurationSheet group={group} scopeDescription="Applies to the dedicated Runner." copy={projectGroupsEn} onClose={onClose} /></QueryClientProvider>);
}
const apply = () => screen.getByRole("button", { name: "Apply Model policy" });
async function chooseMode(mode: string) {
  fireEvent.change(await screen.findByRole("combobox", { name: "Model access" }), { target: { value: mode } });
}
beforeEach(() => {
  vi.clearAllMocks();
  policy = { groupId: "ab", mode: "blocked", version: 0, grantId: null, sourceRevisionId: null, sourceFingerprint: null,
    generation: null, modelIds: [], providerIds: [], updatedAt: null };
  catalog = { providers: [], models: [{ id: "model-a", name: "Detector A", providerName: "Provider A" } as ModelConfigurationView["models"][number]],
    draft: { id: sourceId, state: "validated", assignments: { controlPlane: null, bindings: { "test.binding": "model-a" } },
      validationReport: { valid: true, runtimeFingerprint: fingerprint }, validatedAt: "2026-11-02T00:00:00Z" } as unknown as ModelConfigurationView["draft"],
    active: null, activating: null, failed: null };
  vi.mocked(getGroupModelConfiguration).mockReset().mockImplementation(async () => policy);
  vi.mocked(getModelConfiguration).mockReset().mockImplementation(async () => catalog);
  vi.mocked(updateGroupModelConfiguration).mockReset().mockImplementation(async (_id, input) => ({ ...policy, mode: input.mode, version: policy.version + 1 }));
});
afterEach(() => { cleanup(); client?.clear(); });

describe("group runtime Model policy", () => {
  it("grants the displayed validated source to this group with version and fingerprint checks", async () => {
    mount(); await chooseMode("scoped");
    expect(apply().hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByRole("combobox", { name: "Validated source" }), { target: { value: sourceId } });
    expect(screen.getByText("test.binding: Detector A · Provider A")).toBeTruthy();
    fireEvent.click(apply());
    await waitFor(() => expect(updateGroupModelConfiguration).toHaveBeenCalledWith("ab", {
      mode: "scoped", expectedVersion: 0, sourceRevisionId: sourceId, expectedSourceFingerprint: fingerprint,
    }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("does not offer old validation reports without a reviewed runtime fingerprint", async () => {
    delete catalog.draft!.validationReport!.runtimeFingerprint;
    mount(); await chooseMode("scoped");
    expect(screen.getByRole("combobox", { name: "Validated source" }).children).toHaveLength(1);
    expect(apply().hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/No eligible validated configuration/)).toBeTruthy();
    expect(updateGroupModelConfiguration).not.toHaveBeenCalled();
  });

  it("keeps the reviewed source when a different catalog snapshot enters the cache", async () => {
    mount(); await chooseMode("scoped");
    fireEvent.change(screen.getByRole("combobox", { name: "Validated source" }), { target: { value: sourceId } });
    await act(async () => {
      client.setQueryData(["settings", "group-model-catalog"], { ...catalog, draft: {
        ...catalog.draft, validationReport: { ...catalog.draft!.validationReport, runtimeFingerprint: "b".repeat(64) },
      } });
    });
    fireEvent.click(apply());
    await waitFor(() => expect(updateGroupModelConfiguration).toHaveBeenCalledWith("ab", expect.objectContaining({ expectedSourceFingerprint: fingerprint })));
  });

  it("can block future retrieval even when the global catalog is unavailable", async () => {
    policy = { ...policy, mode: "scoped", version: 7, modelIds: ["model-a"] };
    vi.mocked(getModelConfiguration).mockRejectedValue(new Error("Catalog unavailable"));
    mount(); await chooseMode("blocked"); fireEvent.click(apply());
    await waitFor(() => expect(updateGroupModelConfiguration).toHaveBeenCalledWith("ab", { mode: "blocked", expectedVersion: 7 }));
  });

  it("never offers platform inheritance to a custom group", async () => {
    mount(); await screen.findByRole("combobox", {name:"Model access"});
    expect(screen.queryByRole("option", {name:"Platform defaults"})).toBeNull();
  });

  it("requires refresh and review after a conflict without silently retrying a newer version", async () => {
    policy = {...policy, mode:"scoped"};
    vi.mocked(updateGroupModelConfiguration).mockRejectedValueOnce(new Error("The group Model policy changed"));
    mount(); await chooseMode("blocked"); fireEvent.click(apply());
    await screen.findByText("The group Model policy changed");
    expect(apply().hasAttribute("disabled")).toBe(true);
    await act(async () => { client.setQueryData(groupModelConfigurationKey("ab"), policy); });
    expect(updateGroupModelConfiguration).toHaveBeenCalledTimes(1);
    policy = { ...policy, version: 2, mode: "scoped" };
    fireEvent.click(screen.getByRole("button", { name: "Refresh and review" }));
    await waitFor(() => expect(screen.getByText("Version 2")).toBeTruthy());
    await chooseMode("blocked"); fireEvent.click(apply());
    await waitFor(() => expect(updateGroupModelConfiguration).toHaveBeenLastCalledWith("ab", { mode: "blocked", expectedVersion: 2 }));
  });

  it("does not enable edits using a cached policy after its refresh fails", async () => {
    vi.mocked(getGroupModelConfiguration).mockRejectedValue(new Error("Private upstream detail"));
    mount(); client.setQueryData(groupModelConfigurationKey("ab"), policy);
    expect((await screen.findByRole("alert")).textContent).toContain("current Model policy is unavailable");
    expect(screen.queryByRole("combobox", { name: "Model access" })).toBeNull();
    expect(screen.queryByText("Private upstream detail")).toBeNull();
  });
});
