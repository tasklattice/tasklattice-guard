import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreationFlow } from "./creation-flow";

const mobile = vi.hoisted(() => ({ value: false }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => mobile.value }));
beforeEach(() => { mobile.value = false; });
afterEach(cleanup);

function Fixture({ freelyNavigable = false }: { freelyNavigable?: boolean }) {
  const [step, setStep] = useState(0);
  return <CreationFlow freelyNavigable={freelyNavigable} contained orientation="sidebar" progressLabel="Protection map"
    steps={[{ label: "Content", description: "Optional" }, { label: "Privacy", description: "Optional" }, { label: "Review", description: "Draft" }]}
    currentStep={step} onStepChange={setStep}><p>Current {step}</p></CreationFlow>;
}

describe("optional creation navigation", () => {
  it("keeps the current mobile step visible after resizing and disconnects on unmount", () => {
    mobile.value = true;
    let resized = () => {};
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resized = callback; }
      observe = observe;
      disconnect = disconnect;
    });
    try {
      const { unmount } = render(<Fixture freelyNavigable />);
      fireEvent.click(screen.getByRole("tab", { name: /Review/ }));
      const review = screen.getByRole("tab", { name: /Review/ });
      const scroll = vi.fn();
      Object.defineProperty(review, "scrollIntoView", { value: scroll });
      resized();
      expect(scroll).toHaveBeenCalledWith({ block: "nearest", inline: "center" });
      expect(observe).toHaveBeenCalledTimes(2);
      unmount();
      expect(disconnect).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("allows jumping ahead without marking skipped protection steps complete", () => {
    const { container } = render(<Fixture freelyNavigable />);
    fireEvent.click(screen.getByRole("tab", { name: /Review/ }));
    expect(screen.getByText("Current 2")).toBeTruthy();
    expect(container.querySelectorAll('[data-slot="stepper-item"][data-state="completed"]').length).toBe(0);
    expect(screen.getByRole("tab", { name: /Review/ }).getAttribute("aria-current")).toBe("step");
  });

  it("supports keyboard navigation and explicit activation", () => {
    render(<Fixture freelyNavigable />);
    const content = screen.getByRole("tab", { name: /Content/ });
    content.focus();
    fireEvent.keyDown(content, { key: "End" });
    const review = screen.getByRole("tab", { name: /Review/ });
    expect(document.activeElement).toBe(review);
    fireEvent.keyDown(review, { key: "Enter" });
    expect(screen.getByText("Current 2")).toBeTruthy();
  });

  it("preserves gated navigation for existing linear wizards", () => {
    render(<Fixture />);
    const review = screen.getByRole("tab", { name: /Review/ });
    expect(review.hasAttribute("disabled")).toBe(true);
    fireEvent.click(review);
    expect(screen.getByText("Current 0")).toBeTruthy();
  });
});
