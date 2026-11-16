// Isolated native-P orchestration extension for the held source-mode campaign.
//
// This module is deliberately not imported by the public native-rc workflow.  It
// is a closed adapter for a future macOS checkpoint: the existing A/M operations
// stay owned by the approved controller, while this module is called only when
// its explicit P switch is supplied.  No command, fixture, platform lane,
// workflow, receipt schema, or public qualification claim is added here.

import { createHash } from "node:crypto";

export const APPEARANCE_CONTROLLER_SCHEMA = "nebular.source-native-appearance-p-orchestration-v1";
export const APPEARANCE_RESULT_SCHEMA = "nebular.source-native-appearance-smoke-v1";
export const APPEARANCE_PLATFORM = "darwin-arm64";
export const APPEARANCE_TARGET = "aarch64-apple-darwin";
export const APPEARANCE_SCENARIO = "P";

export const APPEARANCE_STEPS = Object.freeze([
  Object.freeze({ id: "appearance-shell", via: "dom" }),
  Object.freeze({ id: "appearance-pair", via: "dom+invoke" }),
  Object.freeze({ id: "appearance-dark-mode", via: "dom+invoke" }),
  Object.freeze({ id: "appearance-custom-pair", via: "dom+invoke" }),
  Object.freeze({ id: "appearance-reset", via: "dom+invoke" }),
]);

export const APPEARANCE_FACTS = Object.freeze([
  Object.freeze(["appearancePreferenceReadback", "terminal-nova pair"]),
  Object.freeze(["appearanceMode", "dark"]),
  Object.freeze(["appearanceCustomPair", "anime/gamer"]),
  Object.freeze(["appearanceReset", "version-1-empty"]),
  Object.freeze(["visualAppearanceQualified", "false"]),
]);

export const APPEARANCE_P_OPERATIONS = Object.freeze(["RAW_P", "NPM_P"]);

// These names are copied from the approved controller's closed call sites.  A
// caller must continue to execute these four original operations itself; this
// extension never replaces or silently broadens them.
export const EXISTING_MAC_OPERATIONS = Object.freeze(["RAW_A", "NPM_A", "RAW_M", "NPM_M"]);
export const APPROVED_SMOKE_OPERATIONS = Object.freeze([
  "RAW_EXTRACT", "NPM_EXTRACT", "NPM_VERIFY", ...EXISTING_MAC_OPERATIONS,
]);
export const SMOKE_OPERATIONS = Object.freeze([
  ...APPROVED_SMOKE_OPERATIONS,
  ...APPEARANCE_P_OPERATIONS,
]);
export const PLATFORM_SCENARIOS = Object.freeze({
  "darwin-arm64": Object.freeze(["A"]),
  "linux-arm64": Object.freeze(["B"]),
  "linux-x64": Object.freeze(["C", "C-signal"]),
});

const APPEARANCE_FAILURE_REASONS = new Set([
  "APPEARANCE_TIMEOUT",
  "APPEARANCE_BRIDGE_UNAVAILABLE",
  "APPEARANCE_NATIVE_REJECTED",
  "APPEARANCE_SAVE_REJECTED",
  "APPEARANCE_CONTROL_UNAVAILABLE",
  "APPEARANCE_OPTION_UNAVAILABLE",
  "APPEARANCE_SELECT_SETTER_UNAVAILABLE",
  "APPEARANCE_CUSTOM_CONTROLS_UNAVAILABLE",
  "APPEARANCE_RESET_UNAVAILABLE",
  "APPEARANCE_SYSTEM_MODE_UNAVAILABLE",
  "APPEARANCE_SCENARIO_UNSUPPORTED",
  "APPEARANCE_DRIVER_FAILURE",
  "APPEARANCE_UNKNOWN_FAILURE",
]);

const SHA256 = /^[a-f0-9]{64}$/u;
const EMPTY_PREFERENCE_SHA256 = createHash("sha256").update(Buffer.from('{"version":1}', "utf8")).digest("hex");
const PRIVATE_TEXT = /(?:\/Users\/|\/private\/|\/home\/|appearance-preferences[\\/]appearance\.json|[A-Za-z]:\\)/u;
const STEP_IDS = new Set(APPEARANCE_STEPS.map(({ id }) => id));

export class AppearanceOrchestrationError extends Error {
  constructor(code) {
    super(`APPEARANCE_ORCHESTRATION_${code}`);
    this.name = "AppearanceOrchestrationError";
    this.code = code;
  }
}

function fail(code) {
  throw new AppearanceOrchestrationError(code);
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype);
}

function safeSha(value) {
  return typeof value === "string" && SHA256.test(value);
}

function privateText(value) {
  if (typeof value === "string") return PRIVATE_TEXT.test(value);
  if (Array.isArray(value)) return value.some(privateText);
  if (isRecord(value)) return Object.entries(value).some(([key, item]) => privateText(key) || privateText(item));
  return false;
}

