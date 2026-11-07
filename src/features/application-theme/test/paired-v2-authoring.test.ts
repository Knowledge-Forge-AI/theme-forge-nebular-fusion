import { describe, expect, it } from "vitest";
import {
  decodePairedV2CompileResponse,
  PairedV2ValidationError,
} from "../paired-v2-bridge-decoder";
import { PairedV2AuthoringSession } from "../paired-v2-authoring";
import { isPairedV2EditContractCaseAllowed } from "../paired-v2-edit-contract";
import { PAIRED_V2_LIMITS } from "../paired-v2-authoring-types";
import editContractFixture from "./fixtures/paired-v2-edit-contract.json";

const SESSION = "paired-v2-test-session";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const SOURCE = "eA==";

function engineReport(target: string) {
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
    options: { sourceProfileSha256: HASH_A },
    entries: [{
      sourcePath: "color.dark.primaryAction",
      sourceValue: "#123456",
      classification: "consumed",
      reason: "Mapped by adapter",
      targetPath: "--primary",
      targetValue: "#123456",
    }],
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
    digest: HASH_C,
  };
}

function response(sessionId = SESSION, uiRevision = 0, status: "success" | "partial" = "success") {
  return {
    status,
    valid: true,
    uiRevision,
    sessionId,
    draft: {
      profile: { schemaVersion: "tf-paired-profile-v2", name: "developer", version: "0.1.0" },
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
      compiledCss: ":root { --target: solar; }",
      diagnostics: [],
      mappingReport: engineReport("solar-sail"),
      sourceProfileSha256: HASH_B,
      canonicalDigest: HASH_C,
    },
    stellarLoom: {
      valid: true,
      compiledCss: ":root { --target: loom; }",
      diagnostics: [],
      mappingReport: engineReport("stellar-loom"),
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
        entries: [{
          sourcePath: "typography.ui.family",
          target: "--tf-appearance-font-ui",
          value: "monospace",
        }],
        scope: "Supplementary application-only roles",
      },
      sourceProfileSha256: HASH_B,
      canonicalDigest: HASH_C,
    },
    diagnostics: [],
  };
}

function documentSession() {
  return new PairedV2AuthoringSession(SESSION, {
    sourceKind: "document",
    documentId: "developer-document",
    rawSourceSha256: HASH_A,
    canonicalDigest: HASH_B,
  });
}

