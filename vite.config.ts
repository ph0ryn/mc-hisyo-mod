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
    environment: "node",
  },
  pack: {
    entry: { cli: "src/cli.ts", directorBridge: "src/pi/directorBridge.ts" },
    deps: { neverBundle: [/^typebox(?:\/.*)?$/] },
    format: "esm",
    platform: "node",
    target: "node24",
    sourcemap: true,
  },
});
