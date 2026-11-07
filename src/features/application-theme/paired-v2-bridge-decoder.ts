import type { PairedProfileV2Document } from "./types";
import { containsForbiddenControlCharacters } from "./paired-v2-edit-contract";
import {
  PAIRED_V2_LIMITS,
  type PairedV2AdapterIdentity,
  type PairedV2ApplicationExtensionResult,
  type PairedV2ApplicationAppearanceResult,
  type PairedV2ApplicationMappingEntry,
  type PairedV2ApplicationMappingReport,
  type PairedV2CompileResponse,
  type PairedV2FailedCompileResponse,
  type PairedV2Diagnostic,
  type PairedV2Draft,
  type PairedV2Error,
  type PairedV2JsonValue,
  type PairedV2MappingDefault,
  type PairedV2MappingEntry,
  type PairedV2MappingGroup,
  type PairedV2MappingReport,
  type PairedV2MappingSummary,
  type PairedV2SaveResponse,
  type PairedV2SuccessfulCompileResponse,
  type PairedV2TargetResult,
} from "./paired-v2-authoring-types";

type UnknownRecord = Record<string, unknown>;

export class PairedV2ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PairedV2ValidationError";
  }
}

const bytes = (value: string): number => new TextEncoder().encode(value).byteLength;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 20_000;

interface JsonTraversalState {
  readonly seen: WeakSet<object>;
  nodes: number;
}

function fail(context: string, detail: string): never {
  throw new PairedV2ValidationError(context + " " + detail);
}

function record(value: unknown, context: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(context, "must be an object");
  }
  return value as UnknownRecord;
}

function exact(
  value: UnknownRecord,
  allowed: readonly string[],
  required: readonly string[],
  context: string
): void {
  const known = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) fail(context, "contains unexpected field " + key);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail(context, "is missing required field " + key);
  }
}

function stringValue(value: unknown, context: string, maxBytes: number = PAIRED_V2_LIMITS.stringValueChars): string {
  if (typeof value !== "string" || value.length === 0) return fail(context, "must be a non-empty string");
  if (bytes(value) > maxBytes) return fail(context, "exceeds its size bound");
  return value;
}

function optionalString(
  object: UnknownRecord,
  key: string,
  context: string,
  maxBytes: number = PAIRED_V2_LIMITS.stringValueChars
): string | undefined {
  return Object.prototype.hasOwnProperty.call(object, key)
    ? stringValue(object[key], context + "." + key, maxBytes)
    : undefined;
}

function booleanValue(value: unknown, context: string): boolean {
  if (typeof value !== "boolean") return fail(context, "must be a boolean");
  return value;
}

function safeRevision(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return fail(context, "must be a non-negative safe integer");
  }
  return value;
}

function hash(value: unknown, context: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    return fail(context, "must be a lowercase SHA-256 digest");
  }
  return value;
}

function traversal(state: JsonTraversalState, value: object, context: string, depth: number): void {
  if (depth > MAX_JSON_DEPTH) fail(context, "exceeds its nesting bound");
  if (state.seen.has(value)) fail(context, "contains a cycle");
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES) fail(context, "exceeds its node bound");
  state.seen.add(value);
}

function defineOwn(object: UnknownRecord, key: string, value: unknown): void {
  Object.defineProperty(object, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
}

function jsonValue(
  value: unknown,
  context: string,
  depth = 0,
  state: JsonTraversalState = { seen: new WeakSet<object>(), nodes: 0 }
): PairedV2JsonValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (containsForbiddenControlCharacters(value)) {
      return fail(context, "contains forbidden untrusted-text control bytes");
    }
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    traversal(state, value, context, depth);
    const result = value.map((entry, index) => jsonValue(entry, context + "[" + index + "]", depth + 1, state));
    state.seen.delete(value);
    return frozen(result);
  }
  if (typeof value === "object" && value !== null) {
    const object = value as UnknownRecord;
    traversal(state, object, context, depth);
    const result = Object.create(null) as { [key: string]: PairedV2JsonValue };
    for (const [key, entry] of Object.entries(object)) {
      if (containsForbiddenControlCharacters(key)) {
        return fail(context, "contains a forbidden object-key control byte");
      }
      defineOwn(result, key, jsonValue(entry, context + "." + key, depth + 1, state));
    }
    state.seen.delete(object);
    return frozen(result);
  }
  return fail(context, "must contain JSON data only");
}

