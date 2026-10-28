// @ts-check
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readlink, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path";
import { canonical, digest, identity, inventoryTree } from "./candidate-provenance.mjs";

const canonicalJson = (/** @type {unknown} */ value) => `${canonical(value)}\n`;

export const NATIVE_RUNTIME_INPUT_SCHEMA = "nebular-native-runtime-input-v1";
export const NATIVE_RUNTIME_MATERIAL_SCHEMA = "nebular-native-runtime-material-v1";
export const NATIVE_PAYLOAD_INVENTORY_SCHEMA = "nebular-native-payload-inventory-v1";
export const NATIVE_RUNTIME_RECEIPT_SCHEMA = "nebular-native-runtime-material-receipt-v1";
export const NATIVE_RUNTIME_ALIAS_PROJECTION_SCHEMA = "nebular-native-runtime-alias-projection-v1";

export const PRIVATE_RUNTIME_PREFIX = "opt/nebular-private";
export const PRIVATE_RUNTIME_MARKER = "native-runtime.json";
export const PRIVATE_RUNTIME_RECEIPT = "native-runtime-material.json";

export const SUPPORTED_LINUX_TARGETS = Object.freeze([
  "aarch64-unknown-linux-gnu",
  "x86_64-unknown-linux-gnu",
]);

export const MAX_RUNTIME_MEMBERS = 20_000;
export const MAX_RUNTIME_FILE_BYTES = 512 * 1024 * 1024;
export const MAX_RUNTIME_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_RUNTIME_PATH_LENGTH = 512;
export const MAX_RUNTIME_PATH_DEPTH = 16;
export const MAX_RUNTIME_ALIAS_DEPTH = 8;
export const MAX_RUNTIME_INPUT_BYTES = 16 * 1024 * 1024;

// Runtime descriptor reads must acquire a non-following, non-blocking read
// handle before inspecting any leaf-path metadata.  The runtime payload is
// Linux-only; O_NONBLOCK keeps a non-regular replacement (for example, a FIFO)
// from turning a bounded admission read into an unbounded wait.
const REGULAR_READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;

export const REQUIRED_RUNTIME_DIRECTORIES = Object.freeze([
  "opt/nebular-private",
  "opt/nebular-private/lib",
  "opt/nebular-private/lib/webkit2gtk-4.1",
  "opt/nebular-private/lib/webkit2gtk-4.1/injected-bundle",
  "opt/nebular-private/libexec",
  "opt/nebular-private/libexec/sandbox",
  "opt/nebular-private/libexec/webkit2gtk-4.1",
]);

export const REQUIRED_EXECUTABLE_RUNTIME_ROLES = Object.freeze([
  "opt/nebular-private/libexec/sandbox/bwrap",
  "opt/nebular-private/libexec/sandbox/xdg-dbus-proxy",
  "opt/nebular-private/libexec/webkit2gtk-4.1/WebKitGPUProcess",
  "opt/nebular-private/libexec/webkit2gtk-4.1/WebKitNetworkProcess",
  "opt/nebular-private/libexec/webkit2gtk-4.1/WebKitWebProcess",
]);

export const REQUIRED_RUNTIME_ROLES = Object.freeze([
  "opt/nebular-private/lib/libjavascriptcoregtk-4.1.so.0.9.11",
  "opt/nebular-private/lib/libwebkit2gtk-4.1.so.0.19.9",
  "opt/nebular-private/lib/webkit2gtk-4.1/injected-bundle/libwebkit2gtkinjectedbundle.so",
  "opt/nebular-private/libexec/sandbox/bwrap",
  "opt/nebular-private/libexec/sandbox/xdg-dbus-proxy",
  "opt/nebular-private/libexec/webkit2gtk-4.1/WebKitGPUProcess",
  "opt/nebular-private/libexec/webkit2gtk-4.1/WebKitNetworkProcess",
  "opt/nebular-private/libexec/webkit2gtk-4.1/WebKitWebProcess",
]);

export const REQUIRED_RUNTIME_SONAME_ENTRIES = Object.freeze([
  "opt/nebular-private/lib/libjavascriptcoregtk-4.1.so.0",
  "opt/nebular-private/lib/libwebkit2gtk-4.1.so.0",
]);

export const COMMON_EXTERNAL_FLOOR_SONAMES = Object.freeze([
  "libGL.so.1",
  "libX11.so.6",
  "libXext.so.6",
  "libXrender.so.1",
  "libatomic.so.1",
  "libc.so.6",
  "libdl.so.2",
  "libexpat.so.1",
  "libgcc_s.so.1",
  "libglib-2.0.so.0",
  "libgobject-2.0.so.0",
  "libm.so.6",
  "libpthread.so.0",
  "libresolv.so.2",
  "libstdc++.so.6",
  "libz.so.1",
]);

const PROTECTED_COMPONENTS = new Set(["db", "raw", ".serena"]);
const PROTECTED_SUFFIX_RE = /\.(?:db|sqlite|sqlite3)$/iu;
const HEX64_RE = /^[0-9a-f]{64}$/u;
const SONAME_RE = /^[A-Za-z0-9_+@.-]{1,255}$/u;
const FORBIDDEN_HOST_KEYS = new Set([
  "full9",
  "ino",
  "inode",
  "dev",
  "uid",
  "gid",
  "mtime",
  "mtimeNs",
  "ctime",
  "ctimeNs",
  "nlink",
  "sourceRoot",
  "sourcePath",
  "hostPath",
]);

/**
 * @typedef {{ path: string, mode: number }} RuntimeDirectoryEntry
 * @typedef {{ path: string, bytes: number, mode: number, sha256: string }} RuntimeRegularEntry
 * @typedef {{ path: string, target: string, canonical: string }} RuntimeAliasEntry
 * @typedef {{
 *   soname: string,
 *   resolvedPath: string | null,
 *   status: "resolved" | "missing" | "interpreter",
 *   subjectRelativePath?: string,
 * }} LddProviderRow
 * @typedef {{
 *   class: string,
 *   machine: string,
 *   elfType: string,
 *   soname: string | null,
 *   needed: string[],
 *   interpreters: string[],
 *   rpaths: { kind: string, value: string }[],
 *   versionDefinitions: string[],
 *   versionNeeds: { provider: string, name: string }[],
 * }} ElfMetadata
 * @typedef {{
 *   soname: string,
 *   classification: "external-floor" | "interpreter",
 *   requestedPath: string,
 *   terminalPath: string,
 *   aliasChain: { path: string, rawTarget: string, full9: (string | number)[] }[],
 *   terminalFull9: (string | number)[],
 *   bytes: number,
 *   sha256: string,
 *   elfMachine: string,
 *   elfClass: "ELF64",
 *   versionDefinitions: string[],
 *   readelfEvidenceSha256: string,
 * }} ObservedProviderRow
 * @typedef {{
 *   subjectRelativePath: string,
 *   neededSoname: string,
 *   resolvedPath: string,
 *   providerObservationIdentity: string,
 * }} SubjectResolutionRow
 * @typedef {{
 *   schema: string,
 *   target: string,
 *   materialDigest: string,
 *   expectedNativePayload: string,
 *   observedProviderRows: ObservedProviderRow[],
 *   subjectResolutionRows: SubjectResolutionRow[],
 *   toolEvidence: Record<string, unknown>,
 *   observationIdentity: string,
 * }} ConsumerFloorObservation
 * @typedef {{ path: string, bytes?: number, mode?: number, sha256?: string }} NativePayloadFile
 * @typedef {{ path: string, target: string, canonical?: string }} NativePayloadAlias
 * @typedef {{ path: string, mode?: number }} NativePayloadDirectory
 * @typedef {{ path: string, target: string, canonical: string, bytes: number, mode: number, sha256: string }} NativeRuntimeAliasProjectionEntry
 * @typedef {{ schema: string, materialDigest: string, aliases: NativeRuntimeAliasProjectionEntry[], digest: string }} NativeRuntimeAliasProjection
 * @typedef {{
 *   schema?: string,
 *   materialDigest?: string,
 *   files: NativePayloadFile[],
 *   aliases?: NativePayloadAlias[],
 *   directories?: NativePayloadDirectory[],
 *   identity: string,
 * }} NativePayloadInventory
 */

/**
 * @param {string} target
 * @returns {string}
 */
export function loaderSonameForTarget(target) {
  if (target === "aarch64-unknown-linux-gnu") return "ld-linux-aarch64.so.1";
  if (target === "x86_64-unknown-linux-gnu") return "ld-linux-x86-64.so.2";
  throw new Error(`Private native runtime is not supported for target ${target}`);
}

/**
 * @param {string} target
 * @returns {string}
 */
export function interpreterForTarget(target) {
  if (target === "aarch64-unknown-linux-gnu") return "/lib/ld-linux-aarch64.so.1";
  if (target === "x86_64-unknown-linux-gnu") return "/lib64/ld-linux-x86-64.so.2";
  throw new Error(`Private native runtime is not supported for target ${target}`);
}

/**
 * @param {string} target
 * @returns {string[]}
 */
export function externalFloorForTarget(target) {
  const loader = loaderSonameForTarget(target);
  return [...COMMON_EXTERNAL_FLOOR_SONAMES, loader].sort();
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {readonly string[]} allowedKeys
 * @param {readonly string[]} [requiredKeys]
 * @returns { asserts value is Record<string, any> }
 */
function assertClosedObject(value, label, allowedKeys, requiredKeys = allowedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  const obj = /** @type {Record<string, any>} */ (value);
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_HOST_KEYS.has(key) && !allowed.has(key)) {
      throw new Error(`${label} contains forbidden non-portable key ${key}`);
    }
    if (!allowed.has(key)) {
      throw new Error(`${label} contains unknown key ${key}`);
    }
  }
  for (const key of requiredKeys) {
    if (!(key in obj)) {
      throw new Error(`${label} is missing required key ${key}`);
    }
  }
}

/**
 * @param {string} relPath
 * @param {string} label
 * @param {{ allowPrefixRoot?: boolean }} [options]
 */
function validateRuntimeRelativePath(relPath, label, { allowPrefixRoot = false } = {}) {
  if (typeof relPath !== "string" || !relPath || relPath.length > MAX_RUNTIME_PATH_LENGTH) {
    throw new Error(`${label} must be a non-empty bounded relative path`);
  }
  if (relPath !== relPath.normalize("NFC") || relPath.includes("\0") || relPath.includes("\\") || relPath.startsWith("/")) {
    throw new Error(`${label} contains invalid or non-portable path characters: ${relPath}`);
  }
  const parts = relPath.split("/");
  if (parts.length > MAX_RUNTIME_PATH_DEPTH) {
    throw new Error(`${label} exceeds maximum path depth: ${relPath}`);
  }
  for (const part of parts) {
    if (!part || part === "." || part === "..") {
      throw new Error(`${label} contains invalid path segment: ${relPath}`);
    }
    if (PROTECTED_COMPONENTS.has(part.toLowerCase()) || PROTECTED_SUFFIX_RE.test(part)) {
      throw new Error(`${label} references protected path component: ${relPath}`);
    }
  }
  if (allowPrefixRoot && relPath === PRIVATE_RUNTIME_PREFIX) {
    return;
  }
  if (!relPath.startsWith(`${PRIVATE_RUNTIME_PREFIX}/`)) {
    throw new Error(`${label} must reside under ${PRIVATE_RUNTIME_PREFIX}: ${relPath}`);
  }
}

/**
 * @param {string[]} values
 * @param {string} label
 */
function assertStrictlySortedUnique(values, label) {
  for (let i = 1; i < values.length; i += 1) {
    const prev = values[i - 1];
    const curr = values[i];
    if (prev === undefined || curr === undefined) {
      throw new Error(`${label} contains an unavailable entry at index ${i}`);
    }
    if (prev === curr) {
      throw new Error(`${label} contains duplicate entry: ${curr}`);
    }
    if (prev > curr) {
      throw new Error(`${label} must be sorted lexicographically: ${prev} > ${curr}`);
    }
  }
}

/**
 * @param {RegExpMatchArray} match
 * @param {number} index
 * @param {string} label
 * @returns {string}
 */
function requiredCapture(match, index, label) {
  const value = match[index];
  if (typeof value !== "string") {
    throw new Error(`Malformed ${label} capture at index ${index}`);
  }
  return value;
}

/**
 * @param {string} aliasPath
 * @param {string} rawTarget
 * @param {Map<string, string>} aliasMap
 * @param {Set<string>} regularSet
 * @param {Set<string>} directorySet
 * @returns {string}
 */
