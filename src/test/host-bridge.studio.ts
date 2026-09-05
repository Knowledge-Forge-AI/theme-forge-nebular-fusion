import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  Channel: class MockChannel<T> {
    onmessage: (value: T) => void;
    constructor(onmessage?: (value: T) => void) { this.onmessage = onmessage ?? (() => undefined); }
  },
}));

import {
  STUDIO_HOST_COMMANDS, StudioHostValidationError, TauriStudioHostBridge,
  validateHostEvent, validateHostStatus, validateProjectResult, validateSourceResult,
} from "../host/studio-host-bridge";

const status = {
  schemaVersion: 1, studioVersion: "0.1.0", manifestDigest: "a".repeat(64), state: "ready",
  selectedProtocolVersion: "1.2", serverVersion: "0.1.0", methods: ["assetDiff", "assetGet", "assetList", "assetValidate", "cancellation", "mutationPlans", "planApply", "previewStatus", "progress", "projectList", "projectOpen", "sourceAnalyze", "sourceOpen", "workspaceOpen", "workspaceStatus"],
  capabilities: {
    baseMethods: ["assetDiff", "assetGet", "assetList", "assetValidate", "cancellation", "mutationPlans", "planApply", "previewStatus", "progress", "projectList", "projectOpen", "sourceAnalyze", "sourceOpen", "workspaceOpen", "workspaceStatus"],
    brandReads: ["consumerLockStatus", "consumerProfileList", "diff", "exportCapability", "exportStatus", "familyList", "qaProfileGet", "qaProfileList", "qaResultGet", "recipeGraph", "status", "tokenList", "visualEvidenceGet"],
    brandSourcePurposes: ["brandBundle", "npmInstalledPackage"],
    limits: { assetPageSizeDefault: 64, assetPageSizeMax: 128, assetPageSizeMin: 1, brandPageSizeDefault: 64, brandPageSizeMax: 128, brandPageSizeMin: 1, maxDiffResultBytes: 16_777_216, maxFrameBytes: 16_777_216, maxQaResultBytes: 16_777_216 },
    planCapabilities: { consumerInstall: true, consumerSync: true, derive: true, export: true, qaBaseline: true },
  },
  raster: { available: true, qualificationIdentity: "sha256:4bb08e677b87ef1ca74c35c5c22f547cebef4c22a1f98a08a9246fd9397d0f11" },
  projectOpenCount: 0, sourceOpenCount: 0, lastReasonCode: null,
};

describe("closed Tauri Studio host bridge", () => {
  beforeEach(() => invokeMock.mockReset());

  it("invokes only the seven fixed lifecycle, picker, and plan commands", async () => {
    invokeMock.mockResolvedValue(status);
    const bridge = new TauriStudioHostBridge();
    await bridge.getStatus();
    await bridge.startHost(() => undefined);
    invokeMock.mockResolvedValueOnce({ cancelled: true });
    await bridge.selectProject("existing");
    invokeMock.mockResolvedValueOnce({ cancelled: true });
    await bridge.selectSource("brand-bundle");
    invokeMock.mockResolvedValueOnce({ kind: "discarded" });
    await bridge.startPlanOperation({ kind: "discard", planHandle: `plan_${"a".repeat(64)}` }, () => undefined);
    invokeMock.mockResolvedValueOnce({ accepted: true });
    await bridge.cancelPlanOperation(`operation_${"b".repeat(64)}`);
    invokeMock.mockResolvedValueOnce(undefined);
    await bridge.shutdownHost();
    expect(invokeMock.mock.calls.map((call) => call[0])).toEqual([
      STUDIO_HOST_COMMANDS.status, STUDIO_HOST_COMMANDS.start, STUDIO_HOST_COMMANDS.selectProject,
      STUDIO_HOST_COMMANDS.selectSource, STUDIO_HOST_COMMANDS.planStart,
      STUDIO_HOST_COMMANDS.planCancel, STUDIO_HOST_COMMANDS.shutdown,
    ]);
    expect(invokeMock.mock.calls[2]?.[1]).toEqual({ mode: "existing" });
    expect(invokeMock.mock.calls[3]?.[1]).toEqual({ kind: "brand-bundle" });
    expect(invokeMock.mock.calls[5]?.[1]).toEqual({ request: { operationHandle: `operation_${"b".repeat(64)}` } });
  });

  it("runtime-validates dynamic DTOs, exact keys, handles, and digests", () => {
    expect(validateHostStatus(status).manifestDigest).toBe("a".repeat(64));
    expect(validateHostEvent({ schemaVersion: 1, sequence: 3, state: "crashed", reasonCode: "sidecar-crashed" }).state).toBe("crashed");
    expect(validateProjectResult({ cancelled: false, project: { projectHandle: "project_safe", rootKind: "project", schemaVersion: 1, name: "Demo", canonicalDigest: `sha256:${"b".repeat(64)}`, assetCount: 2, companionCount: 0, state: null } }).cancelled).toBe(false);
    expect(validateSourceResult({ cancelled: false, source: { sourceHandle: "source_safe", rootKind: "source", sourceKind: null, authorityKind: "brand-bundle", digest: null, packageId: "brand", brandVersion: "1.0.0", brandSystemDigest: `sha256:${"c".repeat(64)}`, candidateCount: null, profileCount: 1, assetCount: 2, companionCount: 0 } }).cancelled).toBe(false);
    expect(() => validateHostStatus({ ...status, extra: true })).toThrow(StudioHostValidationError);
    expect(() => validateHostStatus({ ...status, selectedProtocolVersion: "1.0" })).toThrow(StudioHostValidationError);
    expect(() => validateProjectResult({ cancelled: false, project: { projectHandle: "/private/path" } })).toThrow(StudioHostValidationError);
  });

  it("freezes ready and non-ready state families and reason combinations", () => {
    const unavailable = {
      ...status,
      state: "stopped",
      selectedProtocolVersion: null,
      serverVersion: null,
      methods: [],
      capabilities: null,
      raster: { available: false, qualificationIdentity: null },
      lastReasonCode: null,
    };
    for (const state of ["not-started", "verifying", "starting", "initializing", "stopping", "stopped"]) {
      expect(validateHostStatus({ ...unavailable, state }).state).toBe(state);
    }
    expect(validateHostStatus({ ...unavailable, state: "crashed", lastReasonCode: "sidecar-crashed" }).state).toBe("crashed");
    expect(validateHostStatus({ ...unavailable, state: "failed", lastReasonCode: "sidecar-artifact-invalid" }).state).toBe("failed");
    for (const candidate of [
      { ...status, serverVersion: "0.2.0" },
      { ...status, methods: [...status.methods].reverse() },
      { ...status, methods: [...status.methods, status.methods[0]] },
      { ...status, lastReasonCode: "sidecar-crashed" },
      { ...unavailable, state: "starting", selectedProtocolVersion: "1.2" },
      { ...unavailable, state: "stopped", serverVersion: "0.1.0" },
      { ...unavailable, state: "failed", lastReasonCode: null },
      { ...unavailable, state: "crashed", lastReasonCode: "sidecar-request-timeout" },
      { ...unavailable, state: "not-started", raster: status.raster },
    ]) expect(() => validateHostStatus(candidate)).toThrow(StudioHostValidationError);
  });

  it("propagates rejected invokes without a fixture fallback", async () => {
    invokeMock.mockRejectedValueOnce(new Error("host rejected"));
    await expect(new TauriStudioHostBridge().getStatus()).rejects.toThrow("host rejected");
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});
