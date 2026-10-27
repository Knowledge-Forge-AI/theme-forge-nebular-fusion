import { createHash } from "node:crypto";
import {
  closeSync,
  constants as FS_CONSTANTS,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  readlinkSync
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

/** @typedef {"darwin-arm64" | "linux-arm64" | "linux-x64"} TargetKey */
/** @typedef {{ os: string, cpu: string, package: string, payloadType: string, payloadRoot: string, executable: string }} TargetSpec */
/** @typedef {{ path: string, type?: "directory" | "symlink" | "file", target?: string, size?: number, sha256?: string, mode?: number }} ManifestMember */
/** @typedef {{ schema: string, package: string, version: string, target: { os: string, cpu: string }, payloadRoot: string, executable: string, glibcMinimum?: string, payloadStatus: string, payloadType: string, fileCount: number, members: ManifestMember[] }} PayloadManifest */
/** @typedef {{ schema: string, materialDigest: string, aliases: { path: string, target: string, canonical: string, bytes: number, mode: number, sha256: string }[], digest: string }} NativeRuntimeAliasProjection */
/** @typedef {{ path: string, bytes: number, mode: number, sha256: string }} MaterialRegular */
/** @typedef {{ path: string, target: string, canonical: string }} MaterialAlias */
/** @typedef {{ header?: { glibcVersionRuntime?: string } }} NodeReport */
/** @typedef {{ executable: string, payloadRoot: string, nativeRuntime: boolean, launcher: string | null }} VerifiedPayload */

const wrapperPkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (!wrapperPkg?.version || typeof wrapperPkg.version !== "string") {
  throw new Error("Wrapper package missing valid version");
}
export const VERSION = wrapperPkg.version;
const PACKAGE_MANIFEST_PROJECTION_SCHEMA = "tfsb.nebular-package-manifest-v2";
const NATIVE_RUNTIME_ALIAS_PROJECTION_SCHEMA = "nebular-native-runtime-alias-projection-v1";

export const TARGETS = Object.freeze(Object.fromEntries(["darwin-arm64", "linux-arm64", "linux-x64"].map(key => {
  const [os, cpu] = key.split("-");
  if (!os || !cpu) throw new Error(`Invalid Nebular target key ${key}`);
  return [key, Object.freeze({
    os,
    cpu,
    package: `@knowledge-forge-ai/theme-forge-nebular-fusion-${key}`,
    payloadType: os === "darwin" ? "app-bundle" : "linux-executable-resources",
    payloadRoot: os === "darwin" ? "payload/Theme Forge Nebular Fusion.app" : "payload",
    executable: os === "darwin" ? "payload/Theme Forge Nebular Fusion.app/Contents/MacOS/theme-forge-nebular-fusion" : "payload/bin/theme-forge-nebular-fusion"
  })];
})));

/** @type {Readonly<Record<string, string | undefined>>} */
const LINUX_TARGET_TRIPLES = Object.freeze({
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "linux-x64": "x86_64-unknown-linux-gnu",
});

/** @param {TargetSpec | null | undefined} target @returns {string | null} */
function targetTriple(target) {
  return LINUX_TARGET_TRIPLES[`${target?.os ?? ""}-${target?.cpu ?? ""}`] ?? null;
}

/** @param {string | Uint8Array} bytes @returns {string} */
export const digest = bytes => createHash("sha256").update(bytes).digest("hex");
export const HASH = /^[a-f0-9]{64}$/;

/** @param {string} platform @param {string} arch @returns {{ key: string, target: TargetSpec }} */
export function resolveTarget(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  const target = TARGETS[key];
  if (!target) {
    throw new Error(`Unsupported Nebular platform ${key}; no foreign architecture fallback`);
  }
  return { key, target };
}

/** @param {string} platform @returns {string | null} */
export function assertGlibcRuntime(platform = process.platform) {
  if (platform === "linux") {
    const report = /** @type {NodeReport | undefined} */ (process.report?.getReport?.());
    const glibcVersion = report?.header?.glibcVersionRuntime;
    if (!glibcVersion) {
      throw new Error("GNU/glibc Linux is required");
    }
    return glibcVersion;
  }
  return null;
}

export const INJECTION_ENV_VARS = Object.freeze([
  "NODE_OPTIONS",
  "NODE_PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FALLBACK_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  "DYLD_FALLBACK_FRAMEWORK_PATH"
]);

/** @param {NodeJS.ProcessEnv} env @returns {NodeJS.ProcessEnv} */
export function sanitizeEnvironment(env = process.env) {
  const sanitized = { ...env };
  for (const name of INJECTION_ENV_VARS) {
    delete sanitized[name];
  }
  return sanitized;
}

/** @param {string} root @param {string} path */
function contained(root, path) {
  const normRoot = root.endsWith(sep) ? root.slice(0, -sep.length) : root;
  if (path !== normRoot && !path.startsWith(normRoot + sep)) {
    throw new Error("Payload path escapes its package");
  }
}

/** @param {string} root @param {string} path @returns {string} */
function safeMember(root, path) {
  if (typeof path !== "string" || path.length === 0 || path.length > 1024 || path.includes("\\") || path.includes("\0")
      || path.split("/").some(part => !part || part === "." || part === "..") || !path.startsWith("payload/")) {
    throw new Error("Invalid payload member path");
  }
  const full = resolve(root, path);
  contained(root, full);
  return full;
}

const AUTHENTICATED_STAT_FIELDS = Object.freeze([
  "dev",
  "ino",
  "size",
  "mode",
  "mtimeNs",
  "ctimeNs",
  "uid",
  "gid",
  "nlink"
]);
const AUTHENTICATED_READ_CHUNK = 64 * 1024;

/** @param {import("node:fs").Stats} stat @returns {string} */
function statFingerprint(stat) {
  const values = AUTHENTICATED_STAT_FIELDS.map(field => stat[field]);
  if (values.some(value => typeof value !== "bigint" && typeof value !== "number")) {
    throw new Error("Authenticated file stat is missing a full9 field");
  }
  const [dev, ino, size, mode, mtimeNs, ctimeNs, uid, gid, nlink] = values;
  return [String(dev), String(ino), Number(size), Number(mode), String(mtimeNs), String(ctimeNs), Number(uid), Number(gid), Number(nlink)].join("\0");
}

/** @param {import("node:fs").Stats} stat @returns {number} */
function statMode(stat) {
  const mode = stat.mode;
  return Number(typeof mode === "bigint" ? mode & 0o7777n : mode & 0o7777);
}

/**
 * Read an authenticated descriptor without reopening the pathname for the
 * bytes that are parsed or hashed. The path and held descriptor are compared
 * before and after the bounded read; callers still own any later pathname
 * execution race (the launcher documents that boundary separately).
 *
 * @param {string} path
 * @param {{ label: string, maxBytes: number, expectedSize?: number, minBytes?: number, expectedModes: number[] }} options
 * @returns {Buffer}
 */
function readAuthenticatedRegularFile(path, options) {
  const { label, maxBytes, expectedSize, minBytes = 0, expectedModes } = options;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !Number.isSafeInteger(minBytes) || minBytes < 0
      || minBytes > maxBytes || !Array.isArray(expectedModes) || expectedModes.length === 0) {
    throw new Error(`${label} has invalid bounded-read options`);
  }
  if (expectedSize !== undefined && (!Number.isSafeInteger(expectedSize) || expectedSize < minBytes || expectedSize > maxBytes)) {
    throw new Error(`${label} has an invalid expected size`);
  }
  if (!Number.isInteger(FS_CONSTANTS.O_NOFOLLOW) || !Number.isInteger(FS_CONSTANTS.O_NONBLOCK)) {
    throw new Error(`${label} authenticated read flags are unavailable`);
  }
  const maxBytesBig = BigInt(maxBytes);
  const minBytesBig = BigInt(minBytes);
  const expectedSizeBig = expectedSize === undefined ? undefined : BigInt(expectedSize);
  const validateStat = stat => {
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} is not a regular file`);
    if (typeof stat.size !== "bigint" || stat.size < minBytesBig || stat.size > maxBytesBig
        || (expectedSizeBig !== undefined && stat.size !== expectedSizeBig)) {
      throw new Error(`${label} size is outside the bounded contract`);
    }
    if (!expectedModes.includes(statMode(stat))) throw new Error(`${label} mode is outside the bounded contract`);
    return statFingerprint(stat);
  };

  let beforePath;
  try {
    beforePath = lstatSync(path, { bigint: true });
  } catch {
    throw new Error(`${label} is unavailable`);
  }
  const beforeFingerprint = validateStat(beforePath);
  let fd;
  try {
    fd = openSync(path, FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW | FS_CONSTANTS.O_NONBLOCK);
    const opened = fstatSync(fd, { bigint: true });
    if (validateStat(opened) !== beforeFingerprint) throw new Error(`${label} changed while opening`);

    /** @type {Buffer[]} */
    const chunks = [];
    let total = 0;
    for (;;) {
      const requested = Math.min(AUTHENTICATED_READ_CHUNK, maxBytes - total + 1);
      const chunk = Buffer.alloc(Math.max(1, requested));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      if (total > maxBytes) throw new Error(`${label} exceeds its bounded read cap`);
      chunks.push(count === chunk.length ? chunk : chunk.subarray(0, count));
    }

    const afterDescriptor = fstatSync(fd, { bigint: true });
    if (validateStat(afterDescriptor) !== beforeFingerprint) throw new Error(`${label} changed during read`);
    let afterPath;
    try {
      afterPath = lstatSync(path, { bigint: true });
    } catch {
      throw new Error(`${label} pathname disappeared during read`);
    }
    if (validateStat(afterPath) !== beforeFingerprint || statFingerprint(afterPath) !== statFingerprint(afterDescriptor)) {
      throw new Error(`${label} pathname changed during read`);
    }
    const bytes = Buffer.concat(chunks, total);
    if (bytes.length < minBytes || bytes.length > maxBytes || (expectedSize !== undefined && bytes.length !== expectedSize)) {
      throw new Error(`${label} byte length is outside the bounded contract`);
    }
    return bytes;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
      let terminalPath;
      try {
        terminalPath = lstatSync(path, { bigint: true });
      } catch {
        throw new Error(`${label} pathname disappeared while closing`);
      }
      if (statFingerprint(terminalPath) !== beforeFingerprint) {
        throw new Error(`${label} pathname changed while closing`);
      }
    }
  }
}

/** @param {unknown} value @returns {string} */
function canonicalProjection(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalProjection).join(",") + "]";
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const objectValue = /** @type {Record<string, unknown>} */ (value);
    return "{" + Object.keys(objectValue).sort().map((key) => JSON.stringify(key) + ":" + canonicalProjection(objectValue[key])).join(",") + "}";
  }
  throw new Error("Unsupported alias projection value");
}

/** @param {PayloadManifest & { runtimeAliasProjection?: NativeRuntimeAliasProjection }} manifest @returns {boolean} */
function hasPrivateRuntimeProjection(manifest) {
  const members = Array.isArray(manifest.members) ? manifest.members : [];
  if (members.some((member) => typeof member?.path === "string"
      && (member.path === "payload/native-runtime.json" || member.path === "payload/opt/nebular-private"
        || member.path.startsWith("payload/opt/nebular-private/")))) return true;
  return false;
}

/**
 * @param {PayloadManifest & { runtimeAliasProjection?: NativeRuntimeAliasProjection }} manifest
 * @param {string} root
 * @param {TargetSpec} target
 * @returns {void}
 */
function validateAliasProjection(manifest, root, target) {
  if (manifest.schema !== PACKAGE_MANIFEST_PROJECTION_SCHEMA) {
    if (Object.hasOwn(manifest, "runtimeAliasProjection")) throw new Error("Legacy package manifest cannot carry a runtime alias projection");
    if (hasPrivateRuntimeProjection(manifest)) throw new Error("Legacy package manifest requires v2 for private runtime members");
    return;
  }
  if (target.os !== "linux") throw new Error("Runtime alias projection is Linux-only");
  const projection = manifest.runtimeAliasProjection;
  if (!projection || projection.schema !== NATIVE_RUNTIME_ALIAS_PROJECTION_SCHEMA || !HASH.test(projection.materialDigest ?? "")
      || !HASH.test(projection.digest ?? "") || !Array.isArray(projection.aliases)) {
    throw new Error("Invalid runtime alias projection");
  }
  const markerPath = join(root, "payload", "native-runtime.json");
  let material;
  let markerBytes;
  try {
    markerBytes = readAuthenticatedRegularFile(markerPath, {
      label: "Projected package native runtime marker",
      maxBytes: 16 * 1024 * 1024,
      minBytes: 1,
      expectedModes: [0o644]
    });
  } catch {
    throw new Error("Projected package is missing a regular native runtime marker");
  }
  try { material = JSON.parse(markerBytes.toString("utf8")); } catch { throw new Error("Projected native runtime marker is invalid JSON"); }
  if (material?.schema !== "nebular-native-runtime-material-v1" || material.materialDigest !== projection.materialDigest
      || !Array.isArray(material.regulars) || !Array.isArray(material.aliases)) {
    throw new Error("Projected package material identity mismatch");
  }
  const expectedTarget = targetTriple(target);
  if (!expectedTarget || material.target !== expectedTarget) {
    throw new Error("Projected package material target mismatch");
  }
  const materialBody = {
    schema: material.schema,
    target: material.target,
    prefix: material.prefix,
    directories: material.directories,
    regulars: material.regulars,
    aliases: material.aliases,
    requiredRoles: material.requiredRoles,
    externalFloor: material.externalFloor,
  };
  if (digest(Buffer.from(canonicalProjection(materialBody))) !== material.materialDigest) {
    throw new Error("Projected package material digest is not self-authenticating");
  }
  /** @type {MaterialRegular[]} */
  const materialRegulars = material.regulars;
  /** @type {MaterialAlias[]} */
  const materialAliases = material.aliases;
  const regulars = new Map(materialRegulars.map((entry) => [entry.path, entry]));
  const expectedAliases = materialAliases.map((alias) => {
    const regular = regulars.get(alias.canonical);
    if (!regular || !Number.isSafeInteger(regular.bytes) || ![0o644, 0o755].includes(regular.mode) || !HASH.test(regular.sha256 ?? "")) {
      throw new Error("Projected alias canonical regular is malformed");
    }
    return { path: alias.path, target: alias.target, canonical: alias.canonical, bytes: regular.bytes, mode: regular.mode, sha256: regular.sha256 };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const body = { schema: projection.schema, materialDigest: projection.materialDigest, aliases: projection.aliases };
  if (canonicalProjection(body) !== canonicalProjection({ schema: projection.schema, materialDigest: projection.materialDigest, aliases: expectedAliases })
      || digest(Buffer.from(canonicalProjection(body))) !== projection.digest) {
    throw new Error("Projected alias set or digest mismatch");
  }
  const members = new Map(manifest.members.map((member) => [member.path, member]));
  for (const alias of expectedAliases) {
    const member = members.get("payload/" + alias.path);
    if (!member || member.type !== "file" || member.size !== alias.bytes || member.mode !== alias.mode || member.sha256 !== alias.sha256) {
      throw new Error("Projected alias regular copy is missing or mismatched: " + alias.path);
    }
  }
}

/** @param {string} packageRoot @param {TargetSpec} target @param {string | undefined} [expectedManifestSha256] @returns {VerifiedPayload} */
export function verifyPayload(packageRoot, target, expectedManifestSha256) {
  if (!target || !HASH.test(expectedManifestSha256 ?? "")) {
    throw new Error("No authenticated target payload binding; native assembly is incomplete");
  }
  const root = realpathSync(packageRoot);
  const pkgPath = join(root, "package.json");
  let pkg;
  try {
    const pkgBytes = readAuthenticatedRegularFile(pkgPath, {
      label: "Platform package.json",
      maxBytes: 1024 * 1024,
      minBytes: 1,
      expectedModes: [0o644]
    });
    pkg = JSON.parse(pkgBytes.toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Platform package.json is invalid JSON");
    throw new Error("Invalid platform package.json");
  }
  if (pkg.name !== target.package || pkg.version !== VERSION
      || !Array.isArray(pkg.os) || pkg.os.length !== 1 || pkg.os[0] !== target.os
      || !Array.isArray(pkg.cpu) || pkg.cpu.length !== 1 || pkg.cpu[0] !== target.cpu) {
    throw new Error("Platform package identity mismatch");
  }

  const manifestPath = join(root, "package-manifest.json");
  let bytes;
  try {
    bytes = readAuthenticatedRegularFile(manifestPath, {
      label: "Payload manifest",
      maxBytes: 4 * 1024 * 1024,
      minBytes: 1,
      expectedModes: [0o644]
    });
  } catch {
    throw new Error("Invalid payload manifest file");
  }
  if (digest(bytes) !== expectedManifestSha256) {
    throw new Error("Payload manifest authentication failed");
  }
  let manifest;
  try {
    manifest = /** @type {PayloadManifest} */ (JSON.parse(bytes.toString("utf8")));
  } catch {
    throw new Error("Invalid payload manifest JSON");
  }
  if (!["tfsb.nebular-package-manifest-v1", PACKAGE_MANIFEST_PROJECTION_SCHEMA].includes(manifest.schema) || manifest.package !== target.package
      || manifest.version !== VERSION || manifest.target?.os !== target.os || manifest.target?.cpu !== target.cpu
      || manifest.payloadRoot !== target.payloadRoot || manifest.executable !== target.executable
      || manifest.payloadStatus !== "complete" || manifest.payloadType !== target.payloadType
      || !Array.isArray(manifest.members) || manifest.members.length === 0 || manifest.members.length > 20000
      || manifest.fileCount !== manifest.members.length) {
    throw new Error("Invalid payload manifest identity or inventory");
  }
  validateAliasProjection(manifest, root, target);

  if (target.os === "linux") {
    const minimum = manifest.glibcMinimum;
    if (typeof minimum !== "string" || !/^\d+\.\d+$/.test(minimum)) throw new Error("Missing qualified glibc minimum");
    if (process.platform === "linux") {
      const glibcVersion = assertGlibcRuntime();
      if (!glibcVersion) throw new Error("GNU/glibc Linux is required");
      const actual = glibcVersion.split(".").map(Number);
      const required = minimum.split(".").map(Number);
      const [actualMajor, actualMinor] = actual;
      const [requiredMajor, requiredMinor] = required;
      if (actualMajor === undefined || actualMinor === undefined || requiredMajor === undefined || requiredMinor === undefined) {
        throw new Error("Invalid glibc version");
      }
      if (actualMajor < requiredMajor || (actualMajor === requiredMajor && actualMinor < requiredMinor)) {
        throw new Error("Installed glibc is older than the qualified payload minimum");
      }
    }
  }
  const payloadRoot = resolve(root, target.payloadRoot);
  contained(root, payloadRoot);
  const payloadContainer = lstatSync(join(root, "payload"));
  if (!payloadContainer.isDirectory() || payloadContainer.isSymbolicLink() || (payloadContainer.mode & 0o7777) !== 0o755) {
    throw new Error("Payload container mode or type mismatch");
  }
  const rootStat = lstatSync(payloadRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o7777) !== 0o755) {
    throw new Error("Payload root is not a directory");
  }
  const realPayloadRoot = realpathSync(payloadRoot);
  contained(root, realPayloadRoot);

  const expected = new Set();
  let total = 0;
  for (const member of manifest.members) {
    if (!member || typeof member.path !== "string") throw new Error("Invalid payload member declaration");
    const path = safeMember(root, member.path);
    contained(payloadRoot, path);
    if (expected.has(member.path)) throw new Error("Duplicate payload member");
    expected.add(member.path);
    contained(root, realpathSync(dirname(path)));

    let info;
    try {
      info = lstatSync(path);
    } catch {
      throw new Error("Payload file identity mismatch");
    }
    if (member.type === "directory") {
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Payload directory mismatch");
      if (member.mode !== 0o755 || (info.mode & 0o7777) !== member.mode) {
        throw new Error("Payload directory mode mismatch");
      }
    } else if (member.type === "symlink") {
      if (!info.isSymbolicLink() || typeof member.target !== "string" || member.target.length === 0 || member.target.length > 1024) {
        throw new Error("Payload symlink mismatch");
      }
      if (member.target.startsWith("/") || member.target.includes("\\") || member.target.includes("\0")) {
        throw new Error("Invalid payload symlink target");
      }
      if (readlinkSync(path) !== member.target) throw new Error("Payload symlink mismatch");
      const targetResolved = resolve(dirname(path), member.target);
      contained(payloadRoot, targetResolved);
      contained(payloadRoot, realpathSync(path));
    } else if (member.type === "file" || member.type === undefined) {
      const memberSize = member.size;
      const memberMode = member.mode;
      if (!info.isFile() || info.isSymbolicLink() || !HASH.test(member.sha256 ?? "") || typeof member.size !== "number"
          || !Number.isSafeInteger(memberSize) || typeof memberMode !== "number" || ![0o644, 0o755].includes(memberMode)
          || (info.mode & 0o7777) !== memberMode || info.size !== memberSize
          || memberSize < 0 || memberSize > 512 * 1024 * 1024) {
        throw new Error("Payload file identity mismatch");
      }
      total += memberSize;
      if (total > 2 * 1024 * 1024 * 1024) {
        throw new Error("Payload checksum mismatch");
      }
      let memberBytes;
      try {
        memberBytes = readAuthenticatedRegularFile(path, {
          label: "Payload member",
          maxBytes: memberSize,
          expectedSize: memberSize,
          minBytes: memberSize === 0 ? 0 : 1,
          expectedModes: [memberMode]
        });
      } catch {
        throw new Error("Payload checksum mismatch");
      }
      if (digest(memberBytes) !== member.sha256) throw new Error("Payload checksum mismatch");
    } else {
      throw new Error("Invalid payload member type");
    }
  }

  /** @param {string} currentDir */
  function walk(currentDir) {
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const full = join(currentDir, entry.name);
      const rel = full.slice(root.length + 1);
      if (!expected.has(rel)) throw new Error("Unexpected payload member");
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        walk(full);
      }
    }
  }
  walk(payloadRoot);

  const payloadDir = resolve(root, "payload");
  let payloadDirStat;
  try { payloadDirStat = lstatSync(payloadDir); } catch {}
  if (payloadDir !== payloadRoot && payloadDirStat?.isDirectory() && !payloadDirStat.isSymbolicLink()) {
    for (const entry of readdirSync(payloadDir)) {
      const sub = join(payloadDir, entry);
      if (sub !== payloadRoot) {
        throw new Error("Unexpected payload member");
      }
    }
  }

  if (!expected.has(target.executable)) throw new Error("Executable absent from authenticated inventory");
  const executable = resolve(root, target.executable);
  contained(payloadRoot, executable);
  const info = lstatSync(executable);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o111) === 0) {
    throw new Error("Native executable unavailable");
  }
  const resolvedExecutable = realpathSync(executable);
  contained(payloadRoot, resolvedExecutable);

  // A private Linux runtime is allowed to select only the fixed launcher that
  // was authenticated by this complete manifest/projection walk.  Do not
  // fall back to an arbitrary file that merely happens to exist at this path.
  const nativeRuntime = manifest.schema === PACKAGE_MANIFEST_PROJECTION_SCHEMA;
  let launcher = null;
  if (nativeRuntime) {
    const launcherPath = resolve(root, "payload/bin/tfnf");
    contained(payloadRoot, launcherPath);
    if (!expected.has("payload/bin/tfnf")) {
      throw new Error("Private native launcher absent from authenticated inventory");
    }
    const launcherInfo = lstatSync(launcherPath);
    if (!launcherInfo.isFile() || launcherInfo.isSymbolicLink() || (launcherInfo.mode & 0o7777) !== 0o755) {
      throw new Error("Private native launcher is not a regular executable");
    }
    launcher = realpathSync(launcherPath);
    contained(payloadRoot, launcher);
  }

  return {
    executable: resolvedExecutable,
    payloadRoot: realPayloadRoot,
    nativeRuntime,
    launcher
  };
}
