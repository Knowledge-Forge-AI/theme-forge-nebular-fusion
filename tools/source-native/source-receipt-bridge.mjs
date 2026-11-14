#!/usr/bin/env node
// Source-mode receipt bridge.  This module is deliberately independent of the
// maintained checkout: the maintained validators and inventory reader are
// supplied by the caller.  It adapts a real source-mode receipt to the fields
// consumed by the native-RC evidence chain without changing the original
// receipt or claiming hosted/native acceptance.

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const checkoutGitObservations = new WeakSet();

export const BRIDGE_SCHEMA = "nebular.native-rc-source-mode-build-receipt-v1";
export const SOURCE_RECEIPT_FILE = "source-receipt.json";
export const BRIDGE_RECEIPT_FILE = "native-rc-source-mode-build-receipt.json";

const MAX_RECEIPT_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_MEMBER_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_MEMBERS = 100_000;
const MAX_MEMBER_PATH = 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const SHA1 = /^[a-f0-9]{40}$/u;
const SAFE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const SAFE_NODE_VERSION = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const SAFE_FINGERPRINT = /^(?:[a-f0-9]{40}|[a-f0-9]{64}|(?:[a-f0-9]{2}:){19}[a-f0-9]{2}|(?:[a-f0-9]{2}:){31}[a-f0-9]{2})$/iu;

const PLATFORMS = Object.freeze({
  "darwin-arm64": Object.freeze({ triple: "aarch64-apple-darwin" }),
  "linux-arm64": Object.freeze({ triple: "aarch64-unknown-linux-gnu" }),
  "linux-x64": Object.freeze({ triple: "x86_64-unknown-linux-gnu" }),
});
const PLATFORM_BY_TRIPLE = Object.freeze(Object.fromEntries(
  Object.entries(PLATFORMS).map(([platform, value]) => [value.triple, { platform, triple: value.triple }]),
));
const LOCK_KEYS = Object.freeze([
  "src-tauri/Cargo.lock",
  "package-lock.json",
  "loom-preview-source/package-lock.json",
  "rust-toolchain.toml",
]);
const TOOLCHAIN_KEYS = Object.freeze(["node", "rust", "cargo", "compiler", "linker", "systemLibraries"]);
const RUNTIME_KEYS = Object.freeze(["receiptSha256", "nodeVersion", "undici", "executableSha256", "signer"]);
const FRONTEND_KEYS = Object.freeze(["identity", "files"]);
const PAYLOAD_KEYS = Object.freeze(["identity", "files"]);
const ENVIRONMENT_KEYS = Object.freeze(["runnerOs", "runnerArch", "imageOs", "imageVersion", "container", "packages"]);

const fail = (message) => { throw new Error(`Source receipt bridge: ${message}`); };

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype);
}

function exactObject(value, expectedKeys) {
  return isPlainObject(value)
    && Object.keys(value).length === expectedKeys.length
    && expectedKeys.every((key) => Object.hasOwn(value, key));
}

function requireExactObject(value, expectedKeys, message) {
  if (!exactObject(value, expectedKeys)) fail(message);
  return value;
}

function requireSha(value, message) {
  if (typeof value !== "string" || !SHA256.test(value)) fail(message);
  return value;
}

function requireSha1(value, message) {
  if (typeof value !== "string" || !SHA1.test(value)) fail(message);
  return value;
}

function requireSafeInteger(value, message, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(message);
  return value;
}

function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isPlainObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  fail("unsupported identity value");
}

function identity(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function gitBlobSha1(bytes) {
  const header = Buffer.from(`blob ${bytes.length}\0`, "utf8");
  return createHash("sha1").update(Buffer.concat([header, bytes])).digest("hex");
}

function decodeJson(bytes, label, maxBytes = MAX_RECEIPT_BYTES) {
  if (!Buffer.isBuffer(bytes) || bytes.length > maxBytes) fail(`${label} is too large`);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(`${label} is not valid UTF-8`);
  }
  if (text.charCodeAt(0) === 0xfeff) fail(`${label} has an unsupported BOM`);
  try {
    return JSON.parse(text);
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

function publicRelativePath(value, message) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_MEMBER_PATH
      || value.startsWith("/") || value.includes("\\") || value.includes("\0")
      || value.split("/").some((part) => part.length === 0 || part === "." || part === "..")
      || !/^[A-Za-z0-9._@+ -]+(?:\/[A-Za-z0-9._@+ -]+)*$/u.test(value)
      || /^(?:Users|home|private|tmp|var|Volumes)(?:\/|$)/iu.test(value)) {
    fail(message);
  }
  return value;
}

