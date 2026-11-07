#!/usr/bin/env node
// Native release-candidate smoke harness.
//
// Launches the exact extracted candidate executable in its compiled-in release smoke mode
// (src-tauri/src/release_smoke), which opens the real window and packaged frontend, drives the real
// JS-to-Rust command bridge and embedded sidecar, writes a receipt and quits. This harness only
// prepares scratch state and fixtures from maintained public fixtures, launches, and judges:
//
//   * the receipt: schema, scenario, every required step, and the SHA-256 of the running executable,
//     which must equal the candidate executable measured before launch (no other binary ran);
//   * no orphan: after exit no process whose executable lies inside the candidate remains;
//   * no persistent user state: HOME, XDG and TMPDIR point into scratch, and the real user's
//     application directories for this identifier are unchanged;
//   * fixture effects: the case-exact derived output (scenario C) and untouched siblings.
//
// Scenario C-signal instead leaves the sidecar running, then sends SIGTERM to the application process
// only; the sidecar must exit on its own (stdin EOF) within a bound.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readRegularSnapshot } from "./fs-snapshot.mjs";
import { nativeLauncher } from "./native-launcher.mjs";
import { verifyPlatformPackage } from "./native-rc-package.mjs";
import { selectPayloadNativeRuntime } from "./native-runtime.mjs";
import { buildExpectations, verifyExpectationsArtifact } from "./appearance-matrix-prep1/generate.mjs";

export const APPLICATION_IDENTIFIER = "ai.knowledgeforge.themeforge.nebularfusion";
export const RECEIPT_SCHEMA = "nebular.release-smoke-receipt-v1";
export const RUN_SCHEMA = "nebular.native-rc-smoke-run-v1";
export const FINALIZATION_SCHEMA = "nebular.native-rc-finalization-v1";
export const SCENARIOS = Object.freeze({
  A: Object.freeze({ platforms: ["darwin-arm64"], steps: ["app-shell", "host-start", "host-status", "project-open", "brand-read", "theme-lab-compile", "app-theme-status", "app-theme-compile", "brand-system-view", "host-status-final"] }),
  B: Object.freeze({ platforms: ["linux-arm64"], caseSensitive: true, steps: ["app-shell", "app-theme-status", "app-theme-compile", "theme-lab-compile", "brand-system-view", "host-start", "host-status", "project-open-upper", "brand-read-upper", "project-open-lower", "brand-read-lower", "host-status-final"] }),
  C: Object.freeze({ platforms: ["linux-x64"], caseSensitive: true, steps: ["app-shell", "host-start", "host-start-idempotent", "host-stop", "host-start-again", "host-status", "project-open-case", "derive-plan-cancel", "derive-plan-apply", "host-status-final"] }),
  "C-signal": Object.freeze({ platforms: ["linux-x64"], caseSensitive: true, signal: true, steps: ["app-shell", "host-start", "host-start-idempotent", "host-stop", "host-start-again", "host-status", "project-open-case", "derive-plan-cancel", "derive-plan-apply", "host-status-final"] }),
  "P-save": Object.freeze({ platforms: ["darwin-arm64", "linux-arm64", "linux-x64"], steps: ["p-save-shell", "p-save-load-missing", "p-save-select-family", "p-save-select-mode", "p-save-apply", "p-save-load-saved"] }),
  "P-restart": Object.freeze({ platforms: ["darwin-arm64", "linux-arm64", "linux-x64"], steps: ["p-restart-shell", "p-restart-startup", "p-restart-load-exact"] }),
  "paired-v2": Object.freeze({ platforms: ["darwin-arm64", "linux-arm64", "linux-x64"], steps: ["app-shell", "paired-app-theme", "paired-open-developer", "paired-brief", "paired-three-edits", "paired-compile-both", "paired-preview-acks", "paired-create-candidate", "paired-review-association", "paired-select-candidate", "paired-appearance-dark", "paired-apply-detached", "paired-save-as", "paired-reopen", "paired-appearance-matrix"] }),
});
export const SEAL_ONLY_SCENARIOS = Object.freeze({
  "appearance-pair": Object.freeze({ platforms: ["darwin-arm64", "linux-arm64", "linux-x64"], steps: ["p-save", "p-restart"] }),
});
export const PLATFORM_SCENARIOS = Object.freeze({ "darwin-arm64": ["A"], "linux-arm64": ["B"], "linux-x64": ["C", "C-signal"] });
export const APPEARANCE_PAIR_SCENARIOS = Object.freeze(["appearance-pair", "paired-v2"]);
export const APPEARANCE_FAILURE_CATEGORIES = Object.freeze([
  "appearance-startup-backend-unsupported",
  "appearance-startup-load-rejected",
  "appearance-save-failed",
  "appearance-saved-status-timeout",
  "appearance-selection-mismatch",
  "appearance-computed-mismatch",
  "appearance-record-mismatch",
  "pair-leaf-inventory-mismatch",
  "pair-layout-mismatch",
  "restart-not-persisted",
  "appearance-pair-harness-error",
]);
export const APPEARANCE_PREFERENCE_RECORD = Object.freeze({ version: 1, mode: "dark", light: "developer", dark: "developer" });
export const APPEARANCE_PREFERENCE_BYTES = Buffer.from('{"version":1,"mode":"dark","light":"developer","dark":"developer"}');
export const APPEARANCE_PREFERENCE_SHA256 = "11ed5c176d7725adcb7911ceb7a9a11943af63197dbee5d2e4317dc1df8c7540";
export const APPEARANCE_PAIR_LIMITS = Object.freeze({ markerBytes: 160, preferenceBytes: 4 * 1024, phaseTimeoutMs: 420_000, phases: 2, views: 2 });
export const APPEARANCE_MATRIX_FAMILY_IDS = Object.freeze(["terminal-nova", "nebular", "developer", "graphic-designer", "anime", "gamer"]);
export const APPEARANCE_MATRIX_MODES = Object.freeze(["light", "dark"]);
export const APPEARANCE_MATRIX_FACT_KEY = "appearanceMatrixCell";
export const APPEARANCE_MATRIX_EDITOR_PRESERVED_FACT_KEY = "appearanceMatrixEditorPreserved";
export const APPEARANCE_MATRIX_CELL_KEYS = Object.freeze(["family", "mode", "background", "primary", "fontUi", "radius", "selection", "selectionText", "rolesMatch"]);
const APPEARANCE_MATRIX_SOURCE_LIMITS = Object.freeze({ runtimeBytes: 128 * 1024, catalogBytes: 16 * 1024, expectationsBytes: 64 * 1024 });
const APPEARANCE_MATRIX_ROLE_KEYS = Object.freeze({
  background: "--background",
  primary: "--primary",
  fontUi: "--tf-appearance-font-ui",
  radius: "--tf-appearance-radius-surface",
  selection: "--tf-appearance-selection",
  selectionText: "--tf-appearance-selection-text",
});
const NPM_PLATFORM_KEYS = new Set(Object.keys(PLATFORM_SCENARIOS));
const CORE_FIXTURE = "docs/examples/v0.4/brand-system/core-minimal";
const DEFAULT_TIMEOUT_MS = 420_000;
const CLEANUP_PROBLEM = "harness cleanup of the owned scratch directory failed";
const FILESYSTEM_CODES = new Set([
  "ENOENT", "EACCES", "EPERM", "EEXIST", "ENOTDIR", "EISDIR", "ENOTEMPTY", "EBUSY", "ELOOP",
  "EMLINK", "ENOSPC", "EROFS", "EIO", "EMFILE", "ENFILE", "EXDEV", "ENAMETOOLONG", "EBADF",
]);
const PROCESS_SYSCALLS = new Set(["kill", "spawn", "spawnSync", "waitpid"]);
const PAIRED_V2_BASELINE_BYTES = 4734;
const PAIRED_V2_BASELINE_SHA256 = "7b873b36bf4f0d141e70b72a11dbc6dac7f8250de0b2479b84fe014d629597a8";
const PAIRED_V2_BASELINE_FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), "../test/fixtures/paired-v2/developer.profile.json");
const PAIRED_V2_EXCHANGE_DIR = "exchange";
const PAIRED_V2_BASELINE_NAME = "baseline.theme.json";
const PAIRED_V2_DESTINATION_NAMES = Object.freeze(["candidate-v2.json", "review-v2.json", "v2-saved.theme.json"]);

