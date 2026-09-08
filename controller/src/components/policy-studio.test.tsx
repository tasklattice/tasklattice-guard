import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PolicyImport } from "@/lib/policy-transfer";
import { queryKeys } from "@/features/query-keys";
import { protectionDirectoryIds } from "../../shared/protection-map";
import { PolicyStudioSheet } from "./policy-studio";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { email: "author@example.test", role: "admin" } }) }));
const api = vi.hoisted(() => ({ catalog: vi.fn(), create: vi.fn(), update: vi.fn(), validate: vi.fn(), run: vi.fn(), publish: vi.fn() }));
vi.mock("@/lib/api", async original => ({ ...await original<typeof import("@/lib/api")>(),
  getActionCatalog: api.catalog, createProgrammablePolicy: api.create,
  updateProgrammablePolicy: api.update, validateProgrammablePolicy: api.validate,
  runProgrammablePolicyValidation: api.run, publishProgrammablePolicy: api.publish,
}));

const imported: PolicyImport = {
  name: "Synthetic check", description: "Directory regression", owner: "author@example.test", sourcePolicyId: null, sourceDraftRevision: null,
  draft: { guardrail_category: "pii_detection", colang_version: "2.x", sources: [{ path: "main.co", content: "flow check_request $text\n  pass" }],
    parameter_schema: [], action_references: [], evaluation_contracts: [], prompt_dependencies: [], execution_contract: [],
    rail_bindings: [{ rail_type: "input", flow_name: "check_request", execution_mode: "detect", on_unsafe: "reject",
      parallel_group: null, priority: null, timeout_ms: 500, failure_mode: "fail_closed", required: true, depends_on: [] }],
    test_cases: [{ id: "one", name: "Safe", description: "", rail_type: "input", content: "Hello", expected_decision: "allow",
      covered_rule_ids: ["flow/input/check_request"], case_type: "input_rail", required: true, expected_failure: null,
      concurrency_group: null, trusted_instruction: "", use_guardrail_instruction: false, for_each: null,
      target_source: "user_input", query: "", grounding_sources: [], expected_reasoning_result: null }],
  },
};
function show(onSaved = vi.fn(), source: PolicyImport = imported) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = (open: boolean) => <QueryClientProvider client={client}><PolicyStudioSheet open={open} policy={null} imported={source} onOpenChange={() => {}} onSaved={onSaved} /></QueryClientProvider>;
  const rendered = render(view(true));
  return { client, setOpen: (open: boolean) => rendered.rerender(view(open)) };
}
function review() {
  fireEvent.click(screen.getByRole("button", { name: "common.next" }));
  fireEvent.click(screen.getByRole("button", { name: "common.next" }));
}
async function selectDirectory(directory: string) {
  fireEvent.keyDown(screen.getByRole("combobox", { name: "policyStudio.protectionDirectory" }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("option", { name: `protection.directories.${directory}` }));
}
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  api.catalog.mockReset().mockResolvedValue({ items: [] });
  api.publish.mockReset();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  api.create.mockResolvedValue({ id: "regression" }); api.update.mockResolvedValue({ id: "regression" });
  api.validate.mockResolvedValue({}); api.run.mockResolvedValue({ status: "passed", draft_revision: 1, results: [] });
});

