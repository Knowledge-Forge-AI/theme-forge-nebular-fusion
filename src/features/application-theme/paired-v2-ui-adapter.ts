import {
  PairedV2AuthoringSession,
  type PairedV2BaselineInput,
} from "./paired-v2-authoring";
import {
  hasFatalPairedV2Diagnostics,
  readonlyJsonClone,
} from "./paired-v2-bridge-decoder";
import {
  PAIRED_V2_LIMITS,
} from "./paired-v2-authoring-types";
import type {
  PairedV2AuthoringSnapshot,
  PairedV2CompileAcceptance,
  PairedV2CompileRequest,
  PairedV2CompileResponse,
  PairedV2CompileTicket,
  PairedV2Edit,
  PairedV2PreviewAck,
  PairedV2SaveEligibility,
  PairedV2SaveResponse,
  PairedV2SuccessfulCompileResponse,
} from "./paired-v2-authoring-types";
import type {
  PairedV2NativeBridge,
} from "./paired-v2-native-bridge";
import type { PairedProfileV2Document } from "./types";

export type { PairedV2NativeBridge } from "./paired-v2-native-bridge";

export type PairedV2PreviewName = "application" | "starlight";

export interface PairedV2NativeCapabilityInput {
  readonly supported: boolean;
  readonly sessionId?: string;
}

export interface PairedV2NativeCapability {
  readonly supported: true;
  readonly sessionId: string;
}

export interface PairedV2OpenDocumentInput {
  readonly documentId: string;
  readonly displayName: string;
  readonly schemaVersion: "tf-paired-profile-v2";
  readonly v2AuthoringEligible: boolean;
  /** Legacy v1 editability remains false; v2 uses the separate capability above. */
  readonly editable: boolean;
  readonly verificationStatus: string;
  readonly isTransformed: boolean;
  readonly semantic: string;
  readonly rawSourceSha256: string;
  readonly canonicalDigest: string;
  readonly ownerBinding?: unknown;
  readonly profile?: unknown;
  readonly parentSourceSha256?: unknown;
  readonly aliasResolved?: unknown;
  readonly [key: string]: unknown;
}

export interface PairedV2OpenInput {
  readonly mode?: "custody";
  readonly capability: PairedV2NativeCapabilityInput;
  readonly document: PairedV2OpenDocumentInput;
  readonly v2Profile: PairedProfileV2Document;
}

/**
 * A detached candidate is only a claim until promoteDetached verifies it with
 * a fresh native capability session.  It intentionally has no document,
 * custody record, or frontend-supplied profile.
 */
export interface PairedV2DetachedOpenInput {
  readonly mode: "detached";
  readonly capability: PairedV2NativeCapabilityInput;
  readonly sourceBytesBase64: string;
  readonly expectedRawSourceSha256: string;
  readonly expectedCanonicalDigest: string;
}

export type PairedV2DetachedPromotionInput = PairedV2DetachedOpenInput;
export type PairedV2AuthoringInput = PairedV2OpenInput | PairedV2DetachedOpenInput;

export interface PairedV2DetachedAuthoringSource {
  readonly schemaVersion: "tf-paired-profile-v2";
  readonly v2Profile: PairedProfileV2Document;
  readonly sourceBytesBase64: string;
  readonly rawSourceSha256: string;
  readonly canonicalDigest: string;
  readonly verificationStatus: "verified";
  readonly isTransformed: false;
}

export interface PairedV2AuthoringDocument {
  readonly documentId: string;
  readonly displayName: string;
  readonly schemaVersion: "tf-paired-profile-v2";
  readonly v2AuthoringEligible: true;
  readonly editable: false;
  readonly verificationStatus: "verified";
  readonly isTransformed: false;
  readonly semantic: "validated";
  readonly rawSourceSha256: string;
  readonly canonicalDigest: string;
  readonly v2Profile: PairedProfileV2Document;
}

export interface PairedV2PreviewFrame {
  readonly preview: PairedV2PreviewName;
  readonly frameToken: string;
  readonly sessionId: string;
  readonly uiRevision: number;
  readonly rawSourceSha256: string;
  readonly canonicalDigest: string;
}

export interface PairedV2PreviewAckInput {
  readonly frameToken: string;
  readonly sessionId: string;
  readonly uiRevision: number;
  readonly rawSourceSha256: string;
  readonly canonicalDigest: string;
  readonly frameId: string;
}

export interface PairedV2ApplicationAppearanceCandidate {
  readonly sessionId: string;
  readonly uiRevision: number;
  readonly rawSourceSha256: string;
  readonly canonicalDigest: string;
  readonly sourceBytesBase64: string;
  readonly profile: PairedProfileV2Document;
  /** Full native-composed application appearance CSS, never extension-only CSS. */
  readonly compiledCss: string;
}

