#!/usr/bin/env node
// Consumer-only qualification for already-published Nebular product archives.
// This helper never builds, packs, installs dependencies, seals build evidence, or
// accepts SDK/helper/OCI inputs. It is intended to be projected to tools/ by the
// Nebular composition and invoked only after public source admission succeeds.

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { descriptorIdentity, readRegularSnapshot, sameIdentity } from "./fs-snapshot.mjs";
import { inventoryNativePayload } from "./native-runtime.mjs";
import { RESOURCE_PREPARERS, resourceDirectories } from "./platform-targets.mjs";

export const INPUT_SCHEMA = "nebular.hosted-product-consumer-input-v2";
export const ADMISSION_SCHEMA = "nebular.public-source-admission-v1";
export const RECEIPT_SCHEMA = "nebular.native-rc-consumer-receipt-v2";
export const PLATFORM_RECEIPT_SCHEMA = "nebular.native-rc-consumer-platform-receipt-v1";
export const SOURCE_PAYLOAD_SCHEMA = "nebular.public-source-payload-v1";
export const CORRESPONDING_SOURCE_OFFER_SCHEMA = "nebular.corresponding-source-offer-readback-v1";
export const SOURCE_READBACK_SCHEMA = "nebular.public-source-readback-v2";
export const SOURCE_READBACK_FETCH_SCHEMA = "nebular.source-readback-fetch-manifest-v1";
export const PACKAGE_MANIFEST_SCHEMAS = Object.freeze([
  "tfsb.nebular-package-manifest-v1",
  "tfsb.nebular-package-manifest-v2",
]);
export const QUALIFICATION_RECEIPT_SCHEMA = "nebular.native-rc-qualification-v1";
export const SMOKE_RUN_SCHEMA = "nebular.native-rc-smoke-run-v1";
export const SMOKE_FINALIZATION_SCHEMA = "nebular.native-rc-finalization-v1";
export const SOURCE_CONTRACT = "public-source-first-v6";
export const REPOSITORY = "Knowledge-Forge-AI/theme-forge-nebular-fusion";
export const PRODUCT = "theme-forge-nebular-fusion";
export const VERSION = "0.7.0";
export const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_SOURCE_LISTING_BYTES = 64 * 1024 * 1024;
export const MAX_READBACK_RECEIPT_BYTES = 8 * 1024 * 1024;
export const MAX_REDIRECTS = 5;
const SOURCE_READBACK_ASSET_ROLES = Object.freeze([
  "corresponding-source-offer",
  "darwin-app-source",
  "linux-app-source",
]);
const SOURCE_READBACK_ASSET_PATHS = Object.freeze({
  "corresponding-source-offer": "source-offer/nebular-corresponding-source.tar.gz",
  "darwin-app-source": "darwin-app-source/source.tar.gz",
  "linux-app-source": "linux-app-source/source.tar.gz",
});
const SOURCE_READBACK_PLATFORM_ROLES = Object.freeze({
  "darwin-arm64": "darwin-app-source",
  "linux-arm64": "linux-app-source",
  "linux-x64": "linux-app-source",
});
export const DARWIN_RETAINED_COMMIT_PREFIX = /^b954[a-f0-9]{36}$/u;
export const DARWIN_AUTHORITIES = Object.freeze([
  "retained-darwin-b954",
  "current-darwin-source",
]);
export const ALLOWED_RELEASE_HOSTS = Object.freeze(new Set([
  "api.github.com",
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]));

export const PLATFORMS = Object.freeze({
  "darwin-arm64": Object.freeze({
    runner: "macos-15",
    scenarios: ["A"],
    qualification: "existing-qualified",
    authority: "retained-darwin-b954",
    authorities: DARWIN_AUTHORITIES,
    rawRoot: "Theme Forge Nebular Fusion.app",
    rawExecutable: "Theme Forge Nebular Fusion.app/Contents/MacOS/theme-forge-nebular-fusion",
    npmExecutable: "payload/Theme Forge Nebular Fusion.app/Contents/MacOS/theme-forge-nebular-fusion",
  }),
  "linux-arm64": Object.freeze({
    runner: "ubuntu-24.04-arm",
    scenarios: ["B"],
    qualification: "hosted",
    authority: "current-linux-source",
    rawRoot: "theme-forge-nebular-fusion",
    rawExecutable: "bin/theme-forge-nebular-fusion",
    npmExecutable: "payload/bin/theme-forge-nebular-fusion",
  }),
  "linux-x64": Object.freeze({
    runner: "ubuntu-24.04",
    scenarios: ["C", "C-signal"],
    qualification: "hosted",
    authority: "current-linux-source",
    rawRoot: "theme-forge-nebular-fusion",
    rawExecutable: "bin/theme-forge-nebular-fusion",
    npmExecutable: "payload/bin/theme-forge-nebular-fusion",
  }),
});

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const PRIVATE_KEY = /(?:token|secret|password|credential|private|sdk|oci|docker|helper|buildReceipt)/iu;
const SYNTHETIC_KEY = /^(?:fixture|synthetic|selfAsserted)$/u;
const PRIVATE_VALUE = /(?:^|[/\\])(?:Users|private|home|var\/folders)(?:[/\\]|$)|^(?:file|ssh):[/\\]{2}|^[A-Za-z]:[/\\]/iu;
const SYNTHETIC_VALUE = /(?:never release evidence|synthetic contract\/refusal fixture|self-asserted)/iu;
const fail = (message) => { throw new Error(`[NEBULAR_CONSUMER_FAIL] ${message}`); };

function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function requireRecord(value, label) { if (!isRecord(value)) fail(`${label} must be an object`); return value; }
function requireString(value, label, pattern = null) {
  if (typeof value !== "string" || value.length === 0 || (pattern && !pattern.test(value))) fail(`${label} is invalid`);
  return value;
}
function requireDigest(value, label) { return requireString(value, label, SHA256); }
function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${label} is invalid`);
  return value;
}
function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  fail("unsupported canonical JSON value");
}
function digestBytes(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function digestJson(value) { return digestBytes(Buffer.from(canonicalJson(value), "utf8")); }

function walkPublicValues(value, path = "$") {
  if (Array.isArray(value)) { value.forEach((item, index) => walkPublicValues(item, `${path}[${index}]`)); return; }
  if (!isRecord(value)) {
    if (typeof value === "string") {
      if (PRIVATE_VALUE.test(value)) fail(`private path-like value at ${path}`);
      if (SYNTHETIC_VALUE.test(value)) fail(`synthetic or fixture marker value at ${path}`);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (PRIVATE_KEY.test(key)) fail(`private/SDK/helper field '${key}' at ${path}`);
    if (SYNTHETIC_KEY.test(key) && child === true) fail(`synthetic or fixture flag '${key}' is not admissible at ${path}`);
    walkPublicValues(child, `${path}.${key}`);
  }
}

function expectedAssetUrl(assetId) { return `https://api.github.com/repos/${REPOSITORY}/releases/assets/${assetId}`; }
function sriForSha256(sha256) { return `sha256-${Buffer.from(sha256, "hex").toString("base64")}`; }

export function validateCorrespondingSourceOffer(offer, commit, tree) {
  requireRecord(offer, "source.correspondingSourceOffer");
  if (offer.schema !== CORRESPONDING_SOURCE_OFFER_SCHEMA || offer.status !== "pass" || offer.repository !== REPOSITORY) {
    fail("corresponding-source offer readback schema, status, or repository is invalid");
  }
  if (offer.commit !== commit || offer.tree !== tree) {
    fail("corresponding-source offer readback commit/tree mismatch");
  }
  const sourceArchiveSha256 = requireDigest(offer.sourceArchiveSha256, "source.correspondingSourceOffer.sourceArchiveSha256");
  const sourceArchiveBytes = requirePositiveInteger(offer.sourceArchiveBytes, "source.correspondingSourceOffer.sourceArchiveBytes");
  if (sourceArchiveBytes > MAX_ARCHIVE_BYTES) fail("corresponding-source offer archive exceeds bounded size");
  const authoritySha256 = requireDigest(offer.authoritySha256, "source.correspondingSourceOffer.authoritySha256");
  const publicBuildSourceIdentity = requireDigest(offer.publicBuildSourceIdentity, "source.correspondingSourceOffer.publicBuildSourceIdentity");
  const expectedManifestSha256 = requireDigest(offer.manifestSha256, "source.correspondingSourceOffer.manifestSha256");
  const normalizedOffer = {
    schema: CORRESPONDING_SOURCE_OFFER_SCHEMA,
    status: "pass",
    repository: REPOSITORY,
    commit,
    tree,
    sourceArchiveSha256,
    sourceArchiveBytes,
    authoritySha256,
    publicBuildSourceIdentity,
  };
  const offerSha256 = digestJson(normalizedOffer);
  if (expectedManifestSha256 !== offerSha256) {
    fail("corresponding-source offer manifest digest mismatch");
  }
  return {
    offer: Object.freeze({
      ...normalizedOffer,
      manifestSha256: offerSha256,
    }),
    offerSha256,
  };
}

function validateReadbackRow(row, label, maxBytes) {
  requireRecord(row, label);
  const bytes = requirePositiveInteger(row.bytes, `${label}.bytes`);
  if (bytes > maxBytes) fail(`${label}.bytes exceeds its bounded size`);
  const sha256 = requireDigest(row.sha256, `${label}.sha256`);
  return Object.freeze({ bytes, sha256 });
}

function validateTrustedSourceReadback(readback, offer) {
  requireRecord(readback, "source.trustedReadback");
  if (readback.schema !== SOURCE_READBACK_SCHEMA || readback.status !== "pass") {
    fail("source trusted readback schema or status is invalid");
  }
  const sourceArchive = validateReadbackRow(readback.sourceArchive, "source.trustedReadback.sourceArchive", MAX_ARCHIVE_BYTES);
  if (sourceArchive.bytes !== offer.sourceArchiveBytes || sourceArchive.sha256 !== offer.sourceArchiveSha256) {
    fail("source trusted archive readback does not bind the corresponding-source offer");
  }
  const darwinQualificationReceipt = validateReadbackRow(
    readback.darwinQualificationReceipt,
    "source.trustedReadback.darwinQualificationReceipt",
    MAX_READBACK_RECEIPT_BYTES,
  );
  const canonicalSha256 = requireDigest(
    readback.darwinQualificationReceipt.canonicalSha256,
    "source.trustedReadback.darwinQualificationReceipt.canonicalSha256",
  );
  return Object.freeze({
    schema: SOURCE_READBACK_SCHEMA,
    status: "pass",
    sourceArchive,
    darwinQualificationReceipt: Object.freeze({ ...darwinQualificationReceipt, canonicalSha256 }),
  });
}

function validateSource(source) {
  requireRecord(source, "source");
  if (source.contract !== SOURCE_CONTRACT || source.status !== "accepted") fail("source-first admission is not accepted");
  if (source.repository !== REPOSITORY) fail("source repository mismatch");
  const commit = requireString(source.commit, "source.commit", COMMIT);
  const tree = requireString(source.tree, "source.tree", COMMIT);
  if (DARWIN_RETAINED_COMMIT_PREFIX.test(commit)) {
    fail("public projection source.commit must not be restamped to retained Darwin b954 commit");
  }
  const readback = requireRecord(source.readback, "source.readback");
  if (readback.status !== "pass" || readback.repository !== REPOSITORY || readback.commit !== commit || readback.tree !== tree) {
    fail("source readback identity mismatch");
  }
  const payload = requireRecord(readback.payload, "source.readback.payload");
  if (payload.schema !== SOURCE_PAYLOAD_SCHEMA || payload.status !== "resolved" || payload.kind !== "git-tree-inventory-v1" || payload.tree !== tree) {
    fail("source payload receipt is not a resolved public Git tree inventory");
  }
  if (!Number.isSafeInteger(payload.fileCount) || payload.fileCount < 1 || !Number.isSafeInteger(payload.totalBytes) || payload.totalBytes < 1) {
    fail("source payload receipt counts are invalid");
  }
  requireDigest(payload.inventorySha256, "source.readback.payload.inventorySha256");
  const normalizedPayload = Object.freeze({
    schema: SOURCE_PAYLOAD_SCHEMA,
    status: "resolved",
    kind: "git-tree-inventory-v1",
    tree,
    fileCount: payload.fileCount,
    totalBytes: payload.totalBytes,
    inventorySha256: payload.inventorySha256,
  });
  const expectedManifestSha256 = digestJson(normalizedPayload);
  if (readback.manifestSha256 !== expectedManifestSha256) fail("source payload manifest digest mismatch");
  const { offer: correspondingSourceOffer, offerSha256: correspondingSourceOfferSha256 } = validateCorrespondingSourceOffer(
    source.correspondingSourceOffer,
    commit,
    tree,
  );
  const trustedReadback = validateTrustedSourceReadback(source.trustedReadback, correspondingSourceOffer);
  return Object.freeze({
    contract: SOURCE_CONTRACT,
    status: "accepted",
    repository: REPOSITORY,
    commit,
    tree,
    readback: Object.freeze({
      status: "pass",
      repository: REPOSITORY,
      commit,
      tree,
      payload: normalizedPayload,
      manifestSha256: expectedManifestSha256,
    }),
    payload: normalizedPayload,
    manifestSha256: expectedManifestSha256,
    correspondingSourceOffer,
    correspondingSourceOfferSha256,
    trustedReadback,
  });
}