function safeOwnedAbsolutePath(value) {
  return typeof value === "string" && value.length > 1 && value.startsWith("/") && !value.includes("\0");
}

function boundedMilliseconds(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 300_000;
}

function operationSource(operation) {
  if (operation === "RAW_P") return "raw-archive";
  if (operation === "NPM_P") return "npm-package";
  return null;
}

/** Maps only the two explicit new operations; all other operations remain the approved controller's concern. */
export function appearanceSmokeInvocation(operation) {
  const source = operationSource(operation);
  return source === null ? null : Object.freeze({
    operation,
    scenario: APPEARANCE_SCENARIO,
    platform: APPEARANCE_PLATFORM,
    source,
    stages: Object.freeze(APPEARANCE_STEPS.map(({ id }) => id)),
  });
}

/**
 * Returns a closed diagnostic projection for a failed P receipt.  It never
 * copies driver detail, DOM text, argv, paths, or the original error message.
 */
export function appearanceSmokeDiagnostic(receipt, operation) {
  const invocation = appearanceSmokeInvocation(operation);
  if (!invocation) return Object.freeze({ state: "rejected" });
  if (!isRecord(receipt) || receipt.schema !== "nebular.release-smoke-receipt-v1"
      || receipt.scenario !== APPEARANCE_SCENARIO || !["pass", "fail"].includes(receipt.status)
      || receipt.driver?.scenario !== APPEARANCE_SCENARIO || !Array.isArray(receipt.driver.steps)) {
    return Object.freeze({ operation, state: "rejected" });
  }
  if (receipt.status === "pass") return Object.freeze({ operation, state: "pass" });
  const failed = receipt.driver.steps.find((step) => step?.ok === false);
  const stage = STEP_IDS.has(failed?.id) ? failed.id : null;
  const reason = APPEARANCE_FAILURE_REASONS.has(failed?.detail) ? failed.detail : null;
  return Object.freeze({ operation, state: "fail", ...(stage ? { stage } : {}), ...(reason ? { reason } : {}) });
}

/**
 * Adds only closed P labels to an existing campaign error.  This is the seam
 * for the approved controller's existing runSmokeOperation/format boundary.
 */
export function annotateAppearanceSmokeReceipt(error, receipt, operation) {
  const invocation = appearanceSmokeInvocation(operation);
  if (!invocation || (typeof error !== "object" && typeof error !== "function") || error === null) return error;
  error.appearanceSmokeOperation = operation;
  error.appearanceSmokeReceiptState = "UNAVAILABLE";
  // A failed receipt load is distinct from a present but malformed record.
  // Keep the former unavailable label instead of letting null diagnose as
  // rejected; the launch error remains the authority in that path.
  if (receipt === null || receipt === undefined) return error;
  try {
    const diagnostic = appearanceSmokeDiagnostic(receipt, operation);
    error.appearanceSmokeReceiptState = diagnostic.state === "rejected" ? "REJECTED" : diagnostic.state.toUpperCase();
    if (diagnostic.stage) error.appearanceSmokeStage = diagnostic.stage;
    if (diagnostic.reason) error.appearanceSmokeReason = diagnostic.reason;
  } catch {
    // The launch failure remains the authority when a receipt is malformed.
  }
  return error;
}

/** Formats only the fixed P labels for the approved campaign's stderr boundary. */
export function formatAppearanceSmokeFailure(error) {
  const operation = error && typeof error === "object" && APPEARANCE_P_OPERATIONS.includes(error.appearanceSmokeOperation)
    ? error.appearanceSmokeOperation : null;
  if (!operation) return "SOURCE_NATIVE_APPEARANCE_SMOKE";
  const state = ["UNAVAILABLE", "REJECTED", "PASS", "FAIL"].includes(error.appearanceSmokeReceiptState)
    ? error.appearanceSmokeReceiptState : "REJECTED";
  const lines = [
    `SOURCE_NATIVE_APPEARANCE_SMOKE_OPERATION_${operation}`,
    `SOURCE_NATIVE_APPEARANCE_SMOKE_RECEIPT_${state}`,
  ];
  if (state === "FAIL" && STEP_IDS.has(error.appearanceSmokeStage)) {
    lines.push(`SOURCE_NATIVE_APPEARANCE_SMOKE_STAGE_${error.appearanceSmokeStage}`);
  }
  if (state === "FAIL" && APPEARANCE_FAILURE_REASONS.has(error.appearanceSmokeReason)) {
    lines.push(`SOURCE_NATIVE_APPEARANCE_SMOKE_REASON_${error.appearanceSmokeReason}`);
  }
  return lines.join("\n");
}

