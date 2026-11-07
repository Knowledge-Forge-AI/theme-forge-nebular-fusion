import { Buffer } from "node:buffer";

/*
 * Pure paired-profile v2 compile adapter.
 *
 * This module deliberately has no source lookup, filesystem, process, provider,
 * network, or native binding.  The native owner supplies custody bytes and
 * revision/session claims.  Solar owns binding, validation, canonicalization,
 * transformation, and mapping semantics; this adapter only applies the closed
 * transport edit grammar and checks returned identities and budgets.
 */

export const PAIRED_V2_LIMITS = Object.freeze({
  sourceBytes: 131_072,
  sourceBase64Chars: 175_104,
  profileJsonBytes: 262_144,
  solarCssBytes: 262_144,
  loomCssBytes: 262_144,
  applicationAppearanceCssBytes: 524_288,
  applicationExtensionBytes: 65_536,
  mappingReportBytes: 245_760,
  diagnosticsBytes: 32_768,
  responseBytes: 2_097_152,
  requestBytes: 2_097_152,
  editEntries: 64,
  diagnosticEntries: 256,
  mappingEntries: 4_096,
  mappingGroups: 64,
  mappingDefaults: 256,
  stringValueChars: 500,
  fontFamilyItemBytes: 100,
  explicitLengthBytes: 64,
  hexValueBytes: 9,
  errorMessageChars: 2_048,
  sessionIdBytes: 128,
  editPathBytes: 256,
  numericEditValue: 100_000,
  lineHeight: 10,
});

const REQUEST_FIELDS = Object.freeze([
  "rawSourceBase64",
  "expectedRawSourceSha256",
  "expectedCanonicalDigest",
  "edits",
  "uiRevision",
  "sessionId",
]);

const STATUS = Object.freeze({
  SUCCESS: "success",
  PARTIAL: "partial",
  STALE: "stale",
  CANCELLED: "cancelled",
  ERROR: "error",
});

const ERROR_MESSAGES = Object.freeze({
  INVALID_REQUEST: "The compile request is invalid.",
  INVALID_DEPENDENCIES: "The compile adapter dependencies are invalid.",
  SOURCE_TOO_LARGE: "The source exceeds the bounded source budget.",
  SOURCE_BIND_FAILED: "The source could not be bound.",
  STALE_PROVENANCE: "The source provenance claim is stale.",
  INVALID_EDIT: "The edit list is invalid.",
  EDIT_TARGET_MISSING: "The edit target is unavailable.",
  TRANSFORM_FAILED: "The profile edit could not be applied.",
  CANONICALIZATION_FAILED: "The transformed profile could not be canonicalized.",
  REBIND_FAILED: "The transformed source could not be rebound.",
  RECIPE_FAILED: "The injected compile recipe failed.",
  RECIPE_OUTPUT_INVALID: "The injected compile recipe returned an invalid result.",
  FATAL_DIAGNOSTIC: "The compile recipe returned a fatal diagnostic.",
  RESPONSE_TOO_LARGE: "The compile response exceeds its response budget.",
  CANCELLED: "The compile was cancelled.",
  SESSION_MISMATCH: "The compile session is no longer active.",
  REVISION_STALE: "The compile revision is no longer current.",
  INTERNAL_CONTRACT: "The compile adapter contract was not satisfied.",
});

const COLOR_MODES = new Set(["light", "dark"]);
const COLOR_ROLES = new Set([
  "canvas",
  "canvasText",
  "surface",
  "surfaceText",
  "elevatedSurface",
  "elevatedSurfaceText",
  "primaryAction",
  "primaryActionText",
  "secondaryAction",
  "secondaryActionText",
  "mutedSurface",
  "mutedText",
  "highlight",
  "highlightText",
  "danger",
  "dangerText",
  "border",
  "fieldBorder",
  "focus",
  "hover",
  "active",
  "selection",
  "selectionText",
]);
const TYPOGRAPHY_ROLES = new Set(["body", "heading", "ui", "code"]);
const RADIUS_ROLES = new Set(["control", "surface", "overlay"]);
const TYPOGRAPHY_FIELDS = new Set(["family", "size", "lineHeight"]);
const OPTIONAL_COLOR_ROLES = new Set(["hover", "active"]);
const OPTIONAL_TYPOGRAPHY_FIELDS = new Set(["size", "lineHeight"]);
const PARTIAL_CLASSIFICATIONS = new Set(["normalized", "unsupported", "target-specific"]);
const HASH_RE = /^[0-9a-f]{64}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const EDIT_FORBIDDEN_RE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const CSS_DELIMITER_RE = /[{};]/u;

class ContractFailure extends Error {
  constructor(code) {
    super(code);
    this.name = "PairedV2ContractFailure";
    this.code = code;
  }
}

