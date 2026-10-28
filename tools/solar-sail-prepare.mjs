#!/usr/bin/env node
// @ts-check
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readdir, rm, writeFile } from "node:fs/promises";
import { constants, existsSync, readdirSync } from "node:fs";
import { dirname, resolve, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { repositoryRootForStudio } from "./sidecar-common.mjs";
import { inventoryTree } from "./candidate-provenance.mjs";
import { targetForHost } from "./platform-targets.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const studioRoot = resolve(__dirname, "..");

export const EXPECTED_SOLAR_SAIL_NAME = "@knowledge-forge-ai/theme-forge-solar-sail";
export const EXPECTED_SOLAR_SAIL_VERSION = "0.3.0";
export const SUPPORTED_SOLAR_SAIL_VERSIONS = Object.freeze(["0.3.0", "0.2.1", "0.1.0"]);
export const EXPECTED_SOLAR_SAIL_INVENTORY_DIGEST = "d79c087c6bafa99888fd274895b8d5fe9ab6f27325a3469d159f2b1c9565c616";
export const ADMITTED_SOLAR_SAIL_ARCHIVE_VERSION = "0.3.0";
export const ADMITTED_SOLAR_SAIL_ARCHIVE_SIZE = 110_836;
export const ADMITTED_SOLAR_SAIL_ARCHIVE_SHA256 =
  "65070c3478a1d55476c1b09fbe1dcadfdf7c3d3aa54a154bc9ac9e299411f415";

export const SOLAR_SAIL_BINDING_SCHEMA = "tfsb.solar-sail-binding-v1";
export const SOLAR_SAIL_BUILD_PIN_SCHEMA = "nebular-solar-sail-build-pin-v1";
export const SOLAR_SAIL_TOP_LEVEL_FILES = Object.freeze([
  "COMMERCIAL-LICENSE.md",
  "LICENSE",
  "NOTICE",
  "README.md",
  "package.json",
  "solar-sail-binding.json",
]);
export const SOLAR_SAIL_LEGAL_DOCS = Object.freeze([
  "LICENSE",
  "NOTICE",
  "COMMERCIAL-LICENSE.md",
  "README.md",
]);
export const MAX_SOLAR_SAIL_BINDING_BYTES = 1024 * 1024;
export const MAX_SOLAR_SAIL_MEMBER_BYTES = 8 * 1024 * 1024;
export const MAX_SOLAR_SAIL_TOTAL_DIST_BYTES = 64 * 1024 * 1024;
export const MAX_SOLAR_SAIL_MEMBER_COUNT = 4096;

export const SOLAR_SAIL_RUNTIME_MEMBERS = Object.freeze([
  "dist/cli.js",
  "dist/compiler.js",
  "dist/emitter.js",
  "dist/index.js",
  "dist/legal.js",
  "dist/profile.js",
  "dist/types.js",
  "dist/validator.js",
]);

export const SOLAR_SAIL_DECLARATION_MEMBERS = Object.freeze([
  "dist/cli.d.ts",
  "dist/compiler.d.ts",
  "dist/emitter.d.ts",
  "dist/index.d.ts",
  "dist/legal.d.ts",
  "dist/profile.d.ts",
  "dist/types.d.ts",
  "dist/validator.d.ts",
]);

/** @typedef {"structured-source" | "published-archive"} SolarSailRoute */

/**
 * @typedef {object} SolarSailSourceComponent
 * @property {string} [name]
 * @property {string} [target]
 * @property {string} [source]
 * @property {string} [componentSource]
 * @property {string} [output]
 * @property {string} [producer]
 * @property {string} [version]
 */

/**
 * @typedef {object} SolarSailSourceAuthority
 * @property {string} [sourceModel]
 * @property {string} [sourceCandidate]
 * @property {string} [target]
 * @property {SolarSailSourceComponent} [component]
 */

/**
 * @typedef {object} StructuredSourceProvenance
 * @property {string} sourceCandidate
 * @property {string} componentSource
 * @property {string} output
 * @property {string} producer
 * @property {string} version
 */

/**
 * @typedef {object} PublishedArchiveProvenance
 * @property {string} name
 * @property {string} version
 * @property {number} size
 * @property {string} sha256
 */

/** @typedef {{structuredSource: StructuredSourceProvenance} | {publishedArchive: PublishedArchiveProvenance}} SolarSailProvenance */

/**
 * @typedef {object} SolarSailBindingMember
 * @property {string} path
 * @property {number} size
 * @property {string} sha256
 */

/**
 * @typedef {object} SolarSailBinding
 * @property {string} schema
 * @property {string} name
 * @property {string} version
 * @property {string} packageJsonSha256
 * @property {string} inventoryDigest
 * @property {number} runtimeMemberCount
 * @property {SolarSailBindingMember[]} members
 */

/**
 * @typedef {object} SolarSailBuildPin
 * @property {string} schema
 * @property {string} target
 * @property {{name: string, version: string, packageJsonSha256: string}} package
 * @property {{size: number, sha256: string, inventoryDigest: string, memberCount: number}} binding
 * @property {SolarSailProvenance} provenance
 */

/**
 * @typedef {object} SolarSailBuildPinValidationOptions
 * @property {string} [target]
 * @property {SolarSailRoute} [route]
 * @property {string} [sourceCandidate]
 * @property {string} [componentSource]
 * @property {string} [output]
 * @property {string} [producer]
 * @property {string} [version]
 */

/**
 * @typedef {object} SolarSailPreparationOptions
 * @property {string} [studioRoot]
 * @property {string} [payloadRoot]
 * @property {string} [adapterDir]
 * @property {string} [buildPinPath]
 * @property {string} [packageRoot]
 * @property {string} [tarball]
 * @property {string} [target]
 * @property {string} [expectedInventoryDigest]
 * @property {SolarSailSourceAuthority} [sourceAuthority]
 */

/**
 * @typedef {object} SolarSailDistMember
 * @property {string} path
 * @property {number} size
 * @property {string} sha256
 * @property {Buffer} bytes
 */

/**
 * Computes SHA-256 hexadecimal digest of buffer or string.
 * @param {Buffer | Uint8Array | string} content
 * @returns {string}
 */
export function sha256Hex(content) {
  return createHash("sha256").update(content).digest("hex");
}

/** @param {string | null | undefined} value @returns {value is string} */
function isHex64(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

/** @param {object | null | undefined} obj @param {readonly string[]} expectedKeys @returns {boolean} */
function hasExactKeys(obj, expectedKeys) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const keys = Object.keys(obj);
  return keys.length === expectedKeys.length && expectedKeys.every((k) => Object.prototype.hasOwnProperty.call(obj, k));
}

/** @param {import("node:fs").BigIntStats} stat @returns {(string | number)[]} */
function statFull9(stat) {
  return [
    String(stat.dev),
    String(stat.ino),
    Number(stat.size),
    Number(stat.mode),
    String(stat.mtimeNs),
    String(stat.ctimeNs),
    Number(stat.uid),
    Number(stat.gid),
    Number(stat.nlink),
  ];
}

/** @param {(string | number)[]} left @param {(string | number)[]} right */
function sameStatFull9(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Opens a regular file once, reads only bounded bytes through the held descriptor, and brackets
 * that read with descriptor and pathname full9 checks. Hardlinks and privilege bits are refused
 * so the archive identity cannot be redirected through another name or a privileged file.
 *
 * @param {string} filePath
 * @param {string} [tag]
 * @param {number} [maxBytes]
 * @returns {Promise<Buffer>}
 */
async function readRegularFileNoFollow(filePath, tag = "SOLAR_SAIL_PREPARE_FAIL", maxBytes = MAX_SOLAR_SAIL_MEMBER_BYTES) {
  let handle;
  let openedFrame = null;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new Error(`[${tag}] Missing required file: ${filePath}`);
    }
    if (code === "ELOOP" || code === "EMLINK") {
      throw new Error(`[${tag}] Path must be a regular non-symlink file: ${filePath}`);
    }
    throw new Error(`[${tag}] Failed to open file with O_NOFOLLOW|O_NONBLOCK: ${filePath}`);
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) {
      throw new Error(`[${tag}] Path must be a regular non-symlink file: ${filePath}`);
    }
    if (Number(opened.nlink) !== 1) {
      throw new Error(`[${tag}] Hardlinked regular file refused (nlink=${String(opened.nlink)}): ${filePath}`);
    }
    if ((Number(opened.mode) & 0o7000) !== 0) {
      throw new Error(`[${tag}] Unexpected privilege bits on regular file: ${filePath}`);
    }
    const size = Number(opened.size);
    if (!Number.isSafeInteger(size) || size <= 0 || size > maxBytes) {
      if (size === 0) throw new Error(`[${tag}] Empty regular file: ${filePath}`);
      throw new Error(`[${tag}] Regular file exceeds byte limit (${size} > ${maxBytes}): ${filePath}`);
    }
    openedFrame = statFull9(opened);
    let namedAfterOpen;
    try {
      namedAfterOpen = await lstat(filePath, { bigint: true });
    } catch {
      throw new Error(`[${tag}] File disappeared during open: ${filePath}`);
    }
    if (namedAfterOpen.isSymbolicLink() || !namedAfterOpen.isFile() || !sameStatFull9(statFull9(namedAfterOpen), openedFrame)) {
      throw new Error(`[${tag}] File identity changed during open: ${filePath}`);
    }
    const bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(bytes, offset, size - offset, offset);
      if (bytesRead === 0) throw new Error(`[${tag}] File was truncated during read: ${filePath}`);
      offset += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    const { bytesRead: extraRead } = await handle.read(extra, 0, 1, offset);
    if (extraRead > 0) throw new Error(`[${tag}] File grew during read: ${filePath}`);
    const ended = await handle.stat({ bigint: true });
    if (!sameStatFull9(statFull9(ended), openedFrame)) {
      throw new Error(`[${tag}] File identity changed during read: ${filePath}`);
    }
    return bytes;
  } finally {
    await handle.close();
    let afterNamed;
    try {
      afterNamed = await lstat(filePath, { bigint: true });
    } catch {
      throw new Error(`[${tag}] File disappeared after read: ${filePath}`);
    }
    if (openedFrame && (afterNamed.isSymbolicLink() || !afterNamed.isFile() || !sameStatFull9(statFull9(afterNamed), openedFrame))) {
      throw new Error(`[${tag}] File identity changed after read: ${filePath}`);
    }
  }
}

