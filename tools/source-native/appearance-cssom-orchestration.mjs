import {
  APPEARANCE_FACTS,
  APPEARANCE_PLATFORM,
  APPEARANCE_SCENARIO,
  validateAppearanceSmokeRun,
} from "./appearance-orchestration.mjs";

export const APPEARANCE_CSSOM_RESULT_SCHEMA = "nebular.source-native-appearance-cssom-smoke-v1";
export const APPEARANCE_CSSOM_PROFILE = "cssom-presence-v1";
export const APPEARANCE_CSSOM_CHECKPOINTS = Object.freeze([
  "appearance-pair",
  "appearance-dark-mode",
  "appearance-custom-pair",
  "appearance-reset",
]);

const CSSOM_FACT_COUNT = 21;
const CSSOM_ACTIVE_VALUES = new Set(["1", "2", "3", "4"]);
const CSSOM_FACT_KEYS = Object.freeze([
  "appearanceCssomSlots",
  "appearanceCssomActive",
  "appearanceCssomPair",
  "appearanceCssomComputedPresence",
]);
const CSSOM_SLOT_COUNT = "4";
const CSSOM_TRUE = "true";
const PROFILE_SOURCES = Object.freeze(["raw-archive", "npm-package"]);
const SHA256 = /^[a-f0-9]{64}$/u;

export class AppearanceCssomOrchestrationError extends Error {
  constructor(code) {
    super(`APPEARANCE_CSSOM_ORCHESTRATION_${code}`);
    this.name = "AppearanceCssomOrchestrationError";
    this.code = code;
  }
}

function fail(code) {
  throw new AppearanceCssomOrchestrationError(code);
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

function exactIndexedArray(value, length) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== length) {
    return false;
  }
  const names = new Set(Object.getOwnPropertyNames(value));
  if (names.size !== length + 1 || !names.has("length")) return false;
  for (let index = 0; index < length; index += 1) {
    if (!names.has(String(index))) return false;
  }
  return Object.getOwnPropertySymbols(value).length === 0;
}

function exactTuple(value, expectedKey, expectedValue) {
  return exactIndexedArray(value, 2)
    && value[0] === expectedKey
    && value[1] === expectedValue;
}

function safeSha(value) {
  return typeof value === "string" && SHA256.test(value);
}

function validateCssomFacts(facts) {
  if (!exactIndexedArray(facts, CSSOM_FACT_COUNT)) fail("CSSOM_FACTS");
  const observations = [];
  const legacyFacts = [];
  for (const [checkpointIndex, checkpoint] of APPEARANCE_CSSOM_CHECKPOINTS.entries()) {
    const offset = checkpointIndex * 5;
    if (!exactTuple(facts[offset], CSSOM_FACT_KEYS[0], CSSOM_SLOT_COUNT)) fail("CSSOM_FACTS");
    const active = facts[offset + 1];
    if (!exactIndexedArray(active, 2)
        || active[0] !== CSSOM_FACT_KEYS[1]
        || !CSSOM_ACTIVE_VALUES.has(active[1])) fail("CSSOM_FACTS");
    if (!exactTuple(facts[offset + 2], CSSOM_FACT_KEYS[2], CSSOM_TRUE)
        || !exactTuple(facts[offset + 3], CSSOM_FACT_KEYS[3], CSSOM_TRUE)
        || !exactTuple(facts[offset + 4], APPEARANCE_FACTS[checkpointIndex][0], APPEARANCE_FACTS[checkpointIndex][1])) {
      fail("CSSOM_FACTS");
    }
    legacyFacts.push(Object.freeze([facts[offset + 4][0], facts[offset + 4][1]]));
    observations.push(Object.freeze({
      checkpoint,
      slotCount: 4,
      activeCount: Number(active[1]),
      pairConsistent: true,
      computedStylePresence: true,
    }));
  }
  const visualIndex = APPEARANCE_CSSOM_CHECKPOINTS.length * 5;
  if (!exactTuple(facts[visualIndex], APPEARANCE_FACTS[4][0], APPEARANCE_FACTS[4][1])) {
    fail("CSSOM_FACTS");
  }
  legacyFacts.push(Object.freeze([facts[visualIndex][0], facts[visualIndex][1]]));
  return Object.freeze({
    observations: Object.freeze(observations),
    legacyFacts: Object.freeze(legacyFacts),
  });
}

function validateNewDriverShape(receipt) {
  if (!isRecord(receipt) || !isRecord(receipt.receipt) || !isRecord(receipt.receipt.driver)
      || !exactKeys(receipt.receipt.driver, ["facts", "scenario", "status", "steps"])) {
    fail("CSSOM_RECEIPT");
  }
  if (receipt.receipt.driver.status !== "pass"
      || receipt.receipt.driver.scenario !== APPEARANCE_SCENARIO) fail("CSSOM_RECEIPT");
  return validateCssomFacts(receipt.receipt.driver.facts);
}

function deriveLegacyView(entry, legacyFacts) {
  const legacyReceipt = {
    ...entry.receipt,
    receipt: {
      ...entry.receipt.receipt,
      driver: {
        ...entry.receipt.receipt.driver,
        facts: legacyFacts,
      },
    },
  };
  const legacy = validateAppearanceSmokeRun({
    run: entry.run,
    receipt: legacyReceipt,
    executableSha256: entry.executableSha256,
    source: entry.source,
    launchExecutablePath: entry.launchExecutablePath,
  });
  return Object.freeze({
    source: legacy.source,
    receiptSha256: legacy.receiptSha256,
    stepsPassed: legacy.stepsPassed,
    preferenceCustody: legacy.preferenceCustody,
    persistentUserState: legacy.persistentUserState,
    visualAppearanceQualified: false,
  });
}

function validateSource(entry) {
  if (!isRecord(entry) || !PROFILE_SOURCES.includes(entry.source)
      || !safeSha(entry.executableSha256)) fail("CSSOM_ENTRY");
  if (!isRecord(entry.run) || !isRecord(entry.receipt)) fail("CSSOM_ENTRY");
}

/** Validate one raw/npm CSSOM-presence run while reusing the unchanged legacy gates. */
export function validateAppearanceCssomSmokeRun(entry) {
  validateSource(entry);
  const { observations, legacyFacts } = validateNewDriverShape(entry.receipt);
  const legacy = deriveLegacyView(entry, legacyFacts);
  return Object.freeze({
    source: legacy.source,
    receiptSha256: legacy.receiptSha256,
    legacyView: legacy,
    observations,
  });
}

/** Validate exactly the raw and npm CSSOM-presence pair. */
export function validateAppearanceCssomSmokeRuns(entries, executableSha256) {
  if (!exactIndexedArray(entries, PROFILE_SOURCES.length) || !safeSha(executableSha256)) fail("CSSOM_RUNS");
  const normalized = entries.map((entry) => ({ ...entry, executableSha256 }));
  const runs = normalized.map(validateAppearanceCssomSmokeRun);
  const sources = runs.map(({ source }) => source);
  if (new Set(sources).size !== PROFILE_SOURCES.length
      || PROFILE_SOURCES.some((source) => !sources.includes(source))) fail("CSSOM_RUNS");
  return Object.freeze({
    schema: APPEARANCE_CSSOM_RESULT_SCHEMA,
    profile: APPEARANCE_CSSOM_PROFILE,
    status: "passed-process-observation",
    platform: APPEARANCE_PLATFORM,
    scenario: APPEARANCE_SCENARIO,
    visualAppearanceQualified: false,
    runs: Object.freeze(runs),
  });
}

