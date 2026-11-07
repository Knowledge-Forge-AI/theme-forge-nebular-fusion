import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import {
  decodePairedV2CompileResponse,
  decodePairedV2SaveResponse,
  PairedV2ValidationError,
  readonlyJsonClone,
} from "./paired-v2-bridge-decoder";
import {
  PAIRED_V2_LIMITS,
  type PairedV2CompileRequest,
  type PairedV2CompileResponse,
  type PairedV2Edit,
  type PairedV2SaveRequest,
  type PairedV2SaveResponse,
  type PairedV2SourceReference,
} from "./paired-v2-authoring-types";
import {
  containsForbiddenControlCharacters,
  isPairedV2ApplicationColorValue,
  isPairedV2ApplicationRadiusValue,
  isPairedV2ApplicationTypographyValue,
  isPairedV2ClearOptionalPath,
  isPairedV2ColorPath,
  isPairedV2RadiusPath,
  isPairedV2TypographyPath,
} from "./paired-v2-edit-contract";

export const PAIRED_V2_NATIVE_COMMANDS = Object.freeze({
  compile: "studio_app_theme_paired_compile_v2",
  save: "studio_app_theme_save_profile_v2",
} as const);

export type PairedV2NativeInvoke = <T>(
  command: string,
  args: { readonly request: unknown }
) => Promise<T>;

export type PairedV2NativeBridgeErrorCode =
  | "invalid-request"
  | "invalid-response"
  | "native-rejected";

/**
 * The bridge deliberately does not carry native exception text across the UI boundary.
 * Native session/revision decisions are represented by the decoded closed response;
 * malformed replies and invocation failures use only these stable labels.
 */
export class PairedV2NativeBridgeError extends Error {
  readonly code: PairedV2NativeBridgeErrorCode;

  constructor(code: PairedV2NativeBridgeErrorCode) {
    super(
      code === "invalid-request"
        ? "Paired v2 request rejected before native invocation"
        : code === "invalid-response"
          ? "Paired v2 native response rejected"
          : "Paired v2 native operation was not completed"
    );
    this.name = "PairedV2NativeBridgeError";
    this.code = code;
  }
}

export interface PairedV2NativeBridge {
  compileV2(request: PairedV2CompileRequest): Promise<PairedV2CompileResponse>;
  saveV2(request: PairedV2SaveRequest): Promise<PairedV2SaveResponse>;
}

const defaultInvoke: PairedV2NativeInvoke = <T>(
  command: string,
  args: { readonly request: unknown }
): Promise<T> => tauriInvoke<T>(command, args);

const PAIRED_V2_MAX_HEX_VALUE_BYTES = 9;
const PAIRED_V2_MAX_EXPLICIT_LENGTH_BYTES = 64;
const PAIRED_V2_MAX_FONT_FAMILY_ITEM_BYTES = 100;
const PAIRED_V2_MAX_LINE_HEIGHT = 10;

type UnknownRecord = Record<string, unknown>;

function failRequest(): never {
  throw new PairedV2NativeBridgeError("invalid-request");
}

function objectValue(value: unknown): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return failRequest();
  return value as UnknownRecord;
}

function has(object: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function exact(object: UnknownRecord, allowed: readonly string[], required: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(object)) {
    if (!allowedSet.has(key)) failRequest();
  }
  for (const key of required) {
    if (!has(object, key)) failRequest();
  }
}

function stringValue(value: unknown, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0) return failRequest();
  if (containsForbiddenControlCharacters(value)) return failRequest();
  if (new TextEncoder().encode(value).byteLength > maxBytes) return failRequest();
  return value;
}

function boundedText(value: unknown, maxBytes: number): string {
  const text = stringValue(value, maxBytes);
  if (/[{};]/u.test(text)) return failRequest();
  return text;
}

function fontStackValue(value: unknown): string {
  const fontStack = boundedText(value, PAIRED_V2_LIMITS.stringValueChars);
  if (fontStack.split(",").some((item) => new TextEncoder().encode(item).byteLength > PAIRED_V2_MAX_FONT_FAMILY_ITEM_BYTES)) {
    return failRequest();
  }
  return fontStack;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) return failRequest();
  return value;
}

function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return failRequest();
  return value;
}

function sourceBase64(value: unknown): string {
  const result = stringValue(value, PAIRED_V2_LIMITS.sourceBase64Chars);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result)) {
    return failRequest();
  }
  const padding = result.endsWith("==") ? 2 : result.endsWith("=") ? 1 : 0;
  const decodedBytes = result.length * 3 / 4 - padding;
  if (decodedBytes <= 0 || decodedBytes > PAIRED_V2_LIMITS.sourceBytes) return failRequest();
  return result;
}

function requestBytes(value: unknown): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return failRequest();
  }
  if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > PAIRED_V2_LIMITS.responseBytes) {
    return failRequest();
  }
}