function resolveRuntimeAliasChain(aliasPath, rawTarget, aliasMap, regularSet, directorySet) {
  if (typeof rawTarget !== "string" || !rawTarget || rawTarget.length > MAX_RUNTIME_PATH_LENGTH) {
    throw new Error(`Invalid runtime alias target at ${aliasPath}`);
  }
  if (rawTarget !== rawTarget.normalize("NFC") || rawTarget.includes("\0") || rawTarget.includes("\\") || rawTarget.startsWith("/")) {
    throw new Error(`Runtime alias target must be a contained relative POSIX path at ${aliasPath}: ${rawTarget}`);
  }
  const rawParts = rawTarget.split("/");
  if (rawParts.some((part) => !part || part === ".")) {
    throw new Error(`Runtime alias target contains empty or dot segment at ${aliasPath}: ${rawTarget}`);
  }

  let currentAlias = aliasPath;
  let currentTarget = rawTarget;
  const visited = new Set([aliasPath]);

  for (let hop = 0; hop < MAX_RUNTIME_ALIAS_DEPTH; hop += 1) {
    const baseDir = posix.dirname(currentAlias);
    const joined = posix.normalize(posix.join(baseDir, currentTarget));
    if (joined === PRIVATE_RUNTIME_PREFIX || !joined.startsWith(`${PRIVATE_RUNTIME_PREFIX}/`)) {
      throw new Error(`Runtime alias escapes ${PRIVATE_RUNTIME_PREFIX} at ${aliasPath}: ${currentTarget}`);
    }
    validateRuntimeRelativePath(joined, `resolved alias from ${aliasPath}`);

    const joinedParts = joined.split("/");
    for (let i = 2; i < joinedParts.length - 1; i += 1) {
      const ancestor = joinedParts.slice(0, i + 1).join("/");
      if (aliasMap.has(ancestor)) {
        throw new Error(`Runtime alias traverses aliased directory component ${ancestor} from ${aliasPath}`);
      }
      if (!directorySet.has(ancestor)) {
        throw new Error(`Runtime alias traverses undeclared directory ${ancestor} from ${aliasPath}`);
      }
    }

    if (directorySet.has(joined)) {
      throw new Error(`Runtime alias may not target a directory (${joined}) from ${aliasPath}`);
    }
    if (regularSet.has(joined)) {
      return joined;
    }
    const nextTarget = aliasMap.get(joined);
    if (nextTarget === undefined) {
      throw new Error(`Runtime alias ${aliasPath} points to missing terminal ${joined}`);
    }
    if (visited.has(joined)) {
      throw new Error(`Runtime alias cycle detected from ${aliasPath} via ${joined}`);
    }
    visited.add(joined);
    currentAlias = joined;
    currentTarget = nextTarget;
  }
  throw new Error(`Runtime alias depth exceeded (${MAX_RUNTIME_ALIAS_DEPTH}) from ${aliasPath}`);
}

/**
 * Computes the canonical materialDigest of a portable runtime material manifest.
 * @param {Record<string, any>} material
 * @returns {string}
 */
export function computeMaterialDigest(material) {
  return identity({
    schema: NATIVE_RUNTIME_MATERIAL_SCHEMA,
    target: material.target,
    prefix: material.prefix,
    directories: material.directories,
    regulars: material.regulars,
    aliases: material.aliases,
    requiredRoles: material.requiredRoles,
    externalFloor: material.externalFloor,
  });
}

/**
 * Build the explicit npm transport projection for every declared runtime alias.
 * The source material remains symlink based; this object authenticates only the
 * regular-copy representation used by npm transports.
 * @param {Record<string, any>} material
 * @returns {NativeRuntimeAliasProjection}
 */
export function createNativeRuntimeAliasProjection(material) {
  const validated = validateRuntimeMaterial(material, material?.target ?? null);
  /** @type {RuntimeRegularEntry[]} */
  const regularEntries = validated.regulars;
  /** @type {RuntimeAliasEntry[]} */
  const aliasEntries = validated.aliases;
  const regulars = new Map(regularEntries.map((entry) => [entry.path, entry]));
  const aliases = aliasEntries.map((alias) => {
    const canonicalEntry = regulars.get(alias.canonical);
    if (!canonicalEntry) {
      throw new Error(`Runtime alias ${alias.path} has no canonical regular entry`);
    }
    return {
      path: alias.path,
      target: alias.target,
      canonical: alias.canonical,
      bytes: canonicalEntry.bytes,
      mode: canonicalEntry.mode,
      sha256: canonicalEntry.sha256,
    };
  });
  aliases.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const body = {
    schema: NATIVE_RUNTIME_ALIAS_PROJECTION_SCHEMA,
    materialDigest: validated.materialDigest,
    aliases,
  };
  return { ...body, digest: identity(body) };
}

/**
 * Validate a package-provided alias projection against the complete source material.
 * @param {unknown} projection
 * @param {Record<string, any>} material
 * @returns {NativeRuntimeAliasProjection}
 */
export function validateNativeRuntimeAliasProjection(projection, material) {
  if (projection === null || typeof projection !== "object" || Array.isArray(projection)) {
    throw new Error("Native runtime alias projection must be an object");
  }
  const value = /** @type {Record<string, any>} */ (projection);
  const keys = Object.keys(value).sort();
  const expectedKeys = ["aliases", "digest", "materialDigest", "schema"];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error("Native runtime alias projection has an unexpected shape");
  }
  if (value.schema !== NATIVE_RUNTIME_ALIAS_PROJECTION_SCHEMA || typeof value.materialDigest !== "string"
      || !HEX64_RE.test(value.materialDigest) || !Array.isArray(value.aliases) || !HEX64_RE.test(value.digest ?? "")) {
    throw new Error("Native runtime alias projection identity is malformed");
  }
  const expected = createNativeRuntimeAliasProjection(material);
  if (value.materialDigest !== expected.materialDigest || identity({ schema: value.schema, materialDigest: value.materialDigest, aliases: value.aliases }) !== value.digest) {
    throw new Error("Native runtime alias projection digest mismatch");
  }
  if (identity({ schema: expected.schema, materialDigest: expected.materialDigest, aliases: expected.aliases }) !== value.digest
      || JSON.stringify(value.aliases) !== JSON.stringify(expected.aliases)) {
    throw new Error("Native runtime alias projection does not cover the complete material alias set");
  }
  return expected;
}

/**
 * Validates a portable nebular-native-runtime-material-v1 object.
 * @param {unknown} material
 * @param {string | null} [expectedTarget]
 * @returns {Record<string, any>}
 */
export function validateRuntimeMaterial(material, expectedTarget = null) {
  assertClosedObject(material, "native runtime material", [
    "schema",
    "target",
    "prefix",
    "directories",
    "regulars",
    "aliases",
    "requiredRoles",
    "externalFloor",
    "materialDigest",
  ]);
  if (material.schema !== NATIVE_RUNTIME_MATERIAL_SCHEMA) {
    throw new Error(`Unsupported native runtime material schema: ${String(material.schema)}`);
  }
  if (typeof material.target !== "string" || !SUPPORTED_LINUX_TARGETS.includes(material.target)) {
    throw new Error(`Unsupported native runtime material target: ${String(material.target)}`);
  }
  if (expectedTarget !== null && material.target !== expectedTarget) {
    throw new Error(`Native runtime material target ${material.target} does not match expected target ${expectedTarget}`);
  }
  if (material.prefix !== PRIVATE_RUNTIME_PREFIX) {
    throw new Error(`Native runtime material prefix must be ${PRIVATE_RUNTIME_PREFIX}, got ${String(material.prefix)}`);
  }
  if (!Array.isArray(material.directories) || !Array.isArray(material.regulars) || !Array.isArray(material.aliases)) {
    throw new Error("Native runtime material directories, regulars, and aliases must be arrays");
  }
  if (!Array.isArray(material.requiredRoles) || !Array.isArray(material.externalFloor)) {
    throw new Error("Native runtime material requiredRoles and externalFloor must be arrays");
  }
  if (typeof material.materialDigest !== "string" || !HEX64_RE.test(material.materialDigest)) {
    throw new Error("Native runtime materialDigest must be a lowercase 64-hex SHA-256 string");
  }

  const totalMembers = material.directories.length + material.regulars.length + material.aliases.length;
  if (totalMembers === 0 || totalMembers > MAX_RUNTIME_MEMBERS) {
    throw new Error(`Native runtime member count ${totalMembers} exceeds allowed bounds (1..${MAX_RUNTIME_MEMBERS})`);
  }

  const floorSonames = new Set(externalFloorForTarget(material.target));
  const directorySet = new Set();
  const regularMap = new Map();
  const aliasMap = new Map();
  const casefoldSet = new Set();

  /** @param {string} p */
  const trackNamespacePath = (p) => {
    const folded = p.toLowerCase();
    if (casefoldSet.has(folded)) {
      throw new Error(`Native runtime material contains duplicate or case-ambiguous path: ${p}`);
    }
    casefoldSet.add(folded);
  };

  for (const dir of material.directories) {
    assertClosedObject(dir, "runtime directory entry", ["path", "mode"]);
    validateRuntimeRelativePath(dir.path, "runtime directory path", { allowPrefixRoot: true });
    if (dir.mode !== 0o755) {
      throw new Error(`Runtime directory ${dir.path} must declare mode 0755, got ${String(dir.mode)}`);
    }
    trackNamespacePath(dir.path);
    directorySet.add(dir.path);
  }
  assertStrictlySortedUnique(
    material.directories.map((/** @type {any} */ d) => d.path),
    "runtime material directories",
  );
  for (const requiredDir of REQUIRED_RUNTIME_DIRECTORIES) {
    if (!directorySet.has(requiredDir)) {
      throw new Error(`Runtime material is missing required directory ${requiredDir}`);
    }
  }
  for (const dirPath of directorySet) {
    if (dirPath === PRIVATE_RUNTIME_PREFIX) continue;
    const parent = posix.dirname(dirPath);
    if (!directorySet.has(parent)) {
      throw new Error(`Runtime directory ${dirPath} is missing declared parent directory ${parent}`);
    }
  }

  let totalBytes = 0;
  for (const reg of material.regulars) {
    assertClosedObject(
      reg,
      "runtime regular entry",
      ["path", "bytes", "sha256", "mode", "role"],
      ["path", "bytes", "sha256", "mode"],
    );
    validateRuntimeRelativePath(reg.path, "runtime regular path");
    if (directorySet.has(reg.path)) {
      throw new Error(`Runtime regular ${reg.path} conflicts with declared directory`);
    }
    const parent = posix.dirname(reg.path);
    if (!directorySet.has(parent)) {
      throw new Error(`Runtime regular ${reg.path} is missing declared parent directory ${parent}`);
    }
    const base = posix.basename(reg.path);
    if (floorSonames.has(base)) {
      throw new Error(`External floor terminal ${base} must not be copied as a private runtime regular (${reg.path})`);
    }
    if (!Number.isInteger(reg.bytes) || reg.bytes <= 0 || reg.bytes > MAX_RUNTIME_FILE_BYTES) {
      throw new Error(`Runtime regular ${reg.path} has invalid byte size ${String(reg.bytes)}`);
    }
    totalBytes += reg.bytes;
    if (totalBytes > MAX_RUNTIME_TOTAL_BYTES) {
      throw new Error(`Runtime material total bytes (${totalBytes}) exceeds ceiling (${MAX_RUNTIME_TOTAL_BYTES})`);
    }
    if (typeof reg.sha256 !== "string" || !HEX64_RE.test(reg.sha256)) {
      throw new Error(`Runtime regular ${reg.path} has invalid sha256`);
    }
    if (reg.mode !== 0o644 && reg.mode !== 0o755) {
      throw new Error(`Runtime regular ${reg.path} has invalid mode ${String(reg.mode)} (expected 0644 or 0755)`);
    }
    if ("role" in reg && (typeof reg.role !== "string" || !reg.role.trim())) {
      throw new Error(`Runtime regular ${reg.path} has invalid role field`);
    }
    trackNamespacePath(reg.path);
    regularMap.set(reg.path, reg);
  }
  assertStrictlySortedUnique(
    material.regulars.map((/** @type {any} */ r) => r.path),
    "runtime material regulars",
  );

  for (const alias of material.aliases) {
    assertClosedObject(alias, "runtime alias entry", ["path", "target", "canonical"]);
    validateRuntimeRelativePath(alias.path, "runtime alias path");
    if (directorySet.has(alias.path) || regularMap.has(alias.path)) {
      throw new Error(`Runtime alias ${alias.path} conflicts with existing directory or regular`);
    }
    const parent = posix.dirname(alias.path);
    if (!directorySet.has(parent)) {
      throw new Error(`Runtime alias ${alias.path} is missing declared parent directory ${parent}`);
    }
    const base = posix.basename(alias.path);
    if (floorSonames.has(base)) {
      throw new Error(`External floor terminal ${base} must not be copied as a private runtime alias (${alias.path})`);
    }
    if (typeof alias.canonical !== "string") {
      throw new Error(`Runtime alias ${alias.path} is missing canonical regular path`);
    }
    validateRuntimeRelativePath(alias.canonical, "runtime alias canonical path");
    trackNamespacePath(alias.path);
    aliasMap.set(alias.path, alias.target);
  }
  assertStrictlySortedUnique(
    material.aliases.map((/** @type {any} */ a) => a.path),
    "runtime material aliases",
  );

  const regularSet = new Set(regularMap.keys());
  for (const alias of material.aliases) {
    const resolved = resolveRuntimeAliasChain(alias.path, alias.target, aliasMap, regularSet, directorySet);
    if (resolved !== alias.canonical) {
      throw new Error(`Runtime alias ${alias.path} resolves to ${resolved}, not declared canonical ${alias.canonical}`);
    }
  }

  for (const rolePath of material.requiredRoles) {
    if (typeof rolePath !== "string" || !rolePath) {
      throw new Error("Runtime material requiredRoles entries must be non-empty strings");
    }
  }
  assertStrictlySortedUnique(material.requiredRoles, "runtime material requiredRoles");
  if (
    material.requiredRoles.length !== REQUIRED_RUNTIME_ROLES.length ||
    material.requiredRoles.some((/** @type {string} */ role, /** @type {number} */ idx) => role !== REQUIRED_RUNTIME_ROLES[idx])
  ) {
    throw new Error(`Runtime material requiredRoles must equal the fixed 8-role contract`);
  }
  for (const rolePath of REQUIRED_RUNTIME_ROLES) {
    const reg = regularMap.get(rolePath);
    if (!reg) {
      throw new Error(`Runtime material is missing required role regular ${rolePath}`);
    }
    if (typeof reg.role !== "string" || !reg.role) {
      throw new Error(`Runtime required role ${rolePath} must declare its ELF role`);
    }
  }
  for (const execRolePath of REQUIRED_EXECUTABLE_RUNTIME_ROLES) {
    const reg = regularMap.get(execRolePath);
    if (!reg || reg.mode !== 0o755) {
      throw new Error(`Runtime executable role ${execRolePath} must have mode 0755`);
    }
  }
  for (const sonameEntry of REQUIRED_RUNTIME_SONAME_ENTRIES) {
    if (!regularMap.has(sonameEntry) && !aliasMap.has(sonameEntry)) {
      throw new Error(`Runtime material is missing required primary library entry ${sonameEntry}`);
    }
  }

  for (const floorEntry of material.externalFloor) {
    assertClosedObject(
      floorEntry,
      "runtime externalFloor entry",
      ["soname", "basis", "sha256", "bytes", "versions"],
      ["soname", "basis", "sha256", "bytes"],
    );
    if (typeof floorEntry.soname !== "string" || !SONAME_RE.test(floorEntry.soname)) {
      throw new Error(`Invalid externalFloor soname: ${String(floorEntry.soname)}`);
    }
    if (typeof floorEntry.basis !== "string" || !floorEntry.basis || floorEntry.basis.startsWith("/")) {
      throw new Error(`Invalid externalFloor basis for ${floorEntry.soname}`);
    }
    if (typeof floorEntry.sha256 !== "string" || !HEX64_RE.test(floorEntry.sha256)) {
      throw new Error(`Invalid externalFloor sha256 for ${floorEntry.soname}`);
    }
    if (!Number.isInteger(floorEntry.bytes) || floorEntry.bytes <= 0) {
      throw new Error(`Invalid externalFloor bytes for ${floorEntry.soname}`);
    }
    if ("versions" in floorEntry) {
      if (!Array.isArray(floorEntry.versions) || floorEntry.versions.some((/** @type {any} */ v) => typeof v !== "string" || !v)) {
        throw new Error(`Invalid externalFloor versions for ${floorEntry.soname}`);
      }
      assertStrictlySortedUnique(floorEntry.versions, `externalFloor versions for ${floorEntry.soname}`);
    }
  }
  const declaredFloorSonames = material.externalFloor.map((/** @type {any} */ f) => f.soname);
  assertStrictlySortedUnique(declaredFloorSonames, "runtime material externalFloor");
  const expectedFloorList = externalFloorForTarget(material.target);
  if (
    declaredFloorSonames.length !== expectedFloorList.length ||
    declaredFloorSonames.some((/** @type {string} */ s, /** @type {number} */ idx) => s !== expectedFloorList[idx])
  ) {
    throw new Error(`Runtime material externalFloor must equal the 17 declared floor terminals for ${material.target}`);
  }

  const expectedDigest = computeMaterialDigest(material);
  if (material.materialDigest !== expectedDigest) {
    throw new Error(`Runtime materialDigest mismatch: expected ${expectedDigest}, got ${material.materialDigest}`);
  }

  return material;
}

