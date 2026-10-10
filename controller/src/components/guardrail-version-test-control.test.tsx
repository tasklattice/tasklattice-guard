import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GuardrailVersion, ValidationRun } from "@/lib/api";
import { GuardrailVersionTestControl } from "./guardrail-version-test-control";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, values?: { version?: string }) => values?.version ? `${key} ${values.version}` : key }) }));
afterEach(cleanup);
const version = { version: "20261009-090837.640Z", created_at: "2026-10-09T09:09:10Z", test_suite_count: 12 } as GuardrailVersion;
const defaults = { guardrailName: "Bank assistant", versions: [version], runs: [], loading: false, error: null, submitting: false, onRun: vi.fn(async () => {}), onRetry: vi.fn() };
const open = () => fireEvent.click(screen.getByRole("button", { name: "guardrails.runReviewed" }));

describe("Unified flat testing targets", () => {
  it("keeps the report action simple and runs the chosen row without a dropdown", async () => {
    const onRun = vi.fn(async () => {});
    const goodVersion = "20261009-090835.526Z";
    render(<GuardrailVersionTestControl {...defaults} versions={[{ ...version, test_suite_count: 0 }, { ...version, version: goodVersion }]} onRun={onRun} />);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByText(version.version)).toBeNull();
    open();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByRole("button", { name: `immutableVersions.runVersionTests ${version.version}` }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("immutableVersions.noTestSuite")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: `immutableVersions.runVersionTests ${goodVersion}` }));
    expect(onRun).toHaveBeenCalledWith(goodVersion);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("routes the local draft through the existing review, alongside immutable versions", () => {
    const onReview = vi.fn();
    render(<GuardrailVersionTestControl {...defaults} draft={{ running: false, reason: null, onReview }} />);
    open();
    expect(screen.getByText(version.version)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "guardrails.testDraft" }));
    expect(onReview).toHaveBeenCalledOnce();
  });

  it("prevents duplicate runs while a version is being tested", () => {
    render(<GuardrailVersionTestControl {...defaults} runs={[{ subject: "version", guardrail_version: version.version, execution_status: "running" } as ValidationRun]} />);
    open();
    expect(screen.getByRole("button", { name: `immutableVersions.runVersionTests ${version.version}` }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("guardrails.runningValidation")).toBeTruthy();
  });

  it("blocks stale targets after an error and offers retry", () => {
    const onRetry = vi.fn();
    render(<GuardrailVersionTestControl {...defaults} error={new Error("Unavailable")} onRetry={onRetry} />);
    open();
    expect(screen.getByRole("button", { name: `immutableVersions.runVersionTests ${version.version}` }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "immutableVersions.retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