export function appearanceMatrixCellsForCheckout(checkout) {
  const checkoutRoot = resolve(checkout);
  const runtimePath = join(checkoutRoot, "src/features/appearance/generated/runtime-baselines.ts");
  const catalogPath = join(checkoutRoot, "src/features/appearance/generated/catalog-index.json");
  const expectationsPath = join(checkoutRoot, "src-tauri/src/release_smoke/appearance-role-expectations.v1.json");
  const runtimeText = readRegularSnapshot(runtimePath, { label: "Generated appearance baselines", maxBytes: APPEARANCE_MATRIX_SOURCE_LIMITS.runtimeBytes }).bytes.toString("utf8");
  const catalogText = readRegularSnapshot(catalogPath, { label: "Generated appearance catalog", maxBytes: APPEARANCE_MATRIX_SOURCE_LIMITS.catalogBytes }).bytes.toString("utf8");
  const expectations = JSON.parse(readRegularSnapshot(expectationsPath, { label: "Generated appearance expectations", maxBytes: APPEARANCE_MATRIX_SOURCE_LIMITS.expectationsBytes }).bytes.toString("utf8"));
  try {
    verifyExpectationsArtifact(expectations, { runtimeText, catalogText });
  } catch (error) {
    throw new HarnessStateError(`generated appearance expectations are stale: ${error instanceof Error ? error.message : String(error)}`);
  }
  const expected = buildExpectations({
    runtimeText,
    catalogText,
    runtimePath: "frontend-fixture/src/features/appearance/generated/runtime-baselines.ts",
    catalogPath: "frontend-fixture/src/features/appearance/generated/catalog-index.json",
  });
  const rows = expected.rows;
  for (let index = 0; index < APPEARANCE_MATRIX_FAMILY_IDS.length; index += 1) {
    const light = rows[index];
    const dark = rows[index + APPEARANCE_MATRIX_FAMILY_IDS.length];
    if (light.roles["--background"] === dark.roles["--background"] || light.roles["--tf-appearance-selection"] === dark.roles["--tf-appearance-selection"]) {
      throw new HarnessStateError(`generated appearance mode roles collapsed for ${light.family}`);
    }
  }
  return Object.freeze(rows.map(({ family, mode, roles }) => Object.freeze({
    family,
    mode,
    background: roles[APPEARANCE_MATRIX_ROLE_KEYS.background],
    primary: roles[APPEARANCE_MATRIX_ROLE_KEYS.primary],
    fontUi: roles[APPEARANCE_MATRIX_ROLE_KEYS.fontUi],
    radius: roles[APPEARANCE_MATRIX_ROLE_KEYS.radius],
    selection: roles[APPEARANCE_MATRIX_ROLE_KEYS.selection],
    selectionText: roles[APPEARANCE_MATRIX_ROLE_KEYS.selectionText],
    rolesMatch: true,
  })));
}

function parseAppearanceMatrixCell(value, expected, index, problems) {
  if (typeof value !== "string") {
    problems.push(`appearance matrix fact ${index} value is not a string`);
    return null;
  }
  if (Buffer.byteLength(value, "utf8") > 1024) {
    problems.push(`appearance matrix fact ${index} exceeds 1024 bytes`);
    return null;
  }
  let cell;
  try {
    cell = JSON.parse(value);
  } catch {
    problems.push(`appearance matrix fact ${index} is not JSON`);
    return null;
  }
  if (JSON.stringify(cell) !== value) problems.push(`appearance matrix fact ${index} is not compact canonical JSON`);
  if (cell === null || typeof cell !== "object" || Array.isArray(cell)
      || JSON.stringify(Object.keys(cell)) !== JSON.stringify(APPEARANCE_MATRIX_CELL_KEYS)) {
    problems.push(`appearance matrix fact ${index} keys are not closed and ordered`);
    return null;
  }
  if (cell.family !== expected.family || cell.mode !== expected.mode) problems.push(`appearance matrix fact ${index} family/mode order mismatch`);
  for (const role of ["background", "primary", "fontUi", "radius", "selection", "selectionText"]) {
    if (typeof cell[role] !== "string" || cell[role].length === 0) problems.push(`appearance matrix fact ${index} ${role} type/value invalid`);
    else if (cell[role] !== expected[role]) problems.push(`appearance matrix fact ${index} ${role} does not match generated source`);
  }
  if (cell.rolesMatch !== true) problems.push(`appearance matrix fact ${index} rolesMatch is not true`);
  return cell;
}

export function validateAppearanceMatrixFacts(receipt, checkout) {
  const problems = [];
  const facts = receipt?.driver?.facts;
  if (!Array.isArray(facts)) return ["appearance matrix facts are missing"];
  if (facts.length > 32) problems.push("driver facts exceed the native 32-fact bound");
  for (const [index, fact] of facts.entries()) {
    if (!Array.isArray(fact) || fact.length !== 2 || typeof fact[0] !== "string" || typeof fact[1] !== "string") {
      problems.push(`driver fact ${index} has invalid tuple shape`);
    } else if (Buffer.byteLength(fact[0], "utf8") > 64 || Buffer.byteLength(fact[1], "utf8") > 1024) {
      problems.push(`driver fact ${index} exceeds native bounds`);
    }
  }
  const matrixFacts = facts.filter((fact) => Array.isArray(fact) && fact.length === 2 && fact[0] === APPEARANCE_MATRIX_FACT_KEY);
  if (matrixFacts.length !== 12) {
    problems.push(`appearance matrix requires exactly 12 ${APPEARANCE_MATRIX_FACT_KEY} facts`);
    return problems;
  }
  let expected;
  try {
    expected = appearanceMatrixCellsForCheckout(checkout);
  } catch {
    problems.push("generated appearance role source could not be read");
    return problems;
  }
  const seen = new Set();
  matrixFacts.forEach((fact, index) => {
    const cell = parseAppearanceMatrixCell(fact[1], expected[index], index, problems);
    if (cell !== null && typeof cell.family === "string" && typeof cell.mode === "string") {
      const key = `${cell.family}:${cell.mode}`;
      if (seen.has(key)) problems.push(`appearance matrix fact ${index} is duplicated`);
      seen.add(key);
    }
  });
  return problems;
}

export function validateAppearanceMatrixEditorPreservedFact(receipt) {
  const facts = receipt?.driver?.facts;
  if (!Array.isArray(facts)) return ["appearance matrix editor-preserved fact is missing"];
  const matching = facts.filter((fact) => Array.isArray(fact) && fact.length === 2 && fact[0] === APPEARANCE_MATRIX_EDITOR_PRESERVED_FACT_KEY);
  const problems = [];
  if (matching.length !== 1) problems.push("appearance matrix editor-preserved fact must occur exactly once");
  if (matching.length === 1 && matching[0][1] !== "true") problems.push("appearance matrix editor-preserved fact must be true");
  return problems;
}

/** Authenticate the selected npm package manifest before using any projected runtime aliases. */
export function authenticateNpmPackageContext(packageRoot, platform, packageManifestSha256) {
  if (typeof packageRoot !== "string" || typeof platform !== "string" || !NPM_PLATFORM_KEYS.has(platform)
      || typeof packageManifestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(packageManifestSha256)) {
    throw new Error("Complete authenticated npm package context is required");
  }
  return verifyPlatformPackage(packageRoot, platform, packageManifestSha256);
}

class HarnessStateError extends Error {}

class SmokeReportWriteError extends Error {
  constructor(finalization, reportWriteFamily) {
    super("native RC smoke run report was not written");
    this.name = "NativeRcReportWriteError";
    this.finalization = finalization;
    this.reportWriteFamily = reportWriteFamily;
  }
}

function classifyException(error) {
  try {
    if (error instanceof HarnessStateError) return "state";
    if (error instanceof SyntaxError) return "parse";
    if (error === null || typeof error !== "object") return "unknown";
    const code = typeof error.code === "string" ? error.code : null;
    const syscall = typeof error.syscall === "string" ? error.syscall : null;
    if (code === "ETIMEDOUT") return "timeout";
    if ((syscall !== null && PROCESS_SYSCALLS.has(syscall)) || code === "ESRCH") return "process";
    if (code !== null && FILESYSTEM_CODES.has(code)) return "filesystem";
    return "unknown";
  } catch {
    return "unknown";
  }
}

function formatLegacyError(error) {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "unknown error";
  }
}