function frozen<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) Object.freeze(value);
  return value;
}

function cloneFrozen<T>(
  value: T,
  depth = 0,
  state: JsonTraversalState = { seen: new WeakSet<object>(), nodes: 0 }
): T {
  if (value === null || typeof value !== "object") return value;
  traversal(state, value, "immutable copy", depth);
  if (Array.isArray(value)) {
    const result = value.map((entry) => cloneFrozen(entry, depth + 1, state)) as T;
    state.seen.delete(value);
    return frozen(result);
  }
  const result = Object.create(null) as UnknownRecord;
  for (const [key, entry] of Object.entries(value as UnknownRecord)) {
    defineOwn(result, key, cloneFrozen(entry, depth + 1, state));
  }
  state.seen.delete(value);
  return frozen(result) as T;
}

export function readonlyJsonClone<T>(value: T): T {
  return cloneFrozen(value);
}

function jsonBytes(value: unknown, context: string): number {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return fail(context, "must be JSON-serializable");
  }
  if (serialized === undefined) return fail(context, "must be JSON-serializable");
  return bytes(serialized);
}

function base64(value: unknown, context: string): string {
  const source = stringValue(value, context, PAIRED_V2_LIMITS.sourceBase64Chars);
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(source) ||
    source.length > PAIRED_V2_LIMITS.sourceBase64Chars
  ) {
    return fail(context, "must be valid base64");
  }
  const padding = source.endsWith("==") ? 2 : source.endsWith("=") ? 1 : 0;
  const decodedBytes = source.length * 3 / 4 - padding;
  if (decodedBytes <= 0 || decodedBytes > PAIRED_V2_LIMITS.sourceBytes) {
    return fail(context, "exceeds the 128 KiB source bound");
  }
  return source;
}

function boundedCss(value: unknown, context: string, maxBytes: number, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined;
  const css = stringValue(value, context, maxBytes);
  if (bytes(css) > maxBytes) return fail(context, "exceeds its byte bound");
  return css;
}

function diagnostic(value: unknown, index: number): PairedV2Diagnostic {
  const context = "diagnostics[" + index + "]";
  const object = record(value, context);
  exact(object, ["severity", "code", "message", "path"], ["severity", "code", "message"], context);
  const severity = object.severity;
  if (severity !== "error" && severity !== "warning" && severity !== "info") {
    return fail(context + ".severity", "is invalid");
  }
  const path = optionalString(object, "path", context);
  const result = {
    severity,
    code: stringValue(object.code, context + ".code", 128),
    message: stringValue(object.message, context + ".message", PAIRED_V2_LIMITS.errorMessageChars),
    ...(path !== undefined ? { path } : {}),
  } satisfies PairedV2Diagnostic;
  return frozen(result);
}

function diagnostics(value: unknown): readonly PairedV2Diagnostic[] {
  if (!Array.isArray(value) || value.length > PAIRED_V2_LIMITS.diagnosticEntries) {
    return fail("diagnostics", "must be a bounded array");
  }
  const result = value.map((entry, index) => diagnostic(entry, index));
  if (jsonBytes(result, "diagnostics") > PAIRED_V2_LIMITS.diagnosticsBytes) {
    return fail("diagnostics", "exceeds its response budget");
  }
  return frozen(result);
}

