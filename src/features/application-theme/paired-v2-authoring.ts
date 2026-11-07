import {
  decodePairedV2CompileResponse,
  readonlyJsonClone,
  hasFatalPairedV2Diagnostics,
} from "./paired-v2-bridge-decoder";
import {
  PAIRED_V2_LIMITS,
  type PairedV2AuthoringSnapshot,
  type PairedV2Baseline,
  type PairedV2ClearOptionalEdit,
  type PairedV2CompileAcceptance,
  type PairedV2CompileRequest,
  type PairedV2CompileResponse,
  type PairedV2CompileTicket,
  type PairedV2Edit,
  type PairedV2EditMap,
  type PairedV2PreviewAck,
  type PairedV2SaveEligibility,
  type PairedV2SaveRequest,
  type PairedV2SetColorEdit,
  type PairedV2SetRadiusEdit,
  type PairedV2SetTypographyEdit,
  type PairedV2SourceReference,
  type PairedV2SuccessfulCompileResponse,
} from "./paired-v2-authoring-types";
import {
  isPairedV2ApplicationColorValue,
  isPairedV2ApplicationRadiusValue,
  isPairedV2ApplicationTypographyValue,
  isPairedV2ClearOptionalPath,
  isPairedV2ColorPath,
  isPairedV2RadiusPath,
  isPairedV2TypographyPath,
} from "./paired-v2-edit-contract";

export interface PairedV2DocumentBaselineInput {
  readonly sourceKind: "document";
  readonly documentId: string;
  readonly rawSourceSha256: string;
  readonly canonicalDigest: string;
}

export interface PairedV2DetachedBaselineInput {
  readonly sourceKind: "detached";
  readonly rawSourceBase64: string;
  readonly rawSourceSha256: string;
  readonly canonicalDigest: string;
}

export type PairedV2BaselineInput = PairedV2DocumentBaselineInput | PairedV2DetachedBaselineInput;

function fail(message: string): never {
  throw new Error("PairedV2AuthoringError: " + message);
}

function ensureString(value: string, name: string, maxBytes = 512): string {
  if (typeof value !== "string" || value.length === 0) fail(name + " must be a non-empty string");
  if (new TextEncoder().encode(value).byteLength > maxBytes) fail(name + " exceeds its size bound");
  return value;
}

function ensureHash(value: string, name: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) fail(name + " must be a lowercase SHA-256 digest");
  return value;
}

function ensureBase64(value: string): string {
  ensureString(value, "rawSourceBase64", PAIRED_V2_LIMITS.sourceBase64Chars);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    fail("rawSourceBase64 must be valid base64");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const decodedBytes = value.length * 3 / 4 - padding;
  if (decodedBytes <= 0 || decodedBytes > PAIRED_V2_LIMITS.sourceBytes) {
    fail("rawSourceBase64 exceeds the 128 KiB source bound");
  }
  return value;
}

function ensureEditValue(value: string | number, name: string): string | number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value) > 100_000) fail(name + " must be a finite bounded number");
    return value;
  }
  return ensureString(value, name, PAIRED_V2_LIMITS.stringValueChars);
}

function exactEditKeys(edit: object, expected: readonly string[]): void {
  const allowed = new Set(expected);
  for (const key of Object.keys(edit)) {
    if (!allowed.has(key)) fail("edit contains unsupported field " + key);
  }
}

