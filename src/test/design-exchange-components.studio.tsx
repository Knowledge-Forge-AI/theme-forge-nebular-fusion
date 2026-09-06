import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import type { StudioBrandReadClient } from "../brand-read/StudioBrandReadClient";
import type { DesignPacketClient } from "../design-evidence/client";
import type { BriefPacket, CandidatePacket, DesignEvidencePacket, ReviewAnnotation, ReviewPacket } from "../design-evidence/types";
import { computePacketDigest } from "../design-evidence/canonical";
import { createCandidateArtifactUrls } from "../features/design-exchange/blob-identity";
import { VisualBlobUrlSet } from "../brand-read/blob-manager";
import type { StudioSourceOpen } from "../protocol/contracts";
import { AnnotationEditor } from "../features/design-exchange/AnnotationEditor";
import { BriefBuilder, type BriefTargetOption } from "../features/design-exchange/BriefBuilder";
import { DesignExchange, resolveBriefTargetEvidence } from "../features/design-exchange/DesignExchange";
import { designSessionReducer, initialDesignSession } from "../features/design-exchange/design-session-state";

const candidate = JSON.parse(readFileSync(resolve("protocol/tfsb-design-evidence-v1/examples/candidate-a.json"), "utf8")) as CandidatePacket;
const digest = (suffix: number) => `sha256:${suffix.toString(16).padStart(64, "0")}` as CandidatePacket["candidateDigest"];
const options: readonly BriefTargetOption[] = [
  { key: "asset:brand-mark", label: "Asset brand-mark", target: { kind: "asset", assetId: "brand-mark" }, assetId: "brand-mark", purpose: "mark" },
  { key: "binding:terminal/wordmark/primary", label: "Binding terminal / wordmark / primary", target: { kind: "binding", family: "terminal", role: "wordmark", variant: "primary" }, assetId: "wordmark", purpose: "wordmark" },
];

const sampleBrief = JSON.parse(readFileSync(resolve("protocol/tfsb-design-evidence-v1/examples/brief.json"), "utf8")) as BriefPacket;
const sampleCandidateA = JSON.parse(readFileSync(resolve("protocol/tfsb-design-evidence-v1/examples/candidate-a.json"), "utf8")) as CandidatePacket;
const sampleCandidateB = JSON.parse(readFileSync(resolve("protocol/tfsb-design-evidence-v1/examples/candidate-b.json"), "utf8")) as CandidatePacket;
const sampleReview = JSON.parse(readFileSync(resolve("protocol/tfsb-design-evidence-v1/examples/review.json"), "utf8")) as ReviewPacket;

async function finalizedCandidate(base: CandidatePacket, overrides: Partial<CandidatePacket>): Promise<CandidatePacket> {
  const merged = { ...base, ...overrides };
  const candidateDigest = await computePacketDigest(merged);
  return { ...merged, candidateDigest };
}

function createMockClients(brief: BriefPacket, overrides?: { brandStatus?: Partial<Awaited<ReturnType<StudioBrandReadClient["getBrandStatus"]>>>; rasterAvailable?: boolean }) {
  const exportedPackets: unknown[] = [];
  const importQueue: DesignEvidencePacket[] = [];
  const exportQueue: boolean[] = [];
  const mockPacketClient: DesignPacketClient & { importQueue: DesignEvidencePacket[]; exportQueue: boolean[] } = {
    importQueue,
    exportQueue,
    async importPacket() {
      const next = this.importQueue.shift();
      if (!next) return { cancelled: true as const };
      return {
        cancelled: false as const,
        packet: next,
        kind: next.schema === "tfsb.design-brief" ? "brief" as const : next.schema === "tfsb.design-candidate" ? "candidate" as const : "review" as const,
        digest: next.schema === "tfsb.design-brief" ? next.briefDigest : next.schema === "tfsb.design-candidate" ? next.candidateDigest : next.reviewDigest,
        byteCount: 100,
      };
    },
    async exportPacket(packet: DesignEvidencePacket) {
      exportedPackets.push(packet);
      const cancelled = this.exportQueue.shift() ?? false;
      return {
        cancelled,
        kind: packet.schema === "tfsb.design-brief" ? "brief" as const : packet.schema === "tfsb.design-candidate" ? "candidate" as const : "review" as const,
        digest: packet.schema === "tfsb.design-brief" ? packet.briefDigest : packet.schema === "tfsb.design-candidate" ? packet.candidateDigest : packet.reviewDigest,
        byteCount: 100,
      };
    },
  };

  const mockReadClient: StudioBrandReadClient = {
    async getAssetIdentity(_projectHandle: string, assetId: string) { return { assetId, canonicalAssetDigest: digest(1), svgDigest: digest(2) }; },
    async getBrandStatus() {
      return {
        present: true, schemaVersion: 1, brandDigest: brief.context.project.brandSystemDigest, brandSystemDigest: brief.context.project.brandSystemDigest, domains: [],
        counts: { families: 1, roles: 1, variants: 1, bindings: 1, requirements: 0, tokens: 0, recipes: 1, qaProfiles: 0, qaCases: 0, qaBaselines: 0, consumerProfiles: 0, exportProfiles: 0 },
        completeness: { satisfied: true, familyCount: 1, variantCount: 1, bindingCount: 1, requirementCount: 0 },
        derived: {}, consumerLock: { present: false, status: "absent", packages: 0, profiles: 0, mappings: 0 },
        export: { outputs: 0, receipts: 0 }, raster: { available: overrides?.rasterAvailable ?? true },
        ...(overrides?.brandStatus ?? {}),
      };
    },
    async listFamilies() {
      return { page: { size: 64, count: 1, items: [{ id: "terminal-nova", name: "Terminal Nova", requiredRoles: ["primary"], optionalRoles: [], variants: [], bindings: [{ family: "terminal-nova", role: "primary", variant: "default", asset: "brand-mark", authority: "source" }], requirements: [], complete: true }], nextCursor: null }, viewDigest: brief.context.project.canonicalDigest };
    },
    async listTokens() { return { page: { size: 64, count: 0, items: [], nextCursor: null }, viewDigest: brief.context.project.canonicalDigest }; },
    async getRecipeGraph() { return { recipeDigest: brief.context.project.canonicalDigest, graphDigest: brief.context.project.canonicalDigest, nodes: [{ recipeId: "mark-small", sourceAsset: "brand-source", targetAsset: "brand-mark", dependencies: [], dependents: [], operations: ["normalize"], operationDigest: brief.context.project.canonicalDigest, depth: 0, targetState: "current", receiptDigest: null }], affectedTargetCount: 0, ownershipConflicts: 0 }; },
    async listQaProfiles() { return { page: { size: 64, count: 0, items: [], nextCursor: null }, viewDigest: brief.context.project.canonicalDigest }; },
    async getQaProfile() { return { profile: { id: "profile-1", name: "Profile 1", cases: ["case-1"], description: "Test" } } as unknown as Awaited<ReturnType<StudioBrandReadClient["getQaProfile"]>>; },
    async getQaResult() { throw new Error("not implemented"); },
    async getSemanticDiff() { throw new Error("not implemented"); },
    async listConsumerProfiles() { return { page: { size: 64, count: 0, items: [], nextCursor: null }, viewDigest: brief.context.project.canonicalDigest }; },
    async getConsumerLockStatus() { throw new Error("not implemented"); },
    async getExportCapability() { return { available: false }; },
    async listExportStatus() { return { page: { size: 64, count: 0, items: [], nextCursor: null }, viewDigest: brief.context.project.canonicalDigest }; },
    async getVisualEvidence() { return brief.visualEvidence[0]!; },
  };

  return { mockPacketClient, mockReadClient, exportedPackets };
}