function createFinalizationTracker() {
  let phase = "pre-spawn";
  let firstFailure = null;
  let spawned = false;
  let exitObserved = false;
  let applicationReceiptObservation = "not-attempted";
  let applicationReceiptCopy = "not-attempted";
  return {
    launched() {
      spawned = true;
      phase = "post-exit";
    },
    exited() {
      exitObserved = true;
      phase = "post-exit";
    },
    receipt(read, copy) {
      phase = "receipt-copy";
      let observed;
      try {
        observed = read();
      } catch (error) {
        applicationReceiptObservation = "read-failed";
        throw error;
      }
      applicationReceiptObservation = observed ? "present-at-read" : "absent-at-read";
      if (observed) {
        try {
          copy(observed);
        } catch (error) {
          applicationReceiptCopy = "copy-failed";
          throw error;
        }
        applicationReceiptCopy = "written";
      }
      phase = "post-exit";
      return observed;
    },
    enter(nextPhase) {
      phase = nextPhase;
    },
    failed(error) {
      if (!firstFailure) {
        firstFailure = { phase, exceptionFamily: classifyException(error) };
      }
    },
    record() {
      return {
        schema: FINALIZATION_SCHEMA,
        status: firstFailure ? "failed" : "complete",
        phase: firstFailure ? firstFailure.phase : "complete",
        exceptionFamily: firstFailure ? firstFailure.exceptionFamily : null,
        spawned: Boolean(spawned),
        exitObserved: Boolean(exitObserved),
        applicationReceiptObservation,
        applicationReceiptCopy,
      };
    },
  };
}

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function executablePath(launchRoot, platform) {
  return platform.startsWith("darwin")
    ? join(launchRoot, "Theme Forge Nebular Fusion.app/Contents/MacOS/theme-forge-nebular-fusion")
    : join(launchRoot, "bin/theme-forge-nebular-fusion");
}

export function launcherPath(launchRoot, platform) {
  return platform.startsWith("darwin")
    ? executablePath(launchRoot, platform)
    : join(launchRoot, "bin/tfnf");
}

function ownerOnlyDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

// Runtime children are harness-owned fixed roots. Their private identity is bound in memory for
// phase checks; dev/ino/type/nonlink/uid/mode are identity fields. nlink/mtime/size are deliberately
// not identity invariants because native WebView/sidecar writers may update them.
function boundOwnerDirectory(path, label) {
  if (typeof process.getuid !== "function") throw new HarnessStateError(`${label} owner identity is unavailable`);
  const info = lstatSync(path);
  const uid = typeof info.uid === "number" ? info.uid : null;
  const mode = info.mode & 0o7777;
  if (!info.isDirectory() || info.isSymbolicLink() || uid === null || uid !== process.getuid() || mode !== 0o700) {
    throw new HarnessStateError(`${label} is not a real owner-only directory`);
  }
  return Object.freeze({ dev: info.dev, ino: info.ino, type: "directory", nonlink: true, uid, mode });
}

function assertBoundOwnerDirectory(path, identity, label, { empty = false } = {}) {
  const current = boundOwnerDirectory(path, label);
  if (current.dev !== identity.dev || current.ino !== identity.ino || current.type !== identity.type
      || current.nonlink !== identity.nonlink || current.uid !== identity.uid || current.mode !== identity.mode) {
    throw new HarnessStateError(`${label} identity changed`);
  }
  if (empty && readdirSync(path).length !== 0) throw new HarnessStateError(`${label} must be fresh and empty`);
}

function inventory(root) {
  const files = {};
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const info = lstatSync(path);
      const key = relative(root, path).split(sep).join("/");
      if (info.isSymbolicLink()) files[key] = `link:${readlinkSync(path)}`;
      else if (info.isDirectory()) { files[`${key}/`] = "dir"; visit(path); }
      else files[key] = readRegularSnapshot(path, { label: "Observed member", maxBytes: 256 * 1024 * 1024 }).sha256;
    }
  };
  if (existsSync(root)) visit(root);
  return files;
}

function diffInventories(before, after) {
  const added = Object.keys(after).filter((key) => !(key in before)).sort();
  const removed = Object.keys(before).filter((key) => !(key in after)).sort();
  const changed = Object.keys(after).filter((key) => key in before && before[key] !== after[key]).sort();
  return { added, removed, changed, unchanged: added.length + removed.length + changed.length === 0 };
}

export function caseSensitive(dir) {
  const probe = mkdtempSync(join(dir, "case-probe-"));
  try {
    mkdirSync(join(probe, "Probe"));
    try { mkdirSync(join(probe, "probe")); } catch { return false; }
    return readdirSync(probe).length === 2;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

function copyProject(checkout, destination, name) {
  cpSync(join(checkout, CORE_FIXTURE), destination, { recursive: true, errorOnExist: true, force: false });
  const projectToml = join(destination, ".tfsb/project.toml");
  const original = readFileSync(projectToml, "utf8");
  if (!original.includes('name = "core-fixture"')) throw new HarnessStateError("maintained core fixture project name changed");
  writeFileSync(projectToml, original.replace('name = "core-fixture"', `name = "${name}"`));
}

// Derive-ready variant of the maintained core fixture (as tools/sidecar-transcript.mjs prepares it):
// tokens and recipes enabled, one recipe deriving a dark mark from the light source mark.
function deriveProject(checkout, destination, name) {
  copyProject(checkout, destination, name);
  rmSync(join(destination, ".tfsb/brand-package.toml"), { force: true });
  writeFileSync(join(destination, ".tfsb/brand.toml"), `schema = "tfsb.brand"\nschema_version = 1\nenabled_domains = { tokens = true, recipes = true, qa = false, consumer_profiles = false, package = false, exports = false }\n\n[[families]]\nid = "fixture-fam"\nname = "Fixture Family"\nrequired_roles = []\noptional_roles = ["mark"]\n\n[[variants]]\nfamily = "fixture-fam"\nid = "light"\nbackgrounds = ["light"]\ncolor_mode = "full-color"\nscale = "standard"\nstatus = "primary"\n\n[[variants]]\nfamily = "fixture-fam"\nid = "derived-dark"\nbackgrounds = ["dark"]\ncolor_mode = "reversed"\nscale = "standard"\nstatus = "primary"\n\n[[bindings]]\nfamily = "fixture-fam"\nrole = "mark"\nvariant = "light"\nasset = "fixture-mark-on-light"\nauthority = "source"\n\n[[bindings]]\nfamily = "fixture-fam"\nrole = "mark"\nvariant = "derived-dark"\nasset = "fixture-mark-derived-dark"\nauthority = "derived"\n`);
  writeFileSync(join(destination, ".tfsb/brand-tokens.toml"), `schema = "tfsb.brand-tokens"\nschema_version = 1\n\n[[colors]]\nid = "brand-blue"\nvalue = "#0066CCFF"\n`);
  writeFileSync(join(destination, ".tfsb/brand-recipes.toml"), `schema = "tfsb.brand-recipes"\nschema_version = 1\n\n[[recipes]]\nid = "recipe-derived-dark"\ntarget_asset = "fixture-mark-derived-dark"\nsource_asset = "fixture-mark-on-light"\n\n[[recipes.operations]]\noperation = "replace-paint"\nchannel = "fill"\nsource_color = "#000000FF"\nreplacement_token = "brand-blue"\nexpected_occurrences = 1\n\n[[recipes.operations]]\noperation = "copy-accessibility"\npolicy = "preserve"\n`);
}

function pathExistsWithoutFollowing(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "ENOENT") return false;
    throw error;
  }
}

function preparePairedV2Exchange(smokeDir) {
  const fixture = readRegularSnapshot(PAIRED_V2_BASELINE_FIXTURE, {
    label: "Paired-v2 maintained Developer baseline fixture",
    maxBytes: 8 * 1024,
  });
  if (fixture.bytes.byteLength !== PAIRED_V2_BASELINE_BYTES || fixture.sha256 !== PAIRED_V2_BASELINE_SHA256) {
    throw new HarnessStateError("paired-v2 maintained Developer baseline fixture identity changed");
  }
  const exchange = join(smokeDir, PAIRED_V2_EXCHANGE_DIR);
  if (pathExistsWithoutFollowing(exchange)) {
    throw new HarnessStateError("paired-v2 exchange must be absent before fixture preparation");
  }
  mkdirSync(exchange, { mode: 0o700 });
  chmodSync(exchange, 0o700);
  const baseline = join(exchange, PAIRED_V2_BASELINE_NAME);
  writeFileSync(baseline, fixture.bytes, { flag: "wx", mode: 0o600 });
  chmodSync(baseline, 0o600);
  assertOwnerRegularFile(baseline, "paired-v2 baseline source");
  for (const name of PAIRED_V2_DESTINATION_NAMES) {
    if (pathExistsWithoutFollowing(join(exchange, name))) {
      throw new HarnessStateError("paired-v2 destination must be absent before launch");
    }
  }
}

