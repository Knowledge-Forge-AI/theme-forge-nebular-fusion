import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants, existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

export const TARGET = "aarch64-apple-darwin";
export const RUNTIME_KIND = "node-runtime-payload-v1";
export const NODE_VERSION = "22.23.2";
export const SIDECAR_NAME = `tfsb-studio-service-${TARGET}`;
export const ENTRYPOINT = "dist/service-protocol/server-cli.js";
export const MAX_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_AGGREGATE_BYTES = 1024 * 1024 * 1024;
export const MAX_FILES = 10_000;
export const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
export const MAX_PATH_BYTES = 512;

const ROOT_RUNTIME_PACKAGES = ["@xmldom/xmldom", "fflate", "smol-toml"];
const PROTOCOL_FILES = [
  "README.md",
  "envelope.schema.json",
  "inventory.json",
  "inventory-1.1.json",
  "inventory-1.2.json",
  "requests.schema.json",
  "requests-1.1.schema.json",
  "requests-1.2.schema.json",
  "results.schema.json",
  "results-1.1.schema.json",
  "results-1.2.schema.json",
];
const LEGAL_FILES = ["LICENSE", "NOTICE", "COMMERCIAL-LICENSE.md"];
const RASTER_FILES = ["package.json", "index.js", "index.d.ts", "LICENSE", "NOTICE", "COMMERCIAL-LICENSE.md", "MPL-2.0.txt", "THIRD_PARTY_NOTICES.md"];
const STELLAR_BINDING_SCHEMA = "tfsb.nebular-stellar-input-binding-v1";
const STELLAR_PRODUCT = "theme-forge-stellar-burst";
const NEBULAR_PRODUCT = "theme-forge-nebular-fusion";

// Select the declared standalone layout first; an unrelated ancestor package
// never establishes repository ownership. The private layout is exactly apps/studio.
export function repositoryRootForStudio(studioRoot) {
  const appRoot = resolve(studioRoot);
  if (existsSync(resolve(appRoot, "authenticated-inputs/stellar-binding.json"))) return appRoot;
  return resolve(appRoot, "../..", "apps/studio") === appRoot ? resolve(appRoot, "../..") : appRoot;
}

export function canonicalJson(value) {
  if (value === undefined) throw new Error("canonical JSON cannot encode undefined");
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha1(bytes) {
  return createHash("sha1").update(bytes).digest("hex");
}

function asciiCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sri(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function normalizeRelative(path) {
  const normalized = path.split(sep).join("/").normalize("NFC");
  const components = normalized.split("/");
  if (!normalized || Buffer.byteLength(normalized) > MAX_PATH_BYTES || !/^[\x20-\x7e]+$/.test(normalized)
      || normalized.startsWith("/") || normalized.includes("\\")
      || components.some((component) => !component || component === "." || component === ".." || !/^[A-Za-z0-9._@+-]+$/.test(component))) {
    throw new Error("sidecar path is not a safe relative path");
  }
  return normalized;
}

async function requireRegular(path, maximum = MAX_FILE_BYTES) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`sidecar input is not a regular file: ${basename(path)}`);
  if (info.size > maximum) throw new Error(`sidecar input exceeds its byte limit: ${basename(path)}`);
  return info;
}

function sameIdentity(left, right) {
  return left !== null && right !== null && left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mode === right.mode && left.mtimeMs === right.mtimeMs;
}

async function readRegular(path, maximum = MAX_FILE_BYTES) {
  const before = await requireRegular(path, maximum);
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!sameIdentity(before, opened)) throw new Error(`sidecar input changed before read: ${basename(path)}`);
    const bytes = await handle.readFile();
    const afterRead = await handle.stat();
    const finalNamed = await requireRegular(path, maximum);
    if (!sameIdentity(opened, afterRead) || !sameIdentity(afterRead, finalNamed)) {
      throw new Error(`sidecar input changed during read: ${basename(path)}`);
    }
    return { bytes, info: opened };
  } finally {
    await handle.close();
  }
}

async function rejectSymlinkAncestors(path) {
  const absolute = resolve(path);
  let current = sep;
  for (const component of absolute.split(sep).filter(Boolean)) {
    current = resolve(current, component);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error("sidecar path has a symlinked ancestor");
  }
}

async function copyRegular(source, destination, mode = 0o644) {
  await requireRegular(source);
  await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
  await copyFile(source, destination);
  await chmod(destination, mode);
}

async function copyClosedTree(sourceRoot, destinationRoot, seen) {
  const rootInfo = await lstat(sourceRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error(`sidecar tree root is invalid: ${basename(sourceRoot)}`);
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  entries.sort((left, right) => asciiCompare(left.name, right.name));
  for (const entry of entries) {
    const source = resolve(sourceRoot, entry.name);
    const destination = resolve(destinationRoot, entry.name);
    const key = normalizeRelative(relative(destinationRoot, destination)).toLocaleLowerCase("en-US");
    if (seen.has(key)) throw new Error(`sidecar input contains a case or Unicode collision: ${entry.name}`);
    seen.add(key);
    if (entry.isSymbolicLink()) throw new Error(`sidecar input contains a symlink: ${entry.name}`);
    if (entry.isDirectory()) {
      await mkdir(destination, { recursive: true, mode: 0o755 });
      await copyClosedTree(source, destination, new Set());
    } else if (entry.isFile()) {
      await copyRegular(source, destination);
    } else {
      throw new Error(`sidecar input contains a special file: ${entry.name}`);
    }
  }
}

async function inventory(payloadRoot) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => asciiCompare(left.name, right.name));
    const collisions = new Set();
    for (const entry of entries) {
      const collisionKey = entry.name.normalize("NFC").toLocaleLowerCase("en-US");
      if (collisions.has(collisionKey)) throw new Error("payload contains a case or Unicode collision");
      collisions.add(collisionKey);
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("payload contains a symlink");
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const relativePath = normalizeRelative(relative(payloadRoot, path));
        if (relativePath === "manifest.json") continue;
        if (files.length >= MAX_FILES) throw new Error("payload exceeds its file-count limit");
        const { info, bytes } = await readRegular(path);
        files.push({ path: relativePath, size: info.size, mode: info.mode & 0o777, sha256: sha256(bytes) });
      } else throw new Error("payload contains a special file");
    }
  }
  await visit(payloadRoot);
  files.sort((left, right) => asciiCompare(left.path, right.path));
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  if (!Number.isSafeInteger(bytes) || bytes > MAX_AGGREGATE_BYTES) throw new Error("payload exceeds its aggregate byte limit");
  return files;
}