function normalizeEdit(edit: PairedV2Edit): PairedV2Edit {
  if (typeof edit !== "object" || edit === null) fail("edit must be an object");
  if (edit.kind === "set-color") {
    exactEditKeys(edit, ["kind", "path", "value"]);
    if (!isPairedV2ColorPath(edit.path)) fail("set-color path is not in the closed color grammar");
    const color = ensureString(edit.value, "set-color.value", PAIRED_V2_LIMITS.stringValueChars);
    if (!isPairedV2ApplicationColorValue(edit.path, color)) {
      fail("set-color value is not accepted by the application extension grammar");
    }
    const result: PairedV2SetColorEdit = {
      kind: "set-color",
      path: edit.path,
      value: color,
    };
    return Object.freeze(result);
  }
  if (edit.kind === "set-typography") {
    exactEditKeys(edit, ["kind", "path", "value"]);
    if (!isPairedV2TypographyPath(edit.path)) fail("set-typography path is not in the closed typography grammar");
    const typography = ensureEditValue(edit.value, "set-typography.value");
    if (!isPairedV2ApplicationTypographyValue(edit.path, typography)) {
      fail("set-typography value is not accepted by the application extension grammar");
    }
    const result: PairedV2SetTypographyEdit = {
      kind: "set-typography",
      path: edit.path,
      value: typography,
    };
    return Object.freeze(result);
  }
  if (edit.kind === "set-radius") {
    exactEditKeys(edit, ["kind", "path", "value"]);
    if (!isPairedV2RadiusPath(edit.path)) fail("set-radius path is not in the closed radius grammar");
    const radius = ensureString(edit.value, "set-radius.value", PAIRED_V2_LIMITS.stringValueChars);
    if (!isPairedV2ApplicationRadiusValue(edit.path, radius)) {
      fail("set-radius value is not accepted by the application extension grammar");
    }
    const result: PairedV2SetRadiusEdit = {
      kind: "set-radius",
      path: edit.path,
      value: radius,
    };
    return Object.freeze(result);
  }
  if (edit.kind === "clear-optional") {
    exactEditKeys(edit, ["kind", "path"]);
    if (!isPairedV2ClearOptionalPath(edit.path)) fail("clear-optional path is not optional in the closed grammar");
    const result: PairedV2ClearOptionalEdit = { kind: "clear-optional", path: edit.path };
    return Object.freeze(result);
  }
  fail("edit kind is not supported");
}

function equalEdit(left: PairedV2Edit | undefined, right: PairedV2Edit): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

function closedBaselineObject(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    fail("baseline must be an object");
  }
  return input as Record<string, unknown>;
}

function closedBaselineKeys(object: Record<string, unknown>, expected: readonly string[]): void {
  const allowed = new Set(expected);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) fail("baseline contains unsupported field " + key);
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) fail("baseline is missing field " + key);
  }
}

function baselineFrom(input: PairedV2BaselineInput): PairedV2Baseline {
  const object = closedBaselineObject(input);
  if (object.sourceKind === "document") {
    closedBaselineKeys(object, ["sourceKind", "documentId", "rawSourceSha256", "canonicalDigest"]);
    return Object.freeze({
      sourceKind: "document",
      documentId: ensureString(object.documentId as string, "documentId", 256),
      rawSourceSha256: ensureHash(object.rawSourceSha256 as string, "rawSourceSha256"),
      canonicalDigest: ensureHash(object.canonicalDigest as string, "canonicalDigest"),
    });
  }
  if (object.sourceKind !== "detached") fail("baseline sourceKind is unsupported");
  closedBaselineKeys(object, ["sourceKind", "rawSourceBase64", "rawSourceSha256", "canonicalDigest"]);
  return Object.freeze({
    sourceKind: "detached",
    rawSourceBase64: ensureBase64(object.rawSourceBase64 as string),
    rawSourceSha256: ensureHash(object.rawSourceSha256 as string, "rawSourceSha256"),
    canonicalDigest: ensureHash(object.canonicalDigest as string, "canonicalDigest"),
  });
}

function sourceFor(baseline: PairedV2Baseline): PairedV2SourceReference {
  if (baseline.sourceKind === "document") {
    return {
      documentId: baseline.documentId,
      expectedRawSourceSha256: baseline.rawSourceSha256,
      expectedCanonicalDigest: baseline.canonicalDigest,
    };
  }
  return {
    rawSourceBase64: baseline.rawSourceBase64,
    expectedRawSourceSha256: baseline.rawSourceSha256,
    expectedCanonicalDigest: baseline.canonicalDigest,
  };
}

function cloneEdits(edits: ReadonlyMap<string, PairedV2Edit>): readonly PairedV2Edit[] {
  const result = Array.from(edits.values())
    .map((edit) => normalizeEdit(edit))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return Object.freeze(result);
}