describe("Policy Studio business directory", () => {
  it("retries an unconfirmed publication with the same validated revision without saving again", async () => {
    api.publish.mockRejectedValueOnce(new Error("Connection closed after commit"))
      .mockResolvedValueOnce({ policy_id: "regression", version: "7" });
    const onSaved = vi.fn().mockResolvedValue(undefined);
    show(onSaved); review();
    fireEvent.click(screen.getByRole("button", { name: "policyStudio.validateAndRun" }));
    fireEvent.click(await screen.findByRole("button", { name: "policyStudio.publish" }));
    await screen.findByText("policyStudio.publicationUnconfirmed");
    expect(onSaved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "policyStudio.retryPublication" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(api.publish.mock.calls).toEqual([["regression", 1], ["regression", 1]]);
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(api.update).not.toHaveBeenCalled();
    expect(api.run).toHaveBeenCalledTimes(1);
  });
  it("invalidates navigation from a published detail load when its editor closes", async () => {
    api.publish.mockResolvedValueOnce({ policy_id: "regression", version: "7" });
    let finish!: () => void;
    const onSaved = vi.fn().mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const view = show(onSaved); review();
    fireEvent.click(screen.getByRole("button", { name: "policyStudio.validateAndRun" }));
    fireEvent.click(await screen.findByRole("button", { name: "policyStudio.publish" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const isCurrent = onSaved.mock.calls[0][1] as () => boolean;
    expect(isCurrent()).toBe(true);
    view.setOpen(false); view.setOpen(true);
    expect(isCurrent()).toBe(false);
    await act(async () => finish());
    expect(screen.queryByText("policyStudio.publishedLoading")).toBeNull();
    expect(screen.queryByRole("button", { name: "policyStudio.openPublished" })).toBeNull();
  });
  it("keeps successful publication distinct from a failed detail refresh and retries reads only", async () => {
    api.publish.mockResolvedValueOnce({ policy_id: "regression", version: "7" });
    const onSaved = vi.fn().mockRejectedValueOnce(new Error("Detail refresh unavailable")).mockResolvedValueOnce(undefined);
    show(onSaved); review();
    fireEvent.click(screen.getByRole("button", { name: "policyStudio.validateAndRun" }));
    fireEvent.click(await screen.findByRole("button", { name: "policyStudio.publish" }));
    await screen.findByText("policyStudio.publishedRefreshFailed");
    expect(screen.queryByRole("button", { name: "policyStudio.publish" })).toBeNull();
    expect(screen.queryByRole("button", { name: "policyStudio.validateAndRun" })).toBeNull();
    expect(document.querySelector("fieldset[disabled]")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "policyStudio.openPublished" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2));
    expect(api.publish).toHaveBeenCalledTimes(1);
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(api.update).not.toHaveBeenCalled();
  });
  it("does not present a paused offline request as an empty Action catalog", async () => {
    onlineManager.setOnline(false);
    try {
      show(); fireEvent.click(screen.getByRole("button", { name: "common.next" }));
      fireEvent.click(screen.getByText("policyStudio.actionsTitle"));
      await screen.findByText("policyStudio.actionsWaitingConnection");
      expect(api.catalog).not.toHaveBeenCalled();
      expect(screen.queryByText("policyStudio.actionsEmpty")).toBeNull();
      await act(async () => { onlineManager.setOnline(true); });
      await screen.findByText("policyStudio.actionsEmpty");
    } finally { onlineManager.setOnline(true); }
  });
  it("distinguishes an unavailable Action catalog and retries without discarding selected dependencies", async () => {
    api.catalog.mockRejectedValueOnce(new Error("Catalog temporarily unavailable"));
    const selected = { name: "GuardCustomerIdentifierAction", version: "1.0.0" };
    show(vi.fn(), { ...imported, draft: { ...imported.draft, action_references: [selected] } });
    fireEvent.click(screen.getByRole("button", { name: "common.next" }));
    await screen.findByText("policyStudio.actionsUnavailable");
    expect(screen.queryByText("policyStudio.actionsEmpty")).toBeNull();
    let finish!: (value: unknown) => void;
    api.catalog.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "policyStudio.retryActions" }));
    await screen.findByRole("status");
    await act(async () => finish({ items: [{ ...selected, supported_rails: ["input"], timeout_ms: 500, failure_mode: "fail_closed" }] }));
    await waitFor(() => expect(screen.queryByText("policyStudio.actionsUnavailable")).toBeNull());
    fireEvent.click(screen.getByText("policyStudio.actionsTitle"));
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "common.next" }));
    fireEvent.click(screen.getByRole("button", { name: "policyStudio.validateAndRun" }));
    await waitFor(() => expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ draft: expect.objectContaining({ action_references: [selected] }) })));
  });

  it("shows an explicit empty catalog only after a successful empty response", async () => {
    show(); fireEvent.click(screen.getByRole("button", { name: "common.next" }));
    fireEvent.click(screen.getByText("policyStudio.actionsTitle"));
    await screen.findByText("policyStudio.actionsEmpty");
    expect(screen.queryByText("policyStudio.actionsUnavailable")).toBeNull();
  });

  it("keeps cached Action rows and checked versions when refreshing the catalog fails", async () => {
    const selected = { name: "GuardCustomerIdentifierAction", version: "1.0.0" };
    api.catalog.mockResolvedValueOnce({ items: [{ ...selected, supported_rails: ["input"], timeout_ms: 500, failure_mode: "fail_closed" }] });
    const { client } = show(vi.fn(), { ...imported, draft: { ...imported.draft, action_references: [selected] } });
    fireEvent.click(screen.getByRole("button", { name: "common.next" }));
    fireEvent.click(screen.getByText("policyStudio.actionsTitle"));
    await screen.findByRole("checkbox");
    api.catalog.mockRejectedValueOnce(new Error("Refresh failed"));
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.actionCatalog }); });
    await screen.findByText("policyStudio.actionsUnavailable");
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("GuardCustomerIdentifierAction@1.0.0")).toBeTruthy();
    expect(screen.queryByText("policyStudio.actionsEmpty")).toBeNull();
  });

  it("locks the published snapshot and does not navigate a reopened editor on late publication", async () => {
    let finish!: (value: unknown) => void;
    api.publish.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const onSaved = vi.fn();
    const view = show(onSaved); review();
    fireEvent.click(screen.getByRole("button", { name: "policyStudio.validateAndRun" }));
    fireEvent.click(await screen.findByRole("button", { name: "policyStudio.publish" }));
    await waitFor(() => expect(api.publish).toHaveBeenCalledTimes(1));
    expect(document.querySelector("fieldset[disabled]")).toBeTruthy();
    view.setOpen(false); view.setOpen(true);
    await act(async () => { finish({ policy_id: "regression", version: "1" }); });
    await waitFor(() => expect(document.querySelector("fieldset[disabled]")).toBeNull());
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "policyStudio.publish" })).toBeNull();
  });
  it.each(["passed", "error"])("does not publish a form edited while its earlier validation is in flight (%s)", async (outcome) => {
    let finish!: () => void;
    api.run.mockReturnValueOnce(new Promise((resolve, reject) => { finish = () => outcome === "passed"
      ? resolve({ status: "passed", draft_revision: 1, results: [] }) : reject(new Error("Older source failed")); }));
    show(); review();
    fireEvent.click(screen.getByRole("button", { name: "policyStudio.validateAndRun" }));
    await waitFor(() => expect(api.run).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole("textbox", { name: "policyStudio.content *" }), { target: { value: "Edited while running" } });
    await act(async () => { finish(); });
    await screen.findByText("policyStudio.validationOutdated");
    expect(screen.queryByRole("button", { name: "policyStudio.publish" })).toBeNull();
    expect((screen.getByRole("textbox", { name: "policyStudio.content *" }) as HTMLTextAreaElement).value).toBe("Edited while running");
    fireEvent.click(screen.getByRole("button", { name: "policyStudio.validateAndRun" }));
    await screen.findByRole("button", { name: "policyStudio.publish" });
    expect(api.update).toHaveBeenCalledWith("regression", expect.objectContaining({ draft: expect.objectContaining({
      test_cases: [expect.objectContaining({ content: "Edited while running" })],
    }) }));
  });

  it.each(["passed", "error"])("ignores a late validation result from a closed editor (%s)", async (outcome) => {
    let finish!: () => void;
    api.run.mockReturnValueOnce(new Promise((resolve, reject) => { finish = () => outcome === "passed"
      ? resolve({ status: "passed", draft_revision: 1, results: [] }) : reject(new Error("Closed editor failed")); }));
    const view = show(); review();
    fireEvent.click(screen.getByRole("button", { name: "policyStudio.validateAndRun" }));
    await waitFor(() => expect(api.run).toHaveBeenCalledTimes(1));
    view.setOpen(false); view.setOpen(true); review();
    await act(async () => { finish(); });
    await waitFor(() => expect(screen.getByRole("button", { name: "policyStudio.validateAndRun" }).hasAttribute("disabled")).toBe(false));
    expect(screen.queryByRole("button", { name: "policyStudio.publish" })).toBeNull();
    expect(screen.queryByText("Closed editor failed")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "policyStudio.validateAndRun" }));
    await screen.findByRole("button", { name: "policyStudio.publish" });
    expect(api.create).toHaveBeenCalledTimes(2);
    expect(api.update).not.toHaveBeenCalled();
  });

  it("does not attach a late saved Policy or start its validation after the editor is reopened", async () => {
    let finish!: (value: unknown) => void;
    api.create.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const view = show(); review();
    fireEvent.click(screen.getByRole("button", { name: "policyStudio.validateAndRun" }));
    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1));
    view.setOpen(false); view.setOpen(true);
    await act(async () => { finish({ id: "old-session-policy" }); });
    await waitFor(() => expect(screen.getByRole("button", { name: "common.next" }).hasAttribute("disabled")).toBe(false));
    expect(api.validate).not.toHaveBeenCalled();
    expect(api.run).not.toHaveBeenCalled();
    review();
    fireEvent.click(screen.getByRole("button", { name: "policyStudio.validateAndRun" }));
    await screen.findByRole("button", { name: "policyStudio.publish" });
    expect(api.create).toHaveBeenCalledTimes(2);
    expect(api.update).not.toHaveBeenCalled();
  });

  it("keeps a stable accessible label when a multiline field is edited", () => {
    show();
    const field = screen.getByRole("textbox", { name: "policyStudio.description *" });
    fireEvent.change(field, { target: { value: "Changed description" } });
    expect(screen.getByRole("textbox", { name: "policyStudio.description *" })).toBe(field);
    expect(field.closest("label")).toBeNull();
  });

  it("offers the same eight directories as the protection map, with the existing classification selected", async () => {
    show();
    const trigger = screen.getByRole("combobox", { name: "policyStudio.protectionDirectory" });
    expect(trigger.textContent).toContain("protection.directories.privacy");
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(await screen.findAllByRole("option")).toHaveLength(8);
    for (const directory of protectionDirectoryIds) expect(screen.getByRole("option", { name: `protection.directories.${directory}` })).toBeTruthy();
    expect(screen.queryByText("policyStudio.guardrailCategory")).toBeNull();
  });

  it("persists the chosen directory, shows it in review and invalidates validation when it changes", async () => {
    show(); await selectDirectory("content_filters"); review();
    fireEvent.click(screen.getByRole("button", { name: "policyStudio.validateAndRun" }));
    await screen.findByRole("button", { name: "policyStudio.publish" });
    expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ draft: { ...imported.draft, protection_directory: "content_filters" } }));
    expect(screen.getByText("protection.directories.content_filters")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "common.previous" }));
    fireEvent.click(screen.getByRole("button", { name: "common.previous" }));
    await selectDirectory("application_injection"); review();
    expect(screen.queryByRole("button", { name: "policyStudio.publish" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "policyStudio.validateAndRun" }));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith("regression", expect.objectContaining({
      draft: { ...imported.draft, protection_directory: "application_injection" },
    })));
  });

  it("retains the directory and source after a save failure and allows a successful retry", async () => {
    api.create.mockRejectedValueOnce(new Error("Fixture connection unavailable"));
    show(); await selectDirectory("business_rules"); review();
    fireEvent.click(screen.getByRole("button", { name: "policyStudio.validateAndRun" }));
    await screen.findAllByText("Fixture connection unavailable");
    expect(api.publish).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "policyStudio.validateAndRun" }));
    await screen.findByRole("button", { name: "policyStudio.publish" });
    expect(api.create.mock.calls[0]).toEqual(api.create.mock.calls[1]);
    expect(screen.getByText("protection.directories.business_rules")).toBeTruthy();
  });
});