describe("paired v2 authoring capability", () => {
  it("accepts omitted mapping-entry reasons while rejecting empty present reasons", () => {
    const omitted = response();
    const entry = omitted.solarSail.mappingReport.entries[0]!;
    delete (entry as { reason?: string }).reason;
    const decoded = decodePairedV2CompileResponse(omitted);
    if (decoded.status !== "success" && decoded.status !== "partial") throw new Error("expected success");
    expect(decoded.solarSail.mappingReport.entries[0]?.reason).toBeUndefined();
    const empty = response();
    empty.solarSail.mappingReport.entries[0]!.reason = "";
    expect(() => decodePairedV2CompileResponse(empty)).toThrow(PairedV2ValidationError);
  });


  it("retains every edit in a complete deduplicated map", () => {
    const session = documentSession();
    expect(session.setEdit({ kind: "set-color", path: "color.dark.primaryAction", value: "#123456" })).toBe(1);
    expect(session.setEdit({ kind: "set-typography", path: "typography.body.size", value: "18px" })).toBe(2);
    expect(session.setEdit({ kind: "set-radius", path: "radius.surface", value: "8px" })).toBe(3);
    expect(session.startCompile().request.edits).toEqual([
      { kind: "set-color", path: "color.dark.primaryAction", value: "#123456" },
      { kind: "set-radius", path: "radius.surface", value: "8px" },
      { kind: "set-typography", path: "typography.body.size", value: "18px" },
    ]);
  });

  it("keeps the pure session edit grammar aligned with the application recipe slice", () => {
    for (const edit of [
      { kind: "clear-optional", path: "color.light.selection" },
      { kind: "clear-optional", path: "color.dark.selectionText" },
      { kind: "clear-optional", path: "radius.surface" },
      { kind: "set-color", path: "color.dark.selection", value: "transparent" },
      { kind: "set-color", path: "color.light.selectionText", value: "#12345" },
      { kind: "set-typography", path: "typography.ui.family", value: "Inter" },
      { kind: "set-radius", path: "radius.surface", value: "8" },
    ]) {
      expect(() => documentSession().setEdit(edit as never)).toThrow("PairedV2AuthoringError");
    }

    for (const edit of [
      { kind: "clear-optional", path: "color.dark.hover" },
      { kind: "clear-optional", path: "color.light.active" },
      { kind: "clear-optional", path: "radius.control" },
      { kind: "clear-optional", path: "radius.overlay" },
      { kind: "set-color", path: "color.dark.selection", value: "#123456" },
      { kind: "set-typography", path: "typography.ui.family", value: "system-ui" },
      { kind: "set-radius", path: "radius.surface", value: "0.5rem" },
    ]) {
      expect(() => documentSession().setEdit(edit as never)).not.toThrow();
    }
  });

  it("matches the shared cross-language edit-contract fixture", () => {
    expect(editContractFixture.schema).toBe("tf-paired-v2-edit-contract-fixture-v1");
    for (const fixtureCase of editContractFixture.cases) {
      expect(isPairedV2EditContractCaseAllowed(fixtureCase.edit), fixtureCase.name)
        .toBe(fixtureCase.expectedAllowed);
      const session = documentSession();
      const apply = () => session.setEdit(fixtureCase.edit as never);
      if (fixtureCase.expectedAllowed) {
        expect(apply, fixtureCase.name).not.toThrow();
      } else {
        expect(apply, fixtureCase.name).toThrow("PairedV2AuthoringError");
      }
    }
    expect(isPairedV2EditContractCaseAllowed({
      ...editContractFixture.cases[0]!.edit,
      unexpected: true,
    })).toBe(false);
  });

  it("accepts non-fatal partial results and requires both current preview ACKs", () => {
    const session = documentSession();
    const ticket = session.startCompile();
    expect(session.acceptCompile(ticket, response(SESSION, 0, "partial")).accepted).toBe(true);
    expect(session.canAdoptPaired()).toBe(false);
    for (const preview of ["application", "starlight"] as const) {
      expect(session.recordPreviewAck({
        preview,
        sessionId: SESSION,
        uiRevision: 0,
        rawSourceSha256: HASH_B,
        canonicalDigest: HASH_C,
        frameId: preview + "-frame",
      })).toBe(true);
    }
    expect(session.canAdoptPaired()).toBe(true);
    expect(session.recordPreviewAck({
      preview: "application",
      sessionId: SESSION,
      uiRevision: 0,
      rawSourceSha256: HASH_A,
      canonicalDigest: HASH_C,
      frameId: "stale",
    })).toBe(false);
  });

  it("rejects stale and reset replies without retaining a reset result", () => {
    const session = documentSession();
    const ticket = session.startCompile();
    expect(session.acceptCompile(ticket, response()).accepted).toBe(true);
    const firstRecompile = session.startCompile();
    const secondRecompile = session.startCompile();
    expect(session.acceptCompile(firstRecompile, response())).toMatchObject({
      accepted: false,
      reason: "superseded",
    });
    expect(session.latestCompile).toBeUndefined();
    const stale = session.acceptCompile(secondRecompile, {
      status: "stale",
      valid: false,
      uiRevision: 0,
      sessionId: SESSION,
      solarSail: null,
      stellarLoom: null,
      applicationExtension: null,
    applicationAppearance: null,
      diagnostics: [],
    });
    expect(stale).toMatchObject({ accepted: false, reason: "stale" });
    expect(session.latestCompile).toBeUndefined();
    const pending = session.startCompile();
    expect(session.safeSave("new-document")).toEqual({ eligible: false, reason: "no-successful-compile" });
    expect(session.canAdoptPaired()).toBe(false);
    expect(session.acceptCompile(pending, response())).toMatchObject({ accepted: true });
    const oldTicket = session.startCompile();
    session.reset("new-session");
    expect(session.acceptCompile(oldTicket, response())).toMatchObject({
      accepted: false,
      reason: "session-mismatch",
    });
    expect(session.latestCompile).toBeUndefined();
  });

  it("prepares direct edited/new-document saves only for the latest compile", () => {
    const session = documentSession();
    expect(session.acceptCompile(session.startCompile(), response()).accepted).toBe(true);
    expect(session.safeSave("edited")).toMatchObject({
      eligible: true,
      request: {
        saveMode: "edited",
        documentId: "developer-document",
        expectedParentSourceSha256: HASH_A,
        expectedCompileUiRevision: 0,
      },
    });
    const detached = new PairedV2AuthoringSession(SESSION, {
      sourceKind: "detached",
      rawSourceBase64: SOURCE,
      rawSourceSha256: HASH_A,
      canonicalDigest: HASH_B,
    });
    expect(detached.acceptCompile(detached.startCompile(), response()).accepted).toBe(true);
    expect(detached.safeSave("edited")).toEqual({ eligible: false, reason: "detached-no-custody" });
    expect(detached.safeSave("new-document")).toMatchObject({ eligible: true });
    detached.setEdit({ kind: "clear-optional", path: "typography.ui.size" });
    expect(detached.safeSave("new-document")).toEqual({ eligible: false, reason: "compile-not-current" });
  });

  it("rejects unknown fields, mismatched identity, and over-budget transport", () => {
    expect(() => decodePairedV2CompileResponse({ ...response(), unexpected: true })).toThrow(PairedV2ValidationError);
    expect(() => decodePairedV2CompileResponse(response("wrong", 1), {
      expectedSessionId: SESSION,
      expectedUiRevision: 1,
    })).toThrow(PairedV2ValidationError);
    const overBudget = response();
    overBudget.solarSail.compiledCss = "x".repeat(PAIRED_V2_LIMITS.targetCssBytes + 1);
    expect(() => decodePairedV2CompileResponse(overBudget)).toThrow(PairedV2ValidationError);
    const omittedAppearance = response() as Record<string, unknown>;
    delete omittedAppearance.applicationAppearance;
    expect(() => decodePairedV2CompileResponse(omittedAppearance)).toThrow(PairedV2ValidationError);
    const wrongReport = response();
    wrongReport.solarSail.mappingReport.sourceSha256 = HASH_A;
    expect(() => decodePairedV2CompileResponse(wrongReport)).toThrow(PairedV2ValidationError);
    const wrongAppearance = response();
    wrongAppearance.applicationAppearance.canonicalDigest = HASH_A;
    expect(() => decodePairedV2CompileResponse(wrongAppearance)).toThrow(PairedV2ValidationError);
    const inconsistent = response();
    inconsistent.draft.verificationStatus = "verified";
    expect(() => decodePairedV2CompileResponse(inconsistent)).toThrow(PairedV2ValidationError);
    const verifiedLineageMismatch = response();
    Object.assign(verifiedLineageMismatch.draft, { verificationStatus: "verified", isTransformed: false });
    Reflect.deleteProperty(verifiedLineageMismatch.draft, "parentSourceSha256");
    expect(() => decodePairedV2CompileResponse(verifiedLineageMismatch)).toThrow(PairedV2ValidationError);
    const selfParent = response();
    selfParent.draft.parentSourceSha256 = HASH_B;
    expect(() => decodePairedV2CompileResponse(selfParent)).toThrow(PairedV2ValidationError);
    expect(() => new PairedV2AuthoringSession(SESSION, {
      sourceKind: "unknown",
      rawSourceBase64: SOURCE,
      rawSourceSha256: HASH_A,
      canonicalDigest: HASH_B,
    } as never)).toThrow("sourceKind is unsupported");
  });

  it("keeps stale failure replies report-free and null-targeted", () => {
    const failure = decodePairedV2CompileResponse({
      status: "stale",
      valid: false,
      uiRevision: 3,
      sessionId: SESSION,
      solarSail: null,
      stellarLoom: null,
      applicationExtension: null,
    applicationAppearance: null,
      diagnostics: [],
    });
    expect(failure).toMatchObject({
      status: "stale",
      valid: false,
      solarSail: null,
      stellarLoom: null,
      applicationExtension: null,
    applicationAppearance: null,
    });
    expect(() => decodePairedV2CompileResponse({
      status: "stale",
      valid: false,
      uiRevision: 3,
      sessionId: SESSION,
      solarSail: {},
      stellarLoom: null,
      applicationExtension: null,
    applicationAppearance: null,
      diagnostics: [],
    })).toThrow(PairedV2ValidationError);
  });

  it("clones and freezes accepted transport data without prototype or cycle hazards", () => {
    const raw = response();
    const options = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(options, "__proto__", {
      configurable: true,
      enumerable: true,
      value: { polluted: true },
    });
    raw.solarSail.mappingReport.options = options as { sourceProfileSha256: string };
    const decoded = decodePairedV2CompileResponse(raw);
    if (decoded.status !== "success" && decoded.status !== "partial") throw new Error("expected success response");
    raw.draft.profile.name = "changed";
    raw.solarSail.mappingReport.entries[0]!.reason = "changed";
    expect(decoded.draft?.profile.name).toBe("developer");
    expect(decoded.solarSail.mappingReport.entries[0]?.reason).toBe("Mapped by adapter");
    expect(Object.getPrototypeOf(decoded.solarSail.mappingReport.options)).toBe(null);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.draft?.profile)).toBe(true);

    const cyclic = response();
    cyclic.solarSail.mappingReport.options = { sourceProfileSha256: HASH_A };
    const cyclicOptions = cyclic.solarSail.mappingReport.options as {
      sourceProfileSha256: string;
    } & Record<string, unknown>;
    cyclicOptions.self = cyclicOptions;
    expect(() => decodePairedV2CompileResponse(cyclic)).toThrow(PairedV2ValidationError);
  });
});
