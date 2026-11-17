// Finite, source-only orchestration for the held original-Mac saved-carrier
// illustration lane.  This module validates receipts produced by the future
// I runner; it does not launch a process, read a fixture, or activate a lane.

export const ILLUSTRATION_CONTROLLER_SCHEMA = "nebular.source-native-illustration-i-orchestration-v1";
export const ILLUSTRATION_RESULT_SCHEMA = "nebular.source-native-illustration-smoke-v1";
export const ILLUSTRATION_PROFILE = "saved-carrier-readonly-v1";
export const ILLUSTRATION_PLATFORM = "darwin-arm64";
export const ILLUSTRATION_TARGET = "aarch64-apple-darwin";
export const ILLUSTRATION_SCENARIO = "I";
export const ILLUSTRATION_I_OPERATIONS = Object.freeze(["RAW_I", "NPM_I"]);
export const EXISTING_MAC_OPERATIONS = Object.freeze(["RAW_A", "NPM_A", "RAW_M", "NPM_M"]);
export const EXISTING_APPEARANCE_OPERATIONS = Object.freeze(["RAW_P", "NPM_P"]);
export const EXISTING_AMP_OPERATIONS = Object.freeze([
  ...EXISTING_MAC_OPERATIONS,
  ...EXISTING_APPEARANCE_OPERATIONS,
]);

// These are the exact current source-owned test names.  They are only a source
// list in this afterimage; no Cargo target is invoked here.
export const REQUIRED_ILLUSTRATION_RUST_TESTS = Object.freeze([
  "sidecar::illustration_protocol::tests::illustration_nullable_fields_require_presence_and_accept_explicit_null",
  "sidecar::illustration_protocol::tests::snapshot_is_closed_and_public_selection_has_no_directory",
  "sidecar::illustration_protocol::tests::request_shapes_are_private_and_closed",
  "sidecar::illustration_protocol::tests::preview_digest_and_canonical_base64_are_bound",
  "sidecar::illustration_protocol::tests::bounds_and_semantic_labels_are_closed",
  "sidecar::illustration_protocol::tests::credential_detector_preserves_prefix_lengths_and_boundaries",
  "sidecar::supervisor::illustration::tests::illustration_initialize_requires_exact_negotiated_capability",
  "sidecar::supervisor::illustration::tests::legacy_initialize_does_not_admit_illustration_capability",
  "sidecar::supervisor::illustration::tests::explicit_null_is_not_an_absent_legacy_capability",
  "commands::illustration::tests::illustration_command_inputs_have_no_path_or_method_authority",
  "release_smoke::tests::illustration_scenario_is_mac_only_and_answers_the_public_carrier_twice",
]);

// This is a separate requested Cargo integration-test target, not another
// lib-test prefix. The target name is the maintained scene_inventory binary;
// the two fixed test names are checked independently before execution.
export const REQUIRED_SCENE_INVENTORY_TEST_TARGET = "scene_inventory";
export const REQUIRED_SCENE_INVENTORY_TESTS = Object.freeze([
  "handlers_inventory_permissions_and_scene_bridge_agree",
  "negative_inventory_checks_reject_anomalies",
]);

export const LEGACY_RUST_GATE_COUNT = 17;
export const LEGACY_POLICY_GATE_COUNT = 10;
export const LEGACY_REAL_USER_STATE_OBSERVATIONS = 7;
export const ILLUSTRATION_NAMESPACE_OBSERVATIONS = 2;

