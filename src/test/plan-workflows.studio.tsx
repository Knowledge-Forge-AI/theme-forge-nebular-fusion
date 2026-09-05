import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { StudioBrandPlanClient } from "../brand-plans/StudioBrandPlanClient";
import type { BrandPlanMethod, StudioBrandPlanStartResult, StudioPlanSummary } from "../brand-plans/contracts";
import { StudioPlanValidationError, validatePlanEvent, validatePlanResult } from "../brand-plans/validators";
import { PlanWorkspace } from "../features/brand-plans/PlanWorkspace";

const digest: `sha256:${string}` = `sha256:${"a".repeat(64)}`;
const derive = { selectedRecipes: ["recipe-one"], transitiveRecipes: [], affectedTargets: ["asset-one"], createdCount: 1, updatedCount: 0, unchangedCount: 0, operationSummaries: [{ recipeId: "recipe-one", targetAssetId: "asset-one", operations: ["copy"] }], targetStates: [{ targetAssetId: "asset-one", recipeId: "recipe-one", state: "create", newDigest: digest, newSvgDigest: digest }], tokenDigest: digest, recipeDigest: digest, brandSystemDigest: digest, warnings: [], dryRun: true } as const;
const qa = { profileId: "profile-one", caseId: "case-one", baselinePath: "brand/baseline.png", state: "create", oldBaselineDigest: null, newBaselineDigest: digest, oldQaDigest: digest, newQaDigest: digest, renderer: { id: "resvg-png-v1", version: "2.6.2", qualificationId: "sha256:4bb08e677b87ef1ca74c35c5c22f547cebef4c22a1f98a08a9246fd9397d0f11", platformClaim: "darwin-arm64", rendererBuildDigest: "sha256:22bf6e9f9a100d972da0411a69c5ba504367fc1fa87b3b64e3f35e53926d2d70" }, assetDigests: { old: digest, next: digest }, svgDigests: { old: digest, next: digest }, brandSystemDigests: { old: digest, next: digest }, rasterDifference: { changedPixels: 0, maximumChannelDelta: 0, changedBounds: null, beforeDecodedPixelDigest: null, afterDecodedPixelDigest: digest } } as const;
const consumer = (operation: "install" | "sync") => ({ operation, packages: ["package-one"], profiles: ["package-one/profile-one"], outputs: [{ kind: "asset" as const, packageId: "package-one", sourceId: "asset-one", destination: "public/asset.svg", byteDigest: digest }], omittedOptional: [], lockDigest: digest });
const rasterBuild = "sha256:22bf6e9f9a100d972da0411a69c5ba504367fc1fa87b3b64e3f35e53926d2d70";
const raster = { profileId: "profile-one", adapter: { adapterId: "resvg-png-v1", companionPackage: "@knowledge-forge-ai/tfsb-raster-resvg", companionVersion: "0.0.0-tfsb47f", backend: "wasm", rendererPackage: "@resvg/resvg-wasm", rendererVersion: "2.6.2", rendererBuildDigest: rasterBuild, nodeMajor: 22, platformClaim: "darwin-arm64", qualificationId: "sha256:4bb08e677b87ef1ca74c35c5c22f547cebef4c22a1f98a08a9246fd9397d0f11" }, outputs: [{ profileId: "profile-one", outputId: "output-one", assetId: "asset-one", destination: "public/output.png", state: "create", width: 16, height: 16, purpose: "icon", fit: "contain-pad", background: "transparent", alpha: "straight", canonicalAssetDigest: digest, svgDigest: digest, profileDigest: digest, outputConfigDigest: digest, rendererBuildDigest: rasterBuild, pngDigest: digest, decodedPixelDigest: digest, receiptDigest: digest }], counts: { create: 1, update: 0, unchanged: 0 }, warnings: [] } as const;

function ready(method: BrandPlanMethod, summary: StudioPlanSummary): Extract<StudioBrandPlanStartResult, { readonly kind: "ready" }> { return { kind: "ready", planHandle: `plan_${"b".repeat(64)}`, planDigest: digest, method, expiresInMs: 600000, summary, projectHandle: "project_safe", sourceHandles: [] }; }

