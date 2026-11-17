// Held source-only planner/evaluator for the Linux AArch64 Rust groups.
//
// This module is deliberately effect-free: it builds fixed Cargo argv
// descriptors and evaluates results supplied by a later host-owned run port.
// It never spawns Cargo, selects a working directory, reads an environment, or
// retains child output.

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export const PLAN_SCHEMA = "nebular.linux-aarch64-rust-groups-plan-v1";
export const RESULT_SCHEMA = "nebular.linux-aarch64-rust-groups-result-v1";
export const TARGET = "aarch64-unknown-linux-gnu";
export const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024;
export const REQUIRED_CLEANUP = "leader-close-observed";

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
export const REQUIRED_PLATFORM_TESTS = Object.freeze([
  "platform::tests::product_target_map_has_no_foreign_fallback",
  "platform::tests::hostile_path_missing_and_substituted_owned_runtime_rejected",
  "platform::tests::packaged_bundle_detection_requires_contents_ancestor",
  "platform::tests::nofollow_rejects_symlink_at_open",
]);
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

export const FAILURE_CODES = Object.freeze([
  "PLAN_INVALID",
  "PORT_INVALID",
  "PORT_RESULT_INVALID",
  "RUN_PORT_ERROR",
  "PROCESS_FAILURE",
  "OUTPUT_LIMIT",
  "INVALID_UTF8",
  "PROCESS_EXIT",
  "PROCESS_SIGNAL",
  "CLEANUP_UNCONFIRMED",
  "RUST_TEST_LIST",
  "RUST_TEST_LIST_NAMES",
  "RUST_TEST_ROWS",
  "RUST_TEST_SUMMARY",
  "INTERNAL",
]);

const GROUPS = Object.freeze([
  Object.freeze({
    id: "installed-modes",
    kind: "lib",
    selector: "sidecar::artifact::tests::installed_modes_",
    names: REQUIRED_INSTALLED_MODE_TESTS,
  }),
  Object.freeze({
    id: "source-pins",
    kind: "lib",
    selector: "sidecar::artifact::tests::source_build_",
    names: REQUIRED_SOURCE_PIN_TESTS,
  }),
  Object.freeze({
    id: "platform",
    kind: "lib",
    selector: "platform::tests::",
    names: REQUIRED_PLATFORM_TESTS,
  }),
  Object.freeze({
    id: "policy",
    kind: "policy",
    selector: "policy",
    names: REQUIRED_POLICY_TESTS,
  }),
]);

class LinuxRustGroupError extends Error {
  constructor(code) {
    super(code);
    this.name = "LinuxRustGroupError";
    this.code = code;
  }
}

export { LinuxRustGroupError };

function fail(code) {
  throw new LinuxRustGroupError(code);
}

function freezeDeep(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function commandFor(group, phase) {
  const args = ["cargo", "test", "--locked", "--offline", "--target", TARGET];
  if (group.kind === "lib") args.push("--lib", group.selector);
  else args.push("--test", group.selector);
  args.push("--");
  if (phase === "list") args.push("--list");
  else if (phase === "run") args.push("--test-threads=1");
  else fail("PLAN_INVALID");
  return Object.freeze({ phase, group: group.id, argv: Object.freeze(args) });
}

function planValue() {
  return {
    schema: PLAN_SCHEMA,
    target: TARGET,
    cleanup: REQUIRED_CLEANUP,
    outputCapBytes: MAX_COMMAND_OUTPUT_BYTES,
    groups: GROUPS.map((group) => ({
      id: group.id,
      kind: group.kind,
      selector: group.selector,
      names: [...group.names],
      list: commandFor(group, "list"),
      run: commandFor(group, "run"),
    })),
    requiredLibraryTests: REQUIRED_INSTALLED_MODE_TESTS.length
      + REQUIRED_SOURCE_PIN_TESTS.length
      + REQUIRED_PLATFORM_TESTS.length,
    requiredPolicyTests: REQUIRED_POLICY_TESTS.length,
  };
}

export function createLinuxRustGroupPlan() {
  return freezeDeep(planValue());
}

function validatePlan(plan) {
  if (!isDeepStrictEqual(plan, planValue())) fail("PLAN_INVALID");
}

function ownData(record, key) {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !Object.hasOwn(descriptor, "value")) fail("PORT_RESULT_INVALID");
  return descriptor.value;
}

