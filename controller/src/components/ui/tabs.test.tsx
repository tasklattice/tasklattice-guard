import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";

function ExampleTabs() {
  return (
    <Tabs defaultValue="overview">
      <TabsList aria-label="Example views">
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="activity">Activity</TabsTrigger>
      </TabsList>
      <TabsContent value="overview">Overview content</TabsContent>
      <TabsContent value="activity">Activity content</TabsContent>
    </Tabs>
  );
}

describe("Tabs", () => {
  afterEach(cleanup);

  it("uses one shared line style without stretching triggers", () => {
    render(<ExampleTabs />);

    const list = screen.getByRole("tablist", { name: "Example views" });
    const overview = screen.getByRole("tab", { name: "Overview" });

    expect(list.className).toContain("cds--tab--list");
    expect(overview.className).toContain("cds--tabs__nav-link");
    expect(overview.className).not.toContain("flex-1");
    expect(overview.getAttribute("data-state")).toBe("active");
    expect(overview.getAttribute("aria-selected")).toBe("true");
  });

  it("switches selection and content with horizontal arrow keys", async () => {
    render(<ExampleTabs />);

    const overview = screen.getByRole("tab", { name: "Overview" });
    const activity = screen.getByRole("tab", { name: "Activity" });
    overview.focus();
    fireEvent.keyDown(overview, { key: "ArrowRight", code: "ArrowRight" });

    await waitFor(() => expect(document.activeElement).toBe(activity));
    expect(activity.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Activity content")).toBeTruthy();
  });
});