function cloneEditMap(edits: ReadonlyMap<string, PairedV2Edit>): PairedV2EditMap {
  const result: Record<string, PairedV2Edit> = {};
  for (const [path, edit] of edits) result[path] = normalizeEdit(edit);
  return Object.freeze(result);
}

function cloneAck(ack: PairedV2PreviewAck): PairedV2PreviewAck {
  return Object.freeze({
    preview: ack.preview,
    sessionId: ack.sessionId,
    uiRevision: ack.uiRevision,
    rawSourceSha256: ack.rawSourceSha256,
    canonicalDigest: ack.canonicalDigest,
    frameId: ack.frameId,
  });
}

export class PairedV2AuthoringSession {
  private sessionId: string;
  private revision = 0;
  private baseline: PairedV2Baseline | undefined;
  private readonly edits = new Map<string, PairedV2Edit>();
  private readonly ticketRecords = new WeakMap<object, { readonly sessionId: string; readonly uiRevision: number }>();
  private pendingTicket: PairedV2CompileTicket | undefined;
  private latestSuccessful: PairedV2SuccessfulCompileResponse | undefined;
  private applicationAck: PairedV2PreviewAck | undefined;
  private starlightAck: PairedV2PreviewAck | undefined;

  constructor(sessionId: string, baseline?: PairedV2BaselineInput) {
    this.sessionId = ensureString(sessionId, "sessionId", 128);
    if (baseline !== undefined) this.baseline = baselineFrom(baseline);
  }

  openDocument(input: Omit<PairedV2DocumentBaselineInput, "sourceKind">): void {
    this.openBaseline({ sourceKind: "document", ...input });
  }

  openDetachedSource(input: Omit<PairedV2DetachedBaselineInput, "sourceKind">): void {
    this.openBaseline({ sourceKind: "detached", ...input });
  }

  openBaseline(input: PairedV2BaselineInput): void {
    if (this.baseline !== undefined) fail("rebase requires an explicit reset or reopen");
    this.baseline = baselineFrom(input);
    this.clearTransientState();
  }

  private clearTransientState(): void {
    this.edits.clear();
    this.pendingTicket = undefined;
    this.latestSuccessful = undefined;
    this.applicationAck = undefined;
    this.starlightAck = undefined;
    this.revision = 0;
  }

  reset(nextSessionId = this.sessionId): void {
    this.sessionId = ensureString(nextSessionId, "sessionId", 128);
    this.baseline = undefined;
    this.clearTransientState();
  }

  setEdit(edit: PairedV2Edit): number {
    if (this.baseline === undefined) fail("a baseline must be open before editing");
    const normalized = normalizeEdit(edit);
    if (equalEdit(this.edits.get(normalized.path), normalized)) return this.revision;
    if (!this.edits.has(normalized.path) && this.edits.size >= PAIRED_V2_LIMITS.editEntries) {
      fail("edit map exceeds its 64-entry bound");
    }
    this.edits.set(normalized.path, normalized);
    this.revision = this.nextRevision();
    this.pendingTicket = undefined;
    this.clearAcks();
    return this.revision;
  }

  setEdits(edits: readonly PairedV2Edit[]): number {
    if (this.baseline === undefined) fail("a baseline must be open before editing");
    if (edits.length > PAIRED_V2_LIMITS.editEntries) fail("edit map exceeds its 64-entry bound");
    const next = new Map<string, PairedV2Edit>();
    for (const edit of edits) {
      const normalized = normalizeEdit(edit);
      next.set(normalized.path, normalized);
    }
    if (next.size > PAIRED_V2_LIMITS.editEntries) fail("edit map exceeds its 64-entry bound");
    this.edits.clear();
    for (const [path, edit] of next) this.edits.set(path, edit);
    this.revision = this.nextRevision();
    this.pendingTicket = undefined;
    this.clearAcks();
    return this.revision;
  }