/**
 * @param {import("node:fs").BigIntStats} st
 */
function statFull9(st) {
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
function full9Equal(a, b) {
  return a.length === b.length && a.every((val, idx) => val === b[idx]);
}

/**
 * @param {{ bytes: number, mode: number, sha256: string, full9: (string|number)[] }} observed
 * @param {{ bytes: number, mode: number, sha256: string, full9: (string|number)[] }} expected
 */
function rootEnvelopeEntryEqual(observed, expected) {
  return observed.bytes === expected.bytes &&
    observed.mode === expected.mode &&
    observed.sha256 === expected.sha256 &&
    full9Equal(observed.full9, expected.full9);
}

/**
 * Re-reads the archive-root legal entries through descriptor-bound handles.
 * This is intentionally used both before and after the payload walk: the
 * legal files are outside the native payload identity but still part of the
 * authenticated raw archive envelope.
 * @param {string} resolvedRoot
 * @param {[string, { bytes: number, mode: number, sha256: string, full9: (string|number)[] }][]} entries
 * @param {string} label
 */
async function verifyRootEnvelope(resolvedRoot, entries, label) {
  for (const [path, expected] of entries) {
    const observed = await readRegularDescriptorChecked(join(resolvedRoot, path), MAX_RUNTIME_FILE_BYTES);
    if (!rootEnvelopeEntryEqual(observed, expected)) {
      throw new Error(`${label} mismatch at ${path}`);
    }
  }
}

/**
 * @param {string} absDir
 */
async function openNoFollowDir(absDir) {
  const stat = await lstat(absDir, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Expected real directory: ${absDir}`);
  }
  const rawEntries = await readdir(absDir, { withFileTypes: true });
  const entries = rawEntries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const after = await lstat(absDir, { bigint: true });
  if (!full9Equal(statFull9(stat), statFull9(after))) {
    throw new Error(`Directory changed during listing: ${absDir}`);
  }
  return { stat, entries };
}

/**
 * @param {string} absPath
 * @param {{ label: string, expectDirectory?: boolean, expectFile?: boolean, maxBytes?: number }} options
 */
async function statStableNoFollow(absPath, { label, expectDirectory = false, expectFile = false, maxBytes }) {
  const st = await lstat(absPath, { bigint: true });
  if (st.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link: ${absPath}`);
  }
  if (expectDirectory && !st.isDirectory()) {
    throw new Error(`${label} must be a directory: ${absPath}`);
  }
  if (expectFile && !st.isFile()) {
    throw new Error(`${label} must be a regular file: ${absPath}`);
  }
  if (typeof maxBytes === "number" && Number(st.size) > maxBytes) {
    throw new Error(`${label} exceeds byte limit (${String(st.size)} > ${maxBytes}): ${absPath}`);
  }
  return st;
}

/**
 * @param {string} absPath
 * @param {import("node:fs").BigIntStats} stableStat
 * @param {{ label: string, maxBytes: number }} options
 */
