// @ts-check

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { DEFAULT_TARGET, OPTIONAL_SCENE_RESOURCE, SOLAR_SAIL_RESOURCE } from "./verify-tauri-resource-closure.mjs";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const STUDIO_ROOT = existsSync(join(REPO_ROOT, "apps/studio/src-tauri/tauri.conf.json")) ? join(REPO_ROOT, "apps/studio") : REPO_ROOT;

/**
 * @typedef {{
 *   schema: string,
 *   target: string,
 *   package: {name: string, version: string, packageJsonSha256: string},
 *   binding: {size: number, sha256: string, inventoryDigest: string, memberCount: number},
 *   provenance: {
 *     structuredSource?: {sourceCandidate: string, componentSource: string, output: string, producer: string, version: string},
 *     publishedArchive?: {name: string, version: string, size: number, sha256: string}
 *   }
 * }} SolarSailBuildPin
 */
/** @typedef {{target?: unknown, sourceCandidate?: unknown, solar?: unknown}} RawSolarBuildPins */
/** @typedef {"structured-source" | "published-archive"} SolarSailRoute */
/** @typedef {Record<string, unknown>} JsonRecord */
/** @typedef {{name: string, version: string, packageJsonSha256: string, inventoryDigest: string, runtimeMemberCount: number}} SolarSailBinding */
/** @typedef {{pin: SolarSailBuildPin, route: SolarSailRoute, sourceCandidate: string | null, pinSha256: string, pinPath: string, inventory: Array<{path: string, size: number, sha256: string}>, binding: SolarSailBinding}} SolarSailVerification */
/** @typedef {"structured-source" | "published-archive"} SceneRoute */
/** @typedef {{schema: string, engineSchema: string, capability: string, compatibility: number, compilerLevel: number, metadataVersion: string, sha256: string, bytes: number, sourceTreeDigest?: string, sourceIdentity?: string, runtime: {version: string, target: string, sha256: string, bytes: number}, node: {version: string, target: string, sha256: string, bytes: number}, adapterSha256: string, files: Array<{path: string, bytes: number, sha256: string}>, inventory?: Array<{path: string, bytes: number, sha256: string}>, fileCount?: number}} SceneBinding */
/** @typedef {{binding: SceneBinding, route: SceneRoute, sourceCandidate: string | null, pinSha256: string, pinPath: string, inventory: Array<{path: string, size: number, sha256: string}>, receipt: JsonRecord}} SceneVerification */

// The maintained Solar Sail producer's EXPECTED_SOLAR_SAIL_INVENTORY_DIGEST is
// the eight-member runtime digest. A published archive pin binds all 63 dist
// members, so its retained full-binding digest is a separate authority here.
const PUBLISHED_SOLAR_SAIL_FULL_BINDING_SIZE = 10_170;
const PUBLISHED_SOLAR_SAIL_FULL_BINDING_SHA256 = "7248a3f6ac5de65b9e33b28717177b01d5adcb2d673ddaee19e0bec722d4e3fc";
const PUBLISHED_SOLAR_SAIL_FULL_BINDING_MEMBER_COUNT = 63;
const PUBLISHED_SOLAR_SAIL_FULL_BINDING_DIGEST = "0fdb11c3e4ebd0136e6c260f1a5c7c5626824aaff25ebccdf46545a0417f4676";