function errorValue(value: unknown): PairedV2Error {
  const object = record(value, "error");
  exact(object, ["code", "message", "path"], ["code", "message"], "error");
  const path = optionalString(object, "path", "error");
  const result = {
    code: stringValue(object.code, "error.code", 128),
    message: stringValue(object.message, "error.message", PAIRED_V2_LIMITS.errorMessageChars),
    ...(path !== undefined ? { path } : {}),
  } satisfies PairedV2Error;
  return frozen(result);
}

function adapterIdentity(value: unknown, context: string): PairedV2AdapterIdentity {
  const object = record(value, context);
  exact(object, ["name", "version"], ["name", "version"], context);
  return frozen({
    name: stringValue(object.name, context + ".name", 256),
    version: stringValue(object.version, context + ".version", 64),
  });
}

function mappingEntry(value: unknown, index: number): PairedV2MappingEntry {
  const context = "mappingReport.entries[" + index + "]";
  const object = record(value, context);
  exact(
    object,
    ["sourcePath", "sourceValue", "classification", "reason", "targetPath", "targetValue"],
    ["sourcePath", "classification"],
    context
  );
  const classification = object.classification;
  if (
    classification !== "consumed" &&
    classification !== "normalized" &&
    classification !== "overridden" &&
    classification !== "target-specific" &&
    classification !== "unsupported" &&
    classification !== "generated-default"
  ) {
    return fail(context + ".classification", "is invalid");
  }
  const sourceValue = Object.prototype.hasOwnProperty.call(object, "sourceValue")
    ? jsonValue(object.sourceValue, context + ".sourceValue")
    : undefined;
  const targetPath = optionalString(object, "targetPath", context, 256);
  const targetValue = Object.prototype.hasOwnProperty.call(object, "targetValue")
    ? jsonValue(object.targetValue, context + ".targetValue")
    : undefined;
  const reason = optionalString(object, "reason", context, PAIRED_V2_LIMITS.errorMessageChars);
  const result = {
    sourcePath: stringValue(object.sourcePath, context + ".sourcePath", 256),
    classification,
    ...(reason !== undefined ? { reason } : {}),
    ...(sourceValue !== undefined ? { sourceValue } : {}),
    ...(targetPath !== undefined ? { targetPath } : {}),
    ...(targetValue !== undefined ? { targetValue } : {}),
  } satisfies PairedV2MappingEntry;
  return frozen(result);
}

function applicationMappingEntry(value: unknown, index: number): PairedV2ApplicationMappingEntry {
  const context = "applicationExtension.mappingReport.entries[" + index + "]";
  const object = record(value, context);
  exact(object, ["sourcePath", "target", "value"], ["sourcePath", "target", "value"], context);
  return frozen({
    sourcePath: stringValue(object.sourcePath, context + ".sourcePath", 256),
    target: stringValue(object.target, context + ".target", 256),
    value: jsonValue(object.value, context + ".value"),
  });
}

function mappingGroup(value: unknown, index: number): PairedV2MappingGroup {
  const context = "mappingReport.groups[" + index + "]";
  const object = record(value, context);
  exact(object, ["group", "applicable", "reason"], ["group", "applicable", "reason"], context);
  return frozen({
    group: stringValue(object.group, context + ".group", 128),
    applicable: booleanValue(object.applicable, context + ".applicable"),
    reason: stringValue(object.reason, context + ".reason", PAIRED_V2_LIMITS.errorMessageChars),
  });
}

function mappingDefault(value: unknown, index: number): PairedV2MappingDefault {
  const context = "mappingReport.defaults[" + index + "]";
  const object = record(value, context);
  exact(object, ["targetPath", "targetValue", "reason"], ["targetPath", "targetValue", "reason"], context);
  return frozen({
    targetPath: stringValue(object.targetPath, context + ".targetPath", 256),
    targetValue: jsonValue(object.targetValue, context + ".targetValue"),
    reason: stringValue(object.reason, context + ".reason", PAIRED_V2_LIMITS.errorMessageChars),
  });
}

