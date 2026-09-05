import { useEffect, useReducer, useRef, useState } from "react";
import type { StudioBrandReadClient, VisualArtifact, VisualEvidence } from "../../brand-read/StudioBrandReadClient";
import { VisualBlobUrlSet } from "../../brand-read/blob-manager";
import type { StudioHostStatus, StudioProjectOpen, StudioSourceOpen } from "../../protocol/contracts";
import { canonicalPacketJson, computePacketDigest } from "../../design-evidence/canonical";
import { TauriDesignPacketClient, type DesignPacketClient } from "../../design-evidence/client";
import type { BriefPacket, CandidateDisposition, CandidatePacket, DesignEvidencePacket, PacketTrustState, Proposal, ReviewAnnotation, ReviewPacket } from "../../design-evidence/types";
import { DesignEvidenceBrowserValidationError, validateDesignEvidencePacket, validateDesignEvidenceReviewLinks } from "../../design-evidence/validate";
import { AnnotationEditor } from "./AnnotationEditor";
import { BriefBuilder, type BriefDraftInput, type BriefTargetOption } from "./BriefBuilder";
import { PacketTrustBadge } from "./PacketTrustBadge";
import { artifactKeyFor, createCandidateArtifactUrls, revokeArtifactUrls } from "./blob-identity";
import { designSessionReducer, initialDesignSession } from "./design-session-state";

const dispositions: readonly CandidateDisposition[] = ["unreviewed", "preferred", "approved", "rejected", "needs-revision", "deferred"];
const zeroDigest = `sha256:${"0".repeat(64)}` as const;

function trustForBrief(packet: BriefPacket, project: StudioProjectOpen | undefined, brandDigest: string | null | undefined): PacketTrustState {
  if (!project?.canonicalDigest || !brandDigest) return "self-consistent-external";
  return packet.context.project.canonicalDigest === project.canonicalDigest && packet.context.project.brandSystemDigest === brandDigest ? "context-matched-external" : "context-mismatch";
}

async function withDigest<T extends DesignEvidencePacket>(packet: T): Promise<T> {
  const digest = await computePacketDigest(packet);
  const finalized = packet.schema === "tfsb.design-brief" ? { ...packet, briefDigest: digest } : packet.schema === "tfsb.design-candidate" ? { ...packet, candidateDigest: digest } : { ...packet, reviewDigest: digest };
  return await validateDesignEvidencePacket(finalized) as T;
}

interface SelectedArtifact {
  readonly visual: VisualEvidence;
  readonly artifact: VisualArtifact;
  readonly key: string;
  readonly url: string;
}

export async function resolveBriefTargetEvidence(
  readClient: StudioBrandReadClient,
  projectHandle: string,
  targets: BriefDraftInput["targets"],
  remainsCurrent: () => boolean,
): Promise<readonly { readonly option: BriefTargetOption; readonly identity: Awaited<ReturnType<StudioBrandReadClient["getAssetIdentity"]>>; readonly evidence: readonly VisualEvidence[] }[]> {
  const resolved = [] as { readonly option: BriefTargetOption; readonly identity: Awaited<ReturnType<StudioBrandReadClient["getAssetIdentity"]>>; readonly evidence: readonly VisualEvidence[] }[];
  for (const target of targets) {
    const identity = await readClient.getAssetIdentity(projectHandle, target.option.assetId);
    if (!remainsCurrent() || identity.assetId !== target.option.assetId) throw new Error("stale-identity");
    const evidence: VisualEvidence[] = [];
    for (const tuple of target.visualTuples) {
      const visual = await readClient.getVisualEvidence({ kind: "project-render", projectHandle, target: target.option.target, ...tuple });
      if (!remainsCurrent() || visual.target.assetId !== identity.assetId || visual.target.canonicalAssetDigest !== identity.canonicalAssetDigest || visual.target.svgDigest !== identity.svgDigest || visual.configuration.width !== tuple.width || visual.configuration.height !== tuple.height || visual.configuration.background !== tuple.background) throw new Error("stale-visual");
      evidence.push(visual);
    }
    resolved.push({ option: target.option, identity, evidence });
  }
  return resolved;
}

