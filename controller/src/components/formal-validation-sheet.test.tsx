import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FormalValidationSheet } from "./formal-validation-sheet";
import { declarativePolicyEn } from "../declarative-policy-i18n";
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => declarativePolicyEn[key.replace("declarativePolicy.", "") as keyof typeof declarativePolicyEn] ?? key }) }));
afterEach(cleanup);
it("requires explicit policy-scoped examples before requesting a proof binding validation", () => {
  const onValidate = vi.fn();
  render(<FormalValidationSheet pending={false} onClose={vi.fn()} onValidate={onValidate} />);
  const button = screen.getByRole("button", { name: "modelSettings.validateAssignment" }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  for (const [name, value] of [["Formal policy ID", "warranty-duration"], ["Formal policy version", "1"], ["User query", "Warranty?"], ["Known valid response", "One year."], ["Known invalid response", "One year."]]) {
    fireEvent.change(screen.getByRole("textbox", { name, exact: true }), { target: { value } });
  }
  expect(button.disabled).toBe(true);
  fireEvent.change(screen.getByRole("textbox", { name: "Known invalid response" }), { target: { value: "Ten years." } });
  expect(button.disabled).toBe(false); fireEvent.click(button);
  expect(onValidate).toHaveBeenCalledWith({ policyId: "warranty-duration", policyVersion: "1", confidenceThreshold: 0.8, query: "Warranty?", validResponse: "One year.", invalidResponse: "Ten years." });
});