/** @param {string} relPath @param {string} [tag] */
function validateCanonicalDistMemberPath(relPath, tag = "SOLAR_SAIL_BINDING_FAIL") {
  if (
    typeof relPath !== "string" ||
    relPath.length === 0 ||
    relPath.length > 256 ||
    relPath.normalize("NFC") !== relPath ||
    relPath.includes("\\") ||
    relPath.includes("//") ||
    !relPath.startsWith("dist/") ||
    relPath.endsWith("/")
  ) {
    throw new Error(`[${tag}] Non-canonical Solar Sail member path: ${relPath}`);
  }
  const segs = relPath.split("/");
  if (segs.length < 2 || segs.length > 16 || segs.some((s) => !s || s === "." || s === ".." || !/^[A-Za-z0-9._-]+$/u.test(s))) {
    throw new Error(`[${tag}] Invalid Solar Sail member path segments: ${relPath}`);
  }
}

/**
 * Authenticates candidate package as a valid, untampered Solar Sail distribution.
 * Fails closed if name, version, or runtime member digests do not match.
 *
 * @param {string} packageRoot
 * @param {string | null} [expectedInventoryDigest]
 */
export async function authenticateSolarSailCandidate(packageRoot, expectedInventoryDigest = null) {
  const pkgJsonPath = resolve(packageRoot, "package.json");
  let pkgContent;
  try {
    pkgContent = (await readRegularFileNoFollow(pkgJsonPath, "SOLAR_SAIL_BINDING_FAIL", MAX_SOLAR_SAIL_BINDING_BYTES)).toString("utf8");
  } catch (error) {
    if (error instanceof Error && error.message.includes("Missing required file:")) {
      throw new Error(`[SOLAR_SAIL_BINDING_FAIL] Missing package.json at ${pkgJsonPath}`);
    }
    throw error;
  }
  let pkg;
  try {
    pkg = JSON.parse(pkgContent);
  } catch {
    throw new Error(`[SOLAR_SAIL_BINDING_FAIL] Malformed package.json at ${pkgJsonPath}`);
  }

  if (pkg.name !== EXPECTED_SOLAR_SAIL_NAME) {
    throw new Error(`[SOLAR_SAIL_BINDING_FAIL] Package name mismatch: expected ${EXPECTED_SOLAR_SAIL_NAME}, got ${pkg.name}`);
  }
  if (!SUPPORTED_SOLAR_SAIL_VERSIONS.includes(pkg.version)) {
    throw new Error(`[SOLAR_SAIL_BINDING_FAIL] Unsupported Solar Sail version ${pkg.version}; expected one of ${SUPPORTED_SOLAR_SAIL_VERSIONS.join(", ")}`);
  }

  const packageJsonSha256 = sha256Hex(pkgContent);
  /** @type {Array<{path: string, size: number, sha256: string}>} */
  const members = [];

  for (const relPath of SOLAR_SAIL_RUNTIME_MEMBERS) {
    const fullPath = resolve(packageRoot, relPath);
    try {
      const bytes = await readRegularFileNoFollow(fullPath, "SOLAR_SAIL_BINDING_FAIL", MAX_SOLAR_SAIL_MEMBER_BYTES);
      members.push({
        path: relPath,
        size: bytes.byteLength,
        sha256: sha256Hex(bytes),
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("Missing required file:")) {
        throw new Error(`[SOLAR_SAIL_BINDING_FAIL] Missing required runtime member: ${relPath}`);
      }
      throw error;
    }
  }

  for (const relPath of SOLAR_SAIL_DECLARATION_MEMBERS) {
    const fullPath = resolve(packageRoot, relPath);
    try {
      await readRegularFileNoFollow(fullPath, "SOLAR_SAIL_BINDING_FAIL", MAX_SOLAR_SAIL_MEMBER_BYTES);
    } catch (error) {
      if (error instanceof Error && error.message.includes("Missing required file:")) {
        throw new Error(`[SOLAR_SAIL_BINDING_FAIL] Missing required declaration member: ${relPath}`);
      }
      throw error;
    }
  }

  members.sort((a, b) => a.path.localeCompare(b.path));
  const inventorySummary = members.map((m) => `${m.path}:${m.sha256}`).join("\n");
  const inventoryDigest = sha256Hex(inventorySummary);

  if (expectedInventoryDigest && inventoryDigest !== expectedInventoryDigest) {
    throw new Error(`[SOLAR_SAIL_BINDING_FAIL] Solar Sail candidate inventory digest mismatch: expected ${expectedInventoryDigest}, got ${inventoryDigest}`);
  }

  return {
    schema: SOLAR_SAIL_BINDING_SCHEMA,
    name: pkg.name,
    version: pkg.version,
    packageJsonSha256,
    inventoryDigest,
    runtimeMemberCount: members.length,
    members,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * @param {SolarSailBuildPin} pin
 * @param {SolarSailBuildPinValidationOptions} [options]
 * @returns {SolarSailBuildPin}
 */
export function validateSolarSailBuildPin(pin, options = {}) {
  if (!hasExactKeys(pin, ["schema", "target", "package", "binding", "provenance"])) {
    throw new Error("[SOLAR_SAIL_PIN_FAIL] Solar Sail build pin has invalid or unexpected keys");
  }
  const pkg = pin.package;
  const bnd = pin.binding;
  if (
    pin.schema !== SOLAR_SAIL_BUILD_PIN_SCHEMA ||
    typeof pin.target !== "string" ||
    !pin.target ||
    (options.target && pin.target !== options.target) ||
    !hasExactKeys(pkg, ["name", "version", "packageJsonSha256"]) ||
    pkg.name !== EXPECTED_SOLAR_SAIL_NAME ||
    pkg.version !== EXPECTED_SOLAR_SAIL_VERSION ||
    !isHex64(pkg.packageJsonSha256) ||
    !hasExactKeys(bnd, ["size", "sha256", "inventoryDigest", "memberCount"]) ||
    !Number.isInteger(bnd.size) ||
    bnd.size <= 0 ||
    bnd.size > MAX_SOLAR_SAIL_BINDING_BYTES ||
    !isHex64(bnd.sha256) ||
    !isHex64(bnd.inventoryDigest) ||
    !Number.isInteger(bnd.memberCount) ||
    bnd.memberCount <= 0 ||
    bnd.memberCount > MAX_SOLAR_SAIL_MEMBER_COUNT
  ) {
    throw new Error("[SOLAR_SAIL_PIN_FAIL] Solar Sail build pin fields failed validation");
  }
  const prov = pin.provenance;
  const isStructured = hasExactKeys(prov, ["structuredSource"]);
  const isPublished = hasExactKeys(prov, ["publishedArchive"]);
  if (isStructured === isPublished) {
    throw new Error("[SOLAR_SAIL_PIN_FAIL] Solar Sail build pin provenance must contain exactly one variant");
  }
  const actualRoute = isStructured ? "structured-source" : "published-archive";
  if (options.route && actualRoute !== options.route) {
    throw new Error(`[SOLAR_SAIL_PIN_FAIL] Solar Sail build pin route mismatch: expected ${options.route}, got ${actualRoute}`);
  }
  if (isStructured) {
    if (!("structuredSource" in prov)) {
      throw new Error("[SOLAR_SAIL_PIN_FAIL] Structured-source provenance is missing");
    }
    const src = prov.structuredSource;
    if (!hasExactKeys(src, ["sourceCandidate", "componentSource", "output", "producer", "version"])) {
      throw new Error("[SOLAR_SAIL_PIN_FAIL] Structured-source provenance has invalid key set");
    }
    if (
      !isHex64(src.sourceCandidate) ||
      (options.sourceCandidate && src.sourceCandidate !== options.sourceCandidate) ||
      !isHex64(src.componentSource) ||
      (options.componentSource && src.componentSource !== options.componentSource) ||
      !isHex64(src.output) ||
      (options.output && src.output !== options.output) ||
      !isHex64(src.producer) ||
      (options.producer && src.producer !== options.producer) ||
      typeof src.version !== "string" ||
      src.version !== pkg.version ||
      (options.version && src.version !== options.version)
    ) {
      throw new Error("[SOLAR_SAIL_PIN_FAIL] Structured-source provenance fields failed validation");
    }
  } else {
    if (!("publishedArchive" in prov)) {
      throw new Error("[SOLAR_SAIL_PIN_FAIL] Published-archive provenance is missing");
    }
    const arch = prov.publishedArchive;
    if (!hasExactKeys(arch, ["name", "version", "size", "sha256"])) {
      throw new Error("[SOLAR_SAIL_PIN_FAIL] Published-archive provenance has invalid key set");
    }
    if (
      arch.name !== EXPECTED_SOLAR_SAIL_NAME ||
      arch.version !== ADMITTED_SOLAR_SAIL_ARCHIVE_VERSION ||
      pkg.version !== ADMITTED_SOLAR_SAIL_ARCHIVE_VERSION ||
      arch.size !== ADMITTED_SOLAR_SAIL_ARCHIVE_SIZE ||
      arch.sha256 !== ADMITTED_SOLAR_SAIL_ARCHIVE_SHA256
    ) {
      throw new Error("[SOLAR_SAIL_PIN_FAIL] Published-archive provenance fields failed validation");
    }
  }
  return pin;
}

/**
 * @param {string} rootDir
 * @param {string} [tag]
 * @returns {Promise<SolarSailDistMember[]>}
 */
async function collectFullDistTree(rootDir, tag = "SOLAR_SAIL_PREPARE_FAIL") {
  const distDir = resolve(rootDir, "dist");
  let distMeta;
  try {
    distMeta = await lstat(distDir);
  } catch {
    throw new Error(`[${tag}] packages/solar-sail/dist missing at ${distDir}`);
  }
  if (distMeta.isSymbolicLink() || !distMeta.isDirectory()) {
    throw new Error(`[${tag}] dist must be a real directory: ${distDir}`);
  }
  /** @type {Array<{path: string, size: number, sha256: string, bytes: Buffer}>} */
  const collected = [];
  let totalBytes = 0;

  /** @param {string} currentDir @param {string} relPrefix @returns {Promise<void>} */
  async function walk(currentDir, relPrefix) {
    const entries = await readdir(currentDir);
    entries.sort();
    for (const name of entries) {
      const fullPath = join(currentDir, name);
      const relPath = `${relPrefix}/${name}`;
      const meta = await lstat(fullPath);
      if (meta.isSymbolicLink()) {
        throw new Error(`[${tag}] Symlink forbidden inside Solar Sail dist/: ${relPath}`);
      }
      if (meta.isDirectory()) {
        await walk(fullPath, relPath);
      } else if (meta.isFile()) {
        validateCanonicalDistMemberPath(relPath, tag);
        const bytes = await readRegularFileNoFollow(fullPath, tag, MAX_SOLAR_SAIL_MEMBER_BYTES);
        if (bytes.byteLength > MAX_SOLAR_SAIL_MEMBER_BYTES) {
          throw new Error(`[${tag}] Solar Sail dist member exceeds size cap: ${relPath}`);
        }
        totalBytes += bytes.byteLength;
        if (totalBytes > MAX_SOLAR_SAIL_TOTAL_DIST_BYTES) {
          throw new Error(`[${tag}] Solar Sail dist total bytes exceed cap`);
        }
        collected.push({
          path: relPath,
          size: bytes.byteLength,
          sha256: sha256Hex(bytes),
          bytes,
        });
      } else {
        throw new Error(`[${tag}] Unsupported filesystem entry in Solar Sail dist/: ${relPath}`);
      }
    }
  }

  await walk(distDir, "dist");
  if (collected.length === 0 || collected.length > MAX_SOLAR_SAIL_MEMBER_COUNT) {
    throw new Error(`[${tag}] Invalid Solar Sail dist member count: ${collected.length}`);
  }
  collected.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const lowerSeen = new Set();
  for (let i = 0; i < collected.length; i++) {
    const current = collected[i];
    const previous = i > 0 ? collected[i - 1] : undefined;
    if (!current) {
      throw new Error(`[${tag}] Dist member disappeared during validation at index ${i}`);
    }
    if (previous && previous.path >= current.path) {
      throw new Error(`[${tag}] Duplicate or out-of-order dist member path: ${current.path}`);
    }
    const lower = current.path.toLowerCase();
    if (lowerSeen.has(lower)) {
      throw new Error(`[${tag}] Case-colliding dist member path: ${current.path}`);
    }
    lowerSeen.add(lower);
  }
  return collected;
}

/** @param {string} source @returns {string[]} */
function extractRelativeEsmSpecifiers(source) {
  const specs = [];
  for (const line of source.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!(trimmed.startsWith("import ") || trimmed.startsWith("export "))) continue;
    for (const quote of ['"', "'"]) {
      const end = trimmed.lastIndexOf(quote);
      if (end > 0) {
        const start = trimmed.lastIndexOf(quote, end - 1);
        if (start >= 0) {
          const spec = trimmed.slice(start + 1, end);
          if ((spec.startsWith("./") || spec.startsWith("../")) && (spec.endsWith(".js") || spec.endsWith(".mjs"))) {
            specs.push(spec);
          }
        }
      }
    }
  }
  return specs;
}

/** @param {Map<string, Buffer>} memberMap */
function verifyEsmReachability(memberMap) {
  if (!memberMap.has("dist/index.js")) {
    throw new Error("[SOLAR_SAIL_BINDING_FAIL] Missing required entrypoint dist/index.js");
  }
  const stack = ["dist/index.js"];
  const visited = new Set();
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (visited.has(current)) continue;
    visited.add(current);
    const bytes = memberMap.get(current);
    if (!bytes) {
      throw new Error(`[SOLAR_SAIL_BINDING_FAIL] Unindexed ESM module in Solar Sail dist: ${current}`);
    }
    const parentDir = posix.dirname(current);
    for (const spec of extractRelativeEsmSpecifiers(bytes.toString("utf8"))) {
      const resolved = posix.normalize(posix.join(parentDir, spec));
      if (!resolved.startsWith("dist/") || resolved === "dist" || resolved.startsWith("dist/..")) {
        throw new Error(`[SOLAR_SAIL_BINDING_FAIL] ESM specifier escapes dist/: ${spec}`);
      }
      if (!memberMap.has(resolved)) {
        throw new Error(`[SOLAR_SAIL_BINDING_FAIL] ESM specifier targets undeclared member: ${resolved}`);
      }
      stack.push(resolved);
    }
  }
  if (!visited.has("dist/input.js") || !visited.has("dist/paired-v2/bound.js")) {
    throw new Error("[SOLAR_SAIL_BINDING_FAIL] Required Solar Sail entrypoints dist/input.js and dist/paired-v2/bound.js are not reachable from dist/index.js");
  }
}

/**
 * @param {string} targetPayloadRoot
 * @param {SolarSailBuildPin | null} [expectedPin]
 * @returns {Promise<SolarSailBinding>}
 */
export async function verifyPreparedSolarSailPayload(targetPayloadRoot, expectedPin = null) {
  const rootMeta = await lstat(targetPayloadRoot).catch(() => null);
  if (!rootMeta || rootMeta.isSymbolicLink() || !rootMeta.isDirectory()) {
    throw new Error(`[SOLAR_SAIL_BINDING_FAIL] Payload root must be a real directory: ${targetPayloadRoot}`);
  }
  const topEntries = (await readdir(targetPayloadRoot)).sort();
  const expectedTop = [...SOLAR_SAIL_TOP_LEVEL_FILES, "dist"].sort();
  if (topEntries.length !== expectedTop.length || topEntries.some((e, idx) => e !== expectedTop[idx])) {
    throw new Error(`[SOLAR_SAIL_BINDING_FAIL] Unexpected top-level payload entries in ${targetPayloadRoot}`);
  }

  const bindingPath = resolve(targetPayloadRoot, "solar-sail-binding.json");
  const bindingBytes = await readRegularFileNoFollow(bindingPath, "SOLAR_SAIL_BINDING_FAIL", MAX_SOLAR_SAIL_BINDING_BYTES);
  if (bindingBytes.byteLength > MAX_SOLAR_SAIL_BINDING_BYTES) {
    throw new Error("[SOLAR_SAIL_BINDING_FAIL] solar-sail-binding.json exceeds maximum size");
  }
  const bindingSha256 = sha256Hex(bindingBytes);

  if (expectedPin) {
    validateSolarSailBuildPin(expectedPin);
    if (bindingBytes.byteLength !== expectedPin.binding.size || bindingSha256 !== expectedPin.binding.sha256) {
      throw new Error("[SOLAR_SAIL_BINDING_FAIL] solar-sail-binding.json raw bytes or sha256 mismatch against build pin");
    }
  }

  /** @type {SolarSailBinding} */
  let binding;
  try {
    binding = JSON.parse(bindingBytes.toString("utf8"));
  } catch {
    throw new Error("[SOLAR_SAIL_BINDING_FAIL] Malformed solar-sail-binding.json");
  }
  if (!hasExactKeys(binding, ["schema", "name", "version", "packageJsonSha256", "inventoryDigest", "runtimeMemberCount", "members"])) {
    throw new Error("[SOLAR_SAIL_BINDING_FAIL] solar-sail-binding.json has invalid key set");
  }
  if (
    binding.schema !== SOLAR_SAIL_BINDING_SCHEMA ||
    binding.name !== EXPECTED_SOLAR_SAIL_NAME ||
    binding.version !== EXPECTED_SOLAR_SAIL_VERSION ||
    !isHex64(binding.packageJsonSha256) ||
    !isHex64(binding.inventoryDigest) ||
    !Array.isArray(binding.members) ||
    binding.runtimeMemberCount !== binding.members.length ||
    binding.members.length === 0 ||
    binding.members.length > MAX_SOLAR_SAIL_MEMBER_COUNT
  ) {
    throw new Error("[SOLAR_SAIL_BINDING_FAIL] solar-sail-binding.json header fields failed validation");
  }
  if (expectedPin) {
    if (
      binding.name !== expectedPin.package.name ||
      binding.version !== expectedPin.package.version ||
      binding.packageJsonSha256 !== expectedPin.package.packageJsonSha256 ||
      binding.inventoryDigest !== expectedPin.binding.inventoryDigest ||
      binding.runtimeMemberCount !== expectedPin.binding.memberCount
    ) {
      throw new Error("[SOLAR_SAIL_BINDING_FAIL] solar-sail-binding.json metadata disagrees with build pin");
    }
  }

  for (const doc of SOLAR_SAIL_LEGAL_DOCS) {
    await readRegularFileNoFollow(resolve(targetPayloadRoot, doc), "SOLAR_SAIL_BINDING_FAIL", MAX_SOLAR_SAIL_MEMBER_BYTES);
  }
  const pkgBytes = await readRegularFileNoFollow(resolve(targetPayloadRoot, "package.json"), "SOLAR_SAIL_BINDING_FAIL", MAX_SOLAR_SAIL_BINDING_BYTES);
  if (sha256Hex(pkgBytes) !== binding.packageJsonSha256) {
    throw new Error("[SOLAR_SAIL_BINDING_FAIL] package.json sha256 mismatch");
  }
  const pkg = JSON.parse(pkgBytes.toString("utf8"));
  if (pkg.name !== binding.name || pkg.version !== binding.version) {
    throw new Error("[SOLAR_SAIL_BINDING_FAIL] package.json name or version mismatch");
  }

  const physicalMembers = await collectFullDistTree(targetPayloadRoot, "SOLAR_SAIL_BINDING_FAIL");
  if (physicalMembers.length !== binding.members.length) {
    throw new Error("[SOLAR_SAIL_BINDING_FAIL] Physical dist/ member count does not match binding.members");
  }
  /** @type {Map<string, Buffer>} */
  const memberMap = new Map();
  for (let i = 0; i < binding.members.length; i++) {
    const m = binding.members[i];
    const p = physicalMembers[i];
    if (!m || !p) {
      throw new Error(`[SOLAR_SAIL_BINDING_FAIL] Member count changed during validation at ${i}`);
    }
    if (!hasExactKeys(m, ["path", "size", "sha256"]) || m.path !== p.path || m.size !== p.size || m.sha256 !== p.sha256) {
      throw new Error(`[SOLAR_SAIL_BINDING_FAIL] Member mismatch at ${p.path}`);
    }
    memberMap.set(p.path, p.bytes);
  }
  const recomputedDigest = sha256Hex(binding.members.map((m) => `${m.path}:${m.sha256}`).join("\n"));
  if (recomputedDigest !== binding.inventoryDigest) {
    throw new Error("[SOLAR_SAIL_BINDING_FAIL] Recomputed inventoryDigest does not match binding.inventoryDigest");
  }
  verifyEsmReachability(memberMap);
  return binding;
}

/**
 * Safely inspects and extracts a tarball from verified in-memory bytes or a file path.
 * When a Buffer/Uint8Array is supplied, tar reads the exact verified bytes from stdin
 * without re-opening any filesystem path (eliminating TOCTOU between verification and unpack).
 *
 * @param {string | Buffer | Uint8Array} archiveInput
 * @param {string} destination
 */
export async function extractTarballSafely(archiveInput, destination) {
  let archiveBytes;
  if (Buffer.isBuffer(archiveInput)) {
    archiveBytes = archiveInput;
  } else if (archiveInput instanceof Uint8Array) {
    archiveBytes = Buffer.from(archiveInput.buffer, archiveInput.byteOffset, archiveInput.byteLength);
  } else if (typeof archiveInput === "string") {
    archiveBytes = await readRegularFileNoFollow(archiveInput, "SOLAR_SAIL_PREPARE_FAIL", ADMITTED_SOLAR_SAIL_ARCHIVE_SIZE);
  } else {
    throw new Error("[SOLAR_SAIL_PREPARE_FAIL] Invalid tarball input");
  }

  const listing = spawnSync("tar", ["-tzf", "-"], {
    input: archiveBytes,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (listing.status !== 0 || !listing.stdout) {
    throw new Error("[SOLAR_SAIL_PREPARE_FAIL] Failed to inspect tarball");
  }
  const entries = listing.stdout.split(/\r?\n/u).filter(Boolean);
  if (entries.length === 0) {
    throw new Error("[SOLAR_SAIL_PREPARE_FAIL] Archive is empty");
  }
  for (const entry of entries) {
    const normalized = entry.normalize("NFC");
    const components = normalized.split("/").filter(Boolean);
    if (!normalized.startsWith("package/") || components.some((c) => c === "." || c === ".." || c.includes("\\"))) {
      throw new Error(`[SOLAR_SAIL_PREPARE_FAIL] Archive contains unsafe path: '${entry}'`);
    }
  }
  const extract = spawnSync("tar", ["-xzf", "-", "-C", destination], {
    input: archiveBytes,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (extract.status !== 0) {
    throw new Error("[SOLAR_SAIL_PREPARE_FAIL] Failed to extract tarball");
  }
  const pkgRoot = resolve(destination, "package");
  if (!existsSync(pkgRoot)) {
    throw new Error(`[SOLAR_SAIL_PREPARE_FAIL] Extracted package root missing: ${pkgRoot}`);
  }
  return pkgRoot;
}

/**
 * @param {string} explicitPackageRoot
 * @param {SolarSailSourceAuthority | null | undefined} sourceAuthority
 * @param {string} pkgVersion
 * @returns {Promise<{route: "structured-source", target: string, provenance: {structuredSource: StructuredSourceProvenance}}>}
 */
async function validateSourceAuthority(explicitPackageRoot, sourceAuthority, pkgVersion) {
  if (!sourceAuthority || typeof sourceAuthority !== "object") {
    throw new Error("[SOLAR_SAIL_PREPARE_UNSUPPORTED] Direct --package-root preparation requires structured sourceAuthority from prepare-app-resources");
  }
  const { sourceModel, sourceCandidate, target, component } = sourceAuthority;
  const componentSource = component?.source ?? component?.componentSource;
  if (
    sourceModel !== "source-candidate-v2" ||
    !isHex64(sourceCandidate) ||
    typeof target !== "string" ||
    !target ||
    !component ||
    component.name !== "solar" ||
    (component.target !== undefined && component.target !== target) ||
    !isHex64(componentSource) ||
    !isHex64(component.output) ||
    !isHex64(component.producer) ||
    typeof component.version !== "string" ||
    component.version !== pkgVersion
  ) {
    throw new Error("[SOLAR_SAIL_PREPARE_FAIL] Invalid structured sourceAuthority for Solar Sail preparation");
  }
  const actualTree = await inventoryTree(resolve(explicitPackageRoot));
  if (actualTree.identity !== component.output) {
    throw new Error(`[SOLAR_SAIL_PREPARE_FAIL] Solar Sail source tree digest mismatch: expected ${component.output}, got ${actualTree.identity}`);
  }
  return {
    route: "structured-source",
    target,
    provenance: {
      structuredSource: {
        sourceCandidate,
        componentSource,
        output: component.output,
        producer: component.producer,
        version: component.version,
      },
    },
  };
}

/**
 * @param {SolarSailPreparationOptions} [options]
 * @returns {Promise<{route: SolarSailRoute, binding: SolarSailBinding, buildPin: SolarSailBuildPin}>}
 */
export async function prepareSolarSail(options = {}) {
  const currentStudioRoot = options.studioRoot ? resolve(options.studioRoot) : studioRoot;
  const currentRepoRoot = repositoryRootForStudio(currentStudioRoot);
  const authTarballDir = resolve(currentRepoRoot, "authenticated-inputs/solar-sail-tarball");
  const targetPayloadRoot = options.payloadRoot
    ? resolve(options.payloadRoot)
    : resolve(currentStudioRoot, "src-tauri/solar-sail-payload");
  const targetAdapterDir = options.adapterDir
    ? resolve(options.adapterDir)
    : resolve(currentStudioRoot, "src-tauri/solar-sail-adapter");
  const targetBuildPinPath = options.buildPinPath
    ? resolve(options.buildPinPath)
    : options.payloadRoot
      ? resolve(dirname(targetPayloadRoot), "solar-sail-build-pin.json")
      : resolve(currentStudioRoot, "src-tauri/solar-sail-build-pin.json");

  let candidateDir = null;
  let scratchRoot = null;
  /** @type {SolarSailProvenance | null} */
  let provenance = null;
  /** @type {SolarSailRoute | null} */
  let route = null;
  let targetTriple = null;

  const dashedOptions = /** @type {{"package-root"?: string}} */ (options);
  const explicitPackageRoot = options.packageRoot || dashedOptions["package-root"] || null;
  const isSourceBuild = Boolean(explicitPackageRoot);

  try {
    if (explicitPackageRoot) {
      let packageRoot = resolve(explicitPackageRoot);
      const nestedNix = resolve(packageRoot, "lib/node_modules/@knowledge-forge-ai/theme-forge-solar-sail");
      if (existsSync(resolve(nestedNix, "package.json"))) {
        packageRoot = nestedNix;
      }
      if (!existsSync(resolve(packageRoot, "package.json"))) {
        throw new Error(`[SOLAR_SAIL_PREPARE_FAIL] Missing package.json in Solar Sail package root: ${packageRoot}`);
      }
      candidateDir = packageRoot;
    } else {
      let tarballPath = options.tarball || process.env.TFSS_SOLAR_SAIL_TARBALL || process.env.TFSB_STUDIO_SOLAR_SAIL_TARBALL || null;
      if (tarballPath) {
        if (!existsSync(tarballPath)) {
          throw new Error(`[SOLAR_SAIL_PREPARE_FAIL] Explicit tarball not found: ${tarballPath}`);
        }
        tarballPath = resolve(tarballPath);
      } else if (existsSync(authTarballDir)) {
        const candidates = readdirSync(authTarballDir).filter((f) => f.endsWith(".tgz"));
        const onlyCandidate = candidates[0];
        if (candidates.length === 1 && onlyCandidate !== undefined) {
          tarballPath = resolve(authTarballDir, onlyCandidate);
        }
      }
      if (!tarballPath || !existsSync(tarballPath)) {
        throw new Error("[SOLAR_SAIL_PREPARE_FAIL] No Solar Sail candidate source available in monorepo packages/solar-sail or authenticated-inputs/solar-sail-tarball");
      }
      const archiveBuf = await readRegularFileNoFollow(tarballPath, "SOLAR_SAIL_PREPARE_FAIL", ADMITTED_SOLAR_SAIL_ARCHIVE_SIZE);
      const archiveSha256 = sha256Hex(archiveBuf);
      if (
        archiveBuf.byteLength !== ADMITTED_SOLAR_SAIL_ARCHIVE_SIZE ||
        archiveSha256 !== ADMITTED_SOLAR_SAIL_ARCHIVE_SHA256
      ) {
        throw new Error(
          `[SOLAR_SAIL_PREPARE_FAIL] Solar Sail archive identity mismatch: expected ${ADMITTED_SOLAR_SAIL_ARCHIVE_SIZE}B sha256=${ADMITTED_SOLAR_SAIL_ARCHIVE_SHA256}, got ${archiveBuf.byteLength}B sha256=${archiveSha256}`
        );
      }
      route = "published-archive";
      targetTriple = options.target || process.env.TARGET || targetForHost().triple;
      provenance = {
        publishedArchive: {
          name: EXPECTED_SOLAR_SAIL_NAME,
          version: ADMITTED_SOLAR_SAIL_ARCHIVE_VERSION,
          size: archiveBuf.byteLength,
          sha256: archiveSha256,
        },
      };
      scratchRoot = await mkdtemp(join(tmpdir(), "solar-sail-extract-"));
      candidateDir = await extractTarballSafely(archiveBuf, scratchRoot);
    }

    const distSrc = resolve(candidateDir, "dist");
    if (!existsSync(distSrc)) {
      throw new Error(`[SOLAR_SAIL_PREPARE_FAIL] packages/solar-sail/dist missing at ${distSrc}`);
    }

    const expectedCoreDigest = isSourceBuild
      ? (options.expectedInventoryDigest || null)
      : EXPECTED_SOLAR_SAIL_INVENTORY_DIGEST;
    await authenticateSolarSailCandidate(candidateDir, expectedCoreDigest);

    const pkgBytes = await readRegularFileNoFollow(resolve(candidateDir, "package.json"), "SOLAR_SAIL_PREPARE_FAIL", MAX_SOLAR_SAIL_BINDING_BYTES);
    const pkg = JSON.parse(pkgBytes.toString("utf8"));
    if (pkg.name !== EXPECTED_SOLAR_SAIL_NAME || pkg.version !== EXPECTED_SOLAR_SAIL_VERSION) {
      throw new Error(`[SOLAR_SAIL_PREPARE_FAIL] Solar Sail payload requires ${EXPECTED_SOLAR_SAIL_NAME}@${EXPECTED_SOLAR_SAIL_VERSION}`);
    }

    if (explicitPackageRoot) {
      const auth = await validateSourceAuthority(explicitPackageRoot, options.sourceAuthority, pkg.version);
      if (options.target && options.target !== auth.target) {
        throw new Error("[SOLAR_SAIL_PREPARE_FAIL] Solar Sail target mismatch against sourceAuthority");
      }
      route = auth.route;
      targetTriple = auth.target;
      provenance = auth.provenance;
    }

    /** @type {Map<string, Buffer>} */
    const docBytesMap = new Map();
    for (const doc of SOLAR_SAIL_LEGAL_DOCS) {
      docBytesMap.set(doc, await readRegularFileNoFollow(resolve(candidateDir, doc), "SOLAR_SAIL_PREPARE_FAIL", MAX_SOLAR_SAIL_MEMBER_BYTES));
    }

    const distMembers = await collectFullDistTree(candidateDir, "SOLAR_SAIL_PREPARE_FAIL");
    const members = distMembers.map(({ path, size, sha256 }) => ({ path, size, sha256 }));
    const inventoryDigest = sha256Hex(members.map((m) => `${m.path}:${m.sha256}`).join("\n"));
    const packageJsonSha256 = sha256Hex(pkgBytes);

    const binding = {
      schema: SOLAR_SAIL_BINDING_SCHEMA,
      name: pkg.name,
      version: pkg.version,
      packageJsonSha256,
      inventoryDigest,
      runtimeMemberCount: members.length,
      members,
    };
    const bindingBytes = Buffer.from(JSON.stringify(binding, null, 2) + "\n", "utf8");
    const bindingManifestSha256 = sha256Hex(bindingBytes);

    if (!route || !targetTriple || !provenance) {
      throw new Error("[SOLAR_SAIL_PREPARE_FAIL] Solar Sail preparation did not establish route, target, and provenance");
    }

    const buildPin = validateSolarSailBuildPin(
      {
        schema: SOLAR_SAIL_BUILD_PIN_SCHEMA,
        target: targetTriple,
        package: {
          name: binding.name,
          version: binding.version,
          packageJsonSha256,
        },
        binding: {
          size: bindingBytes.byteLength,
          sha256: bindingManifestSha256,
          inventoryDigest,
          memberCount: members.length,
        },
        provenance,
      },
      { route, target: targetTriple }
    );

    await rm(targetPayloadRoot, { recursive: true, force: true });
    await mkdir(targetPayloadRoot, { recursive: true, mode: 0o755 });
    await writeFile(resolve(targetPayloadRoot, "package.json"), pkgBytes);
    for (const [doc, bytes] of docBytesMap.entries()) {
      await writeFile(resolve(targetPayloadRoot, doc), bytes);
    }
    for (const entry of distMembers) {
      const dest = resolve(targetPayloadRoot, entry.path);
      await mkdir(dirname(dest), { recursive: true, mode: 0o755 });
      await writeFile(dest, entry.bytes);
    }
    await writeFile(resolve(targetPayloadRoot, "solar-sail-binding.json"), bindingBytes);

    if (isSourceBuild) {
      await rm(targetBuildPinPath, { force: true });
    } else {
      await mkdir(dirname(targetBuildPinPath), { recursive: true, mode: 0o755 });
      await writeFile(targetBuildPinPath, JSON.stringify(buildPin, null, 2) + "\n", "utf8");
    }

    await verifyPreparedSolarSailPayload(targetPayloadRoot, buildPin);
    await mkdir(targetAdapterDir, { recursive: true, mode: 0o755 });

    return {
      route,
      binding,
      buildPin,
    };
  } finally {
    if (scratchRoot) {
      await rm(scratchRoot, { recursive: true, force: true });
    }
  }
}

/** @param {string[]} argv @returns {SolarSailPreparationOptions} */
export function parseSolarSailArgs(argv) {
  /** @type {SolarSailPreparationOptions} */
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const next = argv[i + 1];
    if (arg === "--tarball" && next !== undefined) {
      options.tarball = next;
      i += 1;
    } else if ((arg === "--package-root" || arg === "--solar-package-root") && next !== undefined) {
      options.packageRoot = next;
      i += 1;
    } else if (arg === "--studio-root" && next !== undefined) {
      options.studioRoot = next;
      i += 1;
    } else if (arg === "--payload-root" && next !== undefined) {
      options.payloadRoot = next;
      i += 1;
    } else if (arg === "--adapter-dir" && next !== undefined) {
      options.adapterDir = next;
      i += 1;
    } else if (arg === "--build-pin-path" && next !== undefined) {
      options.buildPinPath = next;
      i += 1;
    } else if (arg === "--target" && next !== undefined) {
      options.target = next;
      i += 1;
    } else if (!arg.startsWith("--") && !options.tarball) {
      options.tarball = arg;
    }
  }
  return options;
}

if (process.argv[1] === __filename) {
  prepareSolarSail(parseSolarSailArgs(process.argv.slice(2))).catch((err) => {
    console.error("FATAL:", err.message);
    process.exit(1);
  });
}