function validateProjectedSteps(steps) {
  if (!Array.isArray(steps) || steps.length !== APPEARANCE_STEPS.length) fail("P_RECEIPT");
  for (const [index, expected] of APPEARANCE_STEPS.entries()) {
    const step = steps[index];
    if (!isRecord(step) || step.id !== expected.id || step.ok !== true || step.via !== expected.via
        || !boundedMilliseconds(step.ms)) fail("P_RECEIPT");
    if (Object.hasOwn(step, "detail") && (typeof step.detail !== "string" || step.detail.length > 400)) fail("P_RECEIPT");
  }
}

function validateDriverReceipt(receipt, executableSha256, launchExecutablePath) {
  if (!isRecord(receipt) || receipt.schema !== "nebular.release-smoke-receipt-v1"
      || receipt.scenario !== APPEARANCE_SCENARIO || receipt.status !== "pass"
      || receipt.target !== APPEARANCE_TARGET || typeof receipt.applicationVersion !== "string"
      || !Number.isSafeInteger(receipt.pid) || receipt.pid < 1
      || !Number.isSafeInteger(receipt.startedAtUnixMs) || !Number.isSafeInteger(receipt.finishedAtUnixMs)
      || receipt.finishedAtUnixMs < receipt.startedAtUnixMs || receipt.awaitingSignal !== false
      || receipt.failure !== null || !isRecord(receipt.executable)
      || !safeOwnedAbsolutePath(launchExecutablePath) || receipt.executable.path !== launchExecutablePath
      || !Number.isFinite(receipt.executable.dev) || receipt.executable.dev < 0
      || !Number.isFinite(receipt.executable.ino) || receipt.executable.ino < 0
      || !Number.isFinite(receipt.executable.size) || receipt.executable.size < 0
      || receipt.executable.sha256 !== executableSha256
      || !isRecord(receipt.driver) || receipt.driver.status !== "pass"
      || receipt.driver.scenario !== APPEARANCE_SCENARIO) fail("P_RECEIPT");
  validateProjectedSteps(receipt.driver.steps);
  if (!Array.isArray(receipt.driver.facts)
      || JSON.stringify(receipt.driver.facts) !== JSON.stringify(APPEARANCE_FACTS)) fail("P_RECEIPT");
  // The absolute executable path is an owned internal binding, not public
  // evidence. Remove only that validated field before the privacy scan.
  const privacyReceipt = { ...receipt, executable: { ...receipt.executable } };
  delete privacyReceipt.executable.path;
  if (privateText(privacyReceipt)) fail("P_PRIVACY");
}

function validatePreferenceCustody(checks) {
  const preference = checks?.appearancePreference;
  if (!isRecord(preference) || preference.ok !== true || preference.reason !== "ok"
      || preference.bytes !== Buffer.byteLength('{"version":1}', "utf8")
      || preference.mode !== 0o600 || preference.nlink !== 1
      || preference.temporarySiblingCount !== 0 || preference.unexpectedSiblingCount !== 0
      || preference.record !== "version-1-empty" || preference.sha256 !== EMPTY_PREFERENCE_SHA256) fail("P_CUSTODY");
  if (privateText(preference)) fail("P_PRIVACY");
}

/**
 * Validates one projected native-rc run plus its full receipt.  The full
 * receipt is required so the controller independently checks the fixed P
 * driver facts rather than trusting the harness projection alone.
 */
export function validateAppearanceSmokeRun({ run, receipt, executableSha256, source, launchExecutablePath }) {
  const invocation = appearanceSmokeInvocation(source === "raw-archive" ? "RAW_P" : source === "npm-package" ? "NPM_P" : "");
  if (!invocation || !safeSha(executableSha256) || !isRecord(run) || !isRecord(receipt)
      || !isRecord(run.receipt) || !isRecord(receipt.receipt) || !safeSha(receipt.sha256)) fail("P_RECEIPT");
  if (run.schema !== "nebular.native-rc-smoke-run-v1" || run.label === undefined
      || run.platform !== APPEARANCE_PLATFORM || run.scenario !== APPEARANCE_SCENARIO
      || run.source !== source || run.status !== "pass" || !Array.isArray(run.problems)
      || run.problems.length !== 0 || run.executable?.sha256 !== executableSha256) fail("P_RECEIPT");
  if (!safeOwnedAbsolutePath(launchExecutablePath) || run.receipt.status !== "pass"
      || !safeSha(run.receipt.sha256) || receipt.sha256 !== run.receipt.sha256) fail("P_RECEIPT_HASH");
  validateProjectedSteps(run.receipt.steps);
  validateDriverReceipt(receipt.receipt, executableSha256, launchExecutablePath);
  validatePreferenceCustody(run.checks);
  if (!Array.isArray(run.checks?.orphans) || run.checks.orphans.length !== 0
      || !isRecord(run.checks?.persistentUserState)
      || !Array.isArray(run.checks.persistentUserState.changed)
      || run.checks.persistentUserState.changed.length !== 0
      || run.checks.persistentUserState.locations !== 63
      || !isRecord(run.checks?.fixtureEffects)
      || Object.keys(run.checks.fixtureEffects).length !== 0
      || !Number.isSafeInteger(run.checks?.scratchHomeWrites) || run.checks.scratchHomeWrites < 0) fail("P_RECEIPT");
  if (!isRecord(run.exit) || run.exit.code !== 0 || run.exit.signal !== null || run.exit.signalSent !== null
      || !Number.isSafeInteger(run.exit.durationMs) || run.exit.durationMs < 0) fail("P_RECEIPT");
  if (privateText(run)) fail("P_PRIVACY");
  return Object.freeze({
    source,
    receiptSha256: run.receipt.sha256,
    stepsPassed: APPEARANCE_STEPS.length,
    preferenceCustody: "passed",
    persistentUserState: "unchanged",
    visualAppearanceQualified: false,
  });
}

