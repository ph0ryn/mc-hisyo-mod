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
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
  pack: {
    entry: ["src/cli.ts"],
    format: "esm",
    platform: "node",
    target: "node24",
    sourcemap: true,
  },
});
