#!/usr/bin/env node

// Private campaign controller for the held, source-mode macOS native lane.
//
// This file intentionally contains no repository-specific build implementation.
// It is an orchestration boundary around the maintained tools and the separately
// reviewed input/bridge modules.  Commands are fixed argv calls, never shell
// strings.  The returned record is path-free and does not retain child output.

import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import { createChildProcessPort } from "./host-inputs.mjs";
import { classifyBuildOutput, validateBuildDiagnostic, INPUT_ARCHIVE_SHA256 } from "./build-failure-diagnostics.mjs";
import {
  APPEARANCE_P_OPERATIONS,
  APPEARANCE_RESULT_SCHEMA as LEGACY_APPEARANCE_RESULT_SCHEMA,
  APPEARANCE_STEPS,
  appearanceSmokeInvocation,
} from "./appearance-orchestration.mjs";
import {
  APPEARANCE_CSSOM_PROFILE,
  APPEARANCE_CSSOM_RESULT_SCHEMA,
  annotateAppearanceSmokeReceipt,
  formatAppearanceSmokeFailure,
  legacyAppearanceEvidenceProjection,
  runExplicitAppearanceCssomP,
  validateAppearanceCssomEvidence,
} from "./appearance-cssom-controller.mjs";

export { APPEARANCE_CSSOM_PROFILE, APPEARANCE_CSSOM_RESULT_SCHEMA,
  runExplicitAppearanceCssomP, validateAppearanceCssomEvidence };
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  lstat,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, basename, join, relative, resolve, sep, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CONTROLLER_SCHEMA = "nebular.source-native-campaign66-controller-v1";
export const EVIDENCE_SCHEMA = "nebular.source-native-campaign66-material-evidence-v1";
export const REPOSITORY = "Knowledge-Forge-AI/theme-forge-nebular-fusion";
export const REVIEWED_REF = "refs/heads/qualification/appearance-cssom-20261117";
export const TARGET = "darwin-arm64";
export const TRIPLE = "aarch64-apple-darwin";
export const CANDIDATE_VERSION = "0.6.1";
export const RETENTION_DAYS = 14;
export const CSSOM_ARCHIVE_PATH = "authenticated-inputs/source-native/native-material-inputs62.tar.gz";
export const CSSOM_ARCHIVE_SHA256 = "a3c3217b35c14ca9c08e58729133fe9670ebe39e64e081d1ee49a4a51034861e";
export const CSSOM_ARCHIVE_BYTES = 8975368;
export const MAX_COMMAND_OUTPUT = 256 * 1024;
export const COMMAND_TIMEOUT_MS = 1_800_000;
export const COMMAND_KILL_GRACE_MS = 2_000;

export const PHASES = Object.freeze([
  "guard",
  "bootstrap-python-readback",
  "bootstrap-extract",
  "archive-member-bridge",
  "bootstrap-verifier-copy",
  "toolchain-install",
  "toolchain-readback",
  "bootstrap-node-auth",
  "prepare-host-inputs",
  "build-candidate",
  "test-list-guard",
  "native-tests",
  "payload-path-scan",
  "qualify",
  "package",
  "smoke",
  "bridge-source-receipt",
  "nested-packaging-seal",
  "public-evidence",
]);

export const REQUIRED_INSTALLED_MODE_TESTS = Object.freeze([
  "sidecar::artifact::tests::installed_modes_allow_only_exact_or_complete_write_bit_removal",
  "sidecar::artifact::tests::installed_modes_accept_exact_and_readonly_verification",
  "sidecar::artifact::tests::installed_modes_reject_other_modes_bytes_and_inventory",
  "sidecar::artifact::tests::installed_modes_revalidate_retained_identity",
]);
export const REQUIRED_SOURCE_PIN_TESTS = Object.freeze([
  "sidecar::artifact::tests::source_build_scene_and_loom_pins_use_closed_typed_bindings",
  "sidecar::artifact::tests::source_build_compiled_pins_reject_resealed_native_identity",
]);

export const REQUIRED_MATERIAL_TESTS = Object.freeze([
  "release_smoke::tests::material_selection_is_single_use_and_not_a_directory_override",
  "release_smoke::io::tests::material_fixture_rejects_links_modes_empty_large_and_nonregular_entries",
]);
export const REQUIRED_APPEARANCE_TESTS = Object.freeze([
  "appearance_preferences::contract::tests::record_accepts_valid_optional_fields_and_omission",
  "appearance_preferences::contract::tests::explicit_null_is_rejected_but_unknown_fields_are_also_closed",
  "appearance_preferences::contract::tests::version_and_family_id_validation_are_bounded",
  "appearance_preferences::contract::tests::family_id_bound_matches_javascript_utf16_length",
  "appearance_preferences::contract::tests::replies_are_closed_tagged_records",
  "appearance_preferences::storage::tests::before_rename_hook_is_used_by_the_product_commit_path",
  "appearance_preferences::tests::unavailable_state_returns_closed_replies_without_a_filesystem_root",
  "appearance_preferences::tests::native_state_round_trips_only_its_fixed_preference_leaf",
  "release_smoke::tests::appearance_preferences_refuses_all_pickers",
]);
// The policy integration binary is a separate Cargo test target.  Keep its
// names closed and independent of the lib-test selectors: the list is observed
// before execution and the exact same names are required in the receipt.
//
// The current source capsule contains these ten policy tests.  A future source
// refresh must change this allowlist and its bound list result together; a
// missing or extra test is a hard refusal, never a best-effort count.
export const REQUIRED_POLICY_TESTS = Object.freeze([
  "smoke_selector_requires_explicit_feature_gate",
  "release_smoke_filesystem_authority_is_confined_to_its_owner",
  "appearance_preference_storage_owner_is_confined_to_its_leaf",
  "production_source_has_no_broad_native_authority",
  "recursive_scanner_detects_a_synthetic_forbidden_module",
  "recursive_scanner_detects_a_missing_expected_file",
  "launcher_remains_trivial",
  "scene_runner_test_fields_do_not_truncate_production_scan",
  "single_maintained_native_source_inventory_is_exact_and_complete",
  "app_theme_payload_authentication_owner_is_confined",
]);
const MATERIAL_STEPS = Object.freeze(["material-shell", "material-open-v2", "material-controls", "material-preview-light", "material-preview-dark", "material-invalidated", "material-recompile", "material-reset"]);
const APPEARANCE_FAILURE_STAGES = Object.freeze([...APPEARANCE_STEPS.map(({ id }) => id), "driver"]);

const MATERIAL_FAILURE_REASONS = new Set(["CONFIG_REJECTED", "STAGE_TIMEOUT", "CONTROL_REJECTED", "CUSTODY_REJECTED", "PREVIEW_REJECTED", "INTERNAL_FAILURE"]);
const MATERIAL_FAILURE_STAGES = [...MATERIAL_STEPS, "material-driver"];

/** Labels are untrusted hints from one fixed public fixture, never failure disposition. */
export function annotateMaterialSmokeFailure(error, receipt, source) {
  if (!(error instanceof CampaignError)) return error;
  try {
    if (!["raw-archive", "npm-package"].includes(source) || receipt?.schema !== "nebular.release-smoke-receipt-v1"
      || receipt.scenario !== "M" || receipt.status !== "fail" || receipt.driver?.scenario !== "M"
      || !Array.isArray(receipt.driver.steps) || receipt.driver.steps.length > 9) return error;
    const failed = receipt.driver.steps.find(step=>step?.ok === false);
    if (!failed || !MATERIAL_FAILURE_STAGES.includes(failed.id) || !MATERIAL_FAILURE_REASONS.has(failed.detail)) return error;
    error.materialSmokeSource = source;
    error.materialSmokeStage = failed.id;
    error.materialSmokeReason = failed.detail;
  } catch { /* Malformed or partial diagnostic state must not replace the refusal. */ }
  return error;
}

// Fixed call-site labels identify the command that refused, never its private argv.
export const SMOKE_OPERATIONS = Object.freeze([
  "RAW_EXTRACT", "NPM_EXTRACT", "NPM_VERIFY", "RAW_A", "NPM_A", "RAW_M", "NPM_M", "RAW_P", "NPM_P",
]);
const SMOKE_RECEIPT_STATES = new Set(["UNAVAILABLE", "REJECTED", "PASS", "FAIL"]);
const CORE_A_STEPS = Object.freeze(["app-shell", "host-start", "host-status", "project-open", "brand-read", "theme-lab-compile", "app-theme-status", "app-theme-compile", "brand-system-view", "host-status-final", "driver"]);
function smokeInvocation(operation) {
  if (operation === "RAW_A" || operation === "NPM_A") return {scenario:"A",source:operation === "RAW_A" ? "raw-archive" : "npm-package",stages:CORE_A_STEPS};
  if (operation === "RAW_M" || operation === "NPM_M") return {scenario:"M",source:operation === "RAW_M" ? "raw-archive" : "npm-package",stages:MATERIAL_FAILURE_STAGES};
  const appearance = appearanceSmokeInvocation(operation);
  if (appearance) return {scenario: appearance.scenario, source: appearance.source, stages: APPEARANCE_FAILURE_STAGES};
  return null;
}

/** No messages, paths, step details, facts or child streams are projected. */
export function annotateSmokeReceipt(error, receipt, operation) {
  if (!(error instanceof CampaignError) || error.code !== "SMOKE_FAILED") return error;
  const invocation = smokeInvocation(operation);
  if (!invocation) return error;
  error.smokeReceiptState = "REJECTED";
  try {
    if (receipt?.schema !== "nebular.release-smoke-receipt-v1" || receipt.scenario !== invocation.scenario
      || !["pass", "fail"].includes(receipt.status)) return error;
    error.smokeReceiptState = receipt.status === "pass" ? "PASS" : "FAIL";
    if (receipt.status !== "fail" || receipt.driver?.scenario !== invocation.scenario
      || !Array.isArray(receipt.driver.steps) || receipt.driver.steps.length > invocation.stages.length) return error;
    const failed = receipt.driver.steps.find(step => step?.ok === false);
    if (failed && invocation.stages.includes(failed.id)) error.smokeDriverStage = failed.id;
    if (invocation.scenario === "M") annotateMaterialSmokeFailure(error, receipt, invocation.source);
    if (invocation.scenario === "P") {
      annotateAppearanceSmokeReceipt(error, receipt, operation);
      if (error.appearanceSmokeStage) error.smokeDriverStage = error.appearanceSmokeStage;
      if (error.appearanceSmokeReason) error.smokeDriverReason = error.appearanceSmokeReason;
    }
  } catch { /* Untrusted or partial receipts cannot mask the original exception. */ }
  return error;
}

/** Preserve the identical rejection; receipt loading occurs only after a failed launch. */
export async function runSmokeOperation(operation, execute, loadReceipt = null) {
  try { return await execute(); }
  catch (error) {
    if (error instanceof CampaignError && error.code === "SMOKE_FAILED" && SMOKE_OPERATIONS.includes(operation)) {
      error.smokeOperation = operation;
      if (smokeInvocation(operation) && typeof loadReceipt === "function") {
        error.smokeReceiptState = "UNAVAILABLE";
        try { annotateSmokeReceipt(error, await loadReceipt(), operation); } catch { /* no raw diagnostics */ }
      }
    }
    throw error;
  }
}

/** Accept exactly the two source-bound M runs, without forwarding raw receipt text. */
export function validateMaterialSmokeRuns(runs, executableSha256) {
  if (!Array.isArray(runs) || runs.length !== 2 || !SHA256.test(executableSha256)) fail("PUBLIC_MATERIAL_SMOKE");
  const expected = ["raw-archive", "npm-package"];
  if (new Set(runs.map(row=>row?.source)).size !== 2 || expected.some(source=>!runs.some(row=>row?.source===source))) fail("PUBLIC_MATERIAL_SMOKE");
  const records = [];
  for (const run of runs) {
    if (run?.schema !== "nebular.native-rc-smoke-run-v1" || run.platform !== TARGET || run.scenario !== "M" || run.status !== "pass"
      || run.executable?.sha256 !== executableSha256 || !Array.isArray(run.problems) || run.problems.length !== 0
      || run.receipt?.status !== "pass" || !SHA256.test(run.receipt?.sha256 ?? "")
      || run.checks?.materialSourceUnchanged !== true
      || !Array.isArray(run.checks?.orphans) || run.checks.orphans.length !== 0
      || !Array.isArray(run.checks?.persistentUserState?.changed) || run.checks.persistentUserState.changed.length !== 0) fail("PUBLIC_MATERIAL_SMOKE");
    const steps=run.receipt.steps;
    if (!Array.isArray(steps) || steps.length !== MATERIAL_STEPS.length
      || steps.some((row,index)=>row?.id !== MATERIAL_STEPS[index] || row.ok !== true || row.via !== "dom")) fail("PUBLIC_MATERIAL_SMOKE");
    records.push({source:run.source,receiptSha256:run.receipt.sha256,stepsPassed:steps.length,sourceUnchanged:true});
  }
  return Object.freeze({status:"passed-process-observation",runs:records,visualTranslucency:"not-claimed"});
}

const TEST_LIST_STAGES = new Set(["INSTALLED_MODES", "SOURCE_PINS"]);
const DIAGNOSTIC_COMMAND_PHASES = new Set(["build-candidate", "test-list-installed-modes", "test-list-source-pins"]);