/** Validates exactly raw and npm P runs and returns a path-free evidence projection. */
export function validateAppearanceSmokeRuns(entries, executableSha256) {
  if (!Array.isArray(entries) || entries.length !== APPEARANCE_P_OPERATIONS.length) fail("P_SMOKE");
  if (!safeSha(executableSha256)) fail("P_SMOKE");
  const expectedSources = ["raw-archive", "npm-package"];
  const summaries = entries.map((entry) => validateAppearanceSmokeRun({ ...entry, executableSha256 }));
  if (new Set(summaries.map(({ source }) => source)).size !== expectedSources.length
      || expectedSources.some((source) => !summaries.some((row) => row.source === source))) fail("P_SMOKE");
  return Object.freeze({
    schema: APPEARANCE_RESULT_SCHEMA,
    status: "passed-process-observation",
    platform: APPEARANCE_PLATFORM,
    scenario: APPEARANCE_SCENARIO,
    visualAppearanceQualified: false,
    runs: Object.freeze(summaries),
  });
}

/**
 * Returns the original Mac checkpoint plan. P is absent unless the caller
 * explicitly opts in, and no Linux plan can receive this operation.
 */
export function buildMacCheckpointPlan({ includeAppearanceP = false } = {}) {
  if (typeof includeAppearanceP !== "boolean") fail("P_SWITCH");
  return Object.freeze({
    schema: APPEARANCE_CONTROLLER_SCHEMA,
    platform: APPEARANCE_PLATFORM,
    existingOperations: EXISTING_MAC_OPERATIONS,
    appearanceOperations: includeAppearanceP ? APPEARANCE_P_OPERATIONS : Object.freeze([]),
    defaultPlatformScenarios: PLATFORM_SCENARIOS,
    appearanceEnabled: includeAppearanceP,
  });
}

/** Requires the approved A/M pair to have completed before P can be invoked. */
export function requireExistingMacCheckpoint(operations) {
  if (!Array.isArray(operations) || operations.length !== EXISTING_MAC_OPERATIONS.length
      || operations.some((operation, index) => operation !== EXISTING_MAC_OPERATIONS[index])) fail("EXISTING_MAC_REQUIRED");
  return EXISTING_MAC_OPERATIONS;
}

/**
 * Executes P only with the explicit switch. Existing A/M execution remains in
 * the approved controller and is intentionally not called or reimplemented.
 */
export async function runExplicitAppearanceP({ enabled = false, platform, completedOperations, runOperation, loadReceipt, executableSha256 }) {
  if (enabled !== true) fail("P_NOT_EXPLICIT");
  if (platform !== APPEARANCE_PLATFORM) fail("P_PLATFORM");
  requireExistingMacCheckpoint(completedOperations);
  if (typeof runOperation !== "function" || typeof loadReceipt !== "function") fail("P_CALLBACKS");
  const entries = [];
  for (const operation of APPEARANCE_P_OPERATIONS) {
    let operationResult;
    try {
      operationResult = await runOperation(operation);
    } catch (error) {
      let receipt = null;
      try { receipt = await loadReceipt(operation); } catch { /* keep the launch failure closed */ }
      annotateAppearanceSmokeReceipt(error, isRecord(receipt?.receipt) ? receipt.receipt : receipt, operation);
      if (error && typeof error === "object" && typeof error.code === "string") throw error;
      fail("P_OPERATION_FAILED");
    }
    let receipt;
    try {
      receipt = await loadReceipt(operation);
    } catch {
      fail("P_RECEIPT_UNAVAILABLE");
    }
    entries.push({
      run: isRecord(operationResult?.run) ? operationResult.run : operationResult,
      launchExecutablePath: operationResult?.launchExecutablePath,
      receipt,
      source: operationSource(operation),
    });
  }
  return validateAppearanceSmokeRuns(entries, executableSha256);
}

