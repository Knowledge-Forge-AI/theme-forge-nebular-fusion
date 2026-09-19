// @ts-check
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const OPTIONAL_SCENE_RESOURCE = "scene-payload/**/*";
export const SOLAR_SAIL_RESOURCE = "solar-sail-payload/**/*";
export const OPTIONAL_RESOURCE_SET = Object.freeze(new Set([OPTIONAL_SCENE_RESOURCE]));

export const BASELINE_RESOURCES = Object.freeze([
  "sidecar-payload/**/*",
  "loom-payload/**/*",
  "loom-adapter/**/*",
  "solar-sail-payload/**/*",
  "solar-sail-adapter/**/*",
  "scene-payload/**/*",
  "release-notices/**/*",
]);

export const REQUIRED_BASELINE_RESOURCES = Object.freeze(
  BASELINE_RESOURCES.filter((r) => !OPTIONAL_RESOURCE_SET.has(r))
);

export const DEFAULT_TARGET = "aarch64-apple-darwin";
export const HEX64_RE = /^[0-9a-f]{64}$/;

/**
 * Validates that a filename is a non-empty safe single-component path.
 * @param {unknown} filename
 * @returns {boolean}
 */
export function isSafeFilename(filename) {
  if (typeof filename !== "string" || filename.trim().length === 0) {
    return false;
  }
  if (filename.includes("/") || filename.includes("\\")) {
    return false;
  }
  if (filename === "." || filename === "..") {
    return false;
  }
  if (filename.trim() !== filename) {
    return false;
  }
  if (/[\x00-\x1f\x7f]/.test(filename)) {
    return false;
  }
  return true;
}

/**
 * Asserts that baseline resource projection has not drifted from the authoritative private configuration.
 * @param {string} privateTauriConfPath
 */
export async function assertNoBaselineDrift(privateTauriConfPath) {
  let raw;
  try {
    raw = await readFile(privateTauriConfPath, "utf8");
  } catch (err) {
    throw new Error(`[RESOURCE_CLOSURE_FAIL] Cannot read baseline tauri.conf.json at ${privateTauriConfPath}: ${/** @type {Error} */ (err).message}`);
  }
  const config = JSON.parse(raw);
  const actualResources = config.bundle?.resources;
  if (!Array.isArray(actualResources)) {
    throw new Error("[RESOURCE_CLOSURE_FAIL] Baseline tauri.conf.json missing bundle.resources");
  }
  if (JSON.stringify(actualResources) !== JSON.stringify(BASELINE_RESOURCES)) {
    throw new Error(
      `[RESOURCE_CLOSURE_FAIL] Baseline resource drift detected between verifier projection and private config.\n` +
      `Expected: ${JSON.stringify(BASELINE_RESOURCES)}\n` +
      `Actual:   ${JSON.stringify(actualResources)}`
    );
  }
  return true;
}

/**
 * Validates that a resource pattern does not escape the src-tauri root.
 * @param {string} srcTauriDir
 * @param {string} pattern
 */
export function validateResourcePatternPath(srcTauriDir, pattern) {
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new Error("[RESOURCE_CLOSURE_FAIL] Resource pattern must be a non-empty string");
  }
  if (pattern.startsWith("/") || pattern.startsWith("\\")) {
    throw new Error(`[RESOURCE_CLOSURE_FAIL] Resource pattern escapes src-tauri root (absolute path): ${pattern}`);
  }
  const parts = pattern.split(/[/\\]/);
  if (parts.some((p) => p === "..")) {
    throw new Error(`[RESOURCE_CLOSURE_FAIL] Resource pattern escapes src-tauri root (traversal segment '..'): ${pattern}`);
  }
  const prefix = pattern.split("*")[0].replace(/[/\\]+$/, "");
  const resolved = resolve(srcTauriDir, prefix);
  const rel = relative(srcTauriDir, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`[RESOURCE_CLOSURE_FAIL] Resource pattern escapes src-tauri root: ${pattern}`);
  }
}

/**
 * Recursively collects regular files relative to rootDir.
 * Structurally avoids TOCTOU check-then-open patterns by relying on withFileTypes entries.
 * @param {string} rootDir
 * @param {string} currentDir
 * @returns {Promise<string[]>}
 */
async function collectFilesRecursive(rootDir, currentDir) {
  /** @type {string[]} */
  const results = [];
  let entries;
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") {
      return [];
    }
    throw err;
  }
  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      const subFiles = await collectFilesRecursive(rootDir, fullPath);
      results.push(...subFiles);
    } else if (entry.isFile()) {
      results.push(relative(rootDir, fullPath).replace(/\\/g, "/"));
    }
  }
  return results.sort();
}