async function hashRegularNoFollow(absPath, stableStat, { label, maxBytes }) {
  const beforeFrame = statFull9(stableStat);
  const size = Number(stableStat.size);
  if (size < 0 || size > maxBytes) {
    throw new Error(`${label} exceeds byte limit (${size} > ${maxBytes}): ${absPath}`);
  }
  const fh = await open(absPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  /** @type {unknown} */
  let primaryError = null;
  try {
    const opened = await fh.stat({ bigint: true });
    if (!full9Equal(statFull9(opened), beforeFrame)) {
      throw new Error(`Descriptor drift on open for ${label}: ${absPath}`);
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
      throw new Error(`${label} size changed during read: ${absPath}`);
    }
    const ended = await fh.stat({ bigint: true });
    if (!full9Equal(statFull9(ended), beforeFrame)) {
      throw new Error(`Descriptor drift after read for ${label}: ${absPath}`);
    }
    return createHash("sha256").update(buf).digest("hex");
  } catch (err) {
    primaryError = err;
    throw err;
  } finally {
    await fh.close();
    if (!primaryError) {
      const afterNamed = await lstat(absPath, { bigint: true });
      if (!full9Equal(statFull9(afterNamed), beforeFrame)) {
        throw new Error(`Named file drift after close for ${label}: ${absPath}`);
      }
    }
  }
}

/**
 * @param {string} absDir
 * @param {import("node:fs").BigIntStats} initialStat
 * @param {string[]} expectedNames
 * @param {string} label
 */
async function verifyDirectorySnapshot(absDir, initialStat, expectedNames, label) {
  const afterStat = await lstat(absDir, { bigint: true });
  if (!full9Equal(statFull9(afterStat), statFull9(initialStat))) {
    throw new Error(`${label} metadata drifted during snapshot: ${absDir}`);
  }
  const afterNames = (await readdir(absDir)).sort();
  if (
    afterNames.length !== expectedNames.length ||
    afterNames.some((name, idx) => name !== expectedNames[idx])
  ) {
    throw new Error(`${label} entries drifted during snapshot: ${absDir}`);
  }
}

/**
 * Admit the declared private-runtime namespace from metadata before reading any selected body.
 * The returned regular frames are body-authenticated only after the complete namespace has
 * matched the material tables. Unknown/protected entries therefore cannot cause a descent or
 * body read before they are rejected.
 * @param {string} absRoot
 * @param {string} relRoot
 * @param {Record<string, any>} material
 * @param {string} label
 */
async function admitRuntimeNamespace(absRoot, relRoot, material, label) {
  /** @type {RuntimeDirectoryEntry[]} */
  const directories = material.directories;
  /** @type {RuntimeRegularEntry[]} */
  const regulars = material.regulars;
  /** @type {RuntimeAliasEntry[]} */
  const aliases = material.aliases;
  const expectedDirectories = new Map(directories.map((entry) => [entry.path, entry]));
  const expectedRegulars = new Map(regulars.map((entry) => [entry.path, entry]));
  const expectedAliases = new Map(aliases.map((entry) => [entry.path, entry]));
  const directoryFrames = new Map();
  const regularMetadata = new Map();
  const aliasFrames = new Map();
  const snapshots = new Map();
  let memberCount = 0;
  let totalBytes = 0;

  /** @param {string} absDir @param {string} relDir */
  const visit = async (absDir, relDir) => {
    if (!expectedDirectories.has(relDir)) {
      throw new Error(`${label} encountered undeclared directory ${relDir}`);
    }
    const { stat, entries } = await openNoFollowDir(absDir);
    const declaredDir = expectedDirectories.get(relDir);
    if (!declaredDir) {
      throw new Error(`${label} is missing declared directory ${relDir}`);
    }
    if ((Number(stat.mode) & 0o7000) !== 0 || (Number(stat.mode) & 0o777) !== declaredDir.mode) {
      throw new Error(`${label} directory mode mismatch at ${relDir}`);
    }
    directoryFrames.set(relDir, statFull9(stat));
    snapshots.set(absDir, { stat, names: entries.map((entry) => entry.name) });

    for (const entry of entries) {
      const childRel = `${relDir}/${entry.name}`;
      // These checks deliberately precede lstat: an unknown/protected name is not even
      // admitted as a metadata candidate, so it cannot trigger descent or body access.
      validateRuntimeRelativePath(childRel, `${label} member path`);
      const kind = expectedDirectories.has(childRel)
        ? "directory"
        : expectedRegulars.has(childRel)
          ? "regular"
          : expectedAliases.has(childRel)
            ? "alias"
            : null;
      if (!kind) {
        throw new Error(`${label} contains undeclared member ${childRel}`);
      }
      memberCount += 1;
      if (memberCount > MAX_RUNTIME_MEMBERS) {
        throw new Error(`${label} exceeds maximum member ceiling (${MAX_RUNTIME_MEMBERS})`);
      }
      const childAbs = join(absDir, entry.name);
      const childStat = await lstat(childAbs, { bigint: true });
      if (kind === "directory") {
        if (childStat.isSymbolicLink() || !childStat.isDirectory()) {
          throw new Error(`${label} expected real directory at ${childRel}`);
        }
        await visit(childAbs, childRel);
        continue;
      }
      if (kind === "alias") {
        if (!childStat.isSymbolicLink()) {
          throw new Error(`${label} expected alias at ${childRel}`);
        }
        const beforeFrame = statFull9(childStat);
        const target = await readlink(childAbs);
        const afterStat = await lstat(childAbs, { bigint: true });
        if (!full9Equal(statFull9(afterStat), beforeFrame)) {
          throw new Error(`${label} alias changed during readlink: ${childRel}`);
        }
        const declaredAlias = expectedAliases.get(childRel);
        if (!declaredAlias) {
          throw new Error(`${label} is missing declared alias ${childRel}`);
        }
        if (target !== declaredAlias.target) {
          throw new Error(`${label} alias raw target mismatch at ${childRel}`);
        }
        aliasFrames.set(childRel, { full9: beforeFrame, target });
        continue;
      }
      if (childStat.isSymbolicLink() || !childStat.isFile()) {
        throw new Error(`${label} expected regular file at ${childRel}`);
      }
      if (Number(childStat.nlink) !== 1) {
        throw new Error(`${label} refused hardlinked regular ${childRel}`);
      }
      if ((Number(childStat.mode) & 0o7000) !== 0) {
        throw new Error(`${label} regular has privilege bits at ${childRel}`);
      }
      const bytes = Number(childStat.size);
      if (bytes < 0 || bytes > MAX_RUNTIME_FILE_BYTES) {
        throw new Error(`${label} regular exceeds byte limit at ${childRel}`);
      }
      const declaredRegular = expectedRegulars.get(childRel);
      if (!declaredRegular) {
        throw new Error(`${label} is missing declared regular ${childRel}`);
      }
      if (bytes !== declaredRegular.bytes || (Number(childStat.mode) & 0o777) !== declaredRegular.mode) {
        throw new Error(`${label} regular declared metadata mismatch at ${childRel}`);
      }
      totalBytes += bytes;
      if (totalBytes > MAX_RUNTIME_TOTAL_BYTES) {
        throw new Error(`${label} exceeds total byte ceiling (${MAX_RUNTIME_TOTAL_BYTES})`);
      }
      regularMetadata.set(childRel, {
        full9: statFull9(childStat),
        bytes,
        mode: Number(childStat.mode) & 0o777,
      });
    }
  };

  await visit(absRoot, relRoot);
  if (directoryFrames.size !== expectedDirectories.size) {
    throw new Error(`${label} directory count ${directoryFrames.size} does not match declared namespace count ${expectedDirectories.size}`);
  }
  if (regularMetadata.size !== expectedRegulars.size) {
    throw new Error(`${label} regular count ${regularMetadata.size} does not match declared namespace count ${expectedRegulars.size}`);
  }
  if (aliasFrames.size !== expectedAliases.size) {
    throw new Error(`${label} alias count ${aliasFrames.size} does not match declared namespace count ${expectedAliases.size}`);
  }
  for (const path of expectedDirectories.keys()) {
    if (!directoryFrames.has(path)) throw new Error(`${label} is missing declared directory ${path}`);
  }
  for (const path of expectedRegulars.keys()) {
    if (!regularMetadata.has(path)) throw new Error(`${label} is missing declared regular ${path}`);
  }
  for (const path of expectedAliases.keys()) {
    if (!aliasFrames.has(path)) throw new Error(`${label} is missing declared alias ${path}`);
  }

  // Resolve aliases from the metadata-only table before any regular body is consumed.
  const aliasMap = new Map([...aliasFrames].map(([path, row]) => [path, row.target]));
  const regularSet = new Set(regularMetadata.keys());
  const directorySet = new Set(directoryFrames.keys());
  for (const [path, row] of aliasFrames) {
    const declared = expectedAliases.get(path);
    if (!declared) throw new Error(`${label} is missing expected alias metadata for ${path}`);
    const canonicalPath = resolveRuntimeAliasChain(path, row.target, aliasMap, regularSet, directorySet);
    if (canonicalPath !== declared.canonical) {
      throw new Error(`${label} alias canonical mismatch at ${path}`);
    }
  }

  /** @type {Map<string, { full9: (string|number)[], bytes: number, mode: number, sha256: string, buffer: Buffer }>} */
  const regularFrames = new Map();
  for (const [path, metadata] of regularMetadata) {
    const relativePath = path === relRoot ? "" : path.slice(relRoot.length + 1);
    const info = await readRegularDescriptorChecked(join(absRoot, relativePath), MAX_RUNTIME_FILE_BYTES);
    if (!full9Equal(info.full9, metadata.full9) || info.bytes !== metadata.bytes || info.mode !== metadata.mode) {
      throw new Error(`${label} regular changed between metadata admission and body read: ${path}`);
    }
    regularFrames.set(path, info);
  }

  for (const [directory, snapshot] of snapshots) {
    await verifyDirectorySnapshot(directory, snapshot.stat, snapshot.names, label);
  }
  for (const [path, frame] of aliasFrames) {
    const relativePath = path === relRoot ? "" : path.slice(relRoot.length + 1);
    const aliasPath = join(absRoot, relativePath);
    const current = await lstat(aliasPath, { bigint: true });
    if (!current.isSymbolicLink() || !full9Equal(statFull9(current), frame.full9) || await readlink(aliasPath) !== frame.target) {
      throw new Error(`${label} alias changed after namespace admission: ${path}`);
    }
  }
  for (const [path, metadata] of regularMetadata) {
    const relativePath = path === relRoot ? "" : path.slice(relRoot.length + 1);
    const current = await lstat(join(absRoot, relativePath), { bigint: true });
    if (!full9Equal(statFull9(current), metadata.full9)) {
      throw new Error(`${label} regular changed after namespace admission: ${path}`);
    }
  }

  return { directoryFrames, regularFrames, aliasFrames, snapshots, memberCount, totalBytes };
}

/**
 * @param {string} destPath
 * @param {string | Uint8Array} content
 * @param {number} mode
 */
async function writeExclusiveFile(destPath, content, mode) {
  await writeFile(destPath, content, { flag: "wx", mode });
  await chmod(destPath, mode);
}

/**
 * @param {string} filePath
 * @param {number} maxBytes
 */
export async function readRegularDescriptorChecked(filePath, maxBytes) {
  let fh;
  /** @type {(string|number)[] | null} */
  let openedFrame = null;
  /** @type {unknown} */
  let primaryError = null;
  try {
    fh = await open(filePath, REGULAR_READ_FLAGS);
  } catch (error) {
    const fsError = /** @type {NodeJS.ErrnoException} */ (error);
    if (fsError.code === "ELOOP" || fsError.code === "EMLINK") {
      throw new Error(`Expected regular file (not symlink): ${filePath}`);
    }
    throw error;
  }
  try {
    const opened = await fh.stat({ bigint: true });
    if (!opened.isFile()) {
      throw new Error(`Expected regular file (not symlink): ${filePath}`);
    }
    if (Number(opened.nlink) !== 1) {
      throw new Error(`Hardlinked regular file refused (nlink=${String(opened.nlink)}): ${filePath}`);
    }
    if ((Number(opened.mode) & 0o7000) !== 0) {
      throw new Error(`Unexpected privilege bits on regular file: ${filePath}`);
    }
    const size = Number(opened.size);
    if (size < 0 || size > maxBytes) {
      throw new Error(`Regular file exceeds byte limit (${size} > ${maxBytes}): ${filePath}`);
    }
    const beforeFrame = statFull9(opened);
    openedFrame = beforeFrame;
    const namedBefore = await lstat(filePath, { bigint: true });
    if (namedBefore.isSymbolicLink() || !namedBefore.isFile() || !full9Equal(statFull9(namedBefore), beforeFrame)) {
      throw new Error(`Named file drift on open: ${filePath}`);
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
      throw new Error(`Regular file size changed during read: ${filePath}`);
    }
    const ended = await fh.stat({ bigint: true });
    if (!full9Equal(statFull9(ended), beforeFrame)) {
      throw new Error(`Descriptor drift after read: ${filePath}`);
    }
    const namedAfterRead = await lstat(filePath, { bigint: true });
    if (namedAfterRead.isSymbolicLink() || !namedAfterRead.isFile() || !full9Equal(statFull9(namedAfterRead), beforeFrame)) {
      throw new Error(`Named file drift after read: ${filePath}`);
    }
    const sha256 = createHash("sha256").update(buf).digest("hex");
    return {
      bytes: size,
      mode: Number(opened.mode) & 0o777,
      sha256,
      full9: beforeFrame,
      buffer: buf,
    };
  } catch (err) {
    primaryError = err;
    throw err;
  } finally {
    await fh.close();
    if (!primaryError && openedFrame) {
      const afterNamed = await lstat(filePath, { bigint: true });
      if (afterNamed.isSymbolicLink() || !afterNamed.isFile() || !full9Equal(statFull9(afterNamed), openedFrame)) {
        throw new Error(`Named file drift after close: ${filePath}`);
      }
    }
  }
}

/**
 * Checks whether two absolute paths overlap (equal or ancestor/descendant).
 * @param {string} a
 * @param {string} b
 */
export function pathsOverlap(a, b) {
  const ra = resolve(a);
  const rb = resolve(b);
  if (ra === rb) return true;
  const relAB = relative(ra, rb);
  if (relAB && !relAB.startsWith("..") && !relAB.startsWith(sep)) return true;
  const relBA = relative(rb, ra);
  if (relBA && !relBA.startsWith("..") && !relBA.startsWith(sep)) return true;
  return false;
}

/**
 * Captures and validates the complete source runtime tree against material.
 * @param {string} sourceRoot
 * @param {Record<string, any>} material
 */
export async function captureRuntimeSourceSnapshot(sourceRoot, material) {
  if (typeof sourceRoot !== "string" || !sourceRoot.startsWith("/") || sourceRoot.includes("\0")) {
    throw new Error("Native runtime sourceRoot must be an absolute path");
  }
  const resolvedSource = resolve(sourceRoot);
  for (const part of resolvedSource.split(sep).filter(Boolean)) {
    if (PROTECTED_COMPONENTS.has(part.toLowerCase()) || PROTECTED_SUFFIX_RE.test(part)) {
      throw new Error(`Native runtime sourceRoot contains protected component: ${ part }`);
    }
  }
  const rootStat = await lstat(resolvedSource, { bigint: true });
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Native runtime sourceRoot must be a real directory");
  }
  const optPath = join(resolvedSource, "opt");
  const optStat = await lstat(optPath, { bigint: true });
  if (optStat.isSymbolicLink() || !optStat.isDirectory()) {
    throw new Error("Native runtime sourceRoot/opt must be a real directory");
  }

  const admitted = await admitRuntimeNamespace(
    join(resolvedSource, PRIVATE_RUNTIME_PREFIX),
    PRIVATE_RUNTIME_PREFIX,
    material,
    "Runtime source",
  );
  /** @type {Map<string, (string|number)[]>} */
  const directoryFrames = new Map(
    [...admitted.directoryFrames].map(([path, frame]) => [path, frame]),
  );
  /** @type {Map<string, { full9: (string|number)[], bytes: number, mode: number, sha256: string }>} */
  const regularFrames = new Map(
    [...admitted.regularFrames].map(([path, info]) => [path, {
      full9: info.full9,
      bytes: info.bytes,
      mode: info.mode,
      sha256: info.sha256,
    }]),
  );
  /** @type {Map<string, { full9: (string|number)[], target: string }>} */
  const aliasFrames = new Map(
    [...admitted.aliasFrames].map(([path, frame]) => [path, frame]),
  );

  if (directoryFrames.size !== material.directories.length) {
    throw new Error(`Runtime source directory count (${directoryFrames.size}) does not match material (${material.directories.length})`);
  }
  for (const dir of material.directories) {
    if (!directoryFrames.has(dir.path)) {
      throw new Error(`Runtime source is missing declared directory ${dir.path}`);
    }
  }

  if (regularFrames.size !== material.regulars.length) {
    throw new Error(`Runtime source regular count (${regularFrames.size}) does not match material (${material.regulars.length})`);
  }
  for (const reg of material.regulars) {
    const actual = regularFrames.get(reg.path);
    if (!actual) {
      throw new Error(`Runtime source is missing declared regular file ${reg.path}`);
    }
    if (actual.bytes !== reg.bytes || actual.mode !== reg.mode || actual.sha256 !== reg.sha256) {
      throw new Error(`Runtime source regular mismatch at ${reg.path}`);
    }
  }

  if (aliasFrames.size !== material.aliases.length) {
    throw new Error(`Runtime source alias count (${aliasFrames.size}) does not match material (${material.aliases.length})`);
  }
  for (const alias of material.aliases) {
    const actual = aliasFrames.get(alias.path);
    if (!actual) {
      throw new Error(`Runtime source is missing declared alias ${alias.path}`);
    }
    if (actual.target !== alias.target) {
      throw new Error(`Runtime source alias target mismatch at ${alias.path}: expected ${alias.target}, got ${actual.target}`);
    }
  }

  return {
    sourceRoot: resolvedSource,
    rootFull9: statFull9(rootStat),
    optFull9: statFull9(optStat),
    directoryFrames,
    regularFrames,
    aliasFrames,
  };
}

/**
 * Authenticates a local nebular-native-runtime-input-v1 JSON file and its sourceRoot.
 * @param {string} inputPath
 * @param {string} expectedSha256
 * @param {{ expectedTarget?: string | null, outputRoots?: string[], overlapRoots?: string[] }} [options]
 */