export const REQUIRED_LEGACY_RUST_TESTS = Object.freeze([
  "sidecar::artifact::tests::installed_modes_allow_only_exact_or_complete_write_bit_removal",
  "sidecar::artifact::tests::installed_modes_accept_exact_and_readonly_verification",
  "sidecar::artifact::tests::installed_modes_reject_other_modes_bytes_and_inventory",
  "sidecar::artifact::tests::installed_modes_revalidate_retained_identity",
  "sidecar::artifact::tests::source_build_scene_and_loom_pins_use_closed_typed_bindings",
  "sidecar::artifact::tests::source_build_compiled_pins_reject_resealed_native_identity",
  "release_smoke::tests::material_selection_is_single_use_and_not_a_directory_override",
  "release_smoke::io::tests::material_fixture_rejects_links_modes_empty_large_and_nonregular_entries",
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

export const REQUIRED_LEGACY_POLICY_TESTS = Object.freeze([
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

export const ILLUSTRATION_STEPS = Object.freeze([
  Object.freeze({ id: "illustration-shell", via: "invoke", detail: "scenario I" }),
  Object.freeze({ id: "illustration-host-start", via: "dom", detail: "host ready" }),
  Object.freeze({ id: "illustration-open", via: "invoke", detail: "snapshot ready" }),
  Object.freeze({ id: "illustration-preview", via: "invoke", detail: "preview verified" }),
  Object.freeze({ id: "illustration-restart", via: "dom", detail: "host restarted" }),
  Object.freeze({ id: "illustration-old-handle-refused", via: "invoke", detail: "old handle refused" }),
  Object.freeze({ id: "illustration-reopen", via: "invoke", detail: "new snapshot ready" }),
  Object.freeze({ id: "illustration-preview-after-reopen", via: "invoke", detail: "new preview verified" }),
]);

// This is the fixed public fixture-551 projection.  It is deliberately a
// tuple list because the embedded driver emits ordered closed facts.
export const ILLUSTRATION_FIXED_FACTS = Object.freeze([
  Object.freeze(["illustrationProtocol", "1.3"]),
  Object.freeze(["illustrationCapabilities", "read-only"]),
  Object.freeze(["illustrationSourceMime", "image/png"]),
  Object.freeze(["illustrationSourceDimensions", "1x1"]),
  Object.freeze(["illustrationDerivativeCount", "1"]),
  Object.freeze(["illustrationSourceObservation", "metadata-only"]),
  Object.freeze(["illustrationManifestDigest", "sha256:4b2bcbf7486ce0fbba68bbee92f97cf722436aa443bfdbe0a320638d4006f9a2"]),
  Object.freeze(["illustrationRecordDigest", "sha256:6aa8f6fb2ef7a2d9da003b86923a26f5585ac2f4e75f48100921358b72f29a27"]),
  Object.freeze(["illustrationSourceDigest", "sha256:90f5e172c6ce0c7cdc4d4431d6ae858c556c35ec5807a7c42a61f8c0e59c93f6"]),
  Object.freeze(["illustrationPreview", "image/png:1x1:png-pixels-decoded"]),
  Object.freeze(["illustrationPreviewDigest", "sha256:90f5e172c6ce0c7cdc4d4431d6ae858c556c35ec5807a7c42a61f8c0e59c93f6"]),
  Object.freeze(["oldIllustrationHandle", "refused"]),
  Object.freeze(["reopenedIllustration", "new-handle"]),
  Object.freeze(["reopenedPreview", "image/png:1x1"]),
]);

export class IllustrationOrchestrationError extends Error {
  constructor(code) {
    super(`ILLUSTRATION_ORCHESTRATION_${code}`);
    this.name = "IllustrationOrchestrationError";
    this.code = code;
  }
}

const SHA256 = /^[a-f0-9]{64}$/u;
const FIXTURE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/u;
const SOURCES = Object.freeze(["raw-archive", "npm-package"]);
const RECEIPT_SCHEMA = "nebular.release-smoke-receipt-v1";
const RUN_SCHEMA = "nebular.native-rc-smoke-run-v1";

function fail(code) {
  throw new IllustrationOrchestrationError(code);
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype);
}

function exactKeys(value, expected, code = "WIRE_INVALID") {
  if (!isRecord(value)) fail(code);
  const actual = Object.getOwnPropertyNames(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])
      || Object.getOwnPropertySymbols(value).length !== 0) fail(code);
}

function exactArray(value, length, code = "WIRE_INVALID") {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== length) fail(code);
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== length + 1 || !names.includes("length")
      || Object.getOwnPropertySymbols(value).length !== 0
      || Array.from({ length }, (_, index) => String(index)).some((name) => !names.includes(name))) fail(code);
}