export type PairedV2UiCompileOutcome =
  | {
      readonly accepted: true;
      readonly ticket: PairedV2CompileTicket;
      readonly response: PairedV2SuccessfulCompileResponse;
    }
  | {
      readonly accepted: false;
      readonly ticket: PairedV2CompileTicket;
      readonly reason: Extract<PairedV2CompileAcceptance, { readonly accepted: false }>["reason"] | "disposed" | "reopened";
      readonly response?: PairedV2CompileResponse;
    };

export type PairedV2DetachedPromotionOutcome =
  | {
      readonly accepted: true;
      readonly response: PairedV2SuccessfulCompileResponse;
      readonly snapshot: PairedV2UiSnapshot;
    }
  | {
      readonly accepted: false;
      readonly reason: "refused" | "reopened" | "disposed";
      readonly snapshot: PairedV2UiSnapshot;
      readonly response?: PairedV2CompileResponse;
    };

export interface PairedV2UiSnapshot {
  readonly lifecycle: "empty" | "promoting" | "ready" | "refused" | "disposed";
  readonly capability?: PairedV2NativeCapability;
  readonly document?: PairedV2AuthoringDocument;
  readonly detachedSource?: PairedV2DetachedAuthoringSource;
  readonly sourceMode?: "custody" | "detached";
  readonly authoring?: PairedV2AuthoringSnapshot;
  readonly pendingCompile: boolean;
  readonly pendingSave: boolean;
  readonly savedFrozen: boolean;
  readonly refusal?: "detached-promotion-refused";
  readonly canAdoptPaired: boolean;
}

export interface PairedV2WorkflowState {
  readonly snapshot: PairedV2UiSnapshot;
  readonly acceptedCompile?: PairedV2SuccessfulCompileResponse;
}

export type PairedV2UiAdapterErrorCode =
  | "unsupported"
  | "invalid-open-document"
  | "detached-requires-promotion"
  | "detached-promotion-refused"
  | "already-open"
  | "not-open"
  | "disposed"
  | "invalid-edit"
  | "compile-failed"
  | "save-failed"
  | "save-not-eligible"
  | "invalid-preview"
  | "not-adoptable"
  | "saved-frozen"
  | "stale-operation";

export class PairedV2UiAdapterError extends Error {
  readonly code: PairedV2UiAdapterErrorCode;
  readonly saveReason?: Extract<PairedV2SaveEligibility, { readonly eligible: false }>["reason"];

  constructor(
    code: PairedV2UiAdapterErrorCode,
    saveReason?: Extract<PairedV2SaveEligibility, { readonly eligible: false }>["reason"]
  ) {
    const message =
      code === "unsupported"
        ? "Paired v2 authoring capability is unavailable"
        : code === "invalid-open-document"
          ? "Paired v2 document is not eligible for authoring"
          : code === "detached-requires-promotion"
            ? "A detached candidate must be verified before authoring"
            : code === "detached-promotion-refused"
              ? "The detached candidate could not be verified by the native compiler"
              : code === "already-open"
                ? "Paired v2 document is already open; use explicit reopen"
                : code === "not-open"
                  ? "No paired v2 document is open"
                  : code === "disposed"
                    ? "Paired v2 authoring adapter is disposed"
                    : code === "invalid-edit"
                      ? "Paired v2 edit was rejected"
                      : code === "compile-failed"
                        ? "Paired v2 compilation failed"
                        : code === "save-failed"
                          ? "Paired v2 save failed"
                          : code === "save-not-eligible"
                            ? "Paired v2 save is not eligible"
                            : code === "invalid-preview"
                              ? "Paired v2 preview frame is not current"
                              : code === "not-adoptable"
                                ? "Paired v2 application appearance is not adoptable"
                                : code === "saved-frozen"
                                  ? "This saved source is frozen until it is explicitly reopened"
                                  : "Paired v2 operation became stale";
    super(message);
    this.name = "PairedV2UiAdapterError";
    this.code = code;
    if (saveReason !== undefined) this.saveReason = saveReason;
  }
}

type UnknownRecord = Record<string, unknown>;

interface FrameRecord {
  readonly frame: PairedV2PreviewFrame;
  readonly epoch: number;
  readonly session: PairedV2AuthoringSession;
  readonly ticket: PairedV2CompileTicket;
}

function fail(code: PairedV2UiAdapterErrorCode): never {
  throw new PairedV2UiAdapterError(code);
}