describe("typed Studio plan workflows", () => {
  it("validates all five exact public summary variants and rejects private or mismatched data", () => {
    for (const [method, summary] of [["brand.derive.plan", derive], ["brand.qa.baseline.plan", qa], ["brand.consumer.install.plan", consumer("install")], ["brand.consumer.sync.plan", consumer("sync")], ["brand.export.plan", raster]] as const) { const result = validatePlanResult(ready(method, summary) as unknown); expect(result.kind).toBe("ready"); if (result.kind === "ready") expect(result.method).toBe(method); }
    expect(() => validatePlanResult({ ...ready("brand.derive.plan", derive), planToken: "private" })).toThrow(StudioPlanValidationError);
    expect(() => validatePlanResult(ready("brand.consumer.sync.plan", consumer("install")))).toThrow(StudioPlanValidationError);
    expect(() => validatePlanResult(ready("brand.qa.baseline.plan", { ...qa, baselinePath: "/private/path" }))).toThrow(StudioPlanValidationError);
    expect(() => validatePlanResult(ready("brand.export.plan", { ...raster, counts: { create: 0, update: 0, unchanged: 0 } }))).toThrow(StudioPlanValidationError);
  });

  it("closes operation events to monotonic-capable handles, states, stages, and fields", () => {
    expect(validatePlanEvent({ schemaVersion: 1, sequence: 1, operationHandle: `operation_${"c".repeat(64)}`, state: "started" }).state).toBe("started");
    expect(validatePlanEvent({ schemaVersion: 1, sequence: 2, operationHandle: `operation_${"c".repeat(64)}`, state: "progress", progress: { stage: "waiting-lock", completed: 0, total: 1 } }).progress?.stage).toBe("waiting-lock");
    for (const invalid of [{ schemaVersion: 1, sequence: 1, operationHandle: "request-1", state: "started" }, { schemaVersion: 1, sequence: 1, operationHandle: `operation_${"c".repeat(64)}`, state: "invented" }, { schemaVersion: 1, sequence: 1, operationHandle: `operation_${"c".repeat(64)}`, state: "progress", progress: { stage: "invented", completed: 0 } }, { schemaVersion: 1, sequence: 1, operationHandle: `operation_${"c".repeat(64)}`, state: "started", planToken: "private" }]) expect(() => validatePlanEvent(invalid)).toThrow(StudioPlanValidationError);
  });

  it("requires explicit acknowledgement before exact digest-bound apply and reconciles reads", async () => {
    const start = vi.fn(async (request: Parameters<StudioBrandPlanClient["startPlanOperation"]>[0], onEvent: Parameters<StudioBrandPlanClient["startPlanOperation"]>[1]): Promise<StudioBrandPlanStartResult> => {
      onEvent({ schemaVersion: 1, sequence: 1, operationHandle: `operation_${"c".repeat(64)}`, state: "started" });
      if (request.kind === "create-derive") return ready("brand.derive.plan", derive);
      if (request.kind === "apply") return { kind: "applied" as const, method: "brand.derive.plan" as const };
      return { kind: "discarded" as const };
    });
    const client: StudioBrandPlanClient = { startPlanOperation: start, cancelPlanOperation: async () => ({ accepted: true }) };
    const reconcile = vi.fn(async () => true);
    render(<PlanWorkspace client={client} host={{ schemaVersion: 1, studioVersion: "0.1.0", manifestDigest: "a".repeat(64), state: "ready", selectedProtocolVersion: "1.2", serverVersion: "0.1.0", methods: [], capabilities: null, raster: { available: false, qualificationIdentity: null }, projectOpenCount: 1, sourceOpenCount: 0, lastReasonCode: null }} project={{ projectHandle: "project_safe", rootKind: "project", schemaVersion: 1, name: "demo", canonicalDigest: digest, assetCount: 1, companionCount: 0, state: null }} view="recipes" data={{ view: "recipes", graph: { recipeDigest: digest, graphDigest: digest, affectedTargetCount: 1, ownershipConflicts: 0, nodes: [{ recipeId: "recipe-one", sourceAsset: "source-one", targetAsset: "asset-one", dependencies: [], dependents: [], operations: ["copy"], operationDigest: digest, depth: 0, targetState: "missing", receiptDigest: null }] } }} selection={{ kind: "none" }} sources={[]} selectedSourceHandles={[]} onSourceSelection={() => undefined} identity="ready|project_safe" onReconcile={reconcile} />);
    fireEvent.click(screen.getByRole("button", { name: "Review derive plan" }));
    const apply = await screen.findByRole("button", { name: "Apply this exact plan" });
    expect((apply as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText(digest, { selector: "code" }).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByLabelText("I reviewed this exact plan and its destinations."));
    expect((apply as HTMLButtonElement).disabled).toBe(false); fireEvent.click(apply);
    await waitFor(() => expect(reconcile).toHaveBeenCalledOnce());
    expect(start.mock.calls[1]?.[0]).toEqual({ kind: "apply", planHandle: `plan_${"b".repeat(64)}`, expectedPlanDigest: digest });
    expect(await screen.findByText(/applied and canonical reads refreshed/i)).toBeTruthy();
  });
  it("supports discarding ready plan and resets state", async () => {
    const start = vi.fn(async (request: Parameters<StudioBrandPlanClient["startPlanOperation"]>[0], onEvent: Parameters<StudioBrandPlanClient["startPlanOperation"]>[1]): Promise<StudioBrandPlanStartResult> => {
      onEvent({ schemaVersion: 1, sequence: 1, operationHandle: `operation_${"c".repeat(64)}`, state: "started" });
      if (request.kind === "create-derive") return ready("brand.derive.plan", derive);
      return { kind: "discarded" as const };
    });
    const client: StudioBrandPlanClient = { startPlanOperation: start, cancelPlanOperation: async () => ({ accepted: true }) };
    const reconcile = vi.fn(async () => true);
    render(<PlanWorkspace client={client} host={{ schemaVersion: 1, studioVersion: "0.1.0", manifestDigest: "a".repeat(64), state: "ready", selectedProtocolVersion: "1.2", serverVersion: "0.1.0", methods: [], capabilities: null, raster: { available: false, qualificationIdentity: null }, projectOpenCount: 1, sourceOpenCount: 0, lastReasonCode: null }} project={{ projectHandle: "project_safe", rootKind: "project", schemaVersion: 1, name: "demo", canonicalDigest: digest, assetCount: 1, companionCount: 0, state: null }} view="recipes" data={{ view: "recipes", graph: { recipeDigest: digest, graphDigest: digest, affectedTargetCount: 1, ownershipConflicts: 0, nodes: [{ recipeId: "recipe-one", sourceAsset: "source-one", targetAsset: "asset-one", dependencies: [], dependents: [], operations: ["copy"], operationDigest: digest, depth: 0, targetState: "missing", receiptDigest: null }] } }} selection={{ kind: "none" }} sources={[]} selectedSourceHandles={[]} onSourceSelection={() => undefined} identity="ready|project_safe" onReconcile={reconcile} />);
    fireEvent.click(screen.getByRole("button", { name: "Review derive plan" }));
    const discard = await screen.findByRole("button", { name: "Discard plan" });
    fireEvent.click(discard);
    expect(await screen.findByText(/The plan was discarded/i)).toBeTruthy();
    expect(start.mock.calls[1]?.[0]).toEqual({ kind: "discard", planHandle: `plan_${"b".repeat(64)}` });
  });

  it("handles operation progress, cancellation, and error announcements", async () => {
    let cancelCallback: (() => void) | undefined;
    const cancelPromise = new Promise<StudioBrandPlanStartResult>((resolve) => {
      cancelCallback = () => resolve({ kind: "discarded" });
    });
    const start = vi.fn(async (_request: Parameters<StudioBrandPlanClient["startPlanOperation"]>[0], onEvent: Parameters<StudioBrandPlanClient["startPlanOperation"]>[1]): Promise<StudioBrandPlanStartResult> => {
      onEvent({ schemaVersion: 1, sequence: 1, operationHandle: `operation_${"c".repeat(64)}`, state: "started" });
      onEvent({ schemaVersion: 1, sequence: 2, operationHandle: `operation_${"c".repeat(64)}`, state: "progress", progress: { stage: "analyze", completed: 1, total: 2 } });
      return cancelPromise;
    });
    const cancelPlanOperation = vi.fn(async () => {
      cancelCallback?.();
      return { accepted: true };
    });
    const client: StudioBrandPlanClient = { startPlanOperation: start, cancelPlanOperation };
    render(<PlanWorkspace client={client} host={{ schemaVersion: 1, studioVersion: "0.1.0", manifestDigest: "a".repeat(64), state: "ready", selectedProtocolVersion: "1.2", serverVersion: "0.1.0", methods: [], capabilities: null, raster: { available: false, qualificationIdentity: null }, projectOpenCount: 1, sourceOpenCount: 0, lastReasonCode: null }} project={{ projectHandle: "project_safe", rootKind: "project", schemaVersion: 1, name: "demo", canonicalDigest: digest, assetCount: 1, companionCount: 0, state: null }} view="recipes" data={{ view: "recipes", graph: { recipeDigest: digest, graphDigest: digest, affectedTargetCount: 1, ownershipConflicts: 0, nodes: [{ recipeId: "recipe-one", sourceAsset: "source-one", targetAsset: "asset-one", dependencies: [], dependents: [], operations: ["copy"], operationDigest: digest, depth: 0, targetState: "missing", receiptDigest: null }] } }} selection={{ kind: "none" }} sources={[]} selectedSourceHandles={[]} onSourceSelection={() => undefined} identity="ready|project_safe" onReconcile={async () => true} />);
    fireEvent.click(screen.getByRole("button", { name: "Review derive plan" }));
    const cancelBtn = await screen.findByRole("button", { name: /cancel operation/i });
    expect(cancelBtn).toBeTruthy();
    expect(screen.getByText(/analyze/i)).toBeTruthy();
    fireEvent.click(cancelBtn);
    await waitFor(() => expect(cancelPlanOperation).toHaveBeenCalledWith(`operation_${"c".repeat(64)}`));
  });

  it("handles indeterminate apply outcome and instructs inspection", async () => {
    const start = vi.fn(async (request: Parameters<StudioBrandPlanClient["startPlanOperation"]>[0], onEvent: Parameters<StudioBrandPlanClient["startPlanOperation"]>[1]): Promise<StudioBrandPlanStartResult> => {
      onEvent({ schemaVersion: 1, sequence: 1, operationHandle: `operation_${"c".repeat(64)}`, state: "started" });
      if (request.kind === "create-derive") return ready("brand.derive.plan", derive);
      if (request.kind === "apply") return { kind: "indeterminate" as const, method: "brand.derive.plan" as const };
      return { kind: "discarded" as const };
    });
    const client: StudioBrandPlanClient = { startPlanOperation: start, cancelPlanOperation: async () => ({ accepted: true }) };
    const reconcile = vi.fn(async () => true);
    render(<PlanWorkspace client={client} host={{ schemaVersion: 1, studioVersion: "0.1.0", manifestDigest: "a".repeat(64), state: "ready", selectedProtocolVersion: "1.2", serverVersion: "0.1.0", methods: [], capabilities: null, raster: { available: false, qualificationIdentity: null }, projectOpenCount: 1, sourceOpenCount: 0, lastReasonCode: null }} project={{ projectHandle: "project_safe", rootKind: "project", schemaVersion: 1, name: "demo", canonicalDigest: digest, assetCount: 1, companionCount: 0, state: null }} view="recipes" data={{ view: "recipes", graph: { recipeDigest: digest, graphDigest: digest, affectedTargetCount: 1, ownershipConflicts: 0, nodes: [{ recipeId: "recipe-one", sourceAsset: "source-one", targetAsset: "asset-one", dependencies: [], dependents: [], operations: ["copy"], operationDigest: digest, depth: 0, targetState: "missing", receiptDigest: null }] } }} selection={{ kind: "none" }} sources={[]} selectedSourceHandles={[]} onSourceSelection={() => undefined} identity="ready|project_safe" onReconcile={reconcile} />);
    fireEvent.click(screen.getByRole("button", { name: "Review derive plan" }));
    const apply = await screen.findByRole("button", { name: "Apply this exact plan" });
    fireEvent.click(screen.getByLabelText("I reviewed this exact plan and its destinations."));
    fireEvent.click(apply);
    await waitFor(() => expect(reconcile).toHaveBeenCalledWith("brand.derive.plan", true));
    expect(await screen.findByText(/The apply outcome is indeterminate/i)).toBeTruthy();
  });

  it("locks every ready-plan action while apply is unresolved and reconciles exactly once", async () => {
    let resolveApply: ((value: StudioBrandPlanStartResult) => void) | undefined;
    const apply = new Promise<StudioBrandPlanStartResult>((resolve) => { resolveApply = resolve; });
    const start = vi.fn(async (request: Parameters<StudioBrandPlanClient["startPlanOperation"]>[0]): Promise<StudioBrandPlanStartResult> => {
      if (request.kind === "create-derive") return ready("brand.derive.plan", { ...derive, createdCount: 0, targetStates: [], affectedTargets: [], operationSummaries: [] });
      if (request.kind === "apply") return apply;
      return { kind: "discarded" };
    });
    const reconcile = vi.fn(async () => true);
    const client: StudioBrandPlanClient = { startPlanOperation: start, cancelPlanOperation: async () => ({ accepted: true }) };
    render(<PlanWorkspace client={client} host={{ schemaVersion: 1, studioVersion: "0.1.0", manifestDigest: "a".repeat(64), state: "ready", selectedProtocolVersion: "1.2", serverVersion: "0.1.0", methods: [], capabilities: null, raster: { available: false, qualificationIdentity: null }, projectOpenCount: 1, sourceOpenCount: 0, lastReasonCode: null }} project={{ projectHandle: "project_safe", rootKind: "project", schemaVersion: 1, name: "demo", canonicalDigest: digest, assetCount: 1, companionCount: 0, state: null }} view="recipes" data={{ view: "recipes", graph: { recipeDigest: digest, graphDigest: digest, affectedTargetCount: 1, ownershipConflicts: 0, nodes: [{ recipeId: "recipe-one", sourceAsset: "source-one", targetAsset: "asset-one", dependencies: [], dependents: [], operations: ["copy"], operationDigest: digest, depth: 0, targetState: "missing", receiptDigest: null }] } }} selection={{ kind: "none" }} sources={[]} selectedSourceHandles={[]} onSourceSelection={() => undefined} identity="ready|project_safe" onReconcile={reconcile} />);
    fireEvent.click(screen.getByRole("button", { name: "Review derive plan" }));
    const applyButton = await screen.findByRole("button", { name: "Apply this exact plan" });
    const discardButton = screen.getByRole("button", { name: "Discard plan" });
    fireEvent.click(screen.getByLabelText("I reviewed this exact plan and its destinations."));
    fireEvent.click(applyButton);
    expect((discardButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(discardButton);
    expect(start).toHaveBeenCalledTimes(2);
    resolveApply?.({ kind: "applied", method: "brand.derive.plan" });
    await waitFor(() => expect(reconcile).toHaveBeenCalledOnce());
    expect(await screen.findByText(/applied and canonical reads refreshed/i)).toBeTruthy();
  });

  it("keeps opaque handles, token, nonce, request id, and path out of visible and accessible plan evidence", async () => {
    const projectHandle = "project_private-handle";
    const sourceHandle = "source_private-handle";
    const planHandle = `plan_${"b".repeat(64)}`;
    const start = vi.fn(async (): Promise<StudioBrandPlanStartResult> => ({ ...ready("brand.consumer.sync.plan", consumer("sync")), planHandle, projectHandle, sourceHandles: [sourceHandle] }));
    const client: StudioBrandPlanClient = { startPlanOperation: start, cancelPlanOperation: async () => ({ accepted: true }) };
    const rendered = render(<PlanWorkspace client={client} host={{ schemaVersion: 1, studioVersion: "0.1.0", manifestDigest: "a".repeat(64), state: "ready", selectedProtocolVersion: "1.2", serverVersion: "0.1.0", methods: [], capabilities: null, raster: { available: false, qualificationIdentity: null }, projectOpenCount: 1, sourceOpenCount: 1, lastReasonCode: null }} project={{ projectHandle, rootKind: "project", schemaVersion: 1, name: "Public demo", canonicalDigest: digest, assetCount: 1, companionCount: 0, state: null }} view="recipes" data={{ view: "recipes", graph: { recipeDigest: digest, graphDigest: digest, affectedTargetCount: 1, ownershipConflicts: 0, nodes: [{ recipeId: "recipe-one", sourceAsset: "source-one", targetAsset: "asset-one", dependencies: [], dependents: [], operations: ["copy"], operationDigest: digest, depth: 0, targetState: "missing", receiptDigest: null }] } }} selection={{ kind: "none" }} sources={[{ sourceHandle, rootKind: "source", sourceKind: "archive", authorityKind: "brand-bundle", digest, packageId: "package-one", brandVersion: "1.2.3", brandSystemDigest: digest, candidateCount: null, profileCount: 1, assetCount: 1, companionCount: 0 }]} selectedSourceHandles={[sourceHandle]} onSourceSelection={() => undefined} identity={`ready|${projectHandle}|${sourceHandle}`} onReconcile={async () => true} />);
    fireEvent.click(screen.getByRole("button", { name: "Review derive plan" }));
    await screen.findByRole("button", { name: "Apply this exact plan" });
    const output = rendered.container.innerHTML;
    for (const privateValue of [projectHandle, sourceHandle, planHandle, "private-token", "private-nonce", "request-42", "/private/path"]) expect(output).not.toContain(privateValue);
    expect(output).toContain("Public demo");
    expect(output).toContain("package-one 1.2.3");
  });
});
