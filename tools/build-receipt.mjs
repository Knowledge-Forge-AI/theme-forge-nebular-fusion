import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonical, digest, identity, inventoryTree, seal, validateBuildReceipt, candidateProvenance } from "./candidate-provenance.mjs";
import { validateBuildInputs } from "./build-inputs.mjs";
import { inventoryNativePayload } from "./native-runtime.mjs";
import {
  EXPECTED_PREVIEW_NORMALIZED_OUTPUT,
  EXPECTED_PREVIEW_ORIGIN,
  EXPECTED_PREVIEW_OUTPUT_DIRS,
  PREPARED_PREVIEW_LIMITS,
  createPreviewHashBudget,
  inspectBoundedPreviewTree,
  inspectPreparedPreviewAppProjection,
} from "./prepare-app-resources.mjs";
import { payloadLayout } from "./platform-targets.mjs";
import { defaultSnapshotReader } from "./fs-snapshot.mjs";

export const PREPARED_PREVIEW_HANDOFF_SCHEMA = "nebular-prepared-preview-handoff-v1";

const HANDOFF_HEX64_RE = /^[a-f0-9]{64}$/u;
const STAGED_OBSERVATION_KEYS = Object.freeze([
  "manifestSha256",
  "originSourceCandidate",
  "originOutputIdentity",
  "currentSourceCandidate",
  "target",
  "effectiveInputIdentity",
  "neutralIdentity",
]);
const SOURCE_PIN_EXACT_KEYS = Object.freeze([
  "sourceCandidate",
  "target",
  "sidecarManifest",
  "scene",
  "loom",
  "solar",
]);
const HANDOFF_OUTPUT_EXACT_KEYS = Object.freeze([
  "schema",
  "identity",
  "manifestSha256",
  "originSourceCandidate",
  "originOutputIdentity",
  "currentSourceCandidate",
  "target",
  "effectiveInputIdentity",
  "neutralIdentity",
  "publicPreviewIdentity",
  "sourceBuildPinsSha256",
  "buildReceipt",
  "candidateProvenance",
  "nativePayload",
]);

/** @typedef {Record<string, unknown>} JsonRecord */
/** @typedef {typeof defaultSnapshotReader} SnapshotReader */
/** @typedef {NonNullable<ReturnType<SnapshotReader["readRegular"]>>} Snapshot */
/** @typedef {Awaited<ReturnType<typeof validateBuildInputs>>} ValidatedBuildInputs */
/** @typedef {ValidatedBuildInputs["inputs"]} BuildInputs */
/** @typedef {ValidatedBuildInputs["target"]} PlatformTarget */
/** @typedef {Awaited<ReturnType<typeof inventoryNativePayload>>} Inventory */
/** @typedef {{ source: string, output: string, producer: string }} ReceiptComponent */
/** @typedef {{ path: string, identity: string }} ResourceRecord */
/** @typedef {{ identity: string, resources: ResourceRecord[], externalBin: ResourceRecord[] }} PreparationRecord */
/** @typedef {{ schema: "nebular-build-receipt-v1", identity: string, sourceCandidate: string, version: string, target: string, mode: "nix-source" | "portable-source", toolchains: Record<string, string>, components: Record<string, ReceiptComponent>, settings: string, preparation: PreparationRecord, nativePayload: string }} BuildReceipt */
/** @typedef {ReturnType<typeof candidateProvenance>} ProvenanceRecord */
/** @typedef {{ manifestSha256: string, originSourceCandidate: string, originOutputIdentity: string, currentSourceCandidate: string, target: string, effectiveInputIdentity: string, neutralIdentity: string }} PreparedPreviewObservation */
/** @typedef {{ schema: "nebular-prepared-preview-handoff-v1", identity: string, manifestSha256: string, originSourceCandidate: string, originOutputIdentity: string, currentSourceCandidate: string, target: string, effectiveInputIdentity: string, neutralIdentity: string, publicPreviewIdentity: string, sourceBuildPinsSha256: string, buildReceipt: string, candidateProvenance: string, nativePayload: string }} PreparedPreviewHandoffRecord */
/** @typedef {{ receipt: BuildReceipt, provenance: ProvenanceRecord, payload: Inventory, preparedPreviewHandoff?: PreparedPreviewHandoffRecord }} BuildReceiptResult */
/** @typedef {{ inputs: BuildInputs, studioRoot: string, payloadRoot: string, output: string, reader?: SnapshotReader, preparedPreview?: PreparedPreviewObservation, previewHashBudget?: ReturnType<typeof createPreviewHashBudget> }} ReceiptOptions */