function objectValue(value: unknown): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("invalid-open-document");
  }
  return value as UnknownRecord;
}

function has(object: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function exactKeys(object: UnknownRecord, allowed: readonly string[], required: readonly string[]): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(object).some((key) => !allowedSet.has(key))) return fail("invalid-open-document");
  if (required.some((key) => !has(object, key))) return fail("invalid-open-document");
}

function boundedString(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length === 0) return fail("invalid-open-document");
  if (new TextEncoder().encode(value).byteLength > maximum) return fail("invalid-open-document");
  return value;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) return fail("invalid-open-document");
  return value;
}

function sourceBase64(value: unknown): string {
  const result = boundedString(value, PAIRED_V2_LIMITS.sourceBase64Chars);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result)) {
    return fail("invalid-open-document");
  }
  const padding = result.endsWith("==") ? 2 : result.endsWith("=") ? 1 : 0;
  const decodedBytes = result.length * 3 / 4 - padding;
  if (decodedBytes <= 0 || decodedBytes > PAIRED_V2_LIMITS.sourceBytes) return fail("invalid-open-document");
  return result;
}

function cloneInput(value: unknown): unknown {
  try {
    return readonlyJsonClone(value);
  } catch {
    return fail("invalid-open-document");
  }
}

function supportedCapability(value: unknown): PairedV2NativeCapability {
  const capability = objectValue(cloneInput(value));
  if (capability.supported !== true) return fail("unsupported");
  exactKeys(capability, ["supported", "sessionId"], ["supported", "sessionId"]);
  if (typeof capability.sessionId !== "string" || capability.sessionId.length === 0) {
    return fail("invalid-open-document");
  }
  if (new TextEncoder().encode(capability.sessionId).byteLength > 128) return fail("invalid-open-document");
  return Object.freeze({ supported: true as const, sessionId: capability.sessionId });
}

function validatedProfile(value: unknown): PairedProfileV2Document {
  const profile = objectValue(cloneInput(value));
  if (profile.schemaVersion !== "tf-paired-profile-v2") return fail("invalid-open-document");
  boundedString(profile.name, 256);
  boundedString(profile.version, 128);
  return profile as unknown as PairedProfileV2Document;
}

function validateOwnerBinding(
  value: unknown,
  rawSourceSha256: string,
  canonicalDigest: string
): void {
  const owner = objectValue(value);
  if (owner.inputOrigin !== "source-bytes") return fail("invalid-open-document");
  if (owner.verificationStatus !== "verified" || owner.isTransformed !== false) {
    return fail("invalid-open-document");
  }
  if (owner.rawSourceSha256 !== rawSourceSha256) return fail("invalid-open-document");
  if (has(owner, "canonicalDigest") && owner.canonicalDigest !== canonicalDigest) {
    return fail("invalid-open-document");
  }
  if (has(owner, "parentSourceSha256") && owner.parentSourceSha256 !== undefined) {
    return fail("invalid-open-document");
  }
}

function validatedDocument(value: unknown, v2Profile: PairedProfileV2Document): PairedV2AuthoringDocument {
  const document = objectValue(cloneInput(value));
  if (has(document, "profile")) return fail("invalid-open-document");
  if (document.schemaVersion !== "tf-paired-profile-v2") return fail("invalid-open-document");
  if (document.v2AuthoringEligible !== true || document.editable !== false) {
    return fail("invalid-open-document");
  }
  if (document.verificationStatus !== "verified" || document.isTransformed !== false || document.semantic !== "validated") {
    return fail("invalid-open-document");
  }
  if (document.aliasResolved === true) return fail("invalid-open-document");
  if (has(document, "parentSourceSha256") && document.parentSourceSha256 !== undefined) {
    return fail("invalid-open-document");
  }
  const rawSourceSha256 = digest(document.rawSourceSha256);
  const canonicalDigest = digest(document.canonicalDigest);
  if (has(document, "ownerBinding")) validateOwnerBinding(document.ownerBinding, rawSourceSha256, canonicalDigest);
  return Object.freeze({
    documentId: boundedString(document.documentId, 256),
    displayName: boundedString(document.displayName, 256),
    schemaVersion: "tf-paired-profile-v2" as const,
    v2AuthoringEligible: true as const,
    editable: false as const,
    verificationStatus: "verified" as const,
    isTransformed: false as const,
    semantic: "validated" as const,
    rawSourceSha256,
    canonicalDigest,
    v2Profile,
  });
}