function count(value: unknown, context: string): number {
  const result = safeRevision(value, context);
  if (result > 1_000_000) return fail(context, "is too large");
  return result;
}

function mappingSummary(value: unknown): PairedV2MappingSummary {
  const object = record(value, "mappingReport.summary");
  const fields = [
    "totalSemanticLeaves",
    "consumed",
    "normalized",
    "overridden",
    "targetSpecific",
    "unsupported",
    "generatedDefaultsCount",
  ] as const;
  exact(object, fields, fields, "mappingReport.summary");
  return frozen({
    totalSemanticLeaves: count(object.totalSemanticLeaves, "mappingReport.summary.totalSemanticLeaves"),
    consumed: count(object.consumed, "mappingReport.summary.consumed"),
    normalized: count(object.normalized, "mappingReport.summary.normalized"),
    overridden: count(object.overridden, "mappingReport.summary.overridden"),
    targetSpecific: count(object.targetSpecific, "mappingReport.summary.targetSpecific"),
    unsupported: count(object.unsupported, "mappingReport.summary.unsupported"),
    generatedDefaultsCount: count(object.generatedDefaultsCount, "mappingReport.summary.generatedDefaultsCount"),
  });
}

function engineReport(value: unknown): PairedV2MappingReport {
  const object = record(value, "mappingReport");
  const fields = [
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
  ] as const;
  exact(object, fields, fields, "mappingReport");
  if (object.schema !== "tf-paired-mapping-report-v2") return fail("mappingReport.schema", "is invalid");
  if (object.sourceVerification !== "source-bytes") {
    return fail("mappingReport.sourceVerification", "is invalid");
  }
  if (!Array.isArray(object.entries) || object.entries.length > 4096) {
    return fail("mappingReport.entries", "is unbounded or invalid");
  }
  if (!Array.isArray(object.groups) || object.groups.length > 64) {
    return fail("mappingReport.groups", "is unbounded or invalid");
  }
  if (!Array.isArray(object.defaults) || object.defaults.length > 256) {
    return fail("mappingReport.defaults", "is unbounded or invalid");
  }
  const result: PairedV2MappingReport = {
    schema: "tf-paired-mapping-report-v2",
    target: stringValue(object.target, "mappingReport.target", 64),
    profileName: stringValue(object.profileName, "mappingReport.profileName", 64),
    profileVersion: stringValue(object.profileVersion, "mappingReport.profileVersion", 64),
    sourceSha256: hash(object.sourceSha256, "mappingReport.sourceSha256"),
    sourceVerification: "source-bytes",
    canonicalDigest: hash(object.canonicalDigest, "mappingReport.canonicalDigest"),
    adapter: adapterIdentity(object.adapter, "mappingReport.adapter"),
    compiler: adapterIdentity(object.compiler, "mappingReport.compiler"),
    options: jsonValue(object.options, "mappingReport.options"),
    entries: object.entries.map((entry, index) => mappingEntry(entry, index)),
    groups: object.groups.map((entry, index) => mappingGroup(entry, index)),
    defaults: object.defaults.map((entry, index) => mappingDefault(entry, index)),
    summary: mappingSummary(object.summary),
    digest: hash(object.digest, "mappingReport.digest"),
  };
  if (jsonBytes(result, "mappingReport") > PAIRED_V2_LIMITS.mappingReportBytes) {
    return fail("mappingReport", "exceeds its response budget");
  }
  return frozen(result);
}

