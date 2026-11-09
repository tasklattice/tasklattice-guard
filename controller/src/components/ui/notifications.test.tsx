import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { Toaster, toast } from "./notifications";
afterEach(() => {
  act(() => toast.dismiss());
  cleanup();
});
it("announces saved and failed operations and allows dismissal", () => {
  render(<Toaster />);
  act(() => {
    toast.success("Saved");
    toast.error("Could not save");
  });
  expect(screen.getByRole("status").textContent).toContain("Saved");
  expect(screen.getByRole("alert").textContent).toContain("Could not save");
  fireEvent.click(screen.getByRole("alert").querySelector("button")!);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(document.querySelector(".guard-toast-region")).toBeTruthy();
});