function fail(code) {
  throw new ContractFailure(code);
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function record(value, code = "INVALID_REQUEST") {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(code);
  return value;
}

function exactKeys(value, allowed, required, code) {
  const object = record(value, code);
  const known = new Set(allowed);
  for (const key of Object.keys(object)) {
    if (!known.has(key)) fail(code);
  }
  for (const key of required) {
    if (!own(object, key)) fail(code);
  }
  return object;
}

function utf8Bytes(value) {
  return new TextEncoder().encode(value).byteLength;
}

function safeJsonBytes(value, code) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    fail(code);
  }
  if (serialized === undefined) fail(code);
  return utf8Bytes(serialized);
}

function boundedString(value, maxBytes, code, allowEmpty = false) {
  if (typeof value !== "string") fail(code);
  if (!allowEmpty && value.length === 0) fail(code);
  if (CONTROL_RE.test(value) || utf8Bytes(value) > maxBytes) fail(code);
  return value;
}

function boundedEditText(value, maxBytes, code) {
  if (typeof value !== "string" || value.length === 0) fail(code);
  if (EDIT_FORBIDDEN_RE.test(value) || CSS_DELIMITER_RE.test(value) || utf8Bytes(value) > maxBytes) fail(code);
  return value;
}

function boundedFontStack(value, code) {
  const text = boundedEditText(value, PAIRED_V2_LIMITS.stringValueChars, code);
  if (text.split(",").some((item) => utf8Bytes(item) > PAIRED_V2_LIMITS.fontFamilyItemBytes)) fail(code);
  return text;
}

function boundedCss(value, maxBytes, code) {
  if (typeof value !== "string" || value.trim().length === 0 ||
      value.includes(String.fromCharCode(0)) || utf8Bytes(value) > maxBytes) fail(code);
  return value;
}

function boundedHash(value, code) {
  if (typeof value !== "string" || !HASH_RE.test(value)) fail(code);
  return value;
}

function boundedRevision(value, code) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function strictBase64(value) {
  const encoded = boundedString(value, PAIRED_V2_LIMITS.sourceBase64Chars, "INVALID_REQUEST");
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded) ||
    encoded.length % 4 !== 0
  ) {
    fail("INVALID_REQUEST");
  }
  let bytes;
  try {
    bytes = Buffer.from(encoded, "base64");
  } catch {
    fail("INVALID_REQUEST");
  }
  if (bytes.length === 0 || bytes.length > PAIRED_V2_LIMITS.sourceBytes) fail("SOURCE_TOO_LARGE");
  if (bytes.toString("base64") !== encoded) fail("INVALID_REQUEST");
  return bytes;
}

function jsonValue(value, code, depth = 0, seen = new WeakSet()) {
  if (depth > 64) fail(code);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object") fail(code);
  if (seen.has(value)) fail(code);
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((entry) => jsonValue(entry, code, depth + 1, seen));
    seen.delete(value);
    return result;
  }
  const result = Object.create(null);
  for (const [key, entry] of Object.entries(value)) {
    if (CONTROL_RE.test(key)) fail(code);
    result[key] = jsonValue(entry, code, depth + 1, seen);
  }
  seen.delete(value);
  return result;
}

function validateRequest(request) {
  const object = exactKeys(request, REQUEST_FIELDS, REQUEST_FIELDS, "INVALID_REQUEST");
  if (safeJsonBytes(object, "INVALID_REQUEST") > PAIRED_V2_LIMITS.requestBytes) fail("INVALID_REQUEST");
  const rawSourceBase64 = object.rawSourceBase64;
  const rawBytes = strictBase64(rawSourceBase64);
  const expectedRawSourceSha256 = boundedHash(object.expectedRawSourceSha256, "INVALID_REQUEST");
  const expectedCanonicalDigest = boundedHash(object.expectedCanonicalDigest, "INVALID_REQUEST");
  const uiRevision = boundedRevision(object.uiRevision, "INVALID_REQUEST");
  const sessionId = boundedString(object.sessionId, PAIRED_V2_LIMITS.sessionIdBytes, "INVALID_REQUEST");
  const edits = validateEdits(object.edits);
  return {
    rawSourceBase64,
    rawBytes,
    expectedRawSourceSha256,
    expectedCanonicalDigest,
    edits,
    uiRevision,
    sessionId,
  };
}

function pathParts(path) {
  return path.split(".");
}

function isColorPath(path) {
  const parts = pathParts(path);
  return parts.length === 3 && parts[0] === "color" && COLOR_MODES.has(parts[1]) && COLOR_ROLES.has(parts[2]);
}

function isTypographyPath(path) {
  const parts = pathParts(path);
  return parts.length === 3 && parts[0] === "typography" && TYPOGRAPHY_ROLES.has(parts[1]) && TYPOGRAPHY_FIELDS.has(parts[2]);
}

function isRadiusPath(path) {
  const parts = pathParts(path);
  return parts.length === 2 && parts[0] === "radius" && RADIUS_ROLES.has(parts[1]);
}

function isClearOptionalPath(path) {
  if (isRadiusPath(path)) return path !== "radius.surface";
  const parts = pathParts(path);
  if (parts.length !== 3) return false;
  if (parts[0] === "color") return COLOR_MODES.has(parts[1]) && OPTIONAL_COLOR_ROLES.has(parts[2]);
  return parts[0] === "typography" && TYPOGRAPHY_ROLES.has(parts[1]) && OPTIONAL_TYPOGRAPHY_FIELDS.has(parts[2]);
}

