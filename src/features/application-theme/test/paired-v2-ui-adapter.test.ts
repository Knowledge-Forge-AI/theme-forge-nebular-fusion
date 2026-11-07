import { describe, expect, it, vi } from "vitest";
import type {
  PairedV2CompileResponse,
  PairedV2MappingReport,
  PairedV2SaveRequest,
  PairedV2SaveResponse,
  PairedV2SuccessfulCompileResponse,
} from "../paired-v2-authoring-types";
import {
  PairedV2UiAdapter,
  PairedV2UiAdapterError,
  type PairedV2DetachedOpenInput,
  type PairedV2NativeBridge,
  type PairedV2OpenInput,
} from "../paired-v2-ui-adapter";
import type { PairedProfileV2Document } from "../types";

const SESSION = "paired-v2-ui-session";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const SOURCE = "eA==";
const FULL_APPLICATION_CSS = ":root { --native-application-palette: #123456; }";
const EXTENSION_ONLY_CSS = ":root { --extension-only: #123456; }";

const PROFILE = {
  schemaVersion: "tf-paired-profile-v2",
  name: "developer",
  version: "0.1.0",
} as PairedProfileV2Document;

function openInput(sessionId = SESSION, documentId = "developer-document"): PairedV2OpenInput {
  return {
    capability: { supported: true, sessionId },
    document: {
      documentId,
      displayName: "developer.profile.json",
      schemaVersion: "tf-paired-profile-v2",
      v2AuthoringEligible: true,
      editable: false,
      verificationStatus: "verified",
      isTransformed: false,
      semantic: "validated",
      rawSourceSha256: HASH_A,
      canonicalDigest: HASH_B,
      ownerBinding: {
        inputOrigin: "source-bytes",
        rawSourceSha256: HASH_A,
        verificationStatus: "verified",
        isTransformed: false,
        byteLength: 4734,
        canonicalDigest: HASH_B,
      },
    },
    v2Profile: PROFILE,
  };
}

function detachedInput(sessionId = SESSION): PairedV2DetachedOpenInput {
  return {
    mode: "detached",
    capability: { supported: true, sessionId },
    sourceBytesBase64: SOURCE,
    expectedRawSourceSha256: HASH_A,
    expectedCanonicalDigest: HASH_B,
  };
}

function mappingReport(target: "solar-sail" | "stellar-loom"): PairedV2MappingReport {
  return {
    schema: "tf-paired-mapping-report-v2",
    target,
    profileName: "developer",
    profileVersion: "0.1.0",
    sourceSha256: HASH_B,
    sourceVerification: "source-bytes",
    canonicalDigest: HASH_C,
    adapter: { name: "paired-v2", version: "0.2.0" },
    compiler: { name: target, version: "0.3.0" },
    options: {},
    entries: [
      {
        sourcePath: "color.dark.primaryAction",
        classification: "consumed",
        reason: "Mapped by adapter",
      },
    ],
    groups: [{ group: "color", applicable: true, reason: "Supported subset" }],
    defaults: [],
    summary: {
      totalSemanticLeaves: 1,
      consumed: 1,
      normalized: 0,
      overridden: 0,
      targetSpecific: 0,
      unsupported: 0,
      generatedDefaultsCount: 0,
    },
    digest: HASH_A,
  };
}

function compileReply(sessionId = SESSION, uiRevision = 1): PairedV2CompileResponse {
  return {
    status: "partial",
    valid: true,
    uiRevision,
    sessionId,
    draft: {
      profile: PROFILE,
      sourceBytesBase64: SOURCE,
      rawSourceSha256: HASH_B,
      canonicalDigest: HASH_C,
      baselineRawSourceSha256: HASH_A,
      baselineCanonicalDigest: HASH_B,
      verificationStatus: "transformed",
      isTransformed: true,
      parentSourceSha256: HASH_A,
    },
    solarSail: {
      valid: true,
      compiledCss: ":root { --solar: #123456; }",
      diagnostics: [],
      mappingReport: mappingReport("solar-sail"),
      sourceProfileSha256: HASH_B,
      canonicalDigest: HASH_C,
    },
    stellarLoom: {
      valid: true,
      compiledCss: ":root { --loom: #123456; }",
      diagnostics: [],
      mappingReport: mappingReport("stellar-loom"),
      sourceProfileSha256: HASH_B,
      canonicalDigest: HASH_C,
    },
    applicationExtension: {
      valid: true,
      compiledCss: EXTENSION_ONLY_CSS,
      diagnostics: [],
      mappingReport: {
        schema: "theme-forge.application-appearance-extension.v1",
        entries: [{ sourcePath: "radius.surface", target: "--tf-radius-surface", value: "8px" }],
        scope: "Supplementary application-only roles",
      },
      sourceProfileSha256: HASH_B,
      canonicalDigest: HASH_C,
    },
    applicationAppearance: {
      valid: true,
      compiledCss: FULL_APPLICATION_CSS,
      sourceProfileSha256: HASH_B,
      canonicalDigest: HASH_C,
    },
    diagnostics: [],
  };
}