/** Prepares the scenario fixtures inside the smoke directory; returns the fixture roots to observe. */
export function prepareFixtures(scenario, checkout, smokeDir) {
  const fixtures = join(smokeDir, "fixtures");
  mkdirSync(fixtures, { mode: 0o700 });
  if (scenario === "paired-v2") {
    preparePairedV2Exchange(smokeDir);
    return { observed: {} };
  }
  if (SCENARIOS[scenario].caseSensitive && !caseSensitive(fixtures)) {
    throw new HarnessStateError(`scenario ${scenario} requires a case-sensitive filesystem`);
  }
  if (scenario === "A") {
    copyProject(checkout, join(fixtures, "core-minimal"), "core-fixture");
    return { observed: { "core-minimal": join(fixtures, "core-minimal") } };
  }
  if (scenario === "B") {
    const parent = join(fixtures, "Nebular Smoke Ünïcode");
    mkdirSync(parent);
    copyProject(checkout, join(parent, "Project Ω"), "nebular-smoke-upper");
    copyProject(checkout, join(parent, "project Ω"), "nebular-smoke-lower");
    // The case-distinct sibling carries its own family name (package domain off, as the derive fixture),
    // so each brand read proves which project the sidecar opened.
    const lowerBrand = join(parent, "project Ω", ".tfsb/brand.toml");
    const brand = readFileSync(lowerBrand, "utf8");
    if (!brand.includes('name = "Core Fixture Brand"') || !brand.includes("package = true")) throw new HarnessStateError("maintained core fixture brand changed");
    writeFileSync(lowerBrand, brand.replace('name = "Core Fixture Brand"', 'name = "Nebular Smoke Lower Brand"').replace("package = true", "package = false"));
    rmSync(join(parent, "project Ω", ".tfsb/brand-package.toml"), { force: true });
    return { observed: { upper: join(parent, "Project Ω"), lower: join(parent, "project Ω") } };
  }
  const parent = join(fixtures, "Derive Target");
  mkdirSync(parent);
  deriveProject(checkout, join(parent, "Case"), "nebular-derive-upper");
  deriveProject(checkout, join(parent, "case"), "nebular-derive-lower");
  return { observed: { upper: join(parent, "Case"), lower: join(parent, "case") } };
}

/** The real user's application state locations for this identifier (outside the scratch HOME). */
export function persistentStateLocations(platform, home = homedir()) {
  const names = [APPLICATION_IDENTIFIER, "Theme Forge Nebular Fusion", "theme-forge-nebular-fusion"];
  const bases = platform.startsWith("darwin")
    ? ["Library/Caches", "Library/Application Support", "Library/WebKit", "Library/Logs", "Library/HTTPStorages", "Library/Saved Application State", "Library/Preferences"]
    : [".cache", ".local/share", ".config", ".local/state"];
  return bases.flatMap((base) => names.flatMap((name) => [join(home, base, name), join(home, base, `${name}.plist`), join(home, base, `${name}.savedState`)]));
}

function snapshotLocations(locations) {
  return Object.fromEntries(locations.map((path) => [path, existsSync(path) ? inventory(lstatSync(path).isDirectory() ? path : dirname(path)) : null]));
}

// Processes whose executable lies inside the candidate: the GUI, its sidecar and runner children.
export function candidateProcesses(launchRoot) {
  const root = realpathSync(launchRoot);
  const found = [];
  if (process.platform === "linux") {
    for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
      try {
        const exe = readlinkSync(`/proc/${pid}/exe`);
        if (exe === root || exe.startsWith(root + sep)) found.push({ pid: Number(pid), exe });
      } catch { /* exited or not ours */ }
    }
  } else {
    const listing = spawnSync("ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8" });
    for (const line of listing.stdout.split("\n")) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (match && (match[2].startsWith(root + sep) || match[2].includes(` ${root}${sep}`))) found.push({ pid: Number(match[1]), exe: match[2] });
    }
  }
  return found.filter((entry) => entry.pid !== process.pid);
}