function validateEdit(value) {
  const edit = record(value, "INVALID_EDIT");
  const kind = edit.kind;
  if (kind === "set-color") {
    exactKeys(edit, ["kind", "path", "value"], ["kind", "path", "value"], "INVALID_EDIT");
    const path = boundedString(edit.path, PAIRED_V2_LIMITS.editPathBytes, "INVALID_EDIT");
    if (!isColorPath(path)) fail("INVALID_EDIT");
    const color = boundedEditText(edit.value, PAIRED_V2_LIMITS.hexValueBytes, "INVALID_EDIT");
    if (/^color\.(?:light|dark)\.selection(?:Text)?$/.test(path) && !/^#[0-9a-f]{6}$/i.test(color)) fail("INVALID_EDIT");
    return Object.freeze({ kind, path, value: color });
  }
  if (kind === "set-typography") {
    exactKeys(edit, ["kind", "path", "value"], ["kind", "path", "value"], "INVALID_EDIT");
    const path = boundedString(edit.path, PAIRED_V2_LIMITS.editPathBytes, "INVALID_EDIT");
    if (!isTypographyPath(path)) fail("INVALID_EDIT");
    if (path.endsWith(".family")) {
      const family = boundedFontStack(edit.value, "INVALID_EDIT");
      if (path === "typography.ui.family" && !["system-ui", "monospace", "sans-serif", "serif"].includes(family)) fail("INVALID_EDIT");
      return Object.freeze({ kind, path, value: family });
    }
    if (path.endsWith(".size")) {
      return Object.freeze({ kind, path, value: boundedEditText(edit.value, PAIRED_V2_LIMITS.explicitLengthBytes, "INVALID_EDIT") });
    }
    if (typeof edit.value !== "number" || !Number.isFinite(edit.value) || edit.value <= 0 || edit.value > PAIRED_V2_LIMITS.lineHeight || Math.abs(edit.value) > PAIRED_V2_LIMITS.numericEditValue) fail("INVALID_EDIT");
    return Object.freeze({ kind, path, value: edit.value });
  }
  if (kind === "set-radius") {
    exactKeys(edit, ["kind", "path", "value"], ["kind", "path", "value"], "INVALID_EDIT");
    const path = boundedString(edit.path, PAIRED_V2_LIMITS.editPathBytes, "INVALID_EDIT");
    if (!isRadiusPath(path)) fail("INVALID_EDIT");
    const radius = boundedEditText(edit.value, PAIRED_V2_LIMITS.explicitLengthBytes, "INVALID_EDIT");
    if (path === "radius.surface" && !/^\d+(?:\.\d+)?(?:px|rem|em)$/.test(radius)) fail("INVALID_EDIT");
    return Object.freeze({ kind, path, value: radius });
  }
  if (kind === "clear-optional") {
    exactKeys(edit, ["kind", "path"], ["kind", "path"], "INVALID_EDIT");
    const path = boundedString(edit.path, PAIRED_V2_LIMITS.editPathBytes, "INVALID_EDIT");
    if (!isClearOptionalPath(path)) fail("INVALID_EDIT");
    return Object.freeze({ kind, path });
  }
  fail("INVALID_EDIT");
}

function validateEdits(value) {
  if (!Array.isArray(value) || value.length > PAIRED_V2_LIMITS.editEntries) fail("INVALID_EDIT");
  const edits = value.map(validateEdit);
  let previousPath = undefined;
  for (const edit of edits) {
    if (previousPath !== undefined && edit.path <= previousPath) fail("INVALID_EDIT");
    previousPath = edit.path;
  }
  return Object.freeze(edits);
}

function setPath(profile, path, value) {
  const parts = pathParts(path);
  const [group, role, field] = parts;
  if (group === "color") {
    if (!profile.color || !profile.color[role]) fail("EDIT_TARGET_MISSING");
    profile.color[role][field] = value;
    return;
  }
  if (group === "radius") {
    profile.radius ??= {};
    profile.radius[role] = value;
    return;
  }
  if (group === "typography") {
    profile.typography ??= {};
    if (!profile.typography[role]) {
      if (field !== "family") fail("EDIT_TARGET_MISSING");
      profile.typography[role] = {};
    }
    profile.typography[role][field] = value;
    return;
  }
  fail("INVALID_EDIT");
}

function clearPath(profile, path) {
  const parts = pathParts(path);
  const [group, role, field] = parts.length === 3 ? parts : ["radius", parts[1], undefined];
  const parent = profile[group]?.[role];
  if (parent && field !== undefined) delete parent[field];
  else if (group === "radius" && profile.radius) delete profile.radius[role];
}

function applyEdits(profile, edits) {
  for (const edit of edits) {
    if (edit.kind === "clear-optional") {
      clearPath(profile, edit.path);
    } else {
      setPath(profile, edit.path, edit.value);
    }
  }
  return profile;
}

function dependencyValue(dependencies) {
  const object = record(dependencies, "INVALID_DEPENDENCIES");
  if (!object.solarApi || typeof object.solarApi !== "object") fail("INVALID_DEPENDENCIES");
  for (const key of ["bindSourceProfileV2", "canonicalizeProfileV2"]) {
    if (typeof object.solarApi[key] !== "function") fail("INVALID_DEPENDENCIES");
  }
  if (typeof object.compileSingleProfile !== "function") fail("INVALID_DEPENDENCIES");
  const expectedSessionId = boundedString(
    object.expectedSessionId,
    PAIRED_V2_LIMITS.sessionIdBytes,
    "INVALID_DEPENDENCIES"
  );
  const expectedUiRevision = boundedRevision(object.expectedUiRevision, "INVALID_DEPENDENCIES");
  if (object.isCancelled !== undefined && typeof object.isCancelled !== "function") fail("INVALID_DEPENDENCIES");
  return {
    solarApi: object.solarApi,
    compileSingleProfile: object.compileSingleProfile,
    expectedSessionId,
    expectedUiRevision,
    isCancelled: object.isCancelled ?? (() => false),
  };
}

function safeContext(request) {
  const object = request && typeof request === "object" && !Array.isArray(request) ? request : {};
  const sessionId =
    typeof object.sessionId === "string" &&
    object.sessionId.length > 0 &&
    !CONTROL_RE.test(object.sessionId) &&
    utf8Bytes(object.sessionId) <= PAIRED_V2_LIMITS.sessionIdBytes
      ? object.sessionId
      : "invalid-session";
  const uiRevision =
    typeof object.uiRevision === "number" && Number.isSafeInteger(object.uiRevision) && object.uiRevision >= 0
      ? object.uiRevision
      : 0;
  return { sessionId, uiRevision };
}

function failure(status, context, code) {
  const result = {
    status,
    valid: false,
    uiRevision: context.uiRevision,
    sessionId: context.sessionId,
    solarSail: null,
    stellarLoom: null,
    applicationAppearance: null,
    applicationExtension: null,
    diagnostics: [],
  };
  if (status === STATUS.ERROR) result.error = { code, message: ERROR_MESSAGES[code] ?? ERROR_MESSAGES.INTERNAL_CONTRACT };
  return Object.freeze(result);
}

function cancelledOrError(dependencies, context) {
  let cancelled;
  try {
    cancelled = dependencies.isCancelled();
  } catch {
    return failure(STATUS.ERROR, context, "INTERNAL_CONTRACT");
  }
  if (cancelled === true) return failure(STATUS.CANCELLED, context, "CANCELLED");
  if (typeof cancelled !== "boolean") return failure(STATUS.ERROR, context, "INTERNAL_CONTRACT");
  return undefined;
}

function boundProvenance(bound, code) {
  const provenance = record(bound?.provenance, code);
  const raw = boundedHash(provenance.rawSourceSha256, code);
  const canonical = boundedHash(provenance.canonicalDigest, code);
  if (typeof provenance.verificationStatus !== "string") fail(code);
  if (typeof provenance.isTransformed !== "boolean") fail(code);
  if (!Number.isSafeInteger(provenance.byteLength) || provenance.byteLength <= 0) fail(code);
  return { raw, canonical, provenance };
}

function sourceBound(api, rawBytes, expectedHash) {
  let bound;
  try {
    bound = api.bindSourceProfileV2(rawBytes);
  } catch {
    fail("SOURCE_BIND_FAILED");
  }
  const provenance = boundProvenance(bound, "SOURCE_BIND_FAILED");
  if (provenance.raw !== expectedHash) fail("STALE_PROVENANCE");
  if (provenance.provenance.verificationStatus !== "verified" || provenance.provenance.isTransformed) {
    fail("SOURCE_BIND_FAILED");
  }
  if (provenance.provenance.parentSourceSha256 !== undefined) fail("SOURCE_BIND_FAILED");
  if (provenance.provenance.byteLength !== rawBytes.length) fail("SOURCE_BIND_FAILED");
  return bound;
}

function rebindTransformedBound(api, transformed, baselineRaw) {
  const transformedProvenance = boundProvenance(transformed, "TRANSFORM_FAILED");
  if (transformedProvenance.provenance.parentSourceSha256 !== baselineRaw || transformedProvenance.raw === baselineRaw) fail("TRANSFORM_FAILED");
  let canonical;
  try {
    canonical = api.canonicalizeProfileV2(transformed.profile);
  } catch {
    fail("CANONICALIZATION_FAILED");
  }
  if (typeof canonical !== "string") fail("CANONICALIZATION_FAILED");
  const bytes = Buffer.from(canonical, "utf8");
  if (bytes.length === 0 || bytes.length > PAIRED_V2_LIMITS.sourceBytes) fail("SOURCE_TOO_LARGE");
  let rebound;
  try {
    rebound = api.bindSourceProfileV2(bytes, { expectedSha256: transformedProvenance.raw });
  } catch {
    fail("REBIND_FAILED");
  }
  const reboundProvenance = boundProvenance(rebound, "REBIND_FAILED");
  if (
    reboundProvenance.raw !== transformedProvenance.raw ||
    reboundProvenance.canonical !== transformedProvenance.canonical ||
    reboundProvenance.provenance.verificationStatus !== "verified" ||
    reboundProvenance.provenance.isTransformed ||
    reboundProvenance.provenance.parentSourceSha256 !== undefined ||
    reboundProvenance.provenance.byteLength !== bytes.length
  ) {
    fail("REBIND_FAILED");
  }
  return { rebound, bytes };
}

function boundedDiagnostic(value) {
  const object = exactKeys(value, ["severity", "code", "message", "path"], ["severity", "code", "message"], "RECIPE_OUTPUT_INVALID");
  if (!["error", "warning", "info"].includes(object.severity)) fail("RECIPE_OUTPUT_INVALID");
  const result = {
    severity: object.severity,
    code: boundedString(object.code, 128, "RECIPE_OUTPUT_INVALID"),
    message: boundedString(object.message, PAIRED_V2_LIMITS.errorMessageChars, "RECIPE_OUTPUT_INVALID"),
  };
  if (own(object, "path")) result.path = boundedString(object.path, PAIRED_V2_LIMITS.editPathBytes, "RECIPE_OUTPUT_INVALID");
  return result;
}

function diagnostics(value) {
  if (!Array.isArray(value) || value.length > PAIRED_V2_LIMITS.diagnosticEntries) fail("RECIPE_OUTPUT_INVALID");
  const result = value.map(boundedDiagnostic);
  if (safeJsonBytes(result, "RECIPE_OUTPUT_INVALID") > PAIRED_V2_LIMITS.diagnosticsBytes) {
    fail("RECIPE_OUTPUT_INVALID");
  }
  return result;
}

function identity(value) {
  const object = exactKeys(value, ["name", "version"], ["name", "version"], "RECIPE_OUTPUT_INVALID");
  return {
    name: boundedString(object.name, 256, "RECIPE_OUTPUT_INVALID"),
    version: boundedString(object.version, 64, "RECIPE_OUTPUT_INVALID"),
  };
}

function boundedCount(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) fail("RECIPE_OUTPUT_INVALID");
  return value;
}