function parseOpenInput(value: unknown): {
  readonly capability: PairedV2NativeCapability;
  readonly document: PairedV2AuthoringDocument;
} {
  const input = objectValue(cloneInput(value));
  exactKeys(input, ["mode", "capability", "document", "v2Profile"], ["capability", "document", "v2Profile"]);
  if (input.mode !== undefined && input.mode !== "custody") return fail("detached-requires-promotion");
  const capability = supportedCapability(input.capability);
  const v2Profile = validatedProfile(input.v2Profile);
  const document = validatedDocument(input.document, v2Profile);
  return { capability, document };
}

function parseDetachedPromotionInput(value: unknown): PairedV2DetachedPromotionInput {
  const input = objectValue(cloneInput(value));
  exactKeys(input, ["mode", "capability", "sourceBytesBase64", "expectedRawSourceSha256", "expectedCanonicalDigest"], [
    "mode",
    "capability",
    "sourceBytesBase64",
    "expectedRawSourceSha256",
    "expectedCanonicalDigest",
  ]);
  if (input.mode !== "detached") return fail("invalid-open-document");
  return Object.freeze({
    mode: "detached" as const,
    capability: supportedCapability(input.capability),
    sourceBytesBase64: sourceBase64(input.sourceBytesBase64),
    expectedRawSourceSha256: digest(input.expectedRawSourceSha256),
    expectedCanonicalDigest: digest(input.expectedCanonicalDigest),
  });
}

function frameId(value: unknown): string {
  return boundedString(value, 256);
}

function previewName(value: unknown): PairedV2PreviewName {
  if (value !== "application" && value !== "starlight") return fail("invalid-preview");
  return value;
}

function validDetachedPromotionResponse(
  response: PairedV2CompileResponse,
  input: PairedV2DetachedPromotionInput,
  sessionId: string,
): response is PairedV2SuccessfulCompileResponse {
  if (
    !response.valid ||
    (response.status !== "success" && response.status !== "partial") ||
    response.sessionId !== sessionId ||
    response.uiRevision !== 0 ||
    hasFatalPairedV2Diagnostics(response)
  ) {
    return false;
  }
  const draft = response.draft;
  if (
    draft.sourceBytesBase64 !== input.sourceBytesBase64 ||
    draft.rawSourceSha256 !== input.expectedRawSourceSha256 ||
    draft.canonicalDigest !== input.expectedCanonicalDigest ||
    draft.baselineRawSourceSha256 !== input.expectedRawSourceSha256 ||
    draft.baselineCanonicalDigest !== input.expectedCanonicalDigest ||
    draft.verificationStatus !== "verified" ||
    draft.isTransformed !== false ||
    draft.parentSourceSha256 !== undefined
  ) {
    return false;
  }
  const results = [response.solarSail, response.stellarLoom, response.applicationExtension, response.applicationAppearance];
  return results.every(
    (result) =>
      result.sourceProfileSha256 === input.expectedRawSourceSha256 &&
      result.canonicalDigest === input.expectedCanonicalDigest,
  );
}

function detachedSourceFromResponse(
  response: PairedV2SuccessfulCompileResponse,
): PairedV2DetachedAuthoringSource {
  return Object.freeze({
    schemaVersion: "tf-paired-profile-v2" as const,
    v2Profile: readonlyJsonClone(response.draft.profile) as PairedProfileV2Document,
    sourceBytesBase64: response.draft.sourceBytesBase64,
    rawSourceSha256: response.draft.rawSourceSha256,
    canonicalDigest: response.draft.canonicalDigest,
    verificationStatus: "verified" as const,
    isTransformed: false as const,
  });
}

export class PairedV2UiAdapter {
  private readonly bridge: PairedV2NativeBridge;
  private lifecycleEpoch = 0;
  private disposed = false;
  private capability: PairedV2NativeCapability | undefined;
  private document: PairedV2AuthoringDocument | undefined;
  private detachedSource: PairedV2DetachedAuthoringSource | undefined;
  private session: PairedV2AuthoringSession | undefined;
  private pending:
    | { readonly epoch: number; readonly session: PairedV2AuthoringSession; readonly ticket: PairedV2CompileTicket }
    | undefined;
  private pendingPromotion: { readonly epoch: number; readonly input: PairedV2DetachedPromotionInput } | undefined;
  private pendingSave = false;
  private savedFrozen = false;
  private refusal: "detached-promotion-refused" | undefined;
  private acceptedTicket: PairedV2CompileTicket | undefined;
  private readonly frameRecords = new Map<PairedV2PreviewFrame, FrameRecord>();
  private readonly activeFrames = new Map<PairedV2PreviewName, FrameRecord>();
  private readonly acknowledgements = new Map<PairedV2PreviewName, PairedV2PreviewAck>();