export async function authenticateNativeRuntimeInput(inputPath, expectedSha256, options = {}) {
  if (typeof inputPath !== "string" || !inputPath) {
    throw new Error("Native runtime input path is required");
  }
  if (typeof expectedSha256 !== "string" || !HEX64_RE.test(expectedSha256)) {
    throw new Error("Native runtime input requires an exact 64-hex SHA-256 digest");
  }
  const resolvedInputPath = resolve(inputPath);
  const inputFile = await readRegularDescriptorChecked(resolvedInputPath, MAX_RUNTIME_INPUT_BYTES);
  if (inputFile.sha256 !== expectedSha256) {
    throw new Error(`Native runtime input SHA-256 mismatch: expected ${expectedSha256}, got ${inputFile.sha256}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(inputFile.buffer.toString("utf8"));
  } catch (err) {
    throw new Error(`Malformed native runtime input JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  assertClosedObject(parsed, "native runtime input", [
    "schema",
    "target",
    "sourceRoot",
    "material",
    "evidence",
  ]);
  if (parsed.schema !== NATIVE_RUNTIME_INPUT_SCHEMA) {
    throw new Error(`Unsupported native runtime input schema: ${String(parsed.schema)}`);
  }
  if (typeof parsed.target !== "string" || !SUPPORTED_LINUX_TARGETS.includes(parsed.target)) {
    throw new Error(`Native runtime input is only supported on Linux targets, got ${String(parsed.target)}`);
  }
  if (options.expectedTarget && parsed.target !== options.expectedTarget) {
    throw new Error(`Native runtime input target ${parsed.target} does not match authority target ${options.expectedTarget}`);
  }
  if (!parsed.evidence || typeof parsed.evidence !== "object" || Array.isArray(parsed.evidence)) {
    throw new Error("Native runtime input evidence must be an object of parent-reviewed acceptance digests");
  }
  const evidenceEntries = Object.entries(parsed.evidence);
  if (
    evidenceEntries.length === 0 ||
    evidenceEntries.some(([k, v]) => typeof k !== "string" || typeof v !== "string" || !HEX64_RE.test(v))
  ) {
    throw new Error("Native runtime input evidence must contain exact 64-hex SHA-256 acceptance digests");
  }

  const material = validateRuntimeMaterial(parsed.material, parsed.target);
  if (typeof parsed.sourceRoot !== "string" || !parsed.sourceRoot.startsWith("/")) {
    throw new Error("Native runtime input sourceRoot must be an absolute path");
  }
  const resolvedSourceRoot = resolve(parsed.sourceRoot);
  if (pathsOverlap(resolvedInputPath, resolvedSourceRoot)) {
    throw new Error("Native runtime input descriptor must not reside inside sourceRoot");
  }
  for (const outRoot of options.outputRoots ?? options.overlapRoots ?? []) {
    if (outRoot && pathsOverlap(resolvedSourceRoot, outRoot)) {
      throw new Error(`Native runtime sourceRoot overlaps output/stage root`);
    }
  }

  const sourceSnapshot = await captureRuntimeSourceSnapshot(resolvedSourceRoot, material);
  return {
    inputPath: resolvedInputPath,
    inputSha256: inputFile.sha256,
    inputFull9: inputFile.full9,
    target: parsed.target,
    sourceRoot: resolvedSourceRoot,
    material,
    evidence: parsed.evidence,
    sourceSnapshot,
  };
}

/**
 * Re-verifies that the authenticated native runtime input and its sourceRoot have not drifted.
 * @param {Awaited<ReturnType<typeof authenticateNativeRuntimeInput>>} authenticated
 */
export async function verifyRuntimeSourceSnapshot(authenticated) {
  const inputNow = await readRegularDescriptorChecked(authenticated.inputPath, MAX_RUNTIME_INPUT_BYTES);
  if (inputNow.sha256 !== authenticated.inputSha256 || !full9Equal(inputNow.full9, authenticated.inputFull9)) {
    throw new Error("Native runtime input descriptor drifted after initial authentication");
  }
  const currentSnapshot = await captureRuntimeSourceSnapshot(authenticated.sourceRoot, authenticated.material);
  if (
    !full9Equal(currentSnapshot.rootFull9, authenticated.sourceSnapshot.rootFull9) ||
    !full9Equal(currentSnapshot.optFull9, authenticated.sourceSnapshot.optFull9)
  ) {
    throw new Error("Native runtime sourceRoot or opt directory frame drifted");
  }
  for (const [dirPath, frame] of authenticated.sourceSnapshot.directoryFrames.entries()) {
    const nowFrame = currentSnapshot.directoryFrames.get(dirPath);
    if (!nowFrame || !full9Equal(nowFrame, frame)) {
      throw new Error(`Native runtime source directory frame drifted at ${dirPath}`);
    }
  }
  for (const [regPath, info] of authenticated.sourceSnapshot.regularFrames.entries()) {
    const nowInfo = currentSnapshot.regularFrames.get(regPath);
    if (
      !nowInfo ||
      !full9Equal(nowInfo.full9, info.full9) ||
      nowInfo.sha256 !== info.sha256 ||
      nowInfo.bytes !== info.bytes ||
      nowInfo.mode !== info.mode
    ) {
      throw new Error(`Native runtime source regular file drifted at ${regPath}`);
    }
  }
  for (const [aliasPath, info] of authenticated.sourceSnapshot.aliasFrames.entries()) {
    const nowInfo = currentSnapshot.aliasFrames.get(aliasPath);
    if (!nowInfo || !full9Equal(nowInfo.full9, info.full9) || nowInfo.target !== info.target) {
      throw new Error(`Native runtime source alias drifted at ${aliasPath}`);
    }
  }
}

/**
 * Stages the authenticated private runtime into payloadRoot/opt/nebular-private and writes payloadRoot/native-runtime.json.
 * Always re-verifies source custody in finally on every outcome.
 * @param {string} payloadRoot
 * @param {Awaited<ReturnType<typeof authenticateNativeRuntimeInput>>} authenticated
 */
export async function stageNativeRuntime(payloadRoot, authenticated) {
  const resolvedPayload = resolve(payloadRoot);
  if (pathsOverlap(resolvedPayload, authenticated.sourceRoot)) {
    throw new Error("Native payload root must not overlap runtime sourceRoot");
  }
  const payloadStat = await lstat(resolvedPayload, { bigint: true });
  if (payloadStat.isSymbolicLink() || !payloadStat.isDirectory()) {
    throw new Error("Native payload root must be a real directory");
  }

  /** @type {unknown} */
  let primaryError = null;
  try {
    const optDir = join(resolvedPayload, "opt");
    const privateDir = join(resolvedPayload, PRIVATE_RUNTIME_PREFIX);
    const markerPath = join(resolvedPayload, PRIVATE_RUNTIME_MARKER);
    for (const checkPath of [optDir, privateDir, markerPath]) {
      try {
        await lstat(checkPath);
        throw new Error(`Refusing to overwrite existing runtime path in payload: ${basename(checkPath)}`);
      } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code !== "ENOENT") throw err;
      }
    }

    await mkdir(optDir, { mode: 0o755 });
    await chmod(optDir, 0o755);

    for (const dir of authenticated.material.directories) {
      const targetDir = join(resolvedPayload, dir.path);
      await mkdir(targetDir, { mode: dir.mode });
      await chmod(targetDir, dir.mode);
    }

    for (const reg of authenticated.material.regulars) {
      const srcPath = join(authenticated.sourceRoot, reg.path);
      const expectedFrame = authenticated.sourceSnapshot.regularFrames.get(reg.path);
      const readRes = await readRegularDescriptorChecked(srcPath, MAX_RUNTIME_FILE_BYTES);
      if (
        !expectedFrame ||
        !full9Equal(readRes.full9, expectedFrame.full9) ||
        readRes.bytes !== reg.bytes ||
        readRes.sha256 !== reg.sha256 ||
        readRes.mode !== reg.mode
      ) {
        throw new Error(`Runtime source regular failed pre-copy verification at ${reg.path}`);
      }
      const destPath = join(resolvedPayload, reg.path);
      await writeExclusiveFile(destPath, readRes.buffer, reg.mode);
      const destReadback = await readRegularDescriptorChecked(destPath, MAX_RUNTIME_FILE_BYTES);
      if (destReadback.bytes !== reg.bytes || destReadback.sha256 !== reg.sha256 || destReadback.mode !== reg.mode) {
        throw new Error(`Runtime staged regular readback mismatch at ${reg.path}`);
      }
    }

    for (const alias of authenticated.material.aliases) {
      const srcAliasPath = join(authenticated.sourceRoot, alias.path);
      const expectedAlias = authenticated.sourceSnapshot.aliasFrames.get(alias.path);
      const srcSt = await lstat(srcAliasPath, { bigint: true });
      const rawTarget = await readlink(srcAliasPath);
      if (!expectedAlias || !full9Equal(statFull9(srcSt), expectedAlias.full9) || rawTarget !== alias.target) {
        throw new Error(`Runtime source alias failed pre-copy verification at ${alias.path}`);
      }
      const destAliasPath = join(resolvedPayload, alias.path);
      await symlink(alias.target, destAliasPath);
      const destSt = await lstat(destAliasPath, { bigint: true });
      const destTarget = await readlink(destAliasPath);
      if (!destSt.isSymbolicLink() || destTarget !== alias.target) {
        throw new Error(`Runtime staged alias readback mismatch at ${alias.path}`);
      }
    }

    await writeExclusiveFile(markerPath, canonicalJson(authenticated.material), 0o644);
    const payloadInventory = await inventoryNativePayload(resolvedPayload);
    return {
      material: authenticated.material,
      payloadInventory,
    };
  } catch (err) {
    primaryError = err;
    throw err;
  } finally {
    try {
      await verifyRuntimeSourceSnapshot(authenticated);
    } catch (postErr) {
      if (!primaryError) {
        throw postErr;
      }
      if (primaryError instanceof Error) {
        /** @type {any} */ (primaryError).postguardError = postErr;
      }
    }
  }
}

/**
 * Writes the local native-runtime-material.json receipt into outputDir.
 * @param {string} outputDir
 * @param {{ target: string, material: Record<string, any>, sourceCandidate: string, payloadInventory: Record<string, any>, inputSha256: string }} params
 */
export async function writeNativeRuntimeReceipt(outputDir, { target, material, sourceCandidate, payloadInventory, inputSha256 }) {
  validateRuntimeMaterial(material, target);
  if (typeof sourceCandidate !== "string" || !HEX64_RE.test(sourceCandidate)) {
    throw new Error("Native runtime receipt requires a valid 64-hex sourceCandidate digest");
  }
  if (typeof inputSha256 !== "string" || !HEX64_RE.test(inputSha256)) {
    throw new Error("Native runtime receipt requires a valid 64-hex inputSha256 digest");
  }
  if (
    !payloadInventory ||
    typeof payloadInventory !== "object" ||
    payloadInventory.schema !== NATIVE_PAYLOAD_INVENTORY_SCHEMA ||
    payloadInventory.materialDigest !== material.materialDigest ||
    typeof payloadInventory.identity !== "string" ||
    !HEX64_RE.test(payloadInventory.identity) ||
    identity({
      schema: payloadInventory.schema,
      materialDigest: payloadInventory.materialDigest,
      files: payloadInventory.files,
      aliases: payloadInventory.aliases,
      directories: payloadInventory.directories,
    }) !== payloadInventory.identity
  ) {
    throw new Error("Native runtime receipt requires a verified nebular-native-payload-inventory-v1 matching materialDigest");
  }
  const receipt = {
    schema: NATIVE_RUNTIME_RECEIPT_SCHEMA,
    target,
    materialDigest: material.materialDigest,
    sourceCandidate,
    nativePayload: payloadInventory.identity,
    inputSha256,
  };
  const receiptPath = join(resolve(outputDir), PRIVATE_RUNTIME_RECEIPT);
  await writeExclusiveFile(receiptPath, canonicalJson(receipt), 0o644);
  return receipt;
}

/**
 * Computes the canonical payload inventory (R1).
 * When native-runtime.json is absent, returns the exact existing inventoryTree(root) result.
 * When native-runtime.json is present, validates the portable material and full runtime tree
 * and returns the domain-separated nebular-native-payload-inventory-v1 object.
 * @param {string} root
 * @param {{ expectedTarget?: string | null, aliasProjection?: unknown, rootEnvelope?: Record<string, { bytes: number, mode: number, sha256: string, full9: (string|number)[] }> | null } | string | null} [options]
 * @returns {Promise<NativePayloadInventory>}
 */