/** @param {unknown} value @returns {value is JsonRecord} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is { code: unknown }} */
function hasErrorCode(value) {
  return value !== null && typeof value === "object" && "code" in value;
}

/** @param {unknown} value @param {string} member @returns {string | undefined} */
function pinnedSha(value, member) {
  if (!isRecord(value) || !isRecord(value[member]) || typeof value[member].sha256 !== "string") return undefined;
  return value[member].sha256;
}

// The executable bit and the target header are both taken from one no-follow
// descriptor, and the payload path must still name that file afterwards.
/** @param {string} executable @param {PlatformTarget} target @param {SnapshotReader} [reader] @returns {Snapshot} */
export function measureNativeExecutable(executable, target, reader = defaultSnapshotReader) {
  const produced = reader.readRegular(executable, {
    bindPath: true,
    label: "Native output",
    maxBytes: 1024 * 1024 * 1024,
    messages: { notRegular: "Native output must be a regular file", symlink: "Native output must be a regular file, not a symbolic link" },
  });
  if (!produced) throw new Error("Native output is missing");
  if (!produced.executable) throw new Error("Native output is not executable");
  const header = produced.bytes;
  const correctTarget = target.os === "darwin"
    ? header.length >= 8 && header.readUInt32LE(0) === 0xfeedfacf && header.readUInt32LE(4) === 0x0100000c
    : header.length >= 20 && header.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))
      && header[4] === 2 && header[5] === 1
      && header.readUInt16LE(18) === (target.cpu === "arm64" ? 183 : 62);
  if (!correctTarget) throw new Error("Native output target mismatch");
  return produced;
}

/**
 * Closed local validator for nebular-prepared-preview-handoff-v1 sidecar records.
 * @param {unknown} handoff
 * @param {{
 *   inputs: BuildInputs,
 *   receipt: BuildReceipt,
 *   provenance: ProvenanceRecord,
 *   payload: Inventory,
 *   preparedPreview?: PreparedPreviewObservation,
 *   sourceBuildPinsSha256?: string
 * }} context
 * @returns {asserts handoff is PreparedPreviewHandoffRecord}
 */