function mappingEntry(value) {
  const object = exactKeys(
    value,
    ["sourcePath", "sourceValue", "classification", "reason", "targetPath", "targetValue"],
    ["sourcePath", "classification"],
    "RECIPE_OUTPUT_INVALID"
  );
  const classification = object.classification;
  if (!["consumed", "normalized", "overridden", "target-specific", "unsupported", "generated-default"].includes(classification)) {
    fail("RECIPE_OUTPUT_INVALID");
  }
  const result = {
    sourcePath: boundedString(object.sourcePath, PAIRED_V2_LIMITS.editPathBytes, "RECIPE_OUTPUT_INVALID"),
    classification,
  };
  if (own(object, "reason")) result.reason = boundedString(object.reason, PAIRED_V2_LIMITS.errorMessageChars, "RECIPE_OUTPUT_INVALID");
  if (own(object, "sourceValue")) result.sourceValue = jsonValue(object.sourceValue, "RECIPE_OUTPUT_INVALID");
  if (own(object, "targetPath")) result.targetPath = boundedString(object.targetPath, PAIRED_V2_LIMITS.editPathBytes, "RECIPE_OUTPUT_INVALID");
  if (own(object, "targetValue")) result.targetValue = jsonValue(object.targetValue, "RECIPE_OUTPUT_INVALID");
  return result;
}

