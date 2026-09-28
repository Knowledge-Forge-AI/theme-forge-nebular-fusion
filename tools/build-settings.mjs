import { readFile, stat, lstat, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { digest, identity } from "./candidate-provenance.mjs";

export const EXECUTION_ONLY_REASONS = Object.freeze({
  NIX_STORE: "Fixed canonical Nix store mount / execution prefix",
  NIX_BUILD_TOP: "Caller locator is replaced by the native builder's owned work directory; compiler path remapping uses that execution root",
});

export function classifyEnvironmentKey(key) {
  if (Object.hasOwn(EXECUTION_ONLY_REASONS, key)) return { type: "executionOnly", reason: EXECUTION_ONLY_REASONS[key] };
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

export function isBuildEnvironmentKey(key) {
  return classifyEnvironmentKey(key) !== null;
}

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
    if (!match[1].startsWith("/")) {
      throw new Error(`Unsupported relative path in Cargo config: ${match[1]}`);
    }
  }
  return raw;
}

export function extractCargoConfigLocators(content) {
  if (typeof content !== "string") throw new Error("Cargo config content must be a string");
  const locators = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) continue;
    const matches = trimmed.matchAll(/["'](\/[^"']+)["']/g);
    for (const match of matches) {
      locators.push(match[1]);
    }
  }
  return [...new Set(locators)].sort();
}

// Hash resolved content, including executable mode. Alias paths are locators;
// internal links bind their root-relative destination, whose bytes are already
// inventoried by the physical tree walk. This handles SDK aliases/backlinks
// without recursive expansion. External referents are content-bound separately.
export async function inventoryPath(targetPath) {
  if (typeof targetPath !== "string" || !isAbsolute(targetPath)) throw new Error("Locator path must be absolute");
  const root = await realpath(targetPath);
  const cache = new Map(), active = new Set();
  let count = 0, totalBytes = 0;
  async function visit(path, depth = 0, scopeRoot = root) {
    const real = await realpath(path);
    if ((await lstat(path)).isSymbolicLink()) {
      const rel = relative(scopeRoot, real);
      if (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel)) {
        return { identity: identity({ type: "internal-link", target: rel || "." }), isDirectory: (await stat(real)).isDirectory() };
      }
      // External directory inputs (for example SDK ncurses headers) have their
      // own internal aliases. Inventory that complete referent as its own root.
      if ((await stat(real)).isDirectory()) scopeRoot = real;
    }
    if (active.has(real)) throw new Error("Locator directory cycle detected");
    const cacheKey = `${scopeRoot}\0${real}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    if (depth > 64 || ++count > 100000) throw new Error("Locator inventory traversal limit exceeded");
    const info = await stat(real);
    let record;
    if (info.isFile()) {
      if (info.size > 256 * 1024 * 1024 || (totalBytes += info.size) > 2 * 1024 * 1024 * 1024) throw new Error("Locator inventory byte limit exceeded");
      record = { type: "file", mode: info.mode & 0o111 ? 0o755 : 0o644, bytes: info.size, sha256: digest(await readFile(real)) };
    } else if (info.isDirectory()) {
      active.add(real);
      try {
        const entries = [];
        for (const name of (await readdir(real)).sort()) {
          if (name.length > 1024) throw new Error("Locator member path limit exceeded");
          entries.push({ name, identity: (await visit(join(real, name), depth + 1, scopeRoot)).identity });
        }
        record = { type: "directory", entries };
      } finally { active.delete(real); }
    } else throw new Error("Unsupported locator member type");
    const result = { identity: identity(record), isDirectory: info.isDirectory() };
    cache.set(cacheKey, result);
    return result;
  }
  return { path: resolve(targetPath), ...await visit(root) };
}

export async function inventoryLocator(value, isMulti = false) {
  if (typeof value !== "string") throw new Error("Locator value must be a string");
  if (isMulti) {
    const parts = value.split(":").filter(Boolean);
    if (parts.length === 0) throw new Error("Locator path cannot be empty");
    for (const part of parts) {
      if (!isAbsolute(part)) throw new Error(`Locator path must be absolute: ${part}`);
    }
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

  const semantic = {};
  const locators = {};
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
    locators: Object.fromEntries(Object.keys(locators).sort().map(k => [k, locators[k].identity])),
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

export function buildSettingsClaims(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("Explicit build settings required");
  if (!/^[a-f0-9]{64}$/.test(settings.identity)) throw new Error("Settings identity required");
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
    locators: Object.fromEntries(Object.keys(locators).sort().map(k => [k, typeof locators[k] === "string" ? locators[k] : locators[k].identity])),
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

export async function validateBuildSettings(settings, execution = {}) {
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
  for (const key of ["cargoHome", "npmCache", "frontendModules", "previewModules", "cwd"]) {
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

  // cargoHome verification
  if (execution.cargoHome) {
    const home = resolve(execution.cargoHome);
    for (const configName of ["config", "config.toml"]) {
      const configPath = join(home, configName);
      let exists = false;
      try { await stat(configPath); exists = true; } catch {}
      if (exists) {
        if (!settings.cargo) {
          throw new Error("Unbound cargo configuration in cargoHome");
        }
        const raw = await readFile(configPath, "utf8");
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
    const fresh = await inventoryLocator(env[k], classification.multi);
    const record = settingsLocators[k];
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
    if (k === "NIX_STORE") {
      if (val !== "/nix/store") throw new Error("NIX_STORE must be fixed /nix/store");
    } else if (k === "NIX_BUILD_TOP") {
      if (!isAbsolute(val)) throw new Error("NIX_BUILD_TOP must be an absolute path");
      const st = await stat(val);
      if (!st.isDirectory()) throw new Error("NIX_BUILD_TOP must be a directory");
    }
  }
}