/** Resolves with the promise's value, or null once `ms` elapse; the timer is always cleared so it never holds the process open. */
export async function within(promise, ms) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((done) => { timer = setTimeout(() => done(null), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitUntil(check, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((done) => setTimeout(done, intervalMs));
  }
  return check();
}

function readReceipt(smokeDir) {
  const path = join(smokeDir, "receipt.json");
  const snapshot = readRegularSnapshot(path, { missingOk: true, label: "Smoke receipt", maxBytes: 4 * 1024 * 1024 });
  return snapshot ? { receipt: JSON.parse(snapshot.bytes.toString("utf8")), sha256: snapshot.sha256, mode: snapshot.mode & 0o777 } : null;
}

export function judgeReceipt(record, { scenario, platform, executableSha256, pid }) {
  const problems = [];
  if (!record) return ["no receipt was written"];
  const { receipt, mode } = record;
  if (mode !== 0o600) problems.push(`receipt mode ${mode.toString(8)}`);
  if (receipt.schema !== RECEIPT_SCHEMA) problems.push("receipt schema");
  if (receipt.scenario !== scenario) problems.push(`receipt scenario ${receipt.scenario}`);
  if (receipt.status !== "pass") problems.push(`receipt status ${receipt.status}: ${receipt.failure ?? ""}`);
  if (pid !== undefined && receipt.pid !== pid) problems.push(`receipt pid ${receipt.pid} is not the launched process ${pid}`);
  const triple = { "darwin-arm64": "aarch64-apple-darwin", "linux-arm64": "aarch64-unknown-linux-gnu", "linux-x64": "x86_64-unknown-linux-gnu" }[platform];
  if (receipt.target !== triple) problems.push(`receipt target ${receipt.target}`);
  if (receipt.executable?.sha256 !== executableSha256) problems.push("the running executable is not the candidate executable");
  const steps = receipt.driver?.steps ?? [];
  const byId = new Map(steps.filter((step) => step !== null && typeof step === "object").map((step) => [step.id, step]));
  if (scenario === "paired-v2" && JSON.stringify(steps.map((step) => step !== null && typeof step === "object" ? step.id : null)) !== JSON.stringify(SCENARIOS[scenario].steps)) {
    problems.push("paired-v2 steps are not the exact ordered sequence");
  }
  for (const id of SCENARIOS[scenario].steps) {
    if (!byId.get(id)?.ok) problems.push(`required step ${id} ${byId.has(id) ? "failed" : "missing"}: ${byId.get(id)?.detail ?? ""}`);
  }
  if (Boolean(receipt.awaitingSignal) !== Boolean(SCENARIOS[scenario].signal)) problems.push("receipt signal expectation");
  return problems;
}

/**
 * Internal finalization seam shared by `runSmoke` and deterministic unit tests.
 * @param {{ result: Record<string, any>, keep?: boolean, body: (run: { launched: () => void, exited: () => void, receipt: <T>(read: () => T, copy: (observed: NonNullable<T>) => void) => T }) => Promise<void> | void, cleanup: () => void, writeReport: (text: string) => void }} options
 */
export async function finalizeSmokeRun({ result, keep = false, body, cleanup, writeReport }) {
  const run = createFinalizationTracker();
  try {
    await body(run);
  } catch (error) {
    run.failed(error);
    result.problems.push(`harness error: ${formatLegacyError(error)}`);
  }
  if (!keep) {
    run.enter("cleanup");
    try {
      cleanup();
    } catch (error) {
      run.failed(error);
      result.problems.push(CLEANUP_PROBLEM);
    }
  }
  result.status = result.problems.length === 0 ? "pass" : "fail";
  run.enter("report-write");
  result.finalization = run.record();
  try {
    writeReport(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    run.failed(error);
    throw new SmokeReportWriteError(run.record(), classifyException(error));
  }
  return result;
}

export const SMOKE_INHERITED_ENV_KEYS = Object.freeze([
  "DISPLAY",
  "DBUS_SESSION_BUS_ADDRESS",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "WEBKIT_DISABLE_COMPOSITING_MODE",
  "WEBKIT_DISABLE_DMABUF_RENDERER",
  "LIBGL_ALWAYS_SOFTWARE",
  "GDK_BACKEND",
  "EGL_LOG_LEVEL",
  "LIBGL_DEBUG",
]);

export function buildSmokeEnvironment({ platform, home, temp, smokeDir, xdg, inheritedEnv = process.env }) {
  const env = {
    PATH: inheritedEnv.PATH ?? "/usr/bin:/bin",
    HOME: home,
    TMPDIR: temp,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    XDG_CONFIG_HOME: xdg.config,
    XDG_CACHE_HOME: xdg.cache,
    XDG_DATA_HOME: xdg.data,
    XDG_STATE_HOME: xdg.state,
    XDG_RUNTIME_DIR: xdg.runtime,
    TFNF_RELEASE_SMOKE_DIR: smokeDir,
    GSETTINGS_BACKEND: "memory",
  };
  for (const key of SMOKE_INHERITED_ENV_KEYS) {
    if (!platform.startsWith("linux") && (key === "EGL_LOG_LEVEL" || key === "LIBGL_DEBUG")) continue;
    if (inheritedEnv[key]) env[key] = inheritedEnv[key];
  }
  return env;
}

/**
 * Runs one scenario against one extracted candidate.
 * @param {{ platform: string, scenario: string, launchRoot: string, checkout: string, evidenceDir: string, source?: "raw-archive"|"npm-package", packageManifestSha256?: string, label?: string, timeoutMs?: number, keep?: boolean, layout?: { home: string, temp: string, smokeDir: string, xdg: { config: string, cache: string, data: string, state: string, runtime: string } }, extraEnv?: Record<string, string>, prepareFixtures?: boolean }} options
 */
export async function runSmoke(options) {
  const { platform, scenario } = options;
  if (scenario === "appearance-pair") throw new Error("appearance-pair is seal-only and cannot be launched");
  if (!SCENARIOS[scenario] || !SCENARIOS[scenario].platforms.includes(platform)) throw new Error(`scenario ${scenario} is not defined for ${platform}`);
  if (scenario.startsWith("P-") && options.layout === undefined) throw new Error(`${scenario} requires an allocated appearance-pair view layout`);
  if (scenario === "paired-v2" && options.source !== "raw-archive") throw new Error("paired-v2 requires the raw archive source");
  const launchRoot = realpathSync(resolve(options.launchRoot));
  const authenticatedPackage = options.source === "npm-package"
    ? authenticateNpmPackageContext(dirname(launchRoot), platform, options.packageManifestSha256)
    : null;
  const checkout = resolve(options.checkout);
  const evidenceDir = resolve(options.evidenceDir);
  mkdirSync(evidenceDir, { recursive: true });
  const label = options.label ?? `${platform}-${scenario}`;
  const executable = executablePath(launchRoot, platform);
  const measured = readRegularSnapshot(executable, { label: "Candidate executable", maxBytes: 1024 * 1024 * 1024 });
  if (!measured.executable) throw new Error("candidate executable is not executable");
  const launchTarget = launcherPath(launchRoot, platform);
  if (!platform.startsWith("darwin")) {
    const triple = { "linux-arm64": "aarch64-unknown-linux-gnu", "linux-x64": "x86_64-unknown-linux-gnu" }[platform] ?? null;
    const packageAliasProjection = authenticatedPackage?.manifest?.runtimeAliasProjection ?? null;
    const runtimeSelection = await selectPayloadNativeRuntime(launchRoot, triple, { aliasProjection: packageAliasProjection });
    const measuredLauncher = readRegularSnapshot(launchTarget, { label: "Candidate launcher", maxBytes: 16 * 1024 * 1024 });
    const expectedLauncher = Buffer.from(nativeLauncher({ os: "linux" }, { nativeRuntime: runtimeSelection.nativeRuntime }));
    if (!measuredLauncher.executable || !measuredLauncher.bytes.equals(expectedLauncher)) {
      throw new Error("candidate launcher is missing, not executable, or differs from the maintained launcher");
    }
  }

  const layout = options.layout ?? null;
  const scratch = layout ? null : realpathSync(mkdtempSync(join(tmpdir(), "nebular-rc-smoke-")));
  const home = layout?.home ?? ownerOnlyDir(join(scratch, "home"));
  const temp = layout?.temp ?? ownerOnlyDir(join(scratch, "tmp"));
  const smokeDir = layout?.smokeDir ?? ownerOnlyDir(join(temp, "nebular-release-smoke"));
  const xdg = layout?.xdg ?? Object.fromEntries(["config", "cache", "data", "state", "runtime"].map((name) => [name, ownerOnlyDir(join(scratch, "xdg", name))]));
  const result = { schema: RUN_SCHEMA, label, platform, scenario, source: options.source ?? null, executable: { path: relative(launchRoot, executable), sha256: measured.sha256, size: measured.size }, checks: {}, problems: [] };
  const started = Date.now();
  return finalizeSmokeRun({
    result,
    keep: Boolean(options.keep),
    body: async (run) => {
      const fixtures = options.prepareFixtures === false ? { observed: {} } : prepareFixtures(scenario, checkout, smokeDir);
      const fixturesBefore = Object.fromEntries(Object.entries(fixtures.observed).map(([name, path]) => [name, inventory(path)]));
      const locations = persistentStateLocations(platform);
      const persistentBefore = snapshotLocations(locations);
      const preexisting = candidateProcesses(launchRoot);
      if (preexisting.length) throw new HarnessStateError(`candidate processes already running: ${JSON.stringify(preexisting)}`);

      const env = { ...buildSmokeEnvironment({ platform, home, temp, smokeDir, xdg }), ...validatedSmokeExtraEnv(scenario, options.extraEnv) };
      const log = { stdout: [], stderr: [] };
      const child = spawn(launchTarget, [`--nebular-release-smoke=${scenario}`], { cwd: home, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      if (typeof child.pid === "number") run.launched();
      child.stdout.on("data", (chunk) => log.stdout.push(chunk));
      child.stderr.on("data", (chunk) => log.stderr.push(chunk));
      const exited = new Promise((done) => child.on("exit", (code, signal) => done({ code, signal })));
      let exit;
      let signalSent = null;
      const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      if (SCENARIOS[scenario].signal) {
        const awaiting = await waitUntil(() => readReceipt(smokeDir)?.receipt?.awaitingSignal === true || child.exitCode !== null, timeout, 250);
        const live = candidateProcesses(launchRoot);
        result.checks.processesBeforeSignal = live.map((entry) => ({ pid: entry.pid, exe: entry.exe }));
        result.checks.sidecarRunningBeforeSignal = live.some((entry) => entry.pid !== child.pid && entry.exe.includes("tfsb-studio-service"));
        if (awaiting && child.exitCode === null) {
          process.kill(child.pid, "SIGTERM"); // the application process only, never its group
          signalSent = { signal: "SIGTERM", at: Date.now() - started };
        }
        exit = await within(exited, 30_000);
      } else {
        exit = await within(exited, timeout);
      }
      if (!exit) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
        exit = await exited;
        result.problems.push("the application did not exit within its bound and was killed");
      }
      run.exited();
      result.exit = { ...exit, signalSent, durationMs: Date.now() - started };
      writeFileSync(join(evidenceDir, `${label}.stdout.log`), Buffer.concat(log.stdout));
      writeFileSync(join(evidenceDir, `${label}.stderr.log`), Buffer.concat(log.stderr));

      const orphans = await waitUntil(() => { const live = candidateProcesses(launchRoot); return live.length === 0 ? [] : null; }, 15_000, 250) ?? candidateProcesses(launchRoot);
      result.checks.orphans = orphans.map((entry) => ({ pid: entry.pid, exe: entry.exe }));
      if (orphans.length) {
        result.problems.push(`orphan candidate processes remained: ${orphans.map((entry) => entry.pid).join(", ")}`);
        for (const entry of orphans) { try { process.kill(entry.pid, "SIGKILL"); } catch { /* gone */ } }
      }
      if (SCENARIOS[scenario].signal) {
        if (!signalSent) result.problems.push("the signal scenario never reached its signal point");
        if (!result.checks.sidecarRunningBeforeSignal) result.problems.push("no sidecar was running when the application was terminated");
        if (exit.signal !== "SIGTERM") result.problems.push(`application ended by ${exit.signal ?? `exit ${exit.code}`} instead of SIGTERM`);
      } else if (exit.code !== 0) {
        result.problems.push(`application exit code ${exit.code} signal ${exit.signal}`);
      }

      const record = run.receipt(
        () => readReceipt(smokeDir),
        (observed) => writeFileSync(join(evidenceDir, `${label}.receipt.json`), `${JSON.stringify(observed.receipt, null, 2)}\n`),
      );
      result.receipt = record ? { sha256: record.sha256, status: record.receipt.status, steps: (record.receipt.driver?.steps ?? []).map((step) => step !== null && typeof step === "object" ? ({ id: step.id, ok: step.ok, via: step.via, ms: step.ms }) : ({ id: null, ok: false, via: null, ms: null })) } : null;
      if (scenario === "paired-v2") {
        const matrixProblems = validateAppearanceMatrixFacts(record?.receipt, checkout);
        const editorPreservedProblems = validateAppearanceMatrixEditorPreservedFact(record?.receipt);
        result.appearanceMatrix = { status: matrixProblems.length === 0 ? "pass" : "fail", cells: matrixProblems.length === 0 ? 12 : null };
        result.appearanceMatrixEditorPreserved = editorPreservedProblems.length === 0;
        result.problems.push(...matrixProblems, ...editorPreservedProblems);
      }
      result.problems.push(...judgeReceipt(record, { scenario, platform, executableSha256: measured.sha256, pid: child.pid }));

      const fixturesAfter = Object.fromEntries(Object.entries(fixtures.observed).map(([name, path]) => [name, inventory(path)]));
      result.checks.fixtureEffects = Object.fromEntries(Object.keys(fixturesBefore).map((name) => [name, diffInventories(fixturesBefore[name], fixturesAfter[name])]));
      if (scenario.startsWith("C")) {
        const upper = result.checks.fixtureEffects.upper;
        if (upper.unchanged || !upper.added.some((path) => path.includes("fixture-mark-derived-dark"))) result.problems.push("the derived asset was not written to the case-exact project");
        if (!result.checks.fixtureEffects.lower.unchanged) result.problems.push("the case-distinct sibling project was modified");
      } else {
        for (const [name, effect] of Object.entries(result.checks.fixtureEffects)) if (!effect.unchanged) result.problems.push(`read-only fixture ${name} was modified`);
      }

      const persistentAfter = snapshotLocations(locations);
      const persistentChanges = locations.filter((path) => JSON.stringify(persistentBefore[path]) !== JSON.stringify(persistentAfter[path]));
      result.checks.persistentUserState = { locations: locations.length, changed: persistentChanges };
      if (persistentChanges.length) result.problems.push(`persistent user state changed: ${persistentChanges.join(", ")}`);
      result.checks.scratchHomeWrites = Object.keys(inventory(home)).length;

      const after = readRegularSnapshot(executable, { label: "Candidate executable", maxBytes: 1024 * 1024 * 1024 });
      if (after.sha256 !== measured.sha256) result.problems.push("the candidate executable changed during the smoke run");
    },
    cleanup: () => { if (scratch) rmSync(scratch, { recursive: true, force: true }); },
    writeReport: (text) => writeFileSync(join(evidenceDir, `${label}.run.json`), text),
  });
}

const APPEARANCE_PAIR_MARKER = ".nebular-appearance-pair-v1";
const APPEARANCE_PAIR_MARKER_SCHEMA = "nebular.appearance-pair-v1";
const APPEARANCE_PREFERENCE_ENV = "TFNF_RELEASE_SMOKE_PREFERENCES_DIR";
const APPEARANCE_LAYOUT_PHASES = Object.freeze(["before-save", "after-save", "after-restart"]);
const APPEARANCE_LAYOUT_CHECKPOINTS = Object.freeze([
  "run-root", "lane-root", "source-root", "pair-root", "marker", "shared-root", "preferences-root",
  "view-a:root", "view-a:home", "view-a:temp-root", "view-a:runtime-roots", "view-a:smoke-root", "view-a:receipt", "view-a:xdg-root",
  "view-b:root", "view-b:home", "view-b:temp-root", "view-b:runtime-roots", "view-b:smoke-root", "view-b:receipt", "view-b:xdg-root",
  "preference-inventory", "preference-record",
]);
const APPEARANCE_LAYOUT_FAILURES = new WeakMap();

function captureAppearanceLayoutFailure(phase, checkpoint, operation) {
  try {
    return operation();
  } catch (error) {
    if (error !== null && (typeof error === "object" || typeof error === "function")
        && APPEARANCE_LAYOUT_PHASES.includes(phase)
        && APPEARANCE_LAYOUT_CHECKPOINTS.includes(checkpoint)) {
      APPEARANCE_LAYOUT_FAILURES.set(error, Object.freeze({ phase, checkpoint }));
    }
    throw error;
  }
}

export function getAppearanceLayoutDiagnostic(error) {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) return null;
  return APPEARANCE_LAYOUT_FAILURES.get(error) ?? null;
}

function validatedSmokeExtraEnv(scenario, extraEnv) {
  if (extraEnv === undefined) return {};
  if (extraEnv === null || typeof extraEnv !== "object" || Array.isArray(extraEnv)) {
    throw new HarnessStateError("smoke extra environment is malformed");
  }
  const keys = Object.keys(extraEnv);
  if (scenario !== "P-save" && scenario !== "P-restart") {
    throw new HarnessStateError("smoke extra environment is only available to appearance pair phases");
  }
  if (keys.some((key) => key !== APPEARANCE_PREFERENCE_ENV) || typeof extraEnv[APPEARANCE_PREFERENCE_ENV] !== "string") {
    throw new HarnessStateError("smoke extra environment contains an unsupported key");
  }
  return { [APPEARANCE_PREFERENCE_ENV]: extraEnv[APPEARANCE_PREFERENCE_ENV] };
}

function assertOwnerDirectory(path, label) {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o7777) !== 0o700) {
    throw new HarnessStateError(`${label} is not a real owner-only directory`);
  }
}

function assertOwnerRegularFile(path, label, mode = 0o600) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o7777) !== mode) {
    throw new HarnessStateError(`${label} is not the required regular owner-only file`);
  }
}