function validateTargetSources(rawTargetSources, source = null) {
  const targetSources = requireRecord(rawTargetSources, "targetSources");
  const normalized = {};
  for (const [platform, contract] of Object.entries(PLATFORMS)) {
    const row = requireRecord(targetSources[platform], `targetSources.${platform}`);
    const allowedAuthorities = contract.authorities ?? [contract.authority];
    if (typeof row.authority !== "string" || !allowedAuthorities.includes(row.authority)) {
      fail(
        allowedAuthorities.length === 1
          ? `targetSources.${platform}.authority must be ${contract.authority}`
          : `targetSources.${platform}.authority must be one of ${allowedAuthorities.join(", ")}`,
      );
    }
    const authority = row.authority;
    const sourceCommit = requireString(row.sourceCommit, `targetSources.${platform}.sourceCommit`, COMMIT);
    const sourceTree = requireString(row.sourceTree, `targetSources.${platform}.sourceTree`, COMMIT);
    const sourceCandidate = requireDigest(row.sourceCandidate, `targetSources.${platform}.sourceCandidate`);
    const nativePayloadSha256 = requireDigest(row.nativePayloadSha256, `targetSources.${platform}.nativePayloadSha256`);
    const executableSha256 = requireDigest(row.executableSha256, `targetSources.${platform}.executableSha256`);
    const packageManifestSha256 = row.packageManifestSha256 !== undefined
      ? requireDigest(row.packageManifestSha256, `targetSources.${platform}.packageManifestSha256`)
      : null;
    if (platform === "darwin-arm64") {
      if (authority === "retained-darwin-b954") {
        if (!DARWIN_RETAINED_COMMIT_PREFIX.test(sourceCommit)) {
          fail("darwin-arm64 compiler sourceCommit must preserve retained b954 lineage (restamping refused)");
        }
      } else if (DARWIN_RETAINED_COMMIT_PREFIX.test(sourceCommit)) {
        fail("darwin-arm64 current-darwin-source compiler sourceCommit must not use retained Darwin b954 lineage");
      }
    } else if (DARWIN_RETAINED_COMMIT_PREFIX.test(sourceCommit)) {
      fail(`${platform} compiler sourceCommit must use current Linux source authority, not retained Darwin b954`);
    }
    if (source && (sourceCommit === source.commit || sourceTree === source.tree)) {
      fail(`${platform} compiler sourceCommit/sourceTree must remain distinct from public projection source (restamping refused)`);
    }
    normalized[platform] = Object.freeze({
      platform,
      authority,
      sourceCommit,
      sourceTree,
      sourceCandidate,
      nativePayloadSha256,
      executableSha256,
      ...(packageManifestSha256 ? { packageManifestSha256 } : {}),
    });
  }
  const darwin = normalized["darwin-arm64"];
  const linuxArm = normalized["linux-arm64"];
  const linuxX64 = normalized["linux-x64"];
  if (
    linuxArm.sourceCommit !== linuxX64.sourceCommit ||
    linuxArm.sourceTree !== linuxX64.sourceTree ||
    linuxArm.sourceCandidate !== linuxX64.sourceCandidate
  ) {
    fail("linux-arm64 and linux-x64 must bind the same current Linux compiler sourceCommit, sourceTree, and sourceCandidate");
  }
  if (
    darwin.authority === "retained-darwin-b954" &&
    (darwin.sourceCommit === linuxArm.sourceCommit ||
      darwin.sourceTree === linuxArm.sourceTree ||
      darwin.sourceCandidate === linuxArm.sourceCandidate)
  ) {
    fail("retained darwin-arm64 sourceTree/sourceCandidate must remain distinct from current Linux source authority");
  }
  return Object.freeze(normalized);
}

function normalizeSourceReadbackBindings(rawBindings, label) {
  const bindings = requireRecord(rawBindings, label);
  const platforms = Object.keys(SOURCE_READBACK_PLATFORM_ROLES);
  if (
    Object.keys(bindings).length !== platforms.length ||
    platforms.some((platform) => !Object.hasOwn(bindings, platform))
  ) {
    fail(`${label} must contain exactly one binding for each target platform`);
  }
  const normalized = {};
  for (const platform of platforms) {
    const row = requireRecord(bindings[platform], `${label}.${platform}`);
    const role = requireString(row.role, `${label}.${platform}.role`);
    if (role !== SOURCE_READBACK_PLATFORM_ROLES[platform]) {
      fail(`${label}.${platform}.role does not match its target platform`);
    }
    const sourceCandidate = requireDigest(row.sourceCandidate, `${label}.${platform}.sourceCandidate`);
    const readback = validateReadbackRow(row, `${label}.${platform}`, MAX_ARCHIVE_BYTES);
    normalized[platform] = Object.freeze({ platform, role, sourceCandidate, ...readback });
  }
  for (const role of new Set(Object.values(SOURCE_READBACK_PLATFORM_ROLES))) {
    const rows = Object.values(normalized).filter((row) => row.role === role);
    if (rows.length < 1) fail(`${label} is missing the ${role} binding`);
    const first = rows[0];
    if (rows.some((row) => row.sourceCandidate !== first.sourceCandidate || row.bytes !== first.bytes || row.sha256 !== first.sha256)) {
      fail(`${label} must bind one immutable source identity per asset role`);
    }
  }
  return Object.freeze(normalized);
}

function validateTargetSourceReadbacks(rawBindings, targetSources) {
  const normalized = normalizeSourceReadbackBindings(rawBindings, "source.targetSourceReadbacks");
  for (const [platform, row] of Object.entries(normalized)) {
    if (row.sourceCandidate !== targetSources[platform].sourceCandidate) {
      fail(`source.targetSourceReadbacks.${platform}.sourceCandidate does not bind targetSources.${platform}`);
    }
  }
  return normalized;
}

function assertSourceReadbackBindings(actual, expected, label) {
  const normalized = normalizeSourceReadbackBindings(actual, label);
  const expectedRows = normalizeSourceReadbackBindings(expected, `${label}.expected`);
  for (const platform of Object.keys(SOURCE_READBACK_PLATFORM_ROLES)) {
    const row = normalized[platform];
    const expectedRow = expectedRows[platform];
    if (
      row.role !== expectedRow.role ||
      row.sourceCandidate !== expectedRow.sourceCandidate ||
      row.bytes !== expectedRow.bytes ||
      row.sha256 !== expectedRow.sha256
    ) {
      fail(`${label}.${platform} does not match the authenticated target source binding`);
    }
  }
  return normalized;
}

function validateRelease(release) {
  requireRecord(release, "release");
  if (release.repository !== REPOSITORY) fail("release repository mismatch");
  requirePositiveInteger(release.releaseId, "release.releaseId");
  requireString(release.tag, "release.tag", /^v\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?$/u);
  if (release.version !== VERSION) fail(`release.version must be ${VERSION}`);
  return Object.freeze({
    repository: REPOSITORY,
    releaseId: release.releaseId,
    tag: release.tag,
    version: release.version,
  });
}

function validateAsset(asset, targetSources, release) {
  requireRecord(asset, "release asset");
  if (!Object.hasOwn(PLATFORMS, asset.platform)) fail(`unsupported asset platform ${asset.platform}`);
  if (!Object.hasOwn({ "raw-archive": true, "npm-package": true }, asset.kind)) fail("asset kind is invalid");
  requirePositiveInteger(asset.assetId, "asset.assetId");
  if (asset.releaseId !== release.releaseId || asset.tag !== release.tag) fail("asset release identity mismatch");
  const name = requireString(asset.name, "asset.name");
  if (basename(name) !== name || name.includes("\\") || name.includes("\0")) fail("asset.name must be a basename");
  if (asset.kind === "raw-archive" && !name.endsWith(".tar.gz")) fail("raw asset must be a .tar.gz");
  if (asset.kind === "npm-package" && !name.endsWith(".tgz")) fail("npm asset must be a .tgz");
  const bytes = requirePositiveInteger(asset.bytes, "asset.bytes");
  if (bytes > MAX_ARCHIVE_BYTES) fail("asset exceeds the bounded archive size");
  const sha256 = requireDigest(asset.sha256, "asset.sha256");
  if (asset.integrity !== sriForSha256(sha256) || asset.apiUrl !== expectedAssetUrl(asset.assetId)) fail(`asset integrity/URL mismatch for ${name}`);
  const targetSource = targetSources[asset.platform];
  if (
    asset.product !== PRODUCT ||
    asset.sourceCommit !== targetSource.sourceCommit ||
    asset.sourceTree !== targetSource.sourceTree ||
    asset.sourceCandidate !== targetSource.sourceCandidate
  ) {
    fail(`asset compiler source/sourceCandidate/product binding mismatch for ${name}`);
  }
  return Object.freeze({
    product: PRODUCT,
    platform: asset.platform,
    kind: asset.kind,
    assetId: asset.assetId,
    releaseId: asset.releaseId,
    tag: asset.tag,
    name,
    bytes,
    sha256,
    integrity: asset.integrity,
    apiUrl: asset.apiUrl,
    sourceCommit: asset.sourceCommit,
    sourceTree: asset.sourceTree,
    sourceCandidate: asset.sourceCandidate,
  });
}