function logicalPath(value, message) {
  // Logical output paths are not host paths.  Keep them constrained to the
  // same public-relative grammar, while allowing the fixed candidate labels.
  return publicRelativePath(value, message);
}

function validateMemberManifest(manifest) {
  requireExactObject(manifest, ["schema", "members", "totalBytes", "identity"], "archive member manifest fields invalid");
  if (manifest.schema !== "nebular.source-input-archive-members-v1") fail("archive member manifest schema invalid");
  if (!Array.isArray(manifest.members) || manifest.members.length === 0 || manifest.members.length > MAX_ARCHIVE_MEMBERS) {
    fail("archive member manifest count invalid");
  }
  const members = [];
  let total = 0;
  let previous = "";
  const prefixes = new Map();
  for (const member of manifest.members) {
    requireExactObject(member, ["path", "bytes", "sha256"], "archive member record fields invalid");
    publicRelativePath(member.path, "archive member path invalid");
    const parts = member.path.split("/");
    for (let count = 1; count <= parts.length; count++) {
      const spelling = parts.slice(0, count).join("/");
      const key = spelling.normalize("NFC").toLowerCase();
      const kind = count === parts.length ? "file" : "directory";
      const prior = prefixes.get(key);
      if (prior && (prior.spelling !== spelling || prior.kind !== kind || kind === "file")) fail("archive member prefix collision");
      prefixes.set(key, { spelling, kind });
    }
    requireSafeInteger(member.bytes, "archive member size invalid", { maximum: MAX_ARCHIVE_MEMBER_BYTES });
    requireSha(member.sha256, "archive member digest invalid");
    if (member.path <= previous) fail("archive members are not strictly ordered");
    previous = member.path;
    total += member.bytes;
    if (total > MAX_ARCHIVE_BYTES) fail("archive member bytes exceed limit");
    members.push({ path: member.path, bytes: member.bytes, sha256: member.sha256 });
  }
  if (manifest.totalBytes !== total) fail("archive member byte total mismatch");
  const body = { schema: manifest.schema, members, totalBytes: total };
  if (manifest.identity !== identity(body)) fail("archive member manifest identity mismatch");
  return { ...body, identity: manifest.identity };
}

function validateExtractionReceipt(value, archive) {
  if (value === undefined) return "caller-supplied-unverified";
  requireExactObject(value, ["schema", "status", "archiveSha256", "manifestSha256", "members", "bytes", "executedMembers", "nativeBuild"], "extractor receipt fields invalid");
  const manifest = archive.memberManifest.members.find(row => row.path === "bundle-manifest.json");
  if (value.schema !== "nebular.native-input-extraction.v1" || value.status !== "passed-inputs-only"
      || value.archiveSha256 !== archive.sha256 || !manifest || value.manifestSha256 !== manifest.sha256
      || value.members !== archive.memberManifest.members.length
      || value.bytes !== archive.memberManifest.totalBytes - manifest.bytes
      || value.executedMembers !== false || value.nativeBuild !== false) fail("extractor receipt binding invalid");
  return "extractor-result-linked-not-reparsed-by-bridge";
}

