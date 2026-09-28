#!/usr/bin/env node
// @ts-check

import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, resolve, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

import { targetForHost } from "./platform-targets.mjs";
import { repositoryRootForStudio, preparationOptions, prepareSidecar } from "./sidecar-common.mjs";
import { prepareLoom } from "./loom-prepare.mjs";
import { prepareSolarSail } from "./solar-sail-prepare.mjs";
import { prepareScenePayload, sceneBinding } from "./scene-prepare.mjs";
import { generateReleaseNotices } from "./release-notices.mjs";
import { loadBuildInputs, validateBuildInputs } from "./build-inputs.mjs";
import { inventoryTree, digest } from "./candidate-provenance.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_STUDIO_ROOT = resolve(__dirname, "..");

export const PREPARATION_STEPS = Object.freeze([
  "sidecar",
  "loom",
  "solar",
  "scene",
  "release-notices",
]);

/**
 * Resolves the required Scene archive input.
 * Priority:
 * 1. Explicit options (sceneArchive / sceneTarball)
 * 2. Explicit environment variable (TFSB_STUDIO_SCENE_ARCHIVE, TFSB_STUDIO_SCENE_TARBALL, SCENE_ARCHIVE, SCENE_TGZ)
 * 3. Repository authenticated-inputs/stellar-binding.json
 *
 * Throws exact sanitized error if missing or invalid.
 *
 * @param {Record<string, any>} options
 * @param {string} repositoryRoot
 * @returns {string} Absolute path to resolved Scene archive
 */
export function resolveSceneArchive(options = {}, repositoryRoot) {
  // 1. Explicit options
  const explicit = options.sceneArchive ?? options.sceneTarball ?? options["scene-archive"] ?? options["scene-tarball"];
  if (explicit) {
    const resolved = resolve(explicit);
    if (!existsSync(resolved)) {
      throw new Error(`[PREPARE_APP_RESOURCES_FAIL] Explicit Scene archive does not exist: ${basename(resolved)}`);
    }
    return resolved;
  }

  // 2. Explicit environment variable
  const envArchive = process.env.TFSB_STUDIO_SCENE_ARCHIVE
    ?? process.env.TFSB_STUDIO_SCENE_TARBALL
    ?? process.env.SCENE_ARCHIVE
    ?? process.env.SCENE_TGZ;
  if (envArchive) {
    const resolved = resolve(envArchive);
    if (!existsSync(resolved)) {
      throw new Error(`[PREPARE_APP_RESOURCES_FAIL] Explicit Scene archive does not exist: ${basename(resolved)}`);
    }
    return resolved;
  }

  // 3. Resolve via authenticated-inputs/stellar-binding.json
  const authInputsDir = resolve(repositoryRoot, "authenticated-inputs");
  const stellarBindingPath = resolve(authInputsDir, "stellar-binding.json");
  if (existsSync(stellarBindingPath)) {
    let binding;
    try {
      binding = JSON.parse(readFileSync(stellarBindingPath, "utf8"));
    } catch {
      throw new Error("[PREPARE_APP_RESOURCES_FAIL] Malformed stellar-binding.json at authenticated-inputs/stellar-binding.json");
    }
    const sceneRecord = binding.scene;
    if (sceneRecord && typeof sceneRecord === "object") {
      if (sceneRecord.status === "omitted-by-contract") {
        throw new Error("[PREPARE_APP_RESOURCES_FAIL] Scene archive omitted by contract in stellar-binding.json, but Scene payload is required for app resources");
      }
      if (sceneRecord.status !== "included-authenticated"
          || typeof sceneRecord.filename !== "string"
          || !/^[A-Za-z0-9._+-]+\.tgz$/.test(sceneRecord.filename)
          || sceneRecord.sha256 !== sceneBinding.sha256
          || sceneRecord.bytes !== sceneBinding.bytes
          || sceneRecord.sourceTreeDigest !== sceneBinding.sourceTreeDigest) {
        throw new Error("[PREPARE_APP_RESOURCES_FAIL] Scene input binding does not match maintained authority");
      }
      if (sceneRecord.filename) {
        const candidateInSceneDir = resolve(authInputsDir, "scene-tarball", sceneRecord.filename);
        if (existsSync(candidateInSceneDir)) {
          return candidateInSceneDir;
        }
        const candidateInAuthDir = resolve(authInputsDir, sceneRecord.filename);
        if (existsSync(candidateInAuthDir)) {
          return candidateInAuthDir;
        }
      }
    }
  }

  throw new Error("[PREPARE_APP_RESOURCES_FAIL] Missing required Scene archive input: resolve via authenticated-inputs/stellar-binding.json or TFSB_STUDIO_SCENE_ARCHIVE");
}