  constructor(bridge: PairedV2NativeBridge) {
    this.bridge = bridge;
  }

  open(input: PairedV2OpenInput): PairedV2UiSnapshot {
    this.ensureNotDisposed();
    if (this.session !== undefined) return fail("already-open");
    this.install(input);
    return this.snapshot();
  }

  reopen(input: PairedV2OpenInput): PairedV2UiSnapshot {
    this.ensureNotDisposed();
    this.install(input);
    return this.snapshot();
  }

  /**
   * Verify a detached candidate with a fresh native capability session. The
   * caller owns the native reset/status refresh; this method deliberately does
   * not borrow or revive the previous session when verification fails.
   */
  async promoteDetached(input: PairedV2DetachedPromotionInput): Promise<PairedV2DetachedPromotionOutcome> {
    this.ensureNotDisposed();
    const epoch = ++this.lifecycleEpoch;
    this.pending = undefined;
    this.acceptedTicket = undefined;
    this.clearFrames();
    this.document = undefined;
    this.detachedSource = undefined;
    this.session = undefined;
    this.capability = undefined;
    this.pendingPromotion = undefined;
    this.pendingSave = false;
    this.savedFrozen = false;
    this.refusal = undefined;
    let parsed: PairedV2DetachedPromotionInput;
    let capability: PairedV2NativeCapability;
    try {
      parsed = parseDetachedPromotionInput(input);
      capability = supportedCapability(parsed.capability);
    } catch (error) {
      this.refusal = "detached-promotion-refused";
      throw error;
    }
    this.capability = capability;
    this.pendingPromotion = { epoch, input: parsed };
    const request: PairedV2CompileRequest = Object.freeze({
      source: Object.freeze({
        rawSourceBase64: parsed.sourceBytesBase64,
        expectedRawSourceSha256: parsed.expectedRawSourceSha256,
        expectedCanonicalDigest: parsed.expectedCanonicalDigest,
      }),
      edits: Object.freeze([]),
      uiRevision: 0,
      sessionId: capability.sessionId,
    });
    try {
      const response = await this.bridge.compileV2(request);
      if (!this.isCurrentPromotion(epoch)) {
        return {
          accepted: false,
          reason: this.disposed ? "disposed" : "reopened",
          snapshot: this.snapshot(),
        };
      }
      if (!validDetachedPromotionResponse(response, parsed, capability.sessionId)) {
        this.refuseDetachedPromotion();
        return { accepted: false, reason: "refused", response, snapshot: this.snapshot() };
      }
      const session = new PairedV2AuthoringSession(capability.sessionId, {
        sourceKind: "detached",
        rawSourceBase64: parsed.sourceBytesBase64,
        rawSourceSha256: parsed.expectedRawSourceSha256,
        canonicalDigest: parsed.expectedCanonicalDigest,
      });
      const ticket = session.startCompile();
      const acceptance = session.acceptCompile(ticket, response);
      if (!acceptance.accepted) {
        this.refuseDetachedPromotion();
        return { accepted: false, reason: "refused", response, snapshot: this.snapshot() };
      }
      this.session = session;
      this.detachedSource = detachedSourceFromResponse(acceptance.response);
      this.acceptedTicket = ticket;
      this.pendingPromotion = undefined;
      return { accepted: true, response: acceptance.response, snapshot: this.snapshot() };
    } catch {
      if (!this.isCurrentPromotion(epoch)) {
        return {
          accepted: false,
          reason: this.disposed ? "disposed" : "reopened",
          snapshot: this.snapshot(),
        };
      }
      this.refuseDetachedPromotion();
      return { accepted: false, reason: "refused", snapshot: this.snapshot() };
    } finally {
      if (this.pendingPromotion?.epoch === epoch) this.pendingPromotion = undefined;
    }
  }

  reset(capabilityInput: PairedV2NativeCapabilityInput): PairedV2UiSnapshot {
    this.ensureNotDisposed();
    const capability = supportedCapability(capabilityInput);
    this.lifecycleEpoch += 1;
    this.pending = undefined;
    this.acceptedTicket = undefined;
    this.clearFrames();
    this.capability = capability;
    this.document = undefined;
    this.detachedSource = undefined;
    this.session = undefined;
    this.pendingPromotion = undefined;
    this.pendingSave = false;
    this.savedFrozen = false;
    this.refusal = undefined;
    return this.snapshot();
  }

  dispose(): void {
    if (this.disposed) return;
    this.lifecycleEpoch += 1;
    this.disposed = true;
    this.pending = undefined;
    this.acceptedTicket = undefined;
    this.clearFrames();
    this.capability = undefined;
    this.document = undefined;
    this.detachedSource = undefined;
    this.session = undefined;
    this.pendingPromotion = undefined;
    this.pendingSave = false;
    this.savedFrozen = false;
    this.refusal = undefined;
  }