function parseArgs(argv) {
  const allowed = new Set(["node", "root-tarball"]);
  if (argv.length % 2 !== 0) throw new Error("sidecar preparation requires paired explicit arguments");
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) throw new Error("sidecar preparation requires paired explicit arguments");
    const name = key.slice(2);
    if (!allowed.has(name)) throw new Error(`unknown sidecar preparation option: ${key}`);
    if (values.has(name)) throw new Error(`duplicate sidecar preparation option: ${key}`);
    values.set(name, resolve(value));
  }
  return values;
}

function probeRuntime(nodePath) {
  const probe = spawnSync(nodePath, ["-p", "JSON.stringify({node:process.versions.node,v8:process.versions.v8,arch:process.arch,platform:process.platform})"], {
    encoding: "utf8",
    env: { LANG: "C", LC_ALL: "C", TZ: "UTC" },
    timeout: 10_000,
  });
  if (probe.status !== 0 || probe.error) throw new Error("the explicit Node runtime probe failed");
  const identity = JSON.parse(probe.stdout.trim());
  if (identity.node !== NODE_VERSION || identity.arch !== "arm64" || identity.platform !== "darwin") {
    throw new Error("the explicit Node runtime has the wrong version or target");
  }
  return identity;
}

async function gitIdentity(repositoryRoot) {
  const run = (args) => {
    const result = spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
    if (result.status !== 0) throw new Error("source Git identity is unavailable");
    return result.stdout.trim();
  };
  return run(["rev-parse", "HEAD"]);
}

async function packageIdentity(path) {
  const bytes = (await readRegular(path)).bytes;
  return { sha1: sha1(bytes), sha256: sha256(bytes), sri: sri(bytes), size: bytes.length };
}