/**
 * Resolves resource patterns relative to srcTauriDir and returns matching relative paths.
 * @param {string} srcTauriDir
 * @param {string} pattern
 * @returns {Promise<string[]>}
 */
export async function resolveResourcePattern(srcTauriDir, pattern) {
  validateResourcePatternPath(srcTauriDir, pattern);

  if (!pattern.includes("*")) {
    const fullPath = resolve(srcTauriDir, pattern);
    try {
      const s = await stat(fullPath);
      if (s.isFile()) {
        return [relative(srcTauriDir, fullPath).replace(/\\/g, "/")];
      }
      if (s.isDirectory()) {
        return await collectFilesRecursive(srcTauriDir, fullPath);
      }
      return [];
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") {
        return [];
      }
      throw err;
    }
  }

  if (pattern.endsWith("/**/*")) {
    const baseDir = pattern.slice(0, -"/**/*".length);
    const fullBaseDir = resolve(srcTauriDir, baseDir);
    return await collectFilesRecursive(srcTauriDir, fullBaseDir);
  }

  if (pattern.endsWith("/*")) {
    const baseDir = pattern.slice(0, -"/*".length);
    const fullBaseDir = resolve(srcTauriDir, baseDir);
    let entries;
    try {
      entries = await readdir(fullBaseDir, { withFileTypes: true });
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") {
        return [];
      }
      throw err;
    }
    return entries
      .filter((e) => e.isFile())
      .map((e) => relative(srcTauriDir, join(fullBaseDir, e.name)).replace(/\\/g, "/"))
      .sort();
  }

  const prefix = pattern.split("*")[0].replace(/[/\\]+$/, "");
  const fullPrefix = resolve(srcTauriDir, prefix);
  return await collectFilesRecursive(srcTauriDir, fullPrefix);
}

/**
 * Validates externalBin definitions in tauri.conf.json.
 * In buildReady mode, requires the target-triple-suffixed binary to exist and be executable.
 * Bare unsuffixed binaries do NOT satisfy the check.
 * @param {string} srcTauriDir
 * @param {unknown} externalBinList
 * @param {string} target
 * @param {boolean} buildReady
 */
export async function validateExternalBin(srcTauriDir, externalBinList, target, buildReady) {
  if (!Array.isArray(externalBinList)) return [];
  const results = [];
  for (const bin of externalBinList) {
    if (typeof bin !== "string" || bin.length === 0) {
      throw new Error("[RESOURCE_CLOSURE_FAIL] externalBin entry must be a non-empty string");
    }
    if (bin.startsWith("/") || bin.startsWith("\\") || bin.split(/[/\\]/).some((p) => p === "..")) {
      throw new Error(`[RESOURCE_CLOSURE_FAIL] externalBin entry escapes src-tauri root: ${bin}`);
    }
    const resolvedBare = resolve(srcTauriDir, bin);
    const relBare = relative(srcTauriDir, resolvedBare);
    if (relBare.startsWith("..") || isAbsolute(relBare)) {
      throw new Error(`[RESOURCE_CLOSURE_FAIL] externalBin entry escapes src-tauri root: ${bin}`);
    }

    if (buildReady) {
      const ext = target.includes("windows") ? ".exe" : "";
      const suffixedRel = `${bin}-${target}${ext}`;
      const suffixedPath = resolve(srcTauriDir, suffixedRel);
      try {
        const s = await stat(suffixedPath);
        if (!s.isFile()) {
          throw new Error(`[RESOURCE_CLOSURE_FAIL] Target-suffixed external binary is not a regular file: ${suffixedRel}`);
        }
        if (process.platform !== "win32" && (s.mode & 0o111) === 0) {
          throw new Error(`[RESOURCE_CLOSURE_FAIL] Target-suffixed external binary is not executable: ${suffixedRel}`);
        }
        results.push({ name: bin, target, suffixedPath: suffixedRel, size: s.size });
      } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") {
          throw new Error(
            `[RESOURCE_CLOSURE_FAIL] Target-suffixed external binary does not exist for target '${target}': expected '${suffixedRel}'`
          );
        }
        throw err;
      }
    } else {
      results.push({ name: bin, target: null, suffixedPath: null });
    }
  }
  return results;
}

/**
 * @typedef {Object} VerifyClosureOptions
 * @property {string} [appDir] - Root of application or repository containing src-tauri/
 * @property {string} [srcTauriDir] - Explicit src-tauri directory
 * @property {string} [bindingPath] - Explicit path to stellar-binding.json
 * @property {string} [authInputsDir] - Explicit path to authenticated-inputs/
 * @property {string} [target] - Build target triple (defaults to aarch64-apple-darwin)
 * @property {boolean} [buildReady] - Enforce build-ready resource presence and suffixed binary
 */