/**
 * Resolves the authenticated Node runtime binary.
 *
 * @param {Record<string, any>} options
 * @param {string} studioRoot
 * @returns {string | null} Absolute path to resolved Node binary or null
 */
export function resolveNodeBinary(options = {}, studioRoot) {
  const explicit = options.nodePath ?? options.node ?? options["node"];
  if (explicit) {
    const resolved = resolve(explicit);
    if (!existsSync(resolved)) {
      throw new Error(`[PREPARE_APP_RESOURCES_FAIL] Explicit Node binary does not exist: ${basename(resolved)}`);
    }
    return resolved;
  }
  const envNode = process.env.TFSB_STUDIO_NODE_BINARY;
  if (envNode) {
    const resolved = resolve(envNode);
    if (!existsSync(resolved)) {
      throw new Error(`[PREPARE_APP_RESOURCES_FAIL] Explicit Node binary does not exist: ${basename(resolved)}`);
    }
    return resolved;
  }
  return null;
}

/**
 * Parses CLI arguments for prepare-app-resources.
 *
 * @param {string[]} argv
 * @returns {Record<string, any>}
 */
export function parseArgs(argv) {
  /** @type {Record<string, any>} */
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--studio-root" && i + 1 < argv.length) {
      options.studioRoot = argv[++i];
    } else if (arg === "--build-inputs" && i + 1 < argv.length) {
      options.buildInputs = argv[++i];
    } else if (arg === "--repository-root" && i + 1 < argv.length) {
      options.repositoryRoot = argv[++i];
    } else if (arg === "--node" && i + 1 < argv.length) {
      options.nodePath = argv[++i];
    } else if (arg === "--root-tarball" && i + 1 < argv.length) {
      options.rootTarball = argv[++i];
    } else if (arg === "--loom-tarball" && i + 1 < argv.length) {
      options.loomTarball = argv[++i];
    } else if (arg === "--loom-sha256" && i + 1 < argv.length) {
      options.loomSha256 = argv[++i];
    } else if (arg === "--solar-tarball" && i + 1 < argv.length) {
      options.solarTarball = argv[++i];
    } else if (arg === "--scene-archive" && i + 1 < argv.length) {
      options.sceneArchive = argv[++i];
    } else if (arg === "--scene-tarball" && i + 1 < argv.length) {
      options.sceneArchive = argv[++i];
    } else if (arg === "--scene-sha256" && i + 1 < argv.length) {
      options.sceneSha256 = argv[++i];
    } else if (arg === "--release-notices-out-dir" && i + 1 < argv.length) {
      options.releaseNoticesOutDir = argv[++i];
    } else if (arg === "--step" && i + 1 < argv.length) {
      if (!options.steps) options.steps = [];
      options.steps.push(argv[++i]);
    } else if (arg === "--release") {
      options.release = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`[PREPARE_APP_RESOURCES_FAIL] Unknown option: ${arg}`);
    }
  }
  return options;
}

/**
 * Orchestrates preparation of all application resources using maintained tools.
 *
 * @param {Record<string, any>} [options={}]
 * @returns {Promise<{
 *   schema: string,
 *   status: string,
 *   receipts: Record<string, any>,
 *   completedAt: string
 * }>}
 */
/**
 * Resolves build-time Node and packaged runtime Node authorities.
 *
 * For Darwin portable-source:
 * - Packaged runtime MUST be explicit embeddedRuntime.
 * - Main sidecar, Scene, and Loom source-build pins MUST bind packagedRuntimeNodePath.
 * - Build-time Node is used for build operations (e.g. Loom neutral preview compilation).
 *
 * @param {object} authority Validated build inputs authority
 * @returns {{ buildTimeNodePath: string, packagedRuntimeNodePath: string }}
 */