function applicationReport(value: unknown): PairedV2ApplicationMappingReport {
  const object = record(value, "applicationExtension.mappingReport");
  exact(object, ["schema", "entries", "scope"], ["schema", "entries", "scope"], "applicationExtension.mappingReport");
  if (object.schema !== "theme-forge.application-appearance-extension.v1") {
    return fail("applicationExtension.mappingReport.schema", "is invalid");
  }
  if (!Array.isArray(object.entries) || object.entries.length > 64) {
    return fail("applicationExtension.mappingReport.entries", "is unbounded or invalid");
  }
  const result: PairedV2ApplicationMappingReport = {
    schema: "theme-forge.application-appearance-extension.v1",
    entries: object.entries.map((entry, index) => applicationMappingEntry(entry, index)),
    scope: stringValue(object.scope, "applicationExtension.mappingReport.scope", PAIRED_V2_LIMITS.errorMessageChars),
  };
  if (jsonBytes(result, "applicationExtension.mappingReport") > PAIRED_V2_LIMITS.mappingReportBytes) {
    return fail("applicationExtension.mappingReport", "exceeds its response budget");
  }
  return frozen(result);
}

function target(value: unknown, context: string): PairedV2TargetResult {
  const object = record(value, context);
  exact(
    object,
    ["valid", "compiledCss", "diagnostics", "mappingReport", "sourceProfileSha256", "canonicalDigest"],
    ["valid", "diagnostics", "mappingReport", "sourceProfileSha256", "canonicalDigest"],
    context
  );
  const valid = booleanValue(object.valid, context + ".valid");
  const compiledCss = boundedCss(
    object.compiledCss,
    context + ".compiledCss",
    PAIRED_V2_LIMITS.targetCssBytes,
    valid
  );
  const result: PairedV2TargetResult = {
    valid,
    ...(compiledCss !== undefined ? { compiledCss } : {}),
    diagnostics: diagnostics(object.diagnostics),
    mappingReport: engineReport(object.mappingReport),
    sourceProfileSha256: hash(object.sourceProfileSha256, context + ".sourceProfileSha256"),
    canonicalDigest: hash(object.canonicalDigest, context + ".canonicalDigest"),
  };
  return frozen(result);
}

function application(value: unknown): PairedV2ApplicationExtensionResult {
  const context = "applicationExtension";
  const object = record(value, context);
  exact(
    object,
    ["valid", "compiledCss", "diagnostics", "mappingReport", "sourceProfileSha256", "canonicalDigest"],
    ["valid", "diagnostics", "mappingReport", "sourceProfileSha256", "canonicalDigest"],
    context
  );
  const valid = booleanValue(object.valid, context + ".valid");
  const compiledCss = boundedCss(
    object.compiledCss,
    context + ".compiledCss",
    PAIRED_V2_LIMITS.applicationExtensionBytes,
    valid
  );
  const report = applicationReport(object.mappingReport);
  if (
    (compiledCss === undefined ? 0 : bytes(compiledCss)) + jsonBytes(report, context + ".mappingReport") >
    PAIRED_V2_LIMITS.applicationExtensionBytes
  ) {
    return fail(context, "exceeds its combined CSS/report budget");
  }
  return frozen({
    valid,
    ...(compiledCss !== undefined ? { compiledCss } : {}),
    diagnostics: diagnostics(object.diagnostics),
    mappingReport: report,
    sourceProfileSha256: hash(object.sourceProfileSha256, context + ".sourceProfileSha256"),
    canonicalDigest: hash(object.canonicalDigest, context + ".canonicalDigest"),
  });
}

function applicationAppearance(value: unknown): PairedV2ApplicationAppearanceResult {
  const context = "applicationAppearance";
  const object = record(value, context);
  exact(object, ["valid", "compiledCss", "sourceProfileSha256", "canonicalDigest"],
    ["valid", "compiledCss", "sourceProfileSha256", "canonicalDigest"], context);
  const compiledCss = boundedCss(object.compiledCss, context + ".compiledCss",
    PAIRED_V2_LIMITS.applicationAppearanceCssBytes, true);
  return frozen({
    valid: booleanValue(object.valid, context + ".valid"),
    compiledCss: compiledCss!,
    sourceProfileSha256: hash(object.sourceProfileSha256, context + ".sourceProfileSha256"),
    canonicalDigest: hash(object.canonicalDigest, context + ".canonicalDigest"),
  });
}