/** @param {unknown} value @returns {value is JsonRecord} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {Uint8Array|string} bytes */
function sha256Hex(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
/** @param {string} left @param {string} right @returns {number} */
function codeUnitCompare(left, right) {
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}
/** @param {string} root @param {string} dir @returns {Promise<Array<{path: string, size: number, sha256: string}>>} */
async function inventory(root, dir) {
  /** @type {Array<{path: string, size: number, sha256: string}>} */
  const output = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) output.push(...await inventory(root, full));
    else if (entry.isFile()) { const bytes = await readFile(full); output.push({ path: relative(root, full).replace(/\\/gu, "/"), size: bytes.byteLength, sha256: sha256Hex(bytes) }); }
    else throw new Error(`Bundle contains non-regular entry: ${entry.name}`);
  }
  return output.sort((left, right) => codeUnitCompare(left.path, right.path));
}
/** @param {string} executable */
async function launchAndTerminate(executable) {
  const child = spawn(executable, [], { env: { HOME: process.env.RUNNER_TEMP ?? tmpdir(), TMPDIR: process.env.RUNNER_TEMP ?? tmpdir(), LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, stdio: "ignore" });
  await new Promise((done) => setTimeout(done, 3_000));
  if (child.exitCode !== null || child.signalCode !== null) throw new Error("Nebular app exited before the launch observation completed.");
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  const result = await Promise.race([
    new Promise((done) => child.once("close", (code, signal) => done({ code, signal }))),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Nebular app did not terminate within ten seconds.")), 10_000)),
  ]);
  return result;
}

/**
 * Loads exactly one maintained Solar Sail pin authority for the selected route.
 * Structured-source pins are aggregate preparation receipts and require the
 * independently supplied candidate identity; archive pins remain standalone
 * published-input receipts.
 *
 * @param {{route: SolarSailRoute, sourceCandidate?: string, pinPath?: string}} options
 * @returns {Promise<{pin: SolarSailBuildPin, route: SolarSailRoute, sourceCandidate: string | null, pinSha256: string, pinPath: string}>}
 */
async function loadSolarSailBuildPin({ route, sourceCandidate, pinPath: suppliedPinPath }) {
  if (route === "structured-source") {
    if (typeof sourceCandidate !== "string" || !/^[0-9a-f]{64}$/u.test(sourceCandidate)) {
      throw new Error("[SOLAR_SAIL_PIN_FAIL] Structured-source verification requires an independently supplied SHA-256 source candidate");
    }
  } else if (sourceCandidate !== undefined) {
    throw new Error("[SOLAR_SAIL_PIN_FAIL] sourceCandidate is only valid for the structured-source route");
  }
  const defaultPinPath = route === "structured-source"
    ? join(STUDIO_ROOT, "src-tauri/source-build-pins.json")
    : join(STUDIO_ROOT, "src-tauri/solar-sail-build-pin.json");
  const pinPath = resolve(suppliedPinPath ?? defaultPinPath);
  let pinBytes;
  let parsed;
  try {
    pinBytes = await readFile(pinPath);
    parsed = JSON.parse(pinBytes.toString("utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`[SOLAR_SAIL_PIN_FAIL] Unable to read ${pinPath}: ${detail}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`[SOLAR_SAIL_PIN_FAIL] ${pinPath} must contain a JSON object`);
  }
  const rawPins = /** @type {RawSolarBuildPins} */ (parsed);
  const pin = route === "structured-source" ? rawPins.solar : parsed;
  if (!isRecord(pin)) {
    throw new Error(`[SOLAR_SAIL_PIN_FAIL] ${pinPath} does not contain the ${route} Solar Sail pin authority`);
  }
  const solarPin = /** @type {SolarSailBuildPin} */ (pin);
  if (route === "structured-source" && (typeof rawPins.target !== "string" || rawPins.target !== DEFAULT_TARGET)) {
    throw new Error(`[SOLAR_SAIL_PIN_FAIL] Structured-source Solar Sail pin target must be ${DEFAULT_TARGET}`);
  }
  if (route === "structured-source" && rawPins.sourceCandidate !== sourceCandidate) {
    throw new Error("[SOLAR_SAIL_PIN_FAIL] Structured-source aggregate pin source candidate mismatch");
  }
  const solarPrepareScript = join(STUDIO_ROOT, "tools/solar-sail-prepare.mjs");
  if (!existsSync(solarPrepareScript)) {
    throw new Error(`[SOLAR_SAIL_PIN_FAIL] Maintained Solar Sail preparer missing at ${solarPrepareScript}`);
  }
  try {
    const {
      validateSolarSailBuildPin,
      EXPECTED_SOLAR_SAIL_NAME,
      ADMITTED_SOLAR_SAIL_ARCHIVE_VERSION,
      ADMITTED_SOLAR_SAIL_ARCHIVE_SIZE,
      ADMITTED_SOLAR_SAIL_ARCHIVE_SHA256,
    } = await import(pathToFileURL(solarPrepareScript).href);
    validateSolarSailBuildPin(solarPin, {
      route,
      target: DEFAULT_TARGET,
      ...(route === "structured-source" ? { sourceCandidate } : {}),
    });
    if (route === "published-archive") {
      const archive = solarPin.provenance.publishedArchive;
      if (archive?.name !== EXPECTED_SOLAR_SAIL_NAME
        || archive?.version !== ADMITTED_SOLAR_SAIL_ARCHIVE_VERSION
        || archive?.size !== ADMITTED_SOLAR_SAIL_ARCHIVE_SIZE
        || archive?.sha256 !== ADMITTED_SOLAR_SAIL_ARCHIVE_SHA256
        || solarPin.binding.size !== PUBLISHED_SOLAR_SAIL_FULL_BINDING_SIZE
        || solarPin.binding.sha256 !== PUBLISHED_SOLAR_SAIL_FULL_BINDING_SHA256
        || solarPin.binding.memberCount !== PUBLISHED_SOLAR_SAIL_FULL_BINDING_MEMBER_COUNT
        || solarPin.binding.inventoryDigest !== PUBLISHED_SOLAR_SAIL_FULL_BINDING_DIGEST) {
        throw new Error("[SOLAR_SAIL_PIN_FAIL] Published-archive Solar Sail authority differs from retained historical constants");
      }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`[SOLAR_SAIL_PIN_FAIL] Invalid aggregate Solar Sail pin: ${detail}`);
  }
  return {
    pin: solarPin,
    route,
    sourceCandidate: route === "structured-source" ? (sourceCandidate ?? null) : null,
    pinSha256: sha256Hex(pinBytes),
    pinPath,
  };
}

/**
 * Verifies prepared and packed Solar Sail payloads against the one pin
 * authority selected by route. This is kept separate from bundle plumbing so
 * both monorepo and composed-product callers exercise the same producer gate.
 *
 * @param {{preparedPath: string, packedPath: string, route: SolarSailRoute, sourceCandidate?: string, pinPath?: string}} options
 * @returns {Promise<SolarSailVerification>}
 */
export async function verifySolarSailPayloads({ preparedPath, packedPath, route, sourceCandidate, pinPath }) {
  const pin = await loadSolarSailBuildPin({
    route,
    ...(sourceCandidate !== undefined ? { sourceCandidate } : {}),
    ...(pinPath !== undefined ? { pinPath } : {}),
  });
  const prepared = resolve(preparedPath);
  const packed = resolve(packedPath);
  const [preparedInventory, packedInventory] = await Promise.all([
    inventory(prepared, prepared),
    inventory(packed, packed),
  ]);
  if (JSON.stringify(preparedInventory) !== JSON.stringify(packedInventory)) {
    throw new Error("Packed Solar Sail payload differs from the prepared Solar Sail payload.");
  }
  const solarPrepareScript = join(STUDIO_ROOT, "tools/solar-sail-prepare.mjs");
  if (!existsSync(solarPrepareScript)) {
    throw new Error(`[SOLAR_SAIL_PIN_FAIL] Maintained Solar Sail preparer missing at ${solarPrepareScript}`);
  }
  const { verifyPreparedSolarSailPayload } = await import(pathToFileURL(solarPrepareScript).href);
  let binding;
  try {
    await verifyPreparedSolarSailPayload(prepared, pin.pin);
    binding = await verifyPreparedSolarSailPayload(packed, pin.pin);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`[SOLAR_SAIL_BINDING_FAIL] ${pin.route} payload failed maintained verification: ${detail}`);
  }
  return {
    ...pin,
    inventory: packedInventory,
    binding: /** @type {SolarSailBinding} */ (binding),
  };
}

/**
 * Loads the one Scene authority for the selected resource route. The archive
 * route is pinned to the retained historical protocol binding; the structured
 * route consumes the complete Scene receipt emitted by prepare-app-resources.
 *
 * @param {{route: SceneRoute, sourceCandidate?: string, pinPath?: string}} options
 * @returns {Promise<{binding: SceneBinding, route: SceneRoute, sourceCandidate: string | null, pinSha256: string, pinPath: string}>}
 */
async function loadSceneBinding({ route, sourceCandidate, pinPath: suppliedPinPath }) {
  if (route === "structured-source") {
    if (typeof sourceCandidate !== "string" || !/^[0-9a-f]{64}$/u.test(sourceCandidate)) {
      throw new Error("[SCENE_PIN_FAIL] Structured-source verification requires an independently supplied SHA-256 source candidate");
    }
  } else if (sourceCandidate !== undefined) {
    throw new Error("[SCENE_PIN_FAIL] sourceCandidate is only valid for the structured-source Scene route");
  }

  const scenePrepareScript = join(STUDIO_ROOT, "tools/scene-prepare.mjs");
  if (!existsSync(scenePrepareScript)) throw new Error(`[SCENE_PIN_FAIL] Maintained Scene preparer missing at ${scenePrepareScript}`);
  const { sceneBinding: maintainedBinding, validateStructuredSceneBinding } = await import(pathToFileURL(scenePrepareScript).href);
  const defaultPinPath = route === "structured-source"
    ? join(STUDIO_ROOT, "src-tauri/source-build-pins.json")
    : join(STUDIO_ROOT, "protocol/scene-workbench-v1/payload-binding.json");
  const pinPath = resolve(suppliedPinPath ?? defaultPinPath);
  let pinBytes;
  let parsed;
  try {
    pinBytes = await readFile(pinPath);
    parsed = JSON.parse(pinBytes.toString("utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`[SCENE_PIN_FAIL] Unable to read ${pinPath}: ${detail}`);
  }
  if (!isRecord(parsed)) throw new Error(`[SCENE_PIN_FAIL] ${pinPath} must contain a JSON object`);
  const bindingValue = route === "structured-source" ? parsed.scene : parsed;
  if (!isRecord(bindingValue)) throw new Error(`[SCENE_PIN_FAIL] ${pinPath} does not contain the ${route} Scene binding authority`);
  const binding = /** @type {SceneBinding} */ (bindingValue);

  if (binding.schema !== maintainedBinding.schema
    || binding.engineSchema !== maintainedBinding.engineSchema
    || binding.capability !== maintainedBinding.capability
    || binding.compatibility !== maintainedBinding.compatibility
    || binding.compilerLevel !== maintainedBinding.compilerLevel
    || binding.metadataVersion !== maintainedBinding.metadataVersion
    || binding.adapterSha256 !== maintainedBinding.adapterSha256) {
    throw new Error(`[SCENE_PIN_FAIL] ${route} Scene binding schema or adapter authority is invalid`);
  }
  if (!isRecord(binding.node) || typeof binding.node.version !== "string"
    || typeof binding.node.target !== "string" || typeof binding.node.sha256 !== "string"
    || typeof binding.node.bytes !== "number") {
    throw new Error("[SCENE_PIN_FAIL] Scene binding must contain a complete Node runtime identity");
  }
  if (binding.node.target !== DEFAULT_TARGET || binding.node.version !== maintainedBinding.node.version
    || binding.node.sha256 !== maintainedBinding.node.sha256 || binding.node.bytes !== maintainedBinding.node.bytes) {
    throw new Error("[SCENE_PIN_FAIL] Scene binding Node runtime does not match the maintained target authority");
  }
  if (!Array.isArray(binding.files) || binding.files.length === 0) {
    throw new Error("[SCENE_PIN_FAIL] Scene binding must contain a non-empty file inventory");
  }

  if (route === "published-archive") {
    if (binding.sha256 !== maintainedBinding.sha256 || binding.bytes !== maintainedBinding.bytes
      || binding.sourceTreeDigest !== maintainedBinding.sourceTreeDigest
      || binding.files.length !== maintainedBinding.files.length) {
      throw new Error("[SCENE_PIN_FAIL] Published-archive Scene binding does not match the retained historical authority");
    }
    for (const [index, file] of binding.files.entries()) {
      const maintainedFile = maintainedBinding.files[index];
      if (file.path !== maintainedFile?.path || file.bytes !== maintainedFile?.bytes || file.sha256 !== maintainedFile?.sha256) {
        throw new Error("[SCENE_PIN_FAIL] Published-archive Scene file authority differs from the retained protocol binding");
      }
    }
  } else {
    if (parsed.target !== DEFAULT_TARGET || parsed.sourceCandidate !== sourceCandidate) {
      throw new Error("[SCENE_PIN_FAIL] Structured-source Scene pin target or source candidate mismatch");
    }
    if (binding.sourceIdentity !== sourceCandidate || binding.sourceTreeDigest !== sourceCandidate
      || !Array.isArray(binding.inventory) || binding.inventory.length !== binding.files.length
      || binding.fileCount !== binding.files.length) {
      throw new Error("[SCENE_PIN_FAIL] Structured-source Scene receipt is incomplete or does not bind its candidate");
    }
    const totalBytes = binding.files.reduce((sum, file) => sum + file.bytes, 0);
    const inventoryDigest = sha256Hex(binding.files.map(file => `${file.path}:${file.sha256}`).join("\n"));
    if (binding.bytes !== totalBytes || binding.sha256 !== inventoryDigest) {
      throw new Error("[SCENE_PIN_FAIL] Structured-source Scene receipt digest is inconsistent");
    }
    for (const [index, file] of binding.files.entries()) {
      const inventoryFile = binding.inventory[index];
      if (file.path !== inventoryFile?.path || file.bytes !== inventoryFile?.bytes || file.sha256 !== inventoryFile?.sha256) {
        throw new Error("[SCENE_PIN_FAIL] Structured-source Scene receipt inventory differs from its file list");
      }
    }
    if (binding.runtime?.version !== binding.node.version || binding.runtime?.target !== binding.node.target
      || binding.runtime?.sha256 !== binding.node.sha256 || binding.runtime?.bytes !== binding.node.bytes) {
      throw new Error("[SCENE_PIN_FAIL] Structured-source Scene runtime receipt does not match its Node identity");
    }
    try {
      validateStructuredSceneBinding(binding, { sourceCandidate });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`[SCENE_PIN_FAIL] ${detail}`);
    }
  }
  return { binding, route, sourceCandidate: route === "structured-source" ? (sourceCandidate ?? null) : null, pinSha256: sha256Hex(pinBytes), pinPath };
}

/**
 * Verifies both prepared and packed Scene payloads against the selected
 * authority. Both trees go through the maintained producer verifier so an
 * identical tamper cannot pass merely because the trees still match.
 *
 * @param {{preparedPath: string, packedPath: string, nodePath: string, route: SceneRoute, sourceCandidate?: string, pinPath?: string}} options
 * @returns {Promise<SceneVerification>}
 */
export async function verifyScenePayloads({ preparedPath, packedPath, nodePath, route, sourceCandidate, pinPath }) {
  const authority = await loadSceneBinding({
    route,
    ...(sourceCandidate !== undefined ? { sourceCandidate } : {}),
    ...(pinPath !== undefined ? { pinPath } : {}),
  });
  const prepared = resolve(preparedPath);
  const packed = resolve(packedPath);
  const [preparedInventory, packedInventory] = await Promise.all([
    inventory(prepared, prepared),
    inventory(packed, packed),
  ]);
  if (JSON.stringify(preparedInventory) !== JSON.stringify(packedInventory)) {
    throw new Error("Packed Scene payload differs from the prepared Scene payload.");
  }
  const scenePrepareScript = join(STUDIO_ROOT, "tools/scene-prepare.mjs");
  const { verifyScenePayload } = await import(pathToFileURL(scenePrepareScript).href);
  let receipt;
  try {
    await verifyScenePayload(prepared, resolve(nodePath), authority.binding);
    receipt = await verifyScenePayload(packed, resolve(nodePath), authority.binding);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`[SCENE_BINDING_FAIL] ${authority.route} payload failed maintained verification: ${detail}`);
  }
  return {
    ...authority,
    inventory: packedInventory,
    receipt: /** @type {JsonRecord} */ (receipt),
  };
}

/** @param {{appPath: string, sourceNodePath: string, sourcePayloadPath: string, sourceLoomPayloadPath?: string, sourceSolarSailPayloadPath?: string, sourceScenePayloadPath?: string, sourceCandidate?: string, solarSailRoute?: SolarSailRoute, solarSailBuildPinPath?: string, sceneSourceCandidate?: string, sceneRoute?: SceneRoute, sceneBuildPinPath?: string, outputPath: string, launch?: boolean}} options */
export async function verifyNebularBundle(options) {
  const appPath = resolve(options.appPath), contents = join(appPath, "Contents"), macos = join(contents, "MacOS"), resources = join(contents, "Resources");
  const identifier = execFileSync("plutil", ["-extract", "CFBundleIdentifier", "raw", join(contents, "Info.plist")], { encoding: "utf8" }).trim();
  const executableName = execFileSync("plutil", ["-extract", "CFBundleExecutable", "raw", join(contents, "Info.plist")], { encoding: "utf8" }).trim();
  if (identifier !== "ai.knowledgeforge.themeforge.nebularfusion") throw new Error(`Bundle identifier mismatch: ${identifier}`);
  const executablePath = join(macos, executableName), sidecarPath = join(macos, "tfsb-studio-service"), payloadPath = join(resources, "sidecar-payload");
  if (!execFileSync("file", ["-b", executablePath], { encoding: "utf8" }).includes("arm64")) throw new Error("Nebular executable is not arm64.");
  const [sourceNode, packedNode] = await Promise.all([readFile(options.sourceNodePath), readFile(sidecarPath)]);
  if (sha256Hex(sourceNode) !== sha256Hex(packedNode)) throw new Error("Packed sidecar runtime differs from the authenticated Node executable.");
  const [sourcePayload, packedPayload] = await Promise.all([inventory(resolve(options.sourcePayloadPath), resolve(options.sourcePayloadPath)), inventory(payloadPath, payloadPath)]);
  if (JSON.stringify(sourcePayload) !== JSON.stringify(packedPayload)) throw new Error("Packed sidecar payload differs from the prepared payload.");
  const loomPayloadPath = join(resources, "loom-payload");
  const candidateLoomSource = options.sourceLoomPayloadPath ? resolve(options.sourceLoomPayloadPath) : join(STUDIO_ROOT, "src-tauri/loom-payload");
  let loomInventory = null;
  if (!existsSync(loomPayloadPath) || !existsSync(candidateLoomSource)) throw new Error("Exact prepared and bundled Loom payloads are required.");
  if (existsSync(loomPayloadPath)) {
    const batchScript = join(loomPayloadPath, "bin/tfsl-batch.js");
    if (!existsSync(batchScript)) throw new Error("Packaged loom-payload is missing bin/tfsl-batch.js.");
    if (existsSync(candidateLoomSource)) {
      const [sourceLoom, packedLoom] = await Promise.all([
        inventory(candidateLoomSource, candidateLoomSource),
        inventory(loomPayloadPath, loomPayloadPath),
      ]);
      if (JSON.stringify(sourceLoom) !== JSON.stringify(packedLoom)) throw new Error("Packed loom payload differs from the prepared loom payload.");
      loomInventory = packedLoom;
    } else {
      loomInventory = await inventory(loomPayloadPath, loomPayloadPath);
    }
  }
  const tauri = JSON.parse(await readFile(join(STUDIO_ROOT, "src-tauri/tauri.conf.json"), "utf8"));
  const configuredSceneResource = Array.isArray(tauri.bundle?.resources) && tauri.bundle.resources.includes(OPTIONAL_SCENE_RESOURCE);
  const configuredSolarSailResource = Array.isArray(tauri.bundle?.resources) && tauri.bundle.resources.includes(SOLAR_SAIL_RESOURCE);
  const sceneRoute = options.sceneRoute ?? "published-archive";
  const solarSailRoute = options.solarSailRoute ?? "published-archive";
  if (configuredSceneResource && sceneRoute !== "structured-source" && sceneRoute !== "published-archive") {
    throw new Error(`[SCENE_PIN_FAIL] Unsupported Scene resource route: ${sceneRoute}`);
  }
  if (configuredSolarSailResource && solarSailRoute !== "structured-source" && solarSailRoute !== "published-archive") {
    throw new Error(`[SOLAR_SAIL_PIN_FAIL] Unsupported Solar Sail resource route: ${solarSailRoute}`);
  }
  if (configuredSceneResource && configuredSolarSailResource && sceneRoute !== solarSailRoute) {
    throw new Error("Configured Scene and Solar Sail routes must match for one aggregate bundle candidate.");
  }
  const suppliedCandidates = [options.sourceCandidate, options.sceneSourceCandidate]
    .filter((candidate) => candidate !== undefined);
  if (new Set(suppliedCandidates).size > 1) {
    throw new Error("Configured Scene and Solar Sail source candidates must match.");
  }
  const aggregateCandidate = suppliedCandidates[0];
  if (configuredSceneResource && configuredSolarSailResource && sceneRoute === "structured-source") {
    const sceneAggregatePath = resolve(options.sceneBuildPinPath ?? join(STUDIO_ROOT, "src-tauri/source-build-pins.json"));
    const solarAggregatePath = resolve(options.solarSailBuildPinPath ?? join(STUDIO_ROOT, "src-tauri/source-build-pins.json"));
    if (sceneAggregatePath !== solarAggregatePath) {
      throw new Error("Configured Scene and Solar Sail structured routes must use the same aggregate pin path.");
    }
  }
  const scenePayloadPath = join(resources, "scene-payload");
  const candidateSceneSource = options.sourceScenePayloadPath ? resolve(options.sourceScenePayloadPath) : join(STUDIO_ROOT, "src-tauri/scene-payload");
  let sceneInventory = null;
  let sceneReceipt = null;
  let sceneVerification = null;
  if (configuredSceneResource) {
    if (!existsSync(scenePayloadPath) || !existsSync(candidateSceneSource)) {
      throw new Error("Exact prepared and bundled Scene payloads are required when scene resource is configured.");
    }
    const sceneBatchScript = join(scenePayloadPath, "bin/scene-batch.js");
    if (!existsSync(sceneBatchScript)) {
      throw new Error("Packaged scene-payload is missing bin/scene-batch.js.");
    }
    sceneVerification = await verifyScenePayloads({
      preparedPath: candidateSceneSource,
      packedPath: scenePayloadPath,
      nodePath: options.sourceNodePath,
      route: sceneRoute,
      ...(aggregateCandidate !== undefined ? { sourceCandidate: aggregateCandidate } : {}),
      ...(options.sceneBuildPinPath !== undefined ? { pinPath: options.sceneBuildPinPath } : {}),
    });
    sceneInventory = sceneVerification.inventory;
    sceneReceipt = sceneVerification.receipt;
  }
  const solarSailPayloadPath = join(resources, "solar-sail-payload");
  const candidateSolarSailSource = options.sourceSolarSailPayloadPath ? resolve(options.sourceSolarSailPayloadPath) : join(STUDIO_ROOT, "src-tauri/solar-sail-payload");
  let solarSailInventory = null;
  /** @type {SolarSailBinding | null} */
  let solarSailBinding = null;
  let solarSailBuildPin = null;
  if (configuredSolarSailResource) {
    if (!existsSync(solarSailPayloadPath) || !existsSync(candidateSolarSailSource)) {
      throw new Error("Exact prepared and bundled Solar Sail payloads are required when solar-sail resource is configured.");
    }
    const solarVerification = await verifySolarSailPayloads({
      preparedPath: candidateSolarSailSource,
      packedPath: solarSailPayloadPath,
      route: solarSailRoute,
      ...(aggregateCandidate !== undefined ? { sourceCandidate: aggregateCandidate } : {}),
      ...(options.solarSailBuildPinPath !== undefined ? { pinPath: options.solarSailBuildPinPath } : {}),
    });
    solarSailBuildPin = solarVerification;
    solarSailInventory = solarVerification.inventory;
    solarSailBinding = solarVerification.binding;
  }
  if (sceneVerification && solarSailBuildPin
    && sceneVerification.route === "structured-source"
    && (sceneVerification.pinPath !== solarSailBuildPin.pinPath
      || sceneVerification.pinSha256 !== solarSailBuildPin.pinSha256
      || sceneVerification.sourceCandidate !== solarSailBuildPin.sourceCandidate)) {
    throw new Error("Configured Scene and Solar Sail structured routes resolved different aggregate pin authorities.");
  }
  const capability = JSON.parse(await readFile(join(STUDIO_ROOT, "src-tauri/capabilities/main.json"), "utf8"));
  if (typeof tauri.app?.security?.csp !== "string" || !tauri.app.security.csp.includes("object-src 'none'") || !tauri.app.security.csp.includes("frame-ancestors 'none'")) throw new Error("Strict CSP is missing from the bundle source configuration.");
  if (!Array.isArray(capability.permissions) || !capability.permissions.every((/** @type {unknown} */ value) => typeof value === "string")) throw new Error("Bundle capability permissions are invalid.");
  const permissions = capability.permissions.map((/** @type {string} */ value) => value.replace(/^allow-/u, "").replace(/-/gu, "_"));
  const inventorySource = await readFile(join(STUDIO_ROOT, "src-tauri/src/command_inventory.rs"), "utf8");
  const declaration = /^pub\(crate\) static STUDIO_COMMAND_NAMES: &\[&str\] = &\[([\s\S]*?)\];\s*$/u.exec(inventorySource);
  if (!declaration || !/^(?:\s*"studio_[a-z_]+",)*\s*$/u.test(declaration[1] ?? "")) throw new Error("Owning command inventory syntax is unsupported.");
  const expectedAcl = [...(declaration[1] ?? "").matchAll(/"(studio_[a-z_]+)"/gu)].map((match) => match[1]);
  if (expectedAcl.length === 0 || new Set(expectedAcl).size !== expectedAcl.length || JSON.stringify(permissions) !== JSON.stringify(expectedAcl)) throw new Error("Bundle capability ACL differs from the owning command inventory.");
  const bundleVersion = execFileSync("plutil", ["-extract", "CFBundleShortVersionString", "raw", join(contents, "Info.plist")], {encoding:"utf8"}).trim();
  if (bundleVersion !== tauri.version) throw new Error("Bundle version differs from the owning application version.");
  const signingInspection = spawnSync("codesign", ["-dv", "--verbose=4", appPath], { encoding: "utf8" });
  const signingOutput = `${signingInspection.stdout ?? ""}\n${signingInspection.stderr ?? ""}`;
  if (signingInspection.status !== 0) throw new Error("Bundle signing identity could not be inspected.");
  let signatureValid = true;
  try { execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "pipe" }); } catch { signatureValid = false; }
  if (!signatureValid) throw new Error("Ad-hoc/local bundle signature verification failed.");
  const launches = options.launch ? [await launchAndTerminate(executablePath), await launchAndTerminate(executablePath)] : [];
  const lingering = options.launch && spawnSync("pgrep", ["-f", sidecarPath], { encoding: "utf8" }).status === 0;
  if (lingering) throw new Error("Packed sidecar remained after the app launch/exit cycles.");
  const executableBytes = await readFile(executablePath);
  const receipt = {
    schema: "tfsb.nebular-bundle-identity",
    schemaVersion: 1,
    status: "pass",
    app: basename(appPath),
    identifier,
    version: bundleVersion,
    commandInventorySha256: sha256Hex(Buffer.from(inventorySource)),
    executable: { name: executableName, architecture: "arm64", size: executableBytes.byteLength, sha256: sha256Hex(executableBytes) },
    sidecar: { filename: basename(sidecarPath), size: packedNode.byteLength, sha256: sha256Hex(packedNode), payloadFiles: packedPayload.length, payloadEqual: true, reapedAfterLaunches: options.launch ? true : null },
    loomPayload: loomInventory ? { payloadFiles: loomInventory.length, batchExecutable: true, payloadEqual: true } : null,
    solarSailPayload: solarSailInventory ? {
      payloadFiles: solarSailInventory.length,
      payloadEqual: true,
      route: solarSailBuildPin?.route ?? null,
      pinSha256: solarSailBuildPin?.pinSha256 ?? null,
      sourceCandidate: solarSailBuildPin?.sourceCandidate ?? null,
      binding: solarSailBinding,
    } : null,
    scenePayload: sceneInventory ? {
      payloadFiles: sceneInventory.length,
      batchExecutable: true,
      payloadEqual: true,
      route: sceneVerification?.route ?? null,
      pinSha256: sceneVerification?.pinSha256 ?? null,
      sourceCandidate: sceneVerification?.sourceCandidate ?? null,
      receipt: sceneReceipt,
    } : null,
    sceneReceipt: sceneReceipt ?? null,
    csp: tauri.app.security.csp,
    acl: expectedAcl,
    signing: { kind: signingOutput.includes("Authority=Apple Development") || signingOutput.includes("Authority=Developer ID") ? "credentialed" : signingOutput.includes("Signature=adhoc") ? "ad-hoc" : "local-unsigned-identity", verified: true },
    launches
  };
  await writeFile(resolve(options.outputPath), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return receipt;
}

const invokedDirectly = process.argv[1] !== undefined && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (invokedDirectly) {
  const args = process.argv.slice(2);
  /** @type {Record<string, string | boolean>} */ const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index], value = args[index + 1];
    if (flag === "--launch") parsed.launch = true;
    else if (flag?.startsWith("--") && value) { parsed[flag.slice(2)] = value; index += 1; }
    else throw new Error(`Unsupported bundle verification argument: ${flag}`);
  }
  if (typeof parsed.app !== "string" || typeof parsed.node !== "string" || typeof parsed.payload !== "string" || typeof parsed.output !== "string") throw new Error("--app, --node, --payload, and --output are required.");
  const sourceLoomPayloadPath = typeof parsed["loom-payload"] === "string" ? parsed["loom-payload"] : (typeof parsed.loomPayload === "string" ? parsed.loomPayload : undefined);
  const sourceSolarSailPayloadPath = typeof parsed["solar-sail-payload"] === "string" ? parsed["solar-sail-payload"] : (typeof parsed.solarSailPayload === "string" ? parsed.solarSailPayload : undefined);
  const sourceScenePayloadPath = typeof parsed["scene-payload"] === "string" ? parsed["scene-payload"] : (typeof parsed.scenePayload === "string" ? parsed.scenePayload : undefined);
  const sourceCandidate = typeof parsed["source-candidate"] === "string" ? parsed["source-candidate"] : undefined;
  const solarSailRoute = typeof parsed["solar-sail-route"] === "string" ? parsed["solar-sail-route"] : undefined;
  const solarSailBuildPinPath = typeof parsed["solar-sail-build-pin"] === "string" ? parsed["solar-sail-build-pin"] : undefined;
  const sceneSourceCandidate = typeof parsed["scene-source-candidate"] === "string" ? parsed["scene-source-candidate"] : undefined;
  const sceneRoute = typeof parsed["scene-route"] === "string" ? parsed["scene-route"] : undefined;
  const sceneBuildPinPath = typeof parsed["scene-build-pin"] === "string" ? parsed["scene-build-pin"] : undefined;
  verifyNebularBundle({
    appPath: parsed.app,
    sourceNodePath: parsed.node,
    sourcePayloadPath: parsed.payload,
    ...(sourceLoomPayloadPath !== undefined ? { sourceLoomPayloadPath } : {}),
    ...(sourceSolarSailPayloadPath !== undefined ? { sourceSolarSailPayloadPath } : {}),
    ...(sourceScenePayloadPath !== undefined ? { sourceScenePayloadPath } : {}),
    ...(sourceCandidate !== undefined ? { sourceCandidate } : {}),
    ...(solarSailRoute !== undefined ? { solarSailRoute: /** @type {SolarSailRoute} */ (solarSailRoute) } : {}),
    ...(solarSailBuildPinPath !== undefined ? { solarSailBuildPinPath } : {}),
    ...(sceneSourceCandidate !== undefined ? { sceneSourceCandidate } : {}),
    ...(sceneRoute !== undefined ? { sceneRoute: /** @type {SceneRoute} */ (sceneRoute) } : {}),
    ...(sceneBuildPinPath !== undefined ? { sceneBuildPinPath } : {}),
    outputPath: parsed.output,
    launch: parsed.launch === true,
  })
    .then((receipt) => process.stdout.write(`${JSON.stringify(receipt)}\n`))
    .catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
