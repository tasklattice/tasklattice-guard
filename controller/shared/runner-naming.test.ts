import { describe, expect, it } from "vitest";
import { isRunnerName, projectNameSchema } from "./runner-naming.js";

describe("immutable Project and Runner naming contract", () => {
  it("normalizes names before uniqueness checks", () => {
    for (const name of [" Support_Search ", "support search", "support--search", "support-search"])
      expect(projectNameSchema.parse(name)).toBe("support-search");
  });
  it.each(["", "default", "DEFAULT", "dashboard", "account", "settings", "playground", "API", "policy_library", "-search", "search-", "search.prod", "项目", "a".repeat(46)])("rejects invalid or reserved Project name %s", name => {
    expect(projectNameSchema.safeParse(name).success).toBe(false);
  });
  it.each(["runner-default-0", "runner-default-1", "runner-default-2147483647"])("accepts canonical ordinal %s", name => {
    expect(isRunnerName(name, "default")).toBe(true);
  });
  it.each(["runner-default-01", "runner-default--1", "runner-default-1.5", "runner-default-2147483648", "runner-other-0", "release-runner-default-0"])("rejects ambiguous or foreign identity %s", name => {
    expect(isRunnerName(name, "default")).toBe(false);
  });
  it("parses a hyphenated Project name using the final ordinal separator", () => {
    expect(isRunnerName("runner-support-search-12", "support-search")).toBe(true);
  });
});