function parseGlibcTuple(version) {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?$/u.exec(String(version ?? "").trim());
  if (!match) fail("glibcMinimum must be a numeric major.minor[.patch] version");
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

function compareGlibcTuple(a, b) {
  return (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);
}

function validatePayloadInventorySummary(value, label, expectedIdentity, expectedLabel = expectedIdentity) {
  if (!isRecord(value)) {
    fail(`${label} must be a non-null object; nativePayload.identity does not match ${expectedLabel}`);
  }
  const keys = Object.keys(value);
  if (keys.length !== 2 || keys.some((key) => key !== "identity" && key !== "files")) {
    fail(`${label} contains unknown or missing keys`);
  }
  if (typeof value.identity !== "string" || !SHA256.test(value.identity) || value.identity !== expectedIdentity) {
    fail(`${label} nativePayload.identity does not match ${expectedLabel}`);
  }
  if (!Number.isSafeInteger(value.files) || value.files < 1) {
    fail(`${label} nativePayload.files must be a positive integer`);
  }
  return Object.freeze({
    identity: value.identity,
    files: value.files,
  });
}

export function validateQualificationReceipt(qualification, platform, targetSource) {
  requireRecord(qualification, "qualification.json");
  if (!Object.hasOwn(PLATFORMS, platform)) {
    fail(`unsupported qualification platform ${platform}`);
  }
  requireRecord(targetSource, `targetSources.${platform}`);
  if (
    qualification.schema !== QUALIFICATION_RECEIPT_SCHEMA ||
    qualification.platform !== platform ||
    qualification.status !== "pass" ||
    (qualification.version !== undefined && qualification.version !== VERSION) ||
    qualification.executableSha256 !== targetSource.executableSha256
  ) {
    fail(`qualification receipt failed schema, status, or executableSha256 check for ${platform}`);
  }
  if (!Object.hasOwn(qualification, "nativePayload") || qualification.nativePayload === undefined) {
    fail(`qualification receipt nativePayload is missing for ${platform}; nativePayload.identity does not match targetSources.${platform}.nativePayloadSha256`);
  }
  if (platform === "darwin-arm64") {
    if (!Object.hasOwn(qualification, "glibcMinimum") || qualification.glibcMinimum !== null) {
      fail("qualification receipt glibcMinimum must be null for darwin-arm64");
    }
    if (!Object.hasOwn(qualification, "materialDigest") || qualification.materialDigest !== null) {
      fail("qualification receipt materialDigest must be null for darwin-arm64");
    }
    if (qualification.nativePayload !== null) {
      validatePayloadInventorySummary(
        qualification.nativePayload,
        `qualification receipt for ${platform}`,
        targetSource.nativePayloadSha256,
        `targetSources.${platform}.nativePayloadSha256`,
      );
    }
  } else {
    validatePayloadInventorySummary(
      qualification.nativePayload,
      `qualification receipt for ${platform}`,
      targetSource.nativePayloadSha256,
      `targetSources.${platform}.nativePayloadSha256`,
    );
  }
  if (
    !Array.isArray(qualification.checks) ||
    qualification.checks.length === 0 ||
    !qualification.checks.every((entry) => isRecord(entry) && entry.ok === true && typeof entry.id === "string" && entry.id.length > 0)
  ) {
    fail(`qualification receipt checks are incomplete or failing for ${platform}`);
  }
  const requiredChecks = [
    "executable-header",
    "launcher",
    "sidecar-runtime",
    ...Object.keys(RESOURCE_PREPARERS).map((dir) => `resource:${dir}`),
    ...(platform === "darwin-arm64"
      ? ["legal-notices", "codesign"]
      : ["mode:gui", "mode:sidecar", "mode:launcher", "glibc:gui", "glibc:sidecar", "glibc-floor", "linkage"]),
  ];
  const allowedChecks = new Set([
    ...requiredChecks,
    ...(platform.startsWith("linux") ? ["private-runtime-closure"] : []),
  ]);
  const passedIds = new Set();
  for (const entry of qualification.checks) {
    const id = String(entry.id);
    if (!allowedChecks.has(id) || passedIds.has(id)) {
      fail(`qualification receipt for ${platform} contains unknown or duplicate check '${id}'`);
    }
    if (id === "executable-header" && entry.detail !== targetSource.executableSha256) {
      fail(`qualification receipt executable-header check detail does not match targetSources.${platform}.executableSha256`);
    }
    passedIds.add(id);
  }
  for (const requiredId of requiredChecks) {
    if (!passedIds.has(requiredId)) {
      fail(`qualification receipt for ${platform} is missing required passing check '${requiredId}'`);
    }
  }
  if (platform.startsWith("linux")) {
    const glibcTuple = parseGlibcTuple(qualification.glibcMinimum);
    if (compareGlibcTuple(glibcTuple, [2, 36, 0]) > 0) {
      fail(`qualification receipt glibcMinimum ${qualification.glibcMinimum} exceeds floor 2.36 for ${platform}`);
    }
  }
  return qualification;
}

function validateDarwinQualification(row, darwinTargetSource, source, assets) {
  requireRecord(row, "darwin-arm64 qualification");
  if (row.mode !== "existing-qualified" || row.status !== "pass") {
    fail("Darwin qualification must be existing-qualified and passing");
  }
  if (darwinTargetSource.authority === "retained-darwin-b954") {
    if (row.authority !== undefined && row.authority !== darwinTargetSource.authority) {
      fail("Darwin qualification authority must match targetSources.darwin-arm64.authority");
    }
  } else if (row.authority !== darwinTargetSource.authority) {
    fail("Darwin qualification authority must match targetSources.darwin-arm64.authority");
  }
  if (darwinTargetSource.authority === "retained-darwin-b954") {
    if (
      !DARWIN_RETAINED_COMMIT_PREFIX.test(String(row.sourceCommit ?? "")) ||
      row.sourceCommit !== darwinTargetSource.sourceCommit ||
      row.sourceTree !== darwinTargetSource.sourceTree ||
      row.sourceCandidate !== darwinTargetSource.sourceCandidate
    ) {
      fail("Darwin qualification must preserve retained b954 sourceCommit/sourceTree/sourceCandidate and never be restamped");
    }
  } else {
    const rowCommit = requireString(row.sourceCommit, "darwin-arm64.qualification.sourceCommit", COMMIT);
    const rowTree = requireString(row.sourceTree, "darwin-arm64.qualification.sourceTree", COMMIT);
    const rowCandidate = requireDigest(row.sourceCandidate, "darwin-arm64.qualification.sourceCandidate");
    if (DARWIN_RETAINED_COMMIT_PREFIX.test(rowCommit)) {
      fail("Darwin qualification for current-darwin-source must not use retained b954 sourceCommit");
    }
    if (
      rowCommit !== darwinTargetSource.sourceCommit ||
      rowTree !== darwinTargetSource.sourceTree ||
      rowCandidate !== darwinTargetSource.sourceCandidate
    ) {
      fail("Darwin qualification sourceCommit/sourceTree/sourceCandidate must match targetSources.darwin-arm64");
    }
  }
  if (row.sourceCommit === source.commit || row.sourceTree === source.tree) {
    fail("Darwin qualification must not be restamped to public projection source.commit");
  }
  const receiptSha256 = requireDigest(row.receiptSha256, "darwin-arm64.qualification.receiptSha256");
  const executableSha256 = requireDigest(row.executableSha256, "darwin-arm64.qualification.executableSha256");
  const nativePayloadSha256 = requireDigest(row.nativePayloadSha256, "darwin-arm64.qualification.nativePayloadSha256");
  if (executableSha256 !== darwinTargetSource.executableSha256 || nativePayloadSha256 !== darwinTargetSource.nativePayloadSha256) {
    fail("Darwin qualification executableSha256/nativePayloadSha256 must match darwin-arm64 targetSources");
  }
  const verifiedReceipt = validateQualificationReceipt(row.receipt, "darwin-arm64", darwinTargetSource);
  const actualReceiptSha256 = digestJson(verifiedReceipt);
  if (actualReceiptSha256 !== receiptSha256) {
    fail("Darwin qualification receiptSha256 does not match the canonical SHA-256 of qualifications.darwin-arm64.receipt");
  }
  const raw = assets.find((asset) => asset.platform === "darwin-arm64" && asset.kind === "raw-archive");
  const npm = assets.find((asset) => asset.platform === "darwin-arm64" && asset.kind === "npm-package");
  if (row.rawSha256 !== raw.sha256 || row.npmSha256 !== npm.sha256) fail("Darwin qualification does not bind both product assets");
  return Object.freeze({
    mode: row.mode,
    status: row.status,
    authority: darwinTargetSource.authority,
    sourceCommit: row.sourceCommit,
    sourceTree: row.sourceTree,
    sourceCandidate: row.sourceCandidate,
    receiptSha256,
    receipt: verifiedReceipt,
    executableSha256,
    nativePayloadSha256,
    rawSha256: row.rawSha256,
    npmSha256: row.npmSha256,
  });
}

/** Validate descriptors only. `admit-source` additionally resolves them against the checked-out tree. */
export function validateInput(input) {
  requireRecord(input, "input");
  walkPublicValues(input);
  if (input.schema !== INPUT_SCHEMA || input.product !== PRODUCT || input.version !== VERSION) fail("input schema/product/version mismatch");
  const source = validateSource(input.source);
  const targetSources = validateTargetSources(input.targetSources ?? input.source?.targetSources, source);
  const targetSourceReadbacks = validateTargetSourceReadbacks(input.source.targetSourceReadbacks, targetSources);
  const release = validateRelease(input.release);
  if (!Array.isArray(input.assets)) fail("assets must be an array");
  const assets = input.assets.map((asset) => validateAsset(asset, targetSources, release));
  const expected = Object.keys(PLATFORMS).flatMap((platform) => ["raw-archive", "npm-package"].map((kind) => `${platform}\0${kind}`)).sort();
  const actual = assets.map((asset) => `${asset.platform}\0${asset.kind}`).sort();
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) fail("exactly one raw archive and one npm package are required per platform");
  if (new Set(assets.map((asset) => asset.assetId)).size !== assets.length || new Set(assets.map((asset) => asset.name)).size !== assets.length) fail("asset IDs and names must be unique");
  const rawQualifications = requireRecord(input.qualifications ?? {}, "qualifications");
  const darwinQualification = validateDarwinQualification(rawQualifications["darwin-arm64"], targetSources["darwin-arm64"], source, assets);
  if (source.trustedReadback.darwinQualificationReceipt.canonicalSha256 !== darwinQualification.receiptSha256) {
    fail("source trusted Darwin receipt readback does not bind the existing-qualified receiptSha256");
  }
  const qualifications = { "darwin-arm64": darwinQualification };
  for (const platform of ["linux-arm64", "linux-x64"]) {
    const row = rawQualifications[platform];
    if (row !== undefined && row !== null && (!isRecord(row) || row.mode !== "hosted")) fail(`${platform} qualification must be hosted or omitted`);
    if (row) qualifications[platform] = { mode: "hosted" };
  }
  return Object.freeze({
    schema: input.schema,
    product: input.product,
    version: input.version,
    source: Object.freeze({ ...source, targetSourceReadbacks }),
    targetSources,
    release,
    assets,
    qualifications: Object.freeze(qualifications),
  });
}

/** Parse `git ls-tree -r -l -z` output without reading source bodies. */
export function sourceInventoryFromGitListing(bytes) {
  const records = [];
  const paths = new Set();
  let totalBytes = 0;
  for (const raw of Buffer.from(bytes).toString("utf8").split("\0")) {
    if (!raw) continue;
    const match = /^(\d{6})\s+blob\s+([0-9a-f]{40})\s+(\d+)\t(.+)$/u.exec(raw);
    if (!match) fail("source Git tree listing contains an unsupported entry");
    const size = Number(match[3]);
    const path = match[4];
    if (!Number.isSafeInteger(size) || size < 0 || !path || path.startsWith("/") || path.includes("\\") || path.split("/").includes("..")) fail("source Git tree listing contains an unsafe path or size");
    if (paths.has(path)) fail("source Git tree listing contains duplicate path");
    paths.add(path);
    totalBytes += size;
    if (!Number.isSafeInteger(totalBytes)) fail("source Git tree byte total overflow");
    records.push(`${match[1]} ${match[2]} ${size} ${path}`);
    if (records.length > 20000) fail("source Git tree member limit exceeded");
  }
  if (records.length === 0) fail("source Git tree is empty");
  records.sort();
  return {
    schema: SOURCE_PAYLOAD_SCHEMA,
    status: "resolved",
    kind: "git-tree-inventory-v1",
    tree: null,
    fileCount: records.length,
    totalBytes,
    inventorySha256: digestBytes(Buffer.from(`${records.join("\n")}\n`)),
    paths,
  };
}