function verifiedDetachedReply(sessionId = SESSION): PairedV2CompileResponse {
  const base = compileReply(sessionId, 0) as PairedV2SuccessfulCompileResponse;
  const { parentSourceSha256: _parentSourceSha256, ...baseDraft } = base.draft;
  return {
    ...base,
    status: "success",
    draft: {
      ...baseDraft,
      sourceBytesBase64: SOURCE,
      rawSourceSha256: HASH_A,
      canonicalDigest: HASH_B,
      baselineRawSourceSha256: HASH_A,
      baselineCanonicalDigest: HASH_B,
      verificationStatus: "verified",
      isTransformed: false,
    },
    solarSail: {
      ...base.solarSail,
      sourceProfileSha256: HASH_A,
      canonicalDigest: HASH_B,
      mappingReport: { ...base.solarSail.mappingReport, sourceSha256: HASH_A, canonicalDigest: HASH_B },
    },
    stellarLoom: {
      ...base.stellarLoom,
      sourceProfileSha256: HASH_A,
      canonicalDigest: HASH_B,
      mappingReport: { ...base.stellarLoom.mappingReport, sourceSha256: HASH_A, canonicalDigest: HASH_B },
    },
    applicationExtension: {
      ...base.applicationExtension,
      sourceProfileSha256: HASH_A,
      canonicalDigest: HASH_B,
    },
    applicationAppearance: {
      ...base.applicationAppearance,
      sourceProfileSha256: HASH_A,
      canonicalDigest: HASH_B,
    },
  };
}

function savedReply(sessionId = SESSION, uiRevision = 1, documentId = "developer-document"): PairedV2SaveResponse {
  return {
    cancelled: false,
    saved: true,
    sessionId,
    uiRevision,
    document: {
      documentId,
      rawSourceSha256: HASH_B,
      canonicalDigest: HASH_C,
      displayName: "developer.edited.profile.json",
    },
  };
}

function makeBridge(
  compile: (request: Parameters<PairedV2NativeBridge["compileV2"]>[0]) => Promise<PairedV2CompileResponse>,
  save: (request: PairedV2SaveRequest) => Promise<PairedV2SaveResponse> = async (request) =>
    savedReply(request.sessionId, request.uiRevision, request.documentId ?? "new-document")
): PairedV2NativeBridge & { readonly compileV2: ReturnType<typeof vi.fn>; readonly saveV2: ReturnType<typeof vi.fn> } {
  const compileV2 = vi.fn(compile);
  const saveV2 = vi.fn(save);
  return { compileV2, saveV2 };
}

function openAdapter(bridge: PairedV2NativeBridge): PairedV2UiAdapter {
  const adapter = new PairedV2UiAdapter(bridge);
  adapter.open(openInput());
  return adapter;
}

async function acceptBothFrames(adapter: PairedV2UiAdapter): Promise<void> {
  const application = adapter.beginPreviewFrame("application", "application-frame-1");
  const starlight = adapter.beginPreviewFrame("starlight", "starlight-frame-1");
  expect(adapter.createPreviewAckCallback(application)({
    frameToken: application.frameToken,
    sessionId: application.sessionId,
    uiRevision: application.uiRevision,
    rawSourceSha256: application.rawSourceSha256,
    canonicalDigest: application.canonicalDigest,
    frameId: "application-frame-ack",
  })).toBe(true);
  expect(adapter.recordStarlightAck(starlight, {
    frameToken: starlight.frameToken,
    sessionId: starlight.sessionId,
    uiRevision: starlight.uiRevision,
    rawSourceSha256: starlight.rawSourceSha256,
    canonicalDigest: starlight.canonicalDigest,
    frameId: "starlight-frame-ack",
  })).toBe(true);
}