function sourceReference(value: unknown): PairedV2SourceReference {
  const source = objectValue(value);
  if (has(source, "documentId")) {
    exact(source, ["documentId", "expectedRawSourceSha256", "expectedCanonicalDigest"], [
      "documentId",
      "expectedRawSourceSha256",
      "expectedCanonicalDigest",
    ]);
    return Object.freeze({
      documentId: stringValue(source.documentId, 256),
      expectedRawSourceSha256: digest(source.expectedRawSourceSha256),
      expectedCanonicalDigest: digest(source.expectedCanonicalDigest),
    });
  }
  exact(source, ["rawSourceBase64", "expectedRawSourceSha256", "expectedCanonicalDigest"], [
    "rawSourceBase64",
    "expectedRawSourceSha256",
    "expectedCanonicalDigest",
  ]);
  return Object.freeze({
    rawSourceBase64: sourceBase64(source.rawSourceBase64),
    expectedRawSourceSha256: digest(source.expectedRawSourceSha256),
    expectedCanonicalDigest: digest(source.expectedCanonicalDigest),
  });
}

function validateDraftLineage(
  response: PairedV2CompileResponse,
  request: PairedV2CompileRequest
): void {
  if (!response.valid) return;
  const draft = response.draft;
  const expectedRaw = request.source.expectedRawSourceSha256;
  const expectedCanonical = request.source.expectedCanonicalDigest;
  if (
    draft.baselineRawSourceSha256 !== expectedRaw ||
    draft.baselineCanonicalDigest !== expectedCanonical
  ) {
    throw new PairedV2NativeBridgeError("invalid-response");
  }
  if (draft.verificationStatus === "verified") {
    if (
      draft.isTransformed ||
      draft.parentSourceSha256 !== undefined ||
      draft.rawSourceSha256 !== expectedRaw ||
      draft.canonicalDigest !== expectedCanonical
    ) {
      throw new PairedV2NativeBridgeError("invalid-response");
    }
    if (
      "rawSourceBase64" in request.source &&
      draft.sourceBytesBase64 !== request.source.rawSourceBase64
    ) {
      throw new PairedV2NativeBridgeError("invalid-response");
    }
    return;
  }
  if (
    !draft.isTransformed ||
    request.edits.length === 0 ||
    draft.parentSourceSha256 !== expectedRaw ||
    draft.rawSourceSha256 === expectedRaw
  ) {
    throw new PairedV2NativeBridgeError("invalid-response");
  }
}

function typographyValue(path: string, value: unknown): string | number {
  if (path.endsWith(".family")) {
    const family = fontStackValue(value);
    if (!isPairedV2ApplicationTypographyValue(path, family)) return failRequest();
    return family;
  }
  if (path.endsWith(".size")) return boundedText(value, PAIRED_V2_MAX_EXPLICIT_LENGTH_BYTES);
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > PAIRED_V2_MAX_LINE_HEIGHT ||
    Math.abs(value) > 100_000
  ) return failRequest();
  return value;
}

function editValueObject(value: unknown): PairedV2Edit {
  const edit = objectValue(value);
  const kind = edit.kind;
  const path = stringValue(edit.path, 256);
  if (kind === "set-color") {
    exact(edit, ["kind", "path", "value"], ["kind", "path", "value"]);
    if (!isPairedV2ColorPath(path)) return failRequest();
    const color = boundedText(edit.value, PAIRED_V2_MAX_HEX_VALUE_BYTES);
    if (!isPairedV2ApplicationColorValue(path, color)) return failRequest();
    return Object.freeze({ kind, path, value: color });
  }
  if (kind === "set-typography") {
    exact(edit, ["kind", "path", "value"], ["kind", "path", "value"]);
    if (!isPairedV2TypographyPath(path)) return failRequest();
    const typography = typographyValue(path, edit.value);
    return Object.freeze({ kind, path, value: typography });
  }
  if (kind === "set-radius") {
    exact(edit, ["kind", "path", "value"], ["kind", "path", "value"]);
    if (!isPairedV2RadiusPath(path)) return failRequest();
    const radius = boundedText(edit.value, PAIRED_V2_MAX_EXPLICIT_LENGTH_BYTES);
    if (!isPairedV2ApplicationRadiusValue(path, radius)) return failRequest();
    return Object.freeze({ kind, path, value: radius });
  }
  if (kind === "clear-optional") {
    exact(edit, ["kind", "path"], ["kind", "path"]);
    if (!isPairedV2ClearOptionalPath(path)) return failRequest();
    return Object.freeze({ kind, path });
  }
  return failRequest();
}

function edits(value: unknown): readonly PairedV2Edit[] {
  if (!Array.isArray(value) || value.length > PAIRED_V2_LIMITS.editEntries) return failRequest();
  const result: PairedV2Edit[] = [];
  let previousPath: string | undefined;
  for (const entry of value) {
    const edit = editValueObject(entry);
    if (previousPath !== undefined && previousPath >= edit.path) return failRequest();
    previousPath = edit.path;
    result.push(edit);
  }
  return Object.freeze(result);
}

function cloneInput(value: unknown): unknown {
  try {
    return readonlyJsonClone(value);
  } catch {
    return failRequest();
  }
}