const SHA256 = /^[a-f0-9]{64}$/u;
const SHA1 = /^[a-f0-9]{40}$/u;
const SAFE_ENV = new Set([
  "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "CARGO_HOME", "RUSTUP_HOME",
  "CARGO_TARGET_DIR", "npm_config_cache", "npm_config_offline", "npm_config_userconfig",
  "npm_config_globalconfig", "npm_config_update_notifier", "npm_config_fund",
  "npm_config_audit", "CARGO_NET_OFFLINE", "RUSTC", "CARGO", "CC", "PKG_CONFIG",
  "NEBULAR_BUILD_INPUTS", "NEBULAR_BUILD_MODE", "SOURCE_DATE_EPOCH", "LANG", "LC_ALL",
  "SDKROOT", "MACOSX_DEPLOYMENT_TARGET", "DEVELOPER_DIR", "NIX_CC", "NIX_BINTOOLS",
  "PKG_CONFIG_PATH", "PKG_CONFIG_LIBDIR", "NIX_CFLAGS_COMPILE", "NIX_LDFLAGS",
  "CARGO_ENCODED_RUSTFLAGS", "GITHUB_ACTIONS",
  "RUNNER_OS", "RUNNER_ARCH", "RUNNER_TEMP", "GITHUB_REPOSITORY", "GITHUB_REF",
  "GITHUB_REF_NAME", "GITHUB_REF_TYPE", "GITHUB_EVENT_NAME", "GITHUB_RUN_ID",
  "GITHUB_RUN_ATTEMPT", "ImageOS", "ImageVersion", "NEBULAR_RC_PACKAGES_SHA256",
  "GITHUB_WORKSPACE", "GITHUB_SHA",
]);
const FORBIDDEN_PROGRAMS = new Set(["bash", "sh", "zsh", "fish", "codesign", "security", "notarytool", "gh", "curl", "wget"]);
const ALLOWED_PROGRAM_BASENAMES = new Set(["node", "node-authenticated", "python", "python3", "python3.13", "rustup", "rustc", "cargo", "tar"]);
const SCRIPT_NAMES = new Set([
  "unpack-native-inputs.py", "node-runtime-authority.mjs", "host-inputs.mjs",
  "native-candidate-build.mjs", "native-rc-qualify.mjs", "native-rc-package.mjs",
  "native-rc-smoke.mjs", "native-rc-evidence.mjs", "native-rc-plan.mjs",
  "bridge-archive-members.mjs", "source-receipt-bridge.mjs", "assert-native-tests51.mjs",
  "candidate-provenance.mjs", "build-inputs.mjs", "fs-snapshot.mjs", "material-profile-admission.mjs",
  "maintained-api.mjs",
]);

function isSafeEnvironmentKey(key) {
  return SAFE_ENV.has(key) || /^NIX_CC_WRAPPER_TARGET_[A-Za-z0-9_]+$/u.test(key);
}

export class CampaignError extends Error {
  constructor(code) {
    super(`SOURCE_NATIVE_${code}`);
    this.name = "CampaignError";
    this.code = code;
  }
}

function fail(code) {
  throw new CampaignError(code);
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype);
}

function absolute(value, code) {
  if (typeof value !== "string" || !value || !value.startsWith("/") || value.includes("\0")) fail(code);
  return resolve(value);
}

function digest(value, code = "DIGEST") {
  if (typeof value !== "string" || !SHA256.test(value)) fail(code);
  return value;
}

function commit(value, code = "COMMIT") {
  if (typeof value !== "string" || !SHA1.test(value)) fail(code);
  return value;
}

function safePublicRelative(value, code) {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("\\") || value.includes("\0")
      || value.split("/").some((part) => !part || part === "." || part === "..")) fail(code);
  return value;
}

function safeArtifactName(value, code) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(value) || value.includes("..")) fail(code);
  return value;
}

export function validatePackageRecord(record) {
  if (!isRecord(record) || record.schema !== "nebular.native-rc-package-v1" || record.platform !== TARGET || record.version !== CANDIDATE_VERSION
      || !isRecord(record.raw) || !isRecord(record.npm) || !SHA256.test(record.packageManifestSha256 ?? "")) fail("PACKAGE_RECORD");
  const raw = safeArtifactName(record.raw.filename, "PACKAGE_RECORD");
  const npm = safeArtifactName(record.npm.filename, "PACKAGE_RECORD");
  if (!raw.endsWith(".tar.gz") || !npm.endsWith(".tgz") || !SHA256.test(record.raw.sha256 ?? "") || !SHA256.test(record.npm.sha256 ?? "")) fail("PACKAGE_RECORD");
  return { ...record, raw: { ...record.raw, filename: raw }, npm: { ...record.npm, filename: npm } };
}

function executable(value, expected, code) {
  const path = absolute(value, code);
  if (FORBIDDEN_PROGRAMS.has(basename(path)) || (expected && basename(path) !== expected)) fail(code);
  return path;
}

function script(value, code) {
  const path = absolute(value, code);
  if (!SCRIPT_NAMES.has(basename(path))) fail(code);
  return path;
}

function noPrivateEnvironment(env) {
  if (!isRecord(env)) fail("ENVIRONMENT");
  for (const [key, value] of Object.entries(env)) {
    if (!isSafeEnvironmentKey(key) || typeof value !== "string" || value.includes("\0")) fail("ENVIRONMENT");
  }
  return { ...env };
}

export function validateWorkflowContext(env = process.env) {
  if (!isRecord(env) && typeof env !== "object") fail("ENVIRONMENT");
  if (env.GITHUB_ACTIONS !== "true"
      || env.GITHUB_EVENT_NAME !== "workflow_dispatch"
      || env.GITHUB_REPOSITORY !== REPOSITORY
      || env.GITHUB_REF !== REVIEWED_REF
      || env.RUNNER_OS !== "macOS"
      || env.RUNNER_ARCH !== "ARM64") fail("RUNNER_GUARD");
  absolute(env.RUNNER_TEMP, "RUNNER_TEMP");
  if (env.GITHUB_REF_TYPE !== undefined && env.GITHUB_REF_TYPE !== "branch") fail("RUNNER_REF");
  return {
    repository: REPOSITORY,
    ref: REVIEWED_REF,
    event: "workflow_dispatch",
    runner: "macos-15-arm64",
  };
}

function requirePathMap(paths) {
  if (!isRecord(paths)) fail("SPEC_PATHS");
  for (const [key, value] of Object.entries(paths)) absolute(value, `SPEC_PATH_${key.toUpperCase()}`);
  return paths;
}

function validateTools(tools) {
  if (!isRecord(tools)) fail("SPEC_TOOLS");
  for (const key of ["node", "bootstrapNode", "python", "rustup", "cargo", "npmCli", "tar"]) {
    const expected = key === "python" ? /^python(?:3(?:\.13)?)?$/u : key === "tar" ? /^tar$/u : key === "rustup" ? /^rustup$/u : key === "cargo" ? /^cargo$/u : key === "npmCli" ? /^npm-cli\.js$/u : /^(?:node|node-authenticated)$/u;
    const path = executable(tools[key], undefined, `SPEC_TOOL_${key.toUpperCase()}`);
    if (!expected.test(basename(path))) fail(`SPEC_TOOL_${key.toUpperCase()}`);
  }
  for (const key of ["unpack", "hostInputs", "evidence", "plan", "memberBridge", "sourceBridge", "guard", "maintainedApi"]) {
    script(tools[key], `SPEC_SCRIPT_${key.toUpperCase()}`);
  }
  return tools;
}

/** Validate a private spec before any child process is spawned. */
export function validateSpec(spec, env = process.env) {
  if (!isRecord(spec) || spec.schema !== CONTROLLER_SCHEMA || spec.repository !== REPOSITORY || spec.ref !== REVIEWED_REF) fail("SPEC");
  validateWorkflowContext(env);
  const requiredContext=["HOME","GITHUB_ACTIONS","GITHUB_EVENT_NAME","GITHUB_REPOSITORY","GITHUB_REF","GITHUB_REF_TYPE","RUNNER_OS","RUNNER_ARCH","RUNNER_TEMP","GITHUB_WORKSPACE","GITHUB_RUN_ID","GITHUB_RUN_ATTEMPT","GITHUB_SHA"];
  if (!isRecord(spec.env) || requiredContext.some(key=>typeof spec.env[key]!=="string" || !spec.env[key])) fail("CONTEXT_SNAPSHOT");
  if (!isRecord(spec.env) || Object.entries(spec.env).some(([key,value]) => env[key] !== value)) fail("LIVE_ENVIRONMENT_MISMATCH");
  if (env.HOME !== userInfo().homedir) fail("LIVE_RUNNER_HOME");
  requirePathMap(spec.paths);
  validateTools(spec.tools);
  if (!isRecord(spec.inputs)) fail("SPEC_INPUTS");
  absolute(spec.inputs.archive, "SPEC_ARCHIVE");
  digest(spec.inputs.archiveSha256, "SPEC_ARCHIVE_DIGEST");
  safePublicRelative(spec.inputs.archivePath, "SPEC_ARCHIVE_PATH");
  if (spec.inputs.archivePath !== CSSOM_ARCHIVE_PATH) fail("SPEC_ARCHIVE_PATH");
  if (!isRecord(spec.inputs.verifier) || !isRecord(spec.inputs.verifier.binding) || !isRecord(spec.inputs.verifier.tarball)) fail("SPEC_VERIFIER");
  absolute(spec.inputs.verifier.binding.path, "SPEC_VERIFIER_BINDING");
  absolute(spec.inputs.verifier.tarball.path, "SPEC_VERIFIER_TARBALL");
  digest(spec.inputs.verifier.tarball.sha256, "SPEC_VERIFIER_DIGEST");
  if (spec.inputs.verifier.tarball.sha256 !== "2900c3a0119eb134dc88257b873f53fa499df8e8e02ebb61301bd2378c9cc22b") fail("SPEC_VERIFIER_DIGEST");
if (spec.inputs.archiveSha256 !== CSSOM_ARCHIVE_SHA256) fail("SPEC_ARCHIVE_DIGEST");
if (spec.inputs.archiveBytes !== CSSOM_ARCHIVE_BYTES) fail("SPEC_ARCHIVE_SIZE");
  if (!isRecord(spec.host)) fail("SPEC_HOST");
  for (const key of ["spec", "bridge", "receipt", "locator"]) absolute(spec.host[key], `SPEC_HOST_${key.toUpperCase()}`);
  if (!isRecord(spec.source) || typeof spec.source.commit !== "string") fail("SPEC_SOURCE");
  commit(spec.source.commit);
  if (env.GITHUB_SHA !== spec.source.commit) fail("SOURCE_COMMIT");
  absolute(spec.source.checkout, "SPEC_SOURCE_CHECKOUT");
  if (!isRecord(spec.output)) fail("SPEC_OUTPUT");
  for (const key of ["extractionReceipt", "archiveManifest", "bundleManifest", "legacyObservation", "bridgeDir", "plan", "nestedReceipt", "nestedSeal", "qualification", "packageRecord", "packageManifest", "publicEvidence", "publicDir", "smokeDir"]) absolute(spec.output[key], `SPEC_OUTPUT_${key.toUpperCase()}`);
  absolute(spec.paths.authenticatedNode, "SPEC_AUTHENTICATED_NODE");
  if (basename(spec.paths.authenticatedNode) !== "node-authenticated") fail("SPEC_AUTHENTICATED_NODE");
  absolute(spec.paths.bootstrapTools, "SPEC_BOOTSTRAP_TOOLS");
  absolute(spec.paths.publicDir, "SPEC_PUBLIC_DIR");
  if (!pathInside(spec.paths.bootstrapExtracted, spec.paths.bootstrapStudio)
      || !pathInside(spec.paths.bootstrapExtracted, spec.paths.bootstrapTools)) fail("SPEC_BOOTSTRAP_LAYOUT");
  const campaignRoot = dirname(spec.paths.bootstrapRoot);
  if (!pathInside(env.RUNNER_TEMP, campaignRoot)) fail("SPEC_CAMPAIGN_ROOT");
  for (const path of [...Object.values(spec.paths), ...Object.values(spec.output), spec.host.spec, spec.host.receipt, spec.host.locator]) {
    if (!pathInside(campaignRoot, path)) fail("SPEC_WRITE_SCOPE");
  }
  for (const path of [spec.inputs.archive, spec.inputs.verifier.binding.path, spec.inputs.verifier.tarball.path, spec.host.bridge]) {
    if (!pathInside(spec.source.checkout, path)) fail("SPEC_READ_SCOPE");
  }
  for (const name of ["unpack","hostInputs","sourceBridge","memberBridge","guard","maintainedApi"]) {
    if (!pathInside(spec.source.checkout,spec.tools[name])) fail("SPEC_SCRIPT_SCOPE");
  }
  for (const name of ["evidence","plan"]) {
    if (!pathInside(spec.paths.bootstrapTools,spec.tools[name])) fail("SPEC_SCRIPT_SCOPE");
  }
  const childEnv = noPrivateEnvironment(spec.commandEnv);
  for (const key of requiredContext.filter(key=>key!=="HOME")) {
    if (childEnv[key]!==env[key]) fail("COMMAND_CONTEXT");
  }
  for (const [key, expected] of Object.entries({HOME:spec.paths.rustHome,TMPDIR:spec.paths.tmp,TMP:spec.paths.tmp,TEMP:spec.paths.tmp,CARGO_HOME:spec.paths.cargoHome,RUSTUP_HOME:spec.paths.rustupHome})) {
    if (childEnv[key] !== expected) fail("SPEC_FRESH_ENVIRONMENT");
  }
  if (spec.candidateVersion !== CANDIDATE_VERSION || spec.releaseVersion !== null) fail("SPEC_VERSION");
  if (spec.retentionDays !== RETENTION_DAYS) fail("SPEC_RETENTION");
  return spec;
}