describe("paired v2 UI adapter", () => {
  it("requires the separate capability and verified v2 custody without converting to v1", () => {
    const bridge = makeBridge(async () => compileReply());
    const adapter = new PairedV2UiAdapter(bridge);

    expect(() => adapter.open({ ...openInput(), capability: { supported: false, sessionId: SESSION } })).toThrow(
      PairedV2UiAdapterError
    );
    expect(() => adapter.open({
      ...openInput(),
      document: { ...openInput().document, v2AuthoringEligible: false },
    })).toThrow(PairedV2UiAdapterError);

    const snapshot = adapter.open(openInput());
    expect(snapshot.lifecycle).toBe("ready");
    expect(snapshot.capability).toEqual({ supported: true, sessionId: SESSION });
    expect(snapshot.document).toMatchObject({
      schemaVersion: "tf-paired-profile-v2",
      v2AuthoringEligible: true,
      editable: false,
      verificationStatus: "verified",
      rawSourceSha256: HASH_A,
      canonicalDigest: HASH_B,
    });
    expect(snapshot.document).not.toHaveProperty("profile");
    expect(snapshot.authoring?.baseline).toMatchObject({
      sourceKind: "document",
      rawSourceSha256: HASH_A,
      canonicalDigest: HASH_B,
    });
  });

  it("keeps edits and uses full native application appearance only after both current ACKs", async () => {
    const bridge = makeBridge(async () => compileReply());
    const adapter = openAdapter(bridge);
    adapter.setEdit({ kind: "set-color", path: "color.dark.primaryAction", value: "#123456" });
    const compile = await adapter.compile();
    expect(compile.accepted).toBe(true);
    expect(adapter.canAdoptPaired()).toBe(false);
    await acceptBothFrames(adapter);

    const candidate = adapter.applicationAppearanceCandidate();
    expect(candidate).toMatchObject({
      compiledCss: FULL_APPLICATION_CSS,
      rawSourceSha256: HASH_B,
      canonicalDigest: HASH_C,
    });
    expect(candidate?.compiledCss).not.toBe(EXTENSION_ONLY_CSS);
    expect(adapter.snapshot().canAdoptPaired).toBe(true);

    const application = adapter.beginPreviewFrame("application", "application-frame-2");
    expect(adapter.recordPreviewAck(application, {
      frameToken: "stale-frame-token",
      sessionId: application.sessionId,
      uiRevision: application.uiRevision,
      rawSourceSha256: application.rawSourceSha256,
      canonicalDigest: application.canonicalDigest,
      frameId: "stale-ack",
    })).toBe(false);
    adapter.resetPreviewFrame(application);
    expect(adapter.applicationAppearanceCandidate()).toBeUndefined();
  });

  it("rejects stale replies and ignores late replies after reopen or disposal", async () => {
    const staleBridge = makeBridge(async () => ({
      status: "stale",
      valid: false,
      uiRevision: 0,
      sessionId: SESSION,
      solarSail: null,
      stellarLoom: null,
      applicationExtension: null,
      applicationAppearance: null,
      diagnostics: [],
    }));
    const staleAdapter = openAdapter(staleBridge);
    const stale = await staleAdapter.compile();
    expect(stale).toMatchObject({ accepted: false, reason: "stale" });
    expect(staleAdapter.applicationAppearanceCandidate()).toBeUndefined();

    let resolveCompile!: (reply: PairedV2CompileResponse) => void;
    const delayedBridge = makeBridge(() => new Promise((resolve) => { resolveCompile = resolve; }));
    const adapter = openAdapter(delayedBridge);
    const pending = adapter.compile();
    adapter.reopen(openInput("reopened-session", "reopened-document"));
    resolveCompile(compileReply(SESSION, 1));
    await expect(pending).resolves.toMatchObject({ accepted: false, reason: "reopened" });
    expect(adapter.snapshot()).toMatchObject({ lifecycle: "ready", capability: { sessionId: "reopened-session" } });
    expect(adapter.snapshot().authoring?.latestSuccessful).toBeUndefined();

    let resolveDisposed!: (reply: PairedV2CompileResponse) => void;
    const disposedBridge = makeBridge(() => new Promise((resolve) => { resolveDisposed = resolve; }));
    const disposedAdapter = openAdapter(disposedBridge);
    const disposedPending = disposedAdapter.compile();
    disposedAdapter.dispose();
    resolveDisposed(compileReply(SESSION, 1));
    await expect(disposedPending).resolves.toMatchObject({ accepted: false, reason: "disposed" });
    expect(disposedAdapter.snapshot()).toMatchObject({ lifecycle: "disposed", pendingCompile: false });
  });

  it("freezes any confirmed save until explicit reopen without rebasing the opened source", async () => {
    const bridge = makeBridge(async () => compileReply());
    const adapter = openAdapter(bridge);
    adapter.setEdit({ kind: "set-color", path: "color.dark.primaryAction", value: "#123456" });
    await adapter.compile();
    const edited = await adapter.save("edited");
    expect(edited.saved).toBe(true);
    expect(adapter.snapshot()).toMatchObject({ sourceMode: "custody", savedFrozen: true });
    expect(bridge.saveV2).toHaveBeenNthCalledWith(1, expect.objectContaining({
      saveMode: "edited",
      documentId: "developer-document",
      expectedParentSourceSha256: HASH_A,
      expectedCompileRawSourceSha256: HASH_B,
      expectedCompileCanonicalDigest: HASH_C,
    }));
    expect(adapter.snapshot().authoring?.baseline).toMatchObject({
      rawSourceSha256: HASH_A,
      canonicalDigest: HASH_B,
    });

    await expect(adapter.save("new-document")).rejects.toMatchObject({ code: "saved-frozen" });
    expect(bridge.saveV2).toHaveBeenCalledTimes(1);
  });

  it("does not freeze on a cancelled custody save or a refused detached promotion", async () => {
    const cancelledBridge = makeBridge(
      async () => compileReply(),
      async (request) => ({
        cancelled: true,
        saved: false,
        sessionId: request.sessionId,
        uiRevision: request.uiRevision,
      }),
    );
    const cancelledAdapter = openAdapter(cancelledBridge);
    cancelledAdapter.setEdit({ kind: "set-color", path: "color.dark.primaryAction", value: "#123456" });
    await cancelledAdapter.compile();
    const cancelled = await cancelledAdapter.save("edited");
    expect(cancelled).toMatchObject({ cancelled: true, saved: false });
    expect(cancelledAdapter.snapshot()).toMatchObject({ sourceMode: "custody", savedFrozen: false });

    const refusedBridge = makeBridge(async (request) => {
      const reply = verifiedDetachedReply(request.sessionId) as PairedV2SuccessfulCompileResponse;
      return { ...reply, draft: { ...reply.draft, rawSourceSha256: HASH_B } };
    });
    const refusedAdapter = openAdapter(refusedBridge);
    const result = await refusedAdapter.promoteDetached(detachedInput("fresh-detached-session"));
    expect(result).toMatchObject({ accepted: false, reason: "refused" });
    expect(refusedAdapter.snapshot()).toMatchObject({
      lifecycle: "refused",
      savedFrozen: false,
      refusal: "detached-promotion-refused",
    });
  });

  it("reports closed save eligibility and keeps stale native save replies from changing state", async () => {
    const initialBridge = makeBridge(async () => compileReply());
    const noCompile = openAdapter(initialBridge);
    await expect(noCompile.save("edited")).rejects.toMatchObject({
      code: "save-not-eligible",
      saveReason: "no-successful-compile",
    });

    let resolveSave!: (reply: PairedV2SaveResponse) => void;
    const bridge = makeBridge(async () => compileReply(), () => new Promise((resolve) => { resolveSave = resolve; }));
    const adapter = openAdapter(bridge);
    adapter.setEdit({ kind: "set-color", path: "color.dark.primaryAction", value: "#123456" });
    await adapter.compile();
    const saving = adapter.save("edited");
    adapter.reopen(openInput("new-session", "new-document"));
    resolveSave(savedReply(SESSION, 1));
    await expect(saving).rejects.toMatchObject({ code: "stale-operation" });
    expect(adapter.snapshot().capability).toEqual({ supported: true, sessionId: "new-session" });
    expect(adapter.snapshot().authoring?.latestSuccessful).toBeUndefined();
  });

  it("promotes a detached candidate only from a fresh verified empty-edit compile", async () => {
    const bridge = makeBridge(
      async (request) => verifiedDetachedReply(request.sessionId),
      async (request) => ({
        cancelled: false,
        saved: true,
        sessionId: request.sessionId,
        uiRevision: request.uiRevision,
        document: {
          documentId: "detached-new-document",
          rawSourceSha256: HASH_A,
          canonicalDigest: HASH_B,
          displayName: "detached-new-document.profile.json",
        },
      }),
    );
    const adapter = new PairedV2UiAdapter(bridge);
    const result = await adapter.promoteDetached(detachedInput("fresh-detached-session"));

    expect(result).toMatchObject({ accepted: true, response: { status: "success", uiRevision: 0 } });
    expect(bridge.compileV2).toHaveBeenCalledWith({
      source: {
        rawSourceBase64: SOURCE,
        expectedRawSourceSha256: HASH_A,
        expectedCanonicalDigest: HASH_B,
      },
      edits: [],
      uiRevision: 0,
      sessionId: "fresh-detached-session",
    });
    const snapshot = adapter.snapshot();
    expect(snapshot).toMatchObject({
      lifecycle: "ready",
      sourceMode: "detached",
      capability: { supported: true, sessionId: "fresh-detached-session" },
      detachedSource: {
        sourceBytesBase64: SOURCE,
        rawSourceSha256: HASH_A,
        canonicalDigest: HASH_B,
        verificationStatus: "verified",
        isTransformed: false,
      },
    });
    expect(snapshot.document).toBeUndefined();
    expect(snapshot.authoring?.baseline).toMatchObject({ sourceKind: "detached", rawSourceBase64: SOURCE });
    await expect(adapter.save("edited")).rejects.toMatchObject({
      code: "save-not-eligible",
      saveReason: "detached-no-custody",
    });
    const saved = await adapter.save("new-document");
    expect(saved.saved).toBe(true);
    expect(bridge.saveV2.mock.calls[0]?.[0]).not.toHaveProperty("documentId");
    expect(adapter.snapshot()).toMatchObject({ sourceMode: "detached", savedFrozen: true });
    expect(() => adapter.setEdit({ kind: "set-color", path: "color.dark.primaryAction", value: "#123456" })).toThrow(
      PairedV2UiAdapterError,
    );
    expect(adapter.snapshot().document).toBeUndefined();
  });

  it("refuses mismatched detached verification and never falls back to the prior custody session", async () => {
    const bridge = makeBridge(async (request) => {
      const reply = verifiedDetachedReply(request.sessionId) as PairedV2SuccessfulCompileResponse;
      return { ...reply, draft: { ...reply.draft, rawSourceSha256: HASH_B } };
    });
    const adapter = openAdapter(bridge);
    const result = await adapter.promoteDetached(detachedInput("fresh-detached-session"));

    expect(result).toMatchObject({ accepted: false, reason: "refused" });
    expect(adapter.snapshot()).toMatchObject({ lifecycle: "refused", refusal: "detached-promotion-refused" });
    expect(adapter.snapshot().document).toBeUndefined();
    expect(adapter.snapshot().authoring).toBeUndefined();
    expect(() => adapter.setEdit({ kind: "set-color", path: "color.dark.primaryAction", value: "#123456" })).toThrow(
      PairedV2UiAdapterError,
    );
  });

  it("retires custody before rejecting a malformed detached promotion input", async () => {
    const bridge = makeBridge(async () => verifiedDetachedReply());
    const adapter = openAdapter(bridge);

    await expect(adapter.promoteDetached({
      mode: "detached",
      capability: { supported: true, sessionId: "fresh-detached-session" },
      sourceBytesBase64: "not-base64",
      expectedRawSourceSha256: HASH_A,
      expectedCanonicalDigest: HASH_B,
    })).rejects.toMatchObject({ code: "invalid-open-document" });
    expect(adapter.snapshot()).toMatchObject({ lifecycle: "refused", refusal: "detached-promotion-refused" });
    expect(adapter.snapshot().document).toBeUndefined();
    expect(adapter.snapshot().authoring).toBeUndefined();
  });

  it("retires a pending detached promotion when an explicit reopen supersedes it", async () => {
    let resolvePromotion!: (reply: PairedV2CompileResponse) => void;
    const bridge = makeBridge(() => new Promise((resolve) => { resolvePromotion = resolve; }));
    const adapter = openAdapter(bridge);
    const promotion = adapter.promoteDetached(detachedInput("fresh-detached-session"));
    adapter.reopen(openInput("reopened-session", "reopened-document"));
    resolvePromotion(verifiedDetachedReply("fresh-detached-session"));

    await expect(promotion).resolves.toMatchObject({ accepted: false, reason: "reopened" });
    expect(adapter.snapshot()).toMatchObject({
      lifecycle: "ready",
      sourceMode: "custody",
      capability: { sessionId: "reopened-session" },
      document: { documentId: "reopened-document" },
    });
    expect(adapter.snapshot().detachedSource).toBeUndefined();
  });
});

