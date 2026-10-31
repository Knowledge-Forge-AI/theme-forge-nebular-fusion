#!/usr/bin/env node
// @ts-check

import { constants as fsConstants, existsSync, lstatSync, readFileSync } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve, join, basename, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { targetForHost } from "./platform-targets.mjs";
import { repositoryRootForStudio, preparationOptions, prepareSidecar } from "./sidecar-common.mjs";
import { prepareLoom } from "./loom-prepare.mjs";
import { prepareSolarSail, validateSolarSailBuildPin } from "./solar-sail-prepare.mjs";
import { prepareScenePayload, sceneBinding, validateStructuredSceneBinding } from "./scene-prepare.mjs";
import { generateReleaseNotices } from "./release-notices.mjs";
import { loadBuildInputs, validateBuildInputs } from "./build-inputs.mjs";
import { canonical, identity, inventoryTree, digest } from "./candidate-provenance.mjs";

// Preview members are opened before leaf metadata is trusted.  O_NONBLOCK is
// required so a non-regular replacement cannot turn a bounded preview read
// into a FIFO wait; the existing ancestor and full-9 identity checks remain.
const PREVIEW_REGULAR_READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_STUDIO_ROOT = resolve(__dirname, "..");

/**
 * `validateBuildInputs` returns the frozen target record selected by
 * `targetForTriple`. Derive the shared shape from the maintained target
 * resolver rather than narrowing it to the fields used by one caller.
 *
 * @typedef {ReturnType<typeof targetForHost>} PlatformTarget
 */

/** @typedef {"sidecar" | "loom" | "solar" | "scene" | "release-notices"} PreparationStep */

/**
 * @typedef {object} BuildInputComponent
 * @property {string} root
 * @property {string} source
 * @property {string} target
 * @property {string} version
 * @property {string} output
 * @property {string} producer
 */

/**
 * @typedef {object} BuildInputTool
 * @property {string} path
 * @property {string} identity
 * @property {{path: string, identity: string}} [npm]
 */

/**
 * The serialized authority consumed by validateBuildInputs. The validator
 * returns the corresponding BuildInputAuthority below after resolving these
 * locators and authenticating their bytes.
 *
 * @typedef {object} BuildInputsDocument
 * @property {"nebular-build-inputs-v1"} schema
 * @property {string} sourceRoot
 * @property {{identity: string, components: Record<string, string>, version: string}} source
 * @property {string} target
 * @property {"portable-source" | "nix-source"} mode
 * @property {Record<string, BuildInputComponent>} components
 * @property {Record<string, BuildInputTool>} toolchains
 * @property {Record<string, unknown>} settings
 * @property {Record<string, string>} [dependencies]
 * @property {import("./build-inputs.mjs").BuildExecution} [execution]
 * @property {{path: string, identity: string}} [embeddedRuntime]
 */

/**
 * @typedef {object} BuildInputAuthority
 * @property {BuildInputsDocument} inputs
 * @property {Record<string, unknown>} claims
 * @property {string} identity
 * @property {{burst: string, loom: string, solar: string}} roots
 * @property {{node: string, npm: string, embeddedRuntime?: string}} tools
 * @property {PlatformTarget} target
 */

/**
 * The narrow authority surface used by resolveRuntimeNodePaths. A validated
 * BuildInputAuthority is assignable to this view; the narrow view also keeps
 * unit fixtures focused on the runtime-selection contract.
 *
 * @typedef {object} RuntimeNodeAuthority
 * @property {{mode: string}} inputs
 * @property {PlatformTarget} target
 * @property {{node: string, embeddedRuntime?: string}} tools
 */

/** @typedef {{sha256: string, size?: number, bytes?: number, target?: string, version?: string}} RuntimeIdentity */
/** @typedef {{version: string, target: string, sha256: string, bytes: number}} SceneRuntimePin */
/** @typedef {{path: string, sha256: string, bytes: number}} SceneFileRecord */

/** @typedef {import("./scene-prepare.mjs").SceneBindingInput} SceneReceipt */

/** @typedef {{schema: string, engineSchema: string, capability: string, compatibility: number, compilerLevel: number, metadataVersion: string, sha256: string, bytes: number, sourceTreeDigest: string, sourceIdentity: string, runtime: SceneRuntimePin, node: SceneRuntimePin, adapterSha256: string, files: SceneFileRecord[], inventory: SceneFileRecord[], fileCount: number}} ValidatedSceneReceipt */

/** @typedef {Record<string, unknown> & {runtime: {sha256: string, size: number}}} SidecarManifest */

/**
 * @typedef {object} SolarComponent
 * @property {string} [name]
 * @property {string} [target]
 * @property {string} [source]
 * @property {string} [output]
 * @property {string} [producer]
 * @property {string} [version]
 */

/** @typedef {{sourceCandidate: string, componentSource: string, output: string, producer: string, version: string}} StructuredSourceProvenance */
/** @typedef {{name: string, version: string, size: number, sha256: string}} PublishedArchiveProvenance */
/** @typedef {{structuredSource: StructuredSourceProvenance} | {publishedArchive: PublishedArchiveProvenance}} SolarSailProvenance */

/**
 * @typedef {object} SolarSailBuildPin
 * @property {string} schema
 * @property {string} target
 * @property {{name: string, version: string, packageJsonSha256: string}} package
 * @property {{size: number, sha256: string, inventoryDigest: string, memberCount: number}} binding
 * @property {SolarSailProvenance} provenance
 */

/** @typedef {Record<string, unknown> & {schema?: string, version?: string, runtimeMemberCount?: number}} ResourceReceipt */

/**
 * @typedef {object} PreparationReceipts
 * @property {ResourceReceipt | undefined} [sidecar]
 * @property {ResourceReceipt | undefined} [loom]
 * @property {(ResourceReceipt & {version?: string, runtimeMemberCount?: number}) | undefined} [solarSail]
 * @property {ResourceReceipt | undefined} [scene]
 * @property {ResourceReceipt | undefined} [releaseNotices]
 */

/**
 * @typedef {object} PreparationReceipt
 * @property {string} schema
 * @property {"pass" | "partial"} status
 * @property {PreparationReceipts} receipts
 * @property {string} [buildInputs]
 * @property {string} [completedAt]
 */

/** @typedef {{sourceCandidate: string, target: string, sidecarManifest: SidecarManifest, scene: SceneReceipt, loom: {node: {sha256: string, bytes: number}, files: SceneFileRecord[]}, solar?: SolarSailBuildPin}} SourceBuildPins */

/**
 * @typedef {object} SceneSourcePreparationOptions
 * @property {string} studioRoot
 * @property {string} burstRoot
 * @property {string} node
 * @property {string} destination
 * @property {string} sourceIdentity
 */

/**
 * @typedef {object} SolarPreparationOptions
 * @property {string} [studioRoot]
 * @property {string} [packageRoot]
 * @property {string} [target]
 * @property {string} [tarball]
 * @property {string} [payloadRoot]
 * @property {string} [adapterDir]
 * @property {string} [buildPinPath]
 * @property {boolean} [release]
 * @property {Record<string, unknown>} [sourceAuthority]
 */

/**
 * @typedef {ResourceReceipt & {binding?: ResourceReceipt, buildPin?: SolarSailBuildPin}} SolarPreparationResult
 */

/**
 * @typedef {object} PrepareAppResourceOverrides
 * @property {typeof prepareSidecar} [prepareSidecar]
 * @property {typeof prepareLoom} [prepareLoom]
 * @property {(options: SolarPreparationOptions) => Promise<SolarPreparationResult>} [prepareSolarSail]
 * @property {(options: SceneSourcePreparationOptions) => Promise<SceneReceipt>} [prepareSceneFromSource]
 * @property {typeof generateReleaseNotices} [generateReleaseNotices]
 */

/**
 * Handoff emitted only by native-candidate-build after the maintained
 * prepared-preview admission and staging checks have passed. The path is
 * deliberately the child-local staged path, never the detached origin.
 *
 * @typedef {object} PreparedPreviewHandoff
 * @property {"nebular-prepared-preview-build-handoff-v1"} schema
 * @property {string} previewDist
 * @property {string} authorityIdentity
 * @property {string} sourceIdentity
 * @property {string} manifestSha256
 * @property {string} originSourceCandidate
 * @property {string} originOutputIdentity
 * @property {string} currentSourceCandidate
 * @property {string} target
 * @property {string} effectiveInputIdentity
 * @property {string} neutralIdentity
 */

/**
 * @typedef {object} PrepareAppResourcesBaseOptions
 * @property {string} [studioRoot]
 * @property {string} [repositoryRoot]
 * @property {string | BuildInputsDocument} [buildInputs]
 * @property {string[]} [steps]
 * @property {boolean} [skipSidecar]
 * @property {boolean} [skipLoom]
 * @property {boolean} [skipSolar]
 * @property {boolean} [skipScene]
 * @property {boolean} [skipReleaseNotices]
 * @property {string} [nodePath]
 * @property {string} [node]
 * @property {string} [rootTarball]
 * @property {string} [loomTarball]
 * @property {string} [loomSha256]
 * @property {string} [solarTarball]
 * @property {string} [tarball]
 * @property {string} [solarSailPayload]
 * @property {string} [solarSailAdapter]
 * @property {string} [solarSailBuildPin]
 * @property {string} [sceneArchive]
 * @property {string} [sceneTarball]
 * @property {string} [sceneSha256]
 * @property {string} [scenePayload]
 * @property {SceneReceipt} [sceneBinding]
 * @property {string} [releaseNoticesOutDir]
 * @property {string} [target]
 * @property {boolean} [release]
 * @property {boolean} [failOnMissing]
 * @property {boolean} [help]
 * @property {PreparedPreviewHandoff} [preparedPreview]
 * @property {PrepareAppResourceOverrides} [_testOverrides]
 */

/** @typedef {Partial<Record<"root-tarball" | "loom-tarball" | "loom-sha256" | "solar-tarball" | "solar-sail-payload" | "solar-sail-adapter" | "solar-sail-build-pin" | "scene-archive" | "scene-tarball" | "scene-sha256", string>>} PrepareAppResourceAliases */
/** @typedef {PrepareAppResourcesBaseOptions & PrepareAppResourceAliases} PrepareAppResourcesOptions */

const PREPARED_PREVIEW_HANDOFF_SCHEMA = "nebular-prepared-preview-build-handoff-v1";
const HEX_DIGEST = /^[a-f0-9]{64}$/;

/**
 * Parse the closed child-to-build-app handoff. Native admission remains the
 * authority for the heavy inventory/full9 checks; this parser prevents an
 * ambient or partial environment value from selecting a different path.
 * @param {string | undefined} raw
 * @returns {PreparedPreviewHandoff | undefined}
 */
export function parsePreparedPreviewHandoff(raw) {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("Prepared preview handoff must be a non-empty JSON object");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Malformed prepared preview handoff JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Prepared preview handoff must be a JSON object");
  }
  const expectedKeys = [
    "authorityIdentity", "currentSourceCandidate", "effectiveInputIdentity", "manifestSha256",
    "neutralIdentity", "originOutputIdentity", "originSourceCandidate", "previewDist",
    "schema", "sourceIdentity", "target",
  ];
  const actualKeys = Object.keys(parsed).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, i) => key !== expectedKeys[i])) {
    throw new Error("Prepared preview handoff keys differ from the closed contract");
  }
  for (const key of expectedKeys) {
    if (typeof parsed[key] !== "string" || parsed[key].length === 0) {
      throw new Error(`Prepared preview handoff field ${key} must be a non-empty string`);
    }
  }
  if (parsed.schema !== PREPARED_PREVIEW_HANDOFF_SCHEMA) {
    throw new Error("Unsupported prepared preview handoff schema");
  }
  for (const key of ["authorityIdentity", "sourceIdentity", "manifestSha256", "originOutputIdentity", "effectiveInputIdentity", "neutralIdentity"]) {
    if (!HEX_DIGEST.test(parsed[key])) throw new Error(`Prepared preview handoff field ${key} is not a SHA-256 identity`);
  }
  return /** @type {PreparedPreviewHandoff} */ (parsed);
}

