// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { computePacketDigest } from "../design-evidence/canonical";
import { DESIGN_PACKET_COMMANDS, validatePacketExportResult, validatePacketImportResult } from "../design-evidence/client";
import type { BriefPacket, CandidatePacket, DesignEvidencePacket } from "../design-evidence/types";
import { validateDesignEvidencePacket } from "../design-evidence/validate";
import { artifactKeyFor, createCandidateArtifactUrls, visualArtifactKey } from "../features/design-exchange/blob-identity";
import { designSessionReducer, initialDesignSession } from "../features/design-exchange/design-session-state";
import { vi } from "vitest";
import { VisualBlobUrlSet } from "../brand-read/blob-manager";

function example(name: string): DesignEvidencePacket { return JSON.parse(readFileSync(resolve("protocol/tfsb-design-evidence-v1/examples", name), "utf8")) as DesignEvidencePacket; }

describe("browser design evidence mirror", () => {
  it.each(["brief.json", "candidate-a.json", "candidate-b.json", "review.json"])("independently validates and matches the %s golden digest", async (name) => {
    const packet = example(name); const expected = packet.schema === "tfsb.design-brief" ? packet.briefDigest : packet.schema === "tfsb.design-candidate" ? packet.candidateDigest : packet.reviewDigest;
    expect(await computePacketDigest(packet)).toBe(expected);
    const validated = await validateDesignEvidencePacket(packet); expect(validated).toEqual(packet); expect(Object.isFrozen(validated)).toBe(true);
  });

  it("uses only the two fixed packet commands", () => {
    expect(DESIGN_PACKET_COMMANDS).toEqual({ import: "studio_design_packet_import", export: "studio_design_packet_export" });
  });

  it("runtime-validates the complete typed Tauri import and export envelopes", async () => {
    const packet = example("brief.json") as BriefPacket;
    const digest = packet.briefDigest;
    await expect(validatePacketImportResult({ cancelled: false, packet, kind: "brief", digest, byteCount: 42 })).resolves.toMatchObject({ cancelled: false, kind: "brief", digest, byteCount: 42 });
    await expect(validatePacketImportResult({ cancelled: "yes", packet, kind: "brief", digest, byteCount: 42 })).rejects.toThrow(/ipc-result-invalid/u);
    await expect(validatePacketImportResult({ cancelled: false, packet, kind: "candidate", digest, byteCount: 42 })).rejects.toThrow(/metadata-mismatch/u);
    await expect(validatePacketImportResult({ cancelled: true, digest })).rejects.toThrow(/ipc-result-invalid/u);
    expect(validatePacketExportResult({ cancelled: false, kind: "brief", digest, byteCount: 42 }, packet)).toEqual({ cancelled: false, kind: "brief", digest, byteCount: 42 });
    expect(() => validatePacketExportResult({ cancelled: false, kind: "brief", digest }, packet)).toThrow(/ipc-result-invalid/u);
    expect(() => validatePacketExportResult({ cancelled: true, kind: "brief", digest, byteCount: 0 }, packet)).toThrow(/ipc-result-invalid/u);
  });

  it("independently rejects every shared negative-corpus case", async () => {
    const corpus = JSON.parse(readFileSync(resolve("protocol/tfsb-design-evidence-v1/negative-corpus.json"), "utf8")) as { cases: Array<{ id: string; packet: unknown }> };
    for (const entry of corpus.cases) await expect(validateDesignEvidencePacket(entry.packet), entry.id).rejects.toThrow();
  });

  it("rejects duplicate candidate identities and clears draft authority on staleness", () => {
    const brief = example("brief.json") as BriefPacket; const candidate = example("candidate-a.json") as CandidatePacket;
    let state = designSessionReducer(initialDesignSession, { type: "brief", packet: brief, trust: "local-current" });
    state = designSessionReducer(state, { type: "candidate", candidate: { packet: candidate, trust: "context-matched-external", artifactUrls: { first: "blob:first" } } });
    state = designSessionReducer(state, { type: "candidate", candidate: { packet: candidate, trust: "context-matched-external", artifactUrls: { duplicate: "blob:duplicate" } } });
    expect(state.candidates).toHaveLength(1); expect(state.announcement).toMatch(/duplicate/i);
    state = designSessionReducer(state, { type: "prefill", proposal: candidate.proposal }); expect(state.draftProposal?.kind).toBe("derive");
    state = designSessionReducer(state, { type: "stale" }); expect(state.draftProposal).toBeUndefined(); expect(state.candidates[0]?.trust).toBe("context-stale"); expect(state.candidates[0]?.artifactUrls).toEqual({});
  });

  it("keys every artifact by candidate, visual, role, and PNG digest without old-index collisions using actual VisualBlobUrlSet", async () => {
    const candidate = example("candidate-a.json") as CandidatePacket;
    expect(candidate.visualEvidence[0]?.artifacts).toHaveLength(2); expect(candidate.visualEvidence).toHaveLength(2);
    const keys = candidate.visualEvidence.flatMap((visual) => visual.artifacts.map((artifact) => artifactKeyFor(candidate, visual, artifact)));
    expect(new Set(keys).size).toBe(3); expect(keys[1]).not.toBe(keys[2]);
    expect(visualArtifactKey(candidate.candidateDigest, candidate.visualEvidence[0]!.evidenceDigest, candidate.visualEvidence[0]!.artifacts[1]!.role, candidate.visualEvidence[0]!.artifacts[1]!.pngDigest)).toBe(keys[1]);
    const createSpy = vi.spyOn(URL, "createObjectURL");
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL");
    const realBlobs = new VisualBlobUrlSet();
    const urls = await createCandidateArtifactUrls(candidate, realBlobs, () => true);
    expect(Object.keys(urls)).toEqual(keys);
    expect(createSpy).toHaveBeenCalledTimes(3);
    expect(revokeSpy).not.toHaveBeenCalled();
    for (const url of Object.values(urls)) realBlobs.revoke(url);
    expect(revokeSpy).toHaveBeenCalledTimes(3);
    for (const url of Object.values(urls)) realBlobs.revoke(url);
    expect(revokeSpy).toHaveBeenCalledTimes(3);
    createSpy.mockRestore();
    revokeSpy.mockRestore();
  });

  it("revokes a stale async candidate import before it can attach URLs using actual VisualBlobUrlSet", async () => {
    const candidate = example("candidate-a.json") as CandidatePacket;
    let callCount = 0;
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL");
    revokeSpy.mockClear();
    const realBlobs = new VisualBlobUrlSet();
    await expect(createCandidateArtifactUrls(candidate, realBlobs, () => {
      callCount += 1;
      return callCount <= 1;
    })).rejects.toThrow(/stale/u);
    expect(revokeSpy).toHaveBeenCalledTimes(1);
    revokeSpy.mockRestore();
  });
});