function gitText(checkout, args) {
  try { return execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8", maxBuffer: MAX_SOURCE_LISTING_BYTES }).trim(); }
  catch { fail("public source Git identity could not be resolved"); }
}

function assertDescriptorNotSelfInventoried(checkout, inputPath, trackedPaths) {
  if (!inputPath) return;
  let resolvedCheckout;
  let resolvedInput;
  try {
    resolvedCheckout = realpathSync(resolve(checkout));
    resolvedInput = realpathSync(resolve(inputPath));
  } catch {
    resolvedCheckout = resolve(checkout);
    resolvedInput = resolve(inputPath);
  }
  const rel = relative(resolvedCheckout, resolvedInput).split(sep).join("/");
  if (rel && !rel.startsWith("..") && !rel.startsWith("/")) {
    if (trackedPaths.has(rel)) {
      fail("consumer input descriptor must be late-bound outside the admitted public source tree (self-inventory hash cycle refused)");
    }
    fail("consumer input descriptor must reside outside the checked-out public source tree");
  }
}

function assertReadbackOutsideCheckout(checkout, readbackPath, label) {
  let resolvedCheckout;
  let resolvedReadback;
  try {
    resolvedCheckout = realpathSync(resolve(checkout));
    resolvedReadback = realpathSync(resolve(readbackPath));
  } catch {
    fail(`${label} could not be resolved outside the checked-out public source`);
  }
  const rel = relative(resolvedCheckout, resolvedReadback).split(sep).join("/");
  if (!rel || (!rel.startsWith("..") && !rel.startsWith("/"))) {
    fail(`${label} must be an external late-bound readback, not a public source path`);
  }
}

function readBoundedRegularSnapshot(readbackPath, label, maxBytes) {
  let snapshot;
  try {
    snapshot = readRegularSnapshot(readbackPath, { label, maxBytes, bindPath: true });
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    const message = error instanceof Error ? error.message : String(error);
    if (code === "ENOENT") fail(`${label} does not exist`);
    if (/(?:changed while it was read|was (?:removed|replaced|truncated) while it was read|grew while it was read)/u.test(message)) {
      fail(`${label} changed while it was read`);
    }
    fail(`${label} is not a bounded regular file`);
  }
  if (!snapshot || snapshot.bytes.length < 1 || snapshot.bytes.length > maxBytes) {
    fail(`${label} is not a bounded regular file`);
  }
  if ((snapshot.mode & 0o7000) !== 0) fail(`${label} has unexpected privilege bits`);
  let terminal;
  try {
    terminal = lstatSync(readbackPath);
  } catch {
    fail(`${label} changed while it was read`);
  }
  if (!terminal.isFile() || terminal.isSymbolicLink() || !sameIdentity(descriptorIdentity(terminal), snapshot.identity)) {
    fail(`${label} changed while it was read`);
  }
  return snapshot;
}

function readTrustedRegularFile(readbackPath, label, maxBytes) {
  if (typeof readbackPath !== "string" || readbackPath.length === 0) fail(`${label} path is required`);
  const snapshot = readBoundedRegularSnapshot(readbackPath, label, maxBytes);
  return { bytes: snapshot.bytes, readback: { bytes: snapshot.bytes.length, sha256: digestBytes(snapshot.bytes) } };
}

function verifyTrustedReadbackFiles(normalized, checkout, options) {
  const archivePath = options?.sourceArchivePath;
  const darwinSourcePath = options?.darwinSourceArchivePath;
  const linuxSourcePath = options?.linuxSourceArchivePath;
  const receiptPath = options?.darwinReceiptPath;
  if (
    typeof archivePath !== "string" ||
    typeof darwinSourcePath !== "string" ||
    typeof linuxSourcePath !== "string" ||
    typeof receiptPath !== "string"
  ) {
    fail("source admission requires separately materialized corresponding-source, Darwin-source, Linux-source, and Darwin qualification readbacks");
  }
  assertReadbackOutsideCheckout(checkout, archivePath, "source archive readback");
  assertReadbackOutsideCheckout(checkout, darwinSourcePath, "Darwin app source readback");
  assertReadbackOutsideCheckout(checkout, linuxSourcePath, "Linux app source readback");
  assertReadbackOutsideCheckout(checkout, receiptPath, "Darwin qualification readback");
  const archive = readTrustedRegularFile(archivePath, "source archive readback", MAX_ARCHIVE_BYTES);
  const expectedArchive = normalized.source.trustedReadback.sourceArchive;
  if (archive.readback.bytes !== expectedArchive.bytes || archive.readback.sha256 !== expectedArchive.sha256) {
    fail("source archive readback bytes or SHA-256 do not match the trusted corresponding-source offer");
  }
  const darwinSource = readTrustedRegularFile(darwinSourcePath, "Darwin app source readback", MAX_ARCHIVE_BYTES);
  const expectedDarwinSource = normalized.source.targetSourceReadbacks["darwin-arm64"];
  if (darwinSource.readback.bytes !== expectedDarwinSource.bytes || darwinSource.readback.sha256 !== expectedDarwinSource.sha256) {
    fail("Darwin app source readback bytes or SHA-256 do not match the authenticated target source binding");
  }
  const linuxSource = readTrustedRegularFile(linuxSourcePath, "Linux app source readback", MAX_ARCHIVE_BYTES);
  const expectedLinuxArmSource = normalized.source.targetSourceReadbacks["linux-arm64"];
  const expectedLinuxX64Source = normalized.source.targetSourceReadbacks["linux-x64"];
  if (
    linuxSource.readback.bytes !== expectedLinuxArmSource.bytes ||
    linuxSource.readback.sha256 !== expectedLinuxArmSource.sha256 ||
    linuxSource.readback.bytes !== expectedLinuxX64Source.bytes ||
    linuxSource.readback.sha256 !== expectedLinuxX64Source.sha256
  ) {
    fail("Linux app source readback bytes or SHA-256 do not match the authenticated target source binding");
  }
  const verifiedTargetSourceReadbacks = Object.freeze({
    "darwin-arm64": Object.freeze({
      platform: "darwin-arm64",
      role: "darwin-app-source",
      sourceCandidate: expectedDarwinSource.sourceCandidate,
      ...darwinSource.readback,
    }),
    "linux-arm64": Object.freeze({
      platform: "linux-arm64",
      role: "linux-app-source",
      sourceCandidate: expectedLinuxArmSource.sourceCandidate,
      ...linuxSource.readback,
    }),
    "linux-x64": Object.freeze({
      platform: "linux-x64",
      role: "linux-app-source",
      sourceCandidate: expectedLinuxX64Source.sourceCandidate,
      ...linuxSource.readback,
    }),
  });
  const receipt = readTrustedRegularFile(receiptPath, "Darwin qualification readback", MAX_READBACK_RECEIPT_BYTES);
  const expectedReceipt = normalized.source.trustedReadback.darwinQualificationReceipt;
  if (receipt.readback.bytes !== expectedReceipt.bytes || receipt.readback.sha256 !== expectedReceipt.sha256) {
    fail("Darwin qualification readback bytes or SHA-256 do not match the trusted source input");
  }
  let receiptObject;
  try { receiptObject = JSON.parse(receipt.bytes.toString("utf8")); } catch { fail("Darwin qualification readback is not valid JSON"); }
  const verifiedReceipt = validateQualificationReceipt(receiptObject, "darwin-arm64", normalized.targetSources["darwin-arm64"]);
  if (digestJson(verifiedReceipt) !== expectedReceipt.canonicalSha256) {
    fail("Darwin qualification readback canonical digest does not match the existing-qualified receipt");
  }
  return Object.freeze({
    schema: SOURCE_READBACK_SCHEMA,
    status: "pass",
    sourceArchive: Object.freeze({ ...archive.readback }),
    darwinAppSource: Object.freeze({
      role: "darwin-app-source",
      sourceCandidate: expectedDarwinSource.sourceCandidate,
      ...darwinSource.readback,
    }),
    linuxAppSource: Object.freeze({
      role: "linux-app-source",
      sourceCandidate: expectedLinuxArmSource.sourceCandidate,
      ...linuxSource.readback,
    }),
    targetSourceReadbacks: verifiedTargetSourceReadbacks,
    darwinQualificationReceipt: Object.freeze({ ...receipt.readback, canonicalSha256: digestJson(verifiedReceipt) }),
  });
}

export function resolveSourceAdmission(input, checkout, options = {}) {
  const normalized = validateInput(input);
  const commit = gitText(checkout, ["rev-parse", "HEAD"]);
  const tree = gitText(checkout, ["rev-parse", "HEAD^{tree}"]);
  if (commit !== normalized.source.commit || tree !== normalized.source.tree) fail("checked-out public source does not match the admitted commit/tree");
  let listing;
  try { listing = execFileSync("git", ["-C", checkout, "ls-tree", "-r", "-l", "-z", "--full-tree", "HEAD"], { maxBuffer: MAX_SOURCE_LISTING_BYTES }); }
  catch { fail("public source tree inventory could not be resolved"); }
  const parsedListing = sourceInventoryFromGitListing(listing);
  assertDescriptorNotSelfInventoried(checkout, options.inputPath, parsedListing.paths);
  const trustedReadback = verifyTrustedReadbackFiles(normalized, checkout, options);
  const payload = {
    schema: parsedListing.schema,
    status: parsedListing.status,
    kind: parsedListing.kind,
    tree,
    fileCount: parsedListing.fileCount,
    totalBytes: parsedListing.totalBytes,
    inventorySha256: parsedListing.inventorySha256,
  };
  const expected = normalized.source.payload;
  if (payload.fileCount !== expected.fileCount || payload.totalBytes !== expected.totalBytes || payload.inventorySha256 !== expected.inventorySha256) fail("public source payload inventory differs from the admitted receipt");
  const manifestSha256 = digestJson(payload);
  if (normalized.source.manifestSha256 !== manifestSha256) fail("public source payload manifest does not bind the resolved tree");
  return {
    schema: ADMISSION_SCHEMA,
    status: "pass",
    contract: SOURCE_CONTRACT,
    repository: REPOSITORY,
    commit,
    tree,
    payload,
    manifestSha256,
    correspondingSourceOffer: normalized.source.correspondingSourceOffer,
    correspondingSourceOfferSha256: normalized.source.correspondingSourceOfferSha256,
    targetSourceReadbacks: trustedReadback.targetSourceReadbacks,
    darwinQualificationReceiptSha256: normalized.qualifications["darwin-arm64"].receiptSha256,
    trustedReadback,
  };
}

export function verifyAdmissionReceipt(admission, normalizedInput, options = {}) {
  const normalized = normalizedInput.schema === INPUT_SCHEMA && Object.isFrozen(normalizedInput)
    ? normalizedInput
    : validateInput(normalizedInput);
  requireRecord(admission, "admission");
  if (
    admission.schema !== ADMISSION_SCHEMA ||
    admission.status !== "pass" ||
    admission.contract !== SOURCE_CONTRACT ||
    admission.repository !== REPOSITORY ||
    admission.commit !== normalized.source.commit ||
    admission.tree !== normalized.source.tree
  ) {
    fail("fetch requires the matching passing source admission");
  }
  if (
    !isRecord(admission.payload) ||
    admission.payload.inventorySha256 !== normalized.source.payload.inventorySha256 ||
    admission.manifestSha256 !== normalized.source.manifestSha256 ||
    digestJson(admission.payload) !== normalized.source.manifestSha256
  ) {
    fail("source admission payload readback is missing or does not match the admitted input");
  }
  const { offerSha256 } = validateCorrespondingSourceOffer(
    admission.correspondingSourceOffer,
    normalized.source.commit,
    normalized.source.tree,
  );
  if (
    offerSha256 !== normalized.source.correspondingSourceOfferSha256 ||
    admission.correspondingSourceOfferSha256 !== normalized.source.correspondingSourceOfferSha256
  ) {
    fail("source admission corresponding-source offer readback is missing or mismatched");
  }
  assertSourceReadbackBindings(
    admission.targetSourceReadbacks,
    normalized.source.targetSourceReadbacks,
    "source admission.targetSourceReadbacks",
  );
  if (admission.darwinQualificationReceiptSha256 !== normalized.qualifications["darwin-arm64"].receiptSha256) {
    fail("source admission Darwin existing-qualified receiptSha256 readback is missing or mismatched");
  }
  const trustedReadback = verifyTrustedReadbackFiles(normalized, options.checkout ?? ".", options);
  if (digestJson(trustedReadback) !== digestJson(admission.trustedReadback)) {
    fail("source admission trusted readback does not match the authenticated late-bound files");
  }
  return admission;
}

async function readJson(path, maxBytes = 8 * 1024 * 1024) {
  if (typeof path !== "string" || path.length === 0) fail("JSON path is required");
  const snapshot = readBoundedRegularSnapshot(path, "JSON input", maxBytes);
  try { return JSON.parse(snapshot.bytes.toString("utf8")); } catch { fail("JSON input is invalid"); }
}

async function writeNew(path, value) {
  await mkdir(dirname(path), { recursive: true });
  try { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }
  catch { fail("refusing to overwrite an output"); }
}

async function hashFile(path, maxBytes = MAX_ARCHIVE_BYTES) {
  const info = await stat(path);
  if (!info.isFile() || info.size < 1 || info.size > maxBytes) fail("archive is not a bounded regular file");
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    if (bytes > maxBytes) fail("archive exceeded the bounded byte limit");
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest("hex") };
}

export function validatePublicReleaseUrl(urlString, expectedInitialUrl = null) {
  let parsed;
  try { parsed = new URL(urlString); } catch { fail("public release URL is not a valid URL"); }
  if (parsed.protocol !== "https:") fail("public release URL must use https:");
  if (parsed.username || parsed.password) fail("public release URL must not contain credentials");
  if (!ALLOWED_RELEASE_HOSTS.has(parsed.hostname)) fail(`disallowed release host ${parsed.hostname}`);
  if (expectedInitialUrl !== null && parsed.toString() !== expectedInitialUrl) {
    fail("initial public release URL does not match the pinned GitHub release asset API URL");
  }
  return parsed.toString();
}

function locationHeader(headers) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get("location") ?? headers.get("Location");
  if (isRecord(headers)) return headers.location ?? headers.Location ?? null;
  return null;
}

async function writeResponse(response, destination, maxBytes) {
  if (!response || response.status !== 200 || !response.body || typeof response.body[Symbol.asyncIterator] !== "function") fail("public release GET did not return a bounded 200 body");
  await mkdir(dirname(destination), { recursive: true });
  const handle = await open(destination, "wx", 0o600);
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) fail("public release asset exceeded its declared bounded size");
      hash.update(buffer);
      await handle.write(buffer);
    }
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(destination, { force: true });
    throw error;
  }
  return { bytes, sha256: hash.digest("hex") };
}