export async function inventoryNativePayload(root, options = null) {
  const expectedTarget = typeof options === "string" ? options : (options?.expectedTarget ?? null);
  const suppliedProjection = typeof options === "object" && options !== null ? options.aliasProjection ?? null : null;
  const suppliedRootEnvelope = typeof options === "object" && options !== null ? options.rootEnvelope ?? null : null;
  const resolvedRoot = resolve(root);
  await statStableNoFollow(resolvedRoot, { label: "native payload root", expectDirectory: true });

  const rootEnvelopeEntries = suppliedRootEnvelope === null ? [] : Object.entries(suppliedRootEnvelope);
  const rootEnvelopePaths = new Set(rootEnvelopeEntries.map(([path]) => path));
  if (suppliedRootEnvelope !== null) {
    const legalNames = new Set(["LICENSE", "NOTICE"]);
    if (rootEnvelopeEntries.length !== legalNames.size || rootEnvelopeEntries.some(([path]) => !legalNames.has(path))) {
      throw new Error("Native payload root envelope must contain exactly LICENSE and NOTICE");
    }
    for (const [path, expected] of rootEnvelopeEntries) {
      const validFull9 = Array.isArray(expected?.full9) && expected.full9.length === 9 &&
        expected.full9.every((value) => (typeof value === "string" && value.length > 0) ||
          (typeof value === "number" && Number.isSafeInteger(value) && value >= 0));
      if (!expected || expected.bytes < 0 || expected.mode !== 0o644 || !/^[a-f0-9]{64}$/u.test(expected.sha256) || !validFull9) {
        throw new Error(`Malformed native payload root envelope entry ${path}`);
      }
    }
    await verifyRootEnvelope(resolvedRoot, rootEnvelopeEntries, "Native payload root envelope");
  }

  const markerPath = join(resolvedRoot, PRIVATE_RUNTIME_MARKER);
  let markerExists = false;
  try {
    const st = await lstat(markerPath, { bigint: true });
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new Error(`Malformed native runtime marker at ${PRIVATE_RUNTIME_MARKER}: must be a regular file`);
    }
    markerExists = true;
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== "ENOENT") {
      throw err;
    }
  }

  if (!markerExists) {
    if (suppliedProjection !== null) {
      throw new Error("Native runtime alias projection requires native-runtime.json");
    }
    const strayPrivatePath = join(resolvedRoot, PRIVATE_RUNTIME_PREFIX);
    try {
      await lstat(strayPrivatePath);
      throw new Error(`Unmarked private runtime directory ${PRIVATE_RUNTIME_PREFIX} present without ${PRIVATE_RUNTIME_MARKER}`);
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== "ENOENT") {
        throw err;
      }
    }
    const ordinaryInventory = await inventoryTree(resolvedRoot);
    if (rootEnvelopePaths.size === 0) return ordinaryInventory;
    for (const [path, expected] of rootEnvelopeEntries) {
      const ordinary = ordinaryInventory.files.find((entry) => entry.path === path);
      if (!ordinary || ordinary.bytes !== expected.bytes || ordinary.mode !== expected.mode || ordinary.sha256 !== expected.sha256) {
        throw new Error(`Native payload root envelope ordinary inventory mismatch at ${path}`);
      }
    }
    const files = ordinaryInventory.files.filter(({ path }) => !rootEnvelopePaths.has(path));
    await verifyRootEnvelope(resolvedRoot, rootEnvelopeEntries, "Native payload root envelope changed after ordinary inventory");
    return { files, identity: identity(files) };
  }

  const markerFile = await readRegularDescriptorChecked(markerPath, MAX_RUNTIME_INPUT_BYTES);
  let rawMaterial;
  try {
    rawMaterial = JSON.parse(markerFile.buffer.toString("utf8"));
  } catch (err) {
    throw new Error(`Malformed ${PRIVATE_RUNTIME_MARKER}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const material = validateRuntimeMaterial(rawMaterial, expectedTarget);
  const aliasProjection = suppliedProjection === null
    ? null
    : validateNativeRuntimeAliasProjection(suppliedProjection, material);
  let projectedPhysical = false;
  let admissionMaterial = material;
  if (aliasProjection !== null && material.aliases.length > 0) {
    const aliasKinds = new Set();
    for (const alias of material.aliases) {
      const aliasStat = await lstat(join(resolvedRoot, alias.path), { bigint: true });
      aliasKinds.add(aliasStat.isSymbolicLink() ? "symlink" : aliasStat.isFile() ? "regular" : "other");
    }
    if (aliasKinds.has("other") || aliasKinds.size > 1) {
      throw new Error("Native runtime alias projection has mixed or non-regular physical aliases");
    }
    projectedPhysical = aliasKinds.has("regular");
    if (projectedPhysical) {
      admissionMaterial = {
        ...material,
        regulars: [
          ...material.regulars,
          ...aliasProjection.aliases.map((entry) => ({
            path: entry.path,
            bytes: entry.bytes,
            sha256: entry.sha256,
            mode: entry.mode,
            role: "npm-alias-projection",
          })),
        ],
        aliases: [],
      };
    }
  }
  const admitted = await admitRuntimeNamespace(
    join(resolvedRoot, PRIVATE_RUNTIME_PREFIX),
    PRIVATE_RUNTIME_PREFIX,
    admissionMaterial,
    "Native payload runtime",
  );

  /** @type {Set<string>} */
  const projectedAliasPaths = new Set(aliasProjection?.aliases.map((entry) => entry.path) ?? []);
  const files = [...admitted.regularFrames].filter(([path]) => !projectedAliasPaths.has(path)).map(([path, info]) => ({
    path,
    bytes: info.bytes,
    mode: (info.mode & 0o111) ? 0o755 : 0o644,
    sha256: info.sha256,
  }));
  /** @type {{ path: string, target: string, canonical: string }[]} */
  const aliases = [];
  /** @type {{ path: string, mode: number }[]} */
  const directories = [...admitted.directoryFrames].map(([path]) => ({ path, mode: 0o755 }));

  /** @type {Map<string, number>} */
  const runtimeDirsObserved = new Map(
    [...admitted.directoryFrames].map(([path]) => [path, 0o755]),
  );
  /** @type {Map<string, { bytes: number, mode: number, sha256: string }>} */
  const runtimeRegularsObserved = new Map(
    [...admitted.regularFrames].map(([path, info]) => [path, {
      bytes: info.bytes,
      mode: info.mode,
      sha256: info.sha256,
    }]),
  );
  /** @type {Map<string, string>} */
  const runtimeAliasesObserved = new Map(
    [...admitted.aliasFrames].map(([path, frame]) => [path, frame.target]),
  );
  /** @type {Map<string, { stat: import("node:fs").BigIntStats, names: string[] }>} */
  const snapshots = new Map(admitted.snapshots);

  let memberCount = admitted.memberCount;
  let totalBytes = admitted.totalBytes;

  /**
   * @param {string} absDir
   * @param {string} relDir
   */
  const walkPayload = async (absDir, relDir) => {
    // The private subtree was admitted completely from metadata and its selected bodies
    // were read by admitRuntimeNamespace before this ordinary inventory walk begins.
    if (relDir === PRIVATE_RUNTIME_PREFIX) return;
    const { stat: dirStat, entries } = await openNoFollowDir(absDir);
    snapshots.set(absDir, { stat: dirStat, names: entries.map((e) => e.name) });

    if (relDir) {
      memberCount += 1;
      if (memberCount > MAX_RUNTIME_MEMBERS) {
        throw new Error(`Native payload exceeds maximum member ceiling (${MAX_RUNTIME_MEMBERS})`);
      }
      directories.push({ path: relDir, mode: 0o755 });
      if (relDir === PRIVATE_RUNTIME_PREFIX || relDir.startsWith(`${PRIVATE_RUNTIME_PREFIX}/`)) {
        if ((Number(dirStat.mode) & 0o7000) !== 0) {
          throw new Error(`Unexpected privilege bits on runtime directory ${relDir}`);
        }
        runtimeDirsObserved.set(relDir, Number(dirStat.mode) & 0o777);
      }
    }

    for (const entry of entries) {
      const childAbs = join(absDir, entry.name);
      if (!relDir && rootEnvelopePaths.has(entry.name)) {
        const expected = suppliedRootEnvelope?.[entry.name];
        if (!expected) throw new Error(`Missing expected root envelope entry ${entry.name}`);
        const observed = await readRegularDescriptorChecked(childAbs, MAX_RUNTIME_FILE_BYTES);
        if (!rootEnvelopeEntryEqual(observed, expected)) {
          throw new Error(`Native payload root envelope changed at ${entry.name}`);
        }
        continue;
      }
      const childRel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (childRel !== childRel.normalize("NFC") || childRel.includes("\0") || childRel.includes("\\")) {
        throw new Error(`Invalid payload member path: ${childRel}`);
      }
      const st = await lstat(childAbs, { bigint: true });
      if (st.isDirectory() && !st.isSymbolicLink()) {
        await walkPayload(childAbs, childRel);
      } else if (st.isSymbolicLink()) {
        if (!childRel.startsWith(`${PRIVATE_RUNTIME_PREFIX}/`)) {
          throw new Error(`Non-regular inventory member: ${childRel}`);
        }
        memberCount += 1;
        if (memberCount > MAX_RUNTIME_MEMBERS) {
          throw new Error(`Native payload exceeds maximum member ceiling (${MAX_RUNTIME_MEMBERS})`);
        }
        const beforeFrame = statFull9(st);
        const rawTarget = await readlink(childAbs);
        const afterStat = await lstat(childAbs, { bigint: true });
        if (!full9Equal(statFull9(afterStat), beforeFrame)) {
          throw new Error(`Payload alias changed during inventory: ${childRel}`);
        }
        runtimeAliasesObserved.set(childRel, rawTarget);
      } else if (st.isFile()) {
        memberCount += 1;
        if (memberCount > MAX_RUNTIME_MEMBERS) {
          throw new Error(`Native payload exceeds maximum member ceiling (${MAX_RUNTIME_MEMBERS})`);
        }
        const stable = await statStableNoFollow(childAbs, {
          label: childRel,
          expectFile: true,
          maxBytes: MAX_RUNTIME_FILE_BYTES,
        });
        const size = Number(stable.size);
        totalBytes += size;
        if (totalBytes > MAX_RUNTIME_TOTAL_BYTES) {
          throw new Error(`Native payload exceeds total byte ceiling (${MAX_RUNTIME_TOTAL_BYTES})`);
        }
        const sha256 = await hashRegularNoFollow(childAbs, stable, {
          label: childRel,
          maxBytes: MAX_RUNTIME_FILE_BYTES,
        });
        const physicalMode = Number(stable.mode) & 0o777;
        const logicalMode = (Number(stable.mode) & 0o111) ? 0o755 : 0o644;
        if (childRel.startsWith(`${PRIVATE_RUNTIME_PREFIX}/`)) {
          if (Number(stable.nlink) !== 1) {
            throw new Error(`Hardlinked runtime regular refused at ${childRel}`);
          }
          if ((Number(stable.mode) & 0o7000) !== 0) {
            throw new Error(`Unexpected privilege bits on runtime regular ${childRel}`);
          }
          runtimeRegularsObserved.set(childRel, { bytes: size, mode: physicalMode, sha256 });
        }
        files.push({ path: childRel, bytes: size, mode: logicalMode, sha256 });
      } else {
        throw new Error(`Non-regular inventory member: ${childRel}`);
      }
    }
  };

  await walkPayload(resolvedRoot, "");
  if (rootEnvelopeEntries.length > 0) {
    await verifyRootEnvelope(resolvedRoot, rootEnvelopeEntries, "Native payload root envelope changed after payload walk");
  }

  for (const [dir, snap] of snapshots.entries()) {
    await verifyDirectorySnapshot(dir, snap.stat, snap.names, "native payload directory");
  }

  if (runtimeDirsObserved.size !== material.directories.length) {
    throw new Error(
      `Payload runtime directory count (${runtimeDirsObserved.size}) does not match material (${material.directories.length})`,
    );
  }
  for (const dir of material.directories) {
    const observedMode = runtimeDirsObserved.get(dir.path);
    if (observedMode === undefined) {
      throw new Error(`Payload runtime is missing declared directory ${dir.path}`);
    }
    if (observedMode !== dir.mode) {
      throw new Error(`Payload runtime directory mode mismatch at ${dir.path}: expected ${dir.mode}, got ${observedMode}`);
    }
  }

  const projectedAliases = aliasProjection?.aliases ?? [];
  const expectedPhysicalRegulars = projectedPhysical
    ? [...material.regulars, ...projectedAliases.map((entry) => ({
      path: entry.path,
      bytes: entry.bytes,
      mode: entry.mode,
      sha256: entry.sha256,
    }))]
    : material.regulars;
  if (runtimeRegularsObserved.size !== expectedPhysicalRegulars.length) {
    throw new Error(
      `Payload runtime regular count (${runtimeRegularsObserved.size}) does not match material (${expectedPhysicalRegulars.length})`,
    );
  }
  for (const reg of expectedPhysicalRegulars) {
    const observed = runtimeRegularsObserved.get(reg.path);
    if (!observed) {
      throw new Error(`Payload runtime is missing declared regular ${reg.path}`);
    }
    if (observed.bytes !== reg.bytes || observed.mode !== reg.mode || observed.sha256 !== reg.sha256) {
      throw new Error(`Payload runtime regular mismatch at ${reg.path}`);
    }
  }

  if (runtimeAliasesObserved.size !== (projectedPhysical ? 0 : material.aliases.length)) {
    throw new Error(
      `Payload runtime alias count (${runtimeAliasesObserved.size}) does not match material (${material.aliases.length})`,
    );
  }
  const regularSet = new Set(runtimeRegularsObserved.keys());
  const dirSet = new Set(runtimeDirsObserved.keys());
  for (const declaredAlias of projectedPhysical ? [] : material.aliases) {
    const observedTarget = runtimeAliasesObserved.get(declaredAlias.path);
    if (observedTarget === undefined) {
      throw new Error(`Payload runtime is missing declared alias ${declaredAlias.path}`);
    }
    if (observedTarget !== declaredAlias.target) {
      throw new Error(`Payload runtime alias target mismatch at ${declaredAlias.path}`);
    }
    const resolvedCanonical = resolveRuntimeAliasChain(
      declaredAlias.path,
      observedTarget,
      runtimeAliasesObserved,
      regularSet,
      dirSet,
    );
    if (resolvedCanonical !== declaredAlias.canonical) {
      throw new Error(`Payload runtime alias canonical mismatch at ${declaredAlias.path}`);
    }
    if (aliasProjection === null) {
      aliases.push({
        path: declaredAlias.path,
        target: observedTarget,
        canonical: resolvedCanonical,
      });
    }
  }
  if (aliasProjection !== null) {
    aliases.push(...aliasProjection.aliases.map(({ path, target, canonical }) => ({ path, target, canonical })));
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  aliases.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  directories.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const payload = {
    schema: NATIVE_PAYLOAD_INVENTORY_SCHEMA,
    materialDigest: material.materialDigest,
    files,
    aliases,
    directories,
  };
  return {
    ...payload,
    identity: identity(payload),
  };
}

/**
 * Shared private-mode selector for raw assemblers and native-rc qualifier.
 * Returns { nativeRuntime: false, material: null, inventory: null } when native-runtime.json is genuinely absent.
 * Validates the portable manifest and complete runtime tree when present, refusing malformed markers or unsupported targets.
 * @param {string} payloadRoot
 * @param {string | null} [expectedTarget]
 * @param {{ aliasProjection?: unknown, rootEnvelope?: Record<string, { bytes: number, mode: number, sha256: string, full9: (string|number)[] }> | null } | null} [options]
 */
export async function selectPayloadNativeRuntime(payloadRoot, expectedTarget = null, options = null) {
  const resolvedRoot = resolve(payloadRoot);
  await statStableNoFollow(resolvedRoot, { label: "payload root", expectDirectory: true });

  const markerPath = join(resolvedRoot, PRIVATE_RUNTIME_MARKER);
  let markerExists = false;
  try {
    const st = await lstat(markerPath, { bigint: true });
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new Error(`Malformed native runtime marker at ${PRIVATE_RUNTIME_MARKER}: must be a regular file`);
    }
    markerExists = true;
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== "ENOENT") {
      throw err;
    }
  }

  if (!markerExists) {
    if (options?.aliasProjection !== undefined && options?.aliasProjection !== null) {
      throw new Error("Native runtime alias projection requires native-runtime.json");
    }
    const strayPrivatePath = join(resolvedRoot, PRIVATE_RUNTIME_PREFIX);
    try {
      await lstat(strayPrivatePath);
      throw new Error(`Unmarked private runtime directory ${PRIVATE_RUNTIME_PREFIX} present without ${PRIVATE_RUNTIME_MARKER}`);
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== "ENOENT") {
        throw err;
      }
    }
    return { nativeRuntime: false, material: null, inventory: null };
  }

  const markerFile = await readRegularDescriptorChecked(markerPath, MAX_RUNTIME_INPUT_BYTES);
  let rawMaterial;
  try {
    rawMaterial = JSON.parse(markerFile.buffer.toString("utf8"));
  } catch (err) {
    throw new Error(`Malformed ${PRIVATE_RUNTIME_MARKER}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const material = validateRuntimeMaterial(rawMaterial, expectedTarget);
  const aliasProjection = options?.aliasProjection ?? null;
  const rootEnvelope = options?.rootEnvelope ?? null;
  const inventory = await inventoryNativePayload(resolvedRoot, { expectedTarget, aliasProjection, rootEnvelope });
  return {
    nativeRuntime: true,
    material,
    inventory,
  };
}

/**
 * Constructs a sanitized environment for private runtime child execution or ldd inspection.
 * Strips all inherited LD_* variables and GLIBC_TUNABLES, and sets LD_LIBRARY_PATH to <payloadRoot>/opt/nebular-private/lib.
 * @param {string} payloadRoot
 * @param {NodeJS.ProcessEnv} [baseEnv]
 * @returns {Promise<Record<string, string>>}
 */
export async function createPrivateRuntimeEnvironment(payloadRoot, baseEnv = process.env) {
  const resolvedRoot = resolve(payloadRoot);
  for (const rel of ["", "opt", ...REQUIRED_RUNTIME_DIRECTORIES]) {
    const checkDir = rel ? join(resolvedRoot, rel) : resolvedRoot;
    const st = await lstat(checkDir, { bigint: true });
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(`Private runtime required directory is missing or aliased: ${rel || "."}`);
    }
  }
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value !== "string") continue;
    if (key === "GLIBC_TUNABLES" || key.startsWith("LD_")) continue;
    env[key] = value;
  }
  env.LD_LIBRARY_PATH = join(resolvedRoot, PRIVATE_RUNTIME_PREFIX, "lib");
  return env;
}

