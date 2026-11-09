import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";

import { abbreviateChecksum, CopyableChecksum } from "./copyable-checksum";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/components/ui/notifications", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

describe("CopyableChecksum", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("preserves the beginning and end of long checksums", () => {
    expect(abbreviateChecksum("fb4437aea1a3d877bb12c2b4c183a4a0864eae6da3c8b4f2eb90abcdef123456")).toBe(
      "fb4437aea1a3…ef123456",
    );
    expect(abbreviateChecksum("short-checksum")).toBe("short-checksum");
  });

  it("copies the complete checksum on double-click", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const checksum = "fb4437aea1a3d877bb12c2b4c183a4a0864eae6da3c8b4f2eb90abcdef123456";

    render(
      <TooltipProvider>
        <CopyableChecksum value={checksum} />
      </TooltipProvider>,
    );

    fireEvent.doubleClick(screen.getByRole("button", { name: "common.copyChecksumLabel" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(checksum));
    expect(screen.getByText("fb4437aea1a3…ef123456")).toBeTruthy();
  });
});
