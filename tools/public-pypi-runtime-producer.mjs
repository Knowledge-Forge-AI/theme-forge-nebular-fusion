#!/usr/bin/env node
// Public Linux portable-runtime transport and provenance adapter.
// The input4 Python helper owns archive preflight, held-fd extraction,
// descriptor creation, and maintained runtime authentication. This file owns
// exact GitHub asset transport, source-origin provenance, and final receipts.

import { createHash } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import { mkdir, open, readdir, rm } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const RUNTIME_MANIFEST_SCHEMA = "nebular.public-pypi-runtime-input-manifest-v2";
export const SOURCE_ORIGIN_SCHEMA = "nebular.public-pypi-source-origin-v2";
export const RELEASE_RECEIPT_SCHEMA = "nebular.public-pypi-runtime-release-v1";
export const REPOSITORY = "Knowledge-Forge-AI/theme-forge-nebular-fusion";
export const VERSION = "0.7.1";
export const SOURCE_CONTRACT = "public-source-first-v6";
export const TARGETS = Object.freeze(["aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu"]);
export const RELEASE_HOSTS = Object.freeze(new Set(["api.github.com", "github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]));
export const LIMITS = Object.freeze({ maxArchiveBytes: 2 * 1024 * 1024 * 1024, maxManifestBytes: 256 * 1024, maxReceiptBytes: 16 * 1024 * 1024, maxRedirects: 5 });
const PLATFORM_BINDINGS = Object.freeze({
  "linux-arm64": Object.freeze({ target: "aarch64-unknown-linux-gnu", cpu: "arm64", package: "@knowledge-forge-ai/theme-forge-nebular-fusion-linux-arm64", executable: "payload/bin/theme-forge-nebular-fusion", scenarios: Object.freeze(["B"]) }),
  "linux-x64": Object.freeze({ target: "x86_64-unknown-linux-gnu", cpu: "x64", package: "@knowledge-forge-ai/theme-forge-nebular-fusion-linux-x64", executable: "payload/bin/theme-forge-nebular-fusion", scenarios: Object.freeze(["C", "C-signal"]) }),
});

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;
const SAFE_TARGET = new Set(TARGETS);
const fail = (message) => { throw new Error(`[PUBLIC_PYPI_RUNTIME_FAIL] ${message}`); };
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function requireRecord(value, label) { if (!isRecord(value)) fail(`${label} must be an object`); return value; }
function requireString(value, label, pattern = null) { if (typeof value !== "string" || value.length === 0 || (pattern && !pattern.test(value))) fail(`${label} is invalid`); return value; }
function requireDigest(value, label) { return requireString(value, label, SHA256); }
function requirePositiveInteger(value, label, max = Number.MAX_SAFE_INTEGER) { if (!Number.isSafeInteger(value) || value < 1 || value > max) fail(`${label} is invalid`); return value; }
function closedObject(value, label, required, optional = []) {
  const object = requireRecord(value, label); const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(object)) if (!allowed.has(key)) fail(`${label} contains unsupported field '${key}'`);
  for (const key of required) if (!Object.hasOwn(object, key)) fail(`${label} is missing ${key}`);
  return object;
}
export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  fail("unsupported canonical JSON value");
}
export function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
export function sriForSha256(digest) { requireDigest(digest, "sha256"); return `sha256-${Buffer.from(digest, "hex").toString("base64")}`; }
function expectedAssetUrl(assetId) { return `https://api.github.com/repos/${REPOSITORY}/releases/assets/${assetId}`; }
function validateReleaseUrl(urlString, expected = null) {
  let parsed; try { parsed = new URL(urlString); } catch { fail("runtime release URL is invalid"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || !RELEASE_HOSTS.has(parsed.hostname)) fail("runtime release URL is not an allowed HTTPS GitHub URL");
  if (expected !== null && parsed.toString() !== expected) fail("runtime release URL is not the derived asset API URL");
  return parsed.toString();
}
function validateAssetPart(value, label, target) {
  const part = closedObject(value, label, ["assetId", "name", "bytes", "sha256", "integrity"]);
  if (!Number.isSafeInteger(part.assetId) || part.assetId < 1) fail(`${label}.assetId is invalid`);
  const name = requireString(part.name, `${label}.name`, SAFE_NAME);
  if (name !== `runtime-input-${target}.tar.gz`) fail(`${label}.name is not the fixed runtime archive name`);
  const bytes = requirePositiveInteger(part.bytes, `${label}.bytes`, LIMITS.maxArchiveBytes); const digest = requireDigest(part.sha256, `${label}.sha256`);
  if (part.integrity !== sriForSha256(digest)) fail(`${label}.integrity does not bind sha256`);
  return Object.freeze({ assetId: part.assetId, name, bytes, sha256: digest, integrity: part.integrity });
}
function validateAsset(value, target) {
  const asset = closedObject(value, `assets.${target}`, ["archive", "expectedMemberListSha256", "expectedManifestSha256", "expectedMaterialDigest", "correspondingSourceSha256", "releaseAssetSha256"], ["memberCount", "manifestBytes", "materialBytes"]);
  const archive = validateAssetPart(asset.archive, `assets.${target}.archive`, target);
  const result = { target, archive, expectedMemberListSha256: requireDigest(asset.expectedMemberListSha256, `assets.${target}.expectedMemberListSha256`), expectedManifestSha256: requireDigest(asset.expectedManifestSha256, `assets.${target}.expectedManifestSha256`), expectedMaterialDigest: requireDigest(asset.expectedMaterialDigest, `assets.${target}.expectedMaterialDigest`), correspondingSourceSha256: requireDigest(asset.correspondingSourceSha256, `assets.${target}.correspondingSourceSha256`), releaseAssetSha256: requireDigest(asset.releaseAssetSha256, `assets.${target}.releaseAssetSha256`) };
  if (asset.memberCount !== undefined) result.memberCount = requirePositiveInteger(asset.memberCount, `assets.${target}.memberCount`, 2048);
  if (asset.manifestBytes !== undefined) result.manifestBytes = requirePositiveInteger(asset.manifestBytes, `assets.${target}.manifestBytes`, LIMITS.maxManifestBytes);
  if (asset.materialBytes !== undefined) result.materialBytes = requirePositiveInteger(asset.materialBytes, `assets.${target}.materialBytes`, 1024 * 1024 * 1024);
  return Object.freeze(result);
}
export function validateRuntimeManifest(value) {
  const manifest = closedObject(value, "runtime manifest", ["schema", "version", "repository", "sourceContract", "runtimeToolSha256", "assets"]);
  if (manifest.schema !== RUNTIME_MANIFEST_SCHEMA || manifest.version !== VERSION || manifest.repository !== REPOSITORY || manifest.sourceContract !== SOURCE_CONTRACT) fail("runtime manifest identity fields are invalid");
  const runtimeToolSha256 = requireDigest(manifest.runtimeToolSha256, "runtime manifest runtimeToolSha256"); const assets = closedObject(manifest.assets, "runtime manifest.assets", TARGETS); const normalizedAssets = {};
  for (const target of TARGETS) normalizedAssets[target] = validateAsset(assets[target], target);
  const normalized = { schema: RUNTIME_MANIFEST_SCHEMA, version: VERSION, repository: REPOSITORY, sourceContract: SOURCE_CONTRACT, runtimeToolSha256, assets: normalizedAssets };
  return Object.freeze({ ...normalized, manifestIdentity: sha256(canonicalJson(normalized)) });
}
export function runtimeInputArguments(manifest, target) {
  if (!SAFE_TARGET.has(target)) fail("unsupported runtime target");
  const normalized = requireRecord(manifest, "runtime manifest");
  const asset = requireRecord(normalized.assets?.[target], `assets.${target}`);
  return Object.freeze({ target, archiveName: asset.archive.name, archiveBytes: asset.archive.bytes, archiveSha256: asset.archive.sha256, expectedMemberListSha256: asset.expectedMemberListSha256, expectedManifestSha256: asset.expectedManifestSha256, expectedMaterialDigest: asset.expectedMaterialDigest, correspondingSourceSha256: asset.correspondingSourceSha256, releaseAssetSha256: asset.releaseAssetSha256, runtimeToolSha256: normalized.runtimeToolSha256 });
}
async function readBoundedRegular(path, maxBytes, label) {
  let handle; try { handle = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW); } catch { fail(`${label} is not a regular file`); }
  try { const before = await handle.stat(); if (!before.isFile() || before.size < 1 || before.size > maxBytes) fail(`${label} size is outside bounds`); const bytes = await handle.readFile(); const after = await handle.stat(); if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail(`${label} changed while it was read`); return bytes; } finally { await handle.close(); }
}
export async function readRuntimeManifest(path, expectedSha256) {
  const bytes = await readBoundedRegular(path, LIMITS.maxManifestBytes, "runtime manifest"); const actual = sha256(bytes); if (actual !== requireDigest(expectedSha256, "runtime manifest sha256")) fail("runtime manifest byte digest mismatch"); let parsed; try { parsed = JSON.parse(bytes.toString("utf8")); } catch { fail("runtime manifest is not valid JSON"); } return Object.freeze({ ...validateRuntimeManifest(parsed), manifestSha256: actual });
}
async function writeExclusive(path, bytes, mode = 0o600) { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode); try { await handle.writeFile(bytes); } finally { await handle.close(); } }
async function writeJsonExclusive(path, value, mode = 0o600) { await writeExclusive(path, Buffer.from(`${canonicalJson(value)}\n`, "utf8"), mode); }
async function streamResponse(response, destination, maxBytes) {
  if (!response || response.status !== 200 || !response.body || typeof response.body[Symbol.asyncIterator] !== "function") fail("runtime asset GET did not return a bounded 200 response");
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 }); const handle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); const hash = createHash("sha256"); let bytes = 0;
  try { for await (const chunk of response.body) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += buffer.length; if (bytes > maxBytes) fail("runtime asset exceeded its declared byte bound"); hash.update(buffer); await handle.write(buffer); } await handle.close(); } catch (error) { await handle.close().catch(() => {}); await rm(destination, { force: true }); throw error; }
  return { bytes, sha256: hash.digest("hex") };
}
export async function fetchRuntimeAsset(asset, destination, token, fetchImpl = globalThis.fetch) {
  const initialUrl = expectedAssetUrl(asset.assetId); let currentUrl = validateReleaseUrl(initialUrl, initialUrl); let response;
  for (let hop = 0; hop <= LIMITS.maxRedirects; hop += 1) { const headers = { accept: "application/octet-stream" }; if (hop === 0 && token) headers.authorization = `Bearer ${token}`; response = await fetchImpl(currentUrl, { method: "GET", redirect: "manual", headers }); if (!response || typeof response.status !== "number") fail("runtime asset GET returned an invalid response"); if ([301, 302, 303, 307, 308].includes(response.status)) { if (hop === LIMITS.maxRedirects) fail("runtime asset GET exceeded redirect bound"); const location = typeof response.headers?.get === "function" ? response.headers.get("location") : null; if (typeof location !== "string" || location.length === 0) fail("runtime asset redirect has no Location header"); currentUrl = validateReleaseUrl(new URL(location, currentUrl).toString()); continue; } break; }
  const readback = await streamResponse(response, destination, asset.bytes); if (readback.bytes !== asset.bytes || readback.sha256 !== asset.sha256) { await rm(destination, { force: true }); fail(`runtime asset ${asset.name} failed exact size/SHA-256 readback`); } return Object.freeze({ ...asset, readback });
}
function requireRunIdentity(value, label) { if (!/^\d+$/u.test(String(value ?? "")) || Number(value) < 1) fail(`${label} is invalid`); return String(value); }
async function readJson(path, maxBytes, label) { const bytes = await readBoundedRegular(path, maxBytes, label); try { return JSON.parse(bytes.toString("utf8")); } catch { fail(`${label} is not valid JSON`); } }
function validateClosedInput(closed, receipt, asset, target, runtimeToolSha256) {
  const value = closedObject(closed, "closed runtime input", ["schema", "target", "runtimePrefix", "archive", "materialManifest", "descriptor", "sourceRootRelative", "maintainedRuntimeToolSha256", "authenticated", "productPayloadIncluded", "nativeExecution"]);
  if (value.schema !== "nebular070-public-hosted-runtime-input-closed-manifest-v2" || value.target !== target || value.runtimePrefix !== "opt/nebular-private" || value.sourceRootRelative !== "source" || value.authenticated !== true || value.productPayloadIncluded !== false || value.nativeExecution !== false || value.maintainedRuntimeToolSha256 !== runtimeToolSha256) fail("closed runtime input identity is invalid");
  const archive = closedObject(value.archive, "closed runtime input archive", ["filename", "bytes", "sha256", "expectedBytes", "expectedSha256", "memberCount", "memberListSha256", "expectedMemberListSha256", "paxHeadersRejected"]);
  if (archive.filename !== asset.archive.name || archive.bytes !== asset.archive.bytes || archive.sha256 !== asset.archive.sha256 || archive.expectedBytes !== asset.archive.bytes || archive.expectedSha256 !== asset.archive.sha256 || archive.memberListSha256 !== asset.expectedMemberListSha256 || archive.expectedMemberListSha256 !== asset.expectedMemberListSha256 || archive.paxHeadersRejected !== true) fail("closed runtime input archive does not match the release manifest");
  const material = closedObject(value.materialManifest, "closed runtime input material", ["path", "bytes", "sha256", "materialDigest"]); if (material.path !== "source/native-runtime.json" || material.sha256 !== asset.expectedManifestSha256 || material.materialDigest !== asset.expectedMaterialDigest) fail("closed runtime input material does not match the release manifest");
  const descriptor = closedObject(value.descriptor, "closed runtime input descriptor", ["path", "bytes", "sha256"]); if (descriptor.path !== "input/native-runtime-input.json" || !SHA256.test(descriptor.sha256) || descriptor.bytes < 1) fail("closed runtime input descriptor is invalid");
  const receiptValue = closedObject(receipt, "runtime input receipt", ["schema", "status", "target", "archive", "descriptor", "material", "evidence", "sourceRootRelative", "maintainedRuntimeToolSha256", "authentication", "productPayloadIncluded", "nativeExecution", "buildOrQualificationClaim"]);
  if (receiptValue.schema !== "nebular070-public-hosted-runtime-input-receipt-v2" || receiptValue.status !== "runtime-only-input-authenticated" || receiptValue.target !== target || receiptValue.sourceRootRelative !== "source" || receiptValue.maintainedRuntimeToolSha256 !== runtimeToolSha256 || receiptValue.productPayloadIncluded !== false || receiptValue.nativeExecution !== false || receiptValue.buildOrQualificationClaim !== false || receiptValue.authentication?.sourceSnapshotVerified !== true) fail("runtime input receipt is not an authenticated runtime-only receipt");
  const receiptArchive = closedObject(receiptValue.archive, "runtime input receipt archive", ["filename", "bytes", "expectedBytesSha256Verified", "sha256", "memberCount", "memberListSha256", "paxHeadersRejected"]);
  const receiptDescriptor = closedObject(receiptValue.descriptor, "runtime input receipt descriptor", ["path", "bytes", "sha256"]);
  const receiptMaterial = closedObject(receiptValue.material, "runtime input receipt material", ["path", "bytes", "sha256", "materialDigest", "regulars", "aliases", "directories"]);
  const receiptEvidence = closedObject(receiptValue.evidence, "runtime input receipt evidence", ["correspondingSourceCustody", "releaseAsset", "runtimeMaterialArchive", "runtimeMaterialManifest"]);
  if (receiptArchive.filename !== archive.filename || receiptArchive.bytes !== archive.bytes || receiptArchive.expectedBytesSha256Verified !== true || receiptArchive.sha256 !== archive.sha256 || receiptArchive.memberCount !== archive.memberCount || receiptArchive.memberListSha256 !== archive.memberListSha256 || receiptArchive.paxHeadersRejected !== true || receiptDescriptor.path !== descriptor.path || receiptDescriptor.bytes !== descriptor.bytes || receiptDescriptor.sha256 !== descriptor.sha256 || receiptMaterial.path !== material.path || receiptMaterial.bytes !== material.bytes || receiptMaterial.sha256 !== material.sha256 || receiptMaterial.materialDigest !== material.materialDigest || receiptEvidence.correspondingSourceCustody !== asset.correspondingSourceSha256 || receiptEvidence.releaseAsset !== asset.releaseAssetSha256 || receiptEvidence.runtimeMaterialArchive !== archive.sha256 || receiptEvidence.runtimeMaterialManifest !== material.sha256) fail("runtime input receipt evidence does not match the release manifest");
  return { descriptorSha256: descriptor.sha256, descriptorBytes: descriptor.bytes };
}
async function writeSourceOrigin({ manifestPath, manifestSha256, closedPath, receiptPath, sourceCommit, sourceTree, producerCommit, producerTree, output }) {
  const manifest = await readRuntimeManifest(manifestPath, manifestSha256); const closed = await readJson(closedPath, LIMITS.maxManifestBytes, "closed runtime input"); const receipt = await readJson(receiptPath, LIMITS.maxReceiptBytes, "runtime input receipt"); const target = requireString(closed.target, "closed runtime target"); if (!SAFE_TARGET.has(target)) fail("closed runtime target is invalid"); const asset = manifest.assets[target]; const local = validateClosedInput(closed, receipt, asset, target, manifest.runtimeToolSha256);
  const commit = requireString(sourceCommit, "source commit", COMMIT); const tree = requireString(sourceTree, "source tree", COMMIT); const producerSourceCommit = requireString(producerCommit, "producer commit", COMMIT); const producerSourceTree = requireString(producerTree, "producer tree", COMMIT); if (commit === producerSourceCommit && tree === producerSourceTree) fail("producer and product identities must remain distinct"); if (requireString(process.env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY") !== REPOSITORY) fail("source origin repository mismatch");
  const body = { schema: SOURCE_ORIGIN_SCHEMA, status: "pass", contract: SOURCE_CONTRACT, repository: REPOSITORY, version: VERSION, source: { commit, tree }, producer: { commit: producerSourceCommit, tree: producerSourceTree }, ci: { provider: "github-actions", origin: "public-hosted-runner", workflow: requireString(process.env.GITHUB_WORKFLOW, "GITHUB_WORKFLOW"), workflowPath: ".github/workflows/native-pypi-runtime.yml", runId: requireRunIdentity(process.env.GITHUB_RUN_ID, "GITHUB_RUN_ID"), runAttempt: requireRunIdentity(process.env.GITHUB_RUN_ATTEMPT, "GITHUB_RUN_ATTEMPT"), event: requireString(process.env.GITHUB_EVENT_NAME, "GITHUB_EVENT_NAME"), ref: requireString(process.env.GITHUB_REF, "GITHUB_REF") }, runtime: { target, manifestSha256: manifest.manifestSha256, manifestIdentity: manifest.manifestIdentity, runtimeToolSha256: manifest.runtimeToolSha256, archiveAssetId: asset.archive.assetId, archiveAssetName: asset.archive.name, archiveSha256: asset.archive.sha256, archiveBytes: asset.archive.bytes, expectedMemberListSha256: asset.expectedMemberListSha256, expectedManifestSha256: asset.expectedManifestSha256, expectedMaterialDigest: asset.expectedMaterialDigest, descriptorSha256: local.descriptorSha256, descriptorBytes: local.descriptorBytes, evidence: { correspondingSourceCustody: asset.correspondingSourceSha256, releaseAsset: asset.releaseAssetSha256, runtimeMaterialArchive: asset.archive.sha256, runtimeMaterialManifest: asset.expectedManifestSha256 } } };
  const result = { ...body, identity: sha256(canonicalJson(body)) }; await writeJsonExclusive(output, result, 0o644); return result;
}
export function validateSourceOrigin(value) {
  const origin = closedObject(value, "public source origin", ["schema", "status", "contract", "repository", "version", "source", "producer", "ci", "runtime", "identity"]); if (origin.schema !== SOURCE_ORIGIN_SCHEMA || origin.status !== "pass" || origin.contract !== SOURCE_CONTRACT || origin.repository !== REPOSITORY || origin.version !== VERSION) fail("public source origin is invalid");
  for (const role of ["source", "producer"]) { const pair = closedObject(origin[role], `public source origin.${role}`, ["commit", "tree"]); requireString(pair.commit, `${role}.commit`, COMMIT); requireString(pair.tree, `${role}.tree`, COMMIT); } if (origin.source.commit === origin.producer.commit && origin.source.tree === origin.producer.tree) fail("public source origin producer and product identities must remain distinct");
  const ci = closedObject(origin.ci, "public source origin.ci", ["provider", "origin", "workflow", "workflowPath", "runId", "runAttempt", "event", "ref"]); if (ci.provider !== "github-actions" || ci.origin !== "public-hosted-runner" || ci.workflowPath !== ".github/workflows/native-pypi-runtime.yml") fail("public source origin CI binding is invalid"); requireString(ci.workflow, "ci.workflow"); requireRunIdentity(ci.runId, "ci.runId"); requireRunIdentity(ci.runAttempt, "ci.runAttempt"); requireString(ci.event, "ci.event"); requireString(ci.ref, "ci.ref");
  const runtime = closedObject(origin.runtime, "public source origin.runtime", ["target", "manifestSha256", "manifestIdentity", "runtimeToolSha256", "archiveAssetId", "archiveAssetName", "archiveSha256", "archiveBytes", "expectedMemberListSha256", "expectedManifestSha256", "expectedMaterialDigest", "descriptorSha256", "descriptorBytes", "evidence"]); if (!SAFE_TARGET.has(runtime.target)) fail("runtime target is invalid"); for (const key of ["manifestSha256", "manifestIdentity", "runtimeToolSha256", "archiveSha256", "expectedMemberListSha256", "expectedManifestSha256", "expectedMaterialDigest", "descriptorSha256"]) requireDigest(runtime[key], `runtime.${key}`); if (!Number.isSafeInteger(runtime.archiveAssetId) || runtime.archiveAssetId < 1) fail("runtime archive asset ID is invalid"); requireString(runtime.archiveAssetName, "runtime archive asset name", SAFE_NAME); requirePositiveInteger(runtime.archiveBytes, "runtime archive bytes", LIMITS.maxArchiveBytes); requirePositiveInteger(runtime.descriptorBytes, "runtime descriptor bytes", LIMITS.maxManifestBytes); const evidence = closedObject(runtime.evidence, "runtime evidence", ["correspondingSourceCustody", "releaseAsset", "runtimeMaterialArchive", "runtimeMaterialManifest"]); for (const key of Object.keys(evidence)) requireDigest(evidence[key], `runtime.evidence.${key}`); const identity = requireDigest(origin.identity, "public source origin identity"); const { identity: ignored, ...body } = origin; if (sha256(canonicalJson(body)) !== identity) fail("public source origin identity does not bind its body"); return origin;
}
async function loadRuntimeApi(runtimeTool, runtimeToolSha256) { const bytes = await readBoundedRegular(runtimeTool, 16 * 1024 * 1024, "product native-runtime tool"); const actual = sha256(bytes); if (actual !== requireDigest(runtimeToolSha256, "product native-runtime tool sha256")) fail("product native-runtime tool SHA mismatch"); const runtime = await import(pathToFileURL(resolve(runtimeTool)).href); for (const key of ["inventoryNativePayload", "writeNativeRuntimeReceipt"]) if (typeof runtime[key] !== "function") fail(`product native-runtime tool is missing ${key}`); return runtime; }
async function writeRuntimeReceipt({ target, payload, input, inputSha256, sourceOrigin, output, runtimeTool, runtimeToolSha256 }) { const runtime = await loadRuntimeApi(runtimeTool, runtimeToolSha256); const origin = await readJson(sourceOrigin, LIMITS.maxManifestBytes, "public source origin"); validateSourceOrigin(origin); const material = await readJson(join(dirname(input), "../source/native-runtime.json"), LIMITS.maxManifestBytes, "runtime material manifest"); return runtime.writeNativeRuntimeReceipt(resolve(output), { target, material, sourceCandidate: origin.identity, payloadInventory: await runtime.inventoryNativePayload(resolve(payload), { expectedTarget: target }), inputSha256: requireDigest(inputSha256, "runtime input sha256") }); }
function digestFileSync(path) { const bytes = readFileSync(path); return { bytes: bytes.length, sha256: sha256(bytes) }; }
function reconstructPackagePayloadIdentity(manifest, materialDigest) {
  if (!Array.isArray(manifest.members)) fail("package manifest payload members are missing");
  const members = [];
  for (const member of manifest.members) {
    if (!isRecord(member) || typeof member.path !== "string") fail("package manifest contains an invalid payload member");
    if (!member.path.startsWith("payload/")) fail(`package member is outside payload: ${member.path}`);
    const path = member.path.slice("payload/".length);
    if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0") || posix.normalize(path) !== path) fail(`package payload member path is unsafe: ${member.path}`);
    members.push({ ...member, path });
  }
  const paths = new Set();
  for (const member of members) {
    if (paths.has(member.path)) fail(`duplicate package payload member ${member.path}`);
    paths.add(member.path);
  }
  const files = [];
  const directories = [];
  const aliases = [];
  for (const member of members) {
    if (member.type === "file") {
      if (!Number.isSafeInteger(member.size) || member.size < 0 || !SHA256.test(member.sha256 ?? "") || ![0o644, 0o755].includes(member.mode)) fail(`invalid package payload file ${member.path}`);
      files.push({ path: member.path, bytes: member.size, mode: member.mode, sha256: member.sha256 });
    } else if (member.type === "directory") {
      if (member.mode !== 0o755) fail(`invalid package payload directory ${member.path}`);
      directories.push({ path: member.path, mode: member.mode });
    } else if (member.type === "symlink") {
      if (typeof member.target !== "string" || !member.target || member.target.startsWith("/") || member.target.includes("\\") || member.target.includes("\0")) fail(`invalid package payload alias ${member.path}`);
      aliases.push({ path: member.path, target: member.target });
    } else fail(`unsupported package payload member type ${member.type}`);
  }
  const sortPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  files.sort(sortPath); directories.sort(sortPath); aliases.sort(sortPath);
  const projection = manifest.runtimeAliasProjection ?? null;
  if (manifest.schema === "tfsb.nebular-package-manifest-v2") {
    if (!isRecord(projection) || projection.schema !== "nebular-native-runtime-alias-projection-v1" || !SHA256.test(projection.materialDigest ?? "") || !SHA256.test(projection.digest ?? "") || !Array.isArray(projection.aliases)) fail("package runtime alias projection is malformed");
    const projectedPaths = new Set();
    for (const entry of projection.aliases) {
      if (!isRecord(entry) || typeof entry.path !== "string" || typeof entry.target !== "string" || typeof entry.canonical !== "string" || !Number.isSafeInteger(entry.bytes) || ![0o644, 0o755].includes(entry.mode) || !SHA256.test(entry.sha256 ?? "")) fail("package runtime alias projection entry is malformed");
      projectedPaths.add(entry.path);
      const copied = files.find((file) => file.path === entry.path);
      if (!copied || copied.bytes !== entry.bytes || copied.mode !== entry.mode || copied.sha256 !== entry.sha256) fail(`package runtime alias regular copy mismatch: ${entry.path}`);
      aliases.push({ path: entry.path, target: entry.target, canonical: entry.canonical });
    }
    if (sha256(canonicalJson({ schema: projection.schema, materialDigest: projection.materialDigest, aliases: projection.aliases })) !== projection.digest) fail("package runtime alias projection digest mismatch");
    for (let index = files.length - 1; index >= 0; index -= 1) if (projectedPaths.has(files[index].path)) files.splice(index, 1);
    aliases.sort(sortPath);
  } else if (projection !== null) fail("legacy package manifest unexpectedly carries runtime alias projection");
  const regulars = new Set(files.map((entry) => entry.path));
  const dirs = new Set(directories.map((entry) => entry.path));
  const aliasTargets = new Map(aliases.map((entry) => [entry.path, entry.target]));
  const resolveAlias = (aliasPath) => {
    const seen = new Set(); let current = aliasPath;
    while (aliasTargets.has(current)) {
      if (seen.has(current)) fail(`package payload alias cycle at ${aliasPath}`);
      seen.add(current);
      const next = posix.normalize(posix.join(posix.dirname(current), aliasTargets.get(current)));
      if (next === "." || next.startsWith("../") || next === "..") fail(`package payload alias escapes at ${aliasPath}`);
      if (regulars.has(next)) return next;
      if (dirs.has(next)) fail(`package payload alias targets a directory at ${aliasPath}`);
      if (!aliasTargets.has(next)) fail(`package payload alias target is missing at ${aliasPath}`);
      current = next;
    }
    fail(`package payload alias target is missing at ${aliasPath}`);
  };
  if (!SHA256.test(materialDigest ?? "")) fail("qualification materialDigest is invalid");
  if (projection !== null && projection.materialDigest !== materialDigest) fail("package runtime alias projection material digest differs from qualification");
  const canonicalAliases = aliases.map((entry) => ({ ...entry, canonical: resolveAlias(entry.path) }));
  const payload = { schema: "nebular-native-payload-inventory-v1", materialDigest, files, aliases: canonicalAliases, directories };
  return { identity: sha256(canonicalJson(payload)), files: files.length, materialDigest };
}

export function validateReleaseInputs({ platform, origin, runtime, qualified, built, record, manifest, packageManifest, smokeRuns = [] }) {
  const binding = PLATFORM_BINDINGS[platform];
  if (!binding) fail("unsupported Linux release platform");
  if (!isRecord(runtime) || !isRecord(qualified) || !isRecord(built) || !isRecord(record) || !isRecord(manifest) || runtime.schema !== "nebular-native-runtime-material-receipt-v1" || qualified.schema !== "nebular.native-rc-qualification-v1" || qualified.status !== "pass" || built.schema !== "nebular.native-rc-build-receipt-v1") fail("release receipt input schemas/status are invalid");
  if (origin.runtime.target !== binding.target || runtime.target !== binding.target || qualified.platform !== platform || built.platform !== platform || built.triple !== binding.target || record.platform !== platform) fail("release evidence target/platform join is invalid");
  if (runtime.sourceCandidate !== origin.identity) fail("runtime sourceCandidate is not the source-origin identity");
  if (built.source?.commit !== origin.source.commit || built.source?.tree !== origin.source.tree) fail("build source does not match the public source origin");
  if (!SHA256.test(qualified.executableSha256 ?? "") || !SHA256.test(runtime.inputSha256 ?? "") || !isRecord(qualified.nativePayload) || !SHA256.test(qualified.nativePayload.identity ?? "") || !Number.isSafeInteger(qualified.nativePayload.files) || qualified.nativePayload.files < 1) fail("qualification nativePayload is invalid");
  if (runtime.materialDigest !== qualified.materialDigest || runtime.nativePayload !== qualified.nativePayload.identity) fail("runtime receipt does not match qualification material/payload");
  if (!isRecord(built.nativePayload) || built.nativePayload.identity !== qualified.nativePayload.identity || built.nativePayload.files !== qualified.nativePayload.files) fail("build and qualification native payload identities differ");
  if (!isRecord(record.raw) || !isRecord(record.npm) || !isRecord(manifest) || !["tfsb.nebular-package-manifest-v1", "tfsb.nebular-package-manifest-v2"].includes(manifest.schema)) fail("release package inputs are invalid");
  if (manifest.package !== binding.package || manifest.version !== VERSION || manifest.target?.os !== "linux" || manifest.target?.cpu !== binding.cpu || manifest.payloadRoot !== "payload" || manifest.executable !== binding.executable || manifest.payloadStatus !== "complete" || !Array.isArray(manifest.members) || manifest.fileCount !== manifest.members.length) fail("package manifest platform identity is invalid");
  if (typeof packageManifest !== "string" || digestFileSync(packageManifest).sha256 !== record.packageManifestSha256) fail("package manifest digest differs from the package record");
  if (!SAFE_NAME.test(record.raw.filename ?? "") || !SAFE_NAME.test(record.npm.filename ?? "") || !Number.isSafeInteger(record.raw.size) || record.raw.size < 1 || !Number.isSafeInteger(record.npm.size) || record.npm.size < 1 || !SHA256.test(record.raw.sha256 ?? "") || !SHA256.test(record.npm.sha256 ?? "") || record.npm.integrity !== sriForSha256(record.npm.sha256) || record.raw.executableSha256 !== qualified.executableSha256) fail("package record does not bind the qualified executable and exact archives");
  const manifestExecutable = manifest.members?.find((member) => member.path === binding.executable);
  if (manifestExecutable?.sha256 !== qualified.executableSha256) fail("package manifest executable is not the qualified executable");
  const packagePayload = reconstructPackagePayloadIdentity(manifest, qualified.materialDigest);
  if (packagePayload.identity !== qualified.nativePayload.identity || packagePayload.files !== qualified.nativePayload.files) fail("package and qualification native payload identities differ");
  const seen = new Set();
  for (const run of smokeRuns) {
    if (!isRecord(run) || run.status !== "pass" || !binding.scenarios.includes(run.scenario) || !["raw-archive", "npm-package"].includes(run.source) || run.executable?.sha256 !== qualified.executableSha256) fail("smoke evidence does not bind a passing qualified executable");
    seen.add(run.scenario);
  }
  for (const scenario of binding.scenarios) if (!seen.has(scenario)) fail(`required smoke scenario ${scenario} is missing`);
  if (!smokeRuns.some((run) => run.source === "raw-archive") || !smokeRuns.some((run) => run.source === "npm-package")) fail("smoke evidence did not cover raw and npm sources");
  return { packagePayload, scenarios: [...seen].sort() };
}

async function writeReleaseReceipt({ platform, sourceOrigin, runtimeReceipt, qualification, buildReceipt, packageRecord, packageManifest, smokeDir, output }) {
  const origin = await readJson(sourceOrigin, LIMITS.maxManifestBytes, "public source origin"); validateSourceOrigin(origin);
  const runtime = await readJson(runtimeReceipt, LIMITS.maxReceiptBytes, "native runtime receipt"); const qualified = await readJson(qualification, LIMITS.maxReceiptBytes, "qualification receipt"); const built = await readJson(buildReceipt, LIMITS.maxReceiptBytes, "build receipt"); const record = await readJson(packageRecord, LIMITS.maxReceiptBytes, "package record"); const manifest = await readJson(packageManifest, LIMITS.maxReceiptBytes, "package manifest");
  const smoke = []; const smokeRuns = [];
  if (smokeDir) for (const entry of (await readdir(resolve(smokeDir), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile()) fail("smoke evidence contains a non-regular member");
    const path = join(resolve(smokeDir), entry.name); smoke.push({ name: entry.name, ...digestFileSync(path) });
    if (entry.name.endsWith(".run.json")) smokeRuns.push(await readJson(path, LIMITS.maxReceiptBytes, `smoke run ${entry.name}`));
  }
  validateReleaseInputs({ platform, origin, runtime, qualified, built, record, manifest, packageManifest, smokeRuns });
  const body = { schema: RELEASE_RECEIPT_SCHEMA, status: "pass", contract: "public-pypi-portable-runtime-v1", repository: REPOSITORY, version: VERSION, platform, sourceOrigin: origin.identity, source: origin.source, producer: origin.producer, runtime: { target: runtime.target, materialDigest: runtime.materialDigest, sourceCandidate: runtime.sourceCandidate, nativePayload: runtime.nativePayload, inputSha256: runtime.inputSha256 }, qualification: { sha256: digestFileSync(qualification).sha256, identity: qualified.identity ?? null }, build: { sha256: digestFileSync(buildReceipt).sha256, identity: built.identity ?? null }, package: { recordSha256: digestFileSync(packageRecord).sha256, manifestSha256: digestFileSync(packageManifest).sha256, raw: { filename: record.raw.filename, bytes: record.raw.size, sha256: record.raw.sha256 }, npm: { filename: record.npm.filename, bytes: record.npm.size, sha256: record.npm.sha256, integrity: record.npm.integrity } }, smoke };
  const result = { ...body, identity: sha256(canonicalJson(body)) }; await writeJsonExclusive(output, result, 0o644); return result;
}
function argMap(args) { const values = new Map(); for (let i = 0; i < args.length; i += 2) { const key = args[i]; const value = args[i + 1]; if (!key?.startsWith("--") || value === undefined || values.has(key)) fail("invalid or duplicate CLI argument"); values.set(key, value); } return values; }
function need(values, key) { const value = values.get(key); if (!value) fail(`${key} is required`); return value; }
function positiveIntegerArgument(value, label) { if (!/^\d+$/u.test(value) || Number(value) < 1 || !Number.isSafeInteger(Number(value))) fail(`${label} is invalid`); return Number(value); }
const invokedDirectly = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (invokedDirectly) {
  const [mode, ...args] = process.argv.slice(2);
  try {
    const values = argMap(args); let result;
    if (mode === "fetch-manifest") { const digest = requireDigest(need(values, "--sha256"), "--sha256"); const asset = { assetId: positiveIntegerArgument(need(values, "--asset-id"), "--asset-id"), name: `nebular-runtime-input-manifest-${VERSION}.json`, bytes: positiveIntegerArgument(need(values, "--bytes"), "--bytes"), sha256: digest, integrity: sriForSha256(digest) }; result = await fetchRuntimeAsset(asset, need(values, "--output"), process.env.GITHUB_TOKEN ?? ""); process.stdout.write(`${JSON.stringify(result.readback)}\n`); }
    else if (mode === "fetch-runtime-archive") { const manifest = await readRuntimeManifest(need(values, "--manifest"), need(values, "--manifest-sha256")); const target = need(values, "--target"); if (!SAFE_TARGET.has(target)) fail("unsupported runtime target"); result = await fetchRuntimeAsset(manifest.assets[target].archive, need(values, "--output"), process.env.GITHUB_TOKEN ?? ""); process.stdout.write(`${JSON.stringify(result.readback)}\n`); }
    else if (mode === "runtime-input-args") { const manifest = await readRuntimeManifest(need(values, "--manifest"), need(values, "--manifest-sha256")); process.stdout.write(`${JSON.stringify(runtimeInputArguments(manifest, need(values, "--target")))}\n`); }
    else if (mode === "source-origin") { result = await writeSourceOrigin({ manifestPath: need(values, "--manifest"), manifestSha256: need(values, "--manifest-sha256"), closedPath: need(values, "--closed"), receiptPath: need(values, "--receipt"), sourceCommit: need(values, "--source-commit"), sourceTree: need(values, "--source-tree"), producerCommit: need(values, "--producer-commit"), producerTree: need(values, "--producer-tree"), output: need(values, "--output") }); process.stdout.write(`${JSON.stringify({ identity: result.identity, target: result.runtime.target })}\n`); }
    else if (mode === "runtime-receipt") { result = await writeRuntimeReceipt({ target: need(values, "--target"), payload: need(values, "--payload"), input: need(values, "--input"), inputSha256: need(values, "--input-sha256"), sourceOrigin: need(values, "--source-origin"), output: need(values, "--output"), runtimeTool: need(values, "--runtime-tool"), runtimeToolSha256: need(values, "--runtime-tool-sha256") }); process.stdout.write(`${JSON.stringify({ schema: result.schema, target: result.target, materialDigest: result.materialDigest })}\n`); }
    else if (mode === "release-receipt") { result = await writeReleaseReceipt({ platform: need(values, "--platform"), sourceOrigin: need(values, "--source-origin"), runtimeReceipt: need(values, "--runtime-receipt"), qualification: need(values, "--qualification"), buildReceipt: need(values, "--build-receipt"), packageRecord: need(values, "--package-record"), packageManifest: need(values, "--package-manifest"), smokeDir: values.get("--smoke-dir"), output: need(values, "--output") }); process.stdout.write(`${JSON.stringify({ schema: result.schema, identity: result.identity, platform: result.platform })}\n`); }
    else fail("usage: fetch-manifest | runtime-input-args | fetch-runtime-archive | source-origin | runtime-receipt | release-receipt");
  } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
