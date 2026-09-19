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
    include: [
      "src/test/**/*.studio.{ts,tsx}",
      "src/features/**/test/*.test.{ts,tsx}",
      "test/**/*.test.{ts,tsx,mjs,js}",
    ],
    environment: "jsdom",
    globals: true,
    restoreMocks: true,
    testTimeout: 30000,
    server: {
      deps: {
        external: [/src-tauri\/loom-payload/],
      },
    },
  },
});
