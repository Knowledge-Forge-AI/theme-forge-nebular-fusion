// Explicit controller seam for the approved CSSOM P profile.
// The historical appearance module and validator remain separate and
// byte-identical; this file owns only the new runner, projection and one
// closed diagnostic label.

import * as historical from "./appearance-orchestration.mjs";
import {
  APPEARANCE_CSSOM_CHECKPOINTS,
  APPEARANCE_CSSOM_PROFILE,
  APPEARANCE_CSSOM_RESULT_SCHEMA,
  validateAppearanceCssomSmokeRuns,
} from "./appearance-cssom-orchestration.mjs";

export { APPEARANCE_CSSOM_CHECKPOINTS, APPEARANCE_CSSOM_PROFILE, APPEARANCE_CSSOM_RESULT_SCHEMA };

const SHA256 = /^[a-f0-9]{64}$/u;
const OBSERVATION_KEYS = Object.freeze([
  "activeCount",
  "checkpoint",
  "computedStylePresence",
  "pairConsistent",
  "slotCount",
]);
const LEGACY_VIEW_KEYS = Object.freeze([
  "persistentUserState",
  "preferenceCustody",
  "receiptSha256",
  "source",
  "stepsPassed",
  "visualAppearanceQualified",
]);
const PROFILE_SOURCES = Object.freeze(["raw-archive", "npm-package"]);

function fail(code) {
  throw new historical.AppearanceOrchestrationError(code);
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype);
}

function exactKeys(value, expected) {
  if (!isRecord(value)) return false;
  const actual = Object.getOwnPropertyNames(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index])
    && Object.getOwnPropertySymbols(value).length === 0;
}

function validateObservation(row, index) {
  if (!exactKeys(row, OBSERVATION_KEYS)
      || row.checkpoint !== APPEARANCE_CSSOM_CHECKPOINTS[index]
      || row.slotCount !== 4
      || !Number.isSafeInteger(row.activeCount) || row.activeCount < 1 || row.activeCount > 4
      || row.pairConsistent !== true || row.computedStylePresence !== true) fail("CSSOM_EVIDENCE");
}

/** Validate the fixed path-free CSSOM projection before public evidence. */
export function validateAppearanceCssomEvidence(appearanceSmoke) {
  if (!isRecord(appearanceSmoke)
      || !exactKeys(appearanceSmoke, [
        "profile", "requiredPolicyTests", "requiredRustTests", "runs", "scenario", "schema", "status", "visualAppearanceQualified", "platform",
      ])
      || appearanceSmoke.schema !== APPEARANCE_CSSOM_RESULT_SCHEMA
      || appearanceSmoke.profile !== APPEARANCE_CSSOM_PROFILE
      || appearanceSmoke.status !== "passed-process-observation"
      || appearanceSmoke.platform !== historical.APPEARANCE_PLATFORM
      || appearanceSmoke.scenario !== historical.APPEARANCE_SCENARIO
      || appearanceSmoke.visualAppearanceQualified !== false
      || !Array.isArray(appearanceSmoke.runs)
      || appearanceSmoke.runs.length !== PROFILE_SOURCES.length) fail("CSSOM_EVIDENCE");
  const sources = new Set();
  for (const row of appearanceSmoke.runs) {
    if (!isRecord(row) || !exactKeys(row, ["legacyView", "observations", "receiptSha256", "source"])
        || !PROFILE_SOURCES.includes(row.source) || sources.has(row.source)
        || !SHA256.test(row.receiptSha256 ?? "") || !exactKeys(row.legacyView, LEGACY_VIEW_KEYS)
        || row.legacyView.source !== row.source
        || row.legacyView.receiptSha256 !== row.receiptSha256
        || row.legacyView.stepsPassed !== historical.APPEARANCE_STEPS.length
        || row.legacyView.preferenceCustody !== "passed"
        || row.legacyView.persistentUserState !== "unchanged"
        || row.legacyView.visualAppearanceQualified !== false
        || !Array.isArray(row.observations)
        || row.observations.length !== APPEARANCE_CSSOM_CHECKPOINTS.length) fail("CSSOM_EVIDENCE");
    sources.add(row.source);
    row.observations.forEach(validateObservation);
  }
  if (sources.size !== PROFILE_SOURCES.length) fail("CSSOM_EVIDENCE");
  return appearanceSmoke;
}

