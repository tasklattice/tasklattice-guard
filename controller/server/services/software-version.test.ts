import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readSoftwareVersion } from "./software-version.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
it("captures clean, untracked, staged, unstaged and detached Git states", () => {
  const cwd = mkdtempSync(join(tmpdir(), "guard-version-")); dirs.push(cwd);
  const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
  git("init"); git("config", "user.email", "test@example.com"); git("config", "user.name", "Test");
  writeFileSync(join(cwd, "source"), "first"); git("add", "."); git("commit", "-m", "initial"); git("tag", "v1.0.0");
  const clean = readSoftwareVersion(cwd, "");
  expect(clean).toMatchObject({ dirty: false, source: "workspace" });
  expect(clean.version).toMatch(/^v1\.0\.0-0-g[0-9a-f]{12}$/);
  writeFileSync(join(cwd, "new"), "untracked"); expect(readSoftwareVersion(cwd, "").dirty).toBe(true);
  git("add", "new"); expect(readSoftwareVersion(cwd, "").dirty).toBe(true);
  git("commit", "-m", "new"); writeFileSync(join(cwd, "source"), "changed");
  expect(readSoftwareVersion(cwd, "").version).toMatch(/-dirty$/);
  git("checkout", "--", "source"); git("checkout", "--detach");
  expect(readSoftwareVersion(cwd, "")).toMatchObject({ branch: null, dirty: false });
  expect(readSoftwareVersion(cwd, JSON.stringify(clean))).toEqual({ ...clean, source: "build" });
});
it("does not present missing or invalid metadata as clean", () => {
  const cwd = mkdtempSync(join(tmpdir(), "guard-no-git-")); dirs.push(cwd);
  expect(readSoftwareVersion(cwd, "")).toMatchObject({ version: "unknown", dirty: null });
  expect(readSoftwareVersion(cwd, "invalid")).toMatchObject({ source: "unknown", dirty: null });
});