function sortedNames(path) {
  return readdirSync(path).sort();
}

function exactNames(path, expected, label) {
  const actual = sortedNames(path);
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new HarnessStateError(`${label} inventory mismatch`);
  }
}

function createAppearancePairView(pairRoot, name) {
  const viewRoot = ownerOnlyDir(join(pairRoot, name));
  const home = ownerOnlyDir(join(viewRoot, "home"));
  const temp = ownerOnlyDir(join(viewRoot, "tmp"));
  const smokeDir = ownerOnlyDir(join(temp, "nebular-release-smoke"));
  const runtime = {
    webviewData: ownerOnlyDir(join(smokeDir, "webview-data")),
    sidecarTemp: ownerOnlyDir(join(smokeDir, "sidecar-temp")),
  };
  const runtimeIdentity = {
    webviewData: boundOwnerDirectory(runtime.webviewData, `${name} webview-data`),
    sidecarTemp: boundOwnerDirectory(runtime.sidecarTemp, `${name} sidecar-temp`),
  };
  const xdg = Object.fromEntries(["config", "cache", "data", "state", "runtime"].map((part) => [part, ownerOnlyDir(join(viewRoot, "xdg", part))]));
  const view = { viewRoot, home, temp, smokeDir, runtime, xdg };
  Object.defineProperty(view, "runtimeIdentity", { value: runtimeIdentity, enumerable: false });
  return view;
}

export function createAppearancePairLayout(platform = "test-lane") {
  const runRoot = realpathSync(mkdtempSync(join(tmpdir(), "nebular-appearance-pair-run-")));
  try {
    const lane = platform === "darwin-arm64" ? "macos-arm64" : platform;
    const laneRoot = ownerOnlyDir(join(runRoot, lane));
    const sourceRoot = ownerOnlyDir(join(laneRoot, "appearance-pair", "raw-only"));
    const pairRoot = realpathSync(mkdtempSync(join(sourceRoot, "appearance-pair-v1-")));
    const pairId = basename(pairRoot);
    if (!/^appearance-pair-v1-[A-Za-z0-9._-]{1,96}$/u.test(pairId)) throw new HarnessStateError("appearance pair marker id is invalid");
    const marker = join(pairRoot, APPEARANCE_PAIR_MARKER);
    const markerBytes = Buffer.from(`${APPEARANCE_PAIR_MARKER_SCHEMA}\n${pairId}\n`);
    if (markerBytes.byteLength > APPEARANCE_PAIR_LIMITS.markerBytes) throw new HarnessStateError("appearance pair marker exceeds its bound");
    writeFileSync(marker, markerBytes, { flag: "wx", mode: 0o600 });
    chmodSync(marker, 0o600);
    const sharedRoot = ownerOnlyDir(join(pairRoot, "shared-prefs"));
    const preferencesRoot = ownerOnlyDir(join(sharedRoot, "appearance-preferences"));
    const viewA = createAppearancePairView(pairRoot, "view-a");
    const viewB = createAppearancePairView(pairRoot, "view-b");
    return { runRoot, laneRoot, sourceRoot, pairRoot, pairId, marker, sharedRoot, preferencesRoot, viewA, viewB };
  } catch (error) {
    try { rmSync(runRoot, { recursive: true, force: true }); } catch { /* retain the original allocation error */ }
    throw error;
  }
}