async function readBounded(path, maxBytes, code) {
  absolute(path, code);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile() || before.size > maxBytes) fail(code);
    const buffer = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, null);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    if (offset !== before.size || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
        || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail(code);
    return buffer;
  } catch (error) {
    if (error instanceof CampaignError) throw error;
    fail(code);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readJson(path, code = "JSON") {
  const bytes = await readBounded(path, 16 * 1024 * 1024, code);
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { fail(code); }
  if (text.charCodeAt(0) === 0xfeff) fail(code);
  try { return JSON.parse(text); } catch { fail(code); }
}

// Full P receipts are bound to the bytes observed after the native harness
// closes them. The raw bytes never leave this controller; only the digest and
// closed receipt projection are passed to the appearance helper.
async function readJsonWithDigest(path, code = "JSON") {
  const bytes = await readBounded(path, 16 * 1024 * 1024, code);
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { fail(code); }
  if (text.charCodeAt(0) === 0xfeff) fail(code);
  let value;
  try { value = JSON.parse(text); } catch { fail(code); }
  return Object.freeze({ receipt: value, sha256: createHash("sha256").update(bytes).digest("hex") });
}

async function writeExclusiveJson(path, value, code = "WRITE") {
  absolute(path, code);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  } catch {
    fail(code);
  }
}

async function copyRegularExclusive(source, destination, code) {
  const sourceInfo = await lstat(source).catch(() => null);
  if (!sourceInfo || !sourceInfo.isFile()) fail(code);
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true, mode: 0o700 }).catch(() => fail(code));
  try {
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    await chmod(destination, 0o600);
  } catch {
    fail(code);
  }
  const outputInfo = await lstat(destination).catch(() => null);
  if (!outputInfo?.isFile() || outputInfo.nlink !== 1 || outputInfo.uid !== sourceInfo.uid) fail(code);
}

async function prepareFreshRoots(spec) {
  await mkdir(dirname(spec.paths.bootstrapRoot), { recursive: true, mode: 0o700 }).catch(() => fail("PRIVATE_DIR"));
  for (const path of [spec.paths.bootstrapRoot, spec.paths.upload, spec.paths.smoke,
    spec.paths.rustHome, spec.paths.rustupHome, spec.paths.cargoHome, spec.paths.tmp, spec.paths.nodeDownload]) {
    await mkdir(path, { recursive: false, mode: 0o700 }).catch(() => fail("FRESH_ROOT"));
  }
  for (const path of [spec.paths.authenticatedNode, spec.paths.nodeReceipt]) {
    if (await lstat(path).then(() => true).catch(() => false)) fail("FRESH_ROOT");
  }
  const parents = new Set([
    spec.host.spec, spec.host.receipt, spec.host.locator,
    ...Object.entries(spec.output).filter(([key]) => key !== "bundleManifest").map(([, value]) => value),
  ].map(dirname));
  for (const path of parents) await mkdir(path, { recursive: true, mode: 0o700 }).catch(() => fail("PRIVATE_DIR"));
}

function scrubEnvironment(environment) {
  const result = noPrivateEnvironment(environment);
  for (const key of Object.keys(result)) {
    if (/TOKEN|SECRET|PASSWORD|COOKIE|PRIVATE|CREDENTIAL|KEY/u.test(key)) fail("ENVIRONMENT");
  }
  return result;
}

function commandName(program) {
  return basename(program);
}

function validateCommand(program, args, cwd, environment) {
  absolute(program, "COMMAND_PROGRAM");
  if (FORBIDDEN_PROGRAMS.has(commandName(program)) || !ALLOWED_PROGRAM_BASENAMES.has(commandName(program))
      || !Array.isArray(args) || args.some((value) => typeof value !== "string" || value.includes("\0"))) fail("COMMAND");
  absolute(cwd, "COMMAND_CWD");
  scrubEnvironment(environment);
}

/**
 * No-shell child boundary.  Only byte counts/statuses are returned.  Optional
 * capture is transient and must be consumed by the caller before public
 * evidence is written; raw child text is never placed in a result record.
 */
export async function runFixedCommand({ program, args, cwd, env, timeoutMs = COMMAND_TIMEOUT_MS, capture = "none", phase, spawnImpl = spawn, buildDiagnosticRoots = [] }) {
  validateCommand(program, args, cwd, env);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > COMMAND_TIMEOUT_MS) fail("COMMAND_TIMEOUT");
  if (!["none", "text", "json"].includes(capture)) fail("COMMAND_CAPTURE");
  const chunks = [];
  const buildChunks = [];
  const collectBuildDiagnostic = DIAGNOSTIC_COMMAND_PHASES.has(phase) && Array.isArray(buildDiagnosticRoots) && buildDiagnosticRoots.length === 2;
  let stdoutBytes = 0, stderrBytes = 0;
  const port = createChildProcessPort({ timeoutMs, killGraceMs: COMMAND_KILL_GRACE_MS, spawnImpl: (p, argv, options) => {
    const child = spawnImpl(p, argv, options);
    child.stdout?.on("data", data => {
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
      stdoutBytes += bytes.length;
      if (collectBuildDiagnostic) {
        const available = Math.max(0, MAX_COMMAND_OUTPUT - (stdoutBytes - bytes.length));
        if (available) chunks.push(Buffer.from(bytes.subarray(0, available)));
      } else if (capture !== "none" && stdoutBytes <= MAX_COMMAND_OUTPUT) chunks.push(Buffer.from(bytes));
    });
    child.stderr?.on("data", data => {
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
      stderrBytes += bytes.length;
      if (collectBuildDiagnostic) {
        const available = Math.max(0, MAX_COMMAND_OUTPUT - (stderrBytes - bytes.length));
        if (available) buildChunks.push(Buffer.from(bytes.subarray(0, available)));
      }
    });
    return child;
  }});
  const result = await port.run({ program, args, cwd, env, maxOutputBytes: MAX_COMMAND_OUTPUT, timeoutMs });
  const output = { ...result, stdoutBytes, stderrBytes };
  if (!result.failure && result.cleanup === "leader-close-observed" && capture !== "none") {
    try {
      const text = new TextDecoder("utf-8", {fatal:true}).decode(Buffer.concat(chunks));
      if (capture === "text") output.text = text;
      else output.json = JSON.parse(text);
    } catch {
      // Diagnostic capture must preserve this phase's old exit-zero semantics.
      if (!(phase === "prepare-host-inputs" && result.exitCode === 0)) output.failure = "INVALID_RESULT";
    }
  }
  if (collectBuildDiagnostic && (result.failure != null || result.exitCode !== 0 || result.cleanup !== "leader-close-observed")) {
    const partial = stdoutBytes > MAX_COMMAND_OUTPUT || stderrBytes > MAX_COMMAND_OUTPUT || result.cleanup !== "leader-close-observed" || result.failure != null || result.signal != null;
    try {
      output.buildDiagnostic = classifyBuildOutput({stdout:Buffer.concat(chunks),stderr:Buffer.concat(buildChunks),roots:buildDiagnosticRoots,partial});
    } catch {
      output.buildDiagnostic = {schema:"nebular-build-failure-hints-v1",markers:["DIAGNOSTIC_INPUT_REFUSED"],rustCodes:[],systemCodes:[],sites:[],flags:{longLine:false,unmappedSite:false,partial}};
    }
  }
  return Object.freeze(output);
}

function resultOk(result, code) {
  if (!isRecord(result) || (result.failure !== null && result.failure !== undefined) || result.exitCode !== 0 || result.cleanup !== "leader-close-observed") fail(code);
  return result;
}

// Only exact known refusal names from the frozen host preparer may be public.
// JSON remains transient; neither messages, raw streams nor private values escape.
const HOST_PREPARATION_REFUSALS = new Set([
  "HOST_INPUT_API_ARCHIVE_PORT",
  "HOST_INPUT_API_COMMAND_PORT",
  "HOST_INPUT_ARCHIVE_PORT",
  "HOST_INPUT_BRIDGE",
  "HOST_INPUT_BUILD_INPUTS_WRITE",
  "HOST_INPUT_BUNDLE",
  "HOST_INPUT_BUNDLE_ARCHIVE",
  "HOST_INPUT_BUNDLE_COMPONENT",
  "HOST_INPUT_BUNDLE_EXTRACT",
  "HOST_INPUT_BUNDLE_INVENTORY",
  "HOST_INPUT_BUNDLE_LAYOUT",
  "HOST_INPUT_BUNDLE_MANIFEST",
  "HOST_INPUT_BUNDLE_MANIFEST_PATH",
  "HOST_INPUT_CARGO_CONFIG",
  "HOST_INPUT_CARGO_CONFIG_WRITE",
  "HOST_INPUT_CARGO_FETCH_COMMAND",
  "HOST_INPUT_CARGO_FETCH_FAILED",
  "HOST_INPUT_CARGO_FETCH_OUTPUT_LIMIT",
  "HOST_INPUT_CARGO_FETCH_TIMEOUT",
  "HOST_INPUT_CARGO_LOCATORS",
  "HOST_INPUT_CARGO_REMAP",
  "HOST_INPUT_CARGO_SOURCE",
  "HOST_INPUT_CLI_MODE",
  "HOST_INPUT_COMMAND_LIMIT",
  "HOST_INPUT_COMPONENT_DIGEST",
  "HOST_INPUT_COMPONENT_OUTPUT",
  "HOST_INPUT_COMPONENT_PACKAGE",
  "HOST_INPUT_COMPONENT_SOURCE",
  "HOST_INPUT_COMPONENT_SOURCES",
  "HOST_INPUT_COPY",
  "HOST_INPUT_DESTINATION",
  "HOST_INPUT_EMBEDDED_RUNTIME",
  "HOST_INPUT_ENVIRONMENT",
  "HOST_INPUT_INTERNAL",
  "HOST_INPUT_LOCATOR_WRITE",
  "HOST_INPUT_MAINTAINED_API",
  "HOST_INPUT_MATERIAL_BINDING",
  "HOST_INPUT_NPM_FRONTEND_COMMAND",
  "HOST_INPUT_NPM_FRONTEND_FAILED",
  "HOST_INPUT_NPM_FRONTEND_OUTPUT",
  "HOST_INPUT_NPM_FRONTEND_OUTPUT_LIMIT",
  "HOST_INPUT_NPM_FRONTEND_TIMEOUT",
  "HOST_INPUT_NPM_PREVIEW_COMMAND",
  "HOST_INPUT_NPM_PREVIEW_FAILED",
  "HOST_INPUT_NPM_PREVIEW_OUTPUT",
  "HOST_INPUT_NPM_PREVIEW_OUTPUT_LIMIT",
  "HOST_INPUT_NPM_PREVIEW_TIMEOUT",
  "HOST_INPUT_PREVIEW_PACKAGE",
  "HOST_INPUT_PREVIEW_SOURCE",
  "HOST_INPUT_PRODUCER_IDENTITY",
  "HOST_INPUT_RECEIPT_WRITE",
  "HOST_INPUT_RUNNER_GUARD",
  "HOST_INPUT_RUNNER_TEMP",
  "HOST_INPUT_RUSTUP_HOME",
  "HOST_INPUT_RUSTUP_ROOT",
  "HOST_INPUT_RUST_TARGET_LIB",
  "HOST_INPUT_SDKROOT",
  "HOST_INPUT_SPEC",
  "HOST_INPUT_STAGING_PATH_COVERAGE",
  "HOST_INPUT_STUDIO_DIGEST",
  "HOST_INPUT_STUDIO_INVENTORY",
  "HOST_INPUT_STUDIO_PACKAGE",
  "HOST_INPUT_TOOLCHAINS",
  "HOST_INPUT_TOOLCHAIN_CARGO",
  "HOST_INPUT_TOOLCHAIN_COMPILER",
  "HOST_INPUT_TOOLCHAIN_LINKER",
  "HOST_INPUT_TOOLCHAIN_NODE",
  "HOST_INPUT_TOOLCHAIN_NPM",
  "HOST_INPUT_TOOLCHAIN_OBSERVATION",
  "HOST_INPUT_TOOLCHAIN_PKGCONFIG",
  "HOST_INPUT_TOOLCHAIN_RUST",
  "HOST_INPUT_TOOLCHAIN_SYSTEMLIBRARIES",
  "HOST_INPUT_USAGE",
  "HOST_INPUT_WORKSPACE"
]);
export function hostPreparationFailureCode(result) {
  const fallback = "PREPARE_HOST_INPUTS_FAILED";
  if (!isRecord(result) || result.failure != null || result.cleanup !== "leader-close-observed"
      || ![1, 2, 3].includes(result.exitCode) || !isRecord(result.json)) return fallback;
  const keys = Object.keys(result.json).sort();
  if (keys.length !== 2 || keys[0] !== "code" || keys[1] !== "status"
      || result.json.status !== "refused" || !HOST_PREPARATION_REFUSALS.has(result.json.code)) return fallback;
  const expectedExit = result.json.code === "HOST_INPUT_USAGE" ? 2 : result.json.code === "HOST_INPUT_INTERNAL" ? 3 : 1;
  if (result.exitCode !== expectedExit) return fallback;
  return `PREPARE_HOST_INPUTS_${result.json.code}`;
}

// A closed process category supplements the existing failure code. Child text,
// OS errors, paths, argv and environment are never rendered by this boundary.
const PREPARATION_BOUNDARIES = new Set([
  "INCOHERENT_RESULT", "UNCONFIRMED_CLEANUP", "PORT_LIMIT", "SPAWN_FAILURE",
  "CHILD_ERROR", "TIMEOUT", "OUTPUT_LIMIT", "INVALID_RESULT",
  "UNKNOWN_PROCESS_FAILURE", "ACCEPTED_INNER_REFUSAL", "COMPLETED",
  "SIGNALED", "UNACCEPTED_NONZERO",
]);