const mockHostStatus = {
  schemaVersion: 1 as const,
  studioVersion: "0.1.0" as const,
  manifestDigest: "a".repeat(64),
  state: "ready" as const,
  selectedProtocolVersion: "1.2" as const,
  serverVersion: "0.1.0",
  methods: [],
  capabilities: null,
  raster: { available: true, qualificationIdentity: null },
  projectOpenCount: 1,
  sourceOpenCount: 0,
  lastReasonCode: null,
};

const mockProjectData = {
  projectHandle: "proj-1",
  rootKind: "project" as const,
  schemaVersion: 2 as const,
  name: "Terminal Nova",
  canonicalDigest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
  assetCount: 1,
  companionCount: 0,
  state: null,
};

describe("complete design-exchange controls", () => {
  it("resolves every target identity without rasterizing unattached targets and binds explicit tuples", async () => {
    const getAssetIdentity = vi.fn(async (_projectHandle: string, assetId: string) => ({ assetId, canonicalAssetDigest: digest(assetId === "brand-mark" ? 1 : 2), svgDigest: digest(assetId === "brand-mark" ? 3 : 4) }));
    const getVisualEvidence = vi.fn(async (request: Parameters<StudioBrandReadClient["getVisualEvidence"]>[0]) => {
      if (request.kind !== "project-render") throw new Error("unexpected visual kind");
      const assetId = request.target.kind === "asset" ? request.target.assetId : "wordmark";
      const identity = await getAssetIdentity(request.projectHandle, assetId);
      return { ...candidate.visualEvidence[0]!, kind: "project-render" as const, target: { assetId, canonicalAssetDigest: identity.canonicalAssetDigest, svgDigest: identity.svgDigest, ...(request.target.kind === "binding" ? { binding: { family: request.target.family, role: request.target.role, variant: request.target.variant } } : {}) }, configuration: { width: request.width, height: request.height, background: request.background } };
    });
    const client: StudioBrandReadClient = {
      getAssetIdentity, getVisualEvidence,
      async getBrandStatus() { throw new Error("unused"); }, async listFamilies() { throw new Error("unused"); }, async listTokens() { throw new Error("unused"); }, async getRecipeGraph() { throw new Error("unused"); }, async listQaProfiles() { throw new Error("unused"); }, async getQaProfile() { throw new Error("unused"); }, async getQaResult() { throw new Error("unused"); }, async getSemanticDiff() { throw new Error("unused"); }, async listConsumerProfiles() { throw new Error("unused"); }, async getConsumerLockStatus() { throw new Error("unused"); }, async getExportCapability() { throw new Error("unused"); }, async listExportStatus() { throw new Error("unused"); },
    };
    const tuple = { width: 760, height: 620, background: "token:canvas-dark" };
    const resolved = await resolveBriefTargetEvidence(client, "project", [{ option: options[0]!, visualTuples: [] }, { option: options[1]!, visualTuples: [tuple] }], () => true);
    expect(resolved.map(({ identity }) => identity.assetId)).toEqual(["brand-mark", "wordmark"]);
    expect(getVisualEvidence).toHaveBeenCalledOnce();
    expect(getVisualEvidence).toHaveBeenCalledWith({ kind: "project-render", projectHandle: "project", target: options[1]!.target, ...tuple });
    await expect(resolveBriefTargetEvidence(client, "project", [{ option: options[0]!, visualTuples: [] }], () => false)).rejects.toThrow("stale-identity");
  });

  it("creates an explicit multi-target, multi-render brief with no first-record defaults", async () => {
    const user = userEvent.setup(); const onCreate = vi.fn();
    render(<BriefBuilder ready targetOptions={options} tokenIds={["color.canvas"]} recipeIds={["mark-small"]} qaProfileIds={["profile.compact"]} busy={false} onCreate={onCreate} />);
    const create = screen.getByRole("button", { name: "Create and export brief" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect(screen.getAllByRole("checkbox").every((input) => !(input as HTMLInputElement).checked)).toBe(true);
    await user.type(screen.getByLabelText("Public brief ID"), "operator-brief");
    await user.type(screen.getByLabelText("Title"), "Operator brief");
    await user.type(screen.getByLabelText("Objective"), "Compare profile: compact with align / center.");
    await user.click(screen.getByLabelText("Asset brand-mark"));
    await user.click(screen.getByLabelText("Binding terminal / wordmark / primary"));
    await user.click(screen.getByLabelText("derive")); await user.click(screen.getByLabelText("evidence-only"));
    await user.click(screen.getByLabelText("color.canvas")); await user.click(screen.getByLabelText("mark-small")); await user.click(screen.getByLabelText("profile.compact"));
    await user.click(screen.getByRole("button", { name: "Add render tuple" }));
    await user.clear(screen.getByLabelText("Render 2 width")); await user.type(screen.getByLabelText("Render 2 width"), "760");
    await user.clear(screen.getByLabelText("Render 2 height")); await user.type(screen.getByLabelText("Render 2 height"), "620");
    await user.clear(screen.getByLabelText("Render 2 background")); await user.type(screen.getByLabelText("Render 2 background"), "token:canvas-dark");
    await user.click(screen.getByLabelText(/Attach Binding terminal.*render tuple 1/));
    await user.click(screen.getByLabelText(/Attach Binding terminal.*render tuple 2/));
    await user.type(screen.getByLabelText(/Acceptance criteria/), "Keyboard access remains complete.\nDigest remains visible.");
    expect(create.disabled).toBe(false); await user.click(create);
    expect(onCreate).toHaveBeenCalledOnce();
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({ targets: [{ visualTuples: [] }, { visualTuples: [{ width: 256, height: 256, background: "transparent" }, { width: 760, height: 620, background: "token:canvas-dark" }] }], allowedProposalKinds: ["derive", "evidence-only"], renderTuples: [{ width: 256, height: 256, background: "transparent" }, { width: 760, height: 620, background: "token:canvas-dark" }] });
  });

  it("retains the eight-candidate reducer bound without a ninth insertion, exclusive decisions, annotation cleanup, and stale draft clearing", () => {
    let state = initialDesignSession;
    for (let index = 1; index <= 8; index += 1) state = designSessionReducer(state, { type: "candidate", candidate: { packet: { ...candidate, candidateId: `candidate-${index}`, candidateDigest: digest(index) }, trust: "context-matched-external", artifactUrls: { [`key-${index}`]: `blob:${index}` } } });
    state = designSessionReducer(state, { type: "candidate", candidate: { packet: { ...candidate, candidateId: "candidate-9", candidateDigest: digest(9) }, trust: "context-matched-external", artifactUrls: {} } }); expect(state.candidates).toHaveLength(8);
    state = designSessionReducer(state, { type: "disposition", digest: digest(1), disposition: "preferred" }); state = designSessionReducer(state, { type: "disposition", digest: digest(2), disposition: "approved" });
    expect(state.dispositions[digest(1)]).toBe("unreviewed"); expect(state.dispositions[digest(2)]).toBe("approved");
    const annotation = { annotationId: "region", candidateDigest: digest(2), visualEvidenceDigest: candidate.visualEvidence[0]!.evidenceDigest, artifactRole: candidate.visualEvidence[0]!.artifacts[0]!.role, pngDigest: candidate.visualEvidence[0]!.artifacts[0]!.pngDigest, scope: { kind: "artifact" as const }, category: "alignment" as const, severity: "minor" as const, comment: "First" };
    state = designSessionReducer(state, { type: "annotation", annotation }); state = designSessionReducer(state, { type: "annotation", annotation: { ...annotation, comment: "Edited" } }); expect(state.annotations).toHaveLength(1); expect(state.annotations[0]?.comment).toBe("Edited");
    state = designSessionReducer(state, { type: "prefill", proposal: candidate.proposal }); state = designSessionReducer(state, { type: "stale" }); expect(state.draftProposal).toBeUndefined(); expect(state.candidates.every((entry) => entry.trust === "context-stale" && Object.keys(entry.artifactUrls).length === 0)).toBe(true);
    state = designSessionReducer(state, { type: "delete-annotation", annotationId: "region" }); expect(state.annotations).toHaveLength(0);
  });

  it("supports artifact-wide and keyboard-edited region annotations on the selected artifact", async () => {
    const user = userEvent.setup(); const onSave = vi.fn(); const visual = candidate.visualEvidence[0]!; const artifact = visual.artifacts[1]!;
    const editing: ReviewAnnotation = { annotationId: "existing-note", candidateDigest: candidate.candidateDigest, visualEvidenceDigest: visual.evidenceDigest, artifactRole: artifact.role, pngDigest: artifact.pngDigest, scope: { kind: "region", xMillionths: 10, yMillionths: 20, widthMillionths: 300, heightMillionths: 400 }, category: "alignment", severity: "minor", comment: "Edit me" };
    render(<AnnotationEditor candidate={candidate} visual={visual} artifact={artifact} imageUrl="blob:selected" editing={editing} onSave={onSave} />);
    const overlay = document.querySelector("svg.annotation-overlay"); const imageBox = document.querySelector(".annotated-image");
    expect(overlay?.getAttribute("data-artifact-key")).toBe(imageBox?.getAttribute("data-artifact-key"));
    expect(overlay?.querySelector("rect")?.getAttribute("x")).toBe("10");
    await user.clear(screen.getByLabelText("X")); await user.type(screen.getByLabelText("X"), "100000");
    await user.clear(screen.getByLabelText("Y")); await user.type(screen.getByLabelText("Y"), "200000");
    await user.clear(screen.getByLabelText("Width")); await user.type(screen.getByLabelText("Width"), "300000");
    await user.clear(screen.getByLabelText("Height")); await user.type(screen.getByLabelText("Height"), "400000");
    await user.clear(screen.getByLabelText("Comment")); await user.type(screen.getByLabelText("Comment"), "Keyboard region"); await user.click(screen.getByRole("button", { name: "Save annotation changes" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ annotationId: "existing-note", candidateDigest: candidate.candidateDigest, visualEvidenceDigest: visual.evidenceDigest, artifactRole: artifact.role, pngDigest: artifact.pngDigest, scope: { kind: "region", xMillionths: 100000, yMillionths: 200000, widthMillionths: 300000, heightMillionths: 400000 }, comment: "Keyboard region" }));
  });

  it("maps pointer input to the same millionth coordinate fields used by keyboard input", async () => {
    const user = userEvent.setup(); const onSave = vi.fn(); const visual = candidate.visualEvidence[0]!; const artifact = visual.artifacts[0]!;
    render(<AnnotationEditor candidate={candidate} visual={visual} artifact={artifact} imageUrl="blob:selected" onSave={onSave} />);
    const image = screen.getByRole("img"); Object.defineProperty(image, "naturalWidth", { value: 1000 }); Object.defineProperty(image, "naturalHeight", { value: 500 });
    vi.spyOn(image, "getBoundingClientRect").mockReturnValue({ x: 10, y: 20, left: 10, top: 20, right: 410, bottom: 220, width: 400, height: 200, toJSON: () => ({}) });
    fireEvent.pointerDown(image, { clientX: 210, clientY: 120 });
    expect((screen.getByLabelText("X") as HTMLInputElement).value).toBe("375000"); expect((screen.getByLabelText("Y") as HTMLInputElement).value).toBe("375000");
    await user.type(screen.getByLabelText("Comment"), "Pointer region"); await user.click(screen.getByRole("button", { name: "Save annotation" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ scope: { kind: "region", xMillionths: 375000, yMillionths: 375000, widthMillionths: 250000, heightMillionths: 250000 } }));
  });

  it("orchestrates full DesignExchange lifecycle: brief import, candidates, annotations, dispositions, export, and prefill", async () => {
    const brief = JSON.parse(readFileSync(resolve("protocol/tfsb-design-evidence-v1/examples/brief.json"), "utf8")) as BriefPacket;
    const candidateA = JSON.parse(readFileSync(resolve("protocol/tfsb-design-evidence-v1/examples/candidate-a.json"), "utf8")) as CandidatePacket;
    const candidateB = JSON.parse(readFileSync(resolve("protocol/tfsb-design-evidence-v1/examples/candidate-b.json"), "utf8")) as CandidatePacket;
    const review = JSON.parse(readFileSync(resolve("protocol/tfsb-design-evidence-v1/examples/review.json"), "utf8")) as ReviewPacket;

    const user = userEvent.setup();
    const onProposalPrefill = vi.fn();
    const exportedPackets: unknown[] = [];

    const mockPacketClient: DesignPacketClient & { importQueue: DesignEvidencePacket[] } = {
      importQueue: [],
      async importPacket() {
        const next = this.importQueue.shift();
        if (!next) return { cancelled: true as const };
        return { cancelled: false as const, packet: next, kind: next.schema === "tfsb.design-brief" ? "brief" as const : next.schema === "tfsb.design-candidate" ? "candidate" as const : "review" as const, digest: next.schema === "tfsb.design-brief" ? next.briefDigest : next.schema === "tfsb.design-candidate" ? next.candidateDigest : next.reviewDigest, byteCount: 100 };
      },
      async exportPacket(packet: DesignEvidencePacket) {
        exportedPackets.push(packet);
        return { cancelled: false as const, kind: packet.schema === "tfsb.design-brief" ? "brief" as const : packet.schema === "tfsb.design-candidate" ? "candidate" as const : "review" as const, digest: packet.schema === "tfsb.design-brief" ? packet.briefDigest : packet.schema === "tfsb.design-candidate" ? packet.candidateDigest : packet.reviewDigest, byteCount: 100 };
      },
    };

    const mockReadClient: StudioBrandReadClient = {
      async getAssetIdentity(_projectHandle: string, assetId: string) { return { assetId, canonicalAssetDigest: digest(1), svgDigest: digest(2) }; },
      async getBrandStatus() {
        return { present: true, schemaVersion: 1, brandDigest: brief.context.project.brandSystemDigest, brandSystemDigest: brief.context.project.brandSystemDigest, domains: [], counts: { families: 1, roles: 1, variants: 1, bindings: 1, requirements: 0, tokens: 0, recipes: 1, qaProfiles: 0, qaCases: 0, qaBaselines: 0, consumerProfiles: 0, exportProfiles: 0 }, completeness: { satisfied: true, familyCount: 1, variantCount: 1, bindingCount: 1, requirementCount: 0 }, derived: {}, consumerLock: { present: false, status: "absent", packages: 0, profiles: 0, mappings: 0 }, export: { outputs: 0, receipts: 0 }, raster: { available: true } };
      },
      async listFamilies() {
        return { page: { size: 64, count: 1, items: [{ id: "terminal-nova", name: "Terminal Nova", requiredRoles: ["primary"], optionalRoles: [], variants: [], bindings: [{ family: "terminal-nova", role: "primary", variant: "default", asset: "brand-mark", authority: "source" }], requirements: [], complete: true }], nextCursor: null }, viewDigest: brief.context.project.canonicalDigest };
      },
      async listTokens() { return { page: { size: 64, count: 0, items: [], nextCursor: null }, viewDigest: brief.context.project.canonicalDigest }; },
      async getRecipeGraph() { return { recipeDigest: brief.context.project.canonicalDigest, graphDigest: brief.context.project.canonicalDigest, nodes: [{ recipeId: "mark-small", sourceAsset: "brand-source", targetAsset: "brand-mark", dependencies: [], dependents: [], operations: ["normalize"], operationDigest: brief.context.project.canonicalDigest, depth: 0, targetState: "current", receiptDigest: null }], affectedTargetCount: 0, ownershipConflicts: 0 }; },
      async listQaProfiles() { return { page: { size: 64, count: 0, items: [], nextCursor: null }, viewDigest: brief.context.project.canonicalDigest }; },
      async getQaProfile() { throw new Error("not implemented"); },
      async getQaResult() { throw new Error("not implemented"); },
      async getSemanticDiff() { throw new Error("not implemented"); },
      async listConsumerProfiles() { return { page: { size: 64, count: 0, items: [], nextCursor: null }, viewDigest: brief.context.project.canonicalDigest }; },
      async getConsumerLockStatus() { throw new Error("not implemented"); },
      async getExportCapability() { return { available: false }; },
      async listExportStatus() { return { page: { size: 64, count: 0, items: [], nextCursor: null }, viewDigest: brief.context.project.canonicalDigest }; },
      async getVisualEvidence() { return brief.visualEvidence[0]!; },
    };

    const hostStatus = {
      schemaVersion: 1 as const,
      studioVersion: "0.1.0" as const,
      manifestDigest: "a".repeat(64),
      state: "ready" as const,
      selectedProtocolVersion: "1.2" as const,
      serverVersion: "0.1.0",
      methods: [],
      capabilities: null,
      raster: { available: true, qualificationIdentity: null },
      projectOpenCount: 1,
      sourceOpenCount: 0,
      lastReasonCode: null,
    };

    const projectData = {
      projectHandle: "proj-1",
      rootKind: "project" as const,
      schemaVersion: 2 as const,
      name: "Terminal Nova",
      canonicalDigest: brief.context.project.canonicalDigest,
      assetCount: 1,
      companionCount: 0,
      state: null,
    };

    const { rerender } = render(
      <DesignExchange
        host={hostStatus}
        project={projectData}
        readClient={mockReadClient}
        packetClient={mockPacketClient}
        onProposalPrefill={onProposalPrefill}
      />
    );

    // Import brief
    mockPacketClient.importQueue.push(brief);
    await user.click(screen.getByRole("button", { name: "Import brief" }));
    expect(await screen.findByText(brief.title)).toBeTruthy();
    await screen.findByLabelText("mark-small");
    expect(screen.getByText(/2 targets/i)).toBeTruthy();

    // Import candidates
    mockPacketClient.importQueue.push(candidateA);
    await user.click(screen.getByRole("button", { name: "Import candidate" }));
    expect(await screen.findByText(candidateA.title)).toBeTruthy();

    mockPacketClient.importQueue.push(candidateB);
    await user.click(screen.getByRole("button", { name: "Import candidate" }));
    expect(await screen.findByText(candidateB.title)).toBeTruthy();

    // Explicitly select artifact for annotation
    const selectButtons = screen.getAllByRole("button", { name: "Select this artifact for annotation" });
    expect(selectButtons.length).toBeGreaterThanOrEqual(2);
    await user.click(selectButtons[0]!);

    // Annotate selected artifact
    const commentInput = screen.getByLabelText("Comment");
    await user.type(commentInput, "Candidate A after artifact check");
    await user.click(screen.getByRole("button", { name: "Save annotation" }));
    expect(await screen.findByText(/Candidate A after artifact check/i)).toBeTruthy();

    // Update candidate dispositions
    const radioPreferred = screen.getAllByLabelText("preferred")[0]!;
    await user.click(radioPreferred);

    // Load proposal into plan form (prefill)
    const prefillButton = screen.getAllByRole("button", { name: "Load proposal into current plan form" })[0]!;
    await user.click(prefillButton);
    expect(onProposalPrefill).toHaveBeenCalledWith(candidateA.proposal);

    // Build and export an exact ambiguous needs-revision choice.
    await user.click(screen.getAllByLabelText("needs-revision")[0]!); await user.click(screen.getAllByLabelText("needs-revision")[1]!);
    await user.selectOptions(screen.getByLabelText("Overall disposition"), "needs-revision");
    expect(screen.getAllByLabelText("Overall candidate")).toHaveLength(1);
    expect(screen.getByLabelText("Overall candidate").querySelectorAll("option")).toHaveLength(3);
    await user.selectOptions(screen.getByLabelText("Overall candidate"), candidateB.candidateDigest);
    await user.type(screen.getByLabelText("Human summary"), "Candidate A is preferred.");
    await user.click(screen.getByRole("button", { name: "Export review packet" }));
    expect(exportedPackets).toHaveLength(1);
    expect((exportedPackets[0] as ReviewPacket).overallDisposition).toEqual({ kind: "needs-revision", candidateDigest: candidateB.candidateDigest });

    // Multiple deferred candidates still produce a candidate-free no-decision.
    await user.click(screen.getAllByLabelText("deferred")[0]!); await user.click(screen.getAllByLabelText("deferred")[1]!);
    await user.selectOptions(screen.getByLabelText("Overall disposition"), "no-decision");
    await user.click(screen.getByRole("button", { name: "Export review packet" }));
    expect((exportedPackets.at(-1) as ReviewPacket).overallDisposition).toEqual({ kind: "no-decision" });

    // Import prior review
    mockPacketClient.importQueue.push(review);
    await user.click(screen.getByRole("button", { name: "Import prior review" }));
    expect(await screen.findByText(review.reviewDigest)).toBeTruthy();
    expect((screen.getByLabelText("Overall disposition") as HTMLSelectElement).value).toBe("needs-revision");
    expect((screen.getByLabelText("Overall candidate") as HTMLSelectElement).value).toBe(candidateB.candidateDigest);
    expect((screen.getByLabelText("Human summary") as HTMLTextAreaElement).value).toBe(review.summary);
    await user.click(screen.getByRole("button", { name: "Export review packet" }));
    expect(exportedPackets.at(-1)).toEqual(review);

    // Stale project transition clears prefill and revokes URLs
    rerender(
      <DesignExchange
        host={hostStatus}
        project={{ ...projectData, canonicalDigest: `sha256:${"c".repeat(64)}` }}
        readClient={mockReadClient}
        packetClient={mockPacketClient}
        onProposalPrefill={onProposalPrefill}
      />
    );
    expect(onProposalPrefill).toHaveBeenCalledWith(undefined);
  });

  it("validates valid revisionOf chains and rejects invalid missing parent and non-increasing revision", async () => {
    const user = userEvent.setup();
    const { mockPacketClient, mockReadClient } = createMockClients(sampleBrief);
    render(
      <DesignExchange
        host={mockHostStatus}
        project={{ ...mockProjectData, canonicalDigest: sampleBrief.context.project.canonicalDigest }}
        readClient={mockReadClient}
        packetClient={mockPacketClient}
        onProposalPrefill={vi.fn()}
      />
    );

    mockPacketClient.importQueue.push(sampleBrief);
    await user.click(screen.getByRole("button", { name: "Import brief" }));
    await screen.findByText(sampleBrief.title);
    await screen.findByLabelText("mark-small");

    mockPacketClient.importQueue.push(sampleCandidateA);
    await user.click(screen.getByRole("button", { name: "Import candidate" }));
    await screen.findByText(sampleCandidateA.title);

    // Invalid missing parent
    const missingParentCand = await finalizedCandidate(sampleCandidateB, {
      candidateId: "missing-parent",
      revisionOf: "sha256:0000000000000000000000000000000000000000000000000000000000000000" as CandidatePacket["candidateDigest"],
      revision: 2,
    });
    mockPacketClient.importQueue.push(missingParentCand);
    await user.click(screen.getByRole("button", { name: "Import candidate" }));
    expect(screen.getByRole("alert").textContent).toContain("The bounded design packet operation failed.");
    expect(screen.queryByText(missingParentCand.title)).toBeNull();

    // Invalid non-increasing revision (revision 1 <= parent revision 1)
    const nonIncreasingCand = await finalizedCandidate(sampleCandidateB, {
      candidateId: "non-increasing",
      revisionOf: sampleCandidateA.candidateDigest,
      revision: 1,
    });
    mockPacketClient.importQueue.push(nonIncreasingCand);
    await user.click(screen.getByRole("button", { name: "Import candidate" }));
    expect(screen.getByRole("alert").textContent).toContain("The bounded design packet operation failed.");
    expect(screen.queryByText(nonIncreasingCand.title)).toBeNull();

    // Valid revision chain (revision 2 > parent revision 1)
    const validRevCand = await finalizedCandidate(sampleCandidateB, {
      candidateId: "valid-rev",
      revisionOf: sampleCandidateA.candidateDigest,
      revision: 2,
    });
    mockPacketClient.importQueue.push(validRevCand);
    await user.click(screen.getByRole("button", { name: "Import candidate" }));
    expect(await screen.findByText(validRevCand.title)).toBeTruthy();
  });

  it("exercises self-consistent-external and context-mismatch trust states in rendered controls", async () => {
    const user = userEvent.setup();
    // 1. self-consistent-external when brandSystemDigest is missing/null
    const noBrandClients = createMockClients(sampleBrief, { brandStatus: { present: false } });
    const { unmount } = render(
      <DesignExchange
        host={mockHostStatus}
        project={{ ...mockProjectData, canonicalDigest: sampleBrief.context.project.canonicalDigest }}
        readClient={noBrandClients.mockReadClient}
        packetClient={noBrandClients.mockPacketClient}
        onProposalPrefill={vi.fn()}
      />
    );
    noBrandClients.mockPacketClient.importQueue.push(sampleBrief);
    await user.click(screen.getByRole("button", { name: "Import brief" }));
    expect(await screen.findByText(/Self-consistent/i)).toBeTruthy();
    unmount();

    // 2. context-mismatch when project canonicalDigest mismatches
    const mismatchClients = createMockClients(sampleBrief);
    render(
      <DesignExchange
        host={mockHostStatus}
        project={{ ...mockProjectData, canonicalDigest: `sha256:${"f".repeat(64)}` }}
        readClient={mismatchClients.mockReadClient}
        packetClient={mismatchClients.mockPacketClient}
        onProposalPrefill={vi.fn()}
      />
    );
    mismatchClients.mockPacketClient.importQueue.push(sampleBrief);
    await user.click(screen.getByRole("button", { name: "Import brief" }));
    expect(await screen.findByText(/Context mismatch/i)).toBeTruthy();
  });

  it("handles component-level import and canceled review export without state corruption", async () => {
    const user = userEvent.setup();
    const { mockPacketClient, mockReadClient, exportedPackets } = createMockClients(sampleBrief);
    render(
      <DesignExchange
        host={mockHostStatus}
        project={{ ...mockProjectData, canonicalDigest: sampleBrief.context.project.canonicalDigest }}
        readClient={mockReadClient}
        packetClient={mockPacketClient}
        onProposalPrefill={vi.fn()}
      />
    );

    // Cancel import brief (importQueue is empty, so importPacket returns cancelled: true)
    await user.click(screen.getByRole("button", { name: "Import brief" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(sampleBrief.title)).toBeNull();

    // Import brief
    mockPacketClient.importQueue.push(sampleBrief);
    await user.click(screen.getByRole("button", { name: "Import brief" }));
    await screen.findByText(sampleBrief.title);

    // Cancel import candidate before supplying one.
    await user.click(screen.getByRole("button", { name: "Import candidate" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(sampleCandidateA.title)).toBeNull();

    mockPacketClient.importQueue.push(sampleCandidateA);
    await user.click(screen.getByRole("button", { name: "Import candidate" }));
    await screen.findByText(sampleCandidateA.title);
    await user.click(screen.getAllByLabelText("deferred")[0]!);

    // Cancel import review
    await user.click(screen.getByRole("button", { name: "Import prior review" }));
    expect(screen.queryByRole("alert")).toBeNull();

    // A canceled review export is an observed client result, not an import-queue default.
    await user.type(screen.getByLabelText("Human summary"), "Canceled review export");
    mockPacketClient.exportQueue.push(true);
    await user.click(screen.getByRole("button", { name: "Export review packet" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/Review digest/i)).toBeNull();
    expect(screen.getByRole("status").textContent).not.toContain("Review packet loaded.");
    expect((screen.getByLabelText("Human summary") as HTMLTextAreaElement).value).toBe("Canceled review export");
    expect(exportedPackets).toHaveLength(1);
    expect(exportedPackets[0]).toMatchObject({ schema: "tfsb.design-review", summary: "Canceled review export" });

    // A subsequent successful export still commits the resulting review state.
    mockPacketClient.exportQueue.push(false);
    await user.click(screen.getByRole("button", { name: "Export review packet" }));
    expect(await screen.findByText(/Review digest/i)).toBeTruthy();
    expect(exportedPackets).toHaveLength(2);
  });

  it("keeps recipe, QA, source, and output mismatch proposals from prefilling", async () => {
    const user = userEvent.setup();
    const onProposalPrefill = vi.fn();
    const { mockPacketClient, mockReadClient } = createMockClients(sampleBrief);
    render(
      <DesignExchange
        host={mockHostStatus}
        project={{ ...mockProjectData, canonicalDigest: sampleBrief.context.project.canonicalDigest }}
        sources={[{ sourceHandle: "src-1", rootKind: "source", sourceKind: "directory", authorityKind: "npm-installed-package", digest: "sha256:1111", packageId: "existing-pkg", brandVersion: "1.0", brandSystemDigest: "sha256:2222", candidateCount: 1, profileCount: 1, assetCount: 1, companionCount: 0 }]}
        readClient={mockReadClient}
        packetClient={mockPacketClient}
        onProposalPrefill={onProposalPrefill}
      />
    );

    mockPacketClient.importQueue.push(sampleBrief);
    await user.click(screen.getByRole("button", { name: "Import brief" }));
    await screen.findByText(sampleBrief.title);

    // 1. Recipe mismatch
    const recipeMismatchCand = await finalizedCandidate(sampleCandidateA, {
      candidateId: "cand-recipe-mismatch",
      title: "Candidate Recipe Mismatch",
      proposal: { kind: "derive", selection: { kind: "recipes", recipeIds: ["nonexistent-recipe"] } },
    });
    mockPacketClient.importQueue.push(recipeMismatchCand);
    await user.click(screen.getByRole("button", { name: "Import candidate" }));
    await screen.findByText("Candidate Recipe Mismatch");
    onProposalPrefill.mockClear();
    await user.click(screen.getByRole("button", { name: "Load proposal into current plan form" }));
    expect((await screen.findByRole("alert")).textContent).toContain("The bounded design packet operation failed.");
    expect(onProposalPrefill).not.toHaveBeenCalled();

    // 2. QA unavailable (no qualified profile is advertised)
    const qaCand = await finalizedCandidate(sampleCandidateA, {
      candidateId: "cand-qa-unavailable",
      title: "Candidate QA Unavailable",
      proposal: { kind: "qa-baseline", profileId: "profile-1", caseId: "case-1" },
    });
    mockPacketClient.importQueue.push(qaCand);
    await user.click(screen.getByRole("button", { name: "Import candidate" }));
    await screen.findByText("Candidate QA Unavailable");
    const prefillButtons = screen.getAllByRole("button", { name: "Load proposal into current plan form" });
    onProposalPrefill.mockClear();
    await user.click(prefillButtons[1]!);
    expect((await screen.findByRole("alert")).textContent).toContain("The bounded design packet operation failed.");
    expect(onProposalPrefill).not.toHaveBeenCalled();

    // 3. Source mismatch
    const sourceMismatchCand = await finalizedCandidate(sampleCandidateA, {
      candidateId: "cand-source-mismatch",
      title: "Candidate Source Mismatch",
      proposal: { kind: "consumer-sync", sourcePackages: [{ packageId: "@pkg/different", brandVersion: "1.0.0", brandSystemDigest: `sha256:${"9".repeat(64)}` }] },
    });
    mockPacketClient.importQueue.push(sourceMismatchCand);
    await user.click(screen.getByRole("button", { name: "Import candidate" }));
    await screen.findByText("Candidate Source Mismatch");
    const prefillButtons3 = screen.getAllByRole("button", { name: "Load proposal into current plan form" });
    onProposalPrefill.mockClear();
    await user.click(prefillButtons3[2]!);
    expect((await screen.findByRole("alert")).textContent).toContain("The bounded design packet operation failed.");
    expect(onProposalPrefill).not.toHaveBeenCalled();

    // 4. Output mismatch
    const outputMismatchCand = await finalizedCandidate(sampleCandidateA, {
      candidateId: "cand-output-mismatch",
      title: "Candidate Output Mismatch",
      proposal: { kind: "export", profileId: "export-prof", outputIds: ["out-1"] },
    });
    mockPacketClient.importQueue.push(outputMismatchCand);
    await user.click(screen.getByRole("button", { name: "Import candidate" }));
    await screen.findByText("Candidate Output Mismatch");
    onProposalPrefill.mockClear();
    const listExportStatus = vi.spyOn(mockReadClient, "listExportStatus");
    const outputCard = screen.getByText(outputMismatchCand.title).closest("article");
    expect(outputCard).not.toBeNull();
    await user.click(within(outputCard as HTMLElement).getByRole("button", { name: "Load proposal into current plan form" }));
    expect((await screen.findByRole("alert")).textContent).toContain("The bounded design packet operation failed.");
    expect(listExportStatus).toHaveBeenCalledWith("proj-1", 128);
    expect(listExportStatus).toHaveBeenCalledTimes(1);
    expect(onProposalPrefill).not.toHaveBeenCalled();
    expect(screen.queryByText(/Draft proposal:/i)).toBeNull();
    expect(screen.getByText(outputMismatchCand.title)).toBeTruthy();
    listExportStatus.mockRestore();
  });

  it("disables the ninth candidate import after eight candidates are rendered", async () => {
    const user = userEvent.setup();
    const { mockPacketClient, mockReadClient } = createMockClients(sampleBrief);
    render(
      <DesignExchange
        host={mockHostStatus}
        project={{ ...mockProjectData, canonicalDigest: sampleBrief.context.project.canonicalDigest }}
        readClient={mockReadClient}
        packetClient={mockPacketClient}
        onProposalPrefill={vi.fn()}
      />
    );

    mockPacketClient.importQueue.push(sampleBrief);
    await user.click(screen.getByRole("button", { name: "Import brief" }));
    await screen.findByText(sampleBrief.title);

    // Import 8 candidates
    for (let index = 1; index <= 8; index += 1) {
      const cand = await finalizedCandidate(sampleCandidateA, {
        candidateId: `cand-cap-${index}`,
        title: `Candidate ${index}`,
      });
      mockPacketClient.importQueue.push(cand);
      await user.click(screen.getByRole("button", { name: "Import candidate" }));
      await screen.findByText(`Candidate ${index}`);
    }

    // The ninth-import control is disabled once eight candidates are rendered.
    const importCandBtn = screen.getByRole("button", { name: "Import candidate" });
    expect((importCandBtn as HTMLButtonElement).disabled).toBe(true);

    // Remove candidate 8
    const removeButtons = screen.getAllByRole("button", { name: "Remove candidate" });
    expect(removeButtons).toHaveLength(8);
    const candidateEight = screen.getByText("Candidate 8").closest("article");
    expect(candidateEight).not.toBeNull();
    await user.click(within(candidateEight!).getByRole("button", { name: "Remove candidate" }));
    expect(screen.queryByText("Candidate 8")).toBeNull();

    // "Import candidate" button is enabled again
    expect((screen.getByRole("button", { name: "Import candidate" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("accepts maximum-length vectors: 4096-char objective, 4096-char rationale, and 2048-char annotation comment", async () => {
    const user = userEvent.setup();
    const longObjective = "O".repeat(4096);
    const longRationale = "R".repeat(4096);
    const longComment = "C".repeat(2048);

    const onSave = vi.fn();
    const visual = sampleCandidateA.visualEvidence[0]!;
    const artifact = visual.artifacts[0]!;

    // Test AnnotationEditor with 2048-char comment
    render(<AnnotationEditor candidate={sampleCandidateA} visual={visual} artifact={artifact} imageUrl="blob:selected" onSave={onSave} />);
    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: longComment } });
    await user.click(screen.getByRole("button", { name: "Save annotation" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ comment: longComment }));

    // Test DesignExchange with candidate containing 4096-char rationale and brief containing 4096-char objective
    const { mockPacketClient, mockReadClient } = createMockClients(sampleBrief);
    const longBrief = {
      ...sampleBrief,
      objective: longObjective,
      briefDigest: await computePacketDigest({ ...sampleBrief, objective: longObjective }),
    };
    const longCand = await finalizedCandidate(sampleCandidateA, {
      candidateId: "long-cand",
      title: "Long Candidate",
      rationale: longRationale,
      briefDigest: longBrief.briefDigest,
    });
    render(
      <DesignExchange
        host={mockHostStatus}
        project={{ ...mockProjectData, canonicalDigest: sampleBrief.context.project.canonicalDigest }}
        readClient={mockReadClient}
        packetClient={mockPacketClient}
        onProposalPrefill={vi.fn()}
      />
    );
    mockPacketClient.importQueue.push(longBrief);
    await user.click(screen.getByRole("button", { name: "Import brief" }));
    mockPacketClient.importQueue.push(longCand);
    await user.click(screen.getByRole("button", { name: "Import candidate" }));
    expect(await screen.findByText(longRationale)).toBeTruthy();
  });


  it("proves exact-once URL.revokeObjectURL for packet replacement, project change, source change, host restart, component unmount, and late stale completion", async () => {
    const user = userEvent.setup();
    const createSpy = vi.spyOn(URL, "createObjectURL");
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL");
    createSpy.mockClear();
    revokeSpy.mockClear();

    const { mockPacketClient, mockReadClient } = createMockClients(sampleBrief);
    const onProposalPrefill = vi.fn();

    const initialSource: StudioSourceOpen = {
      sourceHandle: "src-1", rootKind: "source", sourceKind: "directory", authorityKind: "npm-installed-package",
      digest: "sha256:1111", packageId: "pkg-1", brandVersion: "1.0", brandSystemDigest: "sha256:2222",
      candidateCount: 1, profileCount: 1, assetCount: 1, companionCount: 0,
    };

    const { rerender, unmount } = render(
      <DesignExchange
        host={mockHostStatus}
        project={{ ...mockProjectData, canonicalDigest: sampleBrief.context.project.canonicalDigest }}
        sources={[initialSource]}
        readClient={mockReadClient}
        packetClient={mockPacketClient}
        onProposalPrefill={onProposalPrefill}
      />
    );

    mockPacketClient.importQueue.push(sampleBrief);
    await user.click(screen.getByRole("button", { name: "Import brief" }));
    await screen.findByText(sampleBrief.title);

    // Import candidateA: has 3 visual artifacts
    mockPacketClient.importQueue.push(sampleCandidateA);
    await user.click(screen.getByRole("button", { name: "Import candidate" }));
    await screen.findByText(sampleCandidateA.title);
    expect(createSpy).toHaveBeenCalledTimes(3);
    expect(revokeSpy).toHaveBeenCalledTimes(0);

    // 1. Packet replacement: remove candidate
    await user.click(screen.getByRole("button", { name: "Remove candidate" }));
    expect(revokeSpy).toHaveBeenCalledTimes(3);

    // Re-import candidateA
    mockPacketClient.importQueue.push(sampleCandidateA);
    await user.click(screen.getByRole("button", { name: "Import candidate" }));
    await screen.findByText(sampleCandidateA.title);
    expect(createSpy).toHaveBeenCalledTimes(6);
    expect(revokeSpy).toHaveBeenCalledTimes(3);

    // 2. Project identity change
    rerender(
      <DesignExchange
        host={mockHostStatus}
        project={{ ...mockProjectData, canonicalDigest: `sha256:${"9".repeat(64)}` }}
        sources={[initialSource]}
        readClient={mockReadClient}
        packetClient={mockPacketClient}
        onProposalPrefill={onProposalPrefill}
      />
    );
    expect(revokeSpy).toHaveBeenCalledTimes(6);

    // Re-import brief and candidateA
    mockPacketClient.importQueue.push(sampleBrief);
    await user.click(screen.getByRole("button", { name: "Import brief" }));
    mockPacketClient.importQueue.push(sampleCandidateA);
    await user.click(screen.getByRole("button", { name: "Import candidate" }));
    await screen.findByText(sampleCandidateA.title);
    expect(createSpy).toHaveBeenCalledTimes(9);
    expect(revokeSpy).toHaveBeenCalledTimes(6);

    // 3. Source identity change
    rerender(
      <DesignExchange
        host={mockHostStatus}
        project={{ ...mockProjectData, canonicalDigest: sampleBrief.context.project.canonicalDigest }}
        sources={[{ ...initialSource, digest: "sha256:changed-digest" }]}
        readClient={mockReadClient}
        packetClient={mockPacketClient}
        onProposalPrefill={onProposalPrefill}
      />
    );
    expect(revokeSpy).toHaveBeenCalledTimes(9);

    // Re-import brief and candidateA
    mockPacketClient.importQueue.push(sampleBrief);
    await user.click(screen.getByRole("button", { name: "Import brief" }));
    mockPacketClient.importQueue.push(sampleCandidateA);
    await user.click(screen.getByRole("button", { name: "Import candidate" }));
    await screen.findByText(sampleCandidateA.title);
    expect(createSpy).toHaveBeenCalledTimes(12);
    expect(revokeSpy).toHaveBeenCalledTimes(9);

    // 4. Host restart (host.state becomes "starting")
    rerender(
      <DesignExchange
        host={{ ...mockHostStatus, state: "starting" }}
        project={{ ...mockProjectData, canonicalDigest: sampleBrief.context.project.canonicalDigest }}
        sources={[initialSource]}
        readClient={mockReadClient}
        packetClient={mockPacketClient}
        onProposalPrefill={onProposalPrefill}
      />
    );
    expect(revokeSpy).toHaveBeenCalledTimes(12);

    // Restore host to ready, re-import brief and candidateA
    rerender(
      <DesignExchange
        host={mockHostStatus}
        project={{ ...mockProjectData, canonicalDigest: sampleBrief.context.project.canonicalDigest }}
        sources={[initialSource]}
        readClient={mockReadClient}
        packetClient={mockPacketClient}
        onProposalPrefill={onProposalPrefill}
      />
    );
    mockPacketClient.importQueue.push(sampleBrief);
    await user.click(screen.getByRole("button", { name: "Import brief" }));
    mockPacketClient.importQueue.push(sampleCandidateA);
    await user.click(screen.getByRole("button", { name: "Import candidate" }));
    await screen.findByText(sampleCandidateA.title);
    expect(createSpy).toHaveBeenCalledTimes(15);
    expect(revokeSpy).toHaveBeenCalledTimes(12);

    // 5. Component unmount
    unmount();
    expect(revokeSpy).toHaveBeenCalledTimes(15);
    expect(createSpy).toHaveBeenCalledTimes(15);

    // 6. Late stale completion
    const realBlobs = new VisualBlobUrlSet();
    let callCount = 0;
    await expect(createCandidateArtifactUrls(sampleCandidateA, realBlobs, () => {
      callCount += 1;
      return callCount <= 1;
    })).rejects.toThrow(/stale/u);
    expect(createSpy).toHaveBeenCalledTimes(16);
    expect(revokeSpy).toHaveBeenCalledTimes(16);

    createSpy.mockRestore();
    revokeSpy.mockRestore();
  });
});