export function assertAppearancePairLayout(layout, phase) {
  const at = (checkpoint, operation) => captureAppearanceLayoutFailure(phase, checkpoint, operation);
  at("run-root", () => assertOwnerDirectory(layout.runRoot, "appearance pair run root"));
  at("lane-root", () => assertOwnerDirectory(layout.laneRoot, "appearance pair lane root"));
  at("source-root", () => assertOwnerDirectory(layout.sourceRoot, "appearance pair source-form root"));
  at("pair-root", () => assertOwnerDirectory(layout.pairRoot, "appearance pair root"));
  at("marker", () => assertOwnerRegularFile(layout.marker, "appearance pair marker"));
  const marker = at("marker", () => readRegularSnapshot(layout.marker, { label: "Appearance pair marker", maxBytes: APPEARANCE_PAIR_LIMITS.markerBytes }).bytes.toString("utf8"));
  at("marker", () => {
    if (marker !== `${APPEARANCE_PAIR_MARKER_SCHEMA}\n${layout.pairId}\n`) throw new HarnessStateError("appearance pair marker content mismatch");
  });
  at("pair-root", () => exactNames(layout.pairRoot, [APPEARANCE_PAIR_MARKER, "shared-prefs", "view-a", "view-b"], "appearance pair root"));
  at("shared-root", () => assertOwnerDirectory(layout.sharedRoot, "appearance pair shared preferences root"));
  at("preferences-root", () => assertOwnerDirectory(layout.preferencesRoot, "appearance preferences root"));
  at("shared-root", () => exactNames(layout.sharedRoot, ["appearance-preferences"], "shared preferences root"));
  for (const [name, view] of [["view-a", layout.viewA], ["view-b", layout.viewB]]) {
    const prefix = name === "view-a" ? "view-a" : "view-b";
    at(`${prefix}:root`, () => assertOwnerDirectory(view.viewRoot, name));
    at(`${prefix}:home`, () => assertOwnerDirectory(view.home, `${name} HOME`));
    at(`${prefix}:temp-root`, () => assertOwnerDirectory(view.temp, `${name} TMPDIR`));
    at(`${prefix}:smoke-root`, () => assertOwnerDirectory(view.smokeDir, `${name} smoke root`));
    at(`${prefix}:xdg-root`, () => {
      for (const [xdgName, xdgPath] of Object.entries(view.xdg)) assertOwnerDirectory(xdgPath, `${name} XDG ${xdgName}`);
    });
    at(`${prefix}:root`, () => exactNames(view.viewRoot, ["home", "tmp", "xdg"], `${name} root`));
    at(`${prefix}:temp-root`, () => exactNames(view.temp, ["nebular-release-smoke"], `${name} temp root`));
    at(`${prefix}:runtime-roots`, () => {
      assertBoundOwnerDirectory(view.runtime.webviewData, view.runtimeIdentity.webviewData, `${name} webview-data`, {
        empty: phase === "before-save" || (phase === "after-save" && name === "view-b"),
      });
      assertBoundOwnerDirectory(view.runtime.sidecarTemp, view.runtimeIdentity.sidecarTemp, `${name} sidecar-temp`, {
        empty: phase === "before-save" || (phase === "after-save" && name === "view-b"),
      });
    });
    const runtimeNames = ["sidecar-temp", "webview-data"];
    const expectedSmokeNames = phase === "before-save"
      ? runtimeNames
      : phase === "after-save"
        ? (name === "view-a" ? ["receipt.json", ...runtimeNames] : runtimeNames)
        : ["receipt.json", ...runtimeNames];
    at(`${prefix}:smoke-root`, () => exactNames(view.smokeDir, expectedSmokeNames, `${name} smoke root`));
    if (expectedSmokeNames.includes("receipt.json")) at(`${prefix}:receipt`, () => assertOwnerRegularFile(join(view.smokeDir, "receipt.json"), `${name} smoke receipt`));
    at(`${prefix}:xdg-root`, () => exactNames(join(view.viewRoot, "xdg"), Object.keys(view.xdg), `${name} XDG root`));
  }
  at("preference-inventory", () => {
    const names = sortedNames(layout.preferencesRoot);
    if (phase === "before-save" && names.length !== 0) throw new HarnessStateError("appearance preference leaf was not empty before P-save");
    if (phase !== "before-save" && JSON.stringify(names) !== JSON.stringify(["appearance.json"])) throw new HarnessStateError("appearance preference leaf inventory mismatch");
  });
}

export function assertAppearancePreferenceRecord(layout, expectedBytes = APPEARANCE_PREFERENCE_BYTES, phase = null) {
  const at = (checkpoint, operation) => captureAppearanceLayoutFailure(phase, checkpoint, operation);
  const path = join(layout.preferencesRoot, "appearance.json");
  at("preference-record", () => assertOwnerRegularFile(path, "appearance preference record"));
  const bytes = at("preference-record", () => readRegularSnapshot(path, { label: "Appearance preference record", maxBytes: APPEARANCE_PAIR_LIMITS.preferenceBytes }).bytes);
  at("preference-record", () => {
    if (bytes.byteLength > APPEARANCE_PAIR_LIMITS.preferenceBytes) throw new HarnessStateError("appearance preference record exceeds its bound");
    if (!bytes.equals(expectedBytes)) throw new HarnessStateError("appearance preference record bytes mismatch");
    if (sha256(bytes) !== APPEARANCE_PREFERENCE_SHA256) throw new HarnessStateError("appearance preference record digest mismatch");
    const decoded = JSON.parse(bytes.toString("utf8"));
    if (JSON.stringify(decoded) !== JSON.stringify(APPEARANCE_PREFERENCE_RECORD)) throw new HarnessStateError("appearance preference record fields mismatch");
  });
  at("preference-inventory", () => {
    if (sortedNames(layout.preferencesRoot).some((name) => name.startsWith(".nebular-appearance-tmp-"))) {
      throw new HarnessStateError("appearance preference temporary file remains");
    }
  });
}

function readOrdinarySmokeRuns(evidenceDir, platform) {
  const runs = [];
  for (const name of sortedNames(evidenceDir).filter((entry) => entry.endsWith(".run.json"))) {
    try {
      const value = JSON.parse(readRegularSnapshot(join(evidenceDir, name), { label: `Ordinary smoke run ${name}`, maxBytes: 16 * 1024 * 1024 }).bytes.toString("utf8"));
      if (value.platform === platform && PLATFORM_SCENARIOS[platform]?.includes(value.scenario)) runs.push(value);
    } catch {
      // An unrelated diagnostic file cannot become package identity evidence.
    }
  }
  return runs;
}

export function requireRawNpmParity(evidenceDir, platform, executableSha256) {
  const runs = readOrdinarySmokeRuns(evidenceDir, platform);
  const raw = runs.filter((run) => run.source === "raw-archive" && run.status === "pass");
  const npm = runs.filter((run) => run.source === "npm-package" && run.status === "pass");
  const rawDigests = new Set(raw.map((run) => run.executable?.sha256).filter((value) => typeof value === "string"));
  const npmDigests = new Set(npm.map((run) => run.executable?.sha256).filter((value) => typeof value === "string"));
  if (rawDigests.size !== 1 || npmDigests.size !== 1) throw new HarnessStateError("ordinary raw/npm smoke identity is incomplete");
  const rawDigest = [...rawDigests][0];
  const npmDigest = [...npmDigests][0];
  if (rawDigest !== executableSha256 || npmDigest !== executableSha256 || rawDigest !== npmDigest) {
    throw new HarnessStateError("appearance pair executable identity does not match ordinary raw/npm smoke");
  }
  return { rawExecutableSha256: rawDigest, npmExecutableSha256: npmDigest };
}

function normalizeAppearancePairResult(result) {
  if (result.problems.some((problem) => !APPEARANCE_FAILURE_CATEGORIES.includes(problem))) {
    result.problems = ["appearance-pair-harness-error"];
  }
  result.status = result.problems.length === 0 ? "pass" : "fail";
  if (result.appearancePair) result.appearancePair.status = result.status;
  return result;
}

