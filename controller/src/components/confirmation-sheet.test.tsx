import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmationSheet } from "./confirmation-sheet";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: () => "Close" }) }));
afterEach(cleanup);

function Fixture({ onConfirm, pending = false }: { onConfirm: () => void; pending?: boolean }) {
  const [open, setOpen] = useState(true);
  return <ConfirmationSheet open={open} onOpenChange={setOpen} pending={pending}
    title="Delete Policy" eyebrow="Policy" description="This removes the selected Policy."
    cancelLabel="Cancel" confirmLabel="Delete" pendingLabel="Deleting" variant="destructive"
    onConfirm={onConfirm}><p>Policy: Customer privacy</p></ConfirmationSheet>;
}

describe("side-effect confirmation", () => {
  it("opens a right drawer and performs no write until explicit confirmation", () => {
    const confirm = vi.fn();
    render(<Fixture onConfirm={confirm} />);
    expect(screen.getByRole("dialog", { name: "Delete Policy" }).dataset.side).toBe("right");
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete", exact: true }));
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("cancels without performing the action", async () => {
    const confirm = vi.fn();
    render(<Fixture onConfirm={confirm} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(confirm).not.toHaveBeenCalled();
  });

  it("blocks duplicate submission and dismissal while a write is pending", () => {
    const confirm = vi.fn();
    render(<Fixture onConfirm={confirm} pending />);
    for (const name of ["Cancel", "Close", "Deleting"]) {
      const button = screen.getByRole("button", { name, exact: true });
      expect(button).toHaveProperty("disabled", true);
      fireEvent.click(button);
    }
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Delete Policy" }).dataset.side).toBe("right");
    expect(confirm).not.toHaveBeenCalled();
  });
});