export async function fetchReleaseAsset(asset, destination, fetchImpl = globalThis.fetch) {
  const initialUrl = expectedAssetUrl(asset.assetId);
  let currentUrl = validatePublicReleaseUrl(asset.apiUrl ?? initialUrl, initialUrl);
  let response = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    response = await fetchImpl(currentUrl, {
      method: "GET",
      redirect: "manual",
      headers: { accept: "application/octet-stream" },
    });
    if (!response || typeof response.status !== "number") fail("public release GET returned an invalid response");
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (hop === MAX_REDIRECTS) fail("public release GET exceeded maximum redirect hops");
      const location = locationHeader(response.headers);
      if (typeof location !== "string" || location.length === 0) fail("public release redirect is missing Location header");
      const resolvedNext = new URL(location, currentUrl).toString();
      currentUrl = validatePublicReleaseUrl(resolvedNext, null);
      continue;
    }
    break;
  }
  const readback = await writeResponse(response, destination, asset.bytes);
  if (
    readback.bytes !== asset.bytes ||
    readback.sha256 !== asset.sha256 ||
    sriForSha256(readback.sha256) !== asset.integrity
  ) {
    await rm(destination, { force: true });
    fail(`public asset ${asset.name} failed its exact byte/SHA-256/SRI readback`);
  }
  return { ...asset, readback };
}

function validateSourceReadbackFetchManifest(rawManifest, expectedSource) {
  requireRecord(rawManifest, "source readback fetch manifest");
  walkPublicValues(rawManifest);
  if (rawManifest.schema !== SOURCE_READBACK_FETCH_SCHEMA) {
    fail("source readback fetch manifest schema is invalid");
  }
  const rawAssets = requireRecord(rawManifest.sourceAssets, "source readback fetch manifest.sourceAssets");
  const roles = Object.keys(rawAssets).sort();
  if (roles.length !== SOURCE_READBACK_ASSET_ROLES.length || roles.some((role, index) => role !== [...SOURCE_READBACK_ASSET_ROLES].sort()[index])) {
    fail("source readback fetch manifest must contain exactly the three source asset roles");
  }
  const sourceAssets = {};
  for (const role of SOURCE_READBACK_ASSET_ROLES) {
    const row = requireRecord(rawAssets[role], `source readback fetch manifest.sourceAssets.${role}`);
    const url = validatePublicReleaseUrl(requireString(row.url, `source readback fetch manifest.sourceAssets.${role}.url`), null);
    const readback = validateReadbackRow(row, `source readback fetch manifest.sourceAssets.${role}`, MAX_ARCHIVE_BYTES);
    sourceAssets[role] = Object.freeze({ role, url, ...readback });
  }
  const expectedOffer = requireRecord(expectedSource?.correspondingSourceOffer, "source.correspondingSourceOffer");
  const correspondingSourceOffer = sourceAssets["corresponding-source-offer"];
  if (
    correspondingSourceOffer.bytes !== expectedOffer.sourceArchiveBytes ||
    correspondingSourceOffer.sha256 !== expectedOffer.sourceArchiveSha256
  ) {
    fail("source readback fetch manifest corresponding-source offer does not match the authenticated source descriptor");
  }
  const rawReceipt = requireRecord(rawManifest.darwinQualificationReceipt, "source readback fetch manifest.darwinQualificationReceipt");
  const receiptUrl = validatePublicReleaseUrl(
    requireString(rawReceipt.url, "source readback fetch manifest.darwinQualificationReceipt.url"),
    null,
  );
  const receipt = validateReadbackRow(
    rawReceipt,
    "source readback fetch manifest.darwinQualificationReceipt",
    MAX_READBACK_RECEIPT_BYTES,
  );
  const platformSourceRoles = requireRecord(rawManifest.platformSourceRoles, "source readback fetch manifest.platformSourceRoles");
  const platformKeys = Object.keys(SOURCE_READBACK_PLATFORM_ROLES);
  if (
    Object.keys(platformSourceRoles).length !== platformKeys.length ||
    platformKeys.some((platform) => platformSourceRoles[platform] !== SOURCE_READBACK_PLATFORM_ROLES[platform])
  ) {
    fail("source readback fetch manifest platform source associations are invalid");
  }
  const targetSourceReadbacks = assertSourceReadbackBindings(
    rawManifest.targetSourceReadbacks,
    expectedSource?.targetSourceReadbacks,
    "source readback fetch manifest.targetSourceReadbacks",
  );
  for (const role of ["darwin-app-source", "linux-app-source"]) {
    const targetRows = Object.values(targetSourceReadbacks).filter((row) => row.role === role);
    const asset = sourceAssets[role];
    const targetRow = targetRows[0];
    if (
      targetRows.length === 0 ||
      asset.bytes !== targetRow.bytes ||
      asset.sha256 !== targetRow.sha256
    ) {
      fail(`source readback fetch manifest.${role} does not match its authenticated target source binding`);
    }
  }
  return Object.freeze({
    schema: SOURCE_READBACK_FETCH_SCHEMA,
    sourceAssets: Object.freeze(sourceAssets),
    darwinQualificationReceipt: Object.freeze({ url: receiptUrl, ...receipt }),
    platformSourceRoles: Object.freeze({ ...SOURCE_READBACK_PLATFORM_ROLES }),
    targetSourceReadbacks,
  });
}

async function fetchBoundedReadback(row, destination, maxBytes, fetchImpl) {
  let currentUrl = row.url;
  let response = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    response = await fetchImpl(currentUrl, {
      method: "GET",
      redirect: "manual",
      headers: { accept: "application/octet-stream" },
    });
    if (!response || typeof response.status !== "number") fail("source readback GET returned an invalid response");
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (hop === MAX_REDIRECTS) fail("source readback GET exceeded maximum redirect hops");
      const location = locationHeader(response.headers);
      if (typeof location !== "string" || location.length === 0) fail("source readback redirect is missing Location header");
      currentUrl = validatePublicReleaseUrl(new URL(location, currentUrl).toString(), null);
      continue;
    }
    break;
  }
  const readback = await writeResponse(response, destination, maxBytes);
  if (readback.bytes !== row.bytes || readback.sha256 !== row.sha256) {
    await rm(destination, { force: true });
    fail("source readback failed its exact byte/SHA-256 check");
  }
  return readback;
}

export async function fetchSourceReadbacks(
  rawManifest,
  output,
  fetchImpl = globalThis.fetch,
  expectedSource,
) {
  const manifest = validateSourceReadbackFetchManifest(rawManifest, expectedSource);
  const outputRoot = resolve(output);
  const sourceAssets = {};
  for (const role of SOURCE_READBACK_ASSET_ROLES) {
    const row = manifest.sourceAssets[role];
    const relativePath = SOURCE_READBACK_ASSET_PATHS[role];
    const destination = join(outputRoot, relativePath);
    const readback = await fetchBoundedReadback(row, destination, MAX_ARCHIVE_BYTES, fetchImpl);
    const targetRow = role === "corresponding-source-offer"
      ? null
      : Object.values(manifest.targetSourceReadbacks).find((candidate) => candidate.role === role);
    if (targetRow && (readback.bytes !== targetRow.bytes || readback.sha256 !== targetRow.sha256)) {
      await rm(destination, { force: true });
      fail(`materialized ${role} readback does not match its authenticated target source binding`);
    }
    sourceAssets[role] = {
      role,
      ...(targetRow ? { sourceCandidate: targetRow.sourceCandidate } : {}),
      path: relativePath,
      bytes: readback.bytes,
      sha256: readback.sha256,
    };
  }
  const receiptRelativePath = "darwin-receipt/qualification.json";
  const receiptReadback = await fetchBoundedReadback(
    manifest.darwinQualificationReceipt,
    join(outputRoot, receiptRelativePath),
    MAX_READBACK_RECEIPT_BYTES,
    fetchImpl,
  );
  const result = {
    schema: SOURCE_READBACK_FETCH_SCHEMA,
    status: "pass",
    sourceAssets,
    platformSourceRoles: manifest.platformSourceRoles,
    targetSourceReadbacks: manifest.targetSourceReadbacks,
    correspondingSourceOffer: Object.freeze({
      bytes: manifest.sourceAssets["corresponding-source-offer"].bytes,
      sha256: manifest.sourceAssets["corresponding-source-offer"].sha256,
    }),
    darwinQualificationReceipt: {
      path: receiptRelativePath,
      bytes: receiptReadback.bytes,
      sha256: receiptReadback.sha256,
    },
  };
  await writeNew(join(outputRoot, "source-readback-manifest.json"), result);
  return result;
}

export function validateArchiveMemberNames(listing) {
  const names = String(listing).split(/\r?\n/u).map((name) => name.trim()).filter(Boolean);
  if (names.length === 0 || names.length > 20000) fail("archive member count is outside the bounded range");
  for (const name of names) {
    if (name.startsWith("/") || name.includes("\\") || name.includes("\0") || name.split("/").includes("..")) fail("archive contains an unsafe member path");
    if (name.length > 1024) fail("archive member path is too long");
  }
  return names;
}

export function validateArchiveVerboseListing(verboseListing) {
  const lines = String(verboseListing).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0 || lines.length > 20000) fail("archive verbose listing count is outside the bounded range");
  for (const line of lines) {
    const mode = line.split(/\s+/u)[0] ?? "";
    if (mode.length < 10) fail("archive verbose listing contains an unrecognizable mode column");
    const typeChar = mode[0];
    if (!["-", "d", "l"].includes(typeChar)) {
      fail(`archive contains a forbidden member type '${typeChar}' (hardlinks, devices, FIFOs, and sockets are refused)`);
    }
    if (/[sStT]/u.test(mode.slice(1))) {
      fail("archive contains a forbidden setuid/setgid/sticky mode");
    }
    if (typeChar === "l") {
      const arrowIndex = line.indexOf(" -> ");
      if (arrowIndex === -1) fail("archive symlink entry is missing link target");
      const target = line.slice(arrowIndex + 4).trim();
      const beforeArrow = line.slice(0, arrowIndex).trim();
      const timeMatch = /(?:\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?|[A-Z][a-z]{2}\s+\d+\s+(?:\d{4}|\d{2}:\d{2}))\s+(.+)$/u.exec(beforeArrow);
      const memberPath = timeMatch ? timeMatch[1].trim() : (beforeArrow.split(/\s+/u).at(-1) ?? "");
      if (!target || target.startsWith("/") || target.includes("\\") || target.includes("\0")) {
        fail("archive symlink target must be a safe relative path");
      }
      const normalizedMember = memberPath.replace(/^\.\//u, "");
      const resolved = posix.normalize(posix.join(posix.dirname(normalizedMember || "."), target));
      if (resolved === ".." || resolved.startsWith("../") || resolved.startsWith("/")) {
        fail("archive symlink escapes the extraction root");
      }
    }
  }
  return lines.length;
}