/**
 * Bind the handoff to the loaded source authority and the exact staged path.
 * @param {PreparedPreviewHandoff} handoff
 * @param {{studioRoot: string, authority: BuildInputAuthority}} context
 * @returns {void}
 */
export function validatePreparedPreviewHandoff(handoff, { studioRoot, authority }) {
  if (authority.target.triple !== "aarch64-apple-darwin" || authority.inputs.mode !== "portable-source") {
    throw new Error("Prepared preview handoff requires a Darwin portable-source authority");
  }
  const expectedPreviewDist = resolve(studioRoot, "loom-preview-source/dist/neutral");
  if (resolve(handoff.previewDist) !== expectedPreviewDist) {
    throw new Error("Prepared preview handoff previewDist is not the staged neutral root");
  }
  let previewStat;
  try {
    previewStat = lstatSync(expectedPreviewDist);
  } catch {
    throw new Error("Prepared preview handoff staged neutral root is missing");
  }
  if (!previewStat.isDirectory() || previewStat.isSymbolicLink() || !existsSync(join(expectedPreviewDist, "index.html"))) {
    throw new Error("Prepared preview handoff staged neutral root is not a regular preview directory");
  }
  if (handoff.authorityIdentity !== authority.identity) {
    throw new Error("Prepared preview handoff authority identity mismatch");
  }
  if (handoff.currentSourceCandidate !== authority.inputs.source.identity) {
    throw new Error("Prepared preview handoff current source candidate mismatch");
  }
  if (handoff.target !== authority.target.triple) {
    throw new Error("Prepared preview handoff target mismatch");
  }
  if (handoff.neutralIdentity !== handoff.originOutputIdentity) {
    throw new Error("Prepared preview handoff neutral identity mismatch");
  }
  if (handoff.originSourceCandidate !== EXPECTED_PREVIEW_ORIGIN.sourceCandidate) {
    throw new Error("Prepared preview handoff origin source candidate mismatch");
  }
}

export const PREPARATION_STEPS = /** @type {readonly PreparationStep[]} */ (Object.freeze([
  "sidecar",
  "loom",
  "solar",
  "scene",
  "release-notices",
]));

/**
 * Resolves the required Scene archive input.
 * Priority:
 * 1. Explicit options (sceneArchive / sceneTarball)
 * 2. Explicit environment variable (TFSB_STUDIO_SCENE_ARCHIVE, TFSB_STUDIO_SCENE_TARBALL, SCENE_ARCHIVE, SCENE_TGZ)
 * 3. Repository authenticated-inputs/stellar-binding.json
 *
 * Throws exact sanitized error if missing or invalid.
 *
 * @param {PrepareAppResourcesOptions} options
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
 * @param {PrepareAppResourcesOptions} options
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
 * @returns {PrepareAppResourcesOptions}
 */