export function hostPreparationBoundary(result) {
  if (!isRecord(result)) return "INCOHERENT_RESULT";
  if (result.cleanup !== "leader-close-observed") return "UNCONFIRMED_CLEANUP";
  if (result.failure != null) {
    // JSON decoding after a signal can itself report INVALID_RESULT. Preserve
    // the stronger already-recorded signal observation without changing it.
    if (result.failure === "INVALID_RESULT" && result.exitCode === null
        && typeof result.signal === "string" && result.signal.length > 0) return "SIGNALED";
    const names = new Map([
      ["LIMIT", "PORT_LIMIT"], ["SPAWN", "SPAWN_FAILURE"], ["ERROR", "CHILD_ERROR"],
      ["TIMEOUT", "TIMEOUT"], ["OUTPUT_LIMIT", "OUTPUT_LIMIT"], ["INVALID_RESULT", "INVALID_RESULT"],
    ]);
    return names.get(result.failure) ?? "UNKNOWN_PROCESS_FAILURE";
  }
  if (hostPreparationFailureCode(result) !== "PREPARE_HOST_INPUTS_FAILED") return "ACCEPTED_INNER_REFUSAL";
  // Prep's existing exit-zero behavior deliberately defers locator validation.
  if (result.exitCode === 0) return "COMPLETED";
  if (result.exitCode === null && typeof result.signal === "string" && result.signal.length > 0) return "SIGNALED";
  if (Number.isInteger(result.exitCode) && result.exitCode !== 0) return "UNACCEPTED_NONZERO";
  return "INCOHERENT_RESULT";
}

// Build cause and cleanup are separate observations. Frozen builders can launch
// detached inner groups; unconfirmed cleanup must not erase a known stop cause.
export function buildProcessBoundary(result) {
  if (!isRecord(result)) return "INCOHERENT_RESULT";
  if (result.failure != null) {
    const names = new Map([
      ["LIMIT", "PORT_LIMIT"], ["SPAWN", "SPAWN_FAILURE"], ["ERROR", "CHILD_ERROR"],
      ["TIMEOUT", "TIMEOUT"], ["OUTPUT_LIMIT", "OUTPUT_LIMIT"], ["INVALID_RESULT", "INVALID_RESULT"],
    ]);
    return names.get(result.failure) ?? "UNKNOWN_PROCESS_FAILURE";
  }
  if (result.exitCode === 0) return "COMPLETED";
  if (result.exitCode === null && typeof result.signal === "string" && result.signal.length > 0) return "SIGNALED";
  if (Number.isInteger(result.exitCode) && result.exitCode !== 0) return "UNACCEPTED_NONZERO";
  return "INCOHERENT_RESULT";
}

export function requirePhaseResult(result, phase) {
  try {
    return resultOk(result, phase === "prepare-host-inputs" ? hostPreparationFailureCode(result) : `${phase.replaceAll("-", "_").toUpperCase()}_FAILED`);
  } catch (error) {
    if (phase === "prepare-host-inputs" && error instanceof CampaignError) {
      error.preparationBoundary = hostPreparationBoundary(result);
    }
    if (phase === "smoke" && error instanceof CampaignError) {
      error.smokeBoundary = buildProcessBoundary(result);
      error.smokeCleanupUnconfirmed = result?.cleanup !== "leader-close-observed";
    }
    if (phase === "build-candidate" && error instanceof CampaignError) {
      error.buildBoundary = buildProcessBoundary(result);
      error.buildCleanupUnconfirmed = result?.cleanup !== "leader-close-observed";
      const diagnostic = validateBuildDiagnostic(result?.buildDiagnostic);
      if (diagnostic) error.buildDiagnostic = diagnostic;
    }
    throw error;
  }
}

export function requireTestListCommandResult(result, stage) {
  try {
    return resultOk(result, "TEST_LIST_GUARD");
  } catch (error) {
    const label = stage === "installed-modes" ? "INSTALLED_MODES" : stage === "source-pins" ? "SOURCE_PINS" : null;
    if (error instanceof CampaignError && label !== null) {
      error.testListStage = label;
      error.testListBoundary = buildProcessBoundary(result);
      error.testListCleanupUnconfirmed = result?.cleanup !== "leader-close-observed";
      const diagnostic = validateBuildDiagnostic(result?.buildDiagnostic);
      if (diagnostic) error.testListDiagnostic = diagnostic;
    }
    throw error;
  }
}

const PAYLOAD_SCAN_REASONS = new Set(["PREFIX_MATCH", "SYMLINK_ESCAPE", "INVALID_PREFIX_SET", "UNSUPPORTED_MEMBER", "IO_FAILURE", "UNCLASSIFIED"]);
const PAYLOAD_SCAN_IO_CODES = new Set(["ENOENT", "EACCES", "ENOTDIR", "ELOOP", "EMFILE", "ENFILE", "EIO", "ENOSPC"]);

function ownDiagnosticString(error, key) {
  try {
    if ((typeof error !== "object" && typeof error !== "function") || error === null) return null;
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    return descriptor && Object.hasOwn(descriptor, "value") && typeof descriptor.value === "string" ? descriptor.value : null;
  } catch { return null; }
}

const PAYLOAD_MEMBER_CLASSES = new Set(["GUI_EXECUTABLE", "SIDECAR_RUNTIME", "SIDECAR_RESOURCE", "LOOM_RESOURCE", "SOLAR_RESOURCE", "SCENE_RESOURCE", "RELEASE_NOTICE", "OTHER_BUNDLE_RESOURCE", "OTHER_BUNDLE_MEMBER", "UNCLASSIFIED"]);
const PAYLOAD_PREFIX_SOURCES = ["CAMPAIGN_ROOT", "BUILD_INPUT_PARENT", "RUNNER_TEMP", "RUNNER_HOME", "CHECKOUT"];

export function payloadMatchLabels(error, prefixes) {
  const labels = { memberClass: "UNCLASSIFIED", prefixSource: "UNCLASSIFIED" };
  try {
    const message = ownDiagnosticString(error, "message");
    const marker = "Shipped member retains a known build-path prefix: ";
    if (!message?.startsWith(marker)) return labels;
    if (message.length > marker.length + 4096) return labels;
    const name = message.slice(marker.length);
    const parts = name.split("/");
    const safe = name.length > 0 && name.length <= 4096 && /^[\x20-\x7e]+$/.test(name)
      && !name.includes("\\") && parts.every(part => part !== "" && part !== "." && part !== "..");
    if (safe) {
      const bundle = "Theme Forge Nebular Fusion.app/Contents/";
      if (name === bundle + "MacOS/theme-forge-nebular-fusion") labels.memberClass = "GUI_EXECUTABLE";
      else if (name === bundle + "MacOS/tfsb-studio-service") labels.memberClass = "SIDECAR_RUNTIME";
      else if (name.startsWith(bundle + "Resources/")) {
        const resource = name.slice((bundle + "Resources/").length);
        labels.memberClass = "OTHER_BUNDLE_RESOURCE";
        for (const [prefix, category] of [["sidecar-payload/", "SIDECAR_RESOURCE"], ["loom-payload/", "LOOM_RESOURCE"], ["loom-adapter/", "LOOM_RESOURCE"], ["solar-sail-payload/", "SOLAR_RESOURCE"], ["solar-sail-adapter/", "SOLAR_RESOURCE"], ["scene-payload/", "SCENE_RESOURCE"], ["release-notices/", "RELEASE_NOTICE"]]) {
          if (resource.startsWith(prefix)) { labels.memberClass = category; break; }
        }
      } else if (name.startsWith(bundle)) labels.memberClass = "OTHER_BUNDLE_MEMBER";
    }
    const descriptor = Object.getOwnPropertyDescriptor(error, "knownPrefixIndex");
    const index = descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : null;
    if (!Number.isInteger(index) || index < 0 || index >= 10 || !Array.isArray(prefixes) || prefixes.length !== 5) return labels;
    const needles = [], owners = [];
    for (let i = 0; i < prefixes.length; i++) {
      const prefix = prefixes[i];
      if (!prefix) continue;
      if (typeof prefix !== "string" || prefix.length > 4096) return labels;
      for (const spelling of [prefix, resolve(prefix)]) {
        if (!needles.includes(spelling)) { needles.push(spelling); owners.push(PAYLOAD_PREFIX_SOURCES[i]); }
      }
    }
    if (index < owners.length) labels.prefixSource = owners[index];
  } catch { /* Untrusted metadata must never replace the existing refusal. */ }
  return labels;
}

export function payloadPathScanFailure(error, stage, prefixes) {
  const failure = new CampaignError("PAYLOAD_PATH_SCAN");
  if (stage === "MODULE") {
    failure.payloadScanStage = "MODULE";
    failure.payloadScanReason = "MODULE_UNAVAILABLE";
  } else if (stage === "SCAN") {
    const message = ownDiagnosticString(error, "message");
    const code = ownDiagnosticString(error, "code");
    let reason = "UNCLASSIFIED";
    if (message?.startsWith("Shipped member retains a known build-path prefix: ")) reason = "PREFIX_MATCH";
    else if (message === "Shipped symlink escapes artifact") reason = "SYMLINK_ESCAPE";
    else if (message === "Explicit build-path prefixes required") reason = "INVALID_PREFIX_SET";
    else if (message === "Shipped special member is unsupported") reason = "UNSUPPORTED_MEMBER";
    else if (PAYLOAD_SCAN_IO_CODES.has(code)) reason = "IO_FAILURE";
    failure.payloadScanStage = "SCAN";
    failure.payloadScanReason = reason;
    if (reason === "PREFIX_MATCH" && prefixes !== undefined) {
      const location = payloadMatchLabels(error, prefixes);
      failure.payloadMemberClass = location.memberClass;
      failure.payloadPrefixSource = location.prefixSource;
    }
  }
  return failure;
}

export function formatCampaignFailure(error) {
  const code = error instanceof CampaignError ? error.code : "INTERNAL";
  const boundary = error instanceof CampaignError && PREPARATION_BOUNDARIES.has(error.preparationBoundary)
    ? `\nSOURCE_NATIVE_PREPARATION_BOUNDARY_${error.preparationBoundary}` : "";
  const diagnostic = error instanceof CampaignError ? validateBuildDiagnostic(error.buildDiagnostic) : null;
  const buildBoundary = error instanceof CampaignError && PREPARATION_BOUNDARIES.has(error.buildBoundary)
    ? `\nSOURCE_NATIVE_BUILD_BOUNDARY_${error.buildBoundary}` : "";
  const buildCleanup = error instanceof CampaignError && error.buildCleanupUnconfirmed === true
    ? "\nSOURCE_NATIVE_BUILD_CLEANUP_UNCONFIRMED" : "";
  const testFailure = error instanceof CampaignError && error.code === "TEST_LIST_GUARD" && TEST_LIST_STAGES.has(error.testListStage);
  const testStage = testFailure ? `\nSOURCE_NATIVE_TEST_LIST_STAGE_${error.testListStage}` : "";
  const testBoundary = testFailure && PREPARATION_BOUNDARIES.has(error.testListBoundary)
    ? `\nSOURCE_NATIVE_TEST_LIST_BOUNDARY_${error.testListBoundary}` : "";
  const testCleanup = testFailure && error.testListCleanupUnconfirmed === true
    ? "\nSOURCE_NATIVE_TEST_LIST_CLEANUP_UNCONFIRMED" : "";
  const testDiagnostic = testFailure ? validateBuildDiagnostic(error.testListDiagnostic) : null;
  const testHints = testDiagnostic ? `\nSOURCE_NATIVE_TEST_LIST_DIAGNOSTIC ${JSON.stringify(testDiagnostic)}` : "";
  const payloadPair = error instanceof CampaignError && error.code === "PAYLOAD_PATH_SCAN"
    && ((error.payloadScanStage === "MODULE" && error.payloadScanReason === "MODULE_UNAVAILABLE")
      || (error.payloadScanStage === "SCAN" && PAYLOAD_SCAN_REASONS.has(error.payloadScanReason)));
  const payloadHint = payloadPair ? `\nSOURCE_NATIVE_PAYLOAD_SCAN_STAGE_${error.payloadScanStage}\nSOURCE_NATIVE_PAYLOAD_SCAN_REASON_${error.payloadScanReason}` : "";
  const locationPair = payloadPair && error.payloadScanStage === "SCAN" && error.payloadScanReason === "PREFIX_MATCH"
    && PAYLOAD_MEMBER_CLASSES.has(error.payloadMemberClass)
    && (PAYLOAD_PREFIX_SOURCES.includes(error.payloadPrefixSource) || error.payloadPrefixSource === "UNCLASSIFIED");
  const locationHint = locationPair ? `\nSOURCE_NATIVE_PAYLOAD_MEMBER_CLASS_${error.payloadMemberClass}\nSOURCE_NATIVE_PAYLOAD_PREFIX_SOURCE_${error.payloadPrefixSource}` : "";
  const materialPair = error instanceof CampaignError
    && ["raw-archive", "npm-package"].includes(error.materialSmokeSource)
    && MATERIAL_FAILURE_STAGES.includes(error.materialSmokeStage)
    && MATERIAL_FAILURE_REASONS.has(error.materialSmokeReason);
  const materialHint = materialPair
    ? `\nSOURCE_NATIVE_MATERIAL_SOURCE_${error.materialSmokeSource === "raw-archive" ? "RAW_ARCHIVE" : "NPM_PACKAGE"}\nSOURCE_NATIVE_MATERIAL_STAGE_${error.materialSmokeStage}\nSOURCE_NATIVE_MATERIAL_REASON_${error.materialSmokeReason}` : "";
  const smokeFailure = error instanceof CampaignError && error.code === "SMOKE_FAILED"
    && SMOKE_OPERATIONS.includes(error.smokeOperation);
  const smokeOperation = smokeFailure ? `\nSOURCE_NATIVE_SMOKE_OPERATION_${error.smokeOperation}` : "";
  const smokeBoundary = smokeFailure && PREPARATION_BOUNDARIES.has(error.smokeBoundary)
    ? `\nSOURCE_NATIVE_SMOKE_BOUNDARY_${error.smokeBoundary}` : "";
  const smokeCleanup = smokeFailure && error.smokeCleanupUnconfirmed === true
    ? "\nSOURCE_NATIVE_SMOKE_CLEANUP_UNCONFIRMED" : "";
  const invocation = smokeFailure ? smokeInvocation(error.smokeOperation) : null;
  const smokeReceipt = invocation && SMOKE_RECEIPT_STATES.has(error.smokeReceiptState)
    ? `\nSOURCE_NATIVE_SMOKE_RECEIPT_${error.smokeReceiptState}` : "";
  const smokeStage = smokeReceipt && error.smokeReceiptState === "FAIL" && invocation.stages.includes(error.smokeDriverStage)
    ? `\nSOURCE_NATIVE_SMOKE_DRIVER_STAGE_${error.smokeDriverStage}` : "";
  const appearanceFailure = smokeFailure && invocation?.scenario === "P" && error.appearanceSmokeOperation
    ? `\n${formatAppearanceSmokeFailure(error)}` : "";
  return `SOURCE_NATIVE_${code}${smokeOperation}${smokeBoundary}${smokeCleanup}${smokeReceipt}${smokeStage}${appearanceFailure}${boundary}${buildBoundary}${buildCleanup}${diagnostic ? `\nSOURCE_NATIVE_BUILD_DIAGNOSTIC ${JSON.stringify(diagnostic)}` : ""}${testStage}${testBoundary}${testCleanup}${testHints}${payloadHint}${locationHint}${materialHint}`;
}