  setEdit(edit: PairedV2Edit): PairedV2UiSnapshot {
    if (this.savedFrozen) return fail("saved-frozen");
    const session = this.currentSession();
    const previousRevision = session.snapshot().revision;
    try {
      session.setEdit(edit);
    } catch {
      return fail("invalid-edit");
    }
    if (session.snapshot().revision !== previousRevision) this.invalidateCompileState();
    return this.snapshot();
  }

  setEdits(edits: readonly PairedV2Edit[]): PairedV2UiSnapshot {
    if (this.savedFrozen) return fail("saved-frozen");
    const session = this.currentSession();
    try {
      session.setEdits(edits);
    } catch {
      return fail("invalid-edit");
    }
    this.invalidateCompileState();
    return this.snapshot();
  }

  removeEdit(path: string): PairedV2UiSnapshot {
    if (this.savedFrozen) return fail("saved-frozen");
    const session = this.currentSession();
    const previousRevision = session.snapshot().revision;
    try {
      session.removeEdit(path);
    } catch {
      return fail("invalid-edit");
    }
    if (session.snapshot().revision !== previousRevision) this.invalidateCompileState();
    return this.snapshot();
  }

  async compile(): Promise<PairedV2UiCompileOutcome> {
    if (this.savedFrozen) throw new PairedV2UiAdapterError("saved-frozen");
    const session = this.currentSession();
    this.acceptedTicket = undefined;
    this.clearFrames();
    let ticket: PairedV2CompileTicket;
    try {
      ticket = session.startCompile();
    } catch {
      throw new PairedV2UiAdapterError("compile-failed");
    }
    const epoch = this.lifecycleEpoch;
    this.pending = { epoch, session, ticket };
    try {
      const response = await this.bridge.compileV2(ticket.request);
      if (!this.isCurrent(epoch, session)) {
        return {
          accepted: false,
          ticket,
          reason: this.disposed ? "disposed" : "reopened",
        };
      }
      const acceptance = session.acceptCompile(ticket, response);
      if (acceptance.accepted) {
        this.acceptedTicket = ticket;
        return { accepted: true, ticket, response: acceptance.response };
      }
      this.acceptedTicket = undefined;
      return {
        accepted: false,
        ticket,
        reason: acceptance.reason,
        ...(acceptance.response === undefined ? {} : { response: acceptance.response }),
      };
    } catch {
      if (!this.isCurrent(epoch, session)) {
        return {
          accepted: false,
          ticket,
          reason: this.disposed ? "disposed" : "reopened",
        };
      }
      this.acceptedTicket = undefined;
      throw new PairedV2UiAdapterError("compile-failed");
    } finally {
      if (this.pending?.ticket === ticket) this.pending = undefined;
    }
  }

  beginPreviewFrame(preview: PairedV2PreviewName, token: string): PairedV2PreviewFrame {
    const name = previewName(preview);
    const session = this.currentSession();
    const ticket = this.acceptedTicket;
    const response = session.latestCompile;
    const current = session.snapshot();
    if (
      ticket === undefined ||
      response === undefined ||
      response.uiRevision !== current.revision ||
      response.sessionId !== current.sessionId
    ) {
      return fail("invalid-preview");
    }
    const frameToken = frameId(token);
    const frame: PairedV2PreviewFrame = Object.freeze({
      preview: name,
      frameToken,
      sessionId: response.sessionId,
      uiRevision: response.uiRevision,
      rawSourceSha256: response.draft.rawSourceSha256,
      canonicalDigest: response.draft.canonicalDigest,
    });
    const record: FrameRecord = { frame, epoch: this.lifecycleEpoch, session, ticket };
    const previous = this.activeFrames.get(name);
    if (previous !== undefined) this.frameRecords.delete(previous.frame);
    this.activeFrames.set(name, record);
    this.frameRecords.set(frame, record);
    this.acknowledgements.delete(name);
    return frame;
  }

  resetPreviewFrame(frame: PairedV2PreviewFrame): void {
    const record = this.frameRecords.get(frame);
    this.frameRecords.delete(frame);
    if (record !== undefined && this.activeFrames.get(record.frame.preview) === record) {
      this.activeFrames.delete(record.frame.preview);
      this.acknowledgements.delete(record.frame.preview);
    }
  }

