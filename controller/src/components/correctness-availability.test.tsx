import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CorrectnessUnavailable, useCorrectnessAvailability } from "./correctness-availability";
import { protectionEn } from "../protection-i18n";

const getModels = vi.hoisted(() => vi.fn());
vi.mock("@/lib/controller-api", () => ({ getModelConfiguration: getModels }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, values?: Record<string, string>) => {
  const label = key.startsWith("protection.") ? key.slice(11).split(".").reduce<unknown>((value, part) => (value as Record<string, unknown>)?.[part], protectionEn) : key;
  return Object.entries(values ?? {}).reduce((text, [name, value]) => text.replaceAll(`{{${name}}}`, value), String(label ?? key));
} }) }));
afterEach(() => { cleanup(); getModels.mockReset(); });
const view = { models: [{ id: "grounding", name: "Grounding judge" }, { id: "reasoning", name: "Formal reasoning" }], active: null, draft: null, activating: null };
const revision = (capability: string, status = "passed", evidenceKind = "nemo-rail-v1") => {
  const id = capability === "contextual_grounding" ? "grounding" : "reasoning";
  return { assignments: { bindings: { [`${capability}.output`]: id } }, validationReport: { checks: [{ id: `probe:${capability}.output:${id}`, status, evidenceKind }] } };
};
function show() {
  function Probe() {
    const availability = useCorrectnessAvailability(true);
    return <><output aria-label="Correctness availability">{availability.status}</output><CorrectnessUnavailable availability={availability} />{Object.entries(availability.capabilities).map(([key, state]) => <button key={key} disabled={!state.ready}>{key}</button>)}</>;
  }
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Probe /></QueryClientProvider>);
}
describe.each(["contextual_grounding", "automated_reasoning"])("%s availability", capability => {
  it.each(["missing", "unverified", "failed", "validated", "activating"])("blocks configuration when %s", async state => {
    const config = state === "missing" ? view : { ...view, [state === "validated" ? "draft" : state === "activating" ? "activating" : "active"]:
      revision(capability, state === "failed" ? "failed" : "passed", state === "unverified" ? "connection-only" : "nemo-rail-v1") };
    getModels.mockResolvedValue(config);
    show();
    const label = protectionEn.correctness[capability as "contextual_grounding" | "automated_reasoning"];
    await screen.findByText(protectionEn.correctness.availability[state as keyof typeof protectionEn.correctness.availability].replace("{{capability}}", label));
    expect(screen.getByLabelText("Correctness availability").textContent).toBe("unavailable");
    expect(screen.getByRole("button", { name: capability, exact: true }).hasAttribute("disabled")).toBe(true);
  });
  it("enables only its own verified active assignment, even with a failed draft", async () => {
    getModels.mockResolvedValue({ ...view, active: revision(capability), draft: revision(capability, "failed") });
    show();
    const other = capability === "contextual_grounding" ? "automated_reasoning" : "contextual_grounding";
    await screen.findByText(protectionEn.correctness.availability.missing.replace("{{capability}}", protectionEn.correctness[other]));
    expect(screen.getByRole("button", { name: capability, exact: true }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: other, exact: true }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByLabelText("Correctness availability").textContent).toBe("partial");
  });
});
it("fails closed while loading or offline and recovers on retry", async () => {
  getModels.mockRejectedValueOnce(new Error("Offline")).mockResolvedValue({ ...view, active: revision("contextual_grounding") });
  show();
  expect(screen.getByRole("button", { name: "contextual_grounding", exact: true }).hasAttribute("disabled")).toBe(true);
  await screen.findByText(protectionEn.correctness.availability.error.replace("{{capability}}", "Contextual Grounding"));
  fireEvent.click(screen.getAllByRole("button", { name: "common.retry" })[0]!);
  await screen.findByText(protectionEn.correctness.availability.missing.replace("{{capability}}", "Automated Reasoning"));
  expect(screen.getByRole("button", { name: "contextual_grounding", exact: true }).hasAttribute("disabled")).toBe(false);
});