/**
 * Parses readelf (-h -l -d -V) output into structured ELF metadata.
 * @param {string} readelfText
 * @param {string | null} [expectedTarget]
 * @returns {ElfMetadata}
 */
export function parseElfMetadata(readelfText, expectedTarget = null) {
  if (typeof readelfText !== "string" || !readelfText.trim()) {
    throw new Error("Empty readelf output");
  }
  const classMatch = readelfText.match(/^\s*Class:\s*(.+)$/mu);
  const machineMatch = readelfText.match(/^\s*Machine:\s*(.+)$/mu);
  const typeMatch = readelfText.match(/^\s*Type:\s*(\S+)/mu);
  if (!classMatch || !machineMatch || !typeMatch) {
    throw new Error("Malformed readelf header output");
  }
  const elfClass = requiredCapture(classMatch, 1, "ELF class").trim();
  const machine = requiredCapture(machineMatch, 1, "ELF machine").trim();
  const elfType = requiredCapture(typeMatch, 1, "ELF type").trim();
  if (elfClass !== "ELF64") {
    throw new Error(`Unsupported ELF class: ${elfClass}`);
  }
  if (expectedTarget === "aarch64-unknown-linux-gnu" && machine !== "AArch64") {
    throw new Error(`Expected AArch64 ELF machine for ${expectedTarget}, got ${machine}`);
  }
  if (
    expectedTarget === "x86_64-unknown-linux-gnu" &&
    machine !== "Advanced Micro Devices X86-64" &&
    machine !== "X86-64"
  ) {
    throw new Error(`Expected X86-64 ELF machine for ${expectedTarget}, got ${machine}`);
  }

  const needed = [...readelfText.matchAll(/\(NEEDED\)\s+Shared library:\s+\[([^\]]+)\]/gu)].map((m) => {
    const name = requiredCapture(m, 1, "DT_NEEDED").trim();
    if (!SONAME_RE.test(name)) throw new Error(`Invalid DT_NEEDED library name: ${name}`);
    return name;
  });
  const sonames = [...readelfText.matchAll(/\(SONAME\)\s+Library soname:\s+\[([^\]]+)\]/gu)].map((m) => {
    const name = requiredCapture(m, 1, "DT_SONAME").trim();
    if (!SONAME_RE.test(name)) throw new Error(`Invalid DT_SONAME library name: ${name}`);
    return name;
  });
  if (sonames.length > 1) {
    throw new Error(`Multiple DT_SONAME entries found: ${sonames.join(", ")}`);
  }
  const interpreters = [...readelfText.matchAll(/\[Requesting program interpreter:\s*([^\]]+)\]/gu)].map((m) =>
    requiredCapture(m, 1, "ELF interpreter").trim(),
  );
  const rpaths = [...readelfText.matchAll(/\((RUNPATH|RPATH)\)\s+Library (?:runpath|rpath):\s+\[([^\]]*)\]/gu)].map(
    (m) => ({
      kind: requiredCapture(m, 1, "ELF path kind"),
      value: requiredCapture(m, 2, "ELF path value"),
    }),
  );

  /** @type {string[]} */
  const versionDefinitions = [];
  /** @type {{ provider: string, name: string }[]} */
  const versionNeeds = [];

  let section = "none";
  /** @type {string | null} */
  let currentProvider = null;

  for (const line of readelfText.split(/\r?\n/u)) {
    if (/^Version definition section\b/u.test(line)) {
      section = "def";
      currentProvider = null;
      continue;
    }
    if (/^Version needs section\b/u.test(line)) {
      section = "need";
      currentProvider = null;
      continue;
    }
    if (/^(?:Version symbols section|Displaying notes|Symbol table|Histogram|Attribute Section)\b/u.test(line)) {
      section = "none";
      currentProvider = null;
      continue;
    }

    if (section === "def") {
      const defMatch = line.match(/\bName:\s+([A-Za-z0-9_.-]+)/u);
      if (defMatch) {
        const name = requiredCapture(defMatch, 1, "version definition");
        if (!SONAME_RE.test(name) || !name.endsWith(".so") && !name.includes(".so.")) {
          if (!versionDefinitions.includes(name)) versionDefinitions.push(name);
        }
      }
    } else if (section === "need") {
      const fileMatch = line.match(/\bFile:\s+(\S+)/u);
      if (fileMatch) {
        const provider = requiredCapture(fileMatch, 1, "version need provider").trim();
        if (!SONAME_RE.test(provider)) {
          throw new Error(`Invalid version need provider filename: ${provider}`);
        }
        currentProvider = provider;
      }
      const needMatch = line.match(/\bName:\s+([A-Za-z0-9_.-]+)/u);
      if (needMatch) {
        if (!currentProvider) {
          throw new Error(`Version need ${requiredCapture(needMatch, 1, "version need")} missing provider File header`);
        }
        versionNeeds.push({ provider: currentProvider, name: requiredCapture(needMatch, 1, "version need") });
      }
    }
  }

  return {
    class: elfClass,
    machine,
    elfType,
    soname: sonames[0] ?? null,
    needed,
    interpreters,
    rpaths,
    versionDefinitions: versionDefinitions.sort(),
    versionNeeds,
  };
}

/**
 * Parses ldd output into structured provider resolution rows.
 * @param {string} lddText
 * @returns {LddProviderRow[]}
 */
export function parseLddProviders(lddText) {
  if (typeof lddText !== "string") {
    throw new Error("Invalid ldd output");
  }
  /** @type {LddProviderRow[]} */
  const rows = [];
  for (const rawLine of lddText.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("linux-vdso.so") || line.startsWith("linux-gate.so") || line === "statically linked") {
      continue;
    }
    const arrowMatch = line.match(/^(\S+)\s+=>\s+(.+)$/u);
    if (arrowMatch) {
      const soname = requiredCapture(arrowMatch, 1, "ldd soname").trim();
      const rhs = requiredCapture(arrowMatch, 2, "ldd resolution").trim();
      if (/^not found\b/iu.test(rhs)) {
        rows.push({ soname, resolvedPath: null, status: "missing" });
        continue;
      }
      const pathMatch = rhs.match(/^(\/.+?)\s+\(0x[0-9a-fA-F]+\)$/u);
      if (pathMatch) {
        rows.push({ soname, resolvedPath: requiredCapture(pathMatch, 1, "ldd resolved path"), status: "resolved" });
        continue;
      }
      throw new Error(`Unparseable ldd provider resolution line: ${line}`);
    }
    const interpMatch = line.match(/^(\/.+?)\s+\(0x[0-9a-fA-F]+\)$/u);
    if (interpMatch) {
      const resolvedPath = requiredCapture(interpMatch, 1, "ldd interpreter path");
      rows.push({ soname: posix.basename(resolvedPath), resolvedPath, status: "interpreter" });
      continue;
    }
    throw new Error(`Unparseable ldd output line: ${line}`);
  }
  return rows;
}

export const NATIVE_RUNTIME_FLOOR_OBSERVATION_SCHEMA = "nebular-native-runtime-consumer-floor-observation-v1";

/**
 * @param {string} aliasPath
 * @param {unknown} rawTarget
 */
function resolveObservedProviderTarget(aliasPath, rawTarget) {
  if (
    typeof rawTarget !== "string" ||
    !rawTarget ||
    rawTarget.length > MAX_RUNTIME_PATH_LENGTH ||
    rawTarget.includes("\0") ||
    rawTarget.includes("\\")
  ) {
    throw new Error(`Observed provider alias target is invalid at ${aliasPath}`);
  }
  return rawTarget.startsWith("/")
    ? resolve(rawTarget)
    : resolve(dirname(aliasPath), rawTarget);
}

/** @param {string} target */
function expectedProviderMachine(target) {
  return target === "aarch64-unknown-linux-gnu"
    ? ["AArch64"]
    : ["Advanced Micro Devices X86-64", "X86-64"];
}

/**
 * Validate the local, non-portable observation produced by a trusted consumer qualifier.
 * Baseline externalFloor rows are intentionally not accepted as observations: this object
 * binds the current terminal, its bytes and its actual version definitions for this run.
 * @param {unknown} observation
 * @param {{ target?: string | null, materialDigest?: string | null, expectedNativePayload?: string | null }} [expected]
 * @returns {ConsumerFloorObservation}
 */
export function validateConsumerFloorObservation(observation, expected = {}) {
  assertClosedObject(observation, "consumer floor observation", [
    "schema",
    "target",
    "materialDigest",
    "expectedNativePayload",
    "observedProviderRows",
    "subjectResolutionRows",
    "toolEvidence",
    "observationIdentity",
  ]);
  if (observation.schema !== NATIVE_RUNTIME_FLOOR_OBSERVATION_SCHEMA) {
    throw new Error(`Unsupported consumer floor observation schema: ${String(observation.schema)}`);
  }
  if (typeof observation.target !== "string" || !SUPPORTED_LINUX_TARGETS.includes(observation.target)) {
    throw new Error("Consumer floor observation target is unsupported");
  }
  if (expected.target && observation.target !== expected.target) {
    throw new Error(`Consumer floor observation target ${observation.target} does not match ${expected.target}`);
  }
  if (expected.materialDigest && observation.materialDigest !== expected.materialDigest) {
    throw new Error("Consumer floor observation materialDigest does not match the private material");
  }
  if (typeof observation.materialDigest !== "string" || !HEX64_RE.test(observation.materialDigest)) {
    throw new Error("Consumer floor observation materialDigest must be a 64-hex digest");
  }
  if (typeof observation.expectedNativePayload !== "string" || !HEX64_RE.test(observation.expectedNativePayload)) {
    throw new Error("Consumer floor observation expectedNativePayload must be a 64-hex digest");
  }
  if (expected.expectedNativePayload && observation.expectedNativePayload !== expected.expectedNativePayload) {
    throw new Error("Consumer floor observation expectedNativePayload does not match the authenticated payload");
  }
  if (!Array.isArray(observation.observedProviderRows) || observation.observedProviderRows.length === 0) {
    throw new Error("Consumer floor observation requires observedProviderRows");
  }
  const providerIds = new Set();
  for (const row of observation.observedProviderRows) {
    assertClosedObject(row, "consumer floor provider row", [
      "soname",
      "classification",
      "requestedPath",
      "terminalPath",
      "aliasChain",
      "terminalFull9",
      "bytes",
      "sha256",
      "elfMachine",
      "elfClass",
      "versionDefinitions",
      "readelfEvidenceSha256",
    ]);
    if (typeof row.soname !== "string" || !SONAME_RE.test(row.soname)) throw new Error("Invalid observed provider soname");
    if (![
      "external-floor",
      "interpreter",
    ].includes(row.classification)) throw new Error(`Invalid observed provider classification ${String(row.classification)}`);
    if (typeof row.requestedPath !== "string" || !row.requestedPath.startsWith("/")) throw new Error("Observed provider requestedPath must be absolute");
    if (typeof row.terminalPath !== "string" || !row.terminalPath.startsWith("/")) throw new Error("Observed provider terminalPath must be absolute");
    if (!Array.isArray(row.aliasChain)) throw new Error("Observed provider aliasChain must be an array");
    let nextPath = row.requestedPath;
    for (const alias of row.aliasChain) {
      assertClosedObject(alias, "observed provider alias row", ["path", "rawTarget", "full9"]);
      if (alias.path !== nextPath || typeof alias.path !== "string" || !alias.path.startsWith("/")) {
        throw new Error("Observed provider alias chain is not path-contiguous");
      }
      if (!Array.isArray(alias.full9) || alias.full9.length !== 9 || alias.full9.some((value) => !["string", "number"].includes(typeof value))) {
        throw new Error("Observed provider alias full9 is invalid");
      }
      nextPath = resolveObservedProviderTarget(alias.path, alias.rawTarget);
    }
    if (nextPath !== row.terminalPath) throw new Error("Observed provider alias chain does not terminate at terminalPath");
    if (row.aliasChain.length === 0 && row.requestedPath !== row.terminalPath) {
      throw new Error("Observed provider direct terminal path is inconsistent");
    }
    if (!Array.isArray(row.terminalFull9) || row.terminalFull9.length !== 9 || row.terminalFull9.some((value) => !["string", "number"].includes(typeof value))) {
      throw new Error("Observed provider terminalFull9 must contain nine scalar fields");
    }
    if (!Number.isInteger(row.bytes) || row.bytes <= 0 || row.bytes > MAX_RUNTIME_FILE_BYTES) throw new Error("Observed provider bytes are invalid");
    if (typeof row.sha256 !== "string" || !HEX64_RE.test(row.sha256)) throw new Error("Observed provider sha256 is invalid");
    if (row.elfClass !== "ELF64" || !expectedProviderMachine(observation.target).includes(row.elfMachine)) {
      throw new Error(`Observed provider ELF identity does not match ${observation.target}`);
    }
    if (!Array.isArray(row.versionDefinitions) || row.versionDefinitions.some((value) => typeof value !== "string" || !value)) {
      throw new Error("Observed provider versionDefinitions are invalid");
    }
    assertStrictlySortedUnique(row.versionDefinitions, `Observed provider definitions for ${row.soname}`);
    if (typeof row.readelfEvidenceSha256 !== "string" || !HEX64_RE.test(row.readelfEvidenceSha256)) {
      throw new Error("Observed provider readelf evidence digest is invalid");
    }
    const id = identity(row);
    if (providerIds.has(id)) throw new Error(`Duplicate observed provider row ${row.soname}`);
    providerIds.add(id);
  }
  if (!Array.isArray(observation.subjectResolutionRows)) throw new Error("Consumer floor observation subjectResolutionRows must be an array");
  for (const row of observation.subjectResolutionRows) {
    assertClosedObject(row, "consumer floor subject resolution row", [
      "subjectRelativePath",
      "neededSoname",
      "resolvedPath",
      "providerObservationIdentity",
    ]);
    if (typeof row.subjectRelativePath !== "string" || !row.subjectRelativePath || typeof row.neededSoname !== "string" || !SONAME_RE.test(row.neededSoname)) {
      throw new Error("Consumer floor subject resolution row is malformed");
    }
    if (typeof row.resolvedPath !== "string" || !row.resolvedPath.startsWith("/")) throw new Error("Consumer floor resolution path is malformed");
    if (typeof row.providerObservationIdentity !== "string" || !HEX64_RE.test(row.providerObservationIdentity) || !providerIds.has(row.providerObservationIdentity)) {
      throw new Error("Consumer floor resolution row is missing its provider observation");
    }
  }
  assertClosedObject(observation.toolEvidence, "consumer floor observation toolEvidence", [
    "readelfRole",
    "resolutionToolRole",
    "boundedResults",
    "cleanupFacts",
  ]);
  if (!Array.isArray(observation.toolEvidence.boundedResults) || observation.toolEvidence.boundedResults.length === 0) {
    throw new Error("Consumer floor observation requires bounded tool results");
  }
  if (!observation.toolEvidence.cleanupFacts || typeof observation.toolEvidence.cleanupFacts !== "object") {
    throw new Error("Consumer floor observation requires cleanupFacts");
  }
  if (typeof observation.observationIdentity !== "string" || !HEX64_RE.test(observation.observationIdentity)) {
    throw new Error("Consumer floor observation identity is invalid");
  }
  const unsigned = { ...observation };
  delete unsigned.observationIdentity;
  if (identity(unsigned) !== observation.observationIdentity) {
    throw new Error("Consumer floor observation identity does not match its contents");
  }
  return /** @type {ConsumerFloorObservation} */ (observation);
}

