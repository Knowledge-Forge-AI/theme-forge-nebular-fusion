import { readFile, stat, lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { digest, identity } from "./candidate-provenance.mjs";
import { defaultSnapshotReader } from "./fs-snapshot.mjs";

/** @typedef {{dev: number, ino: number, size: number, mode: number, mtimeMs: number, ctimeMs: number}} DescriptorIdentity */
/** @typedef {{type: string, bytes?: Buffer, sha256?: string, size?: number, mode?: number, executable?: boolean, entries?: string[], identity: DescriptorIdentity}} SnapshotDescriptor */
/** @typedef {{type: string, size: number, mode: number, identity: DescriptorIdentity}} SnapshotDescription */
/** @typedef {{bytes: Buffer, sha256: string, size: number, mode: number, executable: boolean, identity: DescriptorIdentity}} SnapshotFile */
/** @typedef {{describe: (path: string, options?: object) => SnapshotDescription | null, inspect: (path: string, options?: object) => SnapshotDescriptor | null, readRegular: (path: string, options?: object) => SnapshotFile | null}} SnapshotReader */
/** @typedef {{type: "executionOnly", reason: string} | {type: "locator", multi: boolean} | {type: "semantic"}} EnvironmentClassification */
/** @typedef {{path: string, identity: string, entries?: Array<{path: string, identity: string}>}} LocatorInventory */
/** @typedef {{value: string, reason: string}} ExecutionOnlyValue */
/** @typedef {{path: string, identity: string}} CargoLocator */
/** @typedef {{type: "file", bytes: number, size?: number, sha256: string, mode: number, executable?: boolean} | {type: "directory", entries: Array<{name: string, identity: string}>, mode?: number}} SnapshotInventoryRecord */
/** @typedef {{content: string, identity: string, locators: CargoLocator[]}} CargoSettings */
/** @typedef {{identity?: string, cargo?: CargoSettings | null, environment?: {semantic?: Record<string, string>, locators?: Record<string, LocatorInventory | string>, executionOnly?: Record<string, ExecutionOnlyValue>}, claims?: unknown}} BuildSettings */
/** @typedef {{cargoConfig?: string, cargoHome?: string, npmCache?: string, frontendModules?: string, previewModules?: string, cwd?: string, environment?: Record<string, string>}} ExecutionSettings */

export const EXECUTION_ONLY_REASONS = Object.freeze({
  NIX_STORE: "Fixed canonical Nix store mount / execution prefix",
  NIX_BUILD_TOP: "Caller locator is replaced by the native builder's owned work directory; compiler path remapping uses that execution root",
});

/** @param {string} key @returns {EnvironmentClassification | null} */
export function classifyEnvironmentKey(key) {
  if (key === "NIX_STORE" || key === "NIX_BUILD_TOP") return { type: "executionOnly", reason: EXECUTION_ONLY_REASONS[key] };
  if (["SDKROOT", "DEVELOPER_DIR", "NIX_CC", "NIX_BINTOOLS"].includes(key)) {
    return { type: "locator", multi: false };
  }
  if (["PKG_CONFIG_PATH", "PKG_CONFIG_LIBDIR"].includes(key)) {
    return { type: "locator", multi: true };
  }
  if (key === "MACOSX_DEPLOYMENT_TARGET") return { type: "semantic" };
  if (/^NIX_CC_WRAPPER_TARGET_(?:BUILD|HOST|TARGET)_[a-zA-Z0-9_]+$/.test(key)) return { type: "semantic" };
  if (/^NIX_(?:CFLAGS_COMPILE|LDFLAGS)(?:_FOR_BUILD|_FOR_TARGET)?$/.test(key)) return { type: "semantic" };
  return null;
}

/** @param {string} key */
export function isBuildEnvironmentKey(key) {
  return classifyEnvironmentKey(key) !== null;
}

/** @param {string} raw */
export function normalizeCargoConfig(raw) {
  if (typeof raw !== "string") throw new Error("Cargo config content must be a string");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) continue;
    const keyEnd = trimmed.indexOf("=");
    if (keyEnd >= 0 && trimmed.slice(0, keyEnd).includes("\\")) throw new Error("Escaped Cargo config keys are unsupported");
  }
  if (/^\s*["\']?include["\']?\s*=/m.test(raw)) {
    throw new Error("Cargo config include directive is unsupported");
  }
  for (const match of raw.matchAll(/^\s*(?:directory|path)\s*=\s*["']([^"']+)["']/gm)) {
    const capturedPath = match[1];
    if (capturedPath !== undefined && !capturedPath.startsWith("/")) {
      throw new Error(`Unsupported relative path in Cargo config: ${capturedPath}`);
    }
  }
  return raw;
}

