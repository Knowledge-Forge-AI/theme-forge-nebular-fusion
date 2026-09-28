import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sidecarBinaryName, verifyDistribution } from "./sidecar-common.mjs";
import { loadBuildInputs } from "./build-inputs.mjs";

import { targetForHost } from "./platform-targets.mjs";

export function parseVerificationArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!["--mode", "--build-inputs"].includes(key) || key in result || !value || value.startsWith("--")) {
      throw new Error("Invalid sidecar verification arguments");
    }
    result[key] = value;
  }
  if (Object.keys(result).length && (!result["--build-inputs"] || !["nix-source", "portable-source"].includes(result["--mode"]))) {
    throw new Error("Explicit source mode and build inputs required");
  }
  return { mode: result["--mode"], buildInputsPath: result["--build-inputs"] };
}

export async function verifySidecar(argv, tauriRoot = resolve(import.meta.dirname, "../src-tauri")) {
  const { mode, buildInputsPath } = parseVerificationArguments(argv);
  const authority = buildInputsPath ? await loadBuildInputs(buildInputsPath) : null;
  const target = targetForHost();
  if (authority && (authority.inputs.mode !== mode || authority.target.triple !== target.triple)) throw new Error("Sidecar verification authority mismatch");
  return verifyDistribution({ binaryPath: resolve(tauriRoot, "binaries", sidecarBinaryName(target)),
    payloadRoot: resolve(tauriRoot, "sidecar-payload"), mode, buildInputs: authority?.inputs });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(await verifySidecar(process.argv.slice(2))));
  } catch (error) {
    console.error("TFSB Studio sidecar verification failed:", error.message);
    process.exitCode = 1;
  }
}
