import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MultiSelectCombobox } from "./multi-select-combobox";
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }) }));
afterEach(cleanup);
it("searches and replaces a single selection without clearing it first", () => {
  function Example() {
    const [value, setValue] = useState(["a"]);
    return <MultiSelectCombobox ariaLabel="Guardrail" selectionMode="single" value={value} onValueChange={setValue} options={[{value:"a",label:"Main"},{value:"b",label:"Canary"}]} />;
  }
  render(<Example />);
  const input = screen.getByRole("combobox", { name: "Guardrail" }) as HTMLInputElement;
  expect(input.value).toBe("Main");
  fireEvent.focus(input);
  fireEvent.change(input, {target:{value:"Can"}});
  fireEvent.click(screen.getByRole("option", {name:"Canary"}));
  expect(input.value).toBe("Canary");
  expect(input.getAttribute("aria-expanded")).toBe("false");
  fireEvent.focus(input);
  fireEvent.click(screen.getByRole("option", {name:"Main"}));
  expect(input.value).toBe("Main");
});