export function validatePreparedPreviewHandoff(handoff, context) {
  if (!isRecord(handoff)) throw new Error("Prepared preview handoff must be a JSON object");
  const actualKeys = Object.keys(handoff).sort();
  const expectedKeys = [...HANDOFF_OUTPUT_EXACT_KEYS].sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((k, idx) => k !== expectedKeys[idx])) {
    throw new Error("Prepared preview handoff keys differ from closed contract");
  }
  const { identity: declaredIdentity, ...body } = handoff;
  if (
    body.schema !== PREPARED_PREVIEW_HANDOFF_SCHEMA ||
    typeof declaredIdentity !== "string" ||
    !HANDOFF_HEX64_RE.test(declaredIdentity) ||
    identity(body) !== declaredIdentity
  ) {
    throw new Error("Prepared preview handoff envelope identity mismatch");
  }
  for (const shaKey of [
    "manifestSha256",
    "originSourceCandidate",
    "originOutputIdentity",
    "currentSourceCandidate",
    "effectiveInputIdentity",
    "neutralIdentity",
    "publicPreviewIdentity",
    "sourceBuildPinsSha256",
    "buildReceipt",
    "candidateProvenance",
    "nativePayload",
  ]) {
    if (typeof handoff[shaKey] !== "string" || !HANDOFF_HEX64_RE.test(/** @type {string} */ (handoff[shaKey]))) {
      throw new Error(`Invalid prepared preview handoff ${shaKey} digest`);
    }
  }
  if (handoff.originSourceCandidate !== EXPECTED_PREVIEW_ORIGIN.sourceCandidate) {
    throw new Error("Prepared preview handoff originSourceCandidate mismatch");
  }
  if (handoff.currentSourceCandidate !== context.inputs.source.identity) {
    throw new Error("Prepared preview handoff currentSourceCandidate does not match inputs.source.identity");
  }
  if (handoff.target !== context.inputs.target || handoff.target !== "aarch64-apple-darwin") {
    throw new Error("Prepared preview handoff target does not match aarch64-apple-darwin inputs.target");
  }
  if (
    handoff.neutralIdentity !== handoff.originOutputIdentity ||
    handoff.publicPreviewIdentity !== handoff.originOutputIdentity
  ) {
    throw new Error("Prepared preview handoff neutral/public preview identities do not equal originOutputIdentity");
  }
  if (
    handoff.buildReceipt !== context.receipt.identity ||
    handoff.candidateProvenance !== context.provenance.identity ||
    handoff.nativePayload !== context.payload.identity
  ) {
    throw new Error("Prepared preview handoff does not bind newly emitted receipt, provenance, and nativePayload");
  }
  if (context.sourceBuildPinsSha256 && handoff.sourceBuildPinsSha256 !== context.sourceBuildPinsSha256) {
    throw new Error("Prepared preview handoff sourceBuildPinsSha256 mismatch");
  }
  if (context.preparedPreview) {
    if (
      handoff.manifestSha256 !== context.preparedPreview.manifestSha256 ||
      handoff.originOutputIdentity !== context.preparedPreview.originOutputIdentity ||
      handoff.effectiveInputIdentity !== context.preparedPreview.effectiveInputIdentity
    ) {
      throw new Error("Prepared preview handoff does not match staged preview observation");
    }
  }
}

