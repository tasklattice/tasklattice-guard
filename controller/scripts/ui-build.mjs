import { randomUUID } from "node:crypto";

// A build identity, including uncommitted/local builds; it never depends on a
// release tag or a Git checkout being present in the runtime image.
export function uiBuildPlugin() {
  const buildId = randomUUID();
  return {
    name: "tali-ui-build",
    apply: "build",
    transformIndexHtml() {
      return [{ tag: "meta", attrs: { name: "tali-ui-build", content: buildId }, injectTo: "head" }];
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "ui-version.json", source: JSON.stringify({ buildId }) });
    },
  };
}