export function parseArgs(argv) {
  /** @type {PrepareAppResourcesOptions} */
  const options = {};
  let i = 0;
  /** @param {string} option @returns {string} */
  const nextValue = (option) => {
    const value = argv[i + 1];
    if (value === undefined) {
      throw new Error(`[PREPARE_APP_RESOURCES_FAIL] Unknown option: ${option}`);
    }
    i += 1;
    return value;
  };
  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--studio-root") {
      options.studioRoot = nextValue(arg);
    } else if (arg === "--build-inputs") {
      options.buildInputs = nextValue(arg);
    } else if (arg === "--repository-root") {
      options.repositoryRoot = nextValue(arg);
    } else if (arg === "--node") {
      options.nodePath = nextValue(arg);
    } else if (arg === "--root-tarball") {
      options.rootTarball = nextValue(arg);
    } else if (arg === "--loom-tarball") {
      options.loomTarball = nextValue(arg);
    } else if (arg === "--loom-sha256") {
      options.loomSha256 = nextValue(arg);
    } else if (arg === "--solar-tarball") {
      options.solarTarball = nextValue(arg);
    } else if (arg === "--scene-archive") {
      options.sceneArchive = nextValue(arg);
    } else if (arg === "--scene-tarball") {
      options.sceneArchive = nextValue(arg);
    } else if (arg === "--scene-sha256") {
      options.sceneSha256 = nextValue(arg);
    } else if (arg === "--release-notices-out-dir") {
      options.releaseNoticesOutDir = nextValue(arg);
    } else if (arg === "--step") {
      if (!options.steps) options.steps = [];
      options.steps.push(nextValue(arg));
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
 * Resolves build-time Node and packaged runtime Node authorities.
 *
 * For Darwin portable-source:
 * - Packaged runtime MUST be explicit embeddedRuntime.
 * - Main sidecar, Scene, and Loom source-build pins MUST bind packagedRuntimeNodePath.
 * - Build-time Node is used for build operations (e.g. Loom neutral preview compilation).
 *
 * @param {RuntimeNodeAuthority} authority Validated build inputs authority
 * @returns {{ buildTimeNodePath: string, packagedRuntimeNodePath: string }}
 */
export function resolveRuntimeNodePaths(authority) {
  const isDarwinPortable = authority.inputs.mode === "portable-source" && authority.target.os === "darwin";
  const embeddedRuntime = authority.tools.embeddedRuntime;
  const buildTimeNodePath = authority.tools.node;
  if (isDarwinPortable) {
    if (!embeddedRuntime) {
      throw new Error("Darwin portable-source preparation requires explicit embeddedRuntime build input");
    }
    return { buildTimeNodePath, packagedRuntimeNodePath: embeddedRuntime };
  }
  const packagedRuntimeNodePath = embeddedRuntime || authority.tools.node;

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
 * @param {SidecarManifest} params.sidecarManifest
 * @param {SceneReceipt} params.sceneReceipt
 * @param {string} params.packagedRuntimeNodePath
 * @param {string} params.loomPayloadDir
 * @param {string} [params.stagedExternalBinPath]
 * @param {SolarSailBuildPin} [params.solarPin]
 * @param {SolarComponent} [params.solarComponent]
 * @returns {Promise<SourceBuildPins>}
 */
export async function assembleSourceBuildPins({
  sourceCandidate,
  targetTriple,
  sidecarManifest,
  sceneReceipt,
  packagedRuntimeNodePath,
  loomPayloadDir,
  stagedExternalBinPath,
  solarPin,
  solarComponent,
}) {
  const packagedRuntimeBytes = readFileSync(packagedRuntimeNodePath);
  const packagedRuntimeSha256 = digest(packagedRuntimeBytes);

  // Invariant 1: sidecarManifest runtime must match packaged runtime
  if (sidecarManifest.runtime.sha256 !== packagedRuntimeSha256 || sidecarManifest.runtime.size !== packagedRuntimeBytes.length) {
    throw new Error(`[SOURCE_BUILD_PIN_INVARIANT_FAIL] sidecarManifest runtime (${sidecarManifest.runtime.sha256}, ${sidecarManifest.runtime.size}B) does not match packaged runtime binary (${packagedRuntimeSha256}, ${packagedRuntimeBytes.length}B)`);
  }

  // Invariant 2: scene source-build pin runtime must match sidecarManifest runtime (size, not undefined bytes)
  if (!sceneReceipt || typeof sceneReceipt !== "object" || Array.isArray(sceneReceipt) || !sceneReceipt.node) {
    throw new Error("[SOURCE_BUILD_PIN_INVARIANT_FAIL] source-only preparation requires a complete Scene receipt");
  }
  if (sceneReceipt.node.sha256 !== sidecarManifest.runtime.sha256 || sceneReceipt.node.bytes !== sidecarManifest.runtime.size) {
    throw new Error(`[SOURCE_BUILD_PIN_INVARIANT_FAIL] scene.node runtime pin (${sceneReceipt.node.sha256}, ${sceneReceipt.node.bytes}B) does not match sidecarManifest runtime (${sidecarManifest.runtime.sha256}, ${sidecarManifest.runtime.size}B)`);
  }

  if (typeof sourceCandidate !== "string" || !/^[a-f0-9]{64}$/u.test(sourceCandidate)) {
    throw new Error("[SOURCE_BUILD_PIN_INVARIANT_FAIL] source candidate must be a SHA-256 identity");
  }
  try {
    validateStructuredSceneBinding(sceneReceipt, { sourceCandidate });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`[SOURCE_BUILD_PIN_INVARIANT_FAIL] ${detail}`);
  }
  if (sceneReceipt.node?.target !== targetTriple || sceneReceipt.runtime?.target !== targetTriple) {
    throw new Error("[SOURCE_BUILD_PIN_INVARIANT_FAIL] scene source receipt target does not match aggregate target");
  }
  const sceneReceiptFields = new Set([
    "schema", "engineSchema", "capability", "compatibility", "compilerLevel", "metadataVersion",
    "sha256", "bytes", "sourceTreeDigest", "sourceIdentity", "runtime", "node", "adapterSha256",
    "files", "inventory", "fileCount",
  ]);
  if (Object.keys(sceneReceipt).some((field) => !sceneReceiptFields.has(field))) {
    throw new Error("[SOURCE_BUILD_PIN_INVARIANT_FAIL] Scene receipt contains a non-whitelisted persisted field");
  }
  const validatedSceneReceipt = /** @type {ValidatedSceneReceipt} */ (/** @type {unknown} */ (sceneReceipt));
  /** @param {SceneRuntimePin} runtime */
  const projectSceneRuntime = (runtime) => ({
    version: runtime.version,
    target: runtime.target,
    sha256: runtime.sha256,
    bytes: runtime.bytes,
  });
  /** @param {SceneFileRecord[]} files */
  const projectSceneFiles = (files) => files.map((file) => ({
    path: file.path,
    bytes: file.bytes,
    sha256: file.sha256,
  }));
  const scenePin = {
    schema: validatedSceneReceipt.schema,
    engineSchema: validatedSceneReceipt.engineSchema,
    capability: validatedSceneReceipt.capability,
    compatibility: validatedSceneReceipt.compatibility,
    compilerLevel: validatedSceneReceipt.compilerLevel,
    metadataVersion: validatedSceneReceipt.metadataVersion,
    sha256: validatedSceneReceipt.sha256,
    bytes: validatedSceneReceipt.bytes,
    sourceTreeDigest: validatedSceneReceipt.sourceTreeDigest,
    sourceIdentity: validatedSceneReceipt.sourceIdentity,
    runtime: projectSceneRuntime(validatedSceneReceipt.runtime),
    node: projectSceneRuntime(validatedSceneReceipt.node),
    adapterSha256: validatedSceneReceipt.adapterSha256,
    files: projectSceneFiles(validatedSceneReceipt.files),
    inventory: projectSceneFiles(validatedSceneReceipt.inventory),
    fileCount: validatedSceneReceipt.fileCount,
  };

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

  if (solarPin !== undefined) {
    if (!solarPin) {
      throw new Error("[SOURCE_BUILD_PIN_INVARIANT_FAIL] Missing required solar build pin for source-build-pins.json");
    }
    validateSolarSailBuildPin(solarPin, {
      route: "structured-source",
      target: targetTriple,
      sourceCandidate,
      ...(solarComponent?.source !== undefined ? { componentSource: solarComponent.source } : {}),
      ...(solarComponent?.output !== undefined ? { output: solarComponent.output } : {}),
      ...(solarComponent?.producer !== undefined ? { producer: solarComponent.producer } : {}),
      ...(solarComponent?.version !== undefined ? { version: solarComponent.version } : {}),
    });
  }

  const loomFiles = (await inventoryTree(loomPayloadDir)).files
    .map(({ path, sha256, bytes }) => ({ path, sha256, bytes }));

  return {
    sourceCandidate,
    target: targetTriple,
    sidecarManifest,
    // Preserve the complete maintained Scene receipt. Older callers that only
    // consume scene.node/files continue to see those fields, while structured
    // source verification can bind the candidate, target, runtime and digest.
    scene: scenePin,
    loom: { node: { sha256: packagedRuntimeSha256, bytes: packagedRuntimeBytes.length }, files: loomFiles },
    ...(solarPin ? { solar: solarPin } : {}),
  };
}

/**
 * Orchestrates preparation of all application resources using maintained tools.
 * The source-build route requires a complete validated authority; the legacy
 * route retains its explicit step-selection behavior for development fixtures.
 *
 * @param {PrepareAppResourcesOptions} [options={}]
 * @returns {Promise<PreparationReceipt>}
 */
export async function prepareAppResources(options = {}) {
  const studioRoot = options.studioRoot ? resolve(options.studioRoot) : DEFAULT_STUDIO_ROOT;
  const repositoryRoot = options.repositoryRoot ? resolve(options.repositoryRoot) : repositoryRootForStudio(studioRoot);
  /** @type {PreparationReceipts} */
  const receipts = {};
  const declared = options.buildInputs ?? process.env.NEBULAR_BUILD_INPUTS;
  if (options.preparedPreview && !declared) {
    throw new Error("Prepared preview handoff requires structured build inputs");
  }
  if (declared) {
    if (options.steps || Object.keys(options).some(key => key.startsWith("skip"))) {
      throw new Error("Source-build preparation requires the complete resource plan");
    }
    const validatedAuthority = typeof declared === "string"
      ? await loadBuildInputs(declared)
      : await validateBuildInputs(declared);
    const authority = /** @type {BuildInputAuthority} */ (/** @type {unknown} */ (validatedAuthority));
    if (options.preparedPreview) {
      validatePreparedPreviewHandoff(options.preparedPreview, { studioRoot, authority });
    }
    const sceneModule = await import("./scene-prepare.mjs");
    const importedPrepareScene = /** @type {(options: SceneSourcePreparationOptions) => Promise<SceneReceipt>} */ (
      /** @type {unknown} */ (sceneModule.prepareSceneFromSource));
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
    receipts.loom = await doPrepareLoom({
      studioRoot,
      packageRoot: authority.roots.loom,
      npmPath: authority.tools.npm,
      nodePath: buildTimeNodePath,
      previewModules: authority.inputs.execution?.previewModules,
      previewModulesIdentity: authority.inputs.dependencies?.previewModules,
      release: true,
      ...(options.preparedPreview ? { previewDist: options.preparedPreview.previewDist } : {}),
    });
    const solarComponent = { name: "solar", ...(authority.inputs.components?.solar || {}) };
    const solarResult = await doPrepareSolarSail({
      studioRoot,
      packageRoot: authority.roots.solar,
      release: true,
      sourceAuthority: {
        sourceModel: "source-candidate-v2",
        sourceCandidate: authority.inputs.source.identity,
        target: authority.target.triple,
        component: solarComponent,
      },
    });
    const solarPin = solarResult?.buildPin;
    if (!solarPin) {
      throw new Error("[SOURCE_BUILD_PIN_INVARIANT_FAIL] Missing required solar build pin from prepareSolarSail");
    }
    receipts.solarSail = solarResult.binding ?? solarResult;
    const sceneReceipt = await doPrepareScene({ studioRoot, burstRoot: authority.roots.burst,
      node: packagedRuntimeNodePath, destination: join(studioRoot, "src-tauri/scene-payload"), sourceIdentity: authority.inputs.source.identity });
    receipts.scene = sceneReceipt;

    const sidecarManifest = JSON.parse(readFileSync(join(studioRoot, "src-tauri/sidecar-payload/manifest.json"), "utf8"));
    const stagedExternalBin = join(studioRoot, "src-tauri/binaries", `tfsb-studio-service-${authority.target.triple}`);

    const pins = await assembleSourceBuildPins({
      sourceCandidate: authority.inputs.source.identity,
      targetTriple: authority.target.triple,
      sidecarManifest,
      sceneReceipt,
      packagedRuntimeNodePath,
      loomPayloadDir: join(studioRoot, "src-tauri/loom-payload"),
      stagedExternalBinPath: stagedExternalBin,
      solarPin,
      solarComponent,
    });

    await writeFile(join(studioRoot, "src-tauri/source-build-pins.json"), JSON.stringify(pins) + "\n", { flag: "wx" });
    receipts.releaseNotices = await doGenerateReleaseNotices({ studioRoot, outDir: join(studioRoot, "src-tauri/release-notices"), failOnMissing: true });
    return { schema: "nebular-prepared-source-resources-v1", status: "pass", buildInputs: authority.identity, receipts };
  }
  if (options.release || ["nix-source", "portable-source"].includes(process.env.NEBULAR_BUILD_MODE ?? "")) {
    throw new Error("Release/source preparation requires explicit --build-inputs authority");
  }

  const selectedSteps = options.steps ? new Set(options.steps) : null;
  /** @param {PreparationStep} step */
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
    // The sidecar is prepared for the product target, which build-app takes from the host.
    sidecarArgv.push("--target", options.target ?? targetForHost().triple);
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
    const solarTarball = options.solarTarball ?? options["solar-tarball"] ?? options.tarball;
    const solarPayloadRoot = options.solarSailPayload ?? options["solar-sail-payload"];
    const solarAdapterDir = options.solarSailAdapter ?? options["solar-sail-adapter"];
    const solarBuildPinPath = options.solarSailBuildPin ?? options["solar-sail-build-pin"];
    const solarOptions = {
      studioRoot,
      target: options.target ?? targetForHost().triple,
      ...(solarTarball !== undefined
        ? { tarball: solarTarball }
        : {}),
      ...(solarPayloadRoot !== undefined
        ? { payloadRoot: solarPayloadRoot }
        : {}),
      ...(solarAdapterDir !== undefined
        ? { adapterDir: solarAdapterDir }
        : {}),
      ...(solarBuildPinPath !== undefined
        ? { buildPinPath: solarBuildPinPath }
        : {}),
    };
    const solarResult = await prepareSolarSail(solarOptions);
    receipts.solarSail = solarResult.binding;
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
    const expectedSceneSha256 = options.sceneSha256 ?? options["scene-sha256"];
    const scenePreparationOptions = {
      archive: sceneArchive,
      node: nodeBinary,
      destination,
      binding: options.sceneBinding ?? sceneBinding,
      ...(expectedSceneSha256 !== undefined ? { expectedSha256: expectedSceneSha256 } : {}),
    };
    receipts.scene = await prepareScenePayload(scenePreparationOptions);
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

export const PREPARED_PREVIEW_INPUT_SCHEMA = "nebular-prepared-neutral-preview-input-v1";

export const PREPARED_PREVIEW_LIMITS = Object.freeze({
  allowance: Object.freeze({
    outputByteOrFileOrNodeGrowth: 0,
    sourceBytes: 11712,
    sourceFileOrNodeGrowth: 0,
  }),
  dependencies: Object.freeze({
    aggregateBytes: 250667046,
    files: 11564,
    nodes: 12732,
    perFileBytes: 57617264,
    relativePathBytes: 88,
  }),
  manifestBytes: 1048576,
  neutralOutputPerDomain: Object.freeze({
    aggregateBytes: 911158,
    files: 27,
    nodes: 31,
    perFileBytes: 175488,
    relativePathBytes: 77,
  }),
  outputSetsExact: true,
  recipeFiles: Object.freeze({
    aggregateBytes: 262144,
    files: 5,
    nodes: 5,
    perFileBytes: 65536,
    relativePathBytes: 256,
  }),
  source: Object.freeze({
    aggregateBytes: 262144,
    files: 11,
    nodes: 16,
    perFileBytes: 262144,
    relativePathBytes: 256,
  }),
  sourceSetsExact: true,
  totalPreviewHashBytesAcrossAllPhases: 1073741824,
});

// `public/preview` is the neutral projection plus the source-frontend-owned
// application fixture. Keep the authenticated neutral contract unchanged and
// bound the auxiliary fixture independently instead of widening the neutral
// node/file domain. The current fixture is 5 files / 18,053 bytes.
export const PREPARED_PREVIEW_APP_LIMITS = Object.freeze({
  aggregateBytes: 262144,
  files: 5,
  nodes: 5,
  perFileBytes: 65536,
  relativePathBytes: 64,
});

export const EXPECTED_PREVIEW_APP_MEMBERS = Object.freeze([
  "NOTICE.md",
  "app.css",
  "app.js",
  "index.html",
  "provenance.json",
]);

export const EXPECTED_PREVIEW_ORIGIN = Object.freeze({
  sourceCandidate: "eaeaf90fdc0400cf1e20751d6594b2de8398bea579c2cc1c9a73b645ac6ae0d9",
  sourceHead: "9ffbc28b744e49a9aa1b0fbcbd79587158b44634",
  recoverySha256: "faacb63f46acd858ff75c8494edc2a61f5fe63ae0110e51c23966972e2e8fc40",
  namespaceSha256: "c223d61fe010e46de8854740c58c792ed2832d63ef2c6244a8f7282e55ca549e",
  originalProducerOuterSha256: "84dc877f6bfc5ba291c7d07ecc4fddd0bf97e22009118c75ff6aac1d024b96a1",
  originalProducerChildSha256: "1af81cc0e5086ee558658bb72a1d76eafe1b698c03c2ac99231edd23dfd9fff9",
  sourceBuildPinsSha256: "efe1f4da0c051e2d1bf5bebf2babb52a3738dae3a640c5e3a983781224d8cf06",
});

export const EXPECTED_PREVIEW_SOURCE_DIRS = Object.freeze([
  "src",
  "src/content",
  "src/content/docs",
  "src/styles",
  "test",
]);

export const EXPECTED_PREVIEW_SOURCE_MEMBERS = Object.freeze([
  Object.freeze({ path: "astro.config.mjs", bytes: 6463, mode: 420, sha256: "41bb78d3f45bd9ff8f3d04819c303e12bcdd8dfe9d0902f3aa2921ac2752fa89" }),
  Object.freeze({ path: "package-lock.json", bytes: 206230, mode: 420, sha256: "c1945074e438c9ae1cf394edd7ceeb6ca7a2bd6d9dc25409ecb7d78a12cdc32f" }),
  Object.freeze({ path: "package.json", bytes: 1710, mode: 420, sha256: "0d3bb71b06c0c7c24c296a0caffe898193d56320213758f29f93ba8e41f9c93c" }),
  Object.freeze({ path: "playwright.config.ts", bytes: 1427, mode: 420, sha256: "6f99605596b7725ebcab859732dfa40ef411516a8a46ab16a2474ff9246812ab" }),
  Object.freeze({ path: "src/content.config.ts", bytes: 368, mode: 420, sha256: "fc0e0aad8b063a7d16153c801ab59627d2052c8e7d4ec6a00b328ac766bf9b7d" }),
  Object.freeze({ path: "src/content/docs/index.mdx", bytes: 3880, mode: 420, sha256: "438e24a618ad9304cdf895d435fc10489d5e4bd64d2131f20ada88ad97c4db92" }),
  Object.freeze({ path: "src/styles/neutral.css", bytes: 431, mode: 420, sha256: "56c51814d30c6f9c3c4f4ead8a0ee3fe1f05e415900566f90bd64184abcc0d94" }),
  Object.freeze({ path: "test/amber-forge.spec.ts", bytes: 11500, mode: 420, sha256: "958da4df8da83823616dfcd8dca547cad3ecf010b9a01c8e96ebdffd289147d6" }),
  Object.freeze({ path: "test/stellar-cyan.spec.ts", bytes: 12683, mode: 420, sha256: "b8f139f779788752396075e4503fb9c094e7b81ca7d014ecd5d737f616a232a3" }),
  Object.freeze({ path: "test/style-fidelity.spec.ts", bytes: 5524, mode: 420, sha256: "a1288b023874078da566fb3d1e7b9bd6b415b4d1b27dd44e0d14091ed2651ad5" }),
  Object.freeze({ path: "tsconfig.json", bytes: 216, mode: 420, sha256: "cfaec641e906c9dc5c20b573fe30b9ed15f93803f6ea5d927ade7960ed92dee2" }),
]);

export const EXPECTED_PREVIEW_RECIPE_MEMBERS = Object.freeze([
  Object.freeze({ name: "candidate-provenance.mjs", bytes: 15484, mode: 420, sha256: "20244b6765d6e7d0ee5fd86452096a4546f189103b0acb9f065c4a1479c23155" }),
  Object.freeze({ name: "fs-snapshot.mjs", bytes: 13794, mode: 420, sha256: "30ad6c3f0394126a7d3e5534507fe46c78c34946edd15bd5c91b36e2b36df351" }),
  Object.freeze({ name: "loom-prepare.mjs", bytes: 44127, mode: 420, sha256: "77038ab6c506fe1b350e317cc55fc47f2cffc80b52865e5500f757dbb2e0400a" }),
  Object.freeze({ name: "pagefind-index.mjs", bytes: 7877, mode: 420, sha256: "e89aecdc4b3a9316f7a2c09bbcf1d00dfe62698693b9199a459c1755258a13d4" }),
  Object.freeze({ name: "sidecar-common.mjs", bytes: 81902, mode: 420, sha256: "e0ca4d4a4bba4abd756f1399e31a768a20873eefb6c50ac26a75adddccc1978c" }),
]);

export const EXPECTED_PREVIEW_RECIPE_COMMAND = "node <verified-node_modules>/astro/bin/astro.mjs build";
export const EXPECTED_PREVIEW_RECIPE_SCRIPT = "ASTRO_BASE=/preview TFSL_THEME_CSS=./src/styles/neutral.css ASTRO_OUT_DIR=./dist/neutral astro build";
export const EXPECTED_PREVIEW_RECIPE_ENV = Object.freeze({
  ASTRO_BASE: "/preview",
  ASTRO_OUT_DIR: "./dist/neutral",
  TFSL_INSTRUMENTED_PREVIEW: "0",
  TFSL_THEME_CSS: "./src/styles/neutral.css",
});

export const EXPECTED_PREVIEW_NODE = Object.freeze({
  bytes: 113002944,
  platform: "darwin-arm64",
  sha256: "2cc28a1880d0774616959f2210ee739bffa6ac695c887e8988a496a21271f6c0",
  version: "22.23.4",
});

export const EXPECTED_PREVIEW_DEPENDENCY_IDENTITY = "28bfedc35b94ce5e7aee3869bb8b9d5a5b2dcf27644e90fcb709d3db9486747a";

export const EXPECTED_PREVIEW_OUTPUT_DIRS = Object.freeze([
  "_astro",
  "pagefind",
  "pagefind/fragment",
  "pagefind/index",
]);

export const EXPECTED_PREVIEW_NORMALIZED_OUTPUT = Object.freeze([
  Object.freeze({ path: "404.html", bytes: 16935, mode: 420, sha256: "bc3b429d2fc7ecd01d8369ed76ab4c72ae7f2205b17ea6f8fbb439a4aac3c928" }),
  Object.freeze({ path: "_astro/MobileTableOfContents.astro_astro_type_script_index_0_lang.BcSo_yiZ.js", bytes: 622, mode: 420, sha256: "dd7cc171c64ce739999d62aae6c7052ae2b45ce190713b35cf8919dde04abfd8" }),
  Object.freeze({ path: "_astro/Search.astro_astro_type_script_index_0_lang.C0C_a0Xk.js", bytes: 2960, mode: 420, sha256: "a3bd4c1273395eec5ac7f81a2cf25d1ff1b621f916e43cfcc456cca194891669" }),
  Object.freeze({ path: "_astro/TableOfContents.astro_astro_type_script_index_0_lang.Csloo1VZ.js", bytes: 36, mode: 420, sha256: "f1c9743eceea19c4cada60524019ee9214c22a257a35bdfd184e85f9006264c0" }),
  Object.freeze({ path: "_astro/common.tH-o6yci.css", bytes: 64062, mode: 420, sha256: "5202b953ce6adb075ccb0ae7c5693af4cfac0bca234db07c294ce673c7826ca4" }),
  Object.freeze({ path: "_astro/ec.0vx5m.js", bytes: 2523, mode: 420, sha256: "182e98b9acfcfd358ea486967bd17dcaddd5930b8d092bc0653fd26ddbb11e37" }),
  Object.freeze({ path: "_astro/ec.w36nc.css", bytes: 18292, mode: 420, sha256: "1db272cd2e2bc5dfbc63c332f5d5f04bb4ba104065e894f951405e7bdddf5dcb" }),
  Object.freeze({ path: "_astro/page.Dwipeu-R.js", bytes: 2486, mode: 420, sha256: "c99ac0eaf0068f03b4abe3a28b0a7bf0f28524b9dad3b23d77d54dfd453a62ae" }),
  Object.freeze({ path: "_astro/print.ehPL0gv-.css", bytes: 3318, mode: 420, sha256: "4d7d25c3d697e6d36e64afb9edef136e6d2e4c50f70a48000ca90f9b059e3622" }),
  Object.freeze({ path: "_astro/starlight-toc.CTCQXEge.js", bytes: 1981, mode: 420, sha256: "2a08da9f380dd1395e0072dbd1b35e1e2b0af6072f0e40417865318271f9b342" }),
  Object.freeze({ path: "_astro/ui-core.CWY5S9Ti.js", bytes: 93823, mode: 420, sha256: "9e2658146ef594311dcebc70267cb69df12960869364d5cad343afab818eba79" }),
  Object.freeze({ path: "index.html", bytes: 53730, mode: 420, sha256: "8defe008f67ad6e3bebfef582f8eff6b33717d02a1af84d81227d444b0c027b0" }),
  Object.freeze({ path: "pagefind/fragment/en_263dd58.pf_fragment", bytes: 1875, mode: 420, sha256: "630ad0907ef6490fe3510c4457f7a1d7579ed7a4cf74407dfc0ea7f18a9e9798" }),
  Object.freeze({ path: "pagefind/index/en_1016229.pf_index", bytes: 2392, mode: 420, sha256: "c80d041e0dfdb517eaf2fc90b7f6c2a2aecf1d4daa6886c83d5f5b7426b260b6" }),
  Object.freeze({ path: "pagefind/pagefind-component-ui.css", bytes: 41830, mode: 420, sha256: "de389c7e5d87d6e2b10d65fb1e36e8989a12a2ad8dd6239b7e070d81fb5d8b0d" }),
  Object.freeze({ path: "pagefind/pagefind-component-ui.js", bytes: 175488, mode: 420, sha256: "958620129dd14bd851805daeb12ce708bd63b9287325d1d5ae6f73a04d1723f8" }),
  Object.freeze({ path: "pagefind/pagefind-entry.json", bytes: 171, mode: 420, sha256: "0da576714a701bd250deab8920b46b0d3eefa48944824d05cbe437493144d4ce" }),
  Object.freeze({ path: "pagefind/pagefind-highlight.js", bytes: 44352, mode: 420, sha256: "04741266a86911636cefc41c8b407e380dda99b7d208724f700f94cdf57e37b5" }),
  Object.freeze({ path: "pagefind/pagefind-modular-ui.css", bytes: 7336, mode: 420, sha256: "653ab29e4de5629f6ddf5f6fcdf5d2b3eb539a8c07fff8a56b8ce2156a570788" }),
  Object.freeze({ path: "pagefind/pagefind-modular-ui.js", bytes: 14634, mode: 420, sha256: "f3efa0f74b305ccab0bc9edc7c09ab69867180b4c43093d84bb9b508ac4ec32c" }),
  Object.freeze({ path: "pagefind/pagefind-ui.css", bytes: 14482, mode: 420, sha256: "e113b816110ed07b017613e901addfe635350f2a5b84990aa76c91a74b158084" }),
  Object.freeze({ path: "pagefind/pagefind-ui.js", bytes: 119987, mode: 420, sha256: "2efa93f2e80a199ca742a69bd4cfffabc5c591ebe7763f64f7c655fd00d2209f" }),
  Object.freeze({ path: "pagefind/pagefind-worker.js", bytes: 41255, mode: 420, sha256: "4ca50d25bcab9e1c3afbc00ab5f7761114e83c8fc1b83d38655af1558b650c2a" }),
  Object.freeze({ path: "pagefind/pagefind.en_6c6290b642.pf_meta", bytes: 94, mode: 420, sha256: "a1f5560856dd6bf903977d9f9f96204674daefdfd38e73f46b35c8e481c14876" }),
  Object.freeze({ path: "pagefind/pagefind.js", bytes: 45555, mode: 420, sha256: "252d272bd34d483d19a752060f6a065114d15ab12c42d8f905ca565e2768a009" }),
  Object.freeze({ path: "pagefind/wasm.en.pagefind", bytes: 72740, mode: 420, sha256: "6c8406154b5d460fc8b6cdbf2c99c008c43c465efdb1f9c15c192f5cf30dcd85" }),
  Object.freeze({ path: "pagefind/wasm.unknown.pagefind", bytes: 68199, mode: 420, sha256: "2533da887ac06de36813d031310af0f737daadacc931775e342aa5a3857a4959" }),
]);

export const EXPECTED_PREVIEW_ORIGIN_OUTPUT_IDENTITY = identity(EXPECTED_PREVIEW_NORMALIZED_OUTPUT);

const PREVIEW_HEX64_RE = /^[0-9a-f]{64}$/u;
const PREVIEW_PROTECTED_COMPONENTS = new Set(["db", "raw", ".serena"]);
const PREVIEW_PROTECTED_SUFFIX_RE = /\.(?:db|sqlite|sqlite3)$/iu;

/**
 * @param {number} [maxBytes]
 */
export function createPreviewHashBudget(maxBytes = PREPARED_PREVIEW_LIMITS.totalPreviewHashBytesAcrossAllPhases) {
  let hashedBytes = 0;
  return {
    get hashedBytes() {
      return hashedBytes;
    },
    get maxBytes() {
      return maxBytes;
    },
    /** @param {number} bytes */
    charge(bytes) {
      if (!Number.isInteger(bytes) || bytes < 0) {
        throw new Error(`Invalid preview hash byte charge: ${String(bytes)}`);
      }
      hashedBytes += bytes;
      if (hashedBytes > maxBytes) {
        throw new Error(`Prepared preview cumulative hash budget exceeded (${hashedBytes} > ${maxBytes})`);
      }
    },
  };
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {readonly string[]} exactKeys
 * @returns {asserts value is Record<string, any>}
 */
function assertPreviewClosedObject(value, label, exactKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...exactKeys].sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((k, idx) => k !== expectedKeys[idx])) {
    throw new Error(`${label} keys differ from closed contract`);
  }
}

/**
 * @param {import("node:fs").BigIntStats} st
 */
function previewStatFull9(st) {
  return [
    String(st.dev),
    String(st.ino),
    Number(st.size),
    Number(st.mode),
    String(st.mtimeNs),
    String(st.ctimeNs),
    Number(st.uid),
    Number(st.gid),
    Number(st.nlink),
  ];
}

/**
 * @param {(string|number)[]} a
 * @param {(string|number)[]} b
 */
function previewFull9Equal(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * @param {import("node:fs").BigIntStats} a
 * @param {import("node:fs").BigIntStats} b
 */
function previewDirIdentityEqual(a, b) {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    (Number(a.mode) & 0o7777) === (Number(b.mode) & 0o7777) &&
    a.uid === b.uid &&
    a.gid === b.gid
  );
}

/**
 * @param {string} absPath
 */
async function assertNoSymlinkAncestors(absPath) {
  const resolved = resolve(absPath);
  const parts = resolved.split(sep).filter(Boolean);
  /** @type {string} */
  let current = sep;
  for (const part of parts) {
    if (PREVIEW_PROTECTED_COMPONENTS.has(part.toLowerCase()) || PREVIEW_PROTECTED_SUFFIX_RE.test(part)) {
      throw new Error(`Protected component in path: ${part}`);
    }
    current = join(current, part);
    const st = await lstat(current, { bigint: true });
    if (st.isSymbolicLink()) {
      throw new Error(`Symlink component refused in path: ${current}`);
    }
  }
}

/**
 * Refuses a protected leaf lexically before any leaf lstat or open.  The
 * ancestor walk intentionally excludes the leaf so descriptor-first reads
 * remain the authority for ordinary regular files.
 * @param {string} absPath
 */
function assertProtectedPreviewLeaf(absPath) {
  const leaf = basename(absPath);
  if (PREVIEW_PROTECTED_COMPONENTS.has(leaf.toLowerCase()) || PREVIEW_PROTECTED_SUFFIX_RE.test(leaf)) {
    throw new Error(`Protected component in path: ${leaf}`);
  }
}

/**
 * @param {string} filePath
 * @param {number} maxBytes
 * @param {ReturnType<typeof createPreviewHashBudget>} budget
 * @param {{ requireNonExec?: boolean, requireExec?: boolean, disallowEmpty?: boolean }} [options]
 */
async function readBoundedPreviewRegular(filePath, maxBytes, budget, options = {}) {
  // Ancestors remain path-checked; the leaf is authenticated by the opened FD
  // and its named-path full-9 bookends below.
  assertProtectedPreviewLeaf(filePath);
  await assertNoSymlinkAncestors(dirname(filePath));
  let fh;
  /** @type {(string|number)[] | null} */
  let openedFrame = null;
  try {
    fh = await open(filePath, PREVIEW_REGULAR_READ_FLAGS);
  } catch (error) {
    const fsError = /** @type {NodeJS.ErrnoException} */ (error);
    if (fsError.code === "ELOOP" || fsError.code === "EMLINK") {
      throw new Error(`Expected regular file (not symlink): ${basename(filePath)}`);
    }
    throw error;
  }
  try {
    const opened = await fh.stat({ bigint: true });
    if (!opened.isFile()) {
      throw new Error(`Expected regular file (not symlink): ${basename(filePath)}`);
    }
    if (Number(opened.nlink) !== 1) {
      throw new Error(`Hardlinked regular file refused (nlink=${String(opened.nlink)}): ${basename(filePath)}`);
    }
    if ((Number(opened.mode) & 0o7000) !== 0) {
      throw new Error(`Unexpected privilege bits on regular file: ${basename(filePath)}`);
    }
    const isExec = (Number(opened.mode) & 0o111) !== 0;
    if (options.requireNonExec && isExec) {
      throw new Error(`Unexpected executable bit on non-executable file: ${basename(filePath)}`);
    }
    if (options.requireExec && !isExec) {
      throw new Error(`Expected executable bit on runtime file: ${basename(filePath)}`);
    }
    const size = Number(opened.size);
    const minBytes = options.disallowEmpty ? 1 : 0;
    if (size < minBytes || size > maxBytes) {
      throw new Error(`Regular file size ${size} exceeds limit ${maxBytes}: ${basename(filePath)}`);
    }
    budget.charge(size);
    const beforeFrame = previewStatFull9(opened);
    openedFrame = beforeFrame;
    const namedBefore = await lstat(filePath, { bigint: true });
    if (namedBefore.isSymbolicLink() || !namedBefore.isFile() || !previewFull9Equal(previewStatFull9(namedBefore), beforeFrame)) {
      throw new Error(`Named file drift on open: ${basename(filePath)}`);
    }
    const buf = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await fh.read(buf, offset, size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    const { bytesRead: extraRead } = await fh.read(extra, 0, 1, offset);
    if (offset !== size || extraRead > 0) {
      throw new Error(`Regular file size changed during read: ${basename(filePath)}`);
    }
    const ended = await fh.stat({ bigint: true });
    if (!previewFull9Equal(previewStatFull9(ended), beforeFrame)) {
      throw new Error(`Descriptor drift after read: ${basename(filePath)}`);
    }
    const namedAfterRead = await lstat(filePath, { bigint: true });
    if (namedAfterRead.isSymbolicLink() || !namedAfterRead.isFile() || !previewFull9Equal(previewStatFull9(namedAfterRead), beforeFrame)) {
      throw new Error(`Named file drift after read: ${basename(filePath)}`);
    }
    return {
      bytes: size,
      mode: isExec ? 0o755 : 0o644,
      physicalMode: Number(opened.mode) & 0o777,
      sha256: digest(buf),
      full9: beforeFrame,
      buffer: buf,
    };
  } finally {
    await fh.close();
    const afterNamed = await lstat(filePath, { bigint: true });
    if (openedFrame && (afterNamed.isSymbolicLink() || !afterNamed.isFile() || !previewFull9Equal(previewStatFull9(afterNamed), openedFrame))) {
      throw new Error(`Named file drift after close: ${basename(filePath)}`);
    }
  }
}

/**
 * Bounded metadata prewalk and inventoryTree wrapper enforcing numeric limits and hash budget.
 * @param {string} rootDir
 * @param {{ files: number, nodes: number, aggregateBytes: number, perFileBytes: number, relativePathBytes: number }} domainLimits
 * @param {ReturnType<typeof createPreviewHashBudget>} budget
 * @param {{ exactAggregateBytes?: boolean, expectedDirs?: readonly string[], excludedRootEntries?: readonly string[] }} [options]
 */
export async function inspectBoundedPreviewTree(rootDir, domainLimits, budget, options = {}) {
  const resolvedRoot = resolve(rootDir);
  await assertNoSymlinkAncestors(resolvedRoot);
  const rootBefore = await lstat(resolvedRoot, { bigint: true });
  if (rootBefore.isSymbolicLink() || !rootBefore.isDirectory()) {
    throw new Error(`Expected real directory at ${basename(resolvedRoot)}`);
  }
  if ((Number(rootBefore.mode) & 0o7000) !== 0) {
    throw new Error(`Unexpected privilege bits on directory ${basename(resolvedRoot)}`);
  }

  let files = 0;
  let nodes = 0;
  let aggregateBytes = 0;
  /** @type {string[]} */
  const observedDirs = [];
  /** @type {Map<string, (string|number)[]>} */
  const fileFrames = new Map();
  const excludedRootEntries = new Set(options.excludedRootEntries ?? []);
  for (const excluded of excludedRootEntries) {
    if (excluded !== "app") throw new Error(`Unsupported excluded preview root entry: ${excluded}`);
  }

  /**
   * @param {string} absDir
   * @param {string} relDir
   */
  const walk = async (absDir, relDir) => {
    const dirBefore = await lstat(absDir, { bigint: true });
    if (dirBefore.isSymbolicLink() || !dirBefore.isDirectory()) {
      throw new Error(`Non-directory or symlink in preview tree: ${relDir || "."}`);
    }
    if ((Number(dirBefore.mode) & 0o7000) !== 0) {
      throw new Error(`Unexpected privilege bits on directory: ${relDir || "."}`);
    }
    const entries = await readdir(absDir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (!relDir) {
      const rootNames = new Set(entries.map((entry) => entry.name));
      for (const excluded of excludedRootEntries) {
        if (!rootNames.has(excluded)) {
          throw new Error(`Excluded preview root entry is missing: ${excluded}`);
        }
      }
    }
    const folded = new Set();
    for (const entry of entries) {
      if (
        !entry.name ||
        entry.name === "." ||
        entry.name === ".." ||
        PREVIEW_PROTECTED_COMPONENTS.has(entry.name.toLowerCase()) ||
        PREVIEW_PROTECTED_SUFFIX_RE.test(entry.name)
      ) {
        throw new Error(`Forbidden or protected entry in preview tree: ${entry.name}`);
      }
      const lower = entry.name.toLowerCase();
      if (folded.has(lower)) {
        throw new Error(`Case-colliding entry in preview tree: ${entry.name}`);
      }
      folded.add(lower);
      if (!relDir && excludedRootEntries.has(entry.name)) continue;
      const childRel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (Buffer.byteLength(childRel, "utf8") > domainLimits.relativePathBytes) {
        throw new Error(`Relative path exceeds ${domainLimits.relativePathBytes}-byte ceiling: ${childRel}`);
      }
      nodes += 1;
      if (nodes > domainLimits.nodes) {
        throw new Error(`Preview tree node count exceeds ${domainLimits.nodes} limit`);
      }
      const childAbs = join(absDir, entry.name);
      const st = await lstat(childAbs, { bigint: true });
      if (st.isSymbolicLink()) {
        throw new Error(`Symlink refused in preview tree: ${childRel}`);
      }
      if (st.isDirectory()) {
        observedDirs.push(childRel);
        await walk(childAbs, childRel);
      } else if (st.isFile()) {
        files += 1;
        if (files > domainLimits.files) {
          throw new Error(`Preview tree file count exceeds ${domainLimits.files} limit`);
        }
        if (Number(st.nlink) !== 1) {
          throw new Error(`Hardlinked file refused in preview tree: ${childRel}`);
        }
        if ((Number(st.mode) & 0o7000) !== 0) {
          throw new Error(`Unexpected privilege bits on file in preview tree: ${childRel}`);
        }
        const size = Number(st.size);
        if (size < 0 || size > domainLimits.perFileBytes) {
          throw new Error(`File ${childRel} size ${size} exceeds per-file ceiling ${domainLimits.perFileBytes}`);
        }
        aggregateBytes += size;
        if (aggregateBytes > domainLimits.aggregateBytes) {
          throw new Error(`Preview tree aggregate bytes ${aggregateBytes} exceeds ceiling ${domainLimits.aggregateBytes}`);
        }
        fileFrames.set(childRel, previewStatFull9(st));
      } else {
        throw new Error(`Special file refused in preview tree: ${childRel}`);
      }
    }
    const dirAfter = await lstat(absDir, { bigint: true });
    if (!previewDirIdentityEqual(dirBefore, dirAfter)) {
      throw new Error(`Directory identity drifted during prewalk: ${relDir || "."}`);
    }
  };

  await walk(resolvedRoot, "");

  if (files !== domainLimits.files) {
    throw new Error(`Preview tree file count ${files} does not equal required ${domainLimits.files}`);
  }
  if (nodes !== domainLimits.nodes) {
    throw new Error(`Preview tree node count ${nodes} does not equal required ${domainLimits.nodes}`);
  }
  if (options.exactAggregateBytes && aggregateBytes !== domainLimits.aggregateBytes) {
    throw new Error(`Preview tree aggregate bytes ${aggregateBytes} does not equal required ${domainLimits.aggregateBytes}`);
  }
  if (options.expectedDirs) {
    const sortedDirs = [...observedDirs].sort();
    const expectedSorted = [...options.expectedDirs].sort();
    if (sortedDirs.length !== expectedSorted.length || sortedDirs.some((d, i) => d !== expectedSorted[i])) {
      throw new Error(`Preview tree directory set [${sortedDirs.join(", ")}] does not match required [${expectedSorted.join(", ")}]`);
    }
  }

  budget.charge(aggregateBytes);
  const fullInventory = await inventoryTree(resolvedRoot);
  const excludedRootPrefixes = [...excludedRootEntries].map((entry) => `${entry}/`);
  const includedFiles = fullInventory.files.filter((file) =>
    ![...excludedRootEntries].some((entry, index) => file.path === entry || file.path.startsWith(excludedRootPrefixes[index]))
  );
  const inventory = excludedRootEntries.size === 0
    ? fullInventory
    : { files: includedFiles, identity: identity(includedFiles) };
  for (const [relPath, beforeFrame] of fileFrames.entries()) {
    const afterSt = await lstat(join(resolvedRoot, relPath), { bigint: true });
    if (!previewFull9Equal(previewStatFull9(afterSt), beforeFrame)) {
      throw new Error(`Preview file frame drifted during inventory: ${relPath}`);
    }
  }
  const rootAfter = await lstat(resolvedRoot, { bigint: true });
  if (!previewDirIdentityEqual(rootBefore, rootAfter)) {
    throw new Error(`Preview root directory identity drifted: ${basename(resolvedRoot)}`);
  }

  return {
    inventory,
    files,
    nodes,
    aggregateBytes,
    observedDirs,
    fileFrames,
    rootStat: rootAfter,
  };
}

/**
 * Validates the separate source-frontend-owned application preview fixture.
 * This keeps `public/preview/app` bounded and closed while leaving the
 * authenticated neutral projection on its exact 27-file/31-node contract.
 * @param {string} rootDir
 * @param {ReturnType<typeof createPreviewHashBudget>} budget
 */
export async function inspectPreparedPreviewAppProjection(rootDir, budget) {
  const check = await inspectBoundedPreviewTree(rootDir, PREPARED_PREVIEW_APP_LIMITS, budget, {
    expectedDirs: [],
  });
  const members = check.inventory.files;
  if (
    members.length !== EXPECTED_PREVIEW_APP_MEMBERS.length ||
    members.some((member, index) => member.path !== EXPECTED_PREVIEW_APP_MEMBERS[index] || member.mode !== 0o644)
  ) {
    throw new Error("Application preview fixture members do not match the closed five-file contract");
  }
  return check;
}

/**
 * Validates the product-membership.json projection for the 11 loom-preview-source members when available.
 * @param {string} sourceRoot
 */
function verifyProductMembershipPreviewProjection(sourceRoot) {
  const candidates = [
    join(resolve(sourceRoot), "tools/public-composition/product-membership.json"),
    join(repositoryRootForStudio(DEFAULT_STUDIO_ROOT), "tools/public-composition/product-membership.json"),
  ];
  for (const candidatePath of candidates) {
    if (!existsSync(candidatePath)) continue;
    const raw = JSON.parse(readFileSync(candidatePath, "utf8"));
    const members = raw?.products?.nebularFusion?.members;
    if (!Array.isArray(members)) {
      throw new Error("Invalid product-membership.json nebularFusion.members");
    }
    const previewMappings = members
      .filter((/** @type {any} */ m) => typeof m?.destination === "string" && (m.destination === "loom-preview-source" || m.destination.startsWith("loom-preview-source/")))
      .map((/** @type {any} */ m) => ({ source: m.source, destination: m.destination }))
      .sort((a, b) => (a.destination < b.destination ? -1 : a.destination > b.destination ? 1 : 0));
    if (previewMappings.length !== EXPECTED_PREVIEW_SOURCE_MEMBERS.length) {
      throw new Error(`product-membership.json loom-preview-source count (${previewMappings.length}) does not equal 11`);
    }
    for (const [i, expected] of EXPECTED_PREVIEW_SOURCE_MEMBERS.entries()) {
      const rel = expected.path;
      const expectedSource = `packages/stellar-loom/fixture/${rel}`;
      const expectedDest = `loom-preview-source/${rel}`;
      const mapping = previewMappings[i];
      if (!mapping || mapping.source !== expectedSource || mapping.destination !== expectedDest) {
        throw new Error(`product-membership.json preview mapping mismatch at ${expectedDest}`);
      }
    }
    return;
  }
}

/**
 * Validates and admits a nebular-prepared-neutral-preview-input-v1 manifest against the build authority and filesystem.
 * @param {string} manifestPath
 * @param {Pick<BuildInputAuthority, "inputs" | "target"> & {tools: Record<string, string>}} authority
 * @param {{ budget?: ReturnType<typeof createPreviewHashBudget>, outputRoots?: string[] }} [options]
 */
export async function admitPreparedNeutralPreviewInput(manifestPath, authority, options = {}) {
  if (typeof manifestPath !== "string" || !manifestPath) {
    throw new Error("Prepared neutral-preview input manifest path is required");
  }
  if (!authority || !authority.inputs || !authority.target) {
    throw new Error("Prepared neutral-preview input requires validated build-inputs authority");
  }
  if (
    authority.target.triple !== "aarch64-apple-darwin" ||
    authority.target.os !== "darwin" ||
    authority.inputs.target !== "aarch64-apple-darwin" ||
    authority.inputs.mode !== "portable-source" ||
    targetForHost().triple !== "aarch64-apple-darwin"
  ) {
    throw new Error("Prepared neutral-preview input is only admitted for target aarch64-apple-darwin in portable-source mode on a Darwin host");
  }

  const budget = options.budget ?? createPreviewHashBudget();
  const resolvedManifestPath = resolve(manifestPath);
  const manifestFile = await readBoundedPreviewRegular(
    resolvedManifestPath,
    PREPARED_PREVIEW_LIMITS.manifestBytes,
    budget,
    { requireNonExec: true },
  );

  let manifest;
  try {
    manifest = JSON.parse(manifestFile.buffer.toString("utf8"));
  } catch (err) {
    throw new Error(`Malformed prepared neutral-preview manifest JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  assertPreviewClosedObject(manifest, "prepared neutral-preview input", [
    "schema",
    "origin",
    "current",
    "source",
    "dependencies",
    "node",
    "recipe",
    "preview",
    "limits",
  ]);
  if (manifest.schema !== PREPARED_PREVIEW_INPUT_SCHEMA) {
    throw new Error(`Unsupported prepared neutral-preview input schema: ${String(manifest.schema)}`);
  }
  if (canonical(manifest.limits) !== canonical(PREPARED_PREVIEW_LIMITS)) {
    throw new Error("Prepared neutral-preview input limits do not match fixed limits.json contract");
  }

  assertPreviewClosedObject(manifest.origin, "prepared preview origin", [
    "sourceCandidate",
    "sourceHead",
    "recoverySha256",
    "namespaceSha256",
    "originalProducerResultSha256",
    "sourceBuildPinsSha256",
  ]);
  for (const [k, v] of Object.entries(manifest.origin)) {
    if (typeof v !== "string" || (k !== "sourceHead" ? !PREVIEW_HEX64_RE.test(v) : !/^[0-9a-f]{40}$/u.test(v))) {
      throw new Error(`Invalid origin digest format for ${k}`);
    }
  }
  if (
    manifest.origin.sourceCandidate !== EXPECTED_PREVIEW_ORIGIN.sourceCandidate ||
    manifest.origin.sourceHead !== EXPECTED_PREVIEW_ORIGIN.sourceHead ||
    manifest.origin.recoverySha256 !== EXPECTED_PREVIEW_ORIGIN.recoverySha256 ||
    manifest.origin.namespaceSha256 !== EXPECTED_PREVIEW_ORIGIN.namespaceSha256 ||
    (manifest.origin.originalProducerResultSha256 !== EXPECTED_PREVIEW_ORIGIN.originalProducerOuterSha256 &&
      manifest.origin.originalProducerResultSha256 !== EXPECTED_PREVIEW_ORIGIN.originalProducerChildSha256) ||
    manifest.origin.sourceBuildPinsSha256 !== EXPECTED_PREVIEW_ORIGIN.sourceBuildPinsSha256
  ) {
    throw new Error("Prepared neutral-preview origin does not match authenticated faac/eaeaf90 origin closure");
  }

  assertPreviewClosedObject(manifest.current, "prepared preview current", [
    "sourceCandidate",
    "target",
    "mode",
  ]);
  if (
    manifest.current.target !== "aarch64-apple-darwin" ||
    manifest.current.mode !== "portable-source" ||
    manifest.current.sourceCandidate !== authority.inputs.source.identity
  ) {
    throw new Error("Prepared neutral-preview current block does not match authority candidate, target, or mode");
  }

  assertPreviewClosedObject(manifest.source, "prepared preview source", ["members", "identity"]);
  if (!Array.isArray(manifest.source.members) || manifest.source.members.length !== PREPARED_PREVIEW_LIMITS.source.files) {
    throw new Error("Prepared neutral-preview source.members must contain exactly 11 files");
  }
  for (const [i, exp] of EXPECTED_PREVIEW_SOURCE_MEMBERS.entries()) {
    const m = manifest.source.members[i];
    assertPreviewClosedObject(m, `source member ${i}`, ["path", "bytes", "mode", "sha256"]);
    if (m.path !== exp.path || m.bytes !== exp.bytes || m.mode !== exp.mode || m.sha256 !== exp.sha256) {
      throw new Error(`Prepared neutral-preview source member mismatch at ${String(m.path)}`);
    }
  }
  if (manifest.source.identity !== identity(manifest.source.members)) {
    throw new Error("Prepared neutral-preview source.identity mismatch");
  }

  const resolvedSourceRoot = resolve(authority.inputs.sourceRoot);
  verifyProductMembershipPreviewProjection(resolvedSourceRoot);
  const sourcePreviewDir = join(resolvedSourceRoot, "loom-preview-source");
  const sourceTreeCheck = await inspectBoundedPreviewTree(
    sourcePreviewDir,
    PREPARED_PREVIEW_LIMITS.source,
    budget,
    { exactAggregateBytes: false, expectedDirs: EXPECTED_PREVIEW_SOURCE_DIRS },
  );
  if (
    sourceTreeCheck.inventory.identity !== manifest.source.identity ||
    canonical(sourceTreeCheck.inventory.files) !== canonical(manifest.source.members)
  ) {
    throw new Error("Current sourceRoot/loom-preview-source inventory does not match prepared preview source closure");
  }

  const fixturePkgJson = JSON.parse(readFileSync(join(sourcePreviewDir, "package.json"), "utf8"));
  const scripts = fixturePkgJson?.scripts ?? {};
  if (
    scripts["build:neutral"] !== EXPECTED_PREVIEW_RECIPE_SCRIPT ||
    "prebuild:neutral" in scripts ||
    "postbuild:neutral" in scripts
  ) {
    throw new Error("loom-preview-source/package.json neutral build script or lifecycle hooks violate pinned recipe");
  }

  assertPreviewClosedObject(manifest.recipe, "prepared preview recipe", [
    "members",
    "command",
    "script",
    "environment",
    "identity",
  ]);
  if (!Array.isArray(manifest.recipe.members) || manifest.recipe.members.length !== PREPARED_PREVIEW_LIMITS.recipeFiles.files) {
    throw new Error("Prepared neutral-preview recipe.members must contain exactly 5 files");
  }
  if (
    manifest.recipe.command !== EXPECTED_PREVIEW_RECIPE_COMMAND ||
    manifest.recipe.script !== EXPECTED_PREVIEW_RECIPE_SCRIPT
  ) {
    throw new Error("Prepared neutral-preview recipe command or script mismatch");
  }
  assertPreviewClosedObject(manifest.recipe.environment, "prepared preview recipe.environment", [
    "ASTRO_BASE",
    "ASTRO_OUT_DIR",
    "TFSL_INSTRUMENTED_PREVIEW",
    "TFSL_THEME_CSS",
  ]);
  if (canonical(manifest.recipe.environment) !== canonical(EXPECTED_PREVIEW_RECIPE_ENV)) {
    throw new Error("Prepared neutral-preview recipe.environment mismatch");
  }
  const execEnv = authority.inputs.execution?.environment ?? {};
  for (const key of Object.keys(execEnv)) {
    if (
      key === "NODE_OPTIONS" ||
      key.startsWith("ASTRO_") ||
      key.startsWith("TFSL_") ||
      key.startsWith("PAGEFIND_")
    ) {
      throw new Error(`Disallowed execution environment override affecting preview recipe: ${key}`);
    }
  }

  let recipeAggregateBytes = 0;
  /** @type {Map<string, (string|number)[]>} */
  const recipeFrames = new Map();
  for (const [i, exp] of EXPECTED_PREVIEW_RECIPE_MEMBERS.entries()) {
    const m = manifest.recipe.members[i];
    assertPreviewClosedObject(m, `recipe member ${i}`, ["path", "bytes", "mode", "sha256"]);
    const validPaths = [`tools/${exp.name}`, `apps/studio/tools/${exp.name}`];
    if (
      !validPaths.includes(m.path) ||
      Buffer.byteLength(m.path, "utf8") > PREPARED_PREVIEW_LIMITS.recipeFiles.relativePathBytes ||
      m.bytes !== exp.bytes ||
      m.mode !== exp.mode ||
      m.sha256 !== exp.sha256
    ) {
      throw new Error(`Prepared neutral-preview recipe member mismatch at ${String(m.path)}`);
    }
    if (i > 0 && manifest.recipe.members[i - 1].path >= m.path) {
      throw new Error("Prepared neutral-preview recipe.members must be strictly sorted");
    }
    const candidateFile = existsSync(join(resolvedSourceRoot, "tools", exp.name))
      ? join(resolvedSourceRoot, "tools", exp.name)
      : join(resolvedSourceRoot, "apps/studio/tools", exp.name);
    const maxFileCeiling = exp.name === "sidecar-common.mjs"
      ? exp.bytes
      : PREPARED_PREVIEW_LIMITS.recipeFiles.perFileBytes;
    const readRecipe = await readBoundedPreviewRegular(candidateFile, maxFileCeiling, budget, { requireNonExec: true });
    if (readRecipe.bytes !== exp.bytes || readRecipe.sha256 !== exp.sha256 || readRecipe.mode !== exp.mode) {
      throw new Error(`Current source recipe file mismatch at ${exp.name}`);
    }
    recipeAggregateBytes += readRecipe.bytes;
    if (recipeAggregateBytes > PREPARED_PREVIEW_LIMITS.recipeFiles.aggregateBytes) {
      throw new Error("Prepared neutral-preview recipe aggregate bytes exceeded");
    }
    recipeFrames.set(candidateFile, readRecipe.full9);
  }
  const { identity: declaredRecipeIdentity, ...recipeBody } = manifest.recipe;
  if (typeof declaredRecipeIdentity !== "string" || identity(recipeBody) !== declaredRecipeIdentity) {
    throw new Error("Prepared neutral-preview recipe.identity mismatch");
  }

  assertPreviewClosedObject(manifest.node, "prepared preview node", [
    "path",
    "identity",
    "version",
    "platform",
  ]);
  const authorityNode = authority.tools.node;
  if (typeof authorityNode !== "string" || !authorityNode) {
    throw new Error("Prepared neutral-preview input requires an authenticated Node locator");
  }
  const resolvedNodePath = resolve(authorityNode);
  if (
    typeof manifest.node.path !== "string" ||
    resolve(manifest.node.path) !== resolvedNodePath ||
    manifest.node.version !== EXPECTED_PREVIEW_NODE.version ||
    manifest.node.platform !== EXPECTED_PREVIEW_NODE.platform ||
    manifest.node.identity !== EXPECTED_PREVIEW_NODE.sha256 ||
    manifest.node.identity !== authority.inputs.toolchains?.node?.identity
  ) {
    throw new Error("Prepared neutral-preview node block does not match pinned Darwin Node 22.23.4 authority");
  }
  const nodeFile = await readBoundedPreviewRegular(
    resolvedNodePath,
    EXPECTED_PREVIEW_NODE.bytes,
    budget,
    { requireExec: true },
  );
  if (nodeFile.bytes !== EXPECTED_PREVIEW_NODE.bytes || nodeFile.sha256 !== EXPECTED_PREVIEW_NODE.sha256) {
    throw new Error("Authenticated build-time Node binary does not match pinned Darwin Node 22.23.4 bytes/SHA-256");
  }

  assertPreviewClosedObject(manifest.dependencies, "prepared preview dependencies", ["root", "identity"]);
  const authPreviewModules = authority.inputs.execution?.previewModules;
  const authPreviewModulesIdentity = authority.inputs.dependencies?.previewModules;
  if (
    typeof authPreviewModules !== "string" ||
    typeof authPreviewModulesIdentity !== "string" ||
    typeof manifest.dependencies.root !== "string" ||
    !manifest.dependencies.root.startsWith("/") ||
    resolve(manifest.dependencies.root) !== resolve(authPreviewModules) ||
    manifest.dependencies.identity !== authPreviewModulesIdentity ||
    manifest.dependencies.identity !== EXPECTED_PREVIEW_DEPENDENCY_IDENTITY
  ) {
    throw new Error("Prepared neutral-preview dependencies block does not match authority previewModules");
  }
  const resolvedDepsRoot = resolve(manifest.dependencies.root);
  const depsCheck = await inspectBoundedPreviewTree(
    resolvedDepsRoot,
    PREPARED_PREVIEW_LIMITS.dependencies,
    budget,
    { exactAggregateBytes: true },
  );
  if (depsCheck.inventory.identity !== manifest.dependencies.identity) {
    throw new Error("Recomputed previewModules dependency inventory does not match manifest dependencies.identity");
  }

  assertPreviewClosedObject(manifest.preview, "prepared preview output", ["root", "members", "identity"]);
  if (typeof manifest.preview.root !== "string" || !manifest.preview.root.startsWith("/")) {
    throw new Error("Prepared neutral-preview preview.root must be an absolute path");
  }
  const resolvedPreviewRoot = resolve(manifest.preview.root);
  for (const checkRoot of [resolvedSourceRoot, resolvedDepsRoot, ...(options.outputRoots ?? [])]) {
    if (!checkRoot) continue;
    const rc = resolve(checkRoot);
    const relA = relative(rc, resolvedPreviewRoot);
    const relB = relative(resolvedPreviewRoot, rc);
    if (rc === resolvedPreviewRoot || (relA && !relA.startsWith("..") && !relA.startsWith(sep)) || (relB && !relB.startsWith("..") && !relB.startsWith(sep))) {
      throw new Error("Prepared neutral-preview preview.root overlaps source, dependency, or output root");
    }
  }
  if (!Array.isArray(manifest.preview.members) || manifest.preview.members.length !== PREPARED_PREVIEW_LIMITS.neutralOutputPerDomain.files) {
    throw new Error("Prepared neutral-preview preview.members must contain exactly 27 files");
  }
  let previewDeclaredBytes = 0;
  for (const [i, exp] of EXPECTED_PREVIEW_NORMALIZED_OUTPUT.entries()) {
    const m = manifest.preview.members[i];
    assertPreviewClosedObject(m, `preview member ${i}`, ["path", "bytes", "mode", "sha256"]);
    if (
      m.path !== exp.path ||
      m.bytes !== exp.bytes ||
      m.mode !== exp.mode ||
      m.sha256 !== exp.sha256
    ) {
      throw new Error(`Prepared neutral-preview preview.members mismatch at ${String(m.path)}`);
    }
    previewDeclaredBytes += m.bytes;
  }
  if (previewDeclaredBytes !== PREPARED_PREVIEW_LIMITS.neutralOutputPerDomain.aggregateBytes) {
    throw new Error("Prepared neutral-preview preview.members aggregate byte mismatch");
  }
  if (
    manifest.preview.identity !== EXPECTED_PREVIEW_ORIGIN_OUTPUT_IDENTITY ||
    manifest.preview.identity !== identity(manifest.preview.members)
  ) {
    throw new Error("Prepared neutral-preview preview.identity does not match preview.members");
  }
  const previewCheck = await inspectBoundedPreviewTree(
    resolvedPreviewRoot,
    PREPARED_PREVIEW_LIMITS.neutralOutputPerDomain,
    budget,
    { exactAggregateBytes: true, expectedDirs: EXPECTED_PREVIEW_OUTPUT_DIRS },
  );
  if (
    previewCheck.inventory.identity !== manifest.preview.identity ||
    canonical(previewCheck.inventory.files) !== canonical(manifest.preview.members)
  ) {
    throw new Error("Origin preview.root inventory does not match manifest.preview");
  }

  const effectiveInputIdentity = identity({
    source: manifest.source.identity,
    dependencies: manifest.dependencies.identity,
    node: manifest.node.identity,
    recipe: manifest.recipe.identity,
    target: manifest.current.target,
  });

  return {
    manifestPath: resolvedManifestPath,
    manifestSha256: manifestFile.sha256,
    manifestFull9: manifestFile.full9,
    manifest,
    sourceRoot: resolvedSourceRoot,
    sourcePreviewDir,
    sourceFrames: sourceTreeCheck.fileFrames,
    recipeFrames,
    nodePath: resolvedNodePath,
    nodeFull9: nodeFile.full9,
    dependenciesRoot: resolvedDepsRoot,
    dependenciesFrames: depsCheck.fileFrames,
    previewRoot: resolvedPreviewRoot,
    previewFrames: previewCheck.fileFrames,
    originSourceCandidate: manifest.origin.sourceCandidate,
    originOutputIdentity: manifest.preview.identity,
    currentSourceCandidate: manifest.current.sourceCandidate,
    target: manifest.current.target,
    effectiveInputIdentity,
    sourceIdentity: manifest.source.identity,
    budget,
  };
}

/**
 * Re-verifies that the admitted manifest, source fixture, recipe files, Node binary, dependencies, and origin preview have not drifted.
 * @param {Awaited<ReturnType<typeof admitPreparedNeutralPreviewInput>>} admitted
 * @param {ReturnType<typeof createPreviewHashBudget>} [budget]
 * @param {{ rehashHeavyInputs?: boolean }} [options]
 */
export async function verifyPreparedNeutralPreviewCustody(admitted, budget = admitted.budget, { rehashHeavyInputs = false } = {}) {
  const manifestNow = await readBoundedPreviewRegular(
    admitted.manifestPath,
    PREPARED_PREVIEW_LIMITS.manifestBytes,
    budget,
    { requireNonExec: true },
  );
  if (manifestNow.sha256 !== admitted.manifestSha256 || !previewFull9Equal(manifestNow.full9, admitted.manifestFull9)) {
    throw new Error("Prepared neutral-preview manifest drifted after admission");
  }

  const sourceNow = await inspectBoundedPreviewTree(
    admitted.sourcePreviewDir,
    PREPARED_PREVIEW_LIMITS.source,
    budget,
    { exactAggregateBytes: false, expectedDirs: EXPECTED_PREVIEW_SOURCE_DIRS },
  );
  if (sourceNow.inventory.identity !== admitted.sourceIdentity) {
    throw new Error("Prepared neutral-preview source fixture drifted");
  }
  for (const [relPath, frame] of admitted.sourceFrames.entries()) {
    const nowFrame = sourceNow.fileFrames.get(relPath);
    if (!nowFrame || !previewFull9Equal(nowFrame, frame)) {
      throw new Error(`Prepared neutral-preview source file frame drifted at ${relPath}`);
    }
  }

  for (const [absPath, frame] of admitted.recipeFrames.entries()) {
    const exp = EXPECTED_PREVIEW_RECIPE_MEMBERS.find((r) => absPath.endsWith(`/${r.name}`));
    const maxBytes = exp ? exp.bytes : PREPARED_PREVIEW_LIMITS.recipeFiles.perFileBytes;
    const nowRecipe = await readBoundedPreviewRegular(absPath, maxBytes, budget, { requireNonExec: true });
    if (!previewFull9Equal(nowRecipe.full9, frame) || (exp && nowRecipe.sha256 !== exp.sha256)) {
      throw new Error(`Prepared neutral-preview recipe file drifted at ${basename(absPath)}`);
    }
  }

  const nodeSt = await lstat(admitted.nodePath, { bigint: true });
  if (!previewFull9Equal(previewStatFull9(nodeSt), admitted.nodeFull9)) {
    throw new Error("Prepared neutral-preview Node binary frame drifted");
  }
  if (rehashHeavyInputs) {
    const nodeNow = await readBoundedPreviewRegular(admitted.nodePath, EXPECTED_PREVIEW_NODE.bytes, budget, { requireExec: true });
    if (nodeNow.sha256 !== EXPECTED_PREVIEW_NODE.sha256 || !previewFull9Equal(nodeNow.full9, admitted.nodeFull9)) {
      throw new Error("Prepared neutral-preview Node binary drifted");
    }
    const depsNow = await inspectBoundedPreviewTree(
      admitted.dependenciesRoot,
      PREPARED_PREVIEW_LIMITS.dependencies,
      budget,
      { exactAggregateBytes: true },
    );
    if (depsNow.inventory.identity !== admitted.manifest.dependencies.identity) {
      throw new Error("Prepared neutral-preview dependencies inventory drifted");
    }
    for (const [relPath, frame] of admitted.dependenciesFrames.entries()) {
      const nowFrame = depsNow.fileFrames.get(relPath);
      if (!nowFrame || !previewFull9Equal(nowFrame, frame)) {
        throw new Error(`Prepared neutral-preview dependency frame drifted at ${relPath}`);
      }
    }
  } else {
    for (const [relPath, frame] of admitted.dependenciesFrames.entries()) {
      const st = await lstat(join(admitted.dependenciesRoot, relPath), { bigint: true });
      if (!previewFull9Equal(previewStatFull9(st), frame)) {
        throw new Error(`Prepared neutral-preview dependency frame drifted at ${relPath}`);
      }
    }
  }

  const previewNow = await inspectBoundedPreviewTree(
    admitted.previewRoot,
    PREPARED_PREVIEW_LIMITS.neutralOutputPerDomain,
    budget,
    { exactAggregateBytes: true, expectedDirs: EXPECTED_PREVIEW_OUTPUT_DIRS },
  );
  if (previewNow.inventory.identity !== admitted.originOutputIdentity) {
    throw new Error("Prepared neutral-preview origin output drifted");
  }
  for (const [relPath, frame] of admitted.previewFrames.entries()) {
    const nowFrame = previewNow.fileFrames.get(relPath);
    if (!nowFrame || !previewFull9Equal(nowFrame, frame)) {
      throw new Error(`Prepared neutral-preview origin file frame drifted at ${relPath}`);
    }
  }
}

/**
 * Exclusively stages the 27 neutral preview members into <stageDir>/loom-preview-source/dist/neutral.
 * @param {string} stageDir
 * @param {Awaited<ReturnType<typeof admitPreparedNeutralPreviewInput>>} admitted
 * @param {ReturnType<typeof createPreviewHashBudget>} [budget]
 */
export async function stagePreparedNeutralPreviewInput(stageDir, admitted, budget = admitted.budget) {
  const resolvedStage = resolve(stageDir);
  await assertNoSymlinkAncestors(resolvedStage);
  const stagePreviewRoot = join(resolvedStage, "loom-preview-source");

  let primaryError = null;
  try {
    const distDir = join(stagePreviewRoot, "dist");
    const neutralDir = join(distDir, "neutral");
    for (const p of [distDir, neutralDir]) {
      try {
        await lstat(p);
        throw new Error(`Refusing to adopt or overwrite existing preview directory: ${basename(p)}`);
      } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code !== "ENOENT") throw err;
      }
    }

    const stageSourceCheck = await inspectBoundedPreviewTree(
      stagePreviewRoot,
      PREPARED_PREVIEW_LIMITS.source,
      budget,
      { exactAggregateBytes: false, expectedDirs: EXPECTED_PREVIEW_SOURCE_DIRS },
    );
    if (
      stageSourceCheck.inventory.identity !== admitted.sourceIdentity ||
      canonical(stageSourceCheck.inventory.files) !== canonical(admitted.manifest.source.members)
    ) {
      throw new Error("Staged loom-preview-source does not match clean source closure before preview staging");
    }

    const parentBefore = await lstat(stagePreviewRoot, { bigint: true });
    await mkdir(distDir, { mode: 0o755, recursive: false });
    await chmod(distDir, 0o755);
    await mkdir(neutralDir, { mode: 0o755, recursive: false });
    await chmod(neutralDir, 0o755);
    for (const subDir of EXPECTED_PREVIEW_OUTPUT_DIRS) {
      const targetDir = join(neutralDir, subDir);
      await mkdir(targetDir, { mode: 0o755, recursive: false });
      await chmod(targetDir, 0o755);
    }

    for (const member of admitted.manifest.preview.members) {
      const srcPath = join(admitted.previewRoot, member.path);
      const expectedFrame = admitted.previewFrames.get(member.path);
      const srcRead = await readBoundedPreviewRegular(
        srcPath,
        PREPARED_PREVIEW_LIMITS.neutralOutputPerDomain.perFileBytes,
        budget,
        { requireNonExec: true },
      );
      if (
        !expectedFrame ||
        !previewFull9Equal(srcRead.full9, expectedFrame) ||
        srcRead.bytes !== member.bytes ||
        srcRead.sha256 !== member.sha256 ||
        srcRead.mode !== member.mode
      ) {
        throw new Error(`Origin preview member failed pre-copy verification at ${member.path}`);
      }

      const destPath = join(neutralDir, member.path);
      const fh = await open(
        destPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0),
        0o644,
      );
      try {
        let written = 0;
        while (written < srcRead.buffer.length) {
          const { bytesWritten } = await fh.write(srcRead.buffer, written, srcRead.buffer.length - written, written);
          if (bytesWritten === 0) throw new Error(`Short write staging preview member ${member.path}`);
          written += bytesWritten;
        }
        await fh.chmod(0o644);
      } finally {
        await fh.close();
      }

      const destReadback = await readBoundedPreviewRegular(
        destPath,
        PREPARED_PREVIEW_LIMITS.neutralOutputPerDomain.perFileBytes,
        budget,
        { requireNonExec: true },
      );
      if (
        destReadback.bytes !== member.bytes ||
        destReadback.sha256 !== member.sha256 ||
        destReadback.mode !== member.mode ||
        destReadback.physicalMode !== 0o644
      ) {
        throw new Error(`Staged preview member readback mismatch at ${member.path}`);
      }
    }

    const parentAfter = await lstat(stagePreviewRoot, { bigint: true });
    if (!previewDirIdentityEqual(parentBefore, parentAfter)) {
      throw new Error("Staged loom-preview-source directory identity drifted during preview staging");
    }

    const stagedNeutralCheck = await inspectBoundedPreviewTree(
      neutralDir,
      PREPARED_PREVIEW_LIMITS.neutralOutputPerDomain,
      budget,
      { exactAggregateBytes: true, expectedDirs: EXPECTED_PREVIEW_OUTPUT_DIRS },
    );
    if (
      stagedNeutralCheck.inventory.identity !== admitted.originOutputIdentity ||
      canonical(stagedNeutralCheck.inventory.files) !== canonical(admitted.manifest.preview.members)
    ) {
      throw new Error("Staged dist/neutral inventory does not match origin output identity");
    }

    return {
      manifestSha256: admitted.manifestSha256,
      originSourceCandidate: admitted.originSourceCandidate,
      originOutputIdentity: admitted.originOutputIdentity,
      currentSourceCandidate: admitted.currentSourceCandidate,
      target: admitted.target,
      effectiveInputIdentity: admitted.effectiveInputIdentity,
      neutralIdentity: stagedNeutralCheck.inventory.identity,
    };
  } catch (err) {
    primaryError = err;
    throw err;
  } finally {
    try {
      await verifyPreparedNeutralPreviewCustody(admitted, budget, { rehashHeavyInputs: false });
    } catch (postErr) {
      if (!primaryError) throw postErr;
    }
  }
}

/**
 * Validates post-build stage/loom-preview-source/dist/neutral, stage/public/preview, source-build-pins.json, and all input afterguards.
 * @param {string} stageDir
 * @param {Awaited<ReturnType<typeof admitPreparedNeutralPreviewInput>>} admitted
 * @param {Awaited<ReturnType<typeof stagePreparedNeutralPreviewInput>>} stagedObservation
 * @param {ReturnType<typeof createPreviewHashBudget>} [budget]
 */
export async function verifyPreparedNeutralPreviewPostbuild(stageDir, admitted, stagedObservation, budget = admitted.budget) {
  assertPreviewClosedObject(stagedObservation, "staged preview observation", [
    "manifestSha256",
    "originSourceCandidate",
    "originOutputIdentity",
    "currentSourceCandidate",
    "target",
    "effectiveInputIdentity",
    "neutralIdentity",
  ]);
  const resolvedStage = resolve(stageDir);

  let primaryError = null;
  try {
    const neutralDir = join(resolvedStage, "loom-preview-source/dist/neutral");
    const publicPreviewDir = join(resolvedStage, "public/preview");

    const neutralCheck = await inspectBoundedPreviewTree(
      neutralDir,
      PREPARED_PREVIEW_LIMITS.neutralOutputPerDomain,
      budget,
      { exactAggregateBytes: true, expectedDirs: EXPECTED_PREVIEW_OUTPUT_DIRS },
    );
    if (
      neutralCheck.inventory.identity !== admitted.originOutputIdentity ||
      neutralCheck.inventory.identity !== stagedObservation.neutralIdentity ||
      canonical(neutralCheck.inventory.files) !== canonical(admitted.manifest.preview.members)
    ) {
      throw new Error("Post-build dist/neutral inventory drifted from authenticated origin output");
    }

    await inspectPreparedPreviewAppProjection(join(publicPreviewDir, "app"), budget);
    const publicCheck = await inspectBoundedPreviewTree(
      publicPreviewDir,
      PREPARED_PREVIEW_LIMITS.neutralOutputPerDomain,
      budget,
      { exactAggregateBytes: true, expectedDirs: EXPECTED_PREVIEW_OUTPUT_DIRS, excludedRootEntries: ["app"] },
    );
    if (
      publicCheck.inventory.identity !== admitted.originOutputIdentity ||
      canonical(publicCheck.inventory.files) !== canonical(admitted.manifest.preview.members)
    ) {
      throw new Error("Post-build public/preview inventory does not equal authenticated origin output");
    }

    const pinsPath = join(resolvedStage, "src-tauri/source-build-pins.json");
    const pinsFile = await readBoundedPreviewRegular(pinsPath, 16 * 1024 * 1024, budget, { requireNonExec: true });
    let pins;
    try {
      pins = JSON.parse(pinsFile.buffer.toString("utf8"));
    } catch {
      throw new Error("Malformed source-build-pins.json after prepared preview build");
    }
    assertPreviewClosedObject(pins, "source-build-pins.json", [
      "sourceCandidate",
      "target",
      "sidecarManifest",
      "scene",
      "loom",
      "solar",
    ]);
    if (pins.sourceCandidate !== admitted.currentSourceCandidate || pins.target !== admitted.target) {
      throw new Error("Post-build source-build-pins.json does not bind current sourceCandidate and target");
    }

    return {
      ...stagedObservation,
      publicPreviewIdentity: publicCheck.inventory.identity,
      sourceBuildPinsSha256: pinsFile.sha256,
    };
  } catch (err) {
    primaryError = err;
    throw err;
  } finally {
    try {
      await verifyPreparedNeutralPreviewCustody(admitted, budget, { rehashHeavyInputs: true });
    } catch (postErr) {
      if (!primaryError) throw postErr;
    }
  }
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
