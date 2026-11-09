import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSoftwareVersion, unknownSoftwareVersion, type SoftwareVersion } from "../../shared/software-version.js";

/** Snapshot the source identity, including staged, unstaged and untracked files. */
export function readSoftwareVersion(cwd = dirname(fileURLToPath(import.meta.url)), build = process.env.TALI_BUILD_INFO): SoftwareVersion {
  if (build) {
    const parsed = parseSoftwareVersion(build);
    return { ...parsed, source: parsed.source === "unknown" ? "unknown" : "build" };
  }
  const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    const commit = git("rev-parse", "HEAD");
    const branch = git("rev-parse", "--abbrev-ref", "HEAD");
    const describe = git("describe", "--tags", "--always", "--long", "--abbrev=12");
    const dirty = git("status", "--porcelain", "--untracked-files=normal").length > 0;
    return { version: `${describe}${dirty ? "-dirty" : ""}`, commit, branch: branch === "HEAD" ? null : branch, dirty, source: "workspace" };
  } catch { return unknownSoftwareVersion(); }
}
