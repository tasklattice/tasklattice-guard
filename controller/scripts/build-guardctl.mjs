import { build } from "esbuild";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// A self-contained CLI: the Runner needs Node, but no npm, tsx or node_modules.
const result = await build({
  entryPoints: ["src/cli/guardctl.ts"],
  outfile: "dist-cli/guardctl.cjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  banner: { js: "#!/usr/bin/env node" },
  legalComments: "eof",
  metafile: true,
});

// Bundling removes node_modules; keep the included packages' license files.
const packages = new Set();
for (const input of Object.keys(result.metafile.inputs).filter(path => path.includes("node_modules/"))) {
  let directory = dirname(resolve(input));
  while (!existsSync(join(directory, "package.json"))) directory = dirname(directory);
  packages.add(directory);
}
const notices = [];
for (const directory of [...packages].sort()) {
  const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  const licenses = readdirSync(directory).filter(name => /^(license|licence|copying)(\.|$)/i.test(name));
  for (const license of licenses) {
    notices.push(`${pkg.name}@${pkg.version}\n${readFileSync(join(directory, license), "utf8")}`);
  }
}
writeFileSync("dist-cli/THIRD_PARTY_LICENSES.txt", notices.join("\n\n---\n\n"));
