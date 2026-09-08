import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GuardrailPolicyBinding } from "@/lib/api";
import { ProtectionOrderEditor } from "./protection-workspace";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, values?: { name?: string }) => `${key}${values?.name ? ` ${values.name}` : ""}` }),
}));
afterEach(cleanup);

const bindings: GuardrailPolicyBinding[] = ["alpha", "beta", "gamma"].map(policy_id => ({
  policy_id, policy_version: "2.0.0", enabled_rails: ["input", "output"],
  enabled_rule_ids: ["second", "first"], rule_order: ["second", "first"],
  rule_actions: { first: "redact" }, action: null, parameter_values: {}, reasoning_policy: null,
}));
function setup() {
  const changed = vi.fn();
  const submitted = vi.fn();
  function Editor() {
    const [value, setValue] = useState(bindings);
    return <form onSubmit={event => { event.preventDefault(); submitted(); }}>
      <ProtectionOrderEditor bindings={value} policies={[]} onChange={next => { changed(next); setValue(next); }} />
    </form>;
  }
  render(<Editor />);
  return { changed, submitted };
}

describe("Policy order keyboard controls", () => {
  it.each([
    ["protection.moveUp beta", [bindings[1], bindings[0], bindings[2]]],
    ["protection.moveDown beta", [bindings[0], bindings[2], bindings[1]]],
  ])("keeps %s focused at the boundary and prevents further movement", (name, expected) => {
    const { changed, submitted } = setup();
    const button = screen.getByRole("button", { name: name as string });
    button.focus();
    fireEvent.click(button);
    expect(changed).toHaveBeenCalledExactlyOnceWith(expected);
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
    fireEvent.click(button);
    expect(changed).toHaveBeenCalledOnce();
    expect(submitted).not.toHaveBeenCalled();
  });

  it("guards initial boundaries without submitting the surrounding form", () => {
    const { changed, submitted } = setup();
    for (const name of ["protection.moveUp alpha", "protection.moveDown gamma"]) {
      const button = screen.getByRole("button", { name });
      button.focus();
      fireEvent.click(button);
      expect(document.activeElement).toBe(button);
      expect(button.getAttribute("aria-disabled")).toBe("true");
    }
    expect(changed).not.toHaveBeenCalled();
    expect(submitted).not.toHaveBeenCalled();
  });

  it("allows moving back from the boundary with the opposite control", () => {
    const { changed, submitted } = setup();
    fireEvent.click(screen.getByRole("button", { name: "protection.moveUp beta" }));
    fireEvent.click(screen.getByRole("button", { name: "protection.moveDown beta" }));
    expect(changed).toHaveBeenLastCalledWith(bindings);
    expect(submitted).not.toHaveBeenCalled();
  });
});
