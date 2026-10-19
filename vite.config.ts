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
    // Colocated domain units and isolated SDK/TCP/SQLite boundary tests; no paid model calls.
    environment: "node",
  },
  pack: {
    entry: { cli: "src/cli.ts" },
    deps: { neverBundle: [/^typebox(?:\/.*)?$/, /^@earendil-works\//, /^proper-lockfile$/] },
    format: "esm",
    platform: "node",
    target: "node24",
    sourcemap: true,
  },
});
