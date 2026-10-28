import { mergeConfig, defineConfig } from "vitest/config";
import viteConfig from "./vite.config";
export default mergeConfig(
  viteConfig,
  defineConfig({ test: {
    globalSetup: ["./scripts/setup-openapi.mjs"],
    setupFiles: ["./src/test/browser-apis.ts"],
  } }),
);
