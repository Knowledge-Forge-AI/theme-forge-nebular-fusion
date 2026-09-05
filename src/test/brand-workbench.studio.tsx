import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { vi } from "vitest";
import { VisualBlobUrlSet } from "../brand-read/blob-manager";
import type {
  BrandStatus, ConsumerLockStatus, ConsumerProfilePage, ExportCapability, ExportStatusPage,
  FamilyPage, QaProfile, QaProfilePage, QaResult, RecipeGraph, SemanticDiff, Sha256Digest,
  StudioBrandReadClient, TokenPage, VisualArtifact, VisualEvidence,
} from "../brand-read/StudioBrandReadClient";
import { validateAssetIdentity, validateFamilyPage, validateVisualEvidence } from "../brand-read/validators";
import { BrandWorkbench } from "../features/brand-workbench/BrandWorkbench";
import type { StudioHostStatus, StudioProjectOpen, StudioSourceOpen } from "../protocol/contracts";

const sha = (digit: string): Sha256Digest => `sha256:${digit.repeat(64)}` as Sha256Digest;
const emptyPage = <T,>(items: readonly T[] = []) => ({ page: { size: 64, count: items.length, items, nextCursor: null }, viewDigest: sha("9") });
const status: BrandStatus = { present: false, raster: { available: false } };
const families: FamilyPage = emptyPage([{ id: "terminal-nova", name: "Terminal Nova", requiredRoles: ["primary"], optionalRoles: [], variants: [{ family: "terminal-nova", id: "default", backgrounds: ["transparent"], colorMode: "full-color", scale: "standard", status: "primary" }], bindings: [{ family: "terminal-nova", role: "primary", variant: "default", asset: "brand-mark", authority: "source" }], requirements: [{ family: "terminal-nova", role: "primary" }], complete: true }]);
const tokens: TokenPage = emptyPage([]);
const graph: RecipeGraph = { recipeDigest: sha("1"), graphDigest: sha("2"), nodes: [], affectedTargetCount: 0, ownershipConflicts: 0 };
const qaProfiles: QaProfilePage = emptyPage([{ id: "release", renderer: "required", formats: ["json"], caseCount: 1, semanticCaseCount: 0, visualCaseCount: 1, baselineCaseCount: 1, qaDigest: sha("3"), brandSystemDigest: sha("4") }]);
const qaProfile: QaProfile = { profile: { id: "release", renderer: "required", formats: ["json"], cases: ["baseline-mark"] }, cases: [{ id: "baseline-mark", kind: "baseline", asset: "brand-mark", sizes: [[16, 16]], backgrounds: ["transparent"], baselineDigest: sha("5"), rendererId: "resvg-png-v1", rendererVersion: "2.6.2", platformClaim: "darwin-arm64", canonicalAssetDigest: sha("6"), svgDigest: sha("7") }], resolvedTargetCount: 1, evaluationCount: 1, qaDigest: sha("3"), brandSystemDigest: sha("4"), baselines: [{ caseId: "baseline-mark", digest: sha("5") }], raster: { available: true } };
const qaResult: QaResult = { schema: "tfsb.brand-qa-result", schemaVersion: 1, profileId: "release", qaDigest: sha("3"), brandSystemDigest: sha("4"), status: "pass", exitCode: 0, counts: { pass: 1, fail: 0, skipped: 0, unavailable: 0, error: 0 }, results: [{ caseId: "baseline-mark", kind: "baseline", status: "pass", capability: "renderer", capabilityRequired: true, measurements: {}, diagnostics: [], evaluations: [{ target: { assetId: "brand-mark" }, width: 16, height: 16, background: "transparent", status: "pass", measurements: {}, diagnostics: [] }] }], resultDigest: sha("8") };
const semanticDiff: SemanticDiff = { diff: { schema: "tfsb.brand-diff", schemaVersion: 1, beforeDigest: sha("1"), afterDigest: sha("2"), status: "equal", inventory: { families: [], roles: [], variants: [], requirements: [], completeness: null }, bindings: { records: [] }, tokens: { records: [] }, recipes: { records: [], affectedTargets: [] }, derived: { records: [] }, geometry: { records: [], canonicalTypedGeometryChanged: false, equivalenceClaim: "none" }, qaImpact: { profiles: [], cases: [], affectedCases: [] }, packageAndLegal: { package: null, companions: [], bundleRelevantChanged: false }, consumerProfiles: { beforeState: "available", afterState: "available", status: "available", records: [] }, exports: { beforeState: "available", afterState: "available", status: "available", records: [] }, resultDigest: sha("3") }, beforeBindingDigest: sha("4"), afterBindingDigest: sha("5"), visualDiff: { available: false } };
const consumerProfiles: ConsumerProfilePage = emptyPage([]);
const consumerLock: ConsumerLockStatus = { status: "ok", exitCode: 0, packages: [], mappings: [], localProfiles: [] };
const exportCapability: ExportCapability = { available: false };
const exportStatus: ExportStatusPage = emptyPage([]);
const calls: string[] = [];
const client: StudioBrandReadClient = {
  async getAssetIdentity(_projectHandle, assetId) { return { assetId, canonicalAssetDigest: sha("1"), svgDigest: sha("2") }; },
  async getBrandStatus() { calls.push("overview"); return status; },
  async listFamilies() { calls.push("families"); return families; },
  async listTokens() { calls.push("tokens"); return tokens; },
  async getRecipeGraph() { calls.push("recipes"); return graph; },
  async listQaProfiles() { calls.push("qa-list"); return qaProfiles; },
  async getQaProfile() { calls.push("qa-profile"); return qaProfile; },
  async getQaResult() { calls.push("qa-result"); return qaResult; },
  async getSemanticDiff() { calls.push("semantic-diff"); return semanticDiff; },
  async listConsumerProfiles() { calls.push("consumer-list"); return consumerProfiles; },
  async getConsumerLockStatus() { calls.push("consumer-lock"); return consumerLock; },
  async getExportCapability() { calls.push("export-capability"); return exportCapability; },
  async listExportStatus() { calls.push("export-status"); return exportStatus; },
  async getVisualEvidence() { throw new Error("raster unavailable"); },
};