function optionalOwnData(record, key) {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) return { present: false, value: undefined };
  if (!Object.hasOwn(descriptor, "value")) fail("PORT_RESULT_INVALID");
  return { present: true, value: descriptor.value };
}

function outputBytes(value) {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (value instanceof Uint8Array) return Buffer.from(value);
  fail("PORT_RESULT_INVALID");
}

function outputMetadata(value) {
  const bytes = outputBytes(value);
  if (bytes.byteLength > MAX_COMMAND_OUTPUT_BYTES) fail("OUTPUT_LIMIT");
  return {
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    text: decodeUtf8(bytes),
  };
}

function decodeUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("INVALID_UTF8");
  }
}

function normalizeProcessResult(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("PORT_RESULT_INVALID");
  const failure = optionalOwnData(value, "failure");
  if (failure.present && failure.value !== null && failure.value !== undefined) fail("PROCESS_FAILURE");
  const stdout = outputMetadata(ownData(value, "stdout"));
  const stderr = outputMetadata(ownData(value, "stderr"));
  const exitCode = ownData(value, "exitCode");
  const signal = ownData(value, "signal");
  const cleanup = ownData(value, "cleanup");
  if (exitCode !== null && (!Number.isInteger(exitCode) || exitCode < 0)) fail("PORT_RESULT_INVALID");
  if (signal !== null && (typeof signal !== "string" || signal.length === 0)) fail("PORT_RESULT_INVALID");
  if (typeof cleanup !== "string") fail("PORT_RESULT_INVALID");
  return { stdout, stderr, exitCode, signal, cleanup };
}

function safeClosedErrorCode(error) {
  try {
    if (!(error instanceof LinuxRustGroupError)) return "INTERNAL";
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return "INTERNAL";
    const code = descriptor.value;
    return typeof code === "string" && FAILURE_CODES.includes(code) ? code : "INTERNAL";
  } catch {
    return "INTERNAL";
  }
}

function requireCleanProcess(value) {
  if (value.cleanup !== REQUIRED_CLEANUP) fail("CLEANUP_UNCONFIRMED");
  if (value.signal !== null) fail("PROCESS_SIGNAL");
  if (value.exitCode !== 0) fail("PROCESS_EXIT");
  return value;
}

function expectedSummaryLine(count) {
  return `${count} ${count === 1 ? "test" : "tests"}, 0 benchmarks`;
}

function sameNames(observed, expected) {
  return observed.length === expected.length
    && new Set(observed).size === expected.length
    && expected.every((name) => observed.includes(name));
}

function parseRustTestList(text, expected) {
  const lines = text.split(/\r?\n/u).filter(Boolean);
  if (lines.length !== expected.length + 1 || lines.at(-1) !== expectedSummaryLine(expected.length)) fail("RUST_TEST_LIST");
  const observed = lines.slice(0, -1).map((line) => line.endsWith(": test") ? line.slice(0, -6) : null);
  if (observed.some((name) => name === null) || !sameNames(observed, expected)) fail("RUST_TEST_LIST_NAMES");
  return observed;
}

const SUMMARY_RE = /^test result: ok\.\s+(\d+) passed;\s+(\d+) failed;\s+(\d+) ignored;\s+(\d+) measured;\s+\d+ filtered out;.*$/u;