export function buildDiagnosticOptions(phase,archiveSha256,sourceRoot,candidateRoot){
  if(!DIAGNOSTIC_COMMAND_PHASES.has(phase)||archiveSha256!==INPUT_ARCHIVE_SHA256||typeof sourceRoot!=="string"||!isAbsolute(sourceRoot)||typeof candidateRoot!=="string"||!isAbsolute(candidateRoot))return {};
  return {buildDiagnosticRoots:[sourceRoot,join(candidateRoot,"work/source")]};
}

async function phaseRun(state, phase, runner, command) {
  const expected = PHASES[state.phaseIndex + 1];
  if (expected !== phase && state.completed.at(-1) !== phase) fail("PHASE_ORDER");
  const result = await runner({ ...command, phase });
  requirePhaseResult(result, phase);
  if (expected === phase) {
    state.phaseIndex += 1;
    state.completed.push(phase);
  }
  state.lastResult = result;
  return result;
}

function command(program, args, cwd, env, capture = "none") {
  return { program, args, cwd, env, capture, timeoutMs: COMMAND_TIMEOUT_MS };
}

function pathInside(parent, child) {
  const parentResolved = resolve(parent);
  const childResolved = resolve(child);
  const rel = relative(parentResolved, childResolved);
  return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep) && !childResolved.includes("\0");
}

async function digestFile(path) {
  const bytes = await readBounded(path, 2 * 1024 * 1024 * 1024, "DIGEST_FILE");
  return createHash("sha256").update(bytes).digest("hex");
}

async function makeLegacyObservation({ spec, authority, sourceReceipt, stagedSource, payloadRoot, maintained }) {
  if (!isRecord(authority) || !isRecord(authority.claims) || !isRecord(authority.claims.toolchains)) fail("LEGACY_AUTHORITY");
  const frontend = await maintained.inventoryTree(join(stagedSource, "dist"));
  const payload = await maintained.inventoryTree(payloadRoot);
  const nodeReceiptBytes = await readBounded(spec.paths.nodeReceipt, 16 * 1024 * 1024, "NODE_RECEIPT");
  let nodeReceipt;
  try {nodeReceipt=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(nodeReceiptBytes));}
  catch {fail("NODE_RECEIPT");}
  const locks = {};
  for (const lockPath of ["src-tauri/Cargo.lock", "package-lock.json", "loom-preview-source/package-lock.json", "rust-toolchain.toml"]) {
    locks[lockPath] = await digestFile(join(stagedSource, lockPath));
  }
  const record = {
    platform: TARGET,
    triple: TRIPLE,
    toolchains: authority.claims.toolchains,
    embeddedRuntime: {
      receiptSha256: createHash("sha256").update(nodeReceiptBytes).digest("hex"),
      nodeVersion: nodeReceipt.nodeVersion ?? nodeReceipt.embeddedRuntime?.nodeVersion,
      undici: nodeReceipt.undici ?? nodeReceipt.embeddedRuntime?.undici ?? null,
      executableSha256: nodeReceipt.executable?.sha256 ?? nodeReceipt.embeddedRuntime?.sha256,
      signer: nodeReceipt.signature?.fingerprint ?? nodeReceipt.embeddedRuntime?.signer ?? null,
    },
    embeddedFrontend: { identity: frontend.identity, files: frontend.files.length },
    nativePayload: { identity: payload.identity, files: payload.files.length },
    environment: {
      runnerOs: "macos",
      runnerArch: "arm64",
      imageOs: spec.env.ImageOS ?? null,
      imageVersion: spec.env.ImageVersion ?? null,
      container: null,
      packages: spec.env.NEBULAR_RC_PACKAGES_SHA256 ?? null,
    },
    locks,
  };
  await writeExclusiveJson(spec.output.legacyObservation, record, "LEGACY_OBSERVATION_WRITE");
  return record;
}

export function parseRustTestSummary(text, expected) {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_COMMAND_OUTPUT) fail("RUST_TEST_OUTPUT");
  const matches = [...text.matchAll(/^test result: ok\.\s+(\d+) passed;\s+(\d+) failed;\s+(\d+) ignored;\s+(\d+) measured;\s+\d+ filtered out;.*$/gmu)];
  const match = matches.length === 1 ? matches[0] : null;
  if (!match || Number(match[1]) !== expected || Number(match[2]) !== 0 || Number(match[3]) !== 0 || Number(match[4]) !== 0) fail("RUST_TEST_SUMMARY");
  return { passed: Number(match[1]), failed: Number(match[2]) };
}

export function validateRustTestList(text, names, guard) {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_COMMAND_OUTPUT) fail("RUST_TEST_LIST");
  const lines=text.split(/\r?\n/u).filter(Boolean);
  if (lines.length !== names.length+1 || lines.at(-1) !== `${names.length} ${names.length === 1 ? "test" : "tests"}, 0 benchmarks`) fail("RUST_TEST_LIST");
  const observed=lines.slice(0,-1).map(line=>line.endsWith(": test")?line.slice(0,-6):null);
  if (new Set(observed).size !== names.length || names.some(name=>!observed.includes(name))) fail("RUST_TEST_LIST");
  const record = guard(text);
  if (!record || record.tests !== names.length || record.status !== "present-not-yet-executed") fail("RUST_TEST_LIST");
  return { tests: record.tests, names: observed, status: "present-not-yet-executed" };
}

export async function rustEnvironment({ authority, candidateRoot }) {
  const work = join(candidateRoot, "work");
  const stage = join(work, "source");
  const target = join(work, "target");
  const tools = authority.tools;
  const pathParts = [...Object.values(tools).filter((value) => typeof value === "string").map(dirname), ...Object.values(authority.inputs.toolchains ?? {}).filter((value) => isRecord(value) && typeof value.path === "string").map((value) => dirname(value.path)), "/usr/bin", "/bin"];
  const environment = {
    PATH: [...new Set(pathParts)].join(":"),
    HOME: join(work, "home"), TMPDIR: join(work, "tmp"), TMP: join(work, "tmp"), TEMP: join(work, "tmp"),
    CARGO_HOME: join(work, "cargo-home"), CARGO_TARGET_DIR: join(target, TRIPLE),
    npm_config_cache: join(work, "npm-cache"), npm_config_offline: "true", CARGO_NET_OFFLINE: "true",
    RUSTC: tools.rust, CARGO: tools.cargo, CC: tools.compiler, PKG_CONFIG: tools.pkgConfig,
    NEBULAR_BUILD_INPUTS: join(work, "build-inputs.json"), NEBULAR_BUILD_MODE: authority.inputs.mode,
    SOURCE_DATE_EPOCH: "1704067200", LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
  };
  for (const [key, value] of Object.entries(authority.inputs.execution?.environment ?? {})) {
    if (!isSafeEnvironmentKey(key) || typeof value !== "string") fail("BUILD_ENVIRONMENT");
    environment[key] = value;
  }
  // This separate, unshipped test-profile compile uses the bound Cargo config.
  // An encoded-flags variable would override its target rustflags in Cargo.
  if (Object.hasOwn(environment,"CARGO_ENCODED_RUSTFLAGS")) fail("BUILD_ENVIRONMENT");
  return { environment, cwd: join(stage, "src-tauri"), stage, work };
}

async function makeNestedPlan(spec) {
  const planModule = await import(pathToFileURL(spec.tools.plan).href).catch(() => null);
  if (!planModule?.planLanes) fail("NESTED_PLAN");
  const plan = planModule.planLanes({
    eventName: "workflow_dispatch",
    inputs: { macos_arm64: true, release_candidate: false },
    sha: spec.source.commit,
    runId: spec.env.GITHUB_RUN_ID,
    runAttempt: spec.env.GITHUB_RUN_ATTEMPT,
    version: CANDIDATE_VERSION,
  });
  await writeExclusiveJson(spec.output.plan, plan, "NESTED_PLAN_WRITE");
  return plan;
}

export function publicArtifactAllowlist() {
  return Object.freeze([
    "candidate/*.tar.gz",
    "candidate/*.tgz",
    "evidence/campaign66-evidence.json",
    "evidence/native-rc-source-mode-build-receipt.json",
    "evidence/source-receipt.json",
    "evidence/qualification.json",
    "evidence/package-record.json",
    "evidence/package-manifest.json",
    "evidence/nested-packaging-seal.json",
  ]);
}

async function materializePublicArtifacts(spec, packageRecord) {
  await mkdir(spec.paths.publicDir, { recursive: false, mode: 0o700 }).catch(() => fail("PUBLIC_DIR"));
  await mkdir(join(spec.paths.publicDir, "candidate"), { recursive: false, mode: 0o700 }).catch(() => fail("PUBLIC_DIR"));
  await mkdir(join(spec.paths.publicDir, "evidence"), { recursive: false, mode: 0o700 }).catch(() => fail("PUBLIC_DIR"));
  const copies = [
    [join(spec.paths.upload, "candidate", packageRecord.raw.filename), join(spec.paths.publicDir, "candidate", packageRecord.raw.filename)],
    [join(spec.paths.upload, "candidate", packageRecord.npm.filename), join(spec.paths.publicDir, "candidate", packageRecord.npm.filename)],
    [spec.output.publicEvidence, join(spec.paths.publicDir, "evidence/campaign66-evidence.json")],
    [join(spec.output.bridgeDir, "native-rc-source-mode-build-receipt.json"), join(spec.paths.publicDir, "evidence/native-rc-source-mode-build-receipt.json")],
    [join(spec.output.bridgeDir, "source-receipt.json"), join(spec.paths.publicDir, "evidence/source-receipt.json")],
    [spec.output.qualification, join(spec.paths.publicDir, "evidence/qualification.json")],
    [spec.output.packageRecord, join(spec.paths.publicDir, "evidence/package-record.json")],
    [spec.output.packageManifest, join(spec.paths.publicDir, "evidence/package-manifest.json")],
    [spec.output.nestedSeal, join(spec.paths.publicDir, "evidence/nested-packaging-seal.json")],
  ];
  for (const [source, destination] of copies) {
    await copyRegularExclusive(source, destination, "PUBLIC_ARTIFACT");
    if (destination.endsWith(".json")) {
      const text = new TextDecoder("utf-8",{fatal:true}).decode(await readBounded(destination,16*1024*1024,"PUBLIC_JSON"));
      const privatePrefixes = [spec.source.checkout,spec.env.RUNNER_TEMP,...Object.values(spec.paths),"/Users/","/private/var/","/home/"];
      if (privatePrefixes.some(value=>value && text.includes(value))) fail("PUBLIC_LOCATOR_SCAN");
    }
  }
  if (await digestFile(join(spec.paths.publicDir,"candidate",packageRecord.raw.filename)) !== packageRecord.raw.sha256
      || await digestFile(join(spec.paths.publicDir,"candidate",packageRecord.npm.filename)) !== packageRecord.npm.sha256) fail("PUBLIC_CANDIDATE_IDENTITY");
  return Object.freeze({ directory: "public", files: copies.map(([, destination]) => destination.slice(spec.paths.publicDir.length + 1)).sort(), allowlist: [...publicArtifactAllowlist()] });
}