function safeSha(value, code = "WIRE_INVALID") {
  if (typeof value !== "string" || !SHA256.test(value)) fail(code);
  return value;
}

function safeVersion(value, code = "WIRE_INVALID") {
  if (typeof value !== "string" || !VERSION.test(value)) fail(code);
  return value;
}

function privateText(value, seen = new Set(), depth = 0) {
  if (depth > 12) return true;
  if (typeof value === "string") {
    return /(?:\/Users\/|\/private\/|\/home\/|[A-Za-z]:\\|(?:provider|model|prompt|bytesBase64|stdout|stderr))/u.test(value);
  }
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return true;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => privateText(item, seen, depth + 1));
  return Object.entries(value).some(([key, item]) => privateText(key, seen, depth + 1) || privateText(item, seen, depth + 1));
}

function validateNamespaceFact(value) {
  exactKeys(value, ["locations", "changed"], "NAMESPACE");
  if (value.locations !== 63 || value.changed !== 0) fail("NAMESPACE");
  return Object.freeze({ locations: 63, changed: 0 });
}

function validateGateSummary(value, expectedNames, code) {
  const expected = expectedNames.length;
  exactKeys(value, ["status", "expected", "passed", "failed", "tests"], code);
  if (value.status !== "passed-process-observation" || value.expected !== expected
      || value.passed !== expected || value.failed !== 0 || !Array.isArray(value.tests)
      || value.tests.length !== expected) fail(code);
  const names = new Set();
  for (const [index, row] of value.tests.entries()) {
    exactKeys(row, ["name", "passed", "failed"], code);
    if (row.name !== expectedNames[index] || typeof row.name !== "string" || row.name.length < 1 || row.name.length > 240
        || !/^[A-Za-z0-9_:.-]+$/u.test(row.name) || names.has(row.name)
        || row.passed !== 1 || row.failed !== 0) fail(code);
    names.add(row.name);
  }
  return Object.freeze({
    status: value.status,
    expected,
    passed: expected,
    failed: 0,
    tests: Object.freeze(value.tests.map(({ name }) => Object.freeze({ name, passed: 1, failed: 0 }))),
  });
}

function validateLegacyRealUserState(value) {
  exactKeys(value, ["method", "locations", "observations", "status"], "REAL_USER_STATE");
  if (value.method !== "fixed-app-namespace-absence-metadata" || value.locations !== 63
      || value.observations !== LEGACY_REAL_USER_STATE_OBSERVATIONS || value.status !== "passed") fail("REAL_USER_STATE");
  return Object.freeze({ method: value.method, locations: 63, observations: 7, status: value.status });
}

function validateReceiptEnvelope(value) {
  exactKeys(value, ["receipt", "sha256"], "I_RECEIPT");
  safeSha(value.sha256, "I_RECEIPT");
  if (!isRecord(value.receipt)) fail("I_RECEIPT");
  return value;
}

function validateStepProjection(step, index, includeDetail) {
  exactKeys(step, includeDetail ? ["id", "ok", "via", "ms", "detail"] : ["id", "ok", "via", "ms"], "I_RECEIPT");
  const expected = ILLUSTRATION_STEPS[index];
  if (step.id !== expected.id || step.ok !== true || step.via !== expected.via
      || (includeDetail && step.detail !== expected.detail)
      || !Number.isSafeInteger(step.ms) || step.ms < 0 || step.ms > 86_400_000) fail("I_RECEIPT");
}