function parseRustTestRun(text, expected) {
  const lines = text.split(/\r?\n/u).filter(Boolean);
  const summaries = lines.map((line) => line.match(SUMMARY_RE)).filter(Boolean);
  if (summaries.length !== 1) fail("RUST_TEST_SUMMARY");
  const summary = summaries[0];
  if (Number(summary[1]) !== expected.length || Number(summary[2]) !== 0 || Number(summary[3]) !== 0 || Number(summary[4]) !== 0) fail("RUST_TEST_SUMMARY");

  const rows = [];
  for (const line of lines) {
    if (!line.startsWith("test ")) continue;
    const match = /^test (.+) \.\.\. (.+)$/u.exec(line);
    if (!match) continue;
    if (match[2] !== "ok") fail("RUST_TEST_ROWS");
    rows.push(match[1]);
  }
  if (!sameNames(rows, expected)) fail("RUST_TEST_ROWS");
  return { passed: Number(summary[1]), failed: Number(summary[2]), ignored: Number(summary[3]), rows };
}

function processEvidence(value) {
  return {
    status: "passed-process-observation",
    exitCode: value.exitCode,
    stdoutBytes: value.stdout.bytes,
    stdoutSha256: value.stdout.sha256,
    stderrBytes: value.stderr.bytes,
    stderrSha256: value.stderr.sha256,
    cleanup: value.cleanup,
  };
}

function failedResult(failureCode, completedGroups, observations, failedGroup = null, failedPhase = null) {
  return {
    schema: RESULT_SCHEMA,
    status: "failed",
    target: TARGET,
    failureCode,
    failedGroup,
    failedPhase,
    completedGroups: [...completedGroups],
    observations: [...observations],
    nativeAcceptance: "not-claimed",
  };
}

function successResult(observations) {
  const libraryExpected = REQUIRED_INSTALLED_MODE_TESTS.length
    + REQUIRED_SOURCE_PIN_TESTS.length
    + REQUIRED_PLATFORM_TESTS.length;
  return {
    schema: RESULT_SCHEMA,
    status: "passed-process-observation",
    target: TARGET,
    groups: observations,
    requiredLibraryTests: libraryExpected,
    requiredPolicyTests: REQUIRED_POLICY_TESTS.length,
    totals: { expected: libraryExpected + REQUIRED_POLICY_TESTS.length, passed: libraryExpected + REQUIRED_POLICY_TESTS.length, failed: 0, ignored: 0 },
    nativeAcceptance: "not-claimed",
  };
}

async function invoke(runPort, command) {
  let result;
  try {
    result = await runPort.run(command);
  } catch {
    fail("RUN_PORT_ERROR");
  }
  return normalizeProcessResult(result);
}

export async function evaluateLinuxRustGroups(plan, runPort) {
  const completedGroups = [];
  const observations = [];
  try {
    validatePlan(plan);
    if (runPort === null || typeof runPort !== "object" || typeof runPort.run !== "function") fail("PORT_INVALID");
    for (const group of plan.groups) {
      let listProcess;
      try {
        listProcess = requireCleanProcess(await invoke(runPort, group.list));
        const listNames = parseRustTestList(listProcess.stdout.text, group.names);
        let runProcess;
        try {
          runProcess = requireCleanProcess(await invoke(runPort, group.run));
        } catch (error) {
          return failedResult(safeClosedErrorCode(error), completedGroups, observations, group.id, "run");
        }
        let runSummary;
        try {
          runSummary = parseRustTestRun(runProcess.stdout.text, group.names);
        } catch (error) {
          return failedResult(safeClosedErrorCode(error), completedGroups, observations, group.id, "run");
        }
        observations.push({
          id: group.id,
          kind: group.kind,
          selector: group.selector,
          names: [...listNames],
          expected: group.names.length,
          passed: runSummary.passed,
          failed: runSummary.failed,
          ignored: runSummary.ignored,
          list: processEvidence(listProcess),
          run: processEvidence(runProcess),
          status: "passed-process-observation",
        });
        completedGroups.push(group.id);
      } catch (error) {
        return failedResult(safeClosedErrorCode(error), completedGroups, observations, group.id, "list");
      }
    }
    return successResult(observations);
  } catch (error) {
    return failedResult(safeClosedErrorCode(error), completedGroups, observations);
  }
}