export function DesignExchange({ host, project, sources = [], readClient, packetClient = new TauriDesignPacketClient(), onProposalPrefill }: {
  readonly host: StudioHostStatus;
  readonly project: StudioProjectOpen | undefined;
  readonly sources?: readonly StudioSourceOpen[];
  readonly readClient: StudioBrandReadClient;
  readonly packetClient?: DesignPacketClient;
  readonly onProposalPrefill: (proposal: Proposal | undefined) => void;
}) {
  const [state, dispatch] = useReducer(designSessionReducer, initialDesignSession);
  const blobs = useRef(new VisualBlobUrlSet()); const epoch = useRef(0);
  const sourceIdentity = sources.map((source) => `${source.sourceHandle}:${source.digest ?? ""}:${source.brandSystemDigest ?? ""}`).sort().join(",");
  const identity = `${host.state}|${project?.canonicalDigest ?? ""}|${project?.projectHandle ?? ""}|${sourceIdentity}`; const previousIdentity = useRef(identity);
  const [brandDigest, setBrandDigest] = useState<string | null>(); const [targetOptions, setTargetOptions] = useState<readonly BriefTargetOption[]>([]); const [tokenIds, setTokenIds] = useState<readonly string[]>([]); const [recipeIds, setRecipeIds] = useState<readonly string[]>([]); const [qaProfileIds, setQaProfileIds] = useState<readonly string[]>([]);
  const [selectedDigest, setSelectedDigest] = useState(""); const [selectedArtifactKey, setSelectedArtifactKey] = useState(""); const [editingAnnotationId, setEditingAnnotationId] = useState(""); const [overall, setOverall] = useState<"no-decision" | "preferred" | "approved" | "needs-revision" | "rejected-all">("no-decision"); const [overallCandidateDigest, setOverallCandidateDigest] = useState(""); const [reviewSummary, setReviewSummary] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState<string>();
  const selected = state.candidates.find(({ packet }) => packet.candidateDigest === selectedDigest);
  const selectedArtifact: SelectedArtifact | undefined = selected?.packet.visualEvidence.flatMap((visual) => visual.artifacts.map((artifact) => { const key = artifactKeyFor(selected.packet, visual, artifact); const url = selected.artifactUrls[key]; return url ? { visual, artifact, key, url } : undefined; })).find((entry): entry is SelectedArtifact => entry?.key === selectedArtifactKey);
  const editingAnnotation = state.annotations.find(({ annotationId }) => annotationId === editingAnnotationId && selectedArtifact && selectedDigest === selected?.packet.candidateDigest);

  useEffect(() => () => { epoch.current += 1; blobs.current.revokeAll(); }, []);
  useEffect(() => {
    if (previousIdentity.current === identity) return;
    previousIdentity.current = identity; epoch.current += 1; blobs.current.revokeAll(); setSelectedDigest(""); setSelectedArtifactKey(""); setEditingAnnotationId(""); setOverall("no-decision"); setOverallCandidateDigest(""); setReviewSummary(""); onProposalPrefill(undefined); dispatch({ type: "stale" });
  }, [identity, onProposalPrefill]);
  useEffect(() => {
    let active = true; setBrandDigest(undefined); setTargetOptions([]); setTokenIds([]); setRecipeIds([]); setQaProfileIds([]);
    if (host.state !== "ready" || !project) return () => { active = false; };
    void Promise.all([
      readClient.getBrandStatus(project.projectHandle), readClient.listFamilies(project.projectHandle, 128), readClient.listTokens(project.projectHandle, 128), readClient.getRecipeGraph(project.projectHandle), readClient.listQaProfiles(project.projectHandle, 128),
    ]).then(([status, families, tokens, recipes, profiles]) => {
      if (!active) return;
      setBrandDigest(status.present ? status.brandSystemDigest : null);
      const bindings = families.page.items.flatMap((family) => family.bindings.map((binding): BriefTargetOption => ({ key: `binding:${binding.family}/${binding.role}/${binding.variant}`, label: `Binding ${binding.family} / ${binding.role} / ${binding.variant} → ${binding.asset}`, target: { kind: "binding", family: binding.family, role: binding.role, variant: binding.variant }, assetId: binding.asset, purpose: binding.role })));
      const assets = [...new Set(families.page.items.flatMap((family) => family.bindings.map((binding) => binding.asset)))].sort().map((asset): BriefTargetOption => ({ key: `asset:${asset}`, label: `Asset ${asset}`, target: { kind: "asset", assetId: asset }, assetId: asset, purpose: "asset" }));
      setTargetOptions([...assets, ...bindings].sort((left, right) => left.key.localeCompare(right.key))); setTokenIds(tokens.page.items.map(({ id }) => id).sort()); setRecipeIds(recipes.nodes.map(({ recipeId }) => recipeId).sort()); setQaProfileIds(profiles.page.items.map(({ id }) => id).sort());
    }, () => { if (active) setError("Live packet context could not be loaded."); });
    return () => { active = false; };
  }, [host.state, project?.projectHandle, readClient]);

  const operate = async (work: () => Promise<void>) => {
    setBusy(true); setError(undefined);
    try { await work(); }
    catch (failure) { setError(failure instanceof DesignEvidenceBrowserValidationError ? `Packet rejected: ${failure.category} validation failed.` : "The bounded design packet operation failed."); }
    finally { setBusy(false); }
  };

  const createBrief = (input: BriefDraftInput) => void operate(async () => {
    const attachmentCount = input.targets.reduce((total, target) => total + target.visualTuples.length, 0);
    if (!project?.canonicalDigest || !brandDigest || attachmentCount > 8) throw new Error("incomplete-brief");
    const generation = epoch.current; const projectDigest = project.canonicalDigest;
    const resolved = await resolveBriefTargetEvidence(readClient, project.projectHandle, input.targets, () => generation === epoch.current && project.canonicalDigest === projectDigest);
    const targets = resolved.map(({ option, identity: targetIdentity }) => ({ targetId: option.target.kind === "asset" ? option.target.assetId : `${option.target.family}.${option.target.role}.${option.target.variant}`, selector: option.target, canonicalAssetDigest: targetIdentity.canonicalAssetDigest, svgDigest: targetIdentity.svgDigest, purpose: option.purpose })).sort((left, right) => left.targetId.localeCompare(right.targetId));
    const visualEvidence = resolved.flatMap(({ evidence }) => evidence);
    const packet = await withDigest<BriefPacket>({ schema: "tfsb.design-brief", schemaVersion: 1, briefId: input.briefId, revision: 1, title: input.title, objective: input.objective, context: { corePackageVersion: "0.4.0", studioVersion: "0.1.0", studioProtocolVersion: "1.2", project: { ...(input.projectLabel ? { label: input.projectLabel } : {}), canonicalDigest: project.canonicalDigest as BriefPacket["context"]["project"]["canonicalDigest"], brandSystemDigest: brandDigest as BriefPacket["context"]["project"]["brandSystemDigest"] } }, targets, constraints: { allowedProposalKinds: input.allowedProposalKinds, requiredTokenIds: input.requiredTokenIds, requiredRecipeIds: input.requiredRecipeIds, qaProfileIds: input.qaProfileIds, renderTuples: input.renderTuples, acceptanceCriteria: input.acceptanceCriteria, prohibitedChanges: input.prohibitedChanges }, materials: input.material ? [input.material] : [], visualEvidence, briefDigest: zeroDigest });
    epoch.current += 1; blobs.current.revokeAll(); onProposalPrefill(undefined); setSelectedDigest(""); setSelectedArtifactKey(""); setOverall("no-decision"); setOverallCandidateDigest(""); setReviewSummary(""); dispatch({ type: "brief", packet, trust: "local-current" }); await packetClient.exportPacket(packet);
  });

  const importBrief = () => void operate(async () => {
    const result = await packetClient.importPacket("brief"); if (result.cancelled) return;
    const packet = await validateDesignEvidencePacket(result.packet); if (packet.schema !== "tfsb.design-brief") throw new Error("kind");
    epoch.current += 1; blobs.current.revokeAll(); onProposalPrefill(undefined); setSelectedDigest(""); setSelectedArtifactKey(""); setOverall("no-decision"); setOverallCandidateDigest(""); setReviewSummary(""); dispatch({ type: "brief", packet, trust: trustForBrief(packet, project, brandDigest) });
  });

  const importCandidate = () => void operate(async () => {
    if (!state.brief || state.candidates.length >= 8) throw new Error("candidate-cap");
    const result = await packetClient.importPacket("candidate"); if (result.cancelled) return;
    const packet = await validateDesignEvidencePacket(result.packet); if (packet.schema !== "tfsb.design-candidate" || packet.briefDigest !== state.brief.briefDigest || state.candidates.some((entry) => entry.packet.candidateId === packet.candidateId || entry.packet.candidateDigest === packet.candidateDigest)) throw new Error("candidate-mismatch");
    if (packet.revisionOf) { const parent = state.candidates.find((entry) => entry.packet.candidateDigest === packet.revisionOf); if (!parent || packet.revision <= parent.packet.revision) throw new Error("revision-chain-mismatch"); }
    const generation = epoch.current; const briefDigest = state.brief.briefDigest; const artifactUrls = await createCandidateArtifactUrls(packet, blobs.current, () => epoch.current === generation && state.brief?.briefDigest === briefDigest);
    if (epoch.current !== generation) { revokeArtifactUrls(artifactUrls, blobs.current); return; }
    dispatch({ type: "candidate", candidate: { packet, trust: trustForBrief(state.brief, project, brandDigest), artifactUrls } });
  });

  const removeCandidate = (candidateDigest: string) => {
    const candidate = state.candidates.find(({ packet }) => packet.candidateDigest === candidateDigest); if (!candidate) return;
    revokeArtifactUrls(candidate.artifactUrls, blobs.current); dispatch({ type: "remove-candidate", candidateDigest }); if (overallCandidateDigest === candidateDigest) setOverallCandidateDigest(""); if (selectedDigest === candidateDigest) { setSelectedDigest(""); setSelectedArtifactKey(""); setEditingAnnotationId(""); }
  };

  const eligibleOverallCandidates = overall === "preferred" || overall === "approved" || overall === "needs-revision" ? state.candidates.filter(({ packet }) => state.dispositions[packet.candidateDigest] === overall) : [];
  const reviewInvariantSatisfied = overall === "no-decision" ? overallCandidateDigest === "" : overall === "rejected-all" ? overallCandidateDigest === "" && state.candidates.length > 0 && state.candidates.every(({ packet }) => state.dispositions[packet.candidateDigest] === "rejected") : eligibleOverallCandidates.some(({ packet }) => packet.candidateDigest === overallCandidateDigest);

  const buildReview = async (): Promise<ReviewPacket> => {
    if (!state.brief || state.candidates.length === 0) throw new Error("no-candidates");
    if (!reviewInvariantSatisfied) throw new Error("review-invariant");
    const candidateDigests = state.candidates.map(({ packet }) => packet.candidateDigest).sort(); const records = candidateDigests.map((candidateDigest) => ({ candidateDigest, disposition: state.dispositions[candidateDigest] ?? "unreviewed" as const }));
    const overallDisposition = overall === "preferred" || overall === "approved" || overall === "needs-revision" ? { kind: overall, candidateDigest: overallCandidateDigest as ReviewPacket["candidateDigests"][number] } : { kind: overall };
    return withDigest<ReviewPacket>({ schema: "tfsb.design-review", schemaVersion: 1, briefDigest: state.brief.briefDigest, candidateDigests, annotations: [...state.annotations].sort((left, right) => left.annotationId.localeCompare(right.annotationId)), dispositions: records, overallDisposition: overallDisposition as ReviewPacket["overallDisposition"], summary: reviewSummary, reviewDigest: zeroDigest });
  };

  const exportReview = () => void operate(async () => { const review = await buildReview(); validateDesignEvidenceReviewLinks(review, state.candidates.map(({ packet }) => packet)); const result = await packetClient.exportPacket(review); if (result.cancelled) return; dispatch({ type: "review", review }); });
  const importReview = () => void operate(async () => {
    const result = await packetClient.importPacket("review"); if (result.cancelled || !state.brief) return; const packet = await validateDesignEvidencePacket(result.packet); if (packet.schema !== "tfsb.design-review" || packet.briefDigest !== state.brief.briefDigest) throw new Error("review-mismatch"); validateDesignEvidenceReviewLinks(packet, state.candidates.map(({ packet: candidate }) => candidate)); setOverall(packet.overallDisposition.kind); setOverallCandidateDigest("candidateDigest" in packet.overallDisposition ? packet.overallDisposition.candidateDigest : ""); setReviewSummary(packet.summary); dispatch({ type: "review", review: packet });
  });

  const loadProposal = (candidate: CandidatePacket, trust: PacketTrustState) => void operate(async () => {
    const validated = await validateDesignEvidencePacket(candidate); if (validated.schema !== "tfsb.design-candidate" || validated.proposal.kind === "evidence-only" || trust !== "context-matched-external" || !project) throw new Error("prefill-disabled"); const proposal = validated.proposal;
    if (proposal.kind === "derive" && proposal.selection.kind === "recipes" && proposal.selection.recipeIds.some((recipeId) => !recipeIds.includes(recipeId))) throw new Error("recipe-mismatch");
    if (proposal.kind === "qa-baseline") { if (!host.raster.available || !qaProfileIds.includes(proposal.profileId)) throw new Error("qa-unavailable"); const profile = await readClient.getQaProfile(project.projectHandle, proposal.profileId); if (!profile.profile.cases.includes(proposal.caseId)) throw new Error("qa-case-mismatch"); }
    if (proposal.kind === "consumer-install" || proposal.kind === "consumer-sync") { const matched = proposal.sourcePackages.map((sourcePackage) => sources.find((source) => source.packageId === sourcePackage.packageId && source.brandVersion === sourcePackage.brandVersion && source.brandSystemDigest === sourcePackage.brandSystemDigest)); if (matched.some((source) => source === undefined)) throw new Error("source-mismatch"); const profiles = await readClient.listConsumerProfiles(project.projectHandle, matched.map((source) => source!.sourceHandle), 128); if (proposal.profileIds?.some((profileId) => !profiles.page.items.some((profile) => profile.qualifiedProfileId === profileId))) throw new Error("profile-mismatch"); }
    if (proposal.kind === "export") { if (!host.raster.available) throw new Error("raster-unavailable"); const status = await readClient.listExportStatus(project.projectHandle, 128); const matches = status.page.items.filter(({ profileId }) => profileId === proposal.profileId); if (matches.length === 0 || proposal.outputIds?.some((outputId) => !matches.some((entry) => entry.outputId === outputId))) throw new Error("output-mismatch"); }
    dispatch({ type: "prefill", proposal }); onProposalPrefill(proposal);
  });

  const candidateCards = state.candidates.map(({ packet, trust, artifactUrls }) => {
    const figures = packet.visualEvidence.flatMap((visual) => visual.artifacts.map((artifact) => {
      const key = artifactKeyFor(packet, visual, artifact), url = artifactUrls[key];
      return <figure key={key}>
        {url ? <img src={url} alt={`${packet.title}, ${visual.target.assetId}, ${artifact.role}, ${artifact.width} by ${artifact.height}, ${visual.configuration.background}`} /> : <div className="stale-artifact">Visual bytes revoked</div>}
        <figcaption>{visual.target.assetId} · {artifact.role} · {artifact.width}×{artifact.height} · {visual.configuration.background}</figcaption>
        <button type="button" disabled={!url} aria-pressed={selectedArtifactKey === key} onClick={() => { setSelectedDigest(packet.candidateDigest); setSelectedArtifactKey(key); setEditingAnnotationId(""); }}>Select this artifact for annotation</button>
      </figure>;
    }));
    return <article className={`candidate-card${packet.candidateDigest === selectedDigest ? " selected-candidate" : ""}`} key={packet.candidateDigest}>
      <button type="button" className="candidate-select" aria-pressed={packet.candidateDigest === selectedDigest} onClick={() => { setSelectedDigest(packet.candidateDigest); setSelectedArtifactKey(""); setEditingAnnotationId(""); }}><h3>{packet.title}</h3></button>
      <PacketTrustBadge state={trust} />{figures}<p>{packet.rationale}</p><p>QA claim: {packet.qaSummary.status}; proposal: {packet.proposal.kind}</p><p>Candidate digest <code>{packet.candidateDigest}</code></p>
      <fieldset><legend>Human disposition</legend>{dispositions.map((disposition) => <label key={disposition}><input type="radio" name={`disposition-${packet.candidateDigest}`} checked={(state.dispositions[packet.candidateDigest] ?? "unreviewed") === disposition} onChange={() => { dispatch({ type: "disposition", digest: packet.candidateDigest, disposition }); if (overallCandidateDigest === packet.candidateDigest && disposition !== overall) setOverallCandidateDigest(""); }} />{disposition}</label>)}</fieldset>
      {packet.proposal.kind !== "evidence-only" ? <button type="button" disabled={trust !== "context-matched-external"} onClick={() => loadProposal(packet, trust)}>Load proposal into current plan form</button> : <p>Evidence-only packet: no plan prefill.</p>}
      <button type="button" onClick={() => removeCandidate(packet.candidateDigest)}>Remove candidate</button>
    </article>;
  });

  return <section className="design-exchange" aria-labelledby="design-exchange-title">
    <div className="section-heading"><div><p className="section-kicker">Closed human–agent evidence packets</p><h2 id="design-exchange-title">Design exchange</h2></div><p>External authorship is self-asserted. Packet integrity is not a signature, license conclusion, or plan authority.</p></div>
    {error ? <p role="alert">{error}</p> : null}<p role="status" aria-live="polite">{state.announcement}</p><div className="exchange-controls"><button type="button" disabled={busy} onClick={importBrief}>Import brief</button><button type="button" disabled={busy || !state.brief || state.candidates.length >= 8} onClick={importCandidate}>Import candidate</button><button type="button" disabled={busy || state.candidates.length === 0} onClick={importReview}>Import prior review</button></div>
    <BriefBuilder ready={host.state === "ready" && Boolean(project && brandDigest)} targetOptions={targetOptions} tokenIds={tokenIds} recipeIds={recipeIds} qaProfileIds={qaProfileIds} busy={busy} onCreate={createBrief} />
    {state.brief ? <article className="packet-summary"><h3>{state.brief.title}</h3><PacketTrustBadge state={state.briefTrust ?? "invalid"} /><p>{state.brief.targets.length} targets · {state.brief.visualEvidence.length} visuals · {state.brief.visualEvidence.reduce((total, visual) => total + visual.artifacts.reduce((sum, artifact) => sum + artifact.byteLength, 0), 0)} visual bytes · {new TextEncoder().encode(canonicalPacketJson(state.brief)).byteLength} packet bytes</p><p>Brief digest <code>{state.brief.briefDigest}</code></p></article> : null}
    {state.candidates.length ? <><div className="candidate-comparison" role="group" aria-label="Imported candidate comparison">{candidateCards}</div>
      {selected && selectedArtifact ? <AnnotationEditor key={`${selectedArtifact.key}:${editingAnnotation?.annotationId ?? "new"}`} candidate={selected.packet} visual={selectedArtifact.visual} artifact={selectedArtifact.artifact} imageUrl={selectedArtifact.url} {...(editingAnnotation ? { editing: editingAnnotation } : {})} onCancelEdit={() => setEditingAnnotationId("")} onSave={(annotation) => dispatch({ type: "annotation", annotation })} /> : <p>Select a candidate artifact explicitly to annotate it.</p>}
      <section aria-labelledby="annotation-list-heading"><h3 id="annotation-list-heading">Annotations</h3><ol>{state.annotations.map((annotation) => { const candidate = state.candidates.find(({ packet }) => packet.candidateDigest === annotation.candidateDigest); const visual = candidate?.packet.visualEvidence.find(({ evidenceDigest }) => evidenceDigest === annotation.visualEvidenceDigest); const artifact = visual?.artifacts.find(({ role, pngDigest }) => role === annotation.artifactRole && pngDigest === annotation.pngDigest); const key = candidate && visual && artifact ? artifactKeyFor(candidate.packet, visual, artifact) : ""; return <li key={annotation.annotationId}>{annotation.scope.kind === "artifact" ? "Whole artifact" : `${annotation.scope.xMillionths},${annotation.scope.yMillionths} ${annotation.scope.widthMillionths}×${annotation.scope.heightMillionths}`} · {annotation.artifactRole} · {annotation.category} · {annotation.severity}: {annotation.comment} <button type="button" disabled={!key} onClick={() => { setSelectedDigest(annotation.candidateDigest); setSelectedArtifactKey(key); setEditingAnnotationId(annotation.annotationId); }}>Edit</button> <button type="button" onClick={() => dispatch({ type: "delete-annotation", annotationId: annotation.annotationId })}>Delete</button></li>; })}</ol></section>
      <article className="panel review-builder"><h3>Review packet</h3><label>Overall disposition <select value={overall} onChange={(event) => { setOverall(event.target.value as typeof overall); setOverallCandidateDigest(""); }}><option value="no-decision">no-decision</option><option value="preferred">preferred</option><option value="approved">approved</option><option value="needs-revision">needs-revision</option><option value="rejected-all">rejected-all</option></select></label>{overall === "preferred" || overall === "approved" || overall === "needs-revision" ? <label>Overall candidate <select value={overallCandidateDigest} onChange={(event) => setOverallCandidateDigest(event.target.value)}><option value="">Select exact candidate</option>{eligibleOverallCandidates.map(({ packet }) => <option key={packet.candidateDigest} value={packet.candidateDigest}>{packet.title} · {packet.candidateDigest}</option>)}</select></label> : null}<label>Human summary <textarea maxLength={4096} value={reviewSummary} onChange={(event) => setReviewSummary(event.target.value)} /></label><button type="button" disabled={busy || !reviewSummary || !reviewInvariantSatisfied} onClick={exportReview}>Export review packet</button>{state.review ? <p>Review digest <code>{state.review.reviewDigest}</code></p> : null}</article></> : null}
    {state.draftProposal ? <p className="draft-prefill" role="status">Draft proposal: {state.draftProposal.kind}. No plan exists until the operator uses the ordinary plan form.</p> : null}
  </section>;
}

export type { ReviewAnnotation };
