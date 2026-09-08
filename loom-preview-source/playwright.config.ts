import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test",
  outputDir: "../../../.test-reports/stellar-loom-playwright/results",
  timeout: 30000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    browserName: "chromium",
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "npm run preview:cyan",
      port: 4321,
      reuseExistingServer: false,
      timeout: 30000,
      env: {
        ASTRO_PREVIEW_BACKGROUND: "false",
      },
    },
    {
      command: "npm run preview:amber",
      port: 4322,
      reuseExistingServer: false,
      timeout: 30000,
      env: {
        ASTRO_PREVIEW_BACKGROUND: "false",
      },
    },
    {
      command: "npm run preview:neutral",
      port: 4323,
      reuseExistingServer: false,
      timeout: 30000,
      env: {
        ASTRO_PREVIEW_BACKGROUND: "false",
      },
    },
  ],
  projects: [
    {
      name: "stellar-cyan",
      use: {
        baseURL: "http://127.0.0.1:4321",
      },
      testMatch: /stellar-cyan\.spec\.ts/,
    },
    {
      name: "amber-forge",
      use: {
        baseURL: "http://127.0.0.1:4322",
      },
      testMatch: /amber-forge\.spec\.ts/,
    },
    {
      name: "style-fidelity",
      use: {
        baseURL: "http://127.0.0.1:4323",
      },
      testMatch: /style-fidelity\.spec\.ts/,
    },
  ],
});
