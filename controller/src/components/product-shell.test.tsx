import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControllerRequestError } from "@/lib/controller-api";
import { ErrorNotice } from "./product-shell";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

describe("ErrorNotice diagnostics", () => {
  it("shows the message, Controller status, and complete upstream evidence as text", () => {
    const body = '<html><script>alert("gateway")</script>upstream unavailable</html>';
    const { container } = render(<ErrorNotice error={new ControllerRequestError("AI provider returned HTTP 503.", 502, "intent_analysis_failed", {
      provider: "NIM", stage: "upstream_http", upstreamStatus: 503, responseBody: body,
    })} />);
    expect(screen.getByText("AI provider returned HTTP 503.")).toBeTruthy();
    expect(screen.getByText("HTTP 502 · intent_analysis_failed")).toBeTruthy();
    expect(container.querySelector("details")?.open).toBe(true);
    expect(container.querySelector("pre")?.textContent).toContain(JSON.stringify(body));
    expect(container.querySelector("script")).toBeNull();
  });

  it("keeps plain errors readable without an empty diagnostics panel", () => {
    const { container } = render(<ErrorNotice error={new Error("Connection failed")} />);
    expect(screen.getByText("Connection failed")).toBeTruthy();
    expect(container.querySelector("details")).toBeNull();
  });
});