const host: StudioHostStatus = { schemaVersion: 1, studioVersion: "0.1.0", manifestDigest: "a".repeat(64), state: "ready", selectedProtocolVersion: "1.2", serverVersion: "0.1.0", methods: [], capabilities: null, raster: { available: false, qualificationIdentity: null }, projectOpenCount: 1, sourceOpenCount: 1, lastReasonCode: null };
const project: StudioProjectOpen = { projectHandle: "project_opaque", rootKind: "project", schemaVersion: 2, name: "Terminal Nova", canonicalDigest: sha("3"), assetCount: 1, companionCount: 0, state: null };
const source: StudioSourceOpen = { sourceHandle: "source_opaque", rootKind: "source", sourceKind: null, authorityKind: "brand-bundle", digest: sha("4"), packageId: "vendor", brandVersion: "1.0.0", brandSystemDigest: sha("5"), candidateCount: null, profileCount: 1, assetCount: 1, companionCount: 0 };

describe("live read-only brand workbench", () => {
  it("loads eight semantic views and requires explicit QA and visual selection", async () => {
    calls.length = 0; const user = userEvent.setup();
    render(<BrandWorkbench client={client} host={host} project={project} source={source} />);
    expect(await screen.findByText(/no declared brand system/i)).toBeTruthy();
    for (const label of ["Families", "Tokens", "Recipes", "QA", "Semantic diff", "Consumer", "Export"]) {
      await user.click(screen.getByRole("button", { name: label }));
      await waitFor(() => expect(screen.getByRole("heading", { name: label })).toBeTruthy());
      await waitFor(() => expect(screen.queryByText(new RegExp(`Loading ${label.toLowerCase()}`, "i"))).toBeNull());
      if (label === "QA") { await user.selectOptions(screen.getByRole("combobox", { name: /qa profile/i }), "release"); await screen.findByText(/Current result: pass/i); }
    }
    expect(calls).toEqual(expect.arrayContaining(["overview", "families", "tokens", "recipes", "qa-list", "qa-profile", "qa-result", "semantic-diff", "consumer-list", "consumer-lock", "export-capability", "export-status"]));
    expect(screen.queryByRole("button", { name: /derive|apply|baseline update|install|sync|export now|provider|model/i })).toBeNull();
    expect((screen.getByRole("button", { name: /render selected/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("rejects unknown and out-of-order family fields", () => {
    const data = { kind: "family-page", data: structuredClone(families) } as unknown as { kind: string; data: { page: { items: unknown[] } } };
    expect(validateFamilyPage(data).page.items).toHaveLength(1);
    (data.data.page.items[0] as Record<string, unknown>).sessionNonce = "secret";
    expect(() => validateFamilyPage(data)).toThrow();
  });

  it("accepts only the identity projection and rejects private asset.get fields", () => {
    const response = { kind: "asset-identity", data: { assetId: "brand-mark", canonicalAssetDigest: sha("1"), svgDigest: sha("2") } };
    expect(validateAssetIdentity(response)).toEqual(response.data);
    expect(() => validateAssetIdentity({ ...response, data: { ...response.data, canonicalSvg: "<svg/>" } })).toThrow();
    expect(() => validateAssetIdentity({ ...response, data: { ...response.data, assetId: "other" }, requestId: "private" })).toThrow();
  });

  it("creates and revokes exactly one verified PNG Blob URL for artifacts larger than 32 KiB", async () => {
    const header = [137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,16,0,0,0,16,8,6,0,0,0];
    const largeBytes = new Uint8Array(48_000); largeBytes.set(header);
    const digestBuffer = await crypto.subtle.digest("SHA-256", Uint8Array.from(largeBytes).buffer);
    const pngDigest = `sha256:${[...new Uint8Array(digestBuffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}` as Sha256Digest;
    const create = vi.fn(() => "blob:tfsb-test"); const revoke = vi.fn(); vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
    const manager = new VisualBlobUrlSet(); let binary = ""; for (let index = 0; index < largeBytes.length; index += 8192) binary += String.fromCharCode(...largeBytes.subarray(index, index + 8192));
    const artifact: VisualArtifact = { role: "current", mediaType: "image/png", encoding: "base64", width: 16, height: 16, byteLength: largeBytes.byteLength, pngDigest, decodedPixelDigest: sha("0"), bytesBase64: btoa(binary) };
    expect(await manager.create(artifact)).toBe("blob:tfsb-test"); manager.revokeAll(); manager.revokeAll();
    expect(create).toHaveBeenCalledOnce(); expect(revoke).toHaveBeenCalledTimes(1); expect(revoke).toHaveBeenCalledWith("blob:tfsb-test"); vi.unstubAllGlobals();
  });

  it("discards a late visual before creating any Blob URL across project identity", async () => {
    const bytes = new Uint8Array(48_000); bytes.set([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82]); new DataView(bytes.buffer).setUint32(16, 16); new DataView(bytes.buffer).setUint32(20, 16);
    const digestBuffer = await crypto.subtle.digest("SHA-256", bytes); let binary = ""; for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
    const artifact: VisualArtifact = { role: "current", mediaType: "image/png", encoding: "base64", width: 16, height: 16, byteLength: bytes.length, pngDigest: `sha256:${[...new Uint8Array(digestBuffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}` as Sha256Digest, decodedPixelDigest: sha("0"), bytesBase64: btoa(binary) };
    const late: VisualEvidence = { schema: "tfsb.studio-visual-evidence", schemaVersion: 1, kind: "project-render", projectDigest: sha("1"), brandSystemDigest: sha("2"), target: { assetId: "brand-mark", canonicalAssetDigest: sha("3"), svgDigest: sha("4") }, configuration: { width: 16, height: 16, background: "transparent" }, renderer: { id: "resvg-png-v1", version: "2.6.2", qualificationId: sha("4"), platformClaim: "darwin-arm64" }, artifacts: [artifact], evidenceDigest: sha("5") };
    let resolveLate: ((value: VisualEvidence) => void) | undefined; const lateClient = { ...client, getVisualEvidence: () => new Promise<VisualEvidence>((resolve) => { resolveLate = resolve; }) };
    const create = vi.fn(() => "blob:should-not-exist"); const revoke = vi.fn(); vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke }); const user = userEvent.setup();
    const rasterHost = { ...host, raster: { available: true, qualificationIdentity: sha("4") } }; const rendered = render(<BrandWorkbench client={lateClient} host={rasterHost} project={project} source={source}/>);
    await user.click(screen.getByRole("button", { name: "Families" })); await screen.findByRole("table", { name: /terminal-nova bindings/i }); await user.click(screen.getByLabelText("Asset")); await user.click(screen.getByRole("button", { name: "Render selected evidence" }));
    rendered.rerender(<BrandWorkbench client={lateClient} host={rasterHost} project={{ ...project, projectHandle: "project_other" }} source={source}/>); resolveLate?.(late); await waitFor(() => expect(screen.getByText(/Select one exact typed record/i)).toBeTruthy());
    expect(create).not.toHaveBeenCalled(); expect(revoke).not.toHaveBeenCalled(); vi.unstubAllGlobals();
  });

  it("validates the complete visual shape and rejects impossible differences", async () => {
    const examples = JSON.parse(readFileSync("protocol/tfsb-studio-v1/examples/1.2/results.json", "utf8")) as Record<string, unknown>;
    const data = structuredClone(examples["brand.visual.evidence.get"]);
    await expect(validateVisualEvidence({ kind: "visual-evidence", data })).resolves.toMatchObject({ kind: "project-render" });
    const impossible = structuredClone(data) as { difference?: { changedPixels: number; maximumChannelDelta: number; changedBounds: unknown; claim: string }; kind: string; qaDigest?: string };
    impossible.kind = "qa-baseline"; impossible.qaDigest = sha("0"); impossible.difference = { changedPixels: 0, maximumChannelDelta: 1, changedBounds: { left: 0, top: 0, right: 0, bottom: 0 }, claim: "pixel-equal-for-this-renderer-and-case-only" };
    await expect(validateVisualEvidence({ kind: "visual-evidence", data: impossible })).rejects.toThrow();
  });
});