export function buildPublicEvidence({ spec, context, sourceReceipt, bridge, tests, qualification, nestedSeal, packageRecord, realUserState, materialSmoke, appearanceSmoke }) {
  const cssomAppearanceSmoke = validateAppearanceCssomEvidence(appearanceSmoke);
  const legacyAppearanceSmoke = legacyAppearanceEvidenceProjection(cssomAppearanceSmoke);
  if (!bridge || bridge.nativeAcceptance !== "not-claimed") fail("PUBLIC_BRIDGE");
  if (bridge.status !== "source-receipt-bridged" || bridge.provenance?.fixtureOnly !== false
      || bridge.provenance?.gitObservation !== "checkout-rev-parse"
      || bridge.provenance?.inputArchiveToSourceCandidate !== "extractor-linked-manifest-to-source-candidate") fail("PUBLIC_BRIDGE");
  if (bridge.materialRoute?.authorityStatus !== "held-self-derived-record") fail("PUBLIC_MATERIAL_ROUTE");
  if (!tests?.installedModes || !tests?.sourcePins || tests.installedModes.status !== "passed-process-observation" || tests.sourcePins.status !== "passed-process-observation"
      || tests.installedModes.passed !== 4 || tests.installedModes.failed !== 0 || tests.installedModes.expected !== 4
      || tests.sourcePins.passed !== 2 || tests.sourcePins.failed !== 0 || tests.sourcePins.expected !== 2) fail("PUBLIC_TESTS");
  if (tests.materialFixture?.status !== "passed-process-observation" || tests.materialFixture.expected !== 2
      || tests.materialFixture.passed !== 2 || tests.materialFixture.failed !== 0
      || !Array.isArray(tests.materialFixture.tests) || tests.materialFixture.tests.length !== 2
      || REQUIRED_MATERIAL_TESTS.some(name=>!tests.materialFixture.tests.some(row=>row.name===name&&row.passed===1&&row.failed===0))) fail("PUBLIC_TESTS");
  if (tests.appearancePreferences?.status !== "passed-process-observation"
      || tests.appearancePreferences.expected !== REQUIRED_APPEARANCE_TESTS.length
      || tests.appearancePreferences.passed !== REQUIRED_APPEARANCE_TESTS.length
      || tests.appearancePreferences.failed !== 0
      || !Array.isArray(tests.appearancePreferences.tests)
      || tests.appearancePreferences.tests.length !== REQUIRED_APPEARANCE_TESTS.length
      || REQUIRED_APPEARANCE_TESTS.some(name => !tests.appearancePreferences.tests.some(row => row.name === name && row.passed === 1 && row.failed === 0))) fail("PUBLIC_TESTS");
  if (materialSmoke?.status !== "passed-process-observation" || materialSmoke.visualTranslucency !== "not-claimed"
      || !Array.isArray(materialSmoke.runs) || materialSmoke.runs.length !== 2
      || new Set(materialSmoke.runs.map(row=>row.source)).size !== 2
      || ["raw-archive","npm-package"].some(source=>!materialSmoke.runs.some(row=>row.source===source))
      || materialSmoke.runs.some(row=>!SHA256.test(row.receiptSha256??"")||row.stepsPassed!==8||row.sourceUnchanged!==true)) fail("PUBLIC_MATERIAL_SMOKE");
  if (legacyAppearanceSmoke?.schema !== LEGACY_APPEARANCE_RESULT_SCHEMA
      || legacyAppearanceSmoke.status !== "passed-process-observation"
      || legacyAppearanceSmoke.platform !== TARGET || legacyAppearanceSmoke.scenario !== "P"
      || legacyAppearanceSmoke.visualAppearanceQualified !== false
      || !Array.isArray(legacyAppearanceSmoke.runs) || legacyAppearanceSmoke.runs.length !== 2
      || new Set(legacyAppearanceSmoke.runs.map(row => row.source)).size !== 2
      || ["raw-archive", "npm-package"].some(source => !legacyAppearanceSmoke.runs.some(row => row.source === source))
      || legacyAppearanceSmoke.runs.some(row => row.stepsPassed !== APPEARANCE_STEPS.length
        || row.preferenceCustody !== "passed" || row.persistentUserState !== "unchanged"
        || row.visualAppearanceQualified !== false || !SHA256.test(row.receiptSha256 ?? ""))
      || legacyAppearanceSmoke.requiredRustTests?.status !== "passed-process-observation"
      || legacyAppearanceSmoke.requiredRustTests.expected !== REQUIRED_APPEARANCE_TESTS.length
      || legacyAppearanceSmoke.requiredRustTests.passed !== REQUIRED_APPEARANCE_TESTS.length
      || legacyAppearanceSmoke.requiredRustTests.failed !== 0
      || !Array.isArray(legacyAppearanceSmoke.requiredRustTests.tests)
      || legacyAppearanceSmoke.requiredRustTests.tests.length !== REQUIRED_APPEARANCE_TESTS.length
      || REQUIRED_APPEARANCE_TESTS.some(name => !legacyAppearanceSmoke.requiredRustTests.tests.some(row => row.name === name && row.passed === 1 && row.failed === 0))) fail("PUBLIC_APPEARANCE_SMOKE");
  if (legacyAppearanceSmoke.requiredPolicyTests?.status !== "passed-process-observation"
      || legacyAppearanceSmoke.requiredPolicyTests.expected !== REQUIRED_POLICY_TESTS.length
      || legacyAppearanceSmoke.requiredPolicyTests.passed !== REQUIRED_POLICY_TESTS.length
      || legacyAppearanceSmoke.requiredPolicyTests.failed !== 0
      || !Array.isArray(legacyAppearanceSmoke.requiredPolicyTests.tests)
      || legacyAppearanceSmoke.requiredPolicyTests.tests.length !== REQUIRED_POLICY_TESTS.length
      || REQUIRED_POLICY_TESTS.some(name => !legacyAppearanceSmoke.requiredPolicyTests.tests.some(row => row.name === name && row.passed === 1 && row.failed === 0))) fail("PUBLIC_APPEARANCE_SMOKE");
  if (qualification?.status !== "pass" || !Array.isArray(qualification.checks) || qualification.checks.length === 0
      || qualification.checks.some(row=>row.ok!==true)) fail("PUBLIC_QUALIFICATION");
  if (nestedSeal?.status !== "pass" || nestedSeal.schema !== "nebular.source-native-packaging-verification-v1"
      || nestedSeal.authorityStatus !== "held-self-derived-record" || nestedSeal.manualConfirmation !== "not-performed") fail("PUBLIC_PACKAGING_SEAL");
  if (realUserState?.method !== "fixed-app-namespace-absence-metadata" || realUserState.locations !== 63 || realUserState.observations !== 7 || realUserState.status !== "passed") fail("PUBLIC_USER_STATE");
  if (bridge.version !== spec.candidateVersion || sourceReceipt.version !== spec.candidateVersion
      || packageRecord?.version !== spec.candidateVersion || bridge.source.commit !== spec.source.commit
      || bridge.sourceCandidate !== sourceReceipt.sourceCandidate || bridge.sourceReceiptIdentity !== sourceReceipt.identity
      || bridge.inputArchive.sha256 !== spec.inputs.archiveSha256) fail("PUBLIC_SOURCE_BINDING");
  return {
    schema: EVIDENCE_SCHEMA,
    status: "held-source-native",
    nativeAcceptance: "not-claimed",
    hosted: true,
    qualificationScope: "macos-arm64-source-build-core-a-native-material-m-and-appearance-p",
    deferredChecks: ["material-visual-compositing", "appearance-visual-compositing", "paired-v2-complete", "linux-native"],
    publication: false,
    productionSigning: false,
    developerAdHocSeal: "existing-build-step",
    manualConfirmation: "not-performed",
    realUserState: {...realUserState},
    materialSmoke,
    appearance: {
      schema: "nebular.source-native-appearance-evidence-v1",
      status: legacyAppearanceSmoke.status,
      platform: legacyAppearanceSmoke.platform,
      scenario: legacyAppearanceSmoke.scenario,
      nativeAcceptance: "not-claimed",
      visualAppearanceQualified: false,
      requiredRustTests: legacyAppearanceSmoke.requiredRustTests,
      requiredPolicyTests: legacyAppearanceSmoke.requiredPolicyTests,
      runs: legacyAppearanceSmoke.runs,
    },
    appearanceCssom: {
      schema: APPEARANCE_CSSOM_RESULT_SCHEMA,
      profile: APPEARANCE_CSSOM_PROFILE,
      status: cssomAppearanceSmoke.status,
      platform: cssomAppearanceSmoke.platform,
      scenario: cssomAppearanceSmoke.scenario,
      visualAppearanceQualified: false,
      runs: cssomAppearanceSmoke.runs,
    },
    repository: context.repository,
    ref: context.ref,
    candidateVersion: spec.candidateVersion,
    releaseVersion: null,
    retentionDays: RETENTION_DAYS,
    source: {
      archivePath: bridge.inputArchive.path,
      archiveSha256: bridge.inputArchive.sha256,
      archiveGitBlobSha1: bridge.inputArchive.gitBlobSha1,
      commit: bridge.source.commit,
      tree: bridge.source.tree,
      sourceCandidate: bridge.sourceCandidate,
      sourceReceiptSha256: bridge.sourceReceiptSha256,
      sourceReceiptIdentity: sourceReceipt.identity,
    },
    materialRoute: { ...bridge.materialRoute, authorityStatus: "held-self-derived-record" },
    inputBinding: bridge.provenance.inputArchiveToSourceCandidate,
    tests,
    qualification: qualification ? { status: qualification.status, checks: qualification.checks?.map(({ id, ok }) => ({ id, ok })) ?? [] } : null,
    nestedPackagingVerification: nestedSeal ? { status: nestedSeal.status, schema: nestedSeal.schema, nativeAcceptance: "not-claimed" } : null,
    package: packageRecord ? {
      version: packageRecord.version,
      packageManifestSha256: packageRecord.packageManifestSha256,
      candidate: { raw: packageRecord.raw?.sha256 ?? null, npm: packageRecord.npm?.sha256 ?? null },
    } : null,
    publicArtifactAllowlist: [...publicArtifactAllowlist()],
    limits: {
      commandOutputPerStreamBytes: MAX_COMMAND_OUTPUT,
      commandTimeoutMs: COMMAND_TIMEOUT_MS,
      candidateRetentionDays: RETENTION_DAYS,
      logs: "status-and-counts-only",
    },
  };
}

/**
 * Execute the concrete campaign.  `run` is injectable for unit tests; the
 * production default is the fixed no-shell boundary above.
 */
