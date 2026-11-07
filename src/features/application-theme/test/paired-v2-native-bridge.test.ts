import { describe, expect, it } from "vitest";
import {
  PAIRED_V2_NATIVE_COMMANDS,
  PairedV2NativeBridgeError,
  type PairedV2NativeInvoke,
  TauriPairedV2NativeBridge,
} from "../paired-v2-native-bridge";
import editContractFixture from "./fixtures/paired-v2-edit-contract.json";

const SESSION = "paired-v2-bridge-test";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const SOURCE = "eA==";

function mappingReport(target: string) {
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

function compileReply(sessionId = SESSION, uiRevision = 4) {
  return {
    status: "partial" as const,
    valid: true as const,
    uiRevision,
    sessionId,
    draft: {
      profile: { schemaVersion: "tf-paired-profile-v2", name: "developer", version: "0.1.0" },
      sourceBytesBase64: SOURCE,
      rawSourceSha256: HASH_B,
      canonicalDigest: HASH_C,
      baselineRawSourceSha256: HASH_A,
      baselineCanonicalDigest: HASH_B,
      verificationStatus: "transformed" as const,
      isTransformed: true,
      parentSourceSha256: HASH_A,
    },
    solarSail: {
      valid: true,
      compiledCss: ":root { --target: solar; }",
      diagnostics: [],
      mappingReport: mappingReport("solar-sail"),
      sourceProfileSha256: HASH_B,
      canonicalDigest: HASH_C,
    },
    stellarLoom: {
      valid: true,
      compiledCss: ":root { --target: loom; }",
      diagnostics: [],
      mappingReport: mappingReport("stellar-loom"),
      sourceProfileSha256: HASH_B,
      canonicalDigest: HASH_C,
    },
    applicationAppearance: { valid: true, compiledCss: ":root { --primary: #123456; --tf-appearance-font-ui: monospace; }", sourceProfileSha256: HASH_B, canonicalDigest: HASH_C },
    applicationExtension: {
      valid: true,
      compiledCss: ":root { --extension: 1; }",
      diagnostics: [],
      mappingReport: {
        schema: "theme-forge.application-appearance-extension.v1",
        entries: [{ sourcePath: "radius.surface", target: "--tf-radius-surface", value: "8px" }],
        scope: "Supplementary application-only roles",
      },
      sourceProfileSha256: HASH_B,
      canonicalDigest: HASH_C,
    },
    diagnostics: [],
  };
}

function staleReply() {
  return {
    status: "stale" as const,
    valid: false as const,
    uiRevision: 4,
    sessionId: SESSION,
    solarSail: null,
    stellarLoom: null,
    applicationExtension: null,
    applicationAppearance: null,
    diagnostics: [],
  };
}

function compileRequest() {
  return {
    source: {
      rawSourceBase64: SOURCE,
      expectedRawSourceSha256: HASH_A,
      expectedCanonicalDigest: HASH_B,
    },
    edits: [{ kind: "set-color" as const, path: "color.dark.primaryAction", value: "#123456" }],
    uiRevision: 4,
    sessionId: SESSION,
  };
}

function retargetReply(reply: ReturnType<typeof compileReply>, rawSourceSha256: string, canonicalDigest: string) {
  reply.draft.rawSourceSha256 = rawSourceSha256;
  reply.draft.canonicalDigest = canonicalDigest;
  reply.solarSail.sourceProfileSha256 = rawSourceSha256;
  reply.solarSail.canonicalDigest = canonicalDigest;
  reply.solarSail.mappingReport.sourceSha256 = rawSourceSha256;
  reply.solarSail.mappingReport.canonicalDigest = canonicalDigest;
  reply.stellarLoom.sourceProfileSha256 = rawSourceSha256;
  reply.stellarLoom.canonicalDigest = canonicalDigest;
  reply.stellarLoom.mappingReport.sourceSha256 = rawSourceSha256;
  reply.stellarLoom.mappingReport.canonicalDigest = canonicalDigest;
  reply.applicationExtension.sourceProfileSha256 = rawSourceSha256;
  reply.applicationExtension.canonicalDigest = canonicalDigest;
  reply.applicationAppearance.sourceProfileSha256 = rawSourceSha256;
  reply.applicationAppearance.canonicalDigest = canonicalDigest;
  return reply;
}

function verifiedNoOpReply() {
  const reply = retargetReply(compileReply(), HASH_A, HASH_B);
  Object.assign(reply.draft, { verificationStatus: "verified", isTransformed: false });
  Reflect.deleteProperty(reply.draft, "parentSourceSha256");
  return reply;
}

function saveRequest() {
  return {
    sessionId: SESSION,
    documentId: "developer-document",
    draftSourceBase64: SOURCE,
    expectedDraftRawSourceSha256: HASH_B,
    expectedCanonicalDigest: HASH_C,
    expectedParentSourceSha256: HASH_A,
    expectedCompileRawSourceSha256: HASH_B,
    expectedCompileCanonicalDigest: HASH_C,
    expectedCompileUiRevision: 4,
    saveMode: "edited" as const,
    uiRevision: 4,
  };
}

function savedReply() {
  return {
    cancelled: false,
    saved: true,
    sessionId: SESSION,
    uiRevision: 4,
    document: {
      documentId: "developer-document",
      rawSourceSha256: HASH_B,
      canonicalDigest: HASH_C,
      displayName: "developer.profile.json",
    },
  };
}

function injectedInvoke(
  value: unknown | (() => unknown)
): { readonly invoke: PairedV2NativeInvoke; readonly calls: readonly { command: string; args: { request: unknown } }[] } {
  const calls: { command: string; args: { request: unknown } }[] = [];
  const invoke: PairedV2NativeInvoke = async (command, args) => {
    calls.push({ command, args });
    if (typeof value === "function") return (value as () => unknown)() as never;
    return value as never;
  };
  return { invoke, calls };
}

describe("paired v2 native bridge seam", () => {
  it("maps the versioned compile command and decodes a closed partial reply", async () => {
    const injected = injectedInvoke(compileReply());
    const bridge = new TauriPairedV2NativeBridge(injected.invoke);
    const request = compileRequest();
    const result = await bridge.compileV2(request);

    expect(result.status).toBe("partial");
    expect(result.valid).toBe(true);
    expect(injected.calls).toHaveLength(1);
    expect(injected.calls[0]).toMatchObject({
      command: PAIRED_V2_NATIVE_COMMANDS.compile,
      args: { request },
    });
    expect(injected.calls[0]?.args.request).not.toBe(request);
    expect(Object.isFrozen(injected.calls[0]?.args.request)).toBe(true);
  });

  it("returns native stale replies but rejects a mismatched session as a closed response error", async () => {
    const stale = injectedInvoke(staleReply());
    await expect(new TauriPairedV2NativeBridge(stale.invoke).compileV2(compileRequest())).resolves.toMatchObject({
      status: "stale",
      valid: false,
      solarSail: null,
    });

    const wrongSession = injectedInvoke(compileReply("other-session"));
    await expect(new TauriPairedV2NativeBridge(wrongSession.invoke).compileV2(compileRequest())).rejects.toMatchObject({
      code: "invalid-response",
    });
  });

  it("maps save through the separate command and checks its expected session/revision", async () => {
    const injected = injectedInvoke(savedReply());
    const bridge = new TauriPairedV2NativeBridge(injected.invoke);
    const result = await bridge.saveV2(saveRequest());

    expect(result).toMatchObject({ saved: true, cancelled: false, sessionId: SESSION, uiRevision: 4 });
    expect(injected.calls[0]).toMatchObject({
      command: PAIRED_V2_NATIVE_COMMANDS.save,
      args: { request: saveRequest() },
    });

    for (const malformed of [
      { ...savedReply(), document: undefined },
      { ...savedReply(), cancelled: true },
      { ...savedReply(), error: { code: "FAILED", message: "Operation failed." } },
      { ...savedReply(), document: { ...savedReply().document, rawSourceSha256: HASH_A } },
      { ...savedReply(), document: { ...savedReply().document, documentId: "other-document" } },
    ]) {
      await expect(new TauriPairedV2NativeBridge(injectedInvoke(malformed).invoke).saveV2(saveRequest()))
        .rejects.toMatchObject({ code: "invalid-response" });
    }
    const wrongRevision = injectedInvoke({ ...savedReply(), uiRevision: 3 });
    await expect(new TauriPairedV2NativeBridge(wrongRevision.invoke).saveV2(saveRequest())).rejects.toMatchObject({
      code: "invalid-response",
    });
  });

  it("rejects malformed requests before invoking native code", async () => {
    const injected = injectedInvoke(compileReply());
    const bridge = new TauriPairedV2NativeBridge(injected.invoke);

    await expect(
      bridge.compileV2({ ...compileRequest(), unexpected: true } as never)
    ).rejects.toBeInstanceOf(PairedV2NativeBridgeError);
    await expect(
      bridge.compileV2({
        ...compileRequest(),
        edits: [
          { kind: "set-typography", path: "typography.body.size", value: 18 },
          { kind: "set-color", path: "color.dark.primaryAction", value: "#123456" },
        ],
      } as never)
    ).rejects.toMatchObject({ code: "invalid-request" });
    expect(injected.calls).toHaveLength(0);
  });

  it("applies every shared edit-contract case at the native bridge boundary", async () => {
    for (const fixtureCase of editContractFixture.cases) {
      const injected = injectedInvoke(compileReply());
      const bridge = new TauriPairedV2NativeBridge(injected.invoke);
      const request = {
        ...compileRequest(),
        edits: [fixtureCase.edit],
      } as never;
      if (fixtureCase.expectedAllowed) {
        await expect(bridge.compileV2(request)).resolves.toMatchObject({ valid: true });
        expect(injected.calls).toHaveLength(1);
      } else {
        await expect(bridge.compileV2(request)).rejects.toMatchObject({ code: "invalid-request" });
        expect(injected.calls).toHaveLength(0);
      }
    }
  });

  it("keeps clear-optional transport paths aligned with recipe-supported optional fields", async () => {
    const invalidPaths = [
      "color.light.selection",
      "color.dark.selectionText",
      "radius.surface",
    ];
    for (const path of invalidPaths) {
      const injected = injectedInvoke(compileReply());
      const bridge = new TauriPairedV2NativeBridge(injected.invoke);
      await expect(bridge.compileV2({
        ...compileRequest(),
        edits: [{ kind: "clear-optional", path }],
      } as never)).rejects.toMatchObject({ code: "invalid-request" });
      expect(injected.calls).toHaveLength(0);
    }

    for (const path of ["color.dark.hover", "color.dark.active", "radius.control", "radius.overlay"]) {
      const injected = injectedInvoke(compileReply());
      const bridge = new TauriPairedV2NativeBridge(injected.invoke);
      await expect(bridge.compileV2({
        ...compileRequest(),
        edits: [{ kind: "clear-optional", path }],
      } as never)).resolves.toMatchObject({ valid: true });
      expect(injected.calls).toHaveLength(1);
    }
  });

  it("rejects recipe-required value shapes before native invocation", async () => {
    const invalidEdits = [
      { kind: "set-color", path: "color.dark.selection", value: "transparent" },
      { kind: "set-color", path: "color.light.selectionText", value: "#12345" },
      { kind: "set-typography", path: "typography.ui.family", value: "Inter" },
      { kind: "set-typography", path: "typography.body.family", value: 18 },
      { kind: "set-typography", path: "typography.body.size", value: 18 },
      { kind: "set-typography", path: "typography.body.lineHeight", value: "1.5" },
      { kind: "set-typography", path: "typography.body.lineHeight", value: 0 },
      { kind: "set-radius", path: "radius.surface", value: "8" },
    ];
    for (const edit of invalidEdits) {
      const injected = injectedInvoke(compileReply());
      const bridge = new TauriPairedV2NativeBridge(injected.invoke);
      await expect(bridge.compileV2({ ...compileRequest(), edits: [edit] } as never))
        .rejects.toMatchObject({ code: "invalid-request" });
      expect(injected.calls).toHaveLength(0);
    }

    const validEdits = [
      { kind: "set-color", path: "color.dark.selection", value: "#123456" },
      { kind: "set-color", path: "color.light.selectionText", value: "#abcdef" },
      { kind: "set-typography", path: "typography.ui.family", value: "system-ui" },
      { kind: "set-typography", path: "typography.body.family", value: "sans-serif" },
      { kind: "set-typography", path: "typography.body.size", value: "16px" },
      { kind: "set-typography", path: "typography.body.lineHeight", value: 1.5 },
      { kind: "set-radius", path: "radius.surface", value: "0.5rem" },
    ];
    for (const edit of validEdits) {
      const injected = injectedInvoke(compileReply());
      const bridge = new TauriPairedV2NativeBridge(injected.invoke);
      await expect(bridge.compileV2({ ...compileRequest(), edits: [edit] } as never))
        .resolves.toMatchObject({ valid: true });
      expect(injected.calls).toHaveLength(1);
    }

    for (const edit of [
      { kind: "set-color", path: "color.dark.primaryAction", value: "é".repeat(5) },
      { kind: "set-typography", path: "typography.body.family", value: "é".repeat(251) },
      { kind: "set-typography", path: "typography.body.family", value: `${"a".repeat(101)}, sans-serif` },
      { kind: "set-typography", path: "typography.body.size", value: "a".repeat(65) },
    ]) {
      const injected = injectedInvoke(compileReply());
      const bridge = new TauriPairedV2NativeBridge(injected.invoke);
      await expect(bridge.compileV2({ ...compileRequest(), edits: [edit] } as never))
        .rejects.toMatchObject({ code: "invalid-request" });
      expect(injected.calls).toHaveLength(0);
    }
  });

  it("binds returned draft lineage and edit mode to the requested source custody", async () => {
    const baselineMismatch = compileReply();
    baselineMismatch.draft.baselineRawSourceSha256 = HASH_C;
    await expect(new TauriPairedV2NativeBridge(injectedInvoke(baselineMismatch).invoke).compileV2(compileRequest()))
      .rejects.toMatchObject({ code: "invalid-response" });

    const canonicalMismatch = compileReply();
    canonicalMismatch.draft.baselineCanonicalDigest = HASH_C;
    await expect(new TauriPairedV2NativeBridge(injectedInvoke(canonicalMismatch).invoke).compileV2(compileRequest()))
      .rejects.toMatchObject({ code: "invalid-response" });

    const transformedWithoutEdits = compileReply();
    await expect(new TauriPairedV2NativeBridge(injectedInvoke(transformedWithoutEdits).invoke).compileV2({
      ...compileRequest(),
      edits: [],
    }))
      .rejects.toMatchObject({ code: "invalid-response" });

    const selfParent = compileReply();
    selfParent.draft.baselineRawSourceSha256 = HASH_B;
    selfParent.draft.baselineCanonicalDigest = HASH_C;
    selfParent.draft.parentSourceSha256 = HASH_B;
    const selfParentRequest = {
      ...compileRequest(),
      source: {
        ...compileRequest().source,
        expectedRawSourceSha256: HASH_B,
        expectedCanonicalDigest: HASH_C,
      },
    };
    await expect(new TauriPairedV2NativeBridge(injectedInvoke(selfParent).invoke).compileV2(selfParentRequest))
      .rejects.toMatchObject({ code: "invalid-response" });

    const verified = retargetReply(compileReply(), HASH_A, HASH_B);
    Object.assign(verified.draft, { verificationStatus: "verified", isTransformed: false });
    Reflect.deleteProperty(verified.draft, "parentSourceSha256");
    await expect(new TauriPairedV2NativeBridge(injectedInvoke(verified).invoke).compileV2({
      ...compileRequest(),
      edits: [],
    })).resolves.toMatchObject({ valid: true, draft: { verificationStatus: "verified" } });

    const verifiedWithEdits = verifiedNoOpReply();
    const noOp = await new TauriPairedV2NativeBridge(injectedInvoke(verifiedWithEdits).invoke).compileV2(compileRequest());
    expect(noOp).toMatchObject({
      valid: true,
      draft: {
        verificationStatus: "verified",
        isTransformed: false,
        rawSourceSha256: HASH_A,
        canonicalDigest: HASH_B,
      },
    });
    if (!noOp.valid) throw new Error("verified no-op response was not valid");
    expect(noOp.draft.parentSourceSha256).toBeUndefined();

    const wrongBytes = verifiedNoOpReply();
    wrongBytes.draft.sourceBytesBase64 = "eQ==";
    await expect(new TauriPairedV2NativeBridge(injectedInvoke(wrongBytes).invoke).compileV2(compileRequest()))
      .rejects.toMatchObject({ code: "invalid-response" });
  });

  it("binds a verified detached draft to the exact requested source bytes", async () => {
    const mismatched = retargetReply(compileReply(), HASH_A, HASH_B);
    Object.assign(mismatched.draft, { verificationStatus: "verified", isTransformed: false });
    Reflect.deleteProperty(mismatched.draft, "parentSourceSha256");
    mismatched.draft.sourceBytesBase64 = "eQ==";
    await expect(new TauriPairedV2NativeBridge(injectedInvoke(mismatched).invoke).compileV2({
      ...compileRequest(),
      edits: [],
    })).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("accepts a transformed draft for the complete bounded three-edit request", async () => {
    const request = {
      ...compileRequest(),
      edits: [
        { kind: "set-color" as const, path: "color.dark.primaryAction", value: "#123456" },
        { kind: "set-typography" as const, path: "typography.body.lineHeight", value: 1.5 },
        { kind: "set-typography" as const, path: "typography.body.size", value: "16px" },
      ],
    };
    const result = await new TauriPairedV2NativeBridge(injectedInvoke(compileReply()).invoke).compileV2(request);
    expect(result).toMatchObject({
      valid: true,
      draft: {
        verificationStatus: "transformed",
        isTransformed: true,
        parentSourceSha256: HASH_A,
        rawSourceSha256: HASH_B,
        canonicalDigest: HASH_C,
      },
    });
  });

  it("fails closed for malformed replies and native rejection without exposing native text", async () => {
    const malformed = injectedInvoke({ ...compileReply(), extra: "not allowed" });
    await expect(new TauriPairedV2NativeBridge(malformed.invoke).compileV2(compileRequest())).rejects.toMatchObject({
      code: "invalid-response",
    });

    const privateFailure: PairedV2NativeInvoke = async () => {
      throw new Error("private native filesystem path");
    };
    const error = await new TauriPairedV2NativeBridge(privateFailure)
      .compileV2(compileRequest())
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(PairedV2NativeBridgeError);
    expect(error).toMatchObject({ code: "native-rejected" });
    expect(String((error as Error).message)).not.toContain("private native filesystem path");
  });
});