export function resolveRuntimeNodePaths(authority) {
  const isDarwinPortable = authority.inputs.mode === "portable-source" && authority.target.os === "darwin";
  if (isDarwinPortable && !authority.tools.embeddedRuntime) {
    throw new Error("Darwin portable-source preparation requires explicit embeddedRuntime build input");
  }
  const buildTimeNodePath = authority.tools.node;
  const packagedRuntimeNodePath = isDarwinPortable
    ? authority.tools.embeddedRuntime
    : (authority.tools.embeddedRuntime || authority.tools.node);

  return {
    buildTimeNodePath,
    packagedRuntimeNodePath,
  };
}

/**
 * Assembles and strictly validates source-build-pins against the packaged runtime identity.
 *
 * Invariant: Every shipped runtime consumer (sidecar, scene, loom) MUST bind the exact
 * runtime identity that is actually packaged and executed in the bundle.
 *
 * @param {object} params
 * @param {string} params.sourceCandidate
 * @param {string} params.targetTriple
 * @param {object} params.sidecarManifest
 * @param {object} params.sceneReceipt
 * @param {string} params.packagedRuntimeNodePath
 * @param {string} params.loomPayloadDir
 * @param {string} [params.stagedExternalBinPath]
 * @returns {Promise<object>}
 */
export async function assembleSourceBuildPins({
  sourceCandidate,
  targetTriple,
  sidecarManifest,
  sceneReceipt,
  packagedRuntimeNodePath,
  loomPayloadDir,
  stagedExternalBinPath,
}) {
  const packagedRuntimeBytes = readFileSync(packagedRuntimeNodePath);
  const packagedRuntimeSha256 = digest(packagedRuntimeBytes);

  // Invariant 1: sidecarManifest runtime must match packaged runtime
  if (sidecarManifest.runtime.sha256 !== packagedRuntimeSha256 || sidecarManifest.runtime.size !== packagedRuntimeBytes.length) {
    throw new Error(`[SOURCE_BUILD_PIN_INVARIANT_FAIL] sidecarManifest runtime (${sidecarManifest.runtime.sha256}, ${sidecarManifest.runtime.size}B) does not match packaged runtime binary (${packagedRuntimeSha256}, ${packagedRuntimeBytes.length}B)`);
  }

  // Invariant 2: scene source-build pin runtime must match sidecarManifest runtime (size, not undefined bytes)
  if (sceneReceipt.node.sha256 !== sidecarManifest.runtime.sha256 || sceneReceipt.node.bytes !== sidecarManifest.runtime.size) {
    throw new Error(`[SOURCE_BUILD_PIN_INVARIANT_FAIL] scene.node runtime pin (${sceneReceipt.node.sha256}, ${sceneReceipt.node.bytes}B) does not match sidecarManifest runtime (${sidecarManifest.runtime.sha256}, ${sidecarManifest.runtime.size}B)`);
  }

  // Invariant 3: loom source-build pin runtime must match sidecarManifest runtime
  if (packagedRuntimeSha256 !== sidecarManifest.runtime.sha256 || packagedRuntimeBytes.length !== sidecarManifest.runtime.size) {
    throw new Error(`[SOURCE_BUILD_PIN_INVARIANT_FAIL] loom.node runtime pin (${packagedRuntimeSha256}, ${packagedRuntimeBytes.length}B) does not match sidecarManifest runtime (${sidecarManifest.runtime.sha256}, ${sidecarManifest.runtime.size}B)`);
  }

  // Invariant 4: staged externalBin if present must match sidecarManifest runtime
  if (stagedExternalBinPath && existsSync(stagedExternalBinPath)) {
    const stagedBytes = readFileSync(stagedExternalBinPath);
    const stagedSha256 = digest(stagedBytes);
    if (stagedSha256 !== sidecarManifest.runtime.sha256 || stagedBytes.length !== sidecarManifest.runtime.size) {
      throw new Error(`[SOURCE_BUILD_PIN_INVARIANT_FAIL] staged externalBin (${stagedSha256}, ${stagedBytes.length}B) does not match sidecarManifest runtime (${sidecarManifest.runtime.sha256}, ${sidecarManifest.runtime.size}B)`);
    }
  }

  const loomFiles = (await inventoryTree(loomPayloadDir)).files
    .map(({ path, sha256, bytes }) => ({ path, sha256, bytes }));

  return {
    sourceCandidate,
    target: targetTriple,
    sidecarManifest,
    scene: { node: sceneReceipt.node, files: sceneReceipt.files },
    loom: { node: { sha256: packagedRuntimeSha256, bytes: packagedRuntimeBytes.length }, files: loomFiles },
  };
}