export async function runCampaign(spec, { env = process.env, run = runFixedCommand, maintainedImport = null } = {}) {
  validateSpec(spec, env);
  const context = validateWorkflowContext(env);
  const state = { phaseIndex: 0, completed: ["guard"] };
  await prepareFreshRoots(spec);
  const commandEnv = scrubEnvironment(spec.commandEnv ?? {
    PATH: env.PATH ?? "/usr/bin:/bin",
    GITHUB_ACTIONS: env.GITHUB_ACTIONS,
    RUNNER_OS: env.RUNNER_OS,
    RUNNER_ARCH: env.RUNNER_ARCH,
    RUNNER_TEMP: env.RUNNER_TEMP,
    GITHUB_REPOSITORY: env.GITHUB_REPOSITORY,
    GITHUB_REF: env.GITHUB_REF,
    GITHUB_REF_TYPE: env.GITHUB_REF_TYPE ?? "branch",
    GITHUB_EVENT_NAME: env.GITHUB_EVENT_NAME,
    GITHUB_RUN_ID: env.GITHUB_RUN_ID,
    GITHUB_RUN_ATTEMPT: env.GITHUB_RUN_ATTEMPT,
    GITHUB_WORKSPACE: env.GITHUB_WORKSPACE,
  });
  let preparedSourceRoot = null;
  const resultRunner = async ({ phase, program, args, cwd, env: phaseEnv = commandEnv, capture = "none" }) => run({ phase, program, args, cwd, env: phaseEnv, capture, timeoutMs: COMMAND_TIMEOUT_MS, ...buildDiagnosticOptions(phase,spec.inputs.archiveSha256,preparedSourceRoot,spec.paths.candidate) });

  const python=await phaseRun(state,"bootstrap-python-readback",resultRunner,command(spec.tools.python,["--version"],spec.paths.bootstrapRoot,commandEnv,"text"));
  if (!/^Python 3\.13\.12\r?\n?$/u.test(python.text??"")) fail("PYTHON_VERSION");

  const extractionResult = await phaseRun(state, "bootstrap-extract", resultRunner, command(spec.tools.python, ["-B", spec.tools.unpack, "--archive", spec.inputs.archive, "--sha256", spec.inputs.archiveSha256, "--output", spec.paths.bootstrapExtracted], spec.paths.bootstrapRoot, commandEnv, "json"));
  const extraction = extractionResult.json;
  // A fake runner may not return parsed output, but production must persist the
  // extractor's bounded JSON receipt before any subsequent bridge phase.
  if (!extraction || extraction.schema !== "nebular.native-input-extraction.v1" || extraction.status !== "passed-inputs-only" || extraction.executedMembers !== false || extraction.nativeBuild !== false) fail("EXTRACTION_PROOF");
  if (resolve(spec.output.bundleManifest) !== resolve(join(spec.paths.bootstrapExtracted, "bundle-manifest.json"))) fail("EXTRACTION_MANIFEST_PATH");
  await writeExclusiveJson(spec.output.extractionReceipt, extraction, "EXTRACTION_PROOF_WRITE");
  state.lastResult = undefined;

  await phaseRun(state, "archive-member-bridge", resultRunner, command(spec.tools.node, [spec.tools.memberBridge, spec.inputs.archive, spec.paths.bootstrapExtracted, spec.output.extractionReceipt, spec.paths.bootstrapTools, spec.output.archiveManifest], spec.paths.bootstrapRoot, commandEnv));

  if (await digestFile(spec.inputs.verifier.binding.path) !== "7556406b3025cc809a125341dae333fb6e6d04d9c06937a955f9ed1d5d139f19"
      || await digestFile(spec.inputs.verifier.tarball.path) !== spec.inputs.verifier.tarball.sha256) fail("VERIFIER_INPUT_IDENTITY");
  await copyRegularExclusive(spec.inputs.verifier.binding.path, join(spec.paths.bootstrapStudio, "authenticated-inputs/tooling/binding.json"), "VERIFIER_COPY");
  await copyRegularExclusive(spec.inputs.verifier.tarball.path, join(spec.paths.bootstrapStudio, "authenticated-inputs/tooling-tarball/openpgp-6.3.1.tgz"), "VERIFIER_COPY");
  state.phaseIndex += 1;
  state.completed.push("bootstrap-verifier-copy");

  const rustupEnv = { ...commandEnv, HOME: spec.paths.rustHome, RUSTUP_HOME: spec.paths.rustupHome, CARGO_HOME: spec.paths.cargoHome, TMPDIR: spec.paths.tmp, TMP: spec.paths.tmp, TEMP: spec.paths.tmp };
  await phaseRun(state, "toolchain-install", resultRunner, command(spec.tools.rustup, ["toolchain", "install", "1.98.0", "--profile", "minimal"], spec.paths.bootstrapRoot, rustupEnv));
  const hostSpec = await readJson(spec.host.spec, "HOST_SPEC");
  for (const [phase, program, args, capture, expected] of [
    ["toolchain-readback", spec.tools.bootstrapNode, ["--version"], "text", /^v22\.23\.4\n?$/u],
    ["toolchain-readback", spec.tools.node, [spec.tools.npmCli, "--version"], "text", /^10\.9\.9\n?$/u],
    ["toolchain-readback", spec.tools.rustup, ["which", "rustc", "--toolchain", "1.98.0"], "text", text => text.trim() === hostSpec.toolchains.rust],
    ["toolchain-readback", spec.tools.rustup, ["which", "cargo", "--toolchain", "1.98.0"], "text", text => text.trim() === hostSpec.toolchains.cargo],
  ]) {
    const readback = await resultRunner(command(program, args, spec.paths.bootstrapRoot, rustupEnv, capture));
    resultOk(readback, "TOOLCHAIN_READBACK");
    if (!(typeof expected === "function" ? expected(readback.text ?? "") : expected.test(readback.text ?? ""))) fail("TOOLCHAIN_READBACK");
  }
  for (const [program, prefix] of [[hostSpec.toolchains.rust, "rustc 1.98.0 "], [hostSpec.toolchains.cargo, "cargo 1.98.0 "]]) {
    const result = await resultRunner(command(program,["--version"],spec.paths.bootstrapRoot,rustupEnv,"text"));
    resultOk(result,"TOOLCHAIN_READBACK");
    if (!(result.text ?? "").startsWith(prefix)) fail("TOOLCHAIN_READBACK");
  }
  state.phaseIndex += 1;
  state.completed.push("toolchain-readback");

  const bootstrapAuthority = join(spec.paths.bootstrapTools, "node-runtime-authority.mjs");
  await phaseRun(state, "bootstrap-node-auth", resultRunner, command(spec.tools.bootstrapNode, [bootstrapAuthority, "--authenticate-download", spec.paths.nodeDownload, "--output-node", spec.paths.authenticatedNode, "--output", spec.paths.nodeReceipt], spec.paths.bootstrapStudio, commandEnv));
  await phaseRun(state, "prepare-host-inputs", resultRunner, command(spec.paths.authenticatedNode, [spec.tools.hostInputs, "--spec", spec.host.spec, "--bridge", spec.host.bridge, "--receipt", spec.host.receipt, "--locator", spec.host.locator], spec.paths.bootstrapStudio, commandEnv, "json"));

  const locator = await readJson(spec.host.locator, "HOST_LOCATOR");
  if (locator.schema !== "nebular-host-input-locator-v1") fail("HOST_LOCATOR");
  const buildInputsPath = absolute(locator.buildInputsPath, "HOST_BUILD_INPUTS");
  const maintained = maintainedImport ?? await import(pathToFileURL(spec.tools.maintainedApi).href).catch(() => null);
  if (!maintained?.loadBuildInputs) fail("MAINTAINED_API");
  const authority = await maintained.loadBuildInputs(buildInputsPath);
  const sourceRoot = absolute(authority.inputs?.sourceRoot, "BUILD_SOURCE_ROOT");
  if (!pathInside(dirname(buildInputsPath), sourceRoot)) fail("BUILD_SOURCE_ROOT");
  const nativeCandidateScript = join(sourceRoot, "tools/native-candidate-build.mjs");
  preparedSourceRoot = sourceRoot;
  await phaseRun(state, "build-candidate", resultRunner, command(spec.paths.authenticatedNode, [nativeCandidateScript, "--target", TARGET, "--build-inputs", buildInputsPath, "--output", spec.paths.candidate], sourceRoot, commandEnv));

  const candidateRoot = resolve(spec.paths.candidate);
  const candidateSource = join(candidateRoot, "work/source");
  const payloadRoot = join(candidateRoot, "payload");
  const rust = await rustEnvironment({ authority, candidateRoot, maintained });
  const guardModule = await import(pathToFileURL(spec.tools.guard).href).catch(() => null);
  if (!guardModule?.assertInstalledModeTests || !guardModule.assertSourcePinTests) fail("TEST_GUARD");
  const installedList = await resultRunner({...command(authority.tools.cargo, ["test", "--locked", "--offline", "--lib", "sidecar::artifact::tests::installed_modes_", "--", "--list"], rust.cwd, scrubEnvironment(rust.environment), "text"), phase: "test-list-installed-modes"});
  requireTestListCommandResult(installedList, "installed-modes");
  const installed = validateRustTestList(installedList.text, REQUIRED_INSTALLED_MODE_TESTS, guardModule.assertInstalledModeTests);
  const sourceList = await resultRunner({...command(authority.tools.cargo, ["test", "--locked", "--offline", "--lib", "sidecar::artifact::tests::source_build_", "--", "--list"], rust.cwd, scrubEnvironment(rust.environment), "text"), phase: "test-list-source-pins"});
  requireTestListCommandResult(sourceList, "source-pins");
  const source = validateRustTestList(sourceList.text, REQUIRED_SOURCE_PIN_TESTS, guardModule.assertSourcePinTests);
  state.phaseIndex += 1;
  state.completed.push("test-list-guard");

  const installedRun = await resultRunner(command(authority.tools.cargo, ["test", "--locked", "--offline", "--lib", "sidecar::artifact::tests::installed_modes_", "--", "--test-threads=1"], rust.cwd, scrubEnvironment(rust.environment), "text"));
  resultOk(installedRun, "NATIVE_TESTS");
  const installedSummary = parseRustTestSummary(installedRun.text ?? "", installed.tests);
  const sourceRun = await resultRunner(command(authority.tools.cargo, ["test", "--locked", "--offline", "--lib", "sidecar::artifact::tests::source_build_", "--", "--test-threads=1"], rust.cwd, scrubEnvironment(rust.environment), "text"));
  resultOk(sourceRun, "NATIVE_TESTS");
  const sourceSummary = parseRustTestSummary(sourceRun.text ?? "", source.tests);
  const materialTests = [];
  for (const name of REQUIRED_MATERIAL_TESTS) {
    const listing = await resultRunner(command(authority.tools.cargo, ["test", "--locked", "--offline", "--lib", name, "--", "--exact", "--list"], rust.cwd, scrubEnvironment(rust.environment), "text"));
    resultOk(listing, "NATIVE_TESTS");
    const present = validateRustTestList(listing.text, [name], () => ({tests:1,status:"present-not-yet-executed"}));
    const executed = await resultRunner(command(authority.tools.cargo, ["test", "--locked", "--offline", "--lib", name, "--", "--exact", "--test-threads=1"], rust.cwd, scrubEnvironment(rust.environment), "text"));
    resultOk(executed, "NATIVE_TESTS");
    materialTests.push({name,...parseRustTestSummary(executed.text ?? "",present.tests)});
  }
  const appearanceTests = [];
  for (const name of REQUIRED_APPEARANCE_TESTS) {
    const listing = await resultRunner(command(authority.tools.cargo, ["test", "--locked", "--offline", "--lib", name, "--", "--exact", "--list"], rust.cwd, scrubEnvironment(rust.environment), "text"));
    resultOk(listing, "NATIVE_TESTS");
    const present = validateRustTestList(listing.text, [name], () => ({tests:1,status:"present-not-yet-executed"}));
    const executed = await resultRunner(command(authority.tools.cargo, ["test", "--locked", "--offline", "--lib", name, "--", "--exact", "--test-threads=1"], rust.cwd, scrubEnvironment(rust.environment), "text"));
    resultOk(executed, "NATIVE_TESTS");
    appearanceTests.push({name,...parseRustTestSummary(executed.text ?? "",present.tests)});
  }
  // The integration policy binary is a separate Cargo target.  List it before
  // execution, require the closed source-owned names, then run the target once
  // so the summary cannot be assembled from independent or skipped commands.
  const policyList = await resultRunner(command(authority.tools.cargo, ["test", "--locked", "--offline", "--test", "policy", "--", "--list"], rust.cwd, scrubEnvironment(rust.environment), "text"));
  resultOk(policyList, "NATIVE_TESTS");
  const policy = validateRustTestList(policyList.text, REQUIRED_POLICY_TESTS, () => ({tests: REQUIRED_POLICY_TESTS.length, status: "present-not-yet-executed"}));
  const policyRun = await resultRunner(command(authority.tools.cargo, ["test", "--locked", "--offline", "--test", "policy", "--", "--test-threads=1"], rust.cwd, scrubEnvironment(rust.environment), "text"));
  resultOk(policyRun, "NATIVE_TESTS");
  const policySummary = parseRustTestSummary(policyRun.text ?? "", policy.tests);
  state.phaseIndex += 1;
  state.completed.push("native-tests");
  const tests = {
    installedModes: { ...installedSummary, expected: installed.tests, status: "passed-process-observation" },
    sourcePins: { ...sourceSummary, expected: source.tests, status: "passed-process-observation" },
    materialFixture: {status:"passed-process-observation",expected:2,passed:materialTests.reduce((n,row)=>n+row.passed,0),failed:materialTests.reduce((n,row)=>n+row.failed,0),tests:materialTests},
    appearancePreferences: {status:"passed-process-observation",expected:REQUIRED_APPEARANCE_TESTS.length,passed:appearanceTests.reduce((n,row)=>n+row.passed,0),failed:appearanceTests.reduce((n,row)=>n+row.failed,0),tests:appearanceTests},
    policy: {status:"passed-process-observation",expected:REQUIRED_POLICY_TESTS.length,passed:policySummary.passed,failed:policySummary.failed,tests:policy.names.map(name=>({name,passed:1,failed:0}))},
    nativeAcceptance: "not-claimed",
  };

  // The maintained builder scans its work/source paths. This outer scan also
  // covers the fresh toolchain/preparation roots owned by this controller.
  const scanner = await import(pathToFileURL(join(spec.paths.bootstrapTools,"scan-shipped-paths.mjs")).href).catch(() => null);
  if (!scanner?.scanShippedPaths) throw payloadPathScanFailure(null,"MODULE");
  const payloadPrefixes = [dirname(spec.paths.bootstrapRoot),dirname(buildInputsPath),env.RUNNER_TEMP,env.HOME,spec.source.checkout];
  try {await scanner.scanShippedPaths(payloadRoot,payloadPrefixes,{preserveSpellings:true});}
  catch(error) {throw payloadPathScanFailure(error,"SCAN",payloadPrefixes);}
  state.phaseIndex += 1;
  state.completed.push("payload-path-scan");

  await phaseRun(state, "qualify", resultRunner, command(spec.paths.authenticatedNode, [join(sourceRoot, "tools/native-rc-qualify.mjs"), "--platform", TARGET, "--payload", payloadRoot, "--checkout", candidateSource, "--output", spec.output.qualification], sourceRoot, commandEnv));
  const rawQualification = await readJson(spec.output.qualification, "QUALIFICATION");
  if (rawQualification.status !== "pass" || rawQualification.platform !== TARGET || !Array.isArray(rawQualification.checks)
      || rawQualification.checks.length === 0 || rawQualification.checks.some(row => row.ok !== true)) fail("QUALIFICATION");
  const cleanQualification = {schema:rawQualification.schema,platform:rawQualification.platform,status:rawQualification.status,
    executableSha256:rawQualification.executableSha256,glibcMinimum:rawQualification.glibcMinimum,
    checks:rawQualification.checks.map(({id,ok})=>({id,ok}))};
  await writeFile(spec.output.qualification,JSON.stringify(cleanQualification,null,2)+"\n",{mode:0o600});
  await phaseRun(state, "package", resultRunner, command(spec.paths.authenticatedNode, [join(sourceRoot, "tools/native-rc-package.mjs"), "--platform", TARGET, "--payload", payloadRoot, "--checkout", candidateSource, "--output", spec.paths.upload, "--npm-cli", spec.tools.npmCli], sourceRoot, commandEnv));
  const packageRecord = validatePackageRecord(await readJson(join(spec.paths.upload, "package-record.json"), "PACKAGE_RECORD"));
  const packageManifest = await readJson(join(spec.paths.upload, "package-manifest.json"), "PACKAGE_MANIFEST");
  await mkdir(spec.output.smokeDir, { recursive: false, mode: 0o700 }).catch(() => fail("SMOKE_DIR"));
  await mkdir(join(spec.paths.smoke, "raw"), { recursive: false, mode: 0o700 }).catch(() => fail("SMOKE_DIR"));
  await mkdir(join(spec.paths.smoke, "npm"), { recursive: false, mode: 0o700 }).catch(() => fail("SMOKE_DIR"));
  // P evidence is nested so the existing A/M seal continues to enumerate only
  // its original direct run records. The nested records are bound separately
  // below and are never treated as a legacy seal input.
  const appearanceSmokeDir = join(spec.output.smokeDir, "appearance-p");
  await mkdir(appearanceSmokeDir, { recursive: false, mode: 0o700 }).catch(() => fail("SMOKE_DIR"));
  const raw = join(spec.paths.upload, "candidate", packageRecord.raw.filename);
  const npm = join(spec.paths.upload, "candidate", packageRecord.npm.filename);
  await runSmokeOperation("RAW_EXTRACT", () => phaseRun(state, "smoke", resultRunner, command(spec.tools.tar, ["-xzf", raw, "-C", join(spec.paths.smoke, "raw")], spec.paths.smoke, commandEnv)));
  await runSmokeOperation("NPM_EXTRACT", () => phaseRun(state, "smoke", resultRunner, command(spec.tools.tar, ["-xzf", npm, "-C", join(spec.paths.smoke, "npm")], spec.paths.smoke, commandEnv)));
  await runSmokeOperation("NPM_VERIFY", () => phaseRun(state, "smoke", resultRunner, command(spec.paths.authenticatedNode, [join(sourceRoot, "tools/native-rc-package.mjs"), "verify", "--platform", TARGET, "--package-root", join(spec.paths.smoke, "npm/package"), "--manifest-sha256", packageRecord.packageManifestSha256], sourceRoot, commandEnv)));
  const smokeModule=await import(pathToFileURL(join(sourceRoot,"tools/native-rc-smoke.mjs")).href).catch(()=>fail("REAL_USER_STATE"));
  const accountHome=userInfo().homedir;
  if(accountHome!==env.HOME)fail("LIVE_RUNNER_HOME");
  const userStateLocations=smokeModule.persistentStateLocations(TARGET,accountHome);
  await assertRunnerAppStateAbsent(userStateLocations,accountHome);
  for (const [label, launchRoot, sourceLabel, scenario] of [
    ["darwin-arm64-A-raw", join(spec.paths.smoke, "raw"), "raw-archive", "A"],
    ["darwin-arm64-A-npm", join(spec.paths.smoke, "npm/package/payload"), "npm-package", "A"],
    ["darwin-arm64-M-raw", join(spec.paths.smoke, "raw"), "raw-archive", "M"],
    ["darwin-arm64-M-npm", join(spec.paths.smoke, "npm/package/payload"), "npm-package", "M"],
  ]) {
    // Keep the legacy observer campaign-scoped. The outer metadata-only
    // observer checks the real account without hashing any profile contents.
    const operation = sourceLabel === "raw-archive" ? (scenario === "A" ? "RAW_A" : "RAW_M") : (scenario === "A" ? "NPM_A" : "NPM_M");
    await runSmokeOperation(operation, () => phaseRun(state, "smoke", resultRunner, command(spec.paths.authenticatedNode, [join(sourceRoot, "tools/native-rc-smoke.mjs"), "--platform", TARGET, "--scenario", scenario, "--launch-root", launchRoot, "--checkout", candidateSource, "--evidence", spec.output.smokeDir, "--source", sourceLabel, "--label", label], sourceRoot, smokeObserverEnvironment(commandEnv,env))),
      () => readJson(join(spec.output.smokeDir, `${label}.receipt.json`), "SMOKE_DIAGNOSTIC"));
    await assertRunnerAppStateAbsent(userStateLocations,accountHome);
  }
  // M proves the connected native controls/ack path; visual frame composition stays separate.
  const materialSmoke = validateMaterialSmokeRuns([
    await readJson(join(spec.output.smokeDir,"darwin-arm64-M-raw.run.json"),"PUBLIC_MATERIAL_SMOKE"),
    await readJson(join(spec.output.smokeDir,"darwin-arm64-M-npm.run.json"),"PUBLIC_MATERIAL_SMOKE"),
  ], packageRecord.raw.executableSha256);
  let appearanceSmoke;
  try {
    appearanceSmoke = await runExplicitAppearanceCssomP({
      enabled: true,
      platform: TARGET,
      completedOperations: ["RAW_A", "NPM_A", "RAW_M", "NPM_M"],
      executableSha256: packageRecord.raw.executableSha256,
      runOperation: async (operation) => {
        const sourceLabel = operation === "RAW_P" ? "raw-archive" : "npm-package";
        const label = sourceLabel === "raw-archive" ? "darwin-arm64-P-raw" : "darwin-arm64-P-npm";
        const launchRoot = sourceLabel === "raw-archive" ? join(spec.paths.smoke, "raw") : join(spec.paths.smoke, "npm/package/payload");
        const launchRootReal = await realpath(launchRoot).catch(() => fail("P_EXECUTABLE_PATH"));
        const launchExecutablePath = smokeModule.executablePath(launchRootReal, TARGET);
        await runSmokeOperation(operation, () => phaseRun(state, "smoke", resultRunner, command(spec.paths.authenticatedNode, [join(sourceRoot, "tools/native-rc-smoke.mjs"), "--platform", TARGET, "--scenario", "P", "--launch-root", launchRoot, "--checkout", candidateSource, "--evidence", appearanceSmokeDir, "--source", sourceLabel, "--label", label], sourceRoot, smokeObserverEnvironment(commandEnv,env))),
          () => readJson(join(appearanceSmokeDir, `${label}.receipt.json`), "P_SMOKE_DIAGNOSTIC"));
        await assertRunnerAppStateAbsent(userStateLocations,accountHome);
        return { run: await readJson(join(appearanceSmokeDir, `${label}.run.json`), "P_SMOKE_RUN"), launchExecutablePath };
      },
      loadReceipt: async (operation) => {
        const label = operation === "RAW_P" ? "darwin-arm64-P-raw" : "darwin-arm64-P-npm";
        return readJsonWithDigest(join(appearanceSmokeDir, `${label}.receipt.json`), "P_SMOKE_RECEIPT");
      },
    });
  } catch (error) {
    if (error instanceof CampaignError) throw error;
    const code = typeof error?.code === "string" && /^P_[A-Z_]+$/u.test(error.code) ? error.code : "P_SMOKE";
    fail(code);
  }
  const appearanceRustTests = {
    status: tests.appearancePreferences.status,
    expected: tests.appearancePreferences.expected,
    passed: tests.appearancePreferences.passed,
    failed: tests.appearancePreferences.failed,
    tests: tests.appearancePreferences.tests.map(({ name, passed, failed }) => ({ name, passed, failed })),
  };
  const appearancePolicyTests = {
    status: tests.policy.status,
    expected: tests.policy.expected,
    passed: tests.policy.passed,
    failed: tests.policy.failed,
    tests: tests.policy.tests.map(({ name, passed, failed }) => ({ name, passed, failed })),
  };
  const appearanceEvidence = { ...appearanceSmoke, requiredRustTests: appearanceRustTests, requiredPolicyTests: appearancePolicyTests };
  const sourceReceipt = await readJson(join(candidateRoot, "build-receipt.json"), "SOURCE_RECEIPT");
  if (!maintained?.inventoryTree) fail("MAINTAINED_API");
  await makeLegacyObservation({ spec, authority, sourceReceipt, stagedSource: candidateSource, payloadRoot, maintained });
  await phaseRun(state, "bridge-source-receipt", resultRunner, command(spec.paths.authenticatedNode, [spec.tools.sourceBridge, "--source-receipt", join(candidateRoot, "build-receipt.json"), "--build-inputs", buildInputsPath, "--payload", payloadRoot, "--staged-source", candidateSource, "--input-archive", spec.inputs.archive, "--archive-manifest", spec.output.archiveManifest, "--legacy-observation", spec.output.legacyObservation, "--extraction-receipt", spec.output.extractionReceipt, "--bundle-manifest", spec.output.bundleManifest, "--checkout", spec.source.checkout, "--archive-path", spec.inputs.archivePath, "--expected-commit", spec.source.commit, "--maintained-api", spec.tools.maintainedApi, "--output", spec.output.bridgeDir], sourceRoot, commandEnv));
  await makeNestedPlan(spec);
  const bridge = await readJson(join(spec.output.bridgeDir, "native-rc-source-mode-build-receipt.json"), "BRIDGE_RECORD");
  const evidenceModule = await import(pathToFileURL(spec.tools.evidence).href).catch(()=>fail("NESTED_PACKAGING_SEAL"));
  let nested;
  try {nested = evidenceModule.seal({ lane:"macos-arm64", plan:spec.output.plan, candidateDir:join(spec.paths.upload,"candidate"),
    packageRecord:spec.output.packageRecord, packageManifest:spec.output.packageManifest,
    qualification:spec.output.qualification, smokeDir:spec.output.smokeDir,
    buildReceipt:join(spec.output.bridgeDir,"native-rc-source-mode-build-receipt.json") });}
  catch {fail("NESTED_PACKAGING_SEAL");}
  if (nested.status !== "pass") fail("NESTED_PACKAGING_SEAL");
  const nestedSeal = {schema:"nebular.source-native-packaging-verification-v1",status:"pass",authorityStatus:"held-self-derived-record",
    manualConfirmation:"not-performed",inputReceiptSchema:bridge.schema,sourceBridgeSha256:await digestFile(join(spec.output.bridgeDir,"native-rc-source-mode-build-receipt.json")),
    packagingChecks:{status:nested.status,candidate:nested.candidate,buildReceiptSha256:nested.buildReceiptSha256,qualification:nested.qualification,
      smoke:nested.smoke.map(({persistentUserStateChanged,...row})=>({...row,campaignHomeStateChanged:persistentUserStateChanged}))}};
  await writeExclusiveJson(spec.output.nestedSeal,nestedSeal,"NESTED_SEAL_WRITE");
  state.phaseIndex += 1;
  state.completed.push("nested-packaging-seal");
  const qualificationRecord = await readJson(spec.output.qualification, "QUALIFICATION");
  const realUserState={method:"fixed-app-namespace-absence-metadata",locations:63,observations:7,status:"passed"};
  const evidence = buildPublicEvidence({ spec, context, sourceReceipt, bridge, tests, qualification: qualificationRecord, nestedSeal, packageRecord,realUserState,materialSmoke,appearanceSmoke: appearanceEvidence });
  await writeExclusiveJson(spec.output.publicEvidence, evidence, "PUBLIC_EVIDENCE_WRITE");
  await materializePublicArtifacts(spec, packageRecord);
  state.phaseIndex += 1;
  state.completed.push("public-evidence");
  return Object.freeze({ status: "held-source-native", phases: [...state.completed], evidence });
}