/**
 * @param {number[]} a
 * @param {number[]} b
 */
function compareVersionTuple(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Classifies and validates ELF metadata, version needs/definitions, and ldd provider resolution
 * against the portable material and 17 declared external floor terminals.
 * @param {{
 *   target: string,
 *   payloadRoot: string,
 *   material: Record<string, any>,
 *   elfRecords?: Record<string, ElfMetadata>,
 *   lddRecords?: LddProviderRow[],
 *   floorObservation?: ConsumerFloorObservation | null,
 *   expectedNativePayload?: string | null,
 *   glibcMaximum?: number[],
 * }} options
 */
export function classifyAndValidateRuntimeClosure({
  target,
  payloadRoot,
  material,
  elfRecords = {},
  lddRecords = [],
  floorObservation = null,
  expectedNativePayload = null,
  glibcMaximum = [2, 36],
}) {
  validateRuntimeMaterial(material, target);
  const resolvedPayload = resolve(payloadRoot);
  const privateRoot = join(resolvedPayload, PRIVATE_RUNTIME_PREFIX);
  const expectedInterpreter = interpreterForTarget(target);
  const floorMap = new Map(
    material.externalFloor.map((/** @type {any} */ entry) => [entry.soname, entry]),
  );

  /** @type {Map<string, string>} */
  const privateSonameToRegular = new Map();
  for (const reg of material.regulars) {
    if (reg.path.startsWith(`${PRIVATE_RUNTIME_PREFIX}/lib/`)) {
      privateSonameToRegular.set(posix.basename(reg.path), reg.path);
    }
  }
  for (const alias of material.aliases) {
    if (alias.path.startsWith(`${PRIVATE_RUNTIME_PREFIX}/lib/`)) {
      privateSonameToRegular.set(posix.basename(alias.path), alias.canonical);
    }
  }

  /** @type {string[]} */
  const problems = [];
  let observation = null;
  if (floorObservation) {
    try {
      observation = validateConsumerFloorObservation(floorObservation, {
        target,
        materialDigest: material.materialDigest,
        expectedNativePayload,
      });
    } catch (error) {
      problems.push(`invalid consumer floor observation: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    problems.push("missing actual consumer floor observation");
  }

  /** @type {Map<string, Set<string>>} */
  const providerDefinitions = new Map();
  const observedProviders = observation?.observedProviderRows ?? [];
  for (const row of observedProviders) {
    providerDefinitions.set(identity(row), new Set(row.versionDefinitions));
  }

  /** @param {LddProviderRow} row @param {"external-floor" | "interpreter"} classification */
  const observedFor = (row, classification) => {
    if (!row.resolvedPath) return undefined;
    const resolvedPath = resolve(row.resolvedPath);
    return observedProviders.find((candidate) =>
    candidate.soname === row.soname &&
    candidate.classification === classification &&
    (candidate.requestedPath === resolvedPath || candidate.terminalPath === resolvedPath)
    );
  };
  /** @param {string} subjectRelativePath @param {string} neededSoname @param {LddProviderRow} row @param {"external-floor" | "interpreter"} classification */
  const subjectObservedFor = (subjectRelativePath, neededSoname, row, classification) => {
    const provider = observedFor(row, classification);
    if (!provider) return false;
    const providerId = identity(provider);
    return observation?.subjectResolutionRows.some((candidate) =>
      candidate.subjectRelativePath === subjectRelativePath &&
      candidate.neededSoname === neededSoname &&
      candidate.providerObservationIdentity === providerId
    ) ?? false;
  };
  /** @param {string} subjectRelativePath @param {string} neededSoname */
  const observedForSubjectNeed = (subjectRelativePath, neededSoname) => {
    /** @type {ObservedProviderRow[]} */
    const providers = [];
    const seen = new Set();
    for (const row of lddRecords) {
      if (
        row.subjectRelativePath !== subjectRelativePath ||
        row.status === "missing" ||
        !row.resolvedPath ||
        (row.soname !== neededSoname && posix.basename(resolve(row.resolvedPath)) !== neededSoname)
      ) continue;
      const classification = row.status === "interpreter" ? "interpreter" : "external-floor";
      const provider = observedFor(row, classification);
      if (provider) {
        const providerId = identity(provider);
        if (!seen.has(providerId)) {
          seen.add(providerId);
          providers.push(provider);
        }
      }
    }
    return providers;
  };

  if (observation) {
    for (const provider of observedProviders) {
      const matchingLdd = lddRecords.some((row) =>
        row.status !== "missing" &&
        row.soname === provider.soname &&
        row.resolvedPath &&
        (resolve(row.resolvedPath) === provider.requestedPath || resolve(row.resolvedPath) === provider.terminalPath) &&
        (row.status === "interpreter") === (provider.classification === "interpreter")
      );
      if (!matchingLdd) {
        problems.push(`consumer floor observation contains an unmeasured provider ${provider.soname} => ${provider.terminalPath}`);
      }
    }
  }

  for (const [objPath, meta] of Object.entries(elfRecords)) {
    for (const needed of meta.needed ?? []) {
      const matches = lddRecords.filter((row) => row.subjectRelativePath === objPath && row.soname === needed && row.status !== "missing" && row.resolvedPath);
      if (matches.length === 0) {
        problems.push(`${objPath} has no resolved observation for required provider ${needed}`);
        continue;
      }
      for (const row of matches) {
        const classification = row.status === "interpreter"
          ? "interpreter"
          : "external-floor";
        if (!observedFor(row, classification)) {
          problems.push(`${objPath} is missing actual provider observation for ${needed} at ${row.resolvedPath}`);
        } else if (!subjectObservedFor(objPath, needed, row, classification)) {
          problems.push(`${objPath} is missing subject resolution observation for ${needed} at ${row.resolvedPath}`);
        }
      }
    }
  }

  /** @type {{ soname: string, classification: "private-material" | "external-floor" | "interpreter", path: string }[]} */
  const classifications = [];
  /** @type {number[]} */
  let maxGlibcObserved = [0, 0];

  for (const [objPath, meta] of Object.entries(elfRecords)) {
    for (const interp of meta.interpreters ?? []) {
      if (interp !== expectedInterpreter) {
        problems.push(`${objPath} requests unexpected ELF interpreter ${interp} (expected ${expectedInterpreter})`);
      }
    }
    for (const needed of meta.needed ?? []) {
      if (!privateSonameToRegular.has(needed) && !floorMap.has(needed)) {
        problems.push(`${objPath} requires undeclared DT_NEEDED provider ${needed}`);
      }
    }
    for (const need of meta.versionNeeds ?? []) {
      if (need.name === "GLIBC_PRIVATE") {
        problems.push(`${objPath} requires disallowed private symbol version GLIBC_PRIVATE from ${need.provider}`);
        continue;
      }
      const glibcMatch = need.name.match(/^GLIBC_(\d+(?:\.\d+)*)$/u);
      if (glibcMatch) {
        const tuple = requiredCapture(glibcMatch, 1, "GLIBC version").split(".").map(Number);
        if (compareVersionTuple(tuple, maxGlibcObserved) > 0) {
          maxGlibcObserved = tuple;
        }
        if (compareVersionTuple(tuple, glibcMaximum) > 0) {
          problems.push(`${objPath} requires ${need.name}, exceeding GLIBC_${glibcMaximum.join(".")}`);
        }
      }
      const providers = observedForSubjectNeed(objPath, need.provider);
      if (providers.length === 0) {
        problems.push(`${objPath} requires version ${need.name} from provider ${need.provider}, but no actual provider observation was recorded`);
      } else {
        for (const provider of providers) {
          const defs = providerDefinitions.get(identity(provider));
          if (!defs || !defs.has(need.name)) {
            problems.push(`${objPath} requires missing version definition ${need.name} from provider ${need.provider}`);
          }
        }
      }
    }
  }

  for (const row of lddRecords) {
    if (row.status === "missing" || !row.resolvedPath) {
      problems.push(`missing runtime provider ${row.soname}`);
      continue;
    }
    const observedRow = observedFor(row, row.status === "interpreter" ? "interpreter" : "external-floor");
    const resolvedAbs = resolve(observedRow?.terminalPath ?? row.resolvedPath);
    if (row.status === "interpreter") {
      const interpreterPath = observedRow?.terminalPath ?? row.resolvedPath;
      if (interpreterPath !== expectedInterpreter && posix.basename(interpreterPath) !== loaderSonameForTarget(target)) {
        problems.push(`unexpected runtime interpreter ${interpreterPath}`);
      } else if (!observedRow) {
        problems.push(`missing actual interpreter observation ${row.resolvedPath}`);
      } else {
        classifications.push({
          soname: row.soname,
          classification: "interpreter",
          path: interpreterPath,
        });
      }
      continue;
    }

    const isInsidePrivate =
      resolvedAbs === privateRoot || resolvedAbs.startsWith(`${privateRoot}${sep}`);
    if (isInsidePrivate) {
      const relToPayload = relative(resolvedPayload, resolvedAbs).split(sep).join("/");
      const expectedCanonical = privateSonameToRegular.get(row.soname);
      if (!expectedCanonical) {
        problems.push(`undeclared private provider ${row.soname} resolved to ${relToPayload}`);
      } else if (relToPayload !== expectedCanonical && `${PRIVATE_RUNTIME_PREFIX}/lib/${row.soname}` !== relToPayload) {
        problems.push(
          `private provider ${row.soname} resolved to ${relToPayload}, expected ${expectedCanonical}`,
        );
      } else {
        const observed = observedFor(row, "external-floor");
        if (!observed) {
          problems.push(`missing actual private provider observation ${row.soname} => ${row.resolvedPath}`);
          continue;
        }
        classifications.push({
          soname: row.soname,
          classification: "private-material",
          path: relToPayload,
        });
      }
    } else {
      if (privateSonameToRegular.has(row.soname)) {
        problems.push(
          `uncontrolled host fallback for private library ${row.soname} => ${row.resolvedPath}`,
        );
      } else if (!floorMap.has(row.soname)) {
        problems.push(
          `unapproved host provider fallback: ${row.soname} => ${row.resolvedPath}`,
        );
      } else {
        const observed = observedFor(row, "external-floor");
        if (!observed) {
          problems.push(`missing actual external-floor observation ${row.soname} => ${row.resolvedPath}`);
          continue;
        }
        classifications.push({
          soname: row.soname,
          classification: "external-floor",
          path: row.resolvedPath,
        });
      }
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    maxGlibcObserved: maxGlibcObserved[0] ? maxGlibcObserved.join(".") : null,
    interpreter: expectedInterpreter,
    dynamicHelperRoles: [...REQUIRED_RUNTIME_ROLES],
    classifications,
  };
}