function draftValue(value: unknown): PairedV2Draft {
  const object = record(value, "draft");
  const fields = [
    "profile",
    "sourceBytesBase64",
    "rawSourceSha256",
    "canonicalDigest",
    "baselineRawSourceSha256",
    "baselineCanonicalDigest",
    "verificationStatus",
    "isTransformed",
    "parentSourceSha256",
  ] as const;
  exact(
    object,
    fields,
    [
      "profile",
      "sourceBytesBase64",
      "rawSourceSha256",
      "canonicalDigest",
      "baselineRawSourceSha256",
      "baselineCanonicalDigest",
      "verificationStatus",
      "isTransformed",
    ],
    "draft"
  );
  const profile = record(object.profile, "draft.profile");
  if (profile.schemaVersion !== "tf-paired-profile-v2") return fail("draft.profile.schemaVersion", "is invalid");
  if (jsonBytes(profile, "draft.profile") > PAIRED_V2_LIMITS.profileJsonBytes) {
    return fail("draft.profile", "exceeds its response budget");
  }
  const verificationStatus = object.verificationStatus;
  if (verificationStatus !== "verified" && verificationStatus !== "transformed") {
    return fail("draft.verificationStatus", "is invalid");
  }
  const isTransformed = booleanValue(object.isTransformed, "draft.isTransformed");
  const parentSourceSha256 = Object.prototype.hasOwnProperty.call(object, "parentSourceSha256")
    ? hash(object.parentSourceSha256, "draft.parentSourceSha256")
    : undefined;
  if (verificationStatus === "transformed" && (!isTransformed || parentSourceSha256 === undefined)) {
    return fail("draft", "transformed drafts require isTransformed and parentSourceSha256");
  }
  if (verificationStatus === "verified" && (isTransformed || parentSourceSha256 !== undefined)) {
    return fail("draft", "verified drafts cannot carry transformed ancestry");
  }
  const sourceBytesBase64 = base64(object.sourceBytesBase64, "draft.sourceBytesBase64");
  const rawSourceSha256 = hash(object.rawSourceSha256, "draft.rawSourceSha256");
  const canonicalDigest = hash(object.canonicalDigest, "draft.canonicalDigest");
  const baselineRawSourceSha256 = hash(object.baselineRawSourceSha256, "draft.baselineRawSourceSha256");
  const baselineCanonicalDigest = hash(object.baselineCanonicalDigest, "draft.baselineCanonicalDigest");
  if (
    verificationStatus === "verified" &&
    (rawSourceSha256 !== baselineRawSourceSha256 || canonicalDigest !== baselineCanonicalDigest)
  ) {
    return fail("draft", "verified drafts must retain their baseline identities");
  }
  if (verificationStatus === "transformed" && parentSourceSha256 === rawSourceSha256) {
    return fail("draft", "transformed drafts cannot self-parent");
  }
  const result: PairedV2Draft = {
    profile: cloneFrozen(profile) as unknown as PairedProfileV2Document,
    sourceBytesBase64,
    rawSourceSha256,
    canonicalDigest,
    baselineRawSourceSha256,
    baselineCanonicalDigest,
    verificationStatus,
    isTransformed,
    ...(parentSourceSha256 !== undefined ? { parentSourceSha256 } : {}),
  };
  return frozen(result);
}

export function hasFatalPairedV2Diagnostics(response: PairedV2SuccessfulCompileResponse): boolean {
  const fatal = (items: readonly PairedV2Diagnostic[]): boolean =>
    items.some((item) => item.severity === "error");
  return (
    fatal(response.diagnostics) ||
    fatal(response.solarSail.diagnostics) ||
    fatal(response.stellarLoom.diagnostics) ||
    fatal(response.applicationExtension.diagnostics)
  );
}