function validateFacts(value) {
  exactArray(value, ILLUSTRATION_FIXED_FACTS.length, "I_RECEIPT");
  for (const [index, expected] of ILLUSTRATION_FIXED_FACTS.entries()) {
    exactArray(value[index], 2, "I_RECEIPT");
    if (value[index][0] !== expected[0] || value[index][1] !== expected[1]) fail("I_RECEIPT");
  }
  return Object.freeze(ILLUSTRATION_FIXED_FACTS.map(([key, item]) => Object.freeze([key, item])));
}

function validateFullReceipt(value, executableSha256) {
  exactKeys(value, ["schema", "scenario", "status", "applicationVersion", "target", "pid", "startedAtUnixMs", "finishedAtUnixMs", "awaitingSignal", "executable", "driver", "failure"], "I_RECEIPT");
  if (value.schema !== RECEIPT_SCHEMA || value.scenario !== ILLUSTRATION_SCENARIO || value.status !== "pass"
      || !safeVersion(value.applicationVersion, "I_RECEIPT") || value.target !== ILLUSTRATION_TARGET
      || !Number.isSafeInteger(value.pid) || value.pid < 1
      || !Number.isSafeInteger(value.startedAtUnixMs) || value.startedAtUnixMs < 0
      || !Number.isSafeInteger(value.finishedAtUnixMs) || value.finishedAtUnixMs < value.startedAtUnixMs
      || value.awaitingSignal !== false || value.failure !== null) fail("I_RECEIPT");
  exactKeys(value.executable, ["dev", "ino", "size", "sha256"], "I_RECEIPT");
  for (const key of ["dev", "ino", "size"]) {
    if (!Number.isSafeInteger(value.executable[key]) || value.executable[key] < 0) fail("I_RECEIPT");
  }
  if (value.executable.sha256 !== executableSha256) fail("I_RECEIPT");
  exactKeys(value.driver, ["status", "scenario", "steps", "facts"], "I_RECEIPT");
  if (value.driver.status !== "pass" || value.driver.scenario !== ILLUSTRATION_SCENARIO) fail("I_RECEIPT");
  exactArray(value.driver.steps, ILLUSTRATION_STEPS.length, "I_RECEIPT");
  value.driver.steps.forEach((step, index) => validateStepProjection(step, index, true));
  const facts = validateFacts(value.driver.facts);
  if (privateText(value)) fail("I_PRIVACY");
  return { facts };
}