/**
 * Finalizes pair evidence only after owned-root cleanup, so a cleanup failure
 * cannot leave a sealed pass record while returning a failed result.
 * The callbacks keep this seam deterministic for source-level failure tests.
 */
export function finalizeAppearancePairEvidence({ result, keep = false, cleanup, writeEvidence }) {
  if (!keep) {
    try {
      cleanup();
    } catch {
      result.problems.push("appearance-pair-harness-error");
    }
  }
  normalizeAppearancePairResult(result);
  try {
    writeEvidence();
  } catch {
    result.problems.push("appearance-pair-harness-error");
    normalizeAppearancePairResult(result);
  }
  return result;
}

function phaseSummary(result, phase) {
  return {
    status: result.status,
    problems: result.status === "pass" ? [] : [phase === "save" ? (result.receipt ? "appearance-save-failed" : "appearance-saved-status-timeout") : "restart-not-persisted"],
    receipt: result.receipt ? { sha256: result.receipt.sha256, status: result.receipt.status, steps: result.receipt.steps } : null,
  };
}

/**
 * Runs one fixed P-save/P-restart preference pair against the raw candidate.
 * The pair is deliberately separate from ordinary PLATFORM_SCENARIOS and from
 * the paired-v2 UI scenario. It is a proposal harness seam: no native result
 * is implied until the source-side P phases exist and a parent gate runs it.
 */
export async function runAppearancePair(options) {
  const { platform } = options;
  if (options.scenario !== undefined) throw new Error("appearance pair takes no scenario argument");
  if (!SCENARIOS["P-save"].platforms.includes(platform) || !SCENARIOS["P-restart"].platforms.includes(platform)) {
    throw new Error(`appearance pair is not defined for ${platform}`);
  }
  if (options.source !== "raw-archive") throw new Error("appearance pair requires the raw archive source");
  const launchRoot = realpathSync(resolve(options.launchRoot));
  const evidenceDir = resolve(options.evidenceDir);
  mkdirSync(evidenceDir, { recursive: true });
  const label = options.label ?? `${platform}-appearance-pair-raw`;
  const executable = executablePath(launchRoot, platform);
  const measured = readRegularSnapshot(executable, { label: "Candidate executable", maxBytes: 1024 * 1024 * 1024 });
  if (!measured.executable) throw new Error("candidate executable is not executable");
  const parity = requireRawNpmParity(evidenceDir, platform, measured.sha256);
  const layout = createAppearancePairLayout(platform);
  const result = {
    schema: RUN_SCHEMA,
    label,
    platform,
    scenario: "appearance-pair",
    source: "raw-archive",
    executable: { path: relative(launchRoot, executable), sha256: measured.sha256, size: measured.size },
    pairIdentity: { schema: APPEARANCE_PAIR_MARKER_SCHEMA, id: layout.pairId, rawExecutableSha256: parity.rawExecutableSha256, npmExecutableSha256: parity.npmExecutableSha256 },
    expectedPreference: { sha256: APPEARANCE_PREFERENCE_SHA256, bytes: APPEARANCE_PREFERENCE_BYTES.byteLength, ...APPEARANCE_PREFERENCE_RECORD },
    phases: {},
    phaseEvidence: `${label}.phases`,
    problems: [],
  };
  let phaseEvidence;
  try {
    phaseEvidence = ownerOnlyDir(join(evidenceDir, `${label}.phases`));
    assertAppearancePairLayout(layout, "before-save");
    const sharedEnv = { [APPEARANCE_PREFERENCE_ENV]: layout.sharedRoot };
    const phaseA = await runSmoke({
      ...options,
      scenario: "P-save",
      timeoutMs: options.timeoutMs ?? APPEARANCE_PAIR_LIMITS.phaseTimeoutMs,
      evidenceDir: phaseEvidence,
      label: `${platform}-P-save-raw`,
      keep: true,
      layout: layout.viewA,
      extraEnv: sharedEnv,
      prepareFixtures: false,
    });
    result.phases.save = phaseSummary(phaseA, "save");
    if (phaseA.status !== "pass") {
      result.problems.push(phaseA.receipt ? "appearance-save-failed" : "appearance-saved-status-timeout");
    } else {
      assertAppearancePairLayout(layout, "after-save");
      assertAppearancePreferenceRecord(layout, undefined, "after-save");
    }
    if (result.problems.length === 0) {
      const beforeRestart = readRegularSnapshot(join(layout.preferencesRoot, "appearance.json"), {
        label: "Observed appearance preference record",
        maxBytes: APPEARANCE_PAIR_LIMITS.preferenceBytes,
      }).bytes;
      const phaseB = await runSmoke({
        ...options,
        scenario: "P-restart",
        timeoutMs: options.timeoutMs ?? APPEARANCE_PAIR_LIMITS.phaseTimeoutMs,
        evidenceDir: phaseEvidence,
        label: `${platform}-P-restart-raw`,
        keep: true,
        layout: layout.viewB,
        extraEnv: sharedEnv,
        prepareFixtures: false,
      });
      result.phases.restart = phaseSummary(phaseB, "restart");
      if (phaseB.status !== "pass") {
        result.problems.push("restart-not-persisted");
      } else {
        assertAppearancePairLayout(layout, "after-restart");
        result.observedPreference = { sha256: sha256(beforeRestart), bytes: beforeRestart.byteLength };
        assertAppearancePreferenceRecord(layout, beforeRestart, "after-restart");
      }
    }
    result.appearancePair = {
      status: result.problems.length === 0 ? "pass" : "fail",
      phases: ["P-save", "P-restart"],
      sharedPreferenceRecord: "exact-dark-developer-v1",
      evidence: "sealed-with-lane-evidence",
    };
    result.status = result.problems.length === 0 ? "pass" : "fail";
  } catch (error) {
    const layoutDiagnostic = getAppearanceLayoutDiagnostic(error);
    if (layoutDiagnostic !== null) result.layoutDiagnostic = layoutDiagnostic;
    result.problems.push(error instanceof HarnessStateError ? "pair-layout-mismatch" : "appearance-pair-harness-error");
    result.appearancePair = { status: "fail", phases: ["P-save", "P-restart"], sharedPreferenceRecord: "not-proven", evidence: "sealed-with-lane-evidence" };
    result.status = "fail";
  }
  const writePairEvidence = () => {
    writeFileSync(join(evidenceDir, `${label}-view-a.receipt.json`), `${JSON.stringify(result.phases.save?.receipt ?? null, null, 2)}\n`, { flag: "wx" });
    writeFileSync(join(evidenceDir, `${label}-view-b.receipt.json`), `${JSON.stringify(result.phases.restart?.receipt ?? null, null, 2)}\n`, { flag: "wx" });
    writeFileSync(join(evidenceDir, `${label}.pair.run.json`), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  };
  return finalizeAppearancePairEvidence({
    result,
    keep: Boolean(options.keep),
    cleanup: () => rmSync(layout.runRoot, { recursive: true, force: true }),
    writeEvidence: writePairEvidence,
  });
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--appearance-pair") { options.appearancePair = true; continue; }
    if (flag === "--keep") { options.keep = true; continue; }
    const key = { "--platform": "platform", "--scenario": "scenario", "--launch-root": "launchRoot", "--checkout": "checkout", "--evidence": "evidenceDir", "--label": "label", "--timeout-ms": "timeoutMs", "--source": "source", "--package-manifest-sha256": "packageManifestSha256" }[flag];
    if (!key || value === undefined) throw new Error(`Usage: native-rc-smoke.mjs --platform <p> --scenario <s> --launch-root <dir> --checkout <dir> --evidence <dir> [--appearance-pair] [--label l] [--timeout-ms n] [--source raw-archive|npm-package] [--package-manifest-sha256 sha256] [--keep]`);
    options[key] = key === "timeoutMs" ? Number(value) : value;
    index += 1;
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = options.appearancePair ? await runAppearancePair(options) : await runSmoke(options);
    process.stdout.write(`${JSON.stringify({ label: result.label, status: result.status, problems: result.problems })}\n`);
    if (result.status !== "pass") process.exitCode = 1;
  } catch (error) {
    if (error instanceof SmokeReportWriteError) {
      process.stderr.write(`${JSON.stringify({ finalization: error.finalization, reportWriteFamily: error.reportWriteFamily })}\n`);
    } else {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exitCode = 1;
  }
}

