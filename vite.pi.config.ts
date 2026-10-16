import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["src/pi/*.test.mjs"],
    environment: "node",
    testTimeout: 15_000,
    hookTimeout: 5_000,
  },
});
