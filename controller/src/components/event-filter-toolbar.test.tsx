import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventFilterToolbar } from "./event-filter-toolbar";
import type { EventSeverity } from "../../shared/security-severity";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }) }));
afterEach(cleanup);
const counts = { total: 18, critical: 3, high: 3, medium: 3, low: 3, informational: 3, unclassified: 3, affected_traces: 12, latest_at: null };

function Harness({ onTime = vi.fn(), onLevels = vi.fn() }) {
  const [levels, setLevels] = useState<EventSeverity[]>([]);
  return <EventFilterToolbar window="7d" onWindowChange={onTime} severities={levels} onSeveritiesChange={value => { onLevels(value); setLevels(value); }} counts={counts} />;
}

describe("Carbon event filters", () => {
  it("keeps the menu open for multi-selection and clears risk without resetting the time window", async () => {
    const onTime = vi.fn(); const onLevels = vi.fn();
    render(<Harness onTime={onTime} onLevels={onLevels} />);
    fireEvent.click(screen.getByRole("combobox", { name: /securityEvents.riskLevel/ }));
    fireEvent.click(screen.getByRole("option", { name: "routerDetail.severity.high" }));
    await waitFor(() => expect(onLevels).toHaveBeenLastCalledWith(["high"]));
    expect(screen.getByRole("combobox", { name: /securityEvents.riskLevel/ }).getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("option", { name: "routerDetail.severity.critical" }));
    await waitFor(() => expect(onLevels).toHaveBeenLastCalledWith(["critical", "high"]));
    fireEvent.keyDown(screen.getByRole("combobox", { name: /securityEvents.riskLevel/ }), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "securityEvents.removeRiskFilter" }));
    await waitFor(() => expect(onLevels).toHaveBeenLastCalledWith([]));
    expect(onTime).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox", { name: "dashboard.timeRangeFilter" }).textContent).toContain("dashboard.windows.7d");
    expect(screen.queryByLabelText("securityEvents.appliedFilters")).toBeNull();
  });

  it("reveals the risk explanation on demand without adding it to the default page", () => {
    render(<Harness />);
    expect(screen.getByRole("button", { name: "securityEvents.levelGuide" }).getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "securityEvents.levelGuide" }));
    expect(screen.getByRole("button", { name: "securityEvents.levelGuide" }).getAttribute("aria-expanded")).toBe("true");
  });
});