function validateBundleSourceBinding(bytes, archive, extraction, authority) {
  if (bytes === undefined) return { status: "not-bound" };
  const row = archive.memberManifest.members.find(member => member.path === "bundle-manifest.json");
  if (!row || sha256(bytes) !== row.sha256 || bytes.length !== row.bytes) fail("bundle manifest bytes differ from archive member record");
  const manifest = decodeJson(bytes, "bundle manifest", 2*1024*1024);
  if (!bytes.equals(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`))) fail("bundle manifest is not exact producer serialization");
  if (manifest.schema !== "nebular.native-material-input-bundle.v1"
      || manifest.studio?.root !== "studio" || manifest.studio?.composition !== authority.inputs.source.composition
      || manifest.version !== authority.inputs.source.version || manifest.target !== authority.inputs.target
      || manifest.mode !== authority.inputs.mode) fail("bundle manifest differs from source authority");
  const componentSources = {}, componentOutputs = {};
  for (const name of ["burst", "loom", "solar"]) {
    const component = manifest.components?.[name];
    if (!component || component.sourceRoot !== `component-sources/${name}` || component.outputRoot !== `component-outputs/${name}`
        || component.source !== authority.inputs.source.components[name]
        || component.source !== authority.claims.components[name].source
        || component.output !== authority.claims.components[name].output) fail("bundle component differs from source authority");
    componentSources[name] = component.source;
    componentOutputs[name] = component.output;
  }
  return { status: extraction ? "extractor-linked-manifest-to-source-candidate" : "caller-supplied-manifest-to-source-candidate",
    manifestSha256: row.sha256, studioComposition: manifest.studio.composition, componentSources, componentOutputs };
}

function validateArchiveMetadata(archive, archiveBytes, git) {
  requireExactObject(archive, ["path", "sha256", "gitBlobSha1", "size", "memberManifest"], "input archive fields invalid");
  publicRelativePath(archive.path, "input archive path invalid");
  requireSha(archive.sha256, "input archive digest invalid");
  requireSha1(archive.gitBlobSha1, "input archive Git blob identity invalid");
  requireSafeInteger(archive.size, "input archive size invalid", { maximum: MAX_ARCHIVE_BYTES });
  if (!Buffer.isBuffer(archiveBytes) || archiveBytes.length > MAX_ARCHIVE_BYTES) fail("input archive bytes exceed limit");
  if (archive.size !== archiveBytes.length || archive.sha256 !== sha256(archiveBytes)) fail("input archive bytes do not match declared digest");
  const actualBlob = gitBlobSha1(archiveBytes);
  if (archive.gitBlobSha1 !== actualBlob || git.archiveBlobSha1 !== actualBlob) fail("input archive Git blob does not match bytes");
  if (git.archivePath !== archive.path) fail("Git archive path does not match input archive");
  const memberManifest = validateMemberManifest(archive.memberManifest);
  return {
    path: archive.path,
    sha256: archive.sha256,
    gitBlobSha1: actualBlob,
    size: archiveBytes.length,
    memberManifest,
  };
}

function validateGitObservation(git, expectedCommit, archivePath) {
  requireExactObject(git, ["commit", "tree", "archivePath", "archiveBlobSha1"], "Git observation fields invalid");
  requireSha1(git.commit, "Git source commit invalid");
  requireSha1(git.tree, "Git source tree invalid");
  publicRelativePath(git.archivePath, "Git archive path invalid");
  requireSha1(git.archiveBlobSha1, "Git archive blob identity invalid");
  if (expectedCommit !== git.commit || archivePath !== git.archivePath) fail("Git source binding does not match expected source");
  return git;
}

function validateToolchains(value, receipt) {
  requireExactObject(value, TOOLCHAIN_KEYS, "legacy toolchain fields invalid");
  for (const key of TOOLCHAIN_KEYS) requireSha(value[key], "legacy toolchain identity invalid");
  if (canonical(value) !== canonical(receipt.toolchains)) fail("legacy toolchains disagree with source receipt");
  return { ...value };
}

function validateEmbeddedRuntime(value, receipt, authority) {
  requireExactObject(value, RUNTIME_KEYS, "embedded runtime fields invalid");
  requireSha(value.receiptSha256, "embedded runtime receipt identity invalid");
  if (typeof value.nodeVersion !== "string" || !SAFE_NODE_VERSION.test(value.nodeVersion)) fail("embedded runtime version invalid");
  if (value.undici !== null && (typeof value.undici !== "string" || !SAFE_VERSION.test(value.undici))) {
    fail("embedded runtime dependency version invalid");
  }
  if (value.signer !== null && (typeof value.signer !== "string" || !SAFE_FINGERPRINT.test(value.signer))) {
    fail("embedded runtime signer fingerprint invalid");
  }
  requireSha(value.executableSha256, "embedded runtime executable identity invalid");
  const runtimeIdentities = receipt.preparation?.externalBin;
  const runtimePath = authority.inputs.source.resourcePlans?.[receipt.target]?.externalBin;
  if (!Array.isArray(runtimePath) || runtimePath.length !== 1
      || !["binaries/tfsb-studio-service", "tfsb-studio-service"].includes(runtimePath[0])
      || !Array.isArray(runtimeIdentities) || runtimeIdentities.length !== 1
      || runtimeIdentities[0]?.path !== runtimePath[0]
      || runtimeIdentities[0]?.identity !== value.executableSha256) {
    fail("embedded runtime executable differs from source receipt runtime identity");
  }
  const declared = authority.inputs.embeddedRuntime ?? authority.inputs.toolchains?.node;
  if (!isPlainObject(declared) || !SHA256.test(declared.identity ?? "")
      || declared.identity !== value.executableSha256) fail("embedded runtime differs from build authority");
  return { ...value };
}

function validateEmbeddedFrontend(value, stagedInventory) {
  requireExactObject(value, FRONTEND_KEYS, "embedded frontend fields invalid");
  requireSha(value.identity, "embedded frontend identity invalid");
  requireSafeInteger(value.files, "embedded frontend file count invalid", { maximum: MAX_ARCHIVE_MEMBERS });
  if (value.identity !== stagedInventory.identity || value.files !== stagedInventory.files.length) {
    fail("embedded frontend differs from staged dist inventory");
  }
  return { ...value };
}

function validateNativePayload(value, receipt, payloadInventory) {
  requireExactObject(value, PAYLOAD_KEYS, "native payload fields invalid");
  requireSha(value.identity, "native payload identity invalid");
  requireSafeInteger(value.files, "native payload file count invalid", { maximum: MAX_ARCHIVE_MEMBERS });
  if (value.identity !== receipt.nativePayload || value.identity !== payloadInventory.identity || value.files !== payloadInventory.files.length) {
    fail("native payload observation disagrees with source receipt or payload bytes");
  }
  return { ...value };
}

function validateEnvironment(value, platform) {
  requireExactObject(value, ENVIRONMENT_KEYS, "native environment fields invalid");
  const expected = platform === "darwin-arm64" ? ["macos", "arm64"]
    : platform === "linux-arm64" ? ["linux", "arm64"] : ["linux", "x64"];
  if (value.runnerOs !== expected[0] || value.runnerArch !== expected[1]) fail("native runner identity invalid");
  for (const key of ["imageOs", "imageVersion"]) {
    if (value[key] !== null && (typeof value[key] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value[key]))) {
      fail("native image metadata invalid");
    }
  }
  if (value.container !== null && (platform === "darwin-arm64" || !/^sha256:[a-f0-9]{64}$/u.test(value.container))) {
    fail("native container identity invalid");
  }
  if (value.packages !== null) requireSha(value.packages, "native package inventory identity invalid");
  return { ...value };
}

function validateLocks(value) {
  requireExactObject(value, LOCK_KEYS, "native lock fields invalid");
  for (const key of LOCK_KEYS) requireSha(value[key], "native lock identity invalid");
  return { ...value };
}

function validateLegacyObservation(value, receipt, payloadInventory, stagedFrontendInventory, git, authority) {
  requireExactObject(value, ["platform", "triple", "toolchains", "embeddedRuntime", "embeddedFrontend", "nativePayload", "environment", "locks"], "legacy observation fields invalid");
  const platform = PLATFORM_BY_TRIPLE[receipt.target];
  if (!platform || value.platform !== platform.platform || value.triple !== platform.triple) fail("legacy platform does not match source receipt target");
  return {
    platform: value.platform,
    triple: value.triple,
    source: { commit: git.commit, tree: git.tree },
    toolchains: validateToolchains(value.toolchains, receipt),
    embeddedRuntime: validateEmbeddedRuntime(value.embeddedRuntime, receipt, authority),
    embeddedFrontend: validateEmbeddedFrontend(value.embeddedFrontend, stagedFrontendInventory),
    nativePayload: validateNativePayload(value.nativePayload, receipt, payloadInventory),
    environment: validateEnvironment(value.environment, value.platform),
    locks: validateLocks(value.locks),
  };
}

async function readStagedLocks(stagedSourceRoot, authority, observedLocks, verifiedTree) {
  if (!isPlainObject(observedLocks)) fail("legacy lock observation required");
  if (typeof authority.inputs.sourceRoot !== "string" || !isAbsolute(authority.inputs.sourceRoot)) fail("clean source root required");
  const actual = {};
  for (const path of LOCK_KEYS) {
    const original = verifiedTree.files.find(row => row.path === path)?.sha256;
    requireSha(original, "verified source lock missing");
    actual[path] = sha256(await readRegularBytes(join(stagedSourceRoot, path), MAX_RECEIPT_BYTES, "staged lock"));
    if (actual[path] !== original) fail("staged lock differs from clean source");
    if (actual[path] !== observedLocks[path]) fail("staged lock differs from legacy observation");
  }
  const sourceLocks = authority.inputs.source?.locks;
  if (!sourceLocks || actual["src-tauri/Cargo.lock"] !== sourceLocks.cargo
      || actual["package-lock.json"] !== sourceLocks.frontend) {
    fail("staged Cargo or frontend lock differs from source authority");
  }
  return actual;
}

async function resolveAuthority({ authority, buildInputsPath, maintained }) {
  if (buildInputsPath !== undefined) {
    if (!maintained || typeof maintained.loadBuildInputs !== "function") fail("maintained build-input loader required");
    authority = await maintained.loadBuildInputs(buildInputsPath);
  }
  if (!authority || !isPlainObject(authority) || !authority.inputs || !authority.claims) fail("validated build-input authority required");
  if (!maintained || typeof maintained.validateBuildReceipt !== "function"
      || typeof maintained.verifyBuildInputReceipt !== "function"
      || typeof maintained.verifySourceTree !== "function") {
    fail("maintained receipt validators required");
  }
  return authority;
}

async function validateMaintainedReceipt(receipt, authority, maintained) {
  try {
    const verifiedTree = await maintained.verifySourceTree(authority.inputs.sourceRoot, authority.inputs.source);
    maintained.validateBuildReceipt(receipt, authority.inputs.source);
    maintained.verifyBuildInputReceipt(authority, receipt);
    return verifiedTree;
  } catch {
    fail("source receipt failed maintained validation");
  }
}

/**
 * Bridge a source-mode build receipt.  `sourceReceiptBytes`, `archiveBytes`,
 * and `payloadRoot` are the actual produced inputs.  Git and maintained APIs
 * are ports so tests can prove the binding without invoking Git or a build.
 */
export async function bridgeSourceModeReceipt({
  sourceReceiptBytes,
  authority,
  buildInputsPath,
  maintained,
  payloadRoot,
  stagedSourceRoot,
  archiveBytes,
  archive,
  git,
  expectedCommit,
  legacyObservation,
  extractionReceipt,
  bundleManifestBytes,
  maintainedApiSha256 = null,
  sourceReceiptFile = SOURCE_RECEIPT_FILE,
  payloadMapping = "candidate/payload",
  stagedSourceMapping = "candidate/work/source",
}) {
  if (!Buffer.isBuffer(sourceReceiptBytes)) fail("source receipt bytes required");
  if (typeof stagedSourceRoot !== "string" || !isAbsolute(stagedSourceRoot)) fail("staged source root must be absolute");
  if (typeof payloadRoot !== "string" || !isAbsolute(payloadRoot)) fail("payload root must be absolute");
  const sourceReceipt = decodeJson(sourceReceiptBytes, "source receipt");
  // The maintained producer writes exactly this format. Reject shadowed keys
  // and nonproducer serialization; never rewrite supplied receipt bytes.
  if (!sourceReceiptBytes.equals(Buffer.from(`${JSON.stringify(sourceReceipt, null, 2)}\n`))) {
    fail("source receipt is not exact producer serialization");
  }
  if (!isPlainObject(sourceReceipt) || !requireSha(sourceReceipt.identity, "source receipt identity missing")) fail("source receipt record invalid");
  const receiptBytesSha256 = sha256(sourceReceiptBytes);
  const authorityRecord = await resolveAuthority({ authority, buildInputsPath, maintained });
  const verifiedSourceTree = await validateMaintainedReceipt(sourceReceipt, authorityRecord, maintained);
  if (sourceReceipt.materialRoute && authorityRecord.inputs.materialRoute?.authorityStatus !== "held-self-derived-record") fail("material authority held status missing");
  if (typeof maintained.inventoryTree !== "function") fail("maintained payload inventory required");
  let payloadInventory;
  try {
    payloadInventory = await maintained.inventoryTree(payloadRoot);
  } catch {
    fail("native payload inventory failed");
  }
  if (!payloadInventory || !Array.isArray(payloadInventory.files) || !requireSha(payloadInventory.identity, "native payload inventory identity invalid")) {
    fail("native payload inventory invalid");
  }
  let stagedFrontendInventory;
  try {
    stagedFrontendInventory = await maintained.inventoryTree(join(stagedSourceRoot, "dist"));
  } catch {
    fail("staged dist inventory failed");
  }
  if (!stagedFrontendInventory || !Array.isArray(stagedFrontendInventory.files)
      || !requireSha(stagedFrontendInventory.identity, "staged dist inventory identity invalid")) {
    fail("staged dist inventory invalid");
  }
  await readStagedLocks(stagedSourceRoot, authorityRecord, legacyObservation?.locks, verifiedSourceTree);
  const gitRecord = validateGitObservation(git, expectedCommit, archive?.path);
  const archiveRecord = validateArchiveMetadata(archive, archiveBytes, gitRecord);
  const extractionBinding = validateExtractionReceipt(extractionReceipt, archiveRecord);
  const inputSourceBinding = validateBundleSourceBinding(bundleManifestBytes, archiveRecord, extractionReceipt, authorityRecord);
  const legacy = validateLegacyObservation(legacyObservation, sourceReceipt, payloadInventory, stagedFrontendInventory, gitRecord, authorityRecord);
  logicalPath(sourceReceiptFile, "source receipt output mapping invalid");
  logicalPath(payloadMapping, "payload output mapping invalid");
  logicalPath(stagedSourceMapping, "staged source output mapping invalid");
  const platform = PLATFORM_BY_TRIPLE[sourceReceipt.target];
  if (!platform) fail("source receipt target is unsupported");
  const bridge = {
    schema: BRIDGE_SCHEMA,
    status: checkoutGitObservations.has(git) ? "source-receipt-bridged" : "source-receipt-bridged-fixture-only",
    nativeAcceptance: "not-claimed",
    platform: legacy.platform,
    triple: legacy.triple,
    version: sourceReceipt.version,
    mode: sourceReceipt.mode,
    source: legacy.source,
    sourceCandidate: sourceReceipt.sourceCandidate,
    ...(sourceReceipt.materialRoute ? {
      materialRoute: { ...sourceReceipt.materialRoute, authorityStatus: authorityRecord.inputs.materialRoute.authorityStatus },
    } : {}),
    provenance: {
      gitObservation: checkoutGitObservations.has(git) ? "checkout-rev-parse" : "injected",
      fixtureOnly: !checkoutGitObservations.has(git),
      memberManifestBinding: extractionBinding,
      inputArchiveToSourceCandidate: inputSourceBinding.status,
      stagedSource: "locks-bound-dist-observed-remainder-unverified",
      maintainedApiSha256Scope: "entry-bytes-read-before-import-not-transitive",
      maintainedApiSha256: maintainedApiSha256 === null ? null : requireSha(maintainedApiSha256, "maintained API digest invalid"),
      runtimeMetadata: "caller-observed-format-checked",
      environment: "caller-observed-format-checked",
      frontend: "staged-dist-observed-not-source-receipt-bound",
      locks: "clean-source-composition-and-staged-byte-bound",
    },
    sourceReceiptSha256: receiptBytesSha256,
    sourceReceiptIdentity: sourceReceipt.identity,
    sourceReceipt: {
      file: sourceReceiptFile,
      sha256: receiptBytesSha256,
      identity: sourceReceipt.identity,
      sourceCandidate: sourceReceipt.sourceCandidate,
    },
    inputArchive: {
      path: archiveRecord.path,
      sha256: archiveRecord.sha256,
      gitBlobSha1: archiveRecord.gitBlobSha1,
      size: archiveRecord.size,
      memberManifest: archiveRecord.memberManifest,
      sourceBinding: inputSourceBinding,
    },
    toolchains: legacy.toolchains,
    embeddedRuntime: legacy.embeddedRuntime,
    embeddedFrontend: legacy.embeddedFrontend,
    nativePayload: legacy.nativePayload,
    environment: legacy.environment,
    locks: legacy.locks,
    mapping: {
      publicSource: { commit: legacy.source.commit, tree: legacy.source.tree },
      sourceReceipt: sourceReceiptFile,
      inputArchive: archiveRecord.path,
      stagedSource: stagedSourceMapping,
      payload: payloadMapping,
    },
  };
  return Object.freeze({ bridge, sourceReceiptBytes, sourceReceipt, payloadInventory, archiveBytes });
}

function gitCommand(checkout, args) {
  const result = spawnSync("git", ["-C", checkout, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000, maxBuffer: 4096,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
  });
  if (result.error || result.status !== 0) fail("Git source observation failed");
  const value = result.stdout.trim();
  if (!value || /[\r\n]/u.test(value)) fail("Git source observation was not a single identity");
  return value;
}

/** Fixed-argv Git boundary.  Tests inject the observation and never call this. */
export function readGitObservation({ checkout, archivePath, expectedCommit }, { command = gitCommand } = {}) {
  if (typeof checkout !== "string" || !isAbsolute(checkout)) fail("Git checkout must be absolute");
  publicRelativePath(archivePath, "Git archive path invalid");
  const commit = command(checkout, ["rev-parse", "HEAD"]);
  if (commit !== expectedCommit) fail("Git checkout is not the expected source commit");
  const tree = command(checkout, ["rev-parse", `${commit}^{tree}`]);
  const archiveBlobSha1 = command(checkout, ["rev-parse", `${commit}:${archivePath}`]);
  requireSha1(commit, "Git source commit invalid");
  requireSha1(tree, "Git source tree invalid");
  requireSha1(archiveBlobSha1, "Git archive blob identity invalid");
  const result = Object.freeze({ commit, tree, archivePath, archiveBlobSha1 });
  if (command === gitCommand) checkoutGitObservations.add(result);
  return result;
}

async function readRegularBytes(path, maxBytes, label) {
  if (typeof path !== "string" || !isAbsolute(path)) fail(`${label} path must be absolute`);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) fail(`${label} is not a bounded regular file`);
    const chunks = [];
    let total = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(65536, maxBytes - total + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maxBytes) fail(`${label} grew beyond limit`);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const bytes = Buffer.concat(chunks, total);
    const after = await handle.stat();
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs || bytes.length !== info.size) fail(`${label} changed while reading`);
    return bytes;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Source receipt bridge:")) throw error;
    fail(`${label} could not be read`);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readJsonFile(path, label) {
  return decodeJson(await readRegularBytes(path, MAX_RECEIPT_BYTES, label), label);
}

function parseArgs(argv) {
  const options = {};
  const names = new Map([
    ["--source-receipt", "sourceReceipt"],
    ["--build-inputs", "buildInputs"],
    ["--payload", "payload"],
    ["--staged-source", "stagedSource"],
    ["--input-archive", "inputArchive"],
    ["--archive-manifest", "archiveManifest"],
    ["--legacy-observation", "legacyObservation"],
    ["--git-observation", "gitObservation"],
    ["--extraction-receipt", "extractionReceipt"],
    ["--bundle-manifest", "bundleManifest"],
    ["--checkout", "checkout"],
    ["--archive-path", "archivePath"],
    ["--expected-commit", "expectedCommit"],
    ["--maintained-api", "maintainedApi"],
    ["--output", "output"],
  ]);
  if (argv.includes("--test-injected-git")) {
    if (argv.filter(arg => arg === "--test-injected-git").length !== 1) fail("invalid bridge CLI arguments");
    options.testInjectedGit = true;
    argv = argv.filter(arg => arg !== "--test-injected-git");
  }
  for (let index = 0; index < argv.length; index += 2) {
    const key = names.get(argv[index]);
    if (!key || argv[index + 1] === undefined || argv[index + 1].startsWith("--") || Object.hasOwn(options, key)) {
      fail("invalid bridge CLI arguments");
    }
    options[key] = argv[index + 1];
  }
  const required = ["sourceReceipt", "buildInputs", "payload", "stagedSource", "inputArchive", "archiveManifest", "legacyObservation", "expectedCommit", "maintainedApi", "output"];
  if (required.some((key) => !options[key])) fail("required bridge CLI argument missing");
  if (!options.gitObservation && !(options.checkout && options.archivePath)) fail("Git observation or checkout binding required");
  if (Boolean(options.gitObservation) !== Boolean(options.testInjectedGit)) fail("injected Git requires explicit test mode");
  if (options.gitObservation && (options.checkout || options.archivePath)) fail("Git observation inputs are mutually exclusive");
  return options;
}

export async function runCli(argv) {
  const options = parseArgs(argv);
  const maintainedApiSha256 = sha256(await readRegularBytes(resolve(options.maintainedApi), MAX_RECEIPT_BYTES, "maintained API"));
  const maintainedModule = await import(pathToFileURL(resolve(options.maintainedApi)).href);
  const maintained = maintainedModule.default ?? maintainedModule;
  const sourceReceiptBytes = await readRegularBytes(options.sourceReceipt, MAX_RECEIPT_BYTES, "source receipt");
  const archiveBytes = await readRegularBytes(options.inputArchive, MAX_ARCHIVE_BYTES, "input archive");
  const archiveManifest = await readJsonFile(options.archiveManifest, "archive member manifest");
  const legacyObservation = await readJsonFile(options.legacyObservation, "legacy observation");
  const git = options.gitObservation
    ? await readJsonFile(options.gitObservation, "Git observation")
    : readGitObservation({ checkout: options.checkout, archivePath: options.archivePath, expectedCommit: options.expectedCommit });
  const authority = await maintained.loadBuildInputs(options.buildInputs);
  const archive = {
    path: git.archivePath,
    sha256: sha256(archiveBytes),
    gitBlobSha1: git.archiveBlobSha1,
    size: archiveBytes.length,
    memberManifest: archiveManifest,
  };
  const result = await bridgeSourceModeReceipt({
    sourceReceiptBytes,
    authority,
    maintained,
    payloadRoot: options.payload,
    stagedSourceRoot: options.stagedSource,
    archiveBytes,
    archive,
    git,
    expectedCommit: options.expectedCommit,
    legacyObservation,
    maintainedApiSha256,
    bundleManifestBytes: options.bundleManifest ? await readRegularBytes(options.bundleManifest, 2*1024*1024, "bundle manifest") : undefined,
    extractionReceipt: options.extractionReceipt ? await readJsonFile(options.extractionReceipt, "extraction receipt") : undefined,
  });
  await mkdir(options.output, { recursive: false, mode: 0o755 });
  await writeFile(resolve(options.output, SOURCE_RECEIPT_FILE), result.sourceReceiptBytes, { flag: "wx", mode: 0o644 });
  await writeFile(resolve(options.output, BRIDGE_RECEIPT_FILE), `${JSON.stringify(result.bridge, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  return result.bridge;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const bridge = await runCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify({ schema: bridge.schema, status: bridge.status, nativeAcceptance: bridge.nativeAcceptance })}\n`);
  } catch (error) {
    const message = error instanceof Error && /^Source receipt bridge: [A-Za-z0-9 -]+$/u.test(error.message) ? error.message : "Source receipt bridge: operation refused";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