export async function prepareAppResources(options = {}) {
  const studioRoot = options.studioRoot ? resolve(options.studioRoot) : DEFAULT_STUDIO_ROOT;
  const repositoryRoot = options.repositoryRoot ? resolve(options.repositoryRoot) : repositoryRootForStudio(studioRoot);
  /** @type {Record<string, any>} */
  const receipts = {};
  const declared = options.buildInputs ?? process.env.NEBULAR_BUILD_INPUTS;
  if (declared) {
    if (options.steps || Object.keys(options).some(key => key.startsWith("skip"))) {
      throw new Error("Source-build preparation requires the complete resource plan");
    }
    const authority = typeof declared === "string" ? await loadBuildInputs(declared) : await validateBuildInputs(declared);
    const { prepareSceneFromSource: importedPrepareScene } = await import("./scene-prepare.mjs");
    const {
      prepareSidecar: doPrepareSidecar = prepareSidecar,
      prepareLoom: doPrepareLoom = prepareLoom,
      prepareSolarSail: doPrepareSolarSail = prepareSolarSail,
      prepareSceneFromSource: doPrepareScene = importedPrepareScene,
      generateReleaseNotices: doGenerateReleaseNotices = generateReleaseNotices,
    } = options._testOverrides || {};

    const { buildTimeNodePath, packagedRuntimeNodePath } = resolveRuntimeNodePaths(authority);

    receipts.sidecar = await doPrepareSidecar({ studioRoot, repositoryRoot: studioRoot,
      nodePath: packagedRuntimeNodePath, sourceIdentity: authority.inputs.source.identity,
      componentRoots: { burst: authority.roots.burst, raster: join(authority.roots.burst, "packages/tfsb-raster-resvg") },
      target: authority.target, release: true, mode: authority.inputs.mode, buildInputs: authority.inputs });
    receipts.loom = await doPrepareLoom({ studioRoot, packageRoot: authority.roots.loom, npmPath: authority.tools.npm, nodePath: buildTimeNodePath, release: true });
    receipts.solarSail = await doPrepareSolarSail({ studioRoot, packageRoot: authority.roots.solar, release: true });
    receipts.scene = await doPrepareScene({ studioRoot, burstRoot: authority.roots.burst,
      node: packagedRuntimeNodePath, destination: join(studioRoot, "src-tauri/scene-payload"), sourceIdentity: authority.inputs.source.identity });

    const sidecarManifest = JSON.parse(readFileSync(join(studioRoot, "src-tauri/sidecar-payload/manifest.json"), "utf8"));
    const stagedExternalBin = join(studioRoot, "src-tauri/binaries", `tfsb-studio-service-${authority.target.triple}`);

    const pins = await assembleSourceBuildPins({
      sourceCandidate: authority.inputs.source.identity,
      targetTriple: authority.target.triple,
      sidecarManifest,
      sceneReceipt: receipts.scene,
      packagedRuntimeNodePath,
      loomPayloadDir: join(studioRoot, "src-tauri/loom-payload"),
      stagedExternalBinPath: stagedExternalBin,
    });

    await writeFile(join(studioRoot, "src-tauri/source-build-pins.json"), JSON.stringify(pins) + "\n", { flag: "wx" });
    receipts.releaseNotices = await doGenerateReleaseNotices({ studioRoot, outDir: join(studioRoot, "src-tauri/release-notices"), failOnMissing: true });
    return { schema: "nebular-prepared-source-resources-v1", status: "pass", buildInputs: authority.identity, receipts };
  }
  if (options.release || ["nix-source", "portable-source"].includes(process.env.NEBULAR_BUILD_MODE)) {
    throw new Error("Release/source preparation requires explicit --build-inputs authority");
  }

  const selectedSteps = options.steps ? new Set(options.steps) : null;
  const shouldRun = (step) => {
    if (selectedSteps) return selectedSteps.has(step);
    if (step === "sidecar" && options.skipSidecar) return false;
    if (step === "loom" && options.skipLoom) return false;
    if (step === "solar" && options.skipSolar) return false;
    if (step === "scene" && options.skipScene) return false;
    if (step === "release-notices" && options.skipReleaseNotices) return false;
    return true;
  };

  // 1. Sidecar Step
  if (shouldRun("sidecar")) {
    console.log("Preparing sidecar payload and binary...");
    const sidecarArgv = [];
    const nodeArg = options.nodePath ?? options.node ?? process.env.TFSB_STUDIO_NODE_BINARY;
    if (!nodeArg) throw new Error("[PREPARE_APP_RESOURCES_FAIL] Missing authenticated Node runtime: TFSB_STUDIO_NODE_BINARY");
    if (nodeArg) {
      sidecarArgv.push("--node", resolve(nodeArg));
    }
    const rootTarballArg = options.rootTarball ?? options["root-tarball"];
    if (rootTarballArg) {
      sidecarArgv.push("--root-tarball", resolve(rootTarballArg));
    }
    const sidecarOpts = preparationOptions(sidecarArgv, repositoryRoot);
    receipts.sidecar = await prepareSidecar(sidecarOpts);
  }

  // 2. Loom Step
  if (shouldRun("loom")) {
    console.log("Preparing Loom payload and preview...");
    receipts.loom = await prepareLoom({
      studioRoot,
      tarball: options.loomTarball ?? options["loom-tarball"],
      sha256: options.loomSha256 ?? options["loom-sha256"],
      release: options.release,
    });
  }

  // 3. Solar Step
  if (shouldRun("solar")) {
    console.log("Preparing Solar Sail payload...");
    receipts.solarSail = await prepareSolarSail({
      studioRoot,
      tarball: options.solarTarball ?? options["solar-tarball"] ?? options.tarball,
      payloadRoot: options.solarSailPayload ?? options["solar-sail-payload"],
      adapterDir: options.solarSailAdapter ?? options["solar-sail-adapter"],
    });
  }

  // 4. Scene Step (MANDATORY)
  if (shouldRun("scene")) {
    console.log("Preparing Scene payload...");
    const sceneArchive = resolveSceneArchive(options, repositoryRoot);
    const nodeBinary = resolveNodeBinary(options, studioRoot);
    if (!nodeBinary) {
      throw new Error("[PREPARE_APP_RESOURCES_FAIL] Missing required Node runtime input: specify via --node or TFSB_STUDIO_NODE_BINARY");
    }
    const destination = options.scenePayload ? resolve(options.scenePayload) : resolve(studioRoot, "src-tauri/scene-payload");
    receipts.scene = await prepareScenePayload({
      archive: sceneArchive,
      node: nodeBinary,
      destination,
      binding: options.sceneBinding ?? sceneBinding,
      expectedSha256: options.sceneSha256 ?? options["scene-sha256"],
    });
  }

  // 5. Release Notices Step
  if (shouldRun("release-notices")) {
    console.log("Generating release notices...");
    const outDir = options.releaseNoticesOutDir ? resolve(options.releaseNoticesOutDir) : resolve(studioRoot, "src-tauri/release-notices");
    receipts.releaseNotices = await generateReleaseNotices({
      studioRoot,
      outDir,
      allowExternalOutDir: true,
      failOnMissing: options.failOnMissing !== false,
    });
  }

  console.log("App resources preparation complete.");
  return {
    schema: "tfsb.prepared-app-resources-v1",
    status: PREPARATION_STEPS.every(shouldRun) ? "pass" : "partial",
    receipts,
    completedAt: new Date().toISOString(),
  };
}

const invokedDirectly = process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node prepare-app-resources.mjs [options]");
    console.log("Options:");
    console.log("  --studio-root <path>             Studio root directory");
    console.log("  --repository-root <path>         Repository root directory");
    console.log("  --node <path>                    Authenticated Node binary");
    console.log("  --root-tarball <path>            Root core tarball");
    console.log("  --loom-tarball <path>            Loom tarball");
    console.log("  --loom-sha256 <hash>             Loom expected SHA-256");
    console.log("  --solar-tarball <path>           Solar Sail tarball");
    console.log("  --scene-archive <path>           Scene archive tarball");
    console.log("  --scene-sha256 <hash>            Scene archive expected SHA-256");
    console.log("  --release-notices-out-dir <path>  Release notices output directory");
    console.log("  --step <step>                    Specific step to execute");
    console.log("  --release                        Run in release mode");
    process.exit(0);
  }
  prepareAppResources(options)
    .then((receipt) => {
      console.log(JSON.stringify(receipt, null, 2));
    })
    .catch((err) => {
      console.error("FATAL:", err.message);
      process.exit(1);
    });
}