function validateRun(value, source, executableSha256, receiptSha256) {
  if (!isRecord(value) || value.schema !== RUN_SCHEMA || typeof value.label !== "string"
      || value.platform !== ILLUSTRATION_PLATFORM || value.scenario !== ILLUSTRATION_SCENARIO
      || value.source !== source || value.status !== "pass" || !Array.isArray(value.problems)
      || value.problems.length !== 0 || !isRecord(value.executable) || !isRecord(value.receipt)
      || !isRecord(value.checks) || !isRecord(value.exit)) fail("I_RECEIPT");
  exactKeys(value.executable, ["dev", "ino", "sha256", "size", "mode", "executable"], "I_RECEIPT");
  if (value.executable.sha256 !== executableSha256 || !Number.isSafeInteger(value.executable.size)
      || value.executable.size < 1 || !Number.isSafeInteger(value.executable.dev) || value.executable.dev < 0
      || !Number.isSafeInteger(value.executable.ino) || value.executable.ino < 0
      || !Number.isInteger(value.executable.mode) || (value.executable.mode & 0o111) === 0
      || value.executable.executable !== true) fail("I_RECEIPT");
  exactKeys(value.receipt, ["sha256", "status", "steps", "executable"], "I_RECEIPT");
  if (value.receipt.sha256 !== receiptSha256 || value.receipt.status !== "pass") fail("I_RECEIPT");
  exactArray(value.receipt.steps, ILLUSTRATION_STEPS.length, "I_RECEIPT");
  value.receipt.steps.forEach((step, index) => validateStepProjection(step, index, false));
  exactKeys(value.receipt.executable, ["dev", "ino", "size", "sha256"], "I_RECEIPT");
  if (value.receipt.executable.sha256 !== executableSha256) fail("I_RECEIPT");
  exactKeys(value.checks.persistentUserState, ["locations", "changed"], "I_RECEIPT");
  validateNamespaceFact(value.checks.persistentUserState);
  exactKeys(value.checks.orphans, ["count"], "I_RECEIPT");
  if (value.checks.orphans.count !== 0) fail("I_RECEIPT");
  exactKeys(value.checks.fixtureEffects, ["illustration"], "I_RECEIPT");
  exactKeys(value.checks.fixtureEffects.illustration, ["added", "removed", "changed", "unchanged"], "I_RECEIPT");
  const effect = value.checks.fixtureEffects.illustration;
  if (!Array.isArray(effect.added) || !Array.isArray(effect.removed) || !Array.isArray(effect.changed)
      || effect.added.length !== 0 || effect.removed.length !== 0 || effect.changed.length !== 0
      || effect.unchanged !== true) fail("I_RECEIPT");
  exactKeys(value.exit, ["code", "signal", "signalSent", "durationMs"], "I_RECEIPT");
  if (value.exit.code !== 0 || value.exit.signal !== null || value.exit.signalSent !== null
      || !Number.isSafeInteger(value.exit.durationMs) || value.exit.durationMs < 0) fail("I_RECEIPT");
  if (privateText(value)) fail("I_PRIVACY");
}

function validateEntry(entry, executableSha256) {
  exactKeys(entry, ["source", "run", "receipt", "namespaceBefore", "namespaceAfter"], "I_ENTRY");
  if (!SOURCES.includes(entry.source)) fail("I_ENTRY");
  validateReceiptEnvelope(entry.receipt);
  const receiptProjection = validateFullReceipt(entry.receipt.receipt, executableSha256);
  validateRun(entry.run, entry.source, executableSha256, entry.receipt.sha256);
  validateNamespaceFact(entry.namespaceBefore);
  validateNamespaceFact(entry.namespaceAfter);
  return Object.freeze({
    source: entry.source,
    receiptSha256: entry.receipt.sha256,
    executableSha256,
    steps: Object.freeze(ILLUSTRATION_STEPS.map(({ id }) => id)),
    facts: receiptProjection.facts,
    namespaceBefore: Object.freeze({ locations: 63, changed: 0 }),
    namespaceAfter: Object.freeze({ locations: 63, changed: 0 }),
  });
}

function validateEntries(entries, executableSha256) {
  exactArray(entries, ILLUSTRATION_I_OPERATIONS.length, "I_RUNS");
  safeSha(executableSha256, "I_RUNS");
  const runs = entries.map((entry) => validateEntry(entry, executableSha256));
  if (new Set(runs.map(({ source }) => source)).size !== SOURCES.length
      || SOURCES.some((source) => !runs.some((row) => row.source === source))
      || runs[0]?.source !== SOURCES[0] || runs[1]?.source !== SOURCES[1]) fail("I_RUNS");
  return Object.freeze(runs);
}

function publicGateSummary(value, expectedNames, code) {
  return validateGateSummary(value, expectedNames, code);
}

