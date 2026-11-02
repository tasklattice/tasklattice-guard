vi.mock("@/components/settings-navigation", () => ({ SettingsNavigation: () => null }));
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { VersionPage } from "./version";
import { getSystemVersion } from "@/lib/controller-api";
vi.mock("@/lib/controller-api", () => ({ getSystemVersion: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en", exists: () => false } }) }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const software = { version: "v1-1-gabc-dirty", commit: "abc", branch: "main", dirty: true, source: "build" as const };
function page() { return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><VersionPage /></QueryClientProvider>); }
it("shows control and Runner source identities including dirty builds and missing Git metadata", async () => {
  vi.mocked(getSystemVersion).mockResolvedValue({ controlPlane: software, dataPlane: [{ runnerId: "runner-old", poolId: "default", status: "offline", lastHeartbeatAt: null, software: { version: "0.2.0", commit: null, branch: null, dirty: null, source: "unknown" } }] });
  page();
  expect(await screen.findByText("v1-1-gabc-dirty")).toBeTruthy();
  expect(screen.getByText("softwareVersion.dirty")).toBeTruthy();
  expect(screen.getByText("runner-old")).toBeTruthy();
  expect(screen.getByText("softwareVersion.missingGitMetadata")).toBeTruthy();
});
it("recovers from a request error with refresh and shows an empty fleet", async () => {
  vi.mocked(getSystemVersion).mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ controlPlane: { ...software, dirty: false }, dataPlane: [] });
  page();
  expect(await screen.findByRole("alert")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "softwareVersion.refresh" }));
  expect(await screen.findByText("softwareVersion.empty")).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});