  recordPreviewAck(frame: PairedV2PreviewFrame, value: PairedV2PreviewAckInput): boolean {
    const record = this.frameRecords.get(frame);
    if (
      record === undefined ||
      this.activeFrames.get(record.frame.preview) !== record ||
      !this.isCurrent(record.epoch, record.session) ||
      this.acceptedTicket !== record.ticket
    ) {
      return false;
    }
    let ack: UnknownRecord;
    try {
      ack = objectValue(cloneInput(value));
    } catch {
      return false;
    }
    const allowed = ["frameToken", "sessionId", "uiRevision", "rawSourceSha256", "canonicalDigest", "frameId"];
    const allowedSet = new Set(allowed);
    if (Object.keys(ack).some((key) => !allowedSet.has(key)) || allowed.some((key) => !has(ack, key))) {
      return false;
    }
    if (
      ack.frameToken !== record.frame.frameToken ||
      ack.sessionId !== record.frame.sessionId ||
      ack.uiRevision !== record.frame.uiRevision ||
      ack.rawSourceSha256 !== record.frame.rawSourceSha256 ||
      ack.canonicalDigest !== record.frame.canonicalDigest
    ) {
      return false;
    }
    let uiRevision: number;
    try {
      uiRevision = Number(ack.uiRevision);
      frameId(ack.frameId);
    } catch {
      return false;
    }
    if (!Number.isSafeInteger(uiRevision) || uiRevision < 0) return false;
    const accepted: PairedV2PreviewAck = Object.freeze({
      preview: record.frame.preview,
      sessionId: record.frame.sessionId,
      uiRevision,
      rawSourceSha256: record.frame.rawSourceSha256,
      canonicalDigest: record.frame.canonicalDigest,
      frameId: ack.frameId as string,
    });
    if (!record.session.recordPreviewAck(accepted)) return false;
    this.acknowledgements.set(record.frame.preview, accepted);
    return true;
  }

  recordApplicationAck(frame: PairedV2PreviewFrame, value: PairedV2PreviewAckInput): boolean {
    return frame.preview === "application" && this.recordPreviewAck(frame, value);
  }

  recordStarlightAck(frame: PairedV2PreviewFrame, value: PairedV2PreviewAckInput): boolean {
    return frame.preview === "starlight" && this.recordPreviewAck(frame, value);
  }

  createPreviewAckCallback(frame: PairedV2PreviewFrame): (value: PairedV2PreviewAckInput) => boolean {
    return (value: PairedV2PreviewAckInput): boolean => this.recordPreviewAck(frame, value);
  }

  canAdoptPaired(): boolean {
    const session = this.session;
    const ticket = this.acceptedTicket;
    if (session === undefined || ticket === undefined || this.disposed || this.pendingSave || this.savedFrozen) return false;
    if (!session.canAdoptPaired()) return false;
    for (const preview of ["application", "starlight"] as const) {
      const record = this.activeFrames.get(preview);
      if (
        record === undefined ||
        record.ticket !== ticket ||
        !this.isCurrent(record.epoch, record.session) ||
        this.acknowledgements.get(preview) === undefined
      ) {
        return false;
      }
    }
    return true;
  }

  applicationAppearanceCandidate(): PairedV2ApplicationAppearanceCandidate | undefined {
    if (!this.canAdoptPaired()) return undefined;
    const session = this.currentSession();
    const response = session.latestCompile;
    if (response === undefined) return undefined;
    const appearance = response.applicationAppearance;
    if (
      !appearance.valid ||
      appearance.compiledCss.length === 0 ||
      appearance.sourceProfileSha256 !== response.draft.rawSourceSha256 ||
      appearance.canonicalDigest !== response.draft.canonicalDigest
    ) {
      return undefined;
    }
    return Object.freeze({
      sessionId: response.sessionId,
      uiRevision: response.uiRevision,
      rawSourceSha256: response.draft.rawSourceSha256,
      canonicalDigest: response.draft.canonicalDigest,
      sourceBytesBase64: response.draft.sourceBytesBase64,
      profile: readonlyJsonClone(response.draft.profile) as PairedProfileV2Document,
      compiledCss: appearance.compiledCss,
    });
  }

