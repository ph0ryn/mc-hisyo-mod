import { defineConfig } from "vite-plus";

export default defineConfig({
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {
    ignorePatterns: ["docs/**", "mod/**"],
  },
  test: {
    include: ["src/**/*.test.ts"],
    // Colocated unit tests only; no network, subprocess or database integration suites.
    environment: "node",
  },
  pack: {
    entry: { cli: "src/cli.ts", piExtension: "src/pi/piExtension.ts" },
    deps: { neverBundle: [/^typebox(?:\/.*)?$/] },
    format: "esm",
    platform: "node",
    target: "node24",
    sourcemap: true,
  },
});