async function readPackage(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function declaredDigest(value, label, length = 64) {
  if (typeof value !== "string" || !new RegExp(`^[0-9a-f]{${length}}$`).test(value)) {
    throw new Error(`standalone sidecar ${label} is invalid`);
  }
  return value;
}

function declaredArchiveFilename(value, label) {
  if (typeof value !== "string" || value !== basename(value) || !/^[A-Za-z0-9._+-]+\.tgz$/u.test(value)) {
    throw new Error(`standalone sidecar ${label} filename is invalid`);
  }
  return value;
}

function declaredCompositionArchiveFilename(value, label) {
  if (typeof value !== "string" || value !== basename(value) || !/^[A-Za-z0-9._+-]+\.tar\.gz$/u.test(value)) {
    throw new Error(`standalone sidecar ${label} filename is invalid`);
  }
  return value;
}

function declaredArchivePath(root, directory, filename, label) {
  const safeFilename = declaredArchiveFilename(filename, label);
  const path = resolve(root, directory, safeFilename);
  if (dirname(path) !== resolve(root, directory)) throw new Error(`standalone sidecar ${label} path is invalid`);
  return path;
}

function runLocalCommand(command, args, cwd, env) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) {
    const detail = typeof result.stderr === "string" ? result.stderr.trim() : "";
    throw new Error(`standalone sidecar ${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}

function standaloneNpmEnvironment(scratchRoot, base = process.env) {
  const env = { ...base };
  const userConfig = resolve(scratchRoot, "npmrc");
  env.NPM_CONFIG_USERCONFIG = userConfig;
  env.npm_config_userconfig = userConfig;
  env.NPM_CONFIG_CACHE = resolve(scratchRoot, "npm-cache");
  env.npm_config_cache = env.NPM_CONFIG_CACHE;
  env.NPM_CONFIG_AUDIT = "false";
  env.npm_config_audit = "false";
  env.NPM_CONFIG_FUND = "false";
  env.npm_config_fund = "false";
  env.NPM_CONFIG_IGNORE_SCRIPTS = "true";
  env.npm_config_ignore_scripts = "true";
  return env;
}

async function extractDeclaredArchive(archivePath, destination, label) {
  await rejectSymlinkAncestors(archivePath);
  await requireRegular(archivePath, MAX_FILE_BYTES);
  const listing = runLocalCommand("tar", ["-tzf", archivePath], process.cwd(), { ...process.env, LANG: "C", LC_ALL: "C", TZ: "UTC" });
  const entries = listing.split(/\r?\n/u).filter(Boolean);
  if (entries.length === 0 || entries.some((entry) => {
    const normalized = entry.normalize("NFC");
    const components = normalized.split("/").filter(Boolean);
    return !normalized.startsWith("package/") || components.some((component) => component === "." || component === ".." || component.includes("\\"));
  })) {
    throw new Error(`standalone sidecar ${label} contains an unsafe archive path`);
  }
  const verbose = runLocalCommand("tar", ["-tvzf", archivePath], process.cwd(), { ...process.env, LANG: "C", LC_ALL: "C", TZ: "UTC" });
  if (verbose.split(/\r?\n/u).filter(Boolean).some((line) => !/^[-d]/u.test(line))) {
    throw new Error(`standalone sidecar ${label} contains a link entry`);
  }
  await mkdir(destination, { recursive: true, mode: 0o755 });
  runLocalCommand("tar", ["-xzf", archivePath, "-C", destination], process.cwd(), { ...process.env, LANG: "C", LC_ALL: "C", TZ: "UTC" });
  const packageRoot = resolve(destination, "package");
  const packageInfo = await lstat(packageRoot);
  if (packageInfo.isSymbolicLink() || !packageInfo.isDirectory()) throw new Error(`standalone sidecar ${label} package root is invalid`);
  return packageRoot;
}

function validatePendingPublication(value) {
  if (!isRecord(value) || value.status !== "pending" || value.value !== null || value.requiredBefore !== "TFSB49C staging publication") {
    throw new Error("standalone sidecar Stellar publication binding is not pending");
  }
}

function validateStellarBinding(binding) {
  if (!isRecord(binding) || binding.schema !== STELLAR_BINDING_SCHEMA || binding.schemaVersion !== 1 || binding.product !== NEBULAR_PRODUCT) {
    throw new Error("standalone sidecar Stellar input binding is invalid");
  }
  const input = binding.input;
  if (!isRecord(input) || input.product !== STELLAR_PRODUCT || typeof input.sourceTree !== "string" || !/^[0-9a-f]{40}$/u.test(input.sourceTree)
      || typeof input.composedTreeDigest !== "string" || !/^[0-9a-f]{64}$/u.test(input.composedTreeDigest)) {
    throw new Error("standalone sidecar Stellar composition identity is invalid");
  }
  declaredDigest(input.compositionManifestSha256, "composition manifest digest");
  declaredDigest(input.packageJsonSha256, "core package digest");
  declaredDigest(input.packageLockSha256, "core lock digest");
  if (!isRecord(input.compositionTarball)) throw new Error("standalone sidecar Stellar composition archive identity is invalid");
  declaredCompositionArchiveFilename(input.compositionTarball.filename, "Stellar composition archive");
  declaredDigest(input.compositionTarball.sha256, "Stellar composition archive digest");
  validatePendingPublication(input.publicStagingCommit);

  if (!isRecord(binding.package)) throw new Error("standalone sidecar core package binding is missing");
  declaredArchiveFilename(binding.package.filename, "core package archive");
  declaredDigest(binding.package.sha256, "core package archive digest");
  if (!isRecord(binding.raster)) throw new Error("standalone sidecar raster package binding is missing");
  declaredArchiveFilename(binding.raster.filename, "raster package archive");
  declaredDigest(binding.raster.sha256, "raster package archive digest");
  declaredDigest(binding.raster.packageSha256, "raster package digest");
  declaredDigest(binding.raster.packageLockSha256, "raster lock digest");
  if (!Number.isSafeInteger(binding.canonicalEpochMs) || binding.canonicalEpochMs < 0) {
    throw new Error("standalone sidecar canonical epoch is invalid");
  }
  return { input, package: binding.package, raster: binding.raster };
}

async function materializeStandaloneInputs({ authInputs, rootTarball }) {
  const bindingPath = resolve(authInputs, "stellar-binding.json");
  await rejectSymlinkAncestors(bindingPath);
  const bindingBytes = (await readRegular(bindingPath, MAX_MANIFEST_BYTES)).bytes;
  let binding;
  try {
    binding = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bindingBytes));
  } catch {
    throw new Error("standalone sidecar Stellar input binding is not valid JSON");
  }
  const declared = validateStellarBinding(binding);
  const corePackagePath = resolve(authInputs, "core/package.json");
  const coreLockPath = resolve(authInputs, "core/package-lock.json");
  await rejectSymlinkAncestors(corePackagePath);
  await rejectSymlinkAncestors(coreLockPath);
  const corePackageRead = await readRegular(corePackagePath, MAX_MANIFEST_BYTES);
  const coreLockRead = await readRegular(coreLockPath, MAX_MANIFEST_BYTES);
  if (sha256(corePackageRead.bytes) !== declared.input.packageJsonSha256 || sha256(coreLockRead.bytes) !== declared.input.packageLockSha256) {
    throw new Error("standalone sidecar Stellar package inputs do not match their binding");
  }
  let corePackage;
  let coreLock;
  try {
    corePackage = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(corePackageRead.bytes));
    coreLock = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(coreLockRead.bytes));
  } catch {
    throw new Error("standalone sidecar Stellar package inputs are not valid JSON");
  }
  if (!isRecord(corePackage) || corePackage.name !== "@knowledge-forge-ai/theme-forge-stellar-burst" || corePackage.version !== "0.4.0"
      || !isRecord(corePackage.dependencies) || !isRecord(coreLock) || coreLock.name !== corePackage.name || coreLock.version !== corePackage.version) {
    throw new Error("standalone sidecar Stellar package identity is invalid");
  }
  const coreLockRoot = isRecord(coreLock.packages) ? coreLock.packages[""] : undefined;
  if (!isRecord(coreLockRoot) || coreLockRoot.name !== corePackage.name || coreLockRoot.version !== corePackage.version) {
    throw new Error("standalone sidecar Stellar lock root identity is invalid");
  }

  const expectedCoreTarball = declaredArchivePath(authInputs, "core-tarball", declared.package.filename, "core package archive");
  if (resolve(rootTarball) !== expectedCoreTarball) throw new Error("standalone sidecar core archive is not the declared input");
  await rejectSymlinkAncestors(expectedCoreTarball);
  await requireRegular(expectedCoreTarball, MAX_FILE_BYTES);
  const coreTarballIdentity = await packageIdentity(expectedCoreTarball);
  if (coreTarballIdentity.sha256 !== declared.package.sha256) throw new Error("standalone sidecar core archive digest does not match its binding");
  const expectedRasterTarball = declaredArchivePath(authInputs, "raster-tarball", declared.raster.filename, "raster package archive");
  await rejectSymlinkAncestors(expectedRasterTarball);
  await requireRegular(expectedRasterTarball, MAX_FILE_BYTES);
  const rasterTarballIdentity = await packageIdentity(expectedRasterTarball);
  if (rasterTarballIdentity.sha256 !== declared.raster.sha256) throw new Error("standalone sidecar raster archive digest does not match its binding");
  const rasterLockPath = resolve(authInputs, "raster/package-lock.json");
  await rejectSymlinkAncestors(rasterLockPath);
  const rasterLockRead = await readRegular(rasterLockPath, MAX_MANIFEST_BYTES);
  if (sha256(rasterLockRead.bytes) !== declared.raster.packageLockSha256) throw new Error("standalone sidecar raster lock does not match its binding");
  let rasterLock;
  try {
    rasterLock = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rasterLockRead.bytes));
  } catch {
    throw new Error("standalone sidecar raster lock is not valid JSON");
  }
  if (!isRecord(rasterLock) || rasterLock.name !== "@knowledge-forge-ai/tfsb-raster-resvg" || rasterLock.version !== "0.0.0-tfsb47f"
      || !isRecord(rasterLock.packages) || !isRecord(rasterLock.packages[""]) || rasterLock.packages[""].name !== rasterLock.name
      || rasterLock.packages[""].version !== rasterLock.version) {
    throw new Error("standalone sidecar raster lock root identity is invalid");
  }

  const scratchRoot = await mkdtemp(join(tmpdir(), "tfsb-sidecar-inputs-"));
  try {
    await mkdir(resolve(scratchRoot, "npm-cache"), { recursive: true, mode: 0o755 });
    await writeFile(resolve(scratchRoot, "npmrc"), "registry=https://registry.npmjs.org/\n", { mode: 0o644 });
    const corePackageRoot = await extractDeclaredArchive(expectedCoreTarball, resolve(scratchRoot, "core-archive"), "core package archive");
    const extractedPackageRead = await readRegular(resolve(corePackageRoot, "package.json"), MAX_MANIFEST_BYTES);
    if (sha256(extractedPackageRead.bytes) !== declared.input.packageJsonSha256
        || Buffer.compare(extractedPackageRead.bytes, corePackageRead.bytes) !== 0) {
      throw new Error("standalone sidecar core archive package metadata does not match its binding");
    }
    await copyRegular(coreLockPath, resolve(corePackageRoot, "package-lock.json"));
    runLocalCommand("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], corePackageRoot, standaloneNpmEnvironment(scratchRoot));

    const rasterPackageRoot = await extractDeclaredArchive(expectedRasterTarball, resolve(scratchRoot, "raster-archive"), "raster package archive");
    const rasterPackageRead = await readRegular(resolve(rasterPackageRoot, "package.json"), MAX_MANIFEST_BYTES);
    if (sha256(rasterPackageRead.bytes) !== declared.raster.packageSha256) throw new Error("standalone sidecar raster package metadata does not match its binding");
    const rasterPackage = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rasterPackageRead.bytes));
    if (!isRecord(rasterPackage) || rasterPackage.name !== "@knowledge-forge-ai/tfsb-raster-resvg" || rasterPackage.version !== "0.0.0-tfsb47f"
        || !isRecord(rasterPackage.dependencies) || rasterPackage.dependencies["@resvg/resvg-wasm"] !== "2.6.2") {
      throw new Error("standalone sidecar raster package identity is invalid");
    }
    if (rasterLock.packages[""].name !== rasterPackage.name || rasterLock.packages[""].version !== rasterPackage.version) {
      throw new Error("standalone sidecar raster lock does not match its package");
    }
    await copyRegular(rasterLockPath, resolve(rasterPackageRoot, "package-lock.json"));
    runLocalCommand("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], rasterPackageRoot, standaloneNpmEnvironment(scratchRoot));
    const resvgPackage = await readPackage(resolve(rasterPackageRoot, "node_modules/@resvg/resvg-wasm/package.json"));
    if (resvgPackage.name !== "@resvg/resvg-wasm" || resvgPackage.version !== "2.6.2") throw new Error("standalone sidecar raster dependency identity is invalid");

    return {
      binding,
      corePackageRoot,
      rasterPackageRoot,
      coreTarballIdentity,
      cleanup: async () => rm(scratchRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(scratchRoot, { recursive: true, force: true });
    throw error;
  }
}

async function optionalIdentity(path, expected) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || (expected === "file" && !info.isFile()) || (expected === "directory" && !info.isDirectory())) {
      throw new Error("generated destination has an invalid identity");
    }
    return info;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function requireIdentity(path, expected, identity) {
  if (!sameIdentity(await optionalIdentity(path, expected), identity)) {
    throw new Error("generated destination identity changed concurrently");
  }
}

async function requireAbsent(path, expected) {
  if (await optionalIdentity(path, expected) !== null) {
    throw new Error("concurrent generated destination appeared during pair publication");
  }
}

export async function replaceGeneratedPair({
  binarySource,
  payloadSource,
  binaryDestination,
  payloadDestination,
  inject = async () => {},
}) {
  await mkdir(dirname(binaryDestination), { recursive: true, mode: 0o755 });
  await mkdir(dirname(payloadDestination), { recursive: true, mode: 0o755 });
  const oldBinary = await optionalIdentity(binaryDestination, "file");
  const oldPayload = await optionalIdentity(payloadDestination, "directory");
  if ((oldBinary === null) !== (oldPayload === null)) {
    throw new Error("generated binary and payload destinations are not a complete owned pair");
  }
  const recoveryRoot = await mkdtemp(resolve(dirname(payloadDestination), ".sidecar-recovery-"));
  const backupBinary = resolve(recoveryRoot, "old-binary");
  const backupPayload = resolve(recoveryRoot, "old-payload");
  const rejectedBinary = resolve(recoveryRoot, "rejected-binary");
  const rejectedPayload = resolve(recoveryRoot, "rejected-payload");
  let movedOldBinary = false;
  let movedOldPayload = false;
  let promotedBinary = null;
  let promotedPayload = null;
  let retainRecovery = false;
  let published = false;
  try {
    await inject("recovery-created", { recoveryRoot, backupBinary, backupPayload });
    if (await optionalIdentity(backupBinary, "file") !== null
        || await optionalIdentity(backupPayload, "directory") !== null) {
      retainRecovery = true;
      throw new Error("concurrent object appeared in the owned recovery directory");
    }
    if (oldBinary !== null && oldPayload !== null) {
      await requireIdentity(binaryDestination, "file", oldBinary);
      await inject("before-old-binary-move", { recoveryRoot });
      await rename(binaryDestination, backupBinary);
      movedOldBinary = true;
      await requireIdentity(payloadDestination, "directory", oldPayload);
      await inject("before-old-payload-move", { recoveryRoot });
      await rename(payloadDestination, backupPayload);
      movedOldPayload = true;
    }
    await requireAbsent(binaryDestination, "file");
    await inject("before-first-promotion", { recoveryRoot });
    await rename(binarySource, binaryDestination);
    promotedBinary = await optionalIdentity(binaryDestination, "file");
    await requireAbsent(payloadDestination, "directory");
    await inject("before-second-promotion", { recoveryRoot });
    await rename(payloadSource, payloadDestination);
    promotedPayload = await optionalIdentity(payloadDestination, "directory");
    published = true;
    await inject("before-cleanup", { recoveryRoot });
    await rm(recoveryRoot, { recursive: true, force: false });
  } catch (error) {
    if (published) {
      throw new Error(`generated pair is published but cleanup retained bounded recovery residue at ${basename(recoveryRoot)}`, { cause: error });
    }
    try {
      if (promotedPayload !== null) {
        await requireIdentity(payloadDestination, "directory", promotedPayload);
        await rename(payloadDestination, rejectedPayload);
      }
      if (promotedBinary !== null) {
        await requireIdentity(binaryDestination, "file", promotedBinary);
        await rename(binaryDestination, rejectedBinary);
      }
      if (movedOldPayload) {
        await requireAbsent(payloadDestination, "directory");
        await requireIdentity(backupPayload, "directory", oldPayload);
        await rename(backupPayload, payloadDestination);
      }
      if (movedOldBinary) {
        await requireAbsent(binaryDestination, "file");
        await requireIdentity(backupBinary, "file", oldBinary);
        await rename(backupBinary, binaryDestination);
      }
      if (!retainRecovery) {
        await inject("before-rollback-cleanup", { recoveryRoot });
        await rm(recoveryRoot, { recursive: true, force: false });
      }
    } catch (rollbackError) {
      retainRecovery = true;
      throw new Error(`generated pair rollback retained bounded recovery residue at ${basename(recoveryRoot)}`, { cause: rollbackError });
    } finally {
      if (!retainRecovery) {
        await rm(recoveryRoot, { recursive: true, force: true });
      }
    }
    throw error;
  }
}

function exactRecord(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())) {
    throw new Error(`${label} has unknown or missing fields`);
  }
  return value;
}

function exactDigest(value, label, length = 64) {
  if (typeof value !== "string" || !new RegExp(`^[0-9a-f]{${length}}$`).test(value)) throw new Error(`${label} is invalid`);
}

function boundedInteger(value, maximum, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error(`${label} is invalid`);
}

export function validateManifestShape(manifest, { testOnlyAllowNonProductionIdentity = false } = {}) {
  exactRecord(manifest, ["core", "entrypoint", "files", "manifestDigest", "native", "protocol", "raster", "resvg", "runtime", "runtimeKind", "schema", "schemaVersion", "source", "target", "totals"], "manifest");
  exactRecord(manifest.source, ["actualInputDigest", "baseCommit", "model"], "manifest source");
  exactRecord(manifest.core, ["name", "tarball", "version"], "manifest core");
  exactRecord(manifest.core.tarball, ["sha1", "sha256", "size", "sri"], "manifest core tarball");
  exactRecord(manifest.runtime, ["mode", "sha256", "size", "target", "v8", "version"], "manifest runtime");
  exactRecord(manifest.protocol, ["1.0", "1.1", "1.2"], "manifest protocol");
  for (const version of ["1.0", "1.1", "1.2"]) exactRecord(manifest.protocol[version], ["inventorySha256", "requestsSha256", "resultsSha256"], `manifest protocol ${version}`);
  exactRecord(manifest.native, ["abi", "backend", "sha256", "size", "target"], "manifest native");
  exactRecord(manifest.raster, ["name", "packageJsonSha256", "version"], "manifest raster");
  exactRecord(manifest.resvg, ["name", "version", "wasmSha256", "wasmSize"], "manifest resvg");
  exactRecord(manifest.totals, ["bytes", "fileCount", "inventoryDigest"], "manifest totals");
  exactDigest(manifest.core.tarball.sha1, "manifest core tarball SHA-1", 40);
  exactDigest(manifest.core.tarball.sha256, "manifest core tarball SHA-256");
  boundedInteger(manifest.core.tarball.size, MAX_FILE_BYTES, "manifest core tarball size");
  if (typeof manifest.core.tarball.sri !== "string" || !/^sha512-[A-Za-z0-9+/]+=*$/.test(manifest.core.tarball.sri)) throw new Error("manifest core tarball SRI is invalid");
  exactDigest(manifest.runtime.sha256, "manifest runtime digest");
  boundedInteger(manifest.runtime.size, MAX_FILE_BYTES, "manifest runtime size");
  for (const version of ["1.0", "1.1", "1.2"]) {
    exactDigest(manifest.protocol[version].inventorySha256, `manifest protocol ${version} inventory digest`);
    exactDigest(manifest.protocol[version].requestsSha256, `manifest protocol ${version} requests digest`);
    exactDigest(manifest.protocol[version].resultsSha256, `manifest protocol ${version} results digest`);
  }
  exactDigest(manifest.native.sha256, "manifest native digest");
  boundedInteger(manifest.native.size, MAX_FILE_BYTES, "manifest native size");
  exactDigest(manifest.raster.packageJsonSha256, "manifest raster package digest");
  exactDigest(manifest.resvg.wasmSha256, "manifest resvg WASM digest");
  boundedInteger(manifest.resvg.wasmSize, MAX_FILE_BYTES, "manifest resvg WASM size");
  if (!Array.isArray(manifest.files) || manifest.files.length > MAX_FILES) throw new Error("manifest files are invalid");
  for (const file of manifest.files) {
    exactRecord(file, ["mode", "path", "sha256", "size"], "manifest file");
    normalizeRelative(file.path);
    exactDigest(file.sha256, "manifest file digest");
    boundedInteger(file.mode, 0o777, "manifest file mode");
    boundedInteger(file.size, MAX_FILE_BYTES, "manifest file size");
  }
  if (manifest.schema !== "tfsb.studio-sidecar-distribution" || manifest.schemaVersion !== 1
      || manifest.target !== TARGET || manifest.runtimeKind !== RUNTIME_KIND || manifest.entrypoint !== ENTRYPOINT
      || manifest.source.model !== "closed-input-digest-v1" || !/^[0-9a-f]{40}$/.test(manifest.source.baseCommit)
      || manifest.runtime.version !== NODE_VERSION || manifest.runtime.v8 !== "12.4.254.21-node.56"
      || manifest.runtime.target !== TARGET || manifest.runtime.mode !== 0o755
      || manifest.native.backend !== "native-addon-posix-openat-v1" || manifest.native.abi !== 1
      || manifest.native.target !== TARGET) {
    throw new Error("manifest fixed identity is invalid");
  }
  if (!testOnlyAllowNonProductionIdentity && (manifest.core.name !== "@knowledge-forge-ai/theme-forge-stellar-burst" || manifest.core.version !== "0.4.0"
      || manifest.runtime.sha256 !== "18e387c90ab8a8400183e8bdd396376e1e875b91b4c874b894dcade7b35bf572"
      || manifest.runtime.size !== 112_937_728
      || manifest.native.sha256 !== "2f842ce43f62c76b04884a92980037067c8e55dfd183c86e788f1c3ac8a533c8" || manifest.native.size !== 53_344
      || manifest.raster.name !== "@knowledge-forge-ai/tfsb-raster-resvg" || manifest.raster.version !== "0.0.0-tfsb47f"
      || manifest.raster.packageJsonSha256 !== "14b741e56d9823f82318e8a9d062a02884258eccfae6266138be2a6aaf9acd12"
      || manifest.resvg.name !== "@resvg/resvg-wasm" || manifest.resvg.version !== "2.6.2"
      || manifest.resvg.wasmSha256 !== "22bf6e9f9a100d972da0411a69c5ba504367fc1fa87b3b64e3f35e53926d2d70" || manifest.resvg.wasmSize !== 2_478_606
      || manifest.protocol["1.0"].inventorySha256 !== "96fdbcf0c56c1890d44363c34c80d8dacfccb37196de8050ab2d1afc7a3e0f70"
      || manifest.protocol["1.0"].requestsSha256 !== "5fa687ed6434b4f0ec6288bf4285f4109ab63afe55e2235d52f04f8ed77a8827"
      || manifest.protocol["1.0"].resultsSha256 !== "5b8f0f057d0dbcabf1b5d83765e476baececd5e7cdb5696bfcb1ac1826f84ff1"
      || manifest.protocol["1.1"].inventorySha256 !== "9d58e954e62169e87648814372a381653e9e69df5a0ce722251e6e46951dfe8a"
      || manifest.protocol["1.1"].requestsSha256 !== "b5a10078862c8e03e951a67a8e7cd125c5d4d23619c3d32a9fb41a762629d54f"
      || manifest.protocol["1.1"].resultsSha256 !== "dee9513c61ed767e260d6dd16a13420c26f745850c7a6055cf6213e52571be60"
      || manifest.protocol["1.2"].inventorySha256 !== "b620544ad644a7293313212a9585cd9e07af93608f2beac4e36b4bc99d812638"
      || manifest.protocol["1.2"].requestsSha256 !== "e63252413eaebc2f5a73ad0973d48a51908f8d0604b09440774948bd935daf89"
      || manifest.protocol["1.2"].resultsSha256 !== "d6259a45a4da2185761098ebf6f8d0f5ff80f08f41d3e34a4a3d69f792760fd1")) {
    throw new Error("manifest fixed identity is invalid");
  }
  exactDigest(manifest.manifestDigest, "manifest self digest");
  exactDigest(manifest.source.actualInputDigest, "manifest actual input digest");
  exactDigest(manifest.totals.inventoryDigest, "manifest inventory digest");
  boundedInteger(manifest.totals.fileCount, MAX_FILES, "manifest file count");
  boundedInteger(manifest.totals.bytes, MAX_AGGREGATE_BYTES, "manifest aggregate bytes");
  return manifest;
}

export async function prepareSidecar({ repositoryRoot, nodePath, rootTarball }) {
  const studioRoot = existsSync(resolve(repositoryRoot, "apps/studio")) ? resolve(repositoryRoot, "apps/studio") : repositoryRoot;
  const tauriRoot = resolve(studioRoot, "src-tauri");
  const stageRoot = await mkdtemp(resolve(tauriRoot, ".sidecar-stage-"));
  const stagePayload = resolve(stageRoot, "sidecar-payload");
  const stageBinary = resolve(stageRoot, SIDECAR_NAME);
  await mkdir(stagePayload, { recursive: true, mode: 0o755 });
  let standaloneInputs = null;
  try {
    const nodeInfo = await requireRegular(nodePath);
    const runtimeProbe = probeRuntime(nodePath);
    const baseCommit = await gitIdentity(repositoryRoot);
    const authInputs = resolve(repositoryRoot, "authenticated-inputs");
    const isAuthTree = existsSync(authInputs);
    standaloneInputs = isAuthTree ? await materializeStandaloneInputs({ authInputs, rootTarball }) : null;
    const coreRoot = standaloneInputs?.corePackageRoot ?? repositoryRoot;
    const rasterRoot = standaloneInputs?.rasterPackageRoot ?? resolve(repositoryRoot, "packages/tfsb-raster-resvg");
    const rootPackage = await readPackage(resolve(coreRoot, "package.json"));
    const rasterPackage = await readPackage(resolve(rasterRoot, "package.json"));
    const resvgPackage = await readPackage(resolve(rasterRoot, "node_modules/@resvg/resvg-wasm/package.json"));
    if (rootPackage.version !== "0.4.0" || rasterPackage.version !== "0.0.0-tfsb47f" || resvgPackage.version !== "2.6.2") {
      throw new Error("sidecar package identity does not match the closed release input");
    }

    await copyRegular(nodePath, stageBinary, 0o755);
    await copyClosedTree(resolve(coreRoot, "dist"), resolve(stagePayload, "dist"), new Set());
    await copyRegular(resolve(coreRoot, "package.json"), resolve(stagePayload, "package.json"));
    for (const packageName of ROOT_RUNTIME_PACKAGES) {
      await copyClosedTree(resolve(coreRoot, "node_modules", packageName), resolve(stagePayload, "node_modules", packageName), new Set());
    }
    await copyClosedTree(resolve(coreRoot, "native/directory-snapshot/prebuilds/darwin-arm64"), resolve(stagePayload, "native/directory-snapshot/prebuilds/darwin-arm64"), new Set());
    for (const file of RASTER_FILES) await copyRegular(resolve(rasterRoot, file), resolve(stagePayload, "node_modules/@knowledge-forge-ai/tfsb-raster-resvg", file));
    await copyClosedTree(resolve(rasterRoot, "node_modules/@resvg/resvg-wasm"), resolve(stagePayload, "node_modules/@resvg/resvg-wasm"), new Set());
    for (const file of PROTOCOL_FILES) await copyRegular(resolve(coreRoot, "protocol/tfsb-studio-v1", file), resolve(stagePayload, "protocol/tfsb-studio-v1", file));
    for (const file of LEGAL_FILES) await copyRegular(resolve(coreRoot, file), resolve(stagePayload, "legal", file));
    await copyRegular(resolve(studioRoot, "legal/node-LICENSE.txt"), resolve(stagePayload, "legal/node-LICENSE.txt"));

    const payloadPackage = { name: "@knowledge-forge-ai/tfsb-studio-sidecar-payload", version: "0.1.0", private: true, type: "module" };
    await writeFile(resolve(stagePayload, "package.json"), `${canonicalJson(payloadPackage)}\n`, { mode: 0o644 });
    const files = await inventory(stagePayload);
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    const rootTarballIdentity = await packageIdentity(rootTarball);
    const runtimeBytes = await readFile(nodePath);
    const nativeManifest = await readPackage(resolve(coreRoot, "native/directory-snapshot/prebuilds/darwin-arm64/manifest.json"));
    const wasmPath = resolve(rasterRoot, "node_modules/@resvg/resvg-wasm/index_bg.wasm");
    const wasmBytes = await readFile(wasmPath);
    const protocol = {};
    for (const version of ["1.0", "1.1", "1.2"]) {
      const suffix = version === "1.0" ? "" : `-${version}`;
      protocol[version] = {
        inventorySha256: sha256(await readFile(resolve(coreRoot, `protocol/tfsb-studio-v1/inventory${suffix}.json`))),
        requestsSha256: sha256(await readFile(resolve(coreRoot, `protocol/tfsb-studio-v1/requests${suffix}.schema.json`))),
        resultsSha256: sha256(await readFile(resolve(coreRoot, `protocol/tfsb-studio-v1/results${suffix}.schema.json`))),
      };
    }
    const manifest = {
      schema: "tfsb.studio-sidecar-distribution",
      schemaVersion: 1,
      target: TARGET,
      runtimeKind: RUNTIME_KIND,
      source: {
        actualInputDigest: sha256(Buffer.from(canonicalJson({ coreTarball: rootTarballIdentity, files }))),
        baseCommit,
        model: "closed-input-digest-v1",
      },
      core: { name: rootPackage.name, version: rootPackage.version, tarball: rootTarballIdentity },
      runtime: { version: runtimeProbe.node, v8: runtimeProbe.v8, target: TARGET, sha256: sha256(runtimeBytes), size: nodeInfo.size, mode: 0o755 },
      entrypoint: ENTRYPOINT,
      protocol,
      native: { backend: nativeManifest.backend, abi: nativeManifest.abiVersion, target: TARGET, sha256: nativeManifest.artifactSha256, size: nativeManifest.artifactBytes },
      raster: { name: rasterPackage.name, version: rasterPackage.version, packageJsonSha256: sha256(await readFile(resolve(rasterRoot, "package.json"))) },
      resvg: { name: resvgPackage.name, version: resvgPackage.version, wasmSha256: sha256(wasmBytes), wasmSize: wasmBytes.length },
      files,
      totals: { fileCount: files.length, bytes: totalBytes, inventoryDigest: sha256(Buffer.from(canonicalJson(files))) },
    };
    const manifestDigest = sha256(Buffer.from(canonicalJson(manifest)));
    const closedManifest = { ...manifest, manifestDigest };
    validateManifestShape(closedManifest);
    await writeFile(resolve(stagePayload, "manifest.json"), `${canonicalJson(closedManifest)}\n`, { mode: 0o644 });
    await verifyDistribution({ binaryPath: stageBinary, payloadRoot: stagePayload });
    const binaryDestination = resolve(tauriRoot, "binaries", SIDECAR_NAME);
    const payloadDestination = resolve(tauriRoot, "sidecar-payload");
    const existingBinary = await optionalIdentity(binaryDestination, "file");
    const existingPayload = await optionalIdentity(payloadDestination, "directory");
    if (existingBinary !== null || existingPayload !== null) {
      if (existingBinary === null || existingPayload === null) throw new Error("existing generated sidecar pair is incomplete");
      await verifyDistribution({ binaryPath: binaryDestination, payloadRoot: payloadDestination });
    }
    await replaceGeneratedPair({
      binarySource: stageBinary,
      payloadSource: stagePayload,
      binaryDestination,
      payloadDestination,
    });
    if (standaloneInputs) {
      await standaloneInputs.cleanup();
      standaloneInputs = null;
    }
    await rm(stageRoot, { recursive: true, force: true });
    return { manifestDigest, fileCount: files.length, bytes: totalBytes };
  } catch (error) {
    if (standaloneInputs) await standaloneInputs.cleanup();
    await rm(stageRoot, { recursive: true, force: true });
    throw error;
  }
}

export const replaceGeneratedPairForTest = replaceGeneratedPair;

export async function verifyDistribution({ binaryPath, payloadRoot, testOnlyAllowNonProductionIdentity = false }) {
  await rejectSymlinkAncestors(binaryPath);
  await rejectSymlinkAncestors(payloadRoot);
  const { bytes: binaryBytes, info: binaryInfo } = await readRegular(binaryPath);
  const { bytes: manifestBytes } = await readRegular(resolve(payloadRoot, "manifest.json"), MAX_MANIFEST_BYTES);
  const rawManifest = new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes);
  const manifest = JSON.parse(rawManifest);
  validateManifestShape(manifest, { testOnlyAllowNonProductionIdentity });
  const { manifestDigest, ...unsigned } = manifest;
  if (canonicalJson(manifest) + "\n" !== rawManifest) throw new Error("manifest bytes are not canonical");
  if (manifestDigest !== sha256(Buffer.from(canonicalJson(unsigned)))) throw new Error("manifest self-digest is invalid");
  if (binaryInfo.size !== manifest.runtime.size || sha256(binaryBytes) !== manifest.runtime.sha256 || (binaryInfo.mode & 0o777) !== 0o755) throw new Error("sidecar runtime is invalid");
  const actualFiles = await inventory(payloadRoot);
  if (canonicalJson(actualFiles) !== canonicalJson(manifest.files)) throw new Error("sidecar payload inventory is invalid");
  const expectedOrder = [...manifest.files].sort((left, right) => asciiCompare(left.path, right.path));
  const collisionKeys = new Set(manifest.files.map((file) => file.path.normalize("NFC").toLocaleLowerCase("en-US")));
  if (canonicalJson(expectedOrder) !== canonicalJson(manifest.files) || collisionKeys.size !== manifest.files.length) throw new Error("sidecar payload paths are not sorted and unique");
  const totalBytes = actualFiles.reduce((sum, file) => sum + file.size, 0);
  if (manifest.totals.fileCount !== actualFiles.length || manifest.totals.bytes !== totalBytes
      || manifest.totals.inventoryDigest !== sha256(Buffer.from(canonicalJson(actualFiles)))) throw new Error("sidecar payload totals are invalid");
  if (manifest.source.actualInputDigest !== sha256(Buffer.from(canonicalJson({ coreTarball: manifest.core.tarball, files: manifest.files })))) throw new Error("sidecar actual input identity is invalid");
  const byPath = new Map(actualFiles.map((file) => [file.path, file]));
  const required = (path) => {
    const file = byPath.get(path);
    if (!file) throw new Error(`required sidecar payload file is unavailable: ${path}`);
    return file;
  };
  const native = required("native/directory-snapshot/prebuilds/darwin-arm64/native-addon-posix-openat-v1.node");
  const raster = required("node_modules/@knowledge-forge-ai/tfsb-raster-resvg/package.json");
  const wasm = required("node_modules/@resvg/resvg-wasm/index_bg.wasm");
  required(ENTRYPOINT);
  if (native.sha256 !== manifest.native.sha256 || native.size !== manifest.native.size
      || raster.sha256 !== manifest.raster.packageJsonSha256 || wasm.sha256 !== manifest.resvg.wasmSha256
      || wasm.size !== manifest.resvg.wasmSize) throw new Error("sidecar consequence identity is invalid");
  for (const version of ["1.0", "1.1", "1.2"]) {
    const suffix = version === "1.0" ? "" : `-${version}`;
    if (required(`protocol/tfsb-studio-v1/inventory${suffix}.json`).sha256 !== manifest.protocol[version].inventorySha256
        || required(`protocol/tfsb-studio-v1/requests${suffix}.schema.json`).sha256 !== manifest.protocol[version].requestsSha256
        || required(`protocol/tfsb-studio-v1/results${suffix}.schema.json`).sha256 !== manifest.protocol[version].resultsSha256) throw new Error("sidecar protocol identity is invalid");
  }
  return { manifestDigest, fileCount: actualFiles.length, bytes: manifest.totals.bytes };
}

export async function cleanSidecar(repositoryRoot) {
  const studioRoot = existsSync(resolve(repositoryRoot, "apps/studio")) ? resolve(repositoryRoot, "apps/studio") : repositoryRoot;
  const tauriRoot = resolve(studioRoot, "src-tauri");
  await rm(resolve(tauriRoot, "binaries"), { recursive: true, force: true });
  await rm(resolve(tauriRoot, "sidecar-payload"), { recursive: true, force: true });
}

export function preparationOptions(argv, repositoryRoot) {
  const args = parseArgs(argv);
  const authTarballDir = resolve(repositoryRoot, "authenticated-inputs/core-tarball");
  const authTarballs = existsSync(authTarballDir)
    ? readdirSync(authTarballDir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".tgz"))
    : [];
  if (authTarballs.length > 1) throw new Error("standalone sidecar core archive input is ambiguous");
  const fallbackTarball = authTarballs.length === 1 ? resolve(authTarballDir, authTarballs[0].name) : undefined;
  const nodePath = args.get("node") ?? process.env.TFSB_STUDIO_NODE_BINARY;
  const rootTarball = args.get("root-tarball") ?? process.env.TFSB_STUDIO_ROOT_TARBALL ?? fallbackTarball;
  if (!nodePath || !rootTarball) throw new Error("set explicit --node and --root-tarball inputs (or the documented TFSB_STUDIO_* equivalents)");
  return { repositoryRoot, nodePath: resolve(nodePath), rootTarball: resolve(rootTarball) };
}