function mappingReport(value, target, bound) {
  const object = exactKeys(
    value,
    [
      "schema",
      "target",
      "profileName",
      "profileVersion",
      "sourceSha256",
      "sourceVerification",
      "canonicalDigest",
      "adapter",
      "compiler",
      "options",
      "entries",
      "groups",
      "defaults",
      "summary",
      "digest",
    ],
    [
      "schema",
      "target",
      "profileName",
      "profileVersion",
      "sourceSha256",
      "sourceVerification",
      "canonicalDigest",
      "adapter",
      "compiler",
      "options",
      "entries",
      "groups",
      "defaults",
      "summary",
      "digest",
    ],
    "RECIPE_OUTPUT_INVALID"
  );
  const provenance = boundProvenance(bound, "RECIPE_OUTPUT_INVALID");
  if (
    object.schema !== "tf-paired-mapping-report-v2" ||
    object.target !== target ||
    object.sourceVerification !== "source-bytes" ||
    object.sourceSha256 !== provenance.raw ||
    object.canonicalDigest !== provenance.canonical ||
    object.profileName !== bound.profile?.name ||
    object.profileVersion !== bound.profile?.version
  ) {
    fail("RECIPE_OUTPUT_INVALID");
  }
  if (!Array.isArray(object.entries) || object.entries.length > PAIRED_V2_LIMITS.mappingEntries) fail("RECIPE_OUTPUT_INVALID");
  if (!Array.isArray(object.groups) || object.groups.length > PAIRED_V2_LIMITS.mappingGroups) fail("RECIPE_OUTPUT_INVALID");
  if (!Array.isArray(object.defaults) || object.defaults.length > PAIRED_V2_LIMITS.mappingDefaults) fail("RECIPE_OUTPUT_INVALID");
  const entries = object.entries.map(mappingEntry);
  const groups = object.groups.map((entry) => {
    const group = exactKeys(entry, ["group", "applicable", "reason"], ["group", "applicable", "reason"], "RECIPE_OUTPUT_INVALID");
    if (typeof group.applicable !== "boolean") fail("RECIPE_OUTPUT_INVALID");
    return {
      group: boundedString(group.group, 128, "RECIPE_OUTPUT_INVALID"),
      applicable: group.applicable,
      reason: boundedString(group.reason, PAIRED_V2_LIMITS.errorMessageChars, "RECIPE_OUTPUT_INVALID"),
    };
  });
  const defaults = object.defaults.map((entry) => {
    const item = exactKeys(entry, ["targetPath", "targetValue", "reason"], ["targetPath", "targetValue", "reason"], "RECIPE_OUTPUT_INVALID");
    return {
      targetPath: boundedString(item.targetPath, PAIRED_V2_LIMITS.editPathBytes, "RECIPE_OUTPUT_INVALID"),
      targetValue: jsonValue(item.targetValue, "RECIPE_OUTPUT_INVALID"),
      reason: boundedString(item.reason, PAIRED_V2_LIMITS.errorMessageChars, "RECIPE_OUTPUT_INVALID"),
    };
  });
  const summary = exactKeys(
    object.summary,
    ["totalSemanticLeaves", "consumed", "normalized", "overridden", "targetSpecific", "unsupported", "generatedDefaultsCount"],
    ["totalSemanticLeaves", "consumed", "normalized", "overridden", "targetSpecific", "unsupported", "generatedDefaultsCount"],
    "RECIPE_OUTPUT_INVALID"
  );
  const result = {
    schema: object.schema,
    target: object.target,
    profileName: boundedString(object.profileName, 64, "RECIPE_OUTPUT_INVALID"),
    profileVersion: boundedString(object.profileVersion, 64, "RECIPE_OUTPUT_INVALID"),
    sourceSha256: provenance.raw,
    sourceVerification: "source-bytes",
    canonicalDigest: provenance.canonical,
    adapter: identity(object.adapter),
    compiler: identity(object.compiler),
    options: jsonValue(object.options, "RECIPE_OUTPUT_INVALID"),
    entries,
    groups,
    defaults,
    summary: {
      totalSemanticLeaves: boundedCount(summary.totalSemanticLeaves),
      consumed: boundedCount(summary.consumed),
      normalized: boundedCount(summary.normalized),
      overridden: boundedCount(summary.overridden),
      targetSpecific: boundedCount(summary.targetSpecific),
      unsupported: boundedCount(summary.unsupported),
      generatedDefaultsCount: boundedCount(summary.generatedDefaultsCount),
    },
    digest: boundedHash(object.digest, "RECIPE_OUTPUT_INVALID"),
  };
  if (safeJsonBytes(result, "RECIPE_OUTPUT_INVALID") > PAIRED_V2_LIMITS.mappingReportBytes) fail("RECIPE_OUTPUT_INVALID");
  return result;
}