export function smokeObserverEnvironment(commandEnv,liveEnv) {
  if (liveEnv.HOME !== userInfo().homedir) fail("LIVE_RUNNER_HOME");
  return scrubEnvironment({...commandEnv});
}

export async function assertRunnerAppStateAbsent(locations,home,{readMetadata=lstat}={}) {
  absolute(home,"REAL_USER_STATE_SCOPE");
  if(!Array.isArray(locations)||locations.length!==63||new Set(locations).size!==63)fail("REAL_USER_STATE_SCOPE");
  const cache=new Map();
  const inspect=async path=>{
    if(cache.has(path))return cache.get(path);
    let info;
    try{info=await readMetadata(path);}catch(error){if(error?.code!=="ENOENT")fail("REAL_USER_STATE_METADATA");info=null;}
    cache.set(path,info);return info;
  };
  const rootInfo=await inspect(home);
  if(!rootInfo||rootInfo.isSymbolicLink()||!rootInfo.isDirectory())fail("REAL_USER_STATE_SCOPE");
  for(const path of locations){
    if(typeof path!=="string"||path!==resolve(path)||!pathInside(home,path))fail("REAL_USER_STATE_SCOPE");
    const parts=relative(home,path).split(sep);
    if(parts.length!==3||parts[0]!=="Library")fail("REAL_USER_STATE_SCOPE");
    let parent=home,missing=false;
    for(const part of parts.slice(0,-1)){
      const info=await inspect(parent);
      if(!info){missing=true;break;}
      if(info.isSymbolicLink()||!info.isDirectory())fail("REAL_USER_STATE_SCOPE");
      parent=join(parent,part);
    }
    if(missing)continue;
    const info=await inspect(parent);
    if(!info)continue;
    if(info.isSymbolicLink()||!info.isDirectory())fail("REAL_USER_STATE_SCOPE");
    if(await inspect(path))fail("REAL_USER_STATE_PRESENT");
  }
  return {method:"fixed-app-namespace-absence-metadata",locations:63,status:"absent"};
}

export function parseCli(argv) {
  if (argv.length !== 2 || argv[0] !== "--spec" || !argv[1] || argv[1].startsWith("--")) fail("USAGE");
  return { spec: absolute(argv[1], "SPEC") };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const { spec: path } = parseCli(process.argv.slice(2));
    if(resolve(path)!==join(await realpath(process.env.RUNNER_TEMP),"nebular-source-native/spec.json"))fail("SPEC_LOCATION");
    const parsed = await readJson(path, "SPEC");
    const result = await runCampaign(parsed,{env:process.env});
    process.stdout.write(`${JSON.stringify({ schema: CONTROLLER_SCHEMA, status: result.status, phases: result.phases })}\n`);
  } catch (error) {
    process.stderr.write(`${formatCampaignFailure(error)}\n`);
    process.exitCode = 1;
  }
}