  async save(mode: "edited" | "new-document"): Promise<PairedV2SaveResponse> {
    if (this.savedFrozen) throw new PairedV2UiAdapterError("saved-frozen");
    const session = this.currentSession();
    const eligibility = session.prepareSafeSave(mode);
    if (!eligibility.eligible) {
      throw new PairedV2UiAdapterError("save-not-eligible", eligibility.reason);
    }
    const epoch = this.lifecycleEpoch;
    this.pendingSave = true;
    try {
      const response = await this.bridge.saveV2(eligibility.request);
      if (!this.isCurrent(epoch, session)) throw new PairedV2UiAdapterError("stale-operation");
      if (response.sessionId !== eligibility.request.sessionId || response.uiRevision !== eligibility.request.uiRevision) {
        throw new PairedV2UiAdapterError("save-failed");
      }
      if (response.saved) {
        const saved = response.document;
        if (
          saved === undefined ||
          saved.rawSourceSha256 !== eligibility.request.expectedDraftRawSourceSha256 ||
          saved.canonicalDigest !== eligibility.request.expectedCanonicalDigest ||
          (mode === "edited" && saved.documentId !== eligibility.request.documentId)
        ) {
          throw new PairedV2UiAdapterError("save-failed");
        }
      }
      if (response.saved) {
        this.savedFrozen = true;
      }
      return response;
    } catch (error) {
      if (error instanceof PairedV2UiAdapterError) throw error;
      if (!this.isCurrent(epoch, session)) throw new PairedV2UiAdapterError("stale-operation");
      throw new PairedV2UiAdapterError("save-failed");
    } finally {
      if (this.pendingSave) this.pendingSave = false;
    }
  }

  snapshot(): PairedV2UiSnapshot {
    const session = this.session;
    const rawAuthoring = session?.snapshot();
    const authoring =
      rawAuthoring === undefined
        ? undefined
        : Object.freeze({
            ...rawAuthoring,
            previewAcks: Object.freeze({
              application: this.acknowledgements.get("application"),
              starlight: this.acknowledgements.get("starlight"),
            }),
          });
    return Object.freeze({
      lifecycle: this.disposed
        ? "disposed" as const
        : this.pendingPromotion !== undefined
          ? "promoting" as const
          : this.refusal !== undefined
            ? "refused" as const
            : session === undefined
              ? "empty" as const
              : "ready" as const,
      ...(this.capability === undefined ? {} : { capability: this.capability }),
      ...(this.document === undefined ? {} : { document: this.document }),
      ...(this.detachedSource === undefined ? {} : { detachedSource: this.detachedSource }),
      ...(this.document !== undefined ? { sourceMode: "custody" as const } : this.detachedSource !== undefined ? { sourceMode: "detached" as const } : {}),
      ...(authoring === undefined ? {} : { authoring }),
      pendingCompile:
        (this.pending !== undefined && this.pending.session === session) || this.pendingPromotion !== undefined,
      pendingSave: this.pendingSave,
      savedFrozen: this.savedFrozen,
      ...(this.refusal === undefined ? {} : { refusal: this.refusal }),
      canAdoptPaired: this.canAdoptPaired(),
    });
  }

  private install(input: PairedV2OpenInput): void {
    const parsed = parseOpenInput(input);
    const baseline: PairedV2BaselineInput = {
      sourceKind: "document",
      documentId: parsed.document.documentId,
      rawSourceSha256: parsed.document.rawSourceSha256,
      canonicalDigest: parsed.document.canonicalDigest,
    };
    this.lifecycleEpoch += 1;
    this.pending = undefined;
    this.acceptedTicket = undefined;
    this.clearFrames();
    this.capability = parsed.capability;
    this.document = parsed.document;
    this.detachedSource = undefined;
    this.refusal = undefined;
    this.pendingPromotion = undefined;
    this.pendingSave = false;
    this.savedFrozen = false;
    this.session = new PairedV2AuthoringSession(parsed.capability.sessionId, baseline);
  }

  private invalidateCompileState(): void {
    this.pending = undefined;
    this.acceptedTicket = undefined;
    this.clearFrames();
  }

  private refuseDetachedPromotion(): void {
    this.pendingPromotion = undefined;
    this.pending = undefined;
    this.acceptedTicket = undefined;
    this.clearFrames();
    this.document = undefined;
    this.detachedSource = undefined;
    this.session = undefined;
    this.savedFrozen = false;
    this.refusal = "detached-promotion-refused";
  }

  private clearFrames(): void {
    this.frameRecords.clear();
    this.activeFrames.clear();
    this.acknowledgements.clear();
  }

  private ensureNotDisposed(): void {
    if (this.disposed) fail("disposed");
  }

  private currentSession(): PairedV2AuthoringSession {
    this.ensureNotDisposed();
    if (this.session === undefined) return fail("not-open");
    return this.session;
  }

  private isCurrent(epoch: number, session: PairedV2AuthoringSession): boolean {
    return !this.disposed && this.lifecycleEpoch === epoch && this.session === session;
  }

  private isCurrentPromotion(epoch: number): boolean {
    return !this.disposed && this.lifecycleEpoch === epoch && this.pendingPromotion?.epoch === epoch;
  }
}