// Called only after the native command exits successfully. All claims are
// collected from produced bytes; no pre-build or schema-only success receipt.
/** @param {ReceiptOptions} options @returns {Promise<BuildReceiptResult>} */
export async function produceBuildReceipt({
  inputs,
  studioRoot,
  payloadRoot,
  output,
  reader = defaultSnapshotReader,
  preparedPreview,
  previewHashBudget,
}) {
  const authority = await validateBuildInputs(inputs);
  let verifiedNeutralIdentity = null;
  let verifiedPublicIdentity = null;
  let pinsRawSha256 = null;

  if (preparedPreview !== undefined) {
    if (!isRecord(preparedPreview)) {
      throw new Error("preparedPreview observation must be a JSON object");
    }
    const obsKeys = Object.keys(preparedPreview).sort();
    const expectedObsKeys = [...STAGED_OBSERVATION_KEYS].sort();
    if (obsKeys.length !== expectedObsKeys.length || obsKeys.some((k, idx) => k !== expectedObsKeys[idx])) {
      throw new Error("preparedPreview observation keys differ from closed stagedObservation contract");
    }
    if (
      inputs.target !== "aarch64-apple-darwin" ||
      inputs.mode !== "portable-source" ||
      authority.target.os !== "darwin"
    ) {
      throw new Error("preparedPreview receipt route is only admitted for aarch64-apple-darwin portable-source");
    }
    /** @type {Array<Exclude<keyof PreparedPreviewObservation, "target">>} */
    const digestKeys = [
      "manifestSha256",
      "originSourceCandidate",
      "originOutputIdentity",
      "currentSourceCandidate",
      "effectiveInputIdentity",
      "neutralIdentity",
    ];
    for (const shaKey of digestKeys) {
      const val = preparedPreview[shaKey];
      if (typeof val !== "string" || !HANDOFF_HEX64_RE.test(val)) {
        throw new Error(`Invalid preparedPreview.${shaKey} digest`);
      }
    }
    if (preparedPreview.originSourceCandidate !== EXPECTED_PREVIEW_ORIGIN.sourceCandidate) {
      throw new Error("preparedPreview.originSourceCandidate mismatch");
    }
    if (preparedPreview.currentSourceCandidate !== inputs.source.identity) {
      throw new Error("preparedPreview.currentSourceCandidate does not match inputs.source.identity");
    }
    if (preparedPreview.target !== inputs.target) {
      throw new Error("preparedPreview.target does not match inputs.target");
    }
    if (preparedPreview.neutralIdentity !== preparedPreview.originOutputIdentity) {
      throw new Error("preparedPreview.neutralIdentity does not equal originOutputIdentity");
    }

    const budget = previewHashBudget ?? createPreviewHashBudget();
    const neutralCheck = await inspectBoundedPreviewTree(
      join(studioRoot, "loom-preview-source/dist/neutral"),
      PREPARED_PREVIEW_LIMITS.neutralOutputPerDomain,
      budget,
      { exactAggregateBytes: true, expectedDirs: EXPECTED_PREVIEW_OUTPUT_DIRS },
    );
    await inspectPreparedPreviewAppProjection(join(studioRoot, "public/preview/app"), budget);
    const publicCheck = await inspectBoundedPreviewTree(
      join(studioRoot, "public/preview"),
      PREPARED_PREVIEW_LIMITS.neutralOutputPerDomain,
      budget,
      { exactAggregateBytes: true, expectedDirs: EXPECTED_PREVIEW_OUTPUT_DIRS, excludedRootEntries: ["app"] },
    );
    for (const check of [neutralCheck, publicCheck]) {
      if (
        check.inventory.identity !== preparedPreview.originOutputIdentity ||
        check.inventory.files.length !== EXPECTED_PREVIEW_NORMALIZED_OUTPUT.length
      ) {
        throw new Error("Prepared preview output inventory in studioRoot does not match originOutputIdentity");
      }
      for (const [i, exp] of EXPECTED_PREVIEW_NORMALIZED_OUTPUT.entries()) {
        const actual = check.inventory.files[i];
        if (!actual || actual.path !== exp.path || actual.bytes !== exp.bytes || actual.mode !== exp.mode) {
          throw new Error(`Prepared preview output member mismatch at ${actual?.path ?? exp.path}`);
        }
      }
    }
    verifiedNeutralIdentity = neutralCheck.inventory.identity;
    verifiedPublicIdentity = publicCheck.inventory.identity;
  }

  measureNativeExecutable(join(payloadRoot, payloadLayout(authority.target).executable), authority.target, reader);
  const darwin = authority.target.os === "darwin";
  const plan = inputs.source.resourcePlans[inputs.target];
  if (!plan) throw new Error("Native resource plan missing for build target");
  const resources = [];
  for (const path of plan.resources) {
    const prepared = (await inventoryTree(join(studioRoot, "src-tauri", path))).identity;
    const shipped = (await inventoryTree(join(payloadRoot, payloadLayout(authority.target).resources, path))).identity;
    if (prepared !== shipped) throw new Error("Native resource differs from prepared authority");
    resources.push({ path, identity: shipped });
  }
  const externalBin = [];
  for (const path of plan.externalBin) {
    const prepared = digest(await readFile(join(studioRoot, "src-tauri", `${path}-${inputs.target}`)));
    const shippedPath = darwin ? "Theme Forge Nebular Fusion.app/Contents/MacOS/tfsb-studio-service" : "bin/tfsb-studio-service";
    const shipped = digest(await readFile(join(payloadRoot, shippedPath)));
    if (prepared !== shipped) throw new Error("Native sidecar differs from prepared authority");
    externalBin.push({ path, identity: shipped });
  }

  const pinsPath = join(studioRoot, "src-tauri", "source-build-pins.json");
  /** @type {JsonRecord | null} */
  let pinsContent = null;
  try {
    const pinsRaw = await readFile(pinsPath);
    if (previewHashBudget) previewHashBudget.charge(pinsRaw.length);
    pinsRawSha256 = digest(pinsRaw);
    const parsed = JSON.parse(pinsRaw.toString("utf8"));
    if (!isRecord(parsed)) throw new Error("Source-build pins must be a record");
    pinsContent = parsed;
  } catch (err) {
    if (!hasErrorCode(err) || err.code !== "ENOENT") throw err;
  }
  if (preparedPreview !== undefined) {
    if (!pinsContent || !pinsRawSha256) {
      throw new Error("Prepared preview receipt route requires freshly generated source-build-pins.json");
    }
    const pinKeys = Object.keys(pinsContent).sort();
    const expectedPinKeys = [...SOURCE_PIN_EXACT_KEYS].sort();
    if (pinKeys.length !== expectedPinKeys.length || pinKeys.some((k, idx) => k !== expectedPinKeys[idx])) {
      throw new Error("source-build-pins.json keys differ from closed six-key contract");
    }
    if (pinsContent.sourceCandidate !== inputs.source.identity || pinsContent.target !== inputs.target) {
      throw new Error("source-build-pins.json does not bind current sourceCandidate and target");
    }
  }
  if (pinsContent) {
    const runtimeIdentity = externalBin[0]?.identity;
    if (!runtimeIdentity) {
      throw new Error("Missing externalBin runtime identity for source-build pin verification");
    }
    if (pinnedSha(pinsContent.sidecarManifest, "runtime") !== runtimeIdentity) {
      throw new Error("Source-build sidecar manifest runtime does not match shipped externalBin");
    }
    if (pinnedSha(pinsContent.scene, "node") !== runtimeIdentity) {
      throw new Error("Source-build scene node pin does not match shipped externalBin");
    }
    if (pinnedSha(pinsContent.loom, "node") !== runtimeIdentity) {
      throw new Error("Source-build loom node pin does not match shipped externalBin");
    }
  }

  const preparation = { resources, externalBin };
  const payload = await inventoryNativePayload(payloadRoot, { expectedTarget: inputs.target });
  /** @type {Record<string, ReceiptComponent>} */
  const components = Object.fromEntries(Object.entries(authority.claims.components).map(([name, c]) =>
    [name, { source: c.source, output: c.output, producer: c.producer }]));
  const settingsIdentity = authority.claims.settings?.identity ?? authority.claims.settings;
  if (!settingsIdentity || typeof settingsIdentity !== "string" || !/^[a-f0-9]{64}$/.test(settingsIdentity)) {
    throw new Error("Valid settings identity required for build receipt");
  }
  /** @type {BuildReceipt} */
  const receipt = seal("nebular-build-receipt-v1", { sourceCandidate: inputs.source.identity,
    version: inputs.source.version, target: inputs.target, mode: inputs.mode,
    toolchains: authority.claims.toolchains, components, settings: settingsIdentity,
    preparation: { ...preparation, identity: identity(preparation) }, nativePayload: payload.identity });
  validateBuildReceipt(receipt, inputs.source);
  const provenance = candidateProvenance(inputs.source, receipt);
  /** @type {PreparedPreviewHandoffRecord | undefined} */
  let handoff;
  if (preparedPreview !== undefined && verifiedNeutralIdentity && verifiedPublicIdentity && pinsRawSha256) {
    const sealedHandoff = seal(PREPARED_PREVIEW_HANDOFF_SCHEMA, {
      manifestSha256: preparedPreview.manifestSha256,
      originSourceCandidate: preparedPreview.originSourceCandidate,
      originOutputIdentity: preparedPreview.originOutputIdentity,
      currentSourceCandidate: inputs.source.identity,
      target: inputs.target,
      effectiveInputIdentity: preparedPreview.effectiveInputIdentity,
      neutralIdentity: verifiedNeutralIdentity,
      publicPreviewIdentity: verifiedPublicIdentity,
      sourceBuildPinsSha256: pinsRawSha256,
      buildReceipt: receipt.identity,
      candidateProvenance: provenance.identity,
      nativePayload: payload.identity,
    });
    validatePreparedPreviewHandoff(sealedHandoff, {
      inputs,
      receipt,
      provenance,
      payload,
      preparedPreview,
      sourceBuildPinsSha256: pinsRawSha256,
    });
    handoff = sealedHandoff;
  }
  /** @type {Array<[string, JsonRecord]>} */
  const records = [["build-receipt.json", receipt], ["native-payload.json", payload], ["candidate-provenance.json", provenance]];
  for (const [name, record] of records) {
    await writeFile(join(output, name), JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
  }
  if (handoff) {
    await writeFile(join(output, "prepared-preview-handoff.json"), JSON.stringify(handoff, null, 2) + "\n", { flag: "wx" });
    return { receipt, provenance, payload, preparedPreviewHandoff: handoff };
  }
  return { receipt, provenance, payload };
}