function targetResult(value, target, bound) {
  const object = exactKeys(
    value,
    ["valid", "compiledCss", "diagnostics", "mappingReport", "sourceProfileSha256", "canonicalDigest"],
    ["valid", "compiledCss", "diagnostics", "mappingReport", "sourceProfileSha256", "canonicalDigest"],
    "RECIPE_OUTPUT_INVALID"
  );
  if (object.valid !== true) fail("RECIPE_OUTPUT_INVALID");
  const cssBudget = target === "stellar-loom" ? PAIRED_V2_LIMITS.loomCssBytes : PAIRED_V2_LIMITS.solarCssBytes;
  const compiledCss = boundedCss(object.compiledCss, cssBudget, "RECIPE_OUTPUT_INVALID");
  const checkedDiagnostics = diagnostics(object.diagnostics);
  const report = mappingReport(object.mappingReport, target, bound);
  const provenance = boundProvenance(bound, "RECIPE_OUTPUT_INVALID");
  if (object.sourceProfileSha256 !== provenance.raw || object.canonicalDigest !== provenance.canonical) fail("RECIPE_OUTPUT_INVALID");
  return {
    valid: true,
    compiledCss,
    diagnostics: checkedDiagnostics,
    mappingReport: report,
    sourceProfileSha256: provenance.raw,
    canonicalDigest: provenance.canonical,
  };
}