/**
 * Verifies Tauri resource closure, optional Scene capability contract, and external binaries.
 * @param {VerifyClosureOptions} [options]
 */
export async function verifyTauriResourceClosure(options = {}) {
  const target = options.target || process.env.TARGET || DEFAULT_TARGET;
  const buildReady = Boolean(options.buildReady);

  // Determine root directories
  let appDir = options.appDir ? resolve(options.appDir) : null;
  let srcTauriDir = options.srcTauriDir ? resolve(options.srcTauriDir) : null;

  if (!srcTauriDir) {
    if (appDir) {
      if (appDir.endsWith("src-tauri")) {
        srcTauriDir = appDir;
        appDir = dirname(appDir);
      } else {
        srcTauriDir = join(appDir, "src-tauri");
      }
    } else {
      // Default resolution from cwd
      const cwd = process.cwd();
      if (cwd.endsWith("src-tauri")) {
        srcTauriDir = cwd;
        appDir = dirname(cwd);
      } else {
        appDir = cwd;
        srcTauriDir = join(appDir, "src-tauri");
      }
    }
  }

  if (!appDir) {
    appDir = dirname(srcTauriDir);
  }

  const tauriConfPath = join(srcTauriDir, "tauri.conf.json");
  let tauriConfRaw;
  try {
    tauriConfRaw = await readFile(tauriConfPath, "utf8");
  } catch (err) {
    // If studio root fallback
    const studioSrcTauri = join(appDir, "apps/studio/src-tauri");
    const studioTauriConf = join(studioSrcTauri, "tauri.conf.json");
    try {
      tauriConfRaw = await readFile(studioTauriConf, "utf8");
      srcTauriDir = studioSrcTauri;
    } catch {
      throw new Error(`[RESOURCE_CLOSURE_FAIL] Cannot read tauri.conf.json at ${tauriConfPath}: ${/** @type {Error} */ (err).message}`);
    }
  }

  const config = JSON.parse(tauriConfRaw);
  const declaredResources = Array.isArray(config.bundle?.resources) ? config.bundle.resources : [];

  // 1. Root / path escape checks on all declared resources
  for (const pattern of declaredResources) {
    validateResourcePatternPath(srcTauriDir, pattern);
  }

  // 2. Derive required resources: REQUIRED_BASELINE_RESOURCES must be declared
  for (const required of REQUIRED_BASELINE_RESOURCES) {
    if (!declaredResources.includes(required)) {
      throw new Error(
        `[RESOURCE_CLOSURE_FAIL] Required resource '${required}' is omitted from tauri.conf.json and is not declared optional`
      );
    }
  }

  // 3. Evaluate in-tree authority for optional resources (Scene payload)
  const authInputsDir = options.authInputsDir ?? join(appDir, "authenticated-inputs");
  const bindingPath = options.bindingPath ?? join(authInputsDir, "stellar-binding.json");

  let stellarBinding;
  try {
    const raw = await readFile(bindingPath, "utf8");
    stellarBinding = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `[RESOURCE_CLOSURE_FAIL] Cannot read or parse stellar-binding.json at ${bindingPath}: ${/** @type {Error} */ (err).message}`
    );
  }

  if (!stellarBinding || typeof stellarBinding !== "object" || Array.isArray(stellarBinding)) {
    throw new Error(
      `[RESOURCE_CLOSURE_FAIL] stellar-binding.json at ${bindingPath} must contain a JSON object`
    );
  }

  const hasSceneResource = declaredResources.includes(OPTIONAL_SCENE_RESOURCE);
  const sceneRecord = stellarBinding.scene;
  const sceneStatus = sceneRecord && typeof sceneRecord === "object" ? sceneRecord.status : undefined;

  if (!hasSceneResource) {
    // Scene is omitted from tauri.conf.json
    if (sceneStatus !== "omitted-by-contract") {
      throw new Error(
        `[RESOURCE_CLOSURE_FAIL] Resource '${OPTIONAL_SCENE_RESOURCE}' is omitted from tauri.conf.json, ` +
        `but stellar-binding.json does not authorize 'omitted-by-contract' (found: ${JSON.stringify(sceneStatus ?? null)})`
      );
    }
  } else {
    // Scene is declared in tauri.conf.json
    if (sceneStatus === "omitted-by-contract") {
      throw new Error(
        `[RESOURCE_CLOSURE_FAIL] Optional state in stellar-binding.json specifies 'omitted-by-contract', ` +
        `but tauri.conf.json still declares '${OPTIONAL_SCENE_RESOURCE}'`
      );
    }
    if (sceneStatus !== "included-authenticated") {
      throw new Error(
        `[RESOURCE_CLOSURE_FAIL] Resource '${OPTIONAL_SCENE_RESOURCE}' is declared in tauri.conf.json, ` +
        `but stellar-binding.json does not authorize 'included-authenticated' (found: ${JSON.stringify(sceneStatus ?? null)})`
      );
    }

    if (!sceneRecord || typeof sceneRecord !== "object" || Array.isArray(sceneRecord)) {
      throw new Error(
        `[RESOURCE_CLOSURE_FAIL] Resource '${OPTIONAL_SCENE_RESOURCE}' is declared with 'included-authenticated', but scene record is missing or invalid`
      );
    }

    if (!isSafeFilename(sceneRecord.filename)) {
      throw new Error(
        `[RESOURCE_CLOSURE_FAIL] Authenticated scene archive requires a non-empty safe filename (found: ${JSON.stringify(sceneRecord.filename ?? null)})`
      );
    }

    if (typeof sceneRecord.sha256 !== "string" || !HEX64_RE.test(sceneRecord.sha256)) {
      throw new Error(
        `[RESOURCE_CLOSURE_FAIL] Authenticated scene archive requires a 64-character lowercase hex sha256 (found: ${JSON.stringify(sceneRecord.sha256 ?? null)})`
      );
    }

    if (
      typeof sceneRecord.bytes !== "number" ||
      !Number.isSafeInteger(sceneRecord.bytes) ||
      sceneRecord.bytes <= 0
    ) {
      throw new Error(
        `[RESOURCE_CLOSURE_FAIL] Authenticated scene archive requires a positive integer byte count (found: ${JSON.stringify(sceneRecord.bytes ?? null)})`
      );
    }

    if (
      typeof sceneRecord.sourceTreeDigest !== "string" ||
      !HEX64_RE.test(sceneRecord.sourceTreeDigest)
    ) {
      throw new Error(
        `[RESOURCE_CLOSURE_FAIL] Authenticated scene archive requires a 64-character lowercase hex sourceTreeDigest (found: ${JSON.stringify(sceneRecord.sourceTreeDigest ?? null)})`
      );
    }
  }

  // 4. In build-ready mode, verify resource closure and zero-member globs
  /** @type {Record<string, string[]>} */
  const resolvedResources = {};
  if (buildReady) {
    for (const pattern of declaredResources) {
      const matches = await resolveResourcePattern(srcTauriDir, pattern);
      if (matches.length === 0) {
        throw new Error(
          `[RESOURCE_CLOSURE_FAIL] Resource declaration '${pattern}' resolved to zero members on disk`
        );
      }
      resolvedResources[pattern] = matches;
    }
  }

  // 5. Validate external binaries
  const externalBinaries = await validateExternalBin(
    srcTauriDir,
    config.bundle?.externalBin,
    target,
    buildReady
  );

  return {
    status: "pass",
    appDir,
    srcTauriDir,
    target,
    buildReady,
    declaredResources,
    resolvedResources: buildReady ? resolvedResources : null,
    optionalSceneState: hasSceneResource ? "included-authenticated" : "omitted-by-contract",
    externalBinaries,
  };
}

