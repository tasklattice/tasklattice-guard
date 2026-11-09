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

// A dialog role alone also accepts centered modals. Keep the side-panel
// geometry contract explicit so a visual-library migration cannot replace it.
describe("EntitySheet interaction contract", () => {
  it("keeps Carbon menus inside the drawer focus and dismissal boundary", async () => {
    const { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } = await import("./ui/dropdown-menu");
    const selected = vi.fn();
    function MenuFixture() {
      const [open, setOpen] = useState(true);
      return <EntitySheet open={open} onOpenChange={setOpen} title="Version" eyebrow="Versions" description="Read only" footer={null}>
        <DropdownMenu><DropdownMenuTrigger asChild><button aria-label="Version actions">Actions</button></DropdownMenuTrigger>
          <DropdownMenuContent><DropdownMenuItem onSelect={selected}>Export</DropdownMenuItem></DropdownMenuContent>
        </DropdownMenu>
      </EntitySheet>;
    }
    render(<MenuFixture />);
    fireEvent.click(screen.getByRole("button", { name: "Version actions" }));
    const item = screen.getByRole("menuitem", { name: "Export" });
    expect(screen.getByRole("dialog").contains(item)).toBe(true);
    item.focus();
    expect(document.activeElement).toBe(item);
    fireEvent.pointerDown(item, { pointerType: "mouse", button: 0 });
    fireEvent.mouseDown(item);
    fireEvent.mouseUp(item);
    fireEvent.click(item);
    await waitFor(() => expect(selected).toHaveBeenCalledOnce());
    expect(screen.getByRole("dialog", { name: "Version" })).toBeTruthy();
    expect(screen.getByRole("dialog").querySelector('[data-slot="sheet-footer"]')).toBeNull();
  });

  it.each(["md", "lg", "xl", "workflow"] as const)("keeps %s forms anchored to the right at full height", (width) => {
    render(<EntitySheet open onOpenChange={() => {}} width={width} title="Edit resource" eyebrow="Resource"
      description="Review before saving" footer={<button>Save</button>}><input aria-label="Name" /></EntitySheet>);
    const drawer = screen.getByRole("dialog", { name: "Edit resource" });
    expect(drawer.dataset.slot).toBe("sheet-content");
    expect(drawer.dataset.side).toBe("right");
    expect(drawer.classList.contains("fixed")).toBe(true);
    for (const rule of ["inset-y-0", "right-0", "h-full"]) {
      expect(drawer.classList.contains(`data-[side=right]:${rule}`)).toBe(true);
    }
    expect(drawer.querySelector('[data-slot="sheet-footer"]')).toBeTruthy();
    expect(drawer.closest(".cds--modal-container")).toBeNull();
  });
});

// Carbon dropdowns have their own popup keyboard handling. Escape must unwind
// that popup first instead of discarding the entire form in the outer drawer.
it("closes a Carbon dropdown before dismissing the drawer on Escape", async () => {
  const { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } = await import("./ui/select");
  function DropdownFixture() {
    const [open, setOpen] = useState(true);
    return <EntitySheet open={open} onOpenChange={setOpen} title="Edit Policy" eyebrow="Policy"
      description="Choose an action" footer={<button>Save</button>}>
      <Select defaultValue="block"><SelectTrigger aria-label="Rule action"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="block">Block</SelectItem><SelectItem value="log">Log</SelectItem></SelectContent>
      </Select>
    </EntitySheet>;
  }
  render(<DropdownFixture />);
  const trigger = screen.getByRole("combobox", { name: "Rule action" });
  trigger.focus();
  fireEvent.click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  fireEvent.keyDown(trigger, { key: "Escape" });
  await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("false"));
  expect(screen.getByRole("dialog", { name: "Edit Policy" })).toBeTruthy();
  fireEvent.keyDown(trigger, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
