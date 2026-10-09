import "@/i18n";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { MultiSelectCombobox } from "./multi-select-combobox";

afterEach(cleanup);

function Example({ disabled = false }: { disabled?: boolean }) {
  const [value, setValue] = useState(["dev", "prod"]);
  return <MultiSelectCombobox ariaLabel="Endpoints" value={value} onValueChange={setValue}
    disabled={disabled} maxSelected={2} placeholder="Select Endpoints" options={[
      { value: "prod", label: "Production" },
      { value: "dev", label: "dev" },
      { value: "test", label: "Test" },
      { value: "owned", label: "Already bound", disabled: true },
    ]} />;
}

it("shows selected names inside the field, removes one at a time and preserves input focus", () => {
  render(<Example />);
  const input = screen.getByRole("combobox", { name: "Endpoints" });
  const field = within(input.parentElement!);
  expect(field.getByText("dev", { exact: true })).toBeTruthy();
  expect(field.getByText("Production", { exact: true })).toBeTruthy();
  fireEvent.click(field.getByRole("button", { name: "Remove dev", exact: true }));
  expect(field.queryByText("dev", { exact: true })).toBeNull();
  expect(field.getByText("Production", { exact: true })).toBeTruthy();
  expect(document.activeElement).toBe(input);
});

it("uses Backspace to remove only the last name and never clears all names with Delete", () => {
  render(<Example />);
  const input = screen.getByRole("combobox", { name: "Endpoints" });
  fireEvent.keyDown(input, { key: "Delete" });
  expect(screen.getByRole("button", { name: "Remove Production", exact: true })).toBeTruthy();
  fireEvent.keyDown(input, { key: "Backspace" });
  expect(screen.queryByRole("button", { name: "Remove Production", exact: true })).toBeNull();
  expect(screen.getByRole("button", { name: "Remove dev", exact: true })).toBeTruthy();
});

it("preserves the limit and disabled choices while searching and selecting by keyboard", async () => {
  render(<Example />);
  const input = screen.getByRole("combobox", { name: "Endpoints" });
  fireEvent.click(input);
  expect(screen.getByText("Test", { exact: true }).closest('[role="option"]')?.hasAttribute("disabled")).toBe(true);
  expect(screen.getByText("Already bound", { exact: true }).closest('[role="option"]')?.hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Remove Production", exact: true }));
  fireEvent.change(input, { target: { value: "Tes" } });
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Enter", keyCode: 13 });
  expect(await screen.findByRole("button", { name: "Remove Test", exact: true })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Remove dev", exact: true })).toBeTruthy();
});

it("disables both the input and selected-name removal", () => {
  render(<Example disabled />);
  expect(screen.getByRole("combobox", { name: "Endpoints" }).matches(":disabled")).toBe(true);
  expect(screen.getByRole("button", { name: "Remove dev", exact: true }).matches(":disabled")).toBe(true);
});
