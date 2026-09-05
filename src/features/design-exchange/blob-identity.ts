import { VisualBlobUrlSet } from "../../brand-read/blob-manager";
import type { VisualArtifact, VisualEvidence } from "../../brand-read/StudioBrandReadClient";
import type { CandidatePacket } from "../../design-evidence/types";

export type ArtifactUrlMap = Readonly<Record<string, string>>;

export function visualArtifactKey(
  candidateDigest: string,
  visualEvidenceDigest: string,
  artifactRole: VisualArtifact["role"],
  pngDigest: string,
): string {
  return `${candidateDigest}\u0000${visualEvidenceDigest}\u0000${artifactRole}\u0000${pngDigest}`;
}

export function artifactKeyFor(
  candidate: CandidatePacket,
  visual: VisualEvidence,
  artifact: VisualArtifact,
): string {
  return visualArtifactKey(candidate.candidateDigest, visual.evidenceDigest, artifact.role, artifact.pngDigest);
}

export async function createCandidateArtifactUrls(
  candidate: CandidatePacket,
  blobs: VisualBlobUrlSet,
  remainsCurrent: () => boolean,
): Promise<ArtifactUrlMap> {
  const artifacts = candidate.visualEvidence.flatMap((visual) => visual.artifacts.map((artifact) => ({ visual, artifact, key: artifactKeyFor(candidate, visual, artifact) })));
  if (new Set(artifacts.map(({ key }) => key)).size !== artifacts.length) throw new Error("duplicate-artifact-key");
  const created: string[] = [];
  try {
    const result: Record<string, string> = {};
    for (const { artifact, key } of artifacts) {
      if (!remainsCurrent()) throw new Error("stale-candidate-import");
      const url = await blobs.create(artifact); created.push(url);
      if (!remainsCurrent()) throw new Error("stale-candidate-import");
      result[key] = url;
    }
    return Object.freeze(result);
  } catch (error) {
    created.forEach((url) => blobs.revoke(url));
    throw error;
  }
}

export function revokeArtifactUrls(urls: ArtifactUrlMap, blobs: VisualBlobUrlSet): void {
  Object.values(urls).forEach((url) => blobs.revoke(url));
}