const invokedDirectly = process.argv[1] !== undefined &&
  resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (invokedDirectly) {
  const args = process.argv.slice(2);
  let appDir = undefined;
  let srcTauriDir = undefined;
  let target = undefined;
  let buildReady = false;
  let bindingPath = undefined;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--build-ready") {
      buildReady = true;
    } else if (arg === "--mode") {
      const mode = args[++i];
      if (mode === "build-ready") {
        buildReady = true;
      } else if (mode === "composition") {
        buildReady = false;
      } else {
        console.error(`Unknown mode: ${mode}`);
        process.exit(1);
      }
    } else if (arg === "--tauri-dir") {
      srcTauriDir = args[++i];
    } else if (arg === "--app-dir" || arg === "--root") {
      appDir = args[++i];
    } else if (arg === "--target") {
      target = args[++i];
    } else if (arg === "--binding") {
      bindingPath = args[++i];
    } else if (arg === "--json") {
      jsonOutput = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node verify-tauri-resource-closure.mjs [--build-ready | --mode <build-ready|composition>] [--tauri-dir <dir>] [--target <triple>] [--app-dir <dir>] [--binding <path>] [--json]");
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }

  verifyTauriResourceClosure({ appDir, srcTauriDir, target, buildReady, bindingPath })
    .then((result) => {
      if (jsonOutput) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`[VERIFY] OK: Tauri resource closure verified (buildReady=${result.buildReady}, sceneState=${result.optionalSceneState})`);
      }
    })
    .catch((err) => {
      console.error(`[RESOURCE_CLOSURE_FAIL] ${err.message}`);
      process.exit(1);
    });
}
