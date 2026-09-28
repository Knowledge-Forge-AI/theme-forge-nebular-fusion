import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyDistribution } from "./sidecar-common.mjs";
import { runSidecarSession } from "./sidecar-transcript.mjs";
import { validateDarwinLinkage, validateLinuxLinkage } from "./darwin-linkage-validator.mjs";

/**
 * Validates a packaged sidecar's integrity, dynamic linkage, and runtime JSON-RPC execution.
 *
 * @param {object} options
 * @param {string} [options.appPath] Path to .app bundle or payload directory
 * @param {string} [options.binaryPath] Direct path to sidecar binary
 * @param {string} [options.payloadRoot] Direct path to sidecar payload root
 * @param {string} [options.entrypointPath] Direct path to server-cli.js entrypoint
 * @param {string} [options.targetSystem="aarch64-darwin"] Target system triple/system
 * @param {boolean} [options.testOnlyAllowNonProductionIdentity=false]
 */
export async function runPackagedSidecarSmoke(options = {}) {
  let {
    appPath,
    binaryPath,
    payloadRoot,
    entrypointPath,
    targetSystem = "aarch64-darwin",
    testOnlyAllowNonProductionIdentity = false,
  } = options;

  if (appPath) {
    const resolvedApp = resolve(appPath);
    if (!existsSync(resolvedApp)) {
      throw new Error(`Target app bundle or directory does not exist: ${resolvedApp}`);
    }

    if (resolvedApp.endsWith(".app") || existsSync(join(resolvedApp, "Contents/MacOS"))) {
      binaryPath = join(resolvedApp, "Contents/MacOS/tfsb-studio-service");
      payloadRoot = join(resolvedApp, "Contents/Resources/sidecar-payload");
      entrypointPath = join(payloadRoot, "dist/service-protocol/server-cli.js");
    } else if (existsSync(join(resolvedApp, "Theme Forge Nebular Fusion.app"))) {
      const innerApp = join(resolvedApp, "Theme Forge Nebular Fusion.app");
      binaryPath = join(innerApp, "Contents/MacOS/tfsb-studio-service");
      payloadRoot = join(innerApp, "Contents/Resources/sidecar-payload");
      entrypointPath = join(payloadRoot, "dist/service-protocol/server-cli.js");
    } else if (existsSync(join(resolvedApp, "payload/Theme Forge Nebular Fusion.app"))) {
      const innerApp = join(resolvedApp, "payload/Theme Forge Nebular Fusion.app");
      binaryPath = join(innerApp, "Contents/MacOS/tfsb-studio-service");
      payloadRoot = join(innerApp, "Contents/Resources/sidecar-payload");
      entrypointPath = join(payloadRoot, "dist/service-protocol/server-cli.js");
    } else if (existsSync(join(resolvedApp, "bin/tfsb-studio-service"))) {
      binaryPath = join(resolvedApp, "bin/tfsb-studio-service");
      payloadRoot = join(resolvedApp, "lib/theme-forge-nebular-fusion/sidecar-payload");
      entrypointPath = join(payloadRoot, "dist/service-protocol/server-cli.js");
    } else if (existsSync(join(resolvedApp, "payload/bin/tfsb-studio-service"))) {
      binaryPath = join(resolvedApp, "payload/bin/tfsb-studio-service");
      payloadRoot = join(resolvedApp, "payload/lib/theme-forge-nebular-fusion/sidecar-payload");
      entrypointPath = join(payloadRoot, "dist/service-protocol/server-cli.js");
    } else {
      throw new Error(`Unable to locate sidecar binary and payload in ${resolvedApp}`);
    }
  }

  if (!binaryPath || !payloadRoot) {
    throw new Error("Both binaryPath and payloadRoot (or appPath) are required");
  }

  const resolvedBinary = resolve(binaryPath);
  const resolvedPayload = resolve(payloadRoot);
  const resolvedEntrypoint = entrypointPath ? resolve(entrypointPath) : join(resolvedPayload, "dist/service-protocol/server-cli.js");

  if (!existsSync(resolvedBinary)) {
    throw new Error(`Sidecar binary does not exist at ${resolvedBinary}`);
  }
  if (!existsSync(resolvedPayload)) {
    throw new Error(`Sidecar payload root does not exist at ${resolvedPayload}`);
  }

  // 1. Dynamic linkage validation (target-appropriate)
  const isDarwinTarget = targetSystem.includes("darwin") || targetSystem.startsWith("aarch64-apple-darwin") || targetSystem.startsWith("x86_64-apple-darwin");
  const isLinuxTarget = targetSystem.includes("linux") || targetSystem.includes("linux-gnu");

  let linkageResult = null;
  if (isDarwinTarget) {
    linkageResult = validateDarwinLinkage(resolvedBinary);
    if (!linkageResult.valid) {
      throw new Error(`Sidecar dynamic linkage validation failed: ${linkageResult.violations.join("; ")}`);
    }
  } else if (isLinuxTarget) {
    linkageResult = validateLinuxLinkage(resolvedBinary);
    if (!linkageResult.valid) {
      throw new Error(`Linux sidecar dynamic linkage validation failed: ${linkageResult.violations.join("; ")}`);
    }
  }

  // 2. Distribution verification (manifest, digests, file tree)
  await verifyDistribution({
    binaryPath: resolvedBinary,
    payloadRoot: resolvedPayload,
    testOnlyAllowNonProductionIdentity,
  });

  // 3. Process execution and JSON-RPC session handshake (if running on matching host platform)
  let sessionResult = null;
  let status = "passed";
  let statusReason = null;

  const isHostExecutable = (process.platform === "darwin" && (targetSystem === "aarch64-darwin" || targetSystem === "darwin-arm64" || targetSystem === "aarch64-apple-darwin") && process.arch === "arm64");
  if (isHostExecutable) {
    sessionResult = await runSidecarSession({
      binaryPath: resolvedBinary,
      payloadRoot: resolvedPayload,
      entrypointPath: resolvedEntrypoint,
      version: "1.2",
    });
    status = "passed";
  } else {
    status = "incomplete";
    statusReason = `Target system ${targetSystem} is not host-executable on ${process.platform}/${process.arch}; runtime execution session deferred`;
  }

  return {
    schema: "tfsb.packaged-sidecar-smoke-v1",
    status,
    ...(statusReason ? { statusReason } : {}),
    targetSystem,
    binaryPath: resolvedBinary,
    payloadRoot: resolvedPayload,
    entrypointPath: resolvedEntrypoint,
    linkageValidation: linkageResult,
    distributionVerified: true,
    sessionExecuted: Boolean(sessionResult),
    sessionResult,
  };
}

export async function main(args = process.argv.slice(2)) {
  const appIdx = args.indexOf("--app");
  const appPath = appIdx !== -1 ? args[appIdx + 1] : null;
  const binIdx = args.indexOf("--binary");
  const binaryPath = binIdx !== -1 ? args[binIdx + 1] : null;
  const payloadIdx = args.indexOf("--payload");
  const payloadRoot = payloadIdx !== -1 ? args[payloadIdx + 1] : null;
  const targetIdx = args.indexOf("--target");
  const targetSystem = targetIdx !== -1 ? args[targetIdx + 1] : "aarch64-darwin";

  if (!appPath && (!binaryPath || !payloadRoot)) {
    console.error("Usage: packaged-sidecar-smoke.mjs (--app <path> | --binary <path> --payload <path>) [--target <system>]");
    process.exitCode = 1;
    return;
  }

  const result = await runPackagedSidecarSmoke({
    appPath,
    binaryPath,
    payloadRoot,
    targetSystem,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(`Packaged sidecar smoke failed: ${err.message}`);
    process.exitCode = 1;
  });
}