export interface PairedV2CompileDecodeOptions {
  readonly expectedSessionId?: string;
  readonly expectedUiRevision?: number;
}

export function decodePairedV2CompileResponse(
  value: unknown,
  options: PairedV2CompileDecodeOptions = {}
): PairedV2CompileResponse {
  if (jsonBytes(value, "compile response") > PAIRED_V2_LIMITS.responseBytes) {
    return fail("compile response", "exceeds its 2 MiB budget");
  }
  const object = record(value, "compile response");
  const fields = [
    "status",
    "valid",
    "uiRevision",
    "sessionId",
    "draft",
    "solarSail",
    "stellarLoom",
    "applicationExtension",
    "applicationAppearance",
    "diagnostics",
    "error",
  ] as const;
  exact(
    object,
    fields,
    ["status", "valid", "uiRevision", "sessionId", "solarSail", "stellarLoom", "applicationExtension", "applicationAppearance", "diagnostics"],
    "compile response"
  );
  const status = object.status;
  if (status !== "success" && status !== "partial" && status !== "stale" && status !== "cancelled" && status !== "error") {
    return fail("compile response.status", "is invalid");
  }
  const valid = booleanValue(object.valid, "compile response.valid");
  const uiRevision = safeRevision(object.uiRevision, "compile response.uiRevision");
  const sessionId = stringValue(object.sessionId, "compile response.sessionId", 128);
  if (options.expectedSessionId !== undefined && sessionId !== options.expectedSessionId) {
    return fail("compile response.sessionId", "does not match the active session");
  }
  if (options.expectedUiRevision !== undefined && uiRevision !== options.expectedUiRevision) {
    return fail("compile response.uiRevision", "does not match the requested revision");
  }
  const responseDiagnostics = diagnostics(object.diagnostics);
  if (status === "stale" || status === "cancelled" || status === "error") {
    if (valid) return fail("compile response", status + " replies must be invalid");
    if (Object.prototype.hasOwnProperty.call(object, "draft")) {
      return fail("compile response", status + " replies cannot contain a draft");
    }
    if (object.solarSail !== null || object.stellarLoom !== null || object.applicationExtension !== null || object.applicationAppearance !== null) {
      return fail("compile response", status + " replies require null target results");
    }
    const failure: PairedV2FailedCompileResponse = {
      status,
      valid: false,
      uiRevision,
      sessionId,
      solarSail: null,
      stellarLoom: null,
      applicationExtension: null,
      applicationAppearance: null,
      diagnostics: responseDiagnostics,
      ...(Object.prototype.hasOwnProperty.call(object, "error") ? { error: errorValue(object.error) } : {}),
    };
    return frozen(failure);
  }
  if (!valid) return fail("compile response", status + " replies must be valid");
  if (!Object.prototype.hasOwnProperty.call(object, "draft")) {
    return fail("compile response", status + " replies require a draft");
  }
  if (Object.prototype.hasOwnProperty.call(object, "error")) {
    return fail("compile response", status + " replies cannot contain an error");
  }
  const draft = draftValue(object.draft);
  const solarSail = target(object.solarSail, "solarSail");
  const stellarLoom = target(object.stellarLoom, "stellarLoom");
  const applicationExtension = application(object.applicationExtension);
  const appearance = applicationAppearance(object.applicationAppearance);
  const result: PairedV2SuccessfulCompileResponse = {
    status,
    valid: true,
    uiRevision,
    sessionId,
    draft,
    solarSail,
    stellarLoom,
    applicationExtension,
    applicationAppearance: appearance,
    diagnostics: responseDiagnostics,
  };
  for (const targetResult of [solarSail, stellarLoom, applicationExtension, appearance]) {
    if (
      targetResult.sourceProfileSha256 !== draft.rawSourceSha256 ||
      targetResult.canonicalDigest !== draft.canonicalDigest
    ) {
      return fail("compile response", "target identity does not match the returned draft");
    }
  }
  if (!solarSail.valid || !stellarLoom.valid || !applicationExtension.valid || !appearance.valid) {
    return fail("compile response", status + " replies require all target results to be valid");
  }
  for (const [targetResult, expectedTarget] of [[solarSail, "solar-sail"], [stellarLoom, "stellar-loom"]] as const) {
    const report = targetResult.mappingReport;
    if (report.target !== expectedTarget ||
        report.sourceSha256 !== draft.rawSourceSha256 ||
        report.canonicalDigest !== draft.canonicalDigest ||
        report.profileName !== draft.profile.name ||
        report.profileVersion !== draft.profile.version) {
      return fail("compile response", "mapping report identity does not match its target and draft");
    }
  }
  if (hasFatalPairedV2Diagnostics(result)) {
    return fail("compile response", status + " replies cannot contain fatal diagnostics");
  }
  return frozen(result);
}