function makeEvidence({ runs, requiredRustTests, requiredPolicyTests, additionalRustTests, sceneInventoryTests, legacyRealUserState }) {
  const normalizedRust = publicGateSummary(requiredRustTests, REQUIRED_LEGACY_RUST_TESTS, "LEGACY_RUST_GATES");
  const normalizedPolicy = publicGateSummary(requiredPolicyTests, REQUIRED_LEGACY_POLICY_TESTS, "LEGACY_POLICY_GATES");
  const normalizedAdditionalRust = publicGateSummary(additionalRustTests, REQUIRED_ILLUSTRATION_RUST_TESTS, "ILLUSTRATION_RUST_GATES");
  const normalizedSceneInventory = publicGateSummary(sceneInventoryTests, REQUIRED_SCENE_INVENTORY_TESTS, "SCENE_INVENTORY_GATES");
  const normalizedLegacyState = validateLegacyRealUserState(legacyRealUserState);
  exactArray(runs, ILLUSTRATION_I_OPERATIONS.length, "I_RUNS");
  const normalizedRuns = Object.freeze(runs.map((row) => {
    exactKeys(row, ["source", "receiptSha256", "executableSha256", "steps", "facts", "namespaceBefore", "namespaceAfter"], "I_RUNS");
    safeSha(row.receiptSha256, "I_RUNS");
    safeSha(row.executableSha256, "I_RUNS");
    exactArray(row.steps, ILLUSTRATION_STEPS.length, "I_RUNS");
    ILLUSTRATION_STEPS.forEach(({ id }, index) => { if (row.steps[index] !== id) fail("I_RUNS"); });
    validateFacts(row.facts);
    validateNamespaceFact(row.namespaceBefore);
    validateNamespaceFact(row.namespaceAfter);
    return Object.freeze({
      source: row.source,
      receiptSha256: row.receiptSha256,
      executableSha256: row.executableSha256,
      steps: Object.freeze([...row.steps]),
      facts: Object.freeze(row.facts.map(([key, value]) => Object.freeze([key, value]))),
      namespaceBefore: Object.freeze({ locations: 63, changed: 0 }),
      namespaceAfter: Object.freeze({ locations: 63, changed: 0 }),
    });
  }));
  if (new Set(normalizedRuns.map(({ source }) => source)).size !== SOURCES.length
      || normalizedRuns[0]?.source !== SOURCES[0] || normalizedRuns[1]?.source !== SOURCES[1]) fail("I_RUNS");
  return Object.freeze({
    schema: ILLUSTRATION_RESULT_SCHEMA,
    profile: ILLUSTRATION_PROFILE,
    status: "passed-process-observation",
    platform: ILLUSTRATION_PLATFORM,
    scenario: ILLUSTRATION_SCENARIO,
    nativeAcceptance: "not-claimed",
    authoring: false,
    legacyRealUserState: normalizedLegacyState,
    namespaceObservations: Object.freeze({ legacyA_M_P: 7, illustrationI: 2, total: 9 }),
    requiredRustTests: normalizedRust,
    requiredPolicyTests: normalizedPolicy,
    additionalRustTests: normalizedAdditionalRust,
    sceneInventoryTests: normalizedSceneInventory,
    runs: normalizedRuns,
  });
}

/** Validate one independent raw/npm I receipt and return its path-free row. */
export function validateIllustrationSmokeRun({ entry, executableSha256 }) {
  safeSha(executableSha256, "I_ENTRY");
  return validateEntry(entry, executableSha256);
}

/** Validate exactly the raw and npm I pair without launching either operation. */
export function validateIllustrationSmokeRuns(entries, executableSha256) {
  return validateEntries(entries, executableSha256);
}

/** Build the strict top-level illustration projection from validated rows. */
export function buildIllustrationEvidence({ runs, requiredRustTests, requiredPolicyTests, additionalRustTests, sceneInventoryTests, legacyRealUserState }) {
  return makeEvidence({ runs, requiredRustTests, requiredPolicyTests, additionalRustTests, sceneInventoryTests, legacyRealUserState });
}

