import { mergeConfig, defineConfig, configDefaults } from "vitest/config";
import viteConfig from "./vite.config";
export default mergeConfig(
  viteConfig,
  defineConfig({ test: {
    exclude: [...configDefaults.exclude, "dist/**", "dist-*/**"],
    globalSetup: ["./scripts/setup-openapi.mjs", "./scripts/setup-artifact-fixtures.mjs"],
    setupFiles: ["./src/test/browser-apis.ts"],
  } }),
);