export function decodePairedV2SaveResponse(
  value: unknown,
  options: PairedV2CompileDecodeOptions = {}
): PairedV2SaveResponse {
  if (jsonBytes(value, "save response") > PAIRED_V2_LIMITS.responseBytes) {
    return fail("save response", "exceeds its 2 MiB budget");
  }
  const object = record(value, "save response");
  exact(
    object,
    ["cancelled", "saved", "sessionId", "uiRevision", "document", "error"],
    ["cancelled", "saved", "sessionId", "uiRevision"],
    "save response"
  );
  const sessionId = stringValue(object.sessionId, "save response.sessionId", 128);
  const uiRevision = safeRevision(object.uiRevision, "save response.uiRevision");
  if (options.expectedSessionId !== undefined && sessionId !== options.expectedSessionId) {
    return fail("save response.sessionId", "does not match the active session");
  }
  if (options.expectedUiRevision !== undefined && uiRevision !== options.expectedUiRevision) {
    return fail("save response.uiRevision", "does not match the requested revision");
  }
  const documentObject = Object.prototype.hasOwnProperty.call(object, "document")
    ? record(object.document, "save response.document")
    : undefined;
  const document =
    documentObject === undefined
      ? undefined
      : (() => {
          exact(
            documentObject,
            ["documentId", "rawSourceSha256", "canonicalDigest", "displayName"],
            ["documentId", "rawSourceSha256", "canonicalDigest", "displayName"],
            "save response.document"
          );
          return frozen({
            documentId: stringValue(documentObject.documentId, "save response.document.documentId", 256),
            rawSourceSha256: hash(documentObject.rawSourceSha256, "save response.document.rawSourceSha256"),
            canonicalDigest: hash(documentObject.canonicalDigest, "save response.document.canonicalDigest"),
            displayName: stringValue(documentObject.displayName, "save response.document.displayName", 256),
          });
        })();
  const result: PairedV2SaveResponse = {
    cancelled: booleanValue(object.cancelled, "save response.cancelled"),
    saved: booleanValue(object.saved, "save response.saved"),
    sessionId,
    uiRevision,
    ...(document !== undefined ? { document } : {}),
    ...(Object.prototype.hasOwnProperty.call(object, "error") ? { error: errorValue(object.error) } : {}),
  };
  if (result.saved && result.cancelled) return fail("save response", "cannot be both saved and cancelled");
  if (result.saved && (result.document === undefined || result.error !== undefined)) {
    return fail("save response", "saved replies require a document and no error");
  }
  if (!result.saved && result.document !== undefined) return fail("save response", "unsaved replies cannot contain a document");
  if (result.cancelled && result.error !== undefined) return fail("save response", "cancelled replies cannot contain an error");
  if (!result.saved && !result.cancelled && result.error === undefined) {
    return fail("save response", "failed replies require an error");
  }
  return frozen(result);
}
