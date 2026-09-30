// Preparation has already consumed qualified inputs; do not invoke the
// development npm script, which can resolve monorepo component siblings.
import { spawnSync } from "node:child_process";
import { loadBuildInputs } from "./build-inputs.mjs";
if (!process.env.NEBULAR_BUILD_INPUTS) throw new Error("Source frontend requires build authority");
await loadBuildInputs(process.env.NEBULAR_BUILD_INPUTS);
for (const args of [["tools/app-preview-prepare.mjs"], ["tools/generate-self-theme.mjs"], ["node_modules/vite/bin/vite.js", "build"]]) {
  const result = spawnSync(process.execPath, args, { stdio: "inherit", timeout: 300_000 });
  if (result.error || result.status !== 0) throw new Error("Source frontend build failed");
}