function applicationAppearanceResult(value, bound) {
  const object = exactKeys(
    value,
    ["valid", "compiledCss", "sourceProfileSha256", "canonicalDigest"],
    ["valid", "compiledCss", "sourceProfileSha256", "canonicalDigest"],
    "RECIPE_OUTPUT_INVALID"
  );
  if (object.valid !== true) fail("RECIPE_OUTPUT_INVALID");
  const compiledCss = boundedCss(object.compiledCss, PAIRED_V2_LIMITS.applicationAppearanceCssBytes, "RECIPE_OUTPUT_INVALID");
  const provenance = boundProvenance(bound, "RECIPE_OUTPUT_INVALID");
  if (object.sourceProfileSha256 !== provenance.raw || object.canonicalDigest !== provenance.canonical) fail("RECIPE_OUTPUT_INVALID");
  return {
    valid: true,
    compiledCss,
    sourceProfileSha256: provenance.raw,
    canonicalDigest: provenance.canonical,
  };
}

function applicationExtensionReport(value) {
  const object = exactKeys(
    value,
    ["schema", "entries", "scope"],
    ["schema", "entries", "scope"],
    "RECIPE_OUTPUT_INVALID"
  );
  if (object.schema !== "theme-forge.application-appearance-extension.v1" || !Array.isArray(object.entries) || object.entries.length > 64) {
    fail("RECIPE_OUTPUT_INVALID");
  }
  const entries = object.entries.map((entry) => {
    const item = exactKeys(entry, ["sourcePath", "target", "value"], ["sourcePath", "target", "value"], "RECIPE_OUTPUT_INVALID");
    return {
      sourcePath: boundedString(item.sourcePath, PAIRED_V2_LIMITS.editPathBytes, "RECIPE_OUTPUT_INVALID"),
      target: boundedString(item.target, PAIRED_V2_LIMITS.editPathBytes, "RECIPE_OUTPUT_INVALID"),
      value: jsonValue(item.value, "RECIPE_OUTPUT_INVALID"),
    };
  });
  return {
    schema: object.schema,
    entries,
    scope: boundedString(object.scope, PAIRED_V2_LIMITS.errorMessageChars, "RECIPE_OUTPUT_INVALID"),
  };
}

function applicationExtensionResult(value, bound) {
  const object = exactKeys(
    value,
    ["valid", "compiledCss", "diagnostics", "mappingReport", "sourceProfileSha256", "canonicalDigest"],
    ["valid", "compiledCss", "diagnostics", "mappingReport", "sourceProfileSha256", "canonicalDigest"],
    "RECIPE_OUTPUT_INVALID"
  );
  if (object.valid !== true) fail("RECIPE_OUTPUT_INVALID");
  const compiledCss = boundedCss(object.compiledCss, PAIRED_V2_LIMITS.applicationExtensionBytes, "RECIPE_OUTPUT_INVALID");
  const checkedDiagnostics = diagnostics(object.diagnostics);
  const report = applicationExtensionReport(object.mappingReport);
  const provenance = boundProvenance(bound, "RECIPE_OUTPUT_INVALID");
  if (object.sourceProfileSha256 !== provenance.raw || object.canonicalDigest !== provenance.canonical) fail("RECIPE_OUTPUT_INVALID");
  if (utf8Bytes(compiledCss) + safeJsonBytes(report, "RECIPE_OUTPUT_INVALID") > PAIRED_V2_LIMITS.applicationExtensionBytes) {
    fail("RECIPE_OUTPUT_INVALID");
  }
  return {
    valid: true,
    compiledCss,
    diagnostics: checkedDiagnostics,
    mappingReport: report,
    sourceProfileSha256: provenance.raw,
    canonicalDigest: provenance.canonical,
  };
}

function draftResult(bound, request, baseline, transformed, sourceBytes) {
  const profile = jsonValue(bound.profile, "RECIPE_OUTPUT_INVALID");
  if (safeJsonBytes(profile, "RECIPE_OUTPUT_INVALID") > PAIRED_V2_LIMITS.profileJsonBytes) fail("RECIPE_OUTPUT_INVALID");
  const provenance = boundProvenance(bound, "RECIPE_OUTPUT_INVALID");
  const draft = {
    profile,
    sourceBytesBase64: transformed ? Buffer.from(sourceBytes).toString("base64") : request.rawSourceBase64,
    rawSourceSha256: provenance.raw,
    canonicalDigest: provenance.canonical,
    baselineRawSourceSha256: baseline.raw,
    baselineCanonicalDigest: baseline.canonical,
    verificationStatus: transformed ? "transformed" : "verified",
    isTransformed: transformed,
  };
  if (transformed) draft.parentSourceSha256 = baseline.raw;
  if (safeJsonBytes(draft, "RECIPE_OUTPUT_INVALID") > PAIRED_V2_LIMITS.responseBytes) fail("RECIPE_OUTPUT_INVALID");
  return draft;
}

function hasFatal(items) {
  return items.some((item) => item.severity === "error");
}

function hasPartialReport(report) {
  return report.entries.some((entry) => PARTIAL_CLASSIFICATIONS.has(entry.classification)) ||
    report.summary.normalized > 0 ||
    report.summary.targetSpecific > 0 ||
    report.summary.unsupported > 0;
}

function responseBudget(response) {
  if (safeJsonBytes(response, "RESPONSE_TOO_LARGE") > PAIRED_V2_LIMITS.responseBytes) fail("RESPONSE_TOO_LARGE");
}

