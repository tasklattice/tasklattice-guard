import { describe, expect, it } from "vitest";
import { createLogTimeFormatter } from "./log-time";

describe("log timestamp precision", () => {
  it.each(["en-US", "zh-CN"])("preserves milliseconds and midnight in %s without rounding seconds", locale => {
    const milliseconds = createLogTimeFormatter(locale);
    for (const ms of [0, 7, 123, 999]) {
      const time = new Date(2026, 10, 11, 0, 0, 0, ms);
      const parts = milliseconds.formatToParts(time);
      expect(parts.find(part => part.type === "fractionalSecond")?.value).toBe(String(ms).padStart(3, "0"));
      expect(parts.find(part => part.type === "hour")?.value).toBe("00");
      expect(parts.find(part => part.type === "second")?.value).toBe("00");
    }
  });

});