  removeEdit(path: string): number {
    if (!this.edits.has(path)) return this.revision;
    this.edits.delete(path);
    this.revision = this.nextRevision();
    this.pendingTicket = undefined;
    this.clearAcks();
    return this.revision;
  }

  private nextRevision(): number {
    if (this.revision >= Number.MAX_SAFE_INTEGER) fail("uiRevision exhausted");
    return this.revision + 1;
  }

  private clearAcks(): void {
    this.applicationAck = undefined;
    this.starlightAck = undefined;
  }

  startCompile(): PairedV2CompileTicket {
    if (this.baseline === undefined) fail("a baseline must be open before compiling");
    this.latestSuccessful = undefined;
    this.clearAcks();
    const request: PairedV2CompileRequest = Object.freeze({
      source: Object.freeze(sourceFor(this.baseline)),
      edits: cloneEdits(this.edits),
      uiRevision: this.revision,
      sessionId: this.sessionId,
    });
    const ticket = Object.freeze({
      request,
      sessionId: this.sessionId,
      uiRevision: this.revision,
    });
    this.pendingTicket = ticket;
    this.ticketRecords.set(ticket, {
      sessionId: this.sessionId,
      uiRevision: this.revision,
    });
    return ticket;
  }

  acceptCompile(ticket: PairedV2CompileTicket, value: unknown): PairedV2CompileAcceptance {
    if (typeof ticket !== "object" || ticket === null) {
      return { accepted: false, reason: "invalid" };
    }
    const record = this.ticketRecords.get(ticket);
    if (ticket.sessionId !== this.sessionId || record?.sessionId !== this.sessionId) {
      return { accepted: false, reason: "session-mismatch" };
    }
    if (this.pendingTicket !== ticket || record === undefined) {
      return { accepted: false, reason: "superseded" };
    }
    if (ticket.uiRevision !== this.revision || record.uiRevision !== this.revision) {
      return { accepted: false, reason: "revision-mismatch" };
    }
    let response: PairedV2CompileResponse;
    try {
      response = decodePairedV2CompileResponse(value, {
        expectedSessionId: this.sessionId,
        expectedUiRevision: this.revision,
      });
    } catch (_error) {
      this.pendingTicket = undefined;
      return { accepted: false, reason: "invalid" };
    }
    if (response.status === "stale") {
      this.pendingTicket = undefined;
      return { accepted: false, reason: "stale", response };
    }
    if (response.status === "cancelled") {
      this.pendingTicket = undefined;
      return { accepted: false, reason: "cancelled", response };
    }
    if (response.status === "error") {
      this.pendingTicket = undefined;
      return { accepted: false, reason: "invalid", response };
    }
    if (response.status !== "success" && response.status !== "partial") {
      this.pendingTicket = undefined;
      return { accepted: false, reason: "invalid", response };
    }
    const successResponse = response as PairedV2SuccessfulCompileResponse;
    if (this.baseline === undefined) {
      this.pendingTicket = undefined;
      return { accepted: false, reason: "invalid", response };
    }
    if (
      successResponse.draft.baselineRawSourceSha256 !== this.baseline.rawSourceSha256 ||
      successResponse.draft.baselineCanonicalDigest !== this.baseline.canonicalDigest ||
      (successResponse.draft.parentSourceSha256 !== undefined &&
        successResponse.draft.parentSourceSha256 !== this.baseline.rawSourceSha256)
    ) {
      this.pendingTicket = undefined;
      return { accepted: false, reason: "invalid", response };
    }
    this.pendingTicket = undefined;
    this.latestSuccessful = successResponse;
    this.clearAcks();
    return { accepted: true, response: successResponse };
  }

  recordPreviewAck(ack: PairedV2PreviewAck): boolean {
    if (
      (ack.preview !== "application" && ack.preview !== "starlight") ||
      ack.sessionId !== this.sessionId ||
      !Number.isSafeInteger(ack.uiRevision) ||
      ack.uiRevision < 0 ||
      this.latestSuccessful === undefined ||
      ack.uiRevision !== this.latestSuccessful.uiRevision ||
      ack.rawSourceSha256 !== this.latestSuccessful.draft?.rawSourceSha256 ||
      ack.canonicalDigest !== this.latestSuccessful.draft?.canonicalDigest
    ) {
      return false;
    }
    ensureString(ack.frameId, "frameId", 256);
    if (ack.preview === "application") this.applicationAck = cloneAck(ack);
    else this.starlightAck = cloneAck(ack);
    return true;
  }

