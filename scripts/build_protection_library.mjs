#!/usr/bin/env node
/** Focused Policies are now authored through the shared declarative contract. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const command = process.argv.includes("--write") ? "build" : "check";
execFileSync(join(root, ".venv/bin/python"), [join(root, "scripts/policy_sources.py"), command], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
if (!process.argv.includes("--check") && !process.argv.includes("--write")) {
  process.stdout.write(readFileSync(join(root, "runner/toolkit/policy_library/assets/focused_policies.json"), "utf8"));
}