export function compilePairedV2(request, dependencies) {
  const context = safeContext(request);
  try {
    const parsed = validateRequest(request);
    const deps = dependencyValue(dependencies);
    const parsedContext = { sessionId: parsed.sessionId, uiRevision: parsed.uiRevision };
    if (parsed.sessionId !== deps.expectedSessionId) return failure(STATUS.CANCELLED, parsedContext, "SESSION_MISMATCH");
    if (parsed.uiRevision !== deps.expectedUiRevision) return failure(STATUS.STALE, parsedContext, "REVISION_STALE");
    const preflight = cancelledOrError(deps, parsedContext);
    if (preflight) return preflight;

    const bound = sourceBound(deps.solarApi, parsed.rawBytes, parsed.expectedRawSourceSha256);
    const baseline = {
      raw: parsed.expectedRawSourceSha256,
      canonical: parsed.expectedCanonicalDigest,
    };
    const initialProvenance = boundProvenance(bound, "SOURCE_BIND_FAILED");
    if (initialProvenance.canonical !== baseline.canonical) return failure(STATUS.ERROR, parsedContext, "STALE_PROVENANCE");

    let finalBound = bound;
    let sourceBytes = parsed.rawBytes;
    let transformed = false;
    if (parsed.edits.length > 0) {
      let transformedBound;
      try {
        transformedBound = bound.transform((profile) => applyEdits(profile, parsed.edits));
      } catch (error) {
        if (error instanceof ContractFailure) throw error;
        fail("TRANSFORM_FAILED");
      }
      const afterTransform = cancelledOrError(deps, parsedContext);
      if (afterTransform) return afterTransform;
      const transformedProvenance = boundProvenance(transformedBound, "TRANSFORM_FAILED");
      if (transformedProvenance.raw === baseline.raw && transformedProvenance.canonical === baseline.canonical) {
        // A value-preserving edit on an already canonical source is still a
        // verified root.  Keep the original bound bytes and do not invent a
        // transformed/self-parent lineage for a semantic no-op.
        finalBound = bound;
        sourceBytes = parsed.rawBytes;
        transformed = false;
      } else {
        const rebound = rebindTransformedBound(deps.solarApi, transformedBound, baseline.raw);
        finalBound = rebound.rebound;
        sourceBytes = rebound.bytes;
        transformed = true;
      }
    }

    const afterBind = cancelledOrError(deps, parsedContext);
    if (afterBind) return afterBind;

    let recipe;
    try {
      recipe = deps.compileSingleProfile(finalBound, finalBound.profile);
    } catch {
      fail("RECIPE_FAILED");
    }
    const afterRecipe = cancelledOrError(deps, parsedContext);
    if (afterRecipe) return afterRecipe;
    const recipeObject = exactKeys(
      recipe,
      ["solarSail", "stellarLoom", "applicationAppearance", "applicationExtension"],
      ["solarSail", "stellarLoom", "applicationAppearance", "applicationExtension"],
      "RECIPE_OUTPUT_INVALID"
    );
    const solarSail = targetResult(recipeObject.solarSail, "solar-sail", finalBound);
    const stellarLoom = targetResult(recipeObject.stellarLoom, "stellar-loom", finalBound);
    const applicationAppearance = applicationAppearanceResult(recipeObject.applicationAppearance, finalBound);
    const applicationExtension = applicationExtensionResult(recipeObject.applicationExtension, finalBound);
    const allDiagnostics = [...solarSail.diagnostics, ...stellarLoom.diagnostics, ...applicationExtension.diagnostics];
    if (safeJsonBytes(allDiagnostics, "RECIPE_OUTPUT_INVALID") > PAIRED_V2_LIMITS.diagnosticsBytes) fail("RECIPE_OUTPUT_INVALID");
    if (hasFatal(allDiagnostics)) fail("FATAL_DIAGNOSTIC");

    const draft = draftResult(finalBound, parsed, baseline, transformed, sourceBytes);
    const response = {
      status: hasPartialReport(solarSail.mappingReport) || hasPartialReport(stellarLoom.mappingReport)
        ? STATUS.PARTIAL
        : STATUS.SUCCESS,
      valid: true,
      uiRevision: parsed.uiRevision,
      sessionId: parsed.sessionId,
      draft,
      solarSail,
      stellarLoom,
      applicationAppearance,
      applicationExtension,
      diagnostics: allDiagnostics,
    };
    responseBudget(response);
    return response;
  } catch (error) {
    const code = error instanceof ContractFailure ? error.code : "INTERNAL_CONTRACT";
    const status = code === "REVISION_STALE" ? STATUS.STALE : code === "SESSION_MISMATCH" || code === "CANCELLED" ? STATUS.CANCELLED : STATUS.ERROR;
    return failure(status, context, code);
  }
}

export function createPairedV2Compiler(dependencies) {
  const deps = dependencyValue(dependencies);
  return (request) => compilePairedV2(request, deps);
}

export { ContractFailure as PairedV2CompileContractFailure };
