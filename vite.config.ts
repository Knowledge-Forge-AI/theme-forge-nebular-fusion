import { defineConfig } from "vitest/config";

export default defineConfig({
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "safari15",
    sourcemap: false,
  },
  test: {
    include: ["src/test/**/*.studio.{ts,tsx}"],
    environment: "jsdom",
    globals: true,
    restoreMocks: true,
  },
});