/** @param {string} content @returns {string[]} */
export function extractCargoConfigLocators(content) {
  if (typeof content !== "string") throw new Error("Cargo config content must be a string");
  /** @type {string[]} */
  const locators = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) continue;
    const matches = trimmed.matchAll(/["'](\/[^"']+)["']/g);
    for (const match of matches) {
      const capturedPath = match[1];
      if (capturedPath !== undefined) locators.push(capturedPath);
    }
  }
  return [...new Set(locators)].sort();
}

// Hash resolved content, including executable mode. Alias paths are locators;
// internal links bind their root-relative destination, whose bytes are already
// inventoried by the physical tree walk. This handles SDK aliases/backlinks
// without recursive expansion. External referents are content-bound separately.
//
// Each resolved member is opened once without following a final link. Its type
// and mode come from that descriptor, file bytes are read through it, and a
// directory is listed while its descriptor is held and must be unchanged (and
// still named by its path) afterwards. A member that is swapped for a link,
// replaced, truncated or changed while it is measured fails closed.
/**
 * @param {string} targetPath
 * @param {{reader?: SnapshotReader}} [options]
 * @returns {Promise<{path: string, identity: string}>}
 */
export async function inventoryPath(targetPath, { reader = defaultSnapshotReader } = {}) {
  if (typeof targetPath !== "string" || !isAbsolute(targetPath)) throw new Error("Locator path must be absolute");
  const root = await realpath(targetPath);
  const cache = new Map(), active = new Set();
  let count = 0, totalBytes = 0;
  const member = {
    label: "Locator member",
    maxBytes: 256 * 1024 * 1024,
    messages: { tooLarge: "Locator inventory byte limit exceeded", unsupported: "Unsupported locator member type" },
  };
  /** @returns {Promise<{identity: string, isDirectory: boolean}>} */
  /** @param {string} path */
  async function visit(path, depth = 0, scopeRoot = root) {
    const real = await realpath(path);
    let referent = null;
    if ((await lstat(path)).isSymbolicLink()) {
      referent = reader.describe(real, member);
      if (!referent) throw new Error(`Locator member disappeared while it was read: ${real}`);
      const rel = relative(scopeRoot, real);
      if (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel)) {
        return { identity: identity({ type: "internal-link", target: rel || "." }), isDirectory: referent.type === "directory" };
      }
      // External directory inputs (for example SDK ncurses headers) have their
      // own internal aliases. Inventory that complete referent as its own root.
      if (referent.type === "directory") scopeRoot = real;
    }
    if (active.has(real)) throw new Error("Locator directory cycle detected");
    const cacheKey = `${scopeRoot}\0${real}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    if (depth > 64 || ++count > 100000) throw new Error("Locator inventory traversal limit exceeded");
    const measured = reader.inspect(real, member);
    if (!measured) throw new Error(`Locator member disappeared while it was read: ${real}`);
    if (referent && referent.type !== measured.type) throw new Error(`Locator member changed while it was read: ${real}`);
    /** @type {SnapshotInventoryRecord} */
    let record;
    if (measured.type === "file") {
      if (typeof measured.size !== "number" || typeof measured.executable !== "boolean" || typeof measured.sha256 !== "string") {
        throw new Error(`Invalid file descriptor for locator member: ${real}`);
      }
      if ((totalBytes += measured.size) > 2 * 1024 * 1024 * 1024) throw new Error("Locator inventory byte limit exceeded");
      record = { type: "file", mode: measured.executable ? 0o755 : 0o644, bytes: measured.size, sha256: measured.sha256 };
    } else if (measured.type === "directory") {
      if (!Array.isArray(measured.entries)) throw new Error(`Invalid directory descriptor for locator member: ${real}`);
      active.add(real);
      try {
      /** @type {Array<{name: string, identity: string}>} */
      const entries = [];
        for (const name of measured.entries) {
          if (name.length > 1024) throw new Error("Locator member path limit exceeded");
          entries.push({ name, identity: (await visit(join(real, name), depth + 1, scopeRoot)).identity });
        }
        record = { type: "directory", entries };
      } finally { active.delete(real); }
    } else {
      throw new Error(`Unsupported locator member type: ${real}`);
    }
    /** @type {{identity: string, isDirectory: boolean}} */
    const result = { identity: identity(record), isDirectory: measured.type === "directory" };
    cache.set(cacheKey, result);
    return result;
  }
  return { path: resolve(targetPath), ...await visit(root) };
}

/** @param {string} value @param {boolean} [isMulti] */
export async function inventoryLocator(value, isMulti = false) {
  if (typeof value !== "string") throw new Error("Locator value must be a string");
  if (isMulti) {
    const parts = value.split(":").filter(Boolean);
    if (parts.length === 0) throw new Error("Locator path cannot be empty");
    for (const part of parts) {
      if (!isAbsolute(part)) throw new Error(`Locator path must be absolute: ${part}`);
    }
    /** @type {Array<{path: string, identity: string}>} */
    const entries = [];
    for (const part of parts) {
      entries.push(await inventoryPath(part));
    }
    return {
      path: value,
      identity: identity(entries.map(e => e.identity)),
      entries,
    };
  } else {
    if (!isAbsolute(value)) throw new Error(`Locator path must be absolute: ${value}`);
    const inv = await inventoryPath(value);
    return {
      path: value,
      identity: inv.identity,
    };
  }
}

/** @param {{cargoConfig?: string | undefined, environment?: Record<string, string>}} options */
export async function createBuildSettings({ cargoConfig, environment = {} }) {
  let cargo = null;
  if (cargoConfig) {
    if (typeof cargoConfig !== "string" || !isAbsolute(cargoConfig)) {
      throw new Error(`Cargo config path must be absolute: ${cargoConfig}`);
    }
    const configPath = resolve(cargoConfig);
    const raw = await readFile(configPath, "utf8");
    const normalized = normalizeCargoConfig(raw);
    const extractedPaths = extractCargoConfigLocators(normalized);
    /** @type {CargoLocator[]} */
    const locators = [];
    for (const p of extractedPaths) {
      const inv = await inventoryPath(p);
      locators.push({ path: p, identity: inv.identity });
    }
    locators.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    cargo = {
      content: normalized,
      identity: digest(Buffer.from(normalized)),
      locators,
    };
  }

  /** @type {Record<string, string>} */
  const semantic = {};
  /** @type {Record<string, LocatorInventory>} */
  const locators = {};
  /** @type {Record<string, ExecutionOnlyValue>} */
  const executionOnly = {};

  for (const [key, value] of Object.entries(environment)) {
    if (typeof value !== "string") throw new Error(`Environment value for ${key} must be a string`);
    const classification = classifyEnvironmentKey(key);
    if (!classification) throw new Error(`Unknown build environment setting: ${key}`);

    if (classification.type === "semantic") {
      semantic[key] = value;
    } else if (classification.type === "executionOnly") {
      if (key === "NIX_STORE") {
        if (value !== "/nix/store") throw new Error("NIX_STORE must be fixed /nix/store");
      } else if (key === "NIX_BUILD_TOP") {
        if (!isAbsolute(value)) throw new Error("NIX_BUILD_TOP must be an absolute path");
        const st = await stat(value);
        if (!st.isDirectory()) throw new Error("NIX_BUILD_TOP must be a directory");
      }
      executionOnly[key] = { value, reason: classification.reason };
    } else if (classification.type === "locator") {
      const inv = await inventoryLocator(value, classification.multi);
      locators[key] = inv;
    }
  }

  const envClaims = {
    semantic: Object.fromEntries(Object.keys(semantic).sort().map(k => [k, semantic[k]])),
    locators: Object.fromEntries(Object.keys(locators).sort().map(k => {
      const locator = locators[k];
      if (!locator) throw new Error(`Locator identity missing: ${k}`);
      return [k, locator.identity];
    })),
  };
  const cargoClaims = cargo ? { identity: cargo.identity, locators: cargo.locators.map(l => l.identity).sort() } : null;
  const claims = { cargo: cargoClaims, environment: envClaims };
  const settingsId = identity(claims);

  return {
    identity: settingsId,
    cargo,
    environment: {
      semantic,
      locators,
      executionOnly,
    },
    claims,
  };
}

/** @param {BuildSettings | null | undefined} settings */
export function buildSettingsClaims(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("Explicit build settings required");
  if (typeof settings.identity !== "string" || !/^[a-f0-9]{64}$/.test(settings.identity)) throw new Error("Settings identity required");
  const allowedSettingsKeys = new Set(["identity", "cargo", "environment", "claims"]);
  for (const key of Object.keys(settings)) {
    if (!allowedSettingsKeys.has(key)) throw new Error(`Unknown settings field: ${key}`);
  }

  let cargoClaims = null;
  if (settings.cargo) {
    const allowedCargoKeys = new Set(["content", "identity", "locators"]);
    for (const key of Object.keys(settings.cargo)) {
      if (!allowedCargoKeys.has(key)) throw new Error(`Unknown settings.cargo field: ${key}`);
    }
    if (typeof settings.cargo.content !== "string" || !/^[a-f0-9]{64}$/.test(settings.cargo.identity)) {
      throw new Error("Invalid settings.cargo structure");
    }
    normalizeCargoConfig(settings.cargo.content);
    if (digest(Buffer.from(settings.cargo.content)) !== settings.cargo.identity) throw new Error("Cargo staged content identity mismatch");
    if (!Array.isArray(settings.cargo.locators)
        || JSON.stringify(settings.cargo.locators.map(l => l.path).sort()) !== JSON.stringify(extractCargoConfigLocators(settings.cargo.content))) {
      throw new Error("Cargo internal locator coverage mismatch");
    }
    for (const locator of settings.cargo.locators) {
      if (!/^[a-f0-9]{64}$/.test(locator.identity)) throw new Error("Cargo internal locator identity required");
    }
    cargoClaims = {
      identity: settings.cargo.identity,
      locators: (settings.cargo.locators ?? []).map(l => typeof l === "string" ? l : l.identity).sort(),
    };
  }

  const envObj = settings.environment ?? {};
  const allowedEnvKeys = new Set(["semantic", "locators", "executionOnly"]);
  for (const key of Object.keys(envObj)) {
    if (!allowedEnvKeys.has(key)) throw new Error(`Unknown settings.environment field: ${key}`);
  }

  const semantic = envObj.semantic ?? {};
  const locators = envObj.locators ?? {};
  for (const [type, records] of [["semantic", semantic], ["locator", locators], ["executionOnly", envObj.executionOnly ?? {}]]) {
    if (!records || typeof records !== "object" || Array.isArray(records)) throw new Error("Invalid environment settings group");
    for (const [key, value] of Object.entries(records)) {
      if (classifyEnvironmentKey(key)?.type !== type) throw new Error(`Invalid environment field ownership: ${key}`);
      if (type === "semantic" && typeof value !== "string") throw new Error("Invalid semantic environment setting");
      if (type === "locator" && !/^[a-f0-9]{64}$/.test(value?.identity)) throw new Error("Locator identity required");
    }
  }
  const envClaims = {
    semantic: Object.fromEntries(Object.keys(semantic).sort().map(k => [k, semantic[k]])),
    locators: Object.fromEntries(Object.keys(locators).sort().map(k => {
      const locator = locators[k];
      if (!locator) throw new Error(`Locator identity missing: ${k}`);
      return [k, typeof locator === "string" ? locator : locator.identity];
    })),
  };
  const claims = { cargo: cargoClaims, environment: envClaims };
  const expectedId = identity(claims);
  if (settings.identity && settings.identity !== expectedId) {
    throw new Error("Settings identity mismatch");
  }
  if (settings.claims && identity(settings.claims) !== expectedId) {
    throw new Error("Inconsistent settings.claims in build settings");
  }
  return { ...claims, identity: expectedId };
}

/**
 * @param {BuildSettings | null | undefined} settings
 * @param {ExecutionSettings | null | undefined} [execution]
 * @param {{reader?: SnapshotReader}} [options]
 */
export async function validateBuildSettings(settings, execution = {}, { reader = defaultSnapshotReader } = {}) {
  if (!settings || typeof settings !== "object") {
    throw new Error("Explicit build settings required");
  }
  const claims = buildSettingsClaims(settings);
  if (settings.identity !== claims.identity) {
    throw new Error("Settings identity mismatch");
  }

  if (!execution || typeof execution !== "object" || Array.isArray(execution)) {
    throw new Error("Execution settings must be an object");
  }
  const allowedExecKeys = new Set(["cargoConfig", "cargoHome", "npmCache", "frontendModules", "previewModules", "environment", "cwd"]);
  for (const key of Object.keys(execution)) {
    if (!allowedExecKeys.has(key)) throw new Error(`Unknown execution setting: ${key}`);
  }
  /** @type {Array<"cargoHome" | "npmCache" | "frontendModules" | "previewModules" | "cwd">} */
  const executionLocatorKeys = ["cargoHome", "npmCache", "frontendModules", "previewModules", "cwd"];
  for (const key of executionLocatorKeys) {
    if (execution[key] !== undefined && (typeof execution[key] !== "string" || !isAbsolute(execution[key]))) throw new Error(`Absolute execution locator required: ${key}`);
  }

  // Cargo settings and config parity
  if (settings.cargo) {
    if (!execution.cargoConfig) {
      throw new Error("execution.cargoConfig required when cargo settings are present");
    }
    if (!isAbsolute(execution.cargoConfig)) throw new Error("Cargo config path must be absolute");
    const raw = await readFile(execution.cargoConfig, "utf8");
    normalizeCargoConfig(raw);
    if (digest(Buffer.from(raw)) !== settings.cargo.identity) {
      throw new Error("Cargo config content mismatch");
    }
    for (const locator of settings.cargo.locators ?? []) {
      const inv = await inventoryPath(locator.path);
      if (inv.identity !== locator.identity) {
        throw new Error(`Internal locator bytes mismatch: ${locator.path}`);
      }
    }
  } else {
    if (execution.cargoConfig) {
      throw new Error("execution.cargoConfig cannot be provided when cargo settings are null");
    }
  }

  // cargoHome verification. Each candidate configuration is opened once; the
  // bytes that are compared are the bytes Cargo would find at that name. Only a
  // missing file is absent: a link, special file or unreadable name fails closed.
  if (execution.cargoHome) {
    const home = resolve(execution.cargoHome);
    for (const configName of ["config", "config.toml"]) {
      const configPath = join(home, configName);
      const config = reader.readRegular(configPath, {
        missingOk: true,
        bindPath: true,
        label: "cargoHome configuration",
        maxBytes: 1024 * 1024,
      });
      if (config) {
        if (!settings.cargo) {
          throw new Error("Unbound cargo configuration in cargoHome");
        }
        const raw = config.bytes.toString("utf8");
        normalizeCargoConfig(raw);
        if (digest(Buffer.from(raw)) !== settings.cargo.identity) {
          throw new Error("cargoHome configuration bypasses bound settings");
        }
      }
    }
  }

  // Check ancestor cargo configs if execution.cwd is supplied
  if (execution.cwd) {
    let curr = resolve(execution.cwd);
    while (true) {
      for (const configName of ["config", "config.toml"]) {
        const p = join(curr, ".cargo", configName);
        let exists = false;
        try { await stat(p); exists = true; } catch {}
        if (exists) {
          throw new Error("Unbound cargo configuration in ancestor; duplicate merging is not admitted");
        }
      }
      const parent = dirname(curr);
      if (parent === curr) break;
      curr = parent;
    }
  }

  // Environment parity and classification
  const env = execution.environment ?? {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") throw new Error(`Environment value for ${key} must be a string`);
    const classification = classifyEnvironmentKey(key);
    if (!classification) {
      throw new Error(`Unknown build environment setting: ${key}`);
    }
  }

  const settingsSemantic = settings.environment?.semantic ?? {};
  const settingsLocators = settings.environment?.locators ?? {};
  const settingsExecutionOnly = settings.environment?.executionOnly ?? {};

  const envSemanticKeys = [];
  const envLocatorKeys = [];
  const envExecutionOnlyKeys = [];
  for (const key of Object.keys(env)) {
    const c = classifyEnvironmentKey(key);
    if (!c) throw new Error(`Unknown build environment setting: ${key}`);
    if (c.type === "semantic") envSemanticKeys.push(key);
    else if (c.type === "locator") envLocatorKeys.push(key);
    else if (c.type === "executionOnly") envExecutionOnlyKeys.push(key);
  }

  // Exact semantic parity
  for (const k of Object.keys(settingsSemantic)) {
    if (!(k in env)) throw new Error(`Missing execution environment setting: ${k}`);
  }
  for (const k of envSemanticKeys) {
    if (!(k in settingsSemantic)) throw new Error(`Execution environment has unbound semantic setting: ${k}`);
    if (env[k] !== settingsSemantic[k]) throw new Error(`${k} semantic setting mismatch`);
  }

  // Exact locator parity
  for (const k of Object.keys(settingsLocators)) {
    if (!(k in env)) throw new Error(`Missing execution locator setting: ${k}`);
  }
  for (const k of envLocatorKeys) {
    if (!(k in settingsLocators)) throw new Error(`Execution environment has unbound locator setting: ${k}`);
    const classification = classifyEnvironmentKey(k);
    if (!classification || classification.type !== "locator") throw new Error(`Execution environment has unbound locator setting: ${k}`);
    const value = env[k];
    if (typeof value !== "string") throw new Error(`Environment value for ${k} must be a string`);
    const fresh = await inventoryLocator(value, classification.multi);
    const record = settingsLocators[k];
    if (record === undefined) throw new Error(`Execution environment has unbound locator setting: ${k}`);
    const expectedId = typeof record === "string" ? record : record.identity;
    if (fresh.identity !== expectedId) {
      throw new Error(`${k} locator bytes mismatch`);
    }
  }

  // Exact executionOnly parity and validation
  for (const k of Object.keys(settingsExecutionOnly)) {
    if (!(k in env)) throw new Error(`Missing execution environment setting: ${k}`);
  }
  for (const k of envExecutionOnlyKeys) {
    if (!(k in settingsExecutionOnly)) throw new Error(`Execution environment has unbound execution-only setting: ${k}`);
    const val = env[k];
    if (typeof val !== "string") throw new Error(`Environment value for ${k} must be a string`);
    if (k === "NIX_STORE") {
      if (val !== "/nix/store") throw new Error("NIX_STORE must be fixed /nix/store");
    } else if (k === "NIX_BUILD_TOP") {
      if (!isAbsolute(val)) throw new Error("NIX_BUILD_TOP must be an absolute path");
      const st = await stat(val);
      if (!st.isDirectory()) throw new Error("NIX_BUILD_TOP must be a directory");
    }
  }
}