function extractArchive(archive, destination) {
  const listed = spawnSync("tar", ["-tzf", archive], { encoding: "utf8", maxBuffer: MAX_SOURCE_LISTING_BYTES });
  if (listed.error || listed.status !== 0) fail("candidate archive listing failed");
  validateArchiveMemberNames(listed.stdout);
  const verbose = spawnSync("tar", ["-tvf", archive], { encoding: "utf8", maxBuffer: MAX_SOURCE_LISTING_BYTES });
  if (verbose.error || verbose.status !== 0) fail("candidate archive verbose inspection failed");
  validateArchiveVerboseListing(verbose.stdout);
  mkdirSyncCompat(destination);
  const extracted = spawnSync("tar", ["-xzf", archive, "-C", destination, "--no-same-owner", "--no-same-permissions"], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (extracted.error || extracted.status !== 0) fail("candidate archive extraction failed");
}

function mkdirSyncCompat(path) {
  // This small synchronous bridge keeps archive extraction deterministic while all
  // durable outputs remain async and write-once.
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

function toolPath(checkout, name) {
  for (const root of [join(checkout, "tools"), join(checkout, "apps/studio/tools")]) {
    const candidate = join(root, name);
    if (existsSync(candidate)) return candidate;
  }
  fail(`maintained consumer tool ${name} is absent from the checked-out public source`);
}

function commandEnvironment(platform) {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    ...(platform.startsWith("linux")
      ? {
        WEBKIT_DISABLE_COMPOSITING_MODE: "1",
        WEBKIT_DISABLE_DMABUF_RENDERER: "1",
        GDK_BACKEND: "x11",
        LIBGL_ALWAYS_SOFTWARE: "1",
      }
      : {}),
  };
}

export function buildCommandPlan({
  platform,
  checkout,
  qualifyCheckout = checkout,
  rawPayload,
  npmPackage,
  packageManifestSha256,
  expectedNativePayloadSha256,
  evidenceDir,
}) {
  if (!Object.hasOwn(PLATFORMS, platform)) fail(`unsupported platform ${platform}`);
  requireDigest(packageManifestSha256, "packageManifestSha256");
  const packageTool = toolPath(checkout, "native-rc-package.mjs");
  const qualifyTool = toolPath(checkout, "native-rc-qualify.mjs");
  const smokeTool = toolPath(checkout, "native-rc-smoke.mjs");
  const node = process.execPath;
  const prefix = platform.startsWith("linux") ? ["xvfb-run", "-a", "-s", "-screen 0 1280x800x24", "dbus-run-session", "--"] : [];
  const smoke = (scenario, source, launchRoot, label) => ({
    label,
    scenario,
    source,
    command: prefix[0] ?? node,
    args: prefix.length
      ? [...prefix.slice(1), node, smokeTool, "--platform", platform, "--scenario", scenario, "--launch-root", launchRoot, "--checkout", checkout, "--evidence", evidenceDir, "--source", source, "--label", label, "--package-manifest-sha256", packageManifestSha256]
      : [smokeTool, "--platform", platform, "--scenario", scenario, "--launch-root", launchRoot, "--checkout", checkout, "--evidence", evidenceDir, "--source", source, "--label", label, "--package-manifest-sha256", packageManifestSha256],
    env: commandEnvironment(platform),
  });
  const packageVerify = {
    command: node,
    args: [packageTool, "verify", "--platform", platform, "--package-root", npmPackage, "--manifest-sha256", packageManifestSha256],
    env: commandEnvironment(platform),
  };
  let qualification = null;
  if (!platform.startsWith("darwin")) {
    requireDigest(expectedNativePayloadSha256, "expectedNativePayloadSha256");
    qualification = {
      command: node,
      args: [
        qualifyTool,
        "--platform",
        platform,
        "--payload",
        rawPayload,
        "--checkout",
        qualifyCheckout,
        "--expected-native-payload-sha256",
        expectedNativePayloadSha256,
        "--archive-legal-envelope",
        "--output",
        join(evidenceDir, `${platform}.qualification.json`),
      ],
      env: commandEnvironment(platform),
    };
  }
  const scenarios = PLATFORMS[platform].scenarios;
  return {
    packageVerify,
    qualification,
    smoke: scenarios.flatMap((scenario) => [
      smoke(scenario, "raw-archive", rawPayload, `${platform}-${scenario}-raw`),
      smoke(scenario, "npm-package", join(npmPackage, "payload"), `${platform}-${scenario}-npm`),
    ]),
    expectedScenarioCount: scenarios.length * 2,
    node,
  };
}

function runCommand(spec, label) {
  const result = spawnSync(spec.command, spec.args, { cwd: undefined, env: spec.env, encoding: "utf8", timeout: 15 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || "").trim();
    fail(`${label} command failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout.trim();
}

function parseLastJson(stdout, label) {
  const lines = String(stdout).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch { /* diagnostics are not receipt bytes */ }
  }
  fail(`${label} did not emit JSON readback`);
}

function archiveRoots(platform, extractedRaw, extractedNpm) {
  const raw = platform.startsWith("darwin") ? extractedRaw : join(extractedRaw, PLATFORMS[platform].rawRoot);
  const npmPackage = join(extractedNpm, "package");
  const npmPayload = join(npmPackage, "payload");
  return { raw, npmPackage, npmPayload };
}

export function validateExtractedPackageManifest(manifest, platform, targetSource) {
  requireRecord(manifest, "package-manifest.json");
  if (!PACKAGE_MANIFEST_SCHEMAS.includes(manifest.schema)) fail("package-manifest.json schema is invalid");
  if (
    manifest.package !== `@knowledge-forge-ai/theme-forge-nebular-fusion-${platform}` ||
    manifest.version !== VERSION ||
    manifest.payloadStatus !== "complete" ||
    manifest.executable !== PLATFORMS[platform].npmExecutable ||
    !Array.isArray(manifest.members) ||
    manifest.fileCount !== manifest.members.length
  ) {
    fail(`package-manifest.json identity or inventory is invalid for ${platform}`);
  }
  const executableMember = manifest.members.find((member) => isRecord(member) && member.path === manifest.executable && member.type === "file");
  if (!executableMember || executableMember.sha256 !== targetSource.executableSha256) {
    fail(`package-manifest.json executable digest does not match authenticated targetSources.${platform}.executableSha256`);
  }
  return manifest;
}

export function validateSmokeRunReport(runReport, { platform, scenario, source, executableSha256 }) {
  requireRecord(runReport, `${platform}-${scenario}-${source}.run.json`);
  if (
    runReport.schema !== SMOKE_RUN_SCHEMA ||
    runReport.status !== "pass" ||
    runReport.platform !== platform ||
    runReport.scenario !== scenario ||
    runReport.source !== source ||
    !Array.isArray(runReport.problems) ||
    runReport.problems.length !== 0
  ) {
    fail(`smoke run report failed schema, status, or scenario/source check for ${platform} ${scenario} (${source})`);
  }
  if (!isRecord(runReport.executable) || runReport.executable.sha256 !== executableSha256) {
    fail(`smoke run report executable.sha256 does not match authenticated executable for ${platform} ${scenario} (${source})`);
  }
  if (!isRecord(runReport.receipt) || runReport.receipt.status !== "pass" || !SHA256.test(String(runReport.receipt.sha256 ?? ""))) {
    fail(`smoke run report application receipt is missing or not passing for ${platform} ${scenario} (${source})`);
  }
  if (!isRecord(runReport.finalization) || runReport.finalization.schema !== SMOKE_FINALIZATION_SCHEMA || runReport.finalization.status !== "complete") {
    fail(`smoke run report finalization is incomplete for ${platform} ${scenario} (${source})`);
  }
  return {
    platform,
    scenario,
    source,
    status: "pass",
    executableSha256: runReport.executable.sha256,
    receiptSha256: runReport.receipt.sha256,
    finalizationStatus: runReport.finalization.status,
  };
}

export function prepareConsumerQualifyCheckout(checkout, npmPayload, scratch) {
  const tauriConfCandidates = [
    join(checkout, "src-tauri/tauri.conf.json"),
    join(checkout, "apps/studio/src-tauri/tauri.conf.json"),
  ];
  const tauriConfPath = tauriConfCandidates.find((candidate) => existsSync(candidate));
  if (!tauriConfPath) return { qualifyCheckout: checkout, resourceComparison: "source-prepared-vs-shipped" };
  let config;
  try { config = JSON.parse(readFileSync(tauriConfPath, "utf8")); } catch { fail("tauri.conf.json in checkout is not valid JSON"); }
  const dirs = resourceDirectories(config);
  if (dirs.length === 0) fail("tauri.conf.json declares no bundle.resources directories");
  const directReady = existsSync(join(checkout, "src-tauri/tauri.conf.json")) &&
    dirs.every((dir) => existsSync(join(checkout, "src-tauri", dir)));
  if (directReady) return { qualifyCheckout: checkout, resourceComparison: "source-prepared-vs-shipped" };
  const bridgeRoot = join(scratch, "qualify-checkout");
  mkdirSyncCompat(join(bridgeRoot, "src-tauri"));
  cpSync(tauriConfPath, join(bridgeRoot, "src-tauri/tauri.conf.json"));
  const studioSourceRoot = dirname(dirname(tauriConfPath));
  for (const legalName of ["LICENSE", "NOTICE"]) {
    const sourceLegalPath = join(studioSourceRoot, legalName);
    if (!existsSync(sourceLegalPath)) {
      fail(`authoritative Studio ${legalName} is missing beside ${tauriConfPath}`);
    }
    cpSync(sourceLegalPath, join(bridgeRoot, legalName));
  }
  const npmResourcesRoot = join(npmPayload, "lib/theme-forge-nebular-fusion");
  for (const dir of dirs) {
    const checkoutCandidate = [
      join(checkout, "src-tauri", dir),
      join(checkout, "apps/studio/src-tauri", dir),
    ].find((candidate) => existsSync(candidate));
    const sourceDir = checkoutCandidate ?? join(npmResourcesRoot, dir);
    if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
      fail(`extracted npm payload is missing declared resource directory '${dir}' required for raw-vs-npm cross-check`);
    }
    cpSync(sourceDir, join(bridgeRoot, "src-tauri", dir), { recursive: true });
  }
  return { qualifyCheckout: bridgeRoot, resourceComparison: "raw-vs-npm-cross-check" };
}

export function resolveAssetsDir(assetsDir) {
  if (typeof assetsDir !== "string" || assetsDir.length === 0) fail("assets directory is required");
  const root = resolve(assetsDir);
  if (existsSync(join(root, "raw")) && existsSync(join(root, "npm"))) {
    return root;
  }
  if (existsSync(root) && statSync(root).isDirectory()) {
    const nested = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && entry.name.startsWith(`nebular-${VERSION}-product-assets-`))
      .map((entry) => join(root, entry.name));
    if (nested.length === 1 && existsSync(join(nested[0], "raw")) && existsSync(join(nested[0], "npm"))) {
      return nested[0];
    }
  }
  return root;
}

async function verifyAssets(normalized, assetsDir) {
  const resolvedRoot = resolveAssetsDir(assetsDir);
  const rows = [];
  for (const asset of normalized.assets) {
    const path = join(resolvedRoot, asset.kind === "raw-archive" ? "raw" : "npm", asset.platform, asset.name);
    const readback = await hashFile(path);
    if (readback.bytes !== asset.bytes || readback.sha256 !== asset.sha256) fail(`transported ${asset.name} differs from its authenticated descriptor`);
    rows.push({
      platform: asset.platform,
      kind: asset.kind,
      assetId: asset.assetId,
      name: asset.name,
      bytes: readback.bytes,
      sha256: readback.sha256,
      sourceCommit: asset.sourceCommit,
      sourceTree: asset.sourceTree,
      sourceCandidate: asset.sourceCandidate,
    });
  }
  return rows;
}

export async function verifyExtractedDarwinRawPayload(rawRoot, targetSource, darwinQualification, rawExecutableReadback = null) {
  if (typeof rawRoot !== "string" || rawRoot.length === 0) {
    fail("Darwin raw payload root is required");
  }
  requireRecord(targetSource, "targetSources.darwin-arm64");
  requireRecord(darwinQualification, "qualifications.darwin-arm64");
  const expectedNativePayloadSha256 = requireDigest(
    targetSource.nativePayloadSha256,
    "targetSources.darwin-arm64.nativePayloadSha256",
  );
  const expectedExecutableSha256 = requireDigest(
    targetSource.executableSha256,
    "targetSources.darwin-arm64.executableSha256",
  );
  if (darwinQualification.nativePayloadSha256 !== expectedNativePayloadSha256) {
    fail("Darwin qualification nativePayloadSha256 does not match targetSources.darwin-arm64.nativePayloadSha256");
  }
  let rootStat;
  try {
    rootStat = lstatSync(rawRoot);
  } catch {
    fail("extracted raw Darwin payload root does not exist");
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail("extracted raw Darwin payload root must be a real directory");
  }
  const resolvedRawRoot = realpathSync(resolve(rawRoot));
  const bundleRootName = PLATFORMS["darwin-arm64"].rawRoot;
  const bundlePath = join(resolvedRawRoot, bundleRootName);
  let bundleStat;
  try {
    bundleStat = lstatSync(bundlePath);
  } catch {
    fail(`extracted raw Darwin payload is missing '${bundleRootName}'`);
  }
  if (!bundleStat.isDirectory() || bundleStat.isSymbolicLink()) {
    fail(`extracted raw Darwin '${bundleRootName}' must be a real directory`);
  }
  const resolvedBundlePath = realpathSync(bundlePath);
  const bundleRel = relative(resolvedRawRoot, resolvedBundlePath).split(sep).join("/");
  if (bundleRel !== bundleRootName) {
    fail("extracted raw Darwin application bundle escapes the payload root");
  }
  const rootEntries = readdirSync(resolvedRawRoot);
  if (rootEntries.length !== 1 || rootEntries[0] !== bundleRootName) {
    fail(`extracted raw Darwin payload root must contain only '${bundleRootName}'`);
  }
  let inventory;
  try {
    inventory = await inventoryNativePayload(resolvedRawRoot);
  } catch (error) {
    fail(`extracted raw Darwin native payload inventory failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (
    !isRecord(inventory) ||
    inventory.schema !== undefined ||
    inventory.materialDigest !== undefined ||
    !Array.isArray(inventory.files) ||
    inventory.files.length === 0 ||
    !SHA256.test(String(inventory.identity ?? ""))
  ) {
    fail("extracted raw Darwin native payload did not produce an ordinary file inventory");
  }
  const bundlePrefix = `${bundleRootName}/`;
  for (const entry of inventory.files) {
    if (
      !isRecord(entry) ||
      typeof entry.path !== "string" ||
      !entry.path.startsWith(bundlePrefix) ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      (entry.mode !== 0o644 && entry.mode !== 0o755) ||
      !SHA256.test(String(entry.sha256 ?? ""))
    ) {
      fail("extracted raw Darwin native payload inventory contains an invalid or uncontained member");
    }
  }
  const executableEntry = inventory.files.find((entry) => entry.path === PLATFORMS["darwin-arm64"].rawExecutable);
  if (
    !executableEntry ||
    executableEntry.mode !== 0o755 ||
    executableEntry.sha256 !== expectedExecutableSha256 ||
    (rawExecutableReadback && executableEntry.bytes !== rawExecutableReadback.bytes)
  ) {
    fail("extracted raw Darwin native payload inventory executable entry does not match targetSources.darwin-arm64.executableSha256");
  }
  if (inventory.identity !== expectedNativePayloadSha256) {
    fail(
      `extracted raw Darwin native payload inventory identity ${inventory.identity} does not match targetSources.darwin-arm64.nativePayloadSha256`,
    );
  }
  return Object.freeze({
    identity: inventory.identity,
    files: inventory.files.length,
  });
}

function qualificationFromInput(normalized, platform, darwinPayloadReadback = null) {
  if (platform === "darwin-arm64") {
    const darwinQual = normalized.qualifications["darwin-arm64"];
    const verifiedPayload = validatePayloadInventorySummary(
      darwinPayloadReadback,
      "darwin-arm64 observed nativePayload",
      darwinQual.nativePayloadSha256,
      "targetSources.darwin-arm64.nativePayloadSha256",
    );
    return {
      status: darwinQual.status,
      mode: "existing-qualified",
      authority: darwinQual.authority,
      sourceCommit: darwinQual.sourceCommit,
      sourceTree: darwinQual.sourceTree,
      sourceCandidate: darwinQual.sourceCandidate,
      receiptSha256: darwinQual.receiptSha256,
      executableSha256: darwinQual.executableSha256,
      nativePayloadSha256: verifiedPayload.identity,
      nativePayload: verifiedPayload,
    };
  }
  return null;
}

export async function qualifyPlatform(normalizedInput, assetsDir, platform, checkout, output, options = {}) {
  const normalized = normalizedInput.schema === INPUT_SCHEMA && Object.isFrozen(normalizedInput)
    ? normalizedInput
    : validateInput(normalizedInput);
  if (!Object.hasOwn(PLATFORMS, platform)) fail("unsupported consumer platform");
  const verifiedTargetSourceReadbacks = options.trustedReadback?.targetSourceReadbacks
    ? assertSourceReadbackBindings(
        options.trustedReadback.targetSourceReadbacks,
        normalized.source.targetSourceReadbacks,
        "qualifyPlatform.trustedReadback.targetSourceReadbacks",
      )
    : options.sourceArchivePath !== undefined
      ? verifyTrustedReadbackFiles(normalized, checkout, options).targetSourceReadbacks
      : normalized.source.targetSourceReadbacks;
  const targetSource = normalized.targetSources[platform];
  const resolvedAssetsRoot = resolveAssetsDir(assetsDir);
  const transport = await verifyAssets(normalized, resolvedAssetsRoot);
  const scratch = await mkdtemp(join(tmpdir(), "nebular-consumer-"));
  const evidenceDir = join(resolve(output), "smoke");
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  try {
    const rawAsset = normalized.assets.find((asset) => asset.platform === platform && asset.kind === "raw-archive");
    const npmAsset = normalized.assets.find((asset) => asset.platform === platform && asset.kind === "npm-package");
    const rawArchive = join(resolvedAssetsRoot, "raw", platform, rawAsset.name);
    const npmArchive = join(resolvedAssetsRoot, "npm", platform, npmAsset.name);
    const rawExtract = join(scratch, "raw");
    const npmExtract = join(scratch, "npm");
    extractArchive(rawArchive, rawExtract);
    extractArchive(npmArchive, npmExtract);
    const roots = archiveRoots(platform, rawExtract, npmExtract);
    const packageManifestPath = join(roots.npmPackage, "package-manifest.json");
    const packageManifestSha256 = (await hashFile(packageManifestPath, 8 * 1024 * 1024)).sha256;
    if (targetSource.packageManifestSha256 && packageManifestSha256 !== targetSource.packageManifestSha256) {
      fail(`extracted package-manifest.json digest mismatch for ${platform}`);
    }
    const packageManifest = await readJson(packageManifestPath, 8 * 1024 * 1024);
    validateExtractedPackageManifest(packageManifest, platform, targetSource);
    const rawExecutablePath = join(roots.raw, PLATFORMS[platform].rawExecutable);
    const rawExecutableReadback = await hashFile(rawExecutablePath, MAX_ARCHIVE_BYTES);
    if (rawExecutableReadback.sha256 !== targetSource.executableSha256) {
      fail(`extracted raw executable digest does not match targetSources.${platform}.executableSha256`);
    }
    const darwinPayloadReadback = platform === "darwin-arm64"
      ? await verifyExtractedDarwinRawPayload(
          roots.raw,
          targetSource,
          normalized.qualifications["darwin-arm64"],
          rawExecutableReadback,
        )
      : null;
    const resolvedCheckout = resolve(checkout);
    const { qualifyCheckout, resourceComparison } = platform.startsWith("linux")
      ? prepareConsumerQualifyCheckout(resolvedCheckout, roots.npmPayload, scratch)
      : { qualifyCheckout: resolvedCheckout, resourceComparison: null };
    const plan = buildCommandPlan({
      platform,
      checkout: resolvedCheckout,
      qualifyCheckout,
      rawPayload: roots.raw,
      npmPackage: roots.npmPackage,
      packageManifestSha256,
      expectedNativePayloadSha256: targetSource.nativePayloadSha256,
      evidenceDir,
    });
    const packageVerifyStdout = parseLastJson(runCommand(plan.packageVerify, "native package verify"), "native package verify");
    if (packageVerifyStdout.status !== "pass") fail(`native package verify did not pass for ${platform}`);
    let qualification = qualificationFromInput(normalized, platform, darwinPayloadReadback);
    let qualificationReceipt = platform === "darwin-arm64"
      ? normalized.qualifications["darwin-arm64"].receipt
      : null;
    if (plan.qualification) {
      const qualStdout = parseLastJson(runCommand(plan.qualification, "native payload qualification"), "native payload qualification");
      if (qualStdout.status !== "pass") fail(`native payload qualification stdout did not pass for ${platform}`);
      const qualificationFile = await readJson(join(evidenceDir, `${platform}.qualification.json`));
      const verifiedQual = validateQualificationReceipt(qualificationFile, platform, targetSource);
      qualificationReceipt = verifiedQual;
      qualification = {
        status: verifiedQual.status,
        mode: "hosted",
        authority: targetSource.authority,
        sourceCommit: targetSource.sourceCommit,
        sourceTree: targetSource.sourceTree,
        sourceCandidate: targetSource.sourceCandidate,
        executableSha256: verifiedQual.executableSha256,
        nativePayloadSha256: verifiedQual.nativePayload.identity,
        glibcMinimum: verifiedQual.glibcMinimum ?? null,
        resourceComparison,
      };
    }
    if (!qualification || qualification.status !== "pass") fail(`consumer qualification did not pass for ${platform}`);
    const runs = [];
    for (const smoke of plan.smoke) {
      const stdoutResult = parseLastJson(runCommand(smoke, "native consumer smoke"), "native consumer smoke");
      if (stdoutResult.status !== "pass") fail(`consumer smoke stdout did not pass for ${platform} (${smoke.label})`);
      const runReport = await readJson(join(evidenceDir, `${smoke.label}.run.json`));
      runs.push(validateSmokeRunReport(runReport, {
        platform,
        scenario: smoke.scenario,
        source: smoke.source,
        executableSha256: targetSource.executableSha256,
      }));
    }
    const dpkgPath = join(resolve(output), `${platform}.dpkg-packages.txt`);
    const dpkgPackagesSha256 = existsSync(dpkgPath)
      ? (await hashFile(dpkgPath, 8 * 1024 * 1024)).sha256
      : null;
    const receipt = {
      schema: PLATFORM_RECEIPT_SCHEMA,
      status: "pass",
      mode: "hosted-product-consumer",
      product: normalized.product,
      version: normalized.version,
      platform,
      source: {
        contract: SOURCE_CONTRACT,
        repository: REPOSITORY,
        commit: normalized.source.commit,
        tree: normalized.source.tree,
        manifestSha256: normalized.source.manifestSha256,
        correspondingSourceOfferSha256: normalized.source.correspondingSourceOfferSha256,
        targetSourceReadbacks: verifiedTargetSourceReadbacks,
      },
      compilerSource: targetSource,
      release: normalized.release,
      assets: normalized.assets.filter((asset) => asset.platform === platform),
      transport,
      packageManifestSha256,
      qualification,
      qualificationReceipt,
      qualificationReceiptSha256: digestJson(qualificationReceipt),
      smoke: runs,
      ...(dpkgPackagesSha256 ? { dpkgPackagesSha256 } : {}),
      buildPerformed: false,
      packageProduced: false,
      privateInputsConsumed: false,
    };
    await writeNew(join(resolve(output), `${platform}.consumer-receipt.json`), receipt);
    return receipt;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export function buildConsumerReceipt(input, platformReceipts, options = {}) {
  const normalized = input.schema === INPUT_SCHEMA && Object.isFrozen(input) ? input : validateInput(input);
  requireRecord(platformReceipts, "platform receipts");
  const verifiedTargetSourceReadbacks = options.sourceArchivePath !== undefined
    ? verifyTrustedReadbackFiles(normalized, options.checkout ?? ".", options).targetSourceReadbacks
    : normalized.source.targetSourceReadbacks;
  const expectedTransport = normalized.assets.map((asset) => ({
    platform: asset.platform,
    kind: asset.kind,
    assetId: asset.assetId,
    name: asset.name,
    bytes: asset.bytes,
    sha256: asset.sha256,
    sourceCommit: asset.sourceCommit,
    sourceTree: asset.sourceTree,
    sourceCandidate: asset.sourceCandidate,
  }));
  const rows = Object.keys(PLATFORMS).map((platform) => {
    const row = requireRecord(platformReceipts[platform], `${platform} receipt`);
    const targetSource = normalized.targetSources[platform];
    if (
      row.schema !== PLATFORM_RECEIPT_SCHEMA ||
      row.status !== "pass" ||
      row.platform !== platform ||
      row.source?.commit !== normalized.source.commit ||
      row.source?.tree !== normalized.source.tree ||
      row.source?.manifestSha256 !== normalized.source.manifestSha256 ||
      row.source?.correspondingSourceOfferSha256 !== normalized.source.correspondingSourceOfferSha256
    ) {
      fail(`${platform} receipt is not bound to the admitted public source and corresponding-source offer`);
    }
    if (row.source?.targetSourceReadbacks !== undefined) {
      assertSourceReadbackBindings(
        row.source.targetSourceReadbacks,
        verifiedTargetSourceReadbacks,
        `${platform} receipt source.targetSourceReadbacks`,
      );
    }
    if (
      !isRecord(row.compilerSource) ||
      row.compilerSource.authority !== targetSource.authority ||
      row.compilerSource.sourceCommit !== targetSource.sourceCommit ||
      row.compilerSource.sourceTree !== targetSource.sourceTree ||
      row.compilerSource.sourceCandidate !== targetSource.sourceCandidate ||
      row.compilerSource.nativePayloadSha256 !== targetSource.nativePayloadSha256 ||
      row.compilerSource.executableSha256 !== targetSource.executableSha256 ||
      (targetSource.packageManifestSha256 !== undefined &&
        row.compilerSource.packageManifestSha256 !== undefined &&
        row.compilerSource.packageManifestSha256 !== targetSource.packageManifestSha256)
    ) {
      fail(`${platform} receipt compilerSource does not match authenticated targetSources.${platform}`);
    }
    if (row.packageManifestSha256 !== undefined) {
      requireDigest(row.packageManifestSha256, `${platform} receipt packageManifestSha256`);
      if (targetSource.packageManifestSha256 && row.packageManifestSha256 !== targetSource.packageManifestSha256) {
        fail(`${platform} receipt packageManifestSha256 does not match targetSources.${platform}.packageManifestSha256`);
      }
    } else if (targetSource.packageManifestSha256) {
      fail(`${platform} receipt is missing required packageManifestSha256`);
    }
    if (row.release !== undefined) {
      const validatedRelease = validateRelease(row.release);
      if (digestJson(validatedRelease) !== digestJson(normalized.release)) {
        fail(`${platform} receipt release does not match authenticated release`);
      }
    }
    if (row.assets !== undefined) {
      const expectedPlatformAssets = normalized.assets
        .filter((asset) => asset.platform === platform)
        .slice()
        .sort((a, b) => a.kind.localeCompare(b.kind));
      if (!Array.isArray(row.assets) || row.assets.length !== expectedPlatformAssets.length) {
        fail(`${platform} receipt assets do not match authenticated platform assets`);
      }
      const actualPlatformAssets = row.assets
        .map((asset) => validateAsset(asset, normalized.targetSources, normalized.release))
        .sort((a, b) => a.kind.localeCompare(b.kind));
      if (digestJson(actualPlatformAssets) !== digestJson(expectedPlatformAssets)) {
        fail(`${platform} receipt assets do not match authenticated platform assets`);
      }
    }
    if (row.transport !== undefined) {
      if (!Array.isArray(row.transport) || row.transport.length !== expectedTransport.length) {
        fail(`${platform} receipt transport does not match authenticated release assets`);
      }
      const sortTransport = (items) =>
        items.slice().sort((a, b) => `${a.platform}\0${a.kind}`.localeCompare(`${b.platform}\0${b.kind}`));
      const actualTransport = row.transport.map((entry) => {
        requireRecord(entry, `${platform} receipt transport entry`);
        return {
          platform: entry.platform,
          kind: entry.kind,
          assetId: entry.assetId,
          name: entry.name,
          bytes: entry.bytes,
          sha256: entry.sha256,
          sourceCommit: entry.sourceCommit,
          sourceTree: entry.sourceTree,
          sourceCandidate: entry.sourceCandidate,
        };
      });
      if (digestJson(sortTransport(actualTransport)) !== digestJson(sortTransport(expectedTransport))) {
        fail(`${platform} receipt transport does not match authenticated release assets`);
      }
    }
    if (
      !isRecord(row.qualification) ||
      row.qualification.status !== "pass" ||
      row.qualification.mode !== PLATFORMS[platform].qualification ||
      row.qualification.authority !== targetSource.authority ||
      row.qualification.sourceCommit !== targetSource.sourceCommit ||
      row.qualification.sourceTree !== targetSource.sourceTree ||
      row.qualification.sourceCandidate !== targetSource.sourceCandidate ||
      row.qualification.executableSha256 !== targetSource.executableSha256 ||
      row.qualification.nativePayloadSha256 !== targetSource.nativePayloadSha256
    ) {
      fail(`${platform} receipt qualification lineage is invalid or restamped`);
    }
    const qualificationReceipt = validateQualificationReceipt(row.qualificationReceipt, platform, targetSource);
    const qualificationReceiptSha256 = requireDigest(
      row.qualificationReceiptSha256,
      `${platform} receipt qualificationReceiptSha256`,
    );
    if (qualificationReceiptSha256 !== digestJson(qualificationReceipt)) {
      fail(`${platform} receipt qualificationReceiptSha256 does not match the complete qualification receipt`);
    }
    if (platform === "darwin-arm64" && row.qualification.receiptSha256 !== normalized.qualifications["darwin-arm64"].receiptSha256) {
      fail("darwin-arm64 receipt qualification does not bind the existing-qualified receiptSha256");
    }
    if (platform === "darwin-arm64" && qualificationReceiptSha256 !== normalized.qualifications["darwin-arm64"].receiptSha256) {
      fail("darwin-arm64 complete qualification receipt does not bind the existing-qualified receiptSha256");
    }
    if (platform === "darwin-arm64") {
      validatePayloadInventorySummary(
        row.qualification.nativePayload,
        "darwin-arm64 receipt qualification.nativePayload",
        targetSource.nativePayloadSha256,
        "targetSources.darwin-arm64.nativePayloadSha256",
      );
    }
    if (!Array.isArray(row.smoke) || row.smoke.some((run) => !isRecord(run) || run.platform !== platform)) {
      fail(`${platform} receipt smoke rows must belong to ${platform}`);
    }
    return row;
  });
  const smoke = rows.flatMap((row) => row.smoke ?? []);
  const expected = Object.entries(PLATFORMS).flatMap(([platform, contract]) =>
    contract.scenarios.flatMap((scenario) => [
      { platform, scenario, source: "raw-archive" },
      { platform, scenario, source: "npm-package" },
    ]),
  );
  const keys = smoke.map((run) => `${run.platform}\0${run.scenario}\0${run.source}`);
  if (
    new Set(keys).size !== keys.length ||
    keys.length !== expected.length ||
    expected.some((want) => !keys.includes(`${want.platform}\0${want.scenario}\0${want.source}`))
  ) {
    fail("consumer smoke matrix is incomplete or duplicated");
  }
  for (const run of smoke) {
    const targetSource = normalized.targetSources[run.platform];
    if (
      run.status !== "pass" ||
      run.executableSha256 !== targetSource.executableSha256 ||
      !SHA256.test(String(run.receiptSha256 ?? ""))
    ) {
      fail(`consumer smoke entry for ${run.platform} ${run.scenario} (${run.source}) is missing passing executable/receipt digests`);
    }
  }
  return {
    schema: RECEIPT_SCHEMA,
    status: "pass",
    mode: "hosted-product-consumer",
    product: normalized.product,
    version: normalized.version,
    source: {
      contract: SOURCE_CONTRACT,
      repository: REPOSITORY,
      commit: normalized.source.commit,
      tree: normalized.source.tree,
      manifestSha256: normalized.source.manifestSha256,
      correspondingSourceOffer: normalized.source.correspondingSourceOffer,
      correspondingSourceOfferSha256: normalized.source.correspondingSourceOfferSha256,
      targetSourceReadbacks: verifiedTargetSourceReadbacks,
    },
    targetSources: normalized.targetSources,
    release: normalized.release,
    assets: normalized.assets,
    platforms: rows,
    smoke,
    buildPerformed: false,
    packageProduced: false,
    privateInputsConsumed: false,
  };
}

function readbackOptionsFromArgs(args, checkout = ".") {
  return {
    checkout,
    sourceArchivePath: flag(args, "--source-archive"),
    darwinSourceArchivePath: flag(args, "--darwin-source-archive"),
    linuxSourceArchivePath: flag(args, "--linux-source-archive"),
    darwinReceiptPath: flag(args, "--darwin-receipt"),
  };
}

function flag(args, name) { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1]; }
async function main(args) {
  const mode = args[0];
  const inputPath = flag(args, "--input");
  if (mode === "validate") { validateInput(await readJson(inputPath)); process.stdout.write(JSON.stringify({ status: "pass", schema: INPUT_SCHEMA }) + "\n"); return; }
  if (mode === "admit-source") {
    const input = await readJson(inputPath);
    const checkout = flag(args, "--checkout") ?? ".";
    const admission = resolveSourceAdmission(input, checkout, {
      inputPath,
      ...readbackOptionsFromArgs(args, checkout),
    });
    await writeNew(resolve(flag(args, "--output")), admission);
    process.stdout.write(JSON.stringify({ status: admission.status, schema: admission.schema, commit: admission.commit, tree: admission.tree, correspondingSourceOfferSha256: admission.correspondingSourceOfferSha256 }) + "\n");
    return;
  }
  if (mode === "fetch") {
    const input = await readJson(inputPath);
    const normalized = validateInput(input);
    const admission = await readJson(flag(args, "--admission"));
    const checkout = flag(args, "--checkout") ?? ".";
    verifyAdmissionReceipt(admission, normalized, readbackOptionsFromArgs(args, checkout));
    const output = resolve(flag(args, "--output"));
    const readbacks = [];
    for (const asset of normalized.assets) {
      const destination = join(output, asset.kind === "raw-archive" ? "raw" : "npm", asset.platform, asset.name);
      readbacks.push(await fetchReleaseAsset(asset, destination));
    }
    await writeNew(join(output, "fetch-readback.json"), {
      schema: "nebular.hosted-product-fetch-readback-v2",
      status: "pass",
      source: {
        commit: normalized.source.commit,
        tree: normalized.source.tree,
        manifestSha256: normalized.source.manifestSha256,
        correspondingSourceOfferSha256: normalized.source.correspondingSourceOfferSha256,
        targetSourceReadbacks: admission.targetSourceReadbacks,
      },
      assets: readbacks.map(({ platform, kind, assetId, name, bytes, sha256, sourceCommit, sourceTree, sourceCandidate }) => ({
        platform,
        kind,
        assetId,
        name,
        bytes,
        sha256,
        sourceCommit,
        sourceTree,
        sourceCandidate,
      })),
    });
    process.stdout.write(JSON.stringify({ status: "pass", assets: readbacks.length }) + "\n");
    return;
  }
  if (mode === "fetch-source-readbacks") {
    const manifest = await readJson(flag(args, "--manifest"));
    const input = validateInput(await readJson(inputPath));
    const result = await fetchSourceReadbacks(
      manifest,
      flag(args, "--output"),
      globalThis.fetch,
      input.source,
    );
    process.stdout.write(JSON.stringify({
      status: result.status,
      schema: result.schema,
      sourceAssets: Object.keys(result.sourceAssets).length,
      darwinQualificationReceipt: result.darwinQualificationReceipt,
    }) + "\n");
    return;
  }
  if (mode === "verify-assets") {
    const normalized = validateInput(await readJson(inputPath));
    const rows = await verifyAssets(normalized, flag(args, "--assets"));
    if (flag(args, "--output")) {
      await writeNew(resolve(flag(args, "--output")), {
        schema: "nebular.hosted-product-asset-verification-v1",
        status: "pass",
        source: { commit: normalized.source.commit, tree: normalized.source.tree },
        assets: rows,
      });
    }
    process.stdout.write(JSON.stringify({ status: "pass", assets: rows.length }) + "\n");
    return;
  }
  if (mode === "qualify") {
    const rawInput = await readJson(inputPath);
    const normalized = validateInput(rawInput);
    const checkout = flag(args, "--checkout") ?? ".";
    const readbackOptions = readbackOptionsFromArgs(args, checkout);
    const admission = resolveSourceAdmission(rawInput, checkout, {
      inputPath,
      ...readbackOptions,
    });
    verifyAdmissionReceipt(admission, normalized, readbackOptions);
    const receipt = await qualifyPlatform(normalized, flag(args, "--assets"), flag(args, "--platform"), checkout, flag(args, "--output"), {
      ...readbackOptions,
      trustedReadback: admission.trustedReadback,
    });
    process.stdout.write(JSON.stringify({ status: receipt.status, schema: receipt.schema, platform: receipt.platform }) + "\n");
    return;
  }
  if (mode === "receipt") {
    const normalized = validateInput(await readJson(inputPath));
    const checkout = flag(args, "--checkout") ?? ".";
    const readbackOptions = readbackOptionsFromArgs(args, checkout);
    const receiptsDir = resolve(flag(args, "--platform-receipts"));
    const rows = {};
    for (const platform of Object.keys(PLATFORMS)) rows[platform] = await readJson(join(receiptsDir, `${platform}.consumer-receipt.json`));
    await writeNew(resolve(flag(args, "--output")), buildConsumerReceipt(normalized, rows, readbackOptions));
    process.stdout.write(JSON.stringify({ status: "pass", schema: RECEIPT_SCHEMA }) + "\n");
    return;
  }
  throw new Error("Usage: nebular-hosted-product-consumer.mjs validate|fetch-source-readbacks|admit-source|fetch|verify-assets|qualify|receipt ... (admit-source/fetch/qualify require --source-archive, --darwin-source-archive, --linux-source-archive, and --darwin-receipt)");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
