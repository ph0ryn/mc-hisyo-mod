import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["src/pi/directorProbe.test.ts", "src/pi/directorBridge.acceptance.test.ts"],
    environment: "node",
    testTimeout: 15_000,
    hookTimeout: 5_000,
  },
});