/** Project only the fields required by the unchanged historical evidence gate. */
export function legacyAppearanceEvidenceProjection(appearanceSmoke) {
  validateAppearanceCssomEvidence(appearanceSmoke);
  return {
    schema: historical.APPEARANCE_RESULT_SCHEMA,
    status: appearanceSmoke.status,
    platform: appearanceSmoke.platform,
    scenario: appearanceSmoke.scenario,
    visualAppearanceQualified: false,
    requiredRustTests: appearanceSmoke.requiredRustTests,
    requiredPolicyTests: appearanceSmoke.requiredPolicyTests,
    runs: appearanceSmoke.runs.map(({ legacyView }) => legacyView),
  };
}

/** Add only the approved closed CSSOM observer failure reason. */
export function appearanceSmokeDiagnostic(receipt, operation) {
  const diagnostic = historical.appearanceSmokeDiagnostic(receipt, operation);
  if (diagnostic.state !== "fail" || diagnostic.reason) return diagnostic;
  const failed = receipt?.driver?.steps?.find((step) => step?.ok === false);
  if (failed?.detail !== "APPEARANCE_CSSOM_OBSERVATION_FAILED") return diagnostic;
  return Object.freeze({ ...diagnostic, reason: "APPEARANCE_CSSOM_OBSERVATION_FAILED" });
}

export function annotateAppearanceSmokeReceipt(error, receipt, operation) {
  historical.annotateAppearanceSmokeReceipt(error, receipt, operation);
  const diagnostic = appearanceSmokeDiagnostic(receipt, operation);
  if (diagnostic.state === "fail" && diagnostic.reason === "APPEARANCE_CSSOM_OBSERVATION_FAILED") {
    error.appearanceSmokeReason = diagnostic.reason;
  }
  return error;
}

export function formatAppearanceSmokeFailure(error) {
  const formatted = historical.formatAppearanceSmokeFailure(error);
  if (error?.appearanceSmokeReason !== "APPEARANCE_CSSOM_OBSERVATION_FAILED"
      || formatted.includes("SOURCE_NATIVE_APPEARANCE_SMOKE_REASON_APPEARANCE_CSSOM_OBSERVATION_FAILED")) return formatted;
  return `${formatted}\nSOURCE_NATIVE_APPEARANCE_SMOKE_REASON_APPEARANCE_CSSOM_OBSERVATION_FAILED`;
}

/** Run only the explicit P pair; A/M remain the maintained caller's gate. */
export async function runExplicitAppearanceCssomP({
  enabled = false,
  platform,
  completedOperations,
  runOperation,
  loadReceipt,
  executableSha256,
}) {
  if (enabled !== true) fail("P_NOT_EXPLICIT");
  if (platform !== historical.APPEARANCE_PLATFORM) fail("P_PLATFORM");
  historical.requireExistingMacCheckpoint(completedOperations);
  if (typeof runOperation !== "function" || typeof loadReceipt !== "function") fail("P_CALLBACKS");
  const entries = [];
  for (const operation of historical.APPEARANCE_P_OPERATIONS) {
    let operationResult;
    try {
      operationResult = await runOperation(operation);
    } catch (error) {
      let receipt = null;
      try { receipt = await loadReceipt(operation); } catch { /* closed launch failure */ }
      annotateAppearanceSmokeReceipt(error, receipt?.receipt ?? receipt, operation);
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
      run: operationResult && typeof operationResult === "object" && !Array.isArray(operationResult)
        ? operationResult.run ?? operationResult : operationResult,
      launchExecutablePath: operationResult?.launchExecutablePath,
      receipt,
      source: operation === "RAW_P" ? "raw-archive" : "npm-package",
    });
  }
  return validateAppearanceCssomSmokeRuns(entries, executableSha256);
}

