import { useRef, useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EntitySheet } from "./entity-sheet";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: () => "Close" }) }));
afterEach(cleanup);

function Fixture() {
  const [open, setOpen] = useState(false);
  const [navigated, setNavigated] = useState(false);
  const opener = useRef<HTMLButtonElement | null>(null);
  return <>
    {!navigated && <>
      <button onClick={(event) => { opener.current = event.currentTarget; setOpen(true); }}>Create</button>
      <button onClick={(event) => { opener.current = event.currentTarget; setOpen(true); }}>Create first</button>
    </>}
    <EntitySheet open={open} returnFocusRef={opener} onOpenChange={setOpen} title="Create Guardrail" eyebrow="Guardrails"
      description="Save a draft" footer={<button onClick={() => setOpen(false)}>Cancel</button>}>
      <input autoFocus aria-label="Name" />
      <button onClick={() => { setNavigated(true); setOpen(false); }}>Navigate after save</button>
    </EntitySheet>
  </>;
}

describe("controlled EntitySheet focus", () => {
  it.each(["Escape", "Close", "Cancel"])("returns focus to the actual opener after %s", async (action) => {
    render(<Fixture />);
    for (const name of ["Create", "Create first"]) {
      const opener = screen.getByRole("button", { name, exact: true });
      opener.focus();
      fireEvent.click(opener);
      const dialog = await screen.findByRole("dialog", { name: "Create Guardrail" });
      expect(dialog.contains(document.activeElement)).toBe(true);
      if (action === "Escape") fireEvent.keyDown(document.activeElement!, { key: "Escape" });
      else fireEvent.click(screen.getByRole("button", { name: action, exact: true }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(opener));
    }
  });

  it("does not focus an opener that was removed after saving", async () => {
    render(<Fixture />);
    const opener = screen.getByRole("button", { name: "Create", exact: true });
    opener.focus();
    fireEvent.click(opener);
    await screen.findByRole("dialog");
    const focus = vi.spyOn(opener, "focus");
    fireEvent.click(screen.getByRole("button", { name: "Navigate after save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(opener.isConnected).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });
});