function validateCompileRequest(value: unknown): PairedV2CompileRequest {
  const copy = objectValue(cloneInput(value));
  exact(copy, ["source", "edits", "uiRevision", "sessionId"], ["source", "edits", "uiRevision", "sessionId"]);
  const request: PairedV2CompileRequest = Object.freeze({
    source: sourceReference(copy.source),
    edits: edits(copy.edits),
    uiRevision: revision(copy.uiRevision),
    sessionId: stringValue(copy.sessionId, 128),
  });
  requestBytes(request);
  return request;
}

function validateSaveRequest(value: unknown): PairedV2SaveRequest {
  const copy = objectValue(cloneInput(value));
  exact(
    copy,
    [
      "sessionId",
      "documentId",
      "draftSourceBase64",
      "expectedDraftRawSourceSha256",
      "expectedCanonicalDigest",
      "expectedParentSourceSha256",
      "expectedCompileRawSourceSha256",
      "expectedCompileCanonicalDigest",
      "expectedCompileUiRevision",
      "saveMode",
      "uiRevision",
    ],
    [
      "sessionId",
      "draftSourceBase64",
      "expectedDraftRawSourceSha256",
      "expectedCanonicalDigest",
      "expectedCompileRawSourceSha256",
      "expectedCompileCanonicalDigest",
      "expectedCompileUiRevision",
      "saveMode",
      "uiRevision",
    ]
  );
  const mode = copy.saveMode;
  if (mode !== "edited" && mode !== "new-document") return failRequest();
  if (mode === "edited") {
    if (!has(copy, "documentId") || !has(copy, "expectedParentSourceSha256")) return failRequest();
  } else if (has(copy, "documentId") || has(copy, "expectedParentSourceSha256")) {
    return failRequest();
  }
  const request: PairedV2SaveRequest = Object.freeze({
    sessionId: stringValue(copy.sessionId, 128),
    ...(mode === "edited"
      ? {
          documentId: stringValue(copy.documentId, 256),
          expectedParentSourceSha256: digest(copy.expectedParentSourceSha256),
        }
      : {}),
    draftSourceBase64: sourceBase64(copy.draftSourceBase64),
    expectedDraftRawSourceSha256: digest(copy.expectedDraftRawSourceSha256),
    expectedCanonicalDigest: digest(copy.expectedCanonicalDigest),
    expectedCompileRawSourceSha256: digest(copy.expectedCompileRawSourceSha256),
    expectedCompileCanonicalDigest: digest(copy.expectedCompileCanonicalDigest),
    expectedCompileUiRevision: revision(copy.expectedCompileUiRevision),
    saveMode: mode,
    uiRevision: revision(copy.uiRevision),
  });
  if (request.expectedCompileRawSourceSha256 !== request.expectedDraftRawSourceSha256 ||
      request.expectedCompileCanonicalDigest !== request.expectedCanonicalDigest ||
      request.expectedCompileUiRevision !== request.uiRevision) return failRequest();
  requestBytes(request);
  return request;
}

export class TauriPairedV2NativeBridge implements PairedV2NativeBridge {
  private readonly invokeFn: PairedV2NativeInvoke;

  constructor(invokeFn: PairedV2NativeInvoke = defaultInvoke) {
    this.invokeFn = invokeFn;
  }

  async compileV2(request: PairedV2CompileRequest): Promise<PairedV2CompileResponse> {
    const checked = validateCompileRequest(request);
    let raw: unknown;
    try {
      raw = await this.invokeFn<unknown>(PAIRED_V2_NATIVE_COMMANDS.compile, { request: checked });
    } catch {
      throw new PairedV2NativeBridgeError("native-rejected");
    }
    try {
      const response = decodePairedV2CompileResponse(raw, {
        expectedSessionId: checked.sessionId,
        expectedUiRevision: checked.uiRevision,
      });
      validateDraftLineage(response, checked);
      return response;
    } catch (error) {
      if (error instanceof PairedV2ValidationError) {
        throw new PairedV2NativeBridgeError("invalid-response");
      }
      throw new PairedV2NativeBridgeError("invalid-response");
    }
  }

  async saveV2(request: PairedV2SaveRequest): Promise<PairedV2SaveResponse> {
    const checked = validateSaveRequest(request);
    let raw: unknown;
    try {
      raw = await this.invokeFn<unknown>(PAIRED_V2_NATIVE_COMMANDS.save, { request: checked });
    } catch {
      throw new PairedV2NativeBridgeError("native-rejected");
    }
    try {
      const result = decodePairedV2SaveResponse(raw, {
        expectedSessionId: checked.sessionId,
        expectedUiRevision: checked.uiRevision,
      });
      if (result.saved && (
        result.document?.rawSourceSha256 !== checked.expectedDraftRawSourceSha256 ||
        result.document?.canonicalDigest !== checked.expectedCanonicalDigest ||
        (checked.saveMode === "edited" && result.document?.documentId !== checked.documentId)
      )) throw new PairedV2NativeBridgeError("invalid-response");
      return result;
    } catch {
      throw new PairedV2NativeBridgeError("invalid-response");
    }
  }
}

