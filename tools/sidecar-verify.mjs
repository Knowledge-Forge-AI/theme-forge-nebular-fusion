import { resolve } from "node:path";
import { SIDECAR_NAME, verifyDistribution } from "./sidecar-common.mjs";

const tauriRoot = resolve(import.meta.dirname, "../src-tauri");
try {
  console.log(JSON.stringify(await verifyDistribution({
    binaryPath: resolve(tauriRoot, "binaries", SIDECAR_NAME),
    payloadRoot: resolve(tauriRoot, "sidecar-payload"),
  })));
} catch {
  console.error("TFSB Studio sidecar verification failed");
  process.exitCode = 1;
}
