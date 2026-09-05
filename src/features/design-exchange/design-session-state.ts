import type { BriefPacket, CandidateDisposition, CandidatePacket, PacketTrustState, Proposal, ReviewAnnotation, ReviewPacket } from "../../design-evidence/types";
import type { ArtifactUrlMap } from "./blob-identity";

export interface ImportedCandidate { readonly packet: CandidatePacket; readonly trust: PacketTrustState; readonly artifactUrls: ArtifactUrlMap }
export interface DesignSessionState { readonly brief: BriefPacket | undefined; readonly briefTrust: PacketTrustState | undefined; readonly candidates: readonly ImportedCandidate[]; readonly annotations: readonly ReviewAnnotation[]; readonly dispositions: Readonly<Record<string, CandidateDisposition>>; readonly review: ReviewPacket | undefined; readonly draftProposal: Proposal | undefined; readonly announcement: string }
export const initialDesignSession: DesignSessionState = { brief: undefined, briefTrust: undefined, candidates: [], annotations: [], dispositions: {}, review: undefined, draftProposal: undefined, announcement: "No design packet loaded." };
export type DesignSessionAction =
  | { readonly type: "brief"; readonly packet: BriefPacket; readonly trust: PacketTrustState }
  | { readonly type: "candidate"; readonly candidate: ImportedCandidate }
  | { readonly type: "annotation"; readonly annotation: ReviewAnnotation }
  | { readonly type: "delete-annotation"; readonly annotationId: string }
  | { readonly type: "remove-candidate"; readonly candidateDigest: string }
  | { readonly type: "disposition"; readonly digest: string; readonly disposition: CandidateDisposition }
  | { readonly type: "review"; readonly review: ReviewPacket }
  | { readonly type: "prefill"; readonly proposal: Proposal }
  | { readonly type: "stale" }
  | { readonly type: "clear" };
export function designSessionReducer(state: DesignSessionState, action: DesignSessionAction): DesignSessionState {
  if (action.type === "clear") return initialDesignSession;
  if (action.type === "brief") return { ...initialDesignSession, brief: action.packet, briefTrust: action.trust, announcement: "Design brief loaded." };
  if (action.type === "candidate") {
    if (state.candidates.length >= 8 || state.candidates.some(({ packet }) => packet.candidateId === action.candidate.packet.candidateId || packet.candidateDigest === action.candidate.packet.candidateDigest)) return { ...state, announcement: "Candidate rejected: duplicate identity or eight-candidate limit." };
    return { ...state, candidates: [...state.candidates, action.candidate].sort((a, b) => a.packet.candidateDigest < b.packet.candidateDigest ? -1 : 1), dispositions: { ...state.dispositions, [action.candidate.packet.candidateDigest]: "unreviewed" }, review: undefined, announcement: "Candidate imported as untrusted external evidence." };
  }
  if (action.type === "annotation") return { ...state, annotations: [...state.annotations.filter(({ annotationId }) => annotationId !== action.annotation.annotationId), action.annotation], review: undefined, announcement: "Annotation saved." };
  if (action.type === "delete-annotation") return { ...state, annotations: state.annotations.filter(({ annotationId }) => annotationId !== action.annotationId), review: undefined, announcement: "Annotation deleted." };
  if (action.type === "remove-candidate") return { ...state, candidates: state.candidates.filter(({ packet }) => packet.candidateDigest !== action.candidateDigest), annotations: state.annotations.filter(({ candidateDigest }) => candidateDigest !== action.candidateDigest), dispositions: Object.fromEntries(Object.entries(state.dispositions).filter(([candidateDigest]) => candidateDigest !== action.candidateDigest)), review: undefined, draftProposal: undefined, announcement: "Candidate removed." };
  if (action.type === "disposition") {
    const exclusive = action.disposition === "preferred" || action.disposition === "approved";
    return { ...state, dispositions: Object.fromEntries(Object.entries({ ...state.dispositions, [action.digest]: action.disposition }).map(([digest, disposition]) => [digest, exclusive && digest !== action.digest && (disposition === "preferred" || disposition === "approved") ? "unreviewed" : disposition])), review: undefined, announcement: `Disposition set to ${action.disposition}.` };
  }
  if (action.type === "review") return { ...state, review: action.review, annotations: action.review.annotations, dispositions: Object.fromEntries(action.review.dispositions.map((entry) => [entry.candidateDigest, entry.disposition])), announcement: "Review packet loaded." };
  if (action.type === "prefill") return { ...state, draftProposal: action.proposal, announcement: "Proposal loaded into draft form only. No plan was created or acknowledged." };
  return { ...state, briefTrust: state.brief ? "context-stale" : state.briefTrust, candidates: state.candidates.map((candidate) => ({ ...candidate, trust: "context-stale", artifactUrls: Object.freeze({}) })), draftProposal: undefined, announcement: "Project or host identity changed; packet evidence is stale and proposal prefill is disabled." };
}