  get previewAcks(): Readonly<{ application: PairedV2PreviewAck | undefined; starlight: PairedV2PreviewAck | undefined }> {
    return Object.freeze({
      application: this.applicationAck === undefined ? undefined : cloneAck(this.applicationAck),
      starlight: this.starlightAck === undefined ? undefined : cloneAck(this.starlightAck),
    });
  }

  canAdoptPaired(): boolean {
    const response = this.latestSuccessful;
    return (
      response !== undefined &&
      response.uiRevision === this.revision &&
      (response.status === "success" || response.status === "partial") &&
      response.valid &&
      response.solarSail.valid &&
      response.stellarLoom.valid &&
      response.applicationExtension.valid &&
      response.applicationAppearance.valid &&
      !hasFatalPairedV2Diagnostics(response) &&
      this.applicationAck !== undefined &&
      this.starlightAck !== undefined &&
      this.applicationAck.uiRevision === response.uiRevision &&
      this.starlightAck.uiRevision === response.uiRevision
    );
  }

  prepareSafeSave(mode: "edited" | "new-document"): PairedV2SaveEligibility {
    if (this.baseline === undefined) return { eligible: false, reason: "no-baseline" };
    const response = this.latestSuccessful;
    if (response === undefined || response.draft === undefined) {
      return { eligible: false, reason: "no-successful-compile" };
    }
    if (response.sessionId !== this.sessionId || response.uiRevision !== this.revision) {
      return { eligible: false, reason: "compile-not-current" };
    }
    const draft = response.draft;
    const common = {
      sessionId: this.sessionId,
      draftSourceBase64: draft.sourceBytesBase64,
      expectedDraftRawSourceSha256: draft.rawSourceSha256,
      expectedCanonicalDigest: draft.canonicalDigest,
      expectedCompileRawSourceSha256: draft.rawSourceSha256,
      expectedCompileCanonicalDigest: draft.canonicalDigest,
      expectedCompileUiRevision: response.uiRevision,
      saveMode: mode,
      uiRevision: this.revision,
    } satisfies Omit<PairedV2SaveRequest, "documentId" | "expectedParentSourceSha256">;
    if (mode === "edited") {
      if (this.baseline.sourceKind !== "document" || this.baseline.documentId === undefined) {
        return { eligible: false, reason: "detached-no-custody" };
      }
      const request: PairedV2SaveRequest = {
        ...common,
        documentId: this.baseline.documentId,
        expectedParentSourceSha256: this.baseline.rawSourceSha256,
      };
      return { eligible: true, request: Object.freeze(request) };
    }
    return { eligible: true, request: Object.freeze(common) };
  }

  safeSave(mode: "edited" | "new-document"): PairedV2SaveEligibility {
    return this.prepareSafeSave(mode);
  }

  get latestCompile(): PairedV2SuccessfulCompileResponse | undefined {
    return this.latestSuccessful;
  }

  snapshot(): PairedV2AuthoringSnapshot {
    const edits = cloneEditMap(this.edits);
    const previewAcks = Object.freeze({
      application: this.applicationAck === undefined ? undefined : cloneAck(this.applicationAck),
      starlight: this.starlightAck === undefined ? undefined : cloneAck(this.starlightAck),
    });
    return Object.freeze({
      sessionId: this.sessionId,
      revision: this.revision,
      ...(this.baseline === undefined ? {} : { baseline: readonlyJsonClone(this.baseline) }),
      edits,
      ...(this.latestSuccessful === undefined
        ? {}
        : { latestSuccessful: readonlyJsonClone(this.latestSuccessful) }),
      previewAcks,
    });
  }
}