/** Validate the complete public I projection, including its named Rust gates. */
export function validateIllustrationEvidence(value) {
  exactKeys(value, ["schema", "profile", "status", "platform", "scenario", "nativeAcceptance", "authoring",
    "legacyRealUserState", "namespaceObservations", "requiredRustTests", "requiredPolicyTests",
    "additionalRustTests", "sceneInventoryTests", "runs"], "I_EVIDENCE");
  if (value.schema !== ILLUSTRATION_RESULT_SCHEMA || value.profile !== ILLUSTRATION_PROFILE
      || value.status !== "passed-process-observation" || value.platform !== ILLUSTRATION_PLATFORM
      || value.scenario !== ILLUSTRATION_SCENARIO || value.nativeAcceptance !== "not-claimed"
      || value.authoring !== false) fail("I_EVIDENCE");
  exactKeys(value.namespaceObservations, ["legacyA_M_P", "illustrationI", "total"], "I_EVIDENCE");
  if (value.namespaceObservations.legacyA_M_P !== 7 || value.namespaceObservations.illustrationI !== 2
      || value.namespaceObservations.total !== 9) fail("I_EVIDENCE");
  return makeEvidence({
    runs: value.runs,
    requiredRustTests: value.requiredRustTests,
    requiredPolicyTests: value.requiredPolicyTests,
    additionalRustTests: value.additionalRustTests,
    sceneInventoryTests: value.sceneInventoryTests,
    legacyRealUserState: value.legacyRealUserState,
  });
}

/**
 * Run only the explicit I pair after the complete A/M/P checkpoint.  The
 * callback boundary is injectable for source tests; this module itself never
 * launches native code or calls a provider.
 */
export async function runExplicitIllustrationI({
  enabled = false,
  platform,
  completedOperations,
  executableSha256,
  requiredRustTests,
  requiredPolicyTests,
  additionalRustTests,
  sceneInventoryTests,
  legacyRealUserState,
  runOperation,
  loadReceipt,
  preserveOperationError = null,
}) {
  if (enabled !== true) fail("I_NOT_EXPLICIT");
  if (platform !== ILLUSTRATION_PLATFORM) fail("I_PLATFORM");
  if (!Array.isArray(completedOperations) || completedOperations.length !== EXISTING_AMP_OPERATIONS.length
      || completedOperations.some((operation, index) => operation !== EXISTING_AMP_OPERATIONS[index])) fail("EXISTING_AMP_REQUIRED");
  safeSha(executableSha256, "I_CALLBACKS");
  publicGateSummary(requiredRustTests, REQUIRED_LEGACY_RUST_TESTS, "LEGACY_RUST_GATES");
  publicGateSummary(requiredPolicyTests, REQUIRED_LEGACY_POLICY_TESTS, "LEGACY_POLICY_GATES");
  validateLegacyRealUserState(legacyRealUserState);
  if (typeof runOperation !== "function" || typeof loadReceipt !== "function") fail("I_CALLBACKS");
  if (preserveOperationError !== null && typeof preserveOperationError !== "function") fail("I_CALLBACKS");
  const entries = [];
  for (const operation of ILLUSTRATION_I_OPERATIONS) {
    let operationResult;
    try {
      operationResult = await runOperation(operation);
    } catch (error) {
      if (error instanceof IllustrationOrchestrationError) throw error;
      if (preserveOperationError?.(error) === true) throw error;
      fail("I_OPERATION_FAILED");
    }
    exactKeys(operationResult, ["run", "namespaceBefore", "namespaceAfter"], "I_OPERATION_FAILED");
    let receipt;
    try {
      receipt = await loadReceipt(operation);
    } catch (error) {
      if (error instanceof IllustrationOrchestrationError || preserveOperationError?.(error) === true) throw error;
      fail("I_RECEIPT_UNAVAILABLE");
    }
    entries.push({
      source: operation === "RAW_I" ? "raw-archive" : "npm-package",
      run: operationResult.run,
      namespaceBefore: operationResult.namespaceBefore,
      namespaceAfter: operationResult.namespaceAfter,
      receipt,
    });
  }
  const runs = validateEntries(entries, executableSha256);
  return makeEvidence({ runs, requiredRustTests, requiredPolicyTests, additionalRustTests, sceneInventoryTests, legacyRealUserState });
}

