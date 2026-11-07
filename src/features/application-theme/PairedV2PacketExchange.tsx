import { useCallback, useMemo, useRef, useState } from "react";
import type { PairedV2PacketBridge } from "./paired-v2-packet-bridge";
import type { PairedV2NativePacketEnvelope } from "./paired-v2-packets";
import { validatePairedV2PacketAssociations } from "./paired-v2-packets";
import "./paired-v2-packet-exchange.css";

const BRIEF_KIND = "tf-paired-profile-v2-brief" as const;
const CANDIDATE_KIND = "tf-paired-profile-v2-candidate" as const;
const REVIEW_KIND = "tf-paired-profile-v2-review" as const;
const PACKET_KINDS = [BRIEF_KIND, CANDIDATE_KIND, REVIEW_KIND] as const;
const MAX_CANDIDATES = 8;

type PairedV2PacketKind = PairedV2NativePacketEnvelope["kind"];
type Packet = PairedV2NativePacketEnvelope["packet"];
type BriefPacket = Extract<Packet, { readonly schema: typeof BRIEF_KIND }>;
type CandidatePacket = Extract<Packet, { readonly schema: typeof CANDIDATE_KIND }>;
type ReviewPacket = Extract<Packet, { readonly schema: typeof REVIEW_KIND }>;
type PacketCreateRequest = Parameters<PairedV2PacketBridge["createPacket"]>[0];
type BriefInput = Omit<BriefPacket, "briefDigest">;
type CandidateInput = Omit<CandidatePacket, "candidateDigest">;
type ReviewInput = Omit<ReviewPacket, "reviewDigest">;

export interface PairedV2VerifiedSourceIdentity {
  readonly profileName: string;
  readonly profileVersion: string;
  readonly rawSourceSha256: string;
  readonly canonicalDigest: string;
  readonly editablePaths: readonly string[];
  readonly allowedModes: readonly ("light" | "dark")[];
}

export interface PairedV2EligibleCurrentCompile {
  readonly sourceBytesBase64: string;
  readonly sourceProfileSha256: string;
  readonly sourceCanonicalDigest: string;
  readonly verificationStatus: "verified" | "transformed";
  readonly isTransformed: boolean;
}

export type PairedV2CandidateDisposition = "approve" | "revise" | "reject";

export interface PairedV2CandidateFeedback {
  readonly disposition: PairedV2CandidateDisposition;
  readonly comment: string;
}

export interface PairedV2CandidateSelectionContext {
  readonly brief: PairedV2NativePacketEnvelope | undefined;
  readonly review: PairedV2NativePacketEnvelope | undefined;
  readonly feedback: Readonly<Record<string, PairedV2CandidateFeedback>>;
}

export interface PairedV2CandidateSelectionOutcome {
  readonly accepted: boolean;
  readonly message?: string;
}

export interface PairedV2PacketExchangeProps {
  readonly bridge: PairedV2PacketBridge;
  /** Historical source identity retained with the open packet session. */
  readonly sourceIdentity: PairedV2VerifiedSourceIdentity;
  /** Current parent-owned source identity; null means no current source is available. */
  readonly currentSourceIdentity: PairedV2VerifiedSourceIdentity | null;
  readonly eligibleCurrentCompile?: PairedV2EligibleCurrentCompile | undefined;
  readonly pendingSave?: boolean;
  readonly onSelectCandidate: (
    envelope: PairedV2NativePacketEnvelope,
    context: PairedV2CandidateSelectionContext,
  ) => Promise<PairedV2CandidateSelectionOutcome>;
}

type BusyAction =
  | "create-brief"
  | "import-brief"
  | "export-brief"
  | "create-candidate"
  | "import-candidate"
  | "export-candidate"
  | "create-review"
  | "import-review"
  | "export-review"
  | "select-candidate"
  | null;

type DraftBrief = {
  briefId: string;
  title: string;
  goal: string;
  acceptanceCriteria: string;
  prohibitedChanges: string;
};

type DraftCandidate = {
  candidateId: string;
  rationale: string;
};

type DraftReview = {
  reviewId: string;
  overallDisposition: "" | PairedV2CandidateDisposition;
  summary: string;
};

type StoredEnvelope = PairedV2NativePacketEnvelope;

function nextIdentifier(prefix: string, counter: number): string {
  return `${prefix}-${counter}`;
}

function splitLines(value: string): readonly string[] {
  return value
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function shortDigest(value: string): string {
  return value.length > 16 ? `${value.slice(0, 12)}…${value.slice(-4)}` : value;
}

function envelopeMatchesKind(
  envelope: PairedV2NativePacketEnvelope,
  expectedKind: PairedV2PacketKind,
): boolean {
  return envelope.kind === expectedKind
    && envelope.packet.schema === expectedKind
    && envelope.packetDigestVerified === true
    && typeof envelope.canonicalJson === "string"
    && envelope.canonicalJson.length > 0
    && typeof envelope.digest === "string"
    && envelope.digest.length > 0;
}

function createRequest(kind: PairedV2PacketKind, input: BriefInput | CandidateInput | ReviewInput): PacketCreateRequest {
  return { kind, input } as unknown as PacketCreateRequest;
}

function isDisposition(value: string): value is PairedV2CandidateDisposition {
  return value === "approve" || value === "revise" || value === "reject";
}

function errorText(action: BusyAction): string {
  switch (action) {
    case "create-brief": return "The brief could not be created. Review the fields and try again.";
    case "import-brief": return "The brief import was not accepted.";
    case "export-brief": return "The brief was not saved.";
    case "create-candidate": return "The candidate could not be created. Confirm the accepted compile and rationale.";
    case "import-candidate": return "The candidate import was not accepted.";
    case "export-candidate": return "The candidate was not saved.";
    case "create-review": return "The review could not be created. Complete its disposition and summary.";
    case "import-review": return "The review import was not accepted.";
    case "export-review": return "The review was not saved.";
    case "select-candidate": return "The candidate was not selected. The current session remains unchanged.";
    default: return "The packet action could not be completed.";
  }
}

function packetForKind(envelope: StoredEnvelope, kind: typeof BRIEF_KIND): BriefPacket;
function packetForKind(envelope: StoredEnvelope, kind: typeof CANDIDATE_KIND): CandidatePacket;
function packetForKind(envelope: StoredEnvelope, kind: typeof REVIEW_KIND): ReviewPacket;
function packetForKind(envelope: StoredEnvelope, kind: PairedV2PacketKind): Packet {
  if (envelope.kind !== kind || envelope.packet.schema !== kind) {
    throw new Error("packet-kind-mismatch");
  }
  return envelope.packet;
}

function sourceIdentityMatchesCurrent(
  sourceIdentity: PairedV2VerifiedSourceIdentity,
  currentSourceIdentity: PairedV2VerifiedSourceIdentity | null,
): boolean {
  return currentSourceIdentity !== null
    && sourceIdentity.rawSourceSha256 === currentSourceIdentity.rawSourceSha256
    && sourceIdentity.canonicalDigest === currentSourceIdentity.canonicalDigest;
}

export function PairedV2PacketExchange({
  bridge,
  sourceIdentity,
  currentSourceIdentity,
  eligibleCurrentCompile,
  pendingSave = false,
  onSelectCandidate,
}: PairedV2PacketExchangeProps) {
  const idCounter = useRef(1);
  const [brief, setBrief] = useState<DraftBrief>(() => ({
    briefId: nextIdentifier("brief", idCounter.current),
    title: "",
    goal: "",
    acceptanceCriteria: "",
    prohibitedChanges: "",
  }));
  const [candidate, setCandidate] = useState<DraftCandidate>(() => ({
    candidateId: nextIdentifier("candidate", idCounter.current),
    rationale: "",
  }));
  const [review, setReview] = useState<DraftReview>(() => ({
    reviewId: nextIdentifier("review", idCounter.current),
    overallDisposition: "",
    summary: "",
  }));
  const [envelopes, setEnvelopes] = useState<readonly StoredEnvelope[]>([]);
  const [activeBriefDigest, setActiveBriefDigest] = useState<string | undefined>(undefined);
  const [activeReviewDigest, setActiveReviewDigest] = useState<string | undefined>(undefined);
  const [includedCandidates, setIncludedCandidates] = useState<ReadonlySet<string>>(new Set());
  const [feedback, setFeedback] = useState<Readonly<Record<string, PairedV2CandidateFeedback>>>({});
  const [selectedCandidateDigest, setSelectedCandidateDigest] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [message, setMessage] = useState<string | undefined>(undefined);

  const remember = useCallback((envelope: StoredEnvelope): StoredEnvelope => {
    if (!PACKET_KINDS.includes(envelope.kind) || !envelopeMatchesKind(envelope, envelope.kind)) {
      throw new Error("packet-envelope-invalid");
    }
    setEnvelopes((current) => current.some((entry) => entry.digest === envelope.digest)
      ? current
      : [...current, envelope]);
    return envelope;
  }, []);

  const briefEnvelope = useMemo(
    () => envelopes.find((entry) => entry.kind === BRIEF_KIND && entry.digest === activeBriefDigest)
      ?? envelopes.find((entry) => entry.kind === BRIEF_KIND),
    [activeBriefDigest, envelopes],
  );
  const candidateEnvelopes = useMemo(
    () => envelopes.filter((entry): entry is StoredEnvelope & { readonly kind: typeof CANDIDATE_KIND } => entry.kind === CANDIDATE_KIND),
    [envelopes],
  );
  const reviewEnvelope = useMemo(
    () => envelopes.find((entry) => entry.kind === REVIEW_KIND && entry.digest === activeReviewDigest)
      ?? envelopes.find((entry) => entry.kind === REVIEW_KIND),
    [activeReviewDigest, envelopes],
  );
  const selectedReviewPacket = reviewEnvelope === undefined ? undefined : packetForKind(reviewEnvelope, REVIEW_KIND);
  const selectionBusy = busy === "select-candidate";
  const actionBusy = busy !== null;
  const sourceIsCurrent = sourceIdentityMatchesCurrent(sourceIdentity, currentSourceIdentity);

  const runAction = useCallback(async (action: Exclude<BusyAction, null>, operation: () => Promise<void>) => {
    if (busy !== null) return;
    setBusy(action);
    setMessage(undefined);
    try {
      await operation();
    } catch {
      setMessage(errorText(action));
    } finally {
      setBusy((current) => current === action ? null : current);
    }
  }, [busy]);

  const createBrief = useCallback(() => {
    void runAction("create-brief", async () => {
      if (!sourceIsCurrent) throw new Error("source-not-current");
      const input: BriefInput = {
        schema: BRIEF_KIND,
        schemaVersion: 1,
        briefId: brief.briefId.trim(),
        title: brief.title.trim(),
        goal: brief.goal.trim(),
        profileName: sourceIdentity.profileName,
        profileVersion: sourceIdentity.profileVersion,
        sourceProfileSha256: sourceIdentity.rawSourceSha256,
        sourceCanonicalDigest: sourceIdentity.canonicalDigest,
        editablePaths: sourceIdentity.editablePaths,
        allowedModes: sourceIdentity.allowedModes,
        acceptanceCriteria: splitLines(brief.acceptanceCriteria),
        prohibitedChanges: splitLines(brief.prohibitedChanges),
      } as BriefInput;
      const envelope = await bridge.createPacket(createRequest(BRIEF_KIND, input));
      const retained = remember(envelope);
      if (!envelopeMatchesKind(retained, BRIEF_KIND)) throw new Error("brief-envelope-invalid");
      setActiveBriefDigest(retained.digest);
      setMessage("Brief created and retained with its native canonical bytes.");
      idCounter.current += 1;
      setCandidate((current) => ({ ...current, candidateId: nextIdentifier("candidate", idCounter.current) }));
      setReview((current) => ({ ...current, reviewId: nextIdentifier("review", idCounter.current) }));
    });
  }, [bridge, brief, remember, runAction, sourceIdentity, sourceIsCurrent]);

  const importPacket = useCallback((kind: PairedV2PacketKind, action: Exclude<BusyAction, null>) => {
    void runAction(action, async () => {
      const result = await bridge.importPacket(kind);
      if (result.cancelled || result.envelope === undefined) {
        setMessage("Import cancelled; existing packet context remains unchanged.");
        return;
      }
      const envelope = remember(result.envelope);
      if (!envelopeMatchesKind(envelope, kind)) throw new Error("import-envelope-invalid");
      if (kind === BRIEF_KIND) {
        const packet = packetForKind(envelope, BRIEF_KIND);
        setBrief({
          briefId: packet.briefId,
          title: packet.title,
          goal: packet.goal,
          acceptanceCriteria: packet.acceptanceCriteria.join("\n"),
          prohibitedChanges: packet.prohibitedChanges.join("\n"),
        });
        setActiveBriefDigest(envelope.digest);
        setMessage("Brief imported for inspection and retained without adoption.");
      }
      if (kind === CANDIDATE_KIND) {
        const packet = packetForKind(envelope, CANDIDATE_KIND);
        setCandidate({ candidateId: packet.candidateId, rationale: packet.rationale });
        setIncludedCandidates((current) => new Set(current).add(envelope.digest));
        setMessage("Candidate imported for inspection; source verification remains parent-controlled.");
      }
      if (kind === REVIEW_KIND) {
        const packet = packetForKind(envelope, REVIEW_KIND);
        setReview({
          reviewId: packet.reviewId,
          overallDisposition: packet.overallDisposition,
          summary: packet.summary,
        });
        setFeedback((current) => {
          const next = { ...current };
          for (const disposition of packet.dispositions) {
            next[disposition.candidateDigest] = {
              disposition: disposition.disposition,
              comment: disposition.comment ?? "",
            };
          }
          return next;
        });
        setActiveReviewDigest(envelope.digest);
        setMessage("Review imported for inspection; associations and disposition remain separate.");
      }
    });
  }, [bridge, remember, runAction]);

  const exportEnvelope = useCallback((envelope: StoredEnvelope | undefined, action: Exclude<BusyAction, null>, label: string) => {
    if (envelope === undefined) return;
    void runAction(action, async () => {
      const result = await bridge.exportPacket(envelope);
      if (result.cancelled || !result.saved) {
        setMessage(`${label} export cancelled; retained canonical bytes were not changed.`);
        return;
      }
      setMessage(`${label} exported without adopting or saving the current source.`);
    });
  }, [bridge, runAction]);

  const createCandidate = useCallback(() => {
    void runAction("create-candidate", async () => {
      if (briefEnvelope === undefined || eligibleCurrentCompile === undefined) throw new Error("candidate-not-eligible");
      if (candidateEnvelopes.length >= MAX_CANDIDATES) throw new Error("candidate-limit");
      const input: CandidateInput = {
        schema: CANDIDATE_KIND,
        schemaVersion: 1,
        candidateId: candidate.candidateId.trim(),
        briefDigest: briefEnvelope.digest,
        sourceBytesBase64: eligibleCurrentCompile.sourceBytesBase64,
        sourceProfileSha256: eligibleCurrentCompile.sourceProfileSha256,
        sourceCanonicalDigest: eligibleCurrentCompile.sourceCanonicalDigest,
        rationale: candidate.rationale.trim(),
      } as CandidateInput;
      const envelope = await bridge.createPacket(createRequest(CANDIDATE_KIND, input));
      const retained = remember(envelope);
      if (!envelopeMatchesKind(retained, CANDIDATE_KIND)) throw new Error("candidate-envelope-invalid");
      setIncludedCandidates((current) => new Set(current).add(retained.digest));
      setFeedback((current) => current[retained.digest] === undefined
        ? { ...current, [retained.digest]: { disposition: "revise", comment: "" } }
        : current);
      setMessage("Candidate created and retained; native verification and selection remain explicit.");
      idCounter.current += 1;
      setCandidate({ candidateId: nextIdentifier("candidate", idCounter.current), rationale: "" });
    });
  }, [bridge, briefEnvelope, candidate, candidateEnvelopes.length, eligibleCurrentCompile, remember, runAction]);

  const createReview = useCallback(() => {
    void runAction("create-review", async () => {
      if (briefEnvelope === undefined || review.overallDisposition === "") throw new Error("review-not-ready");
      const stagedCandidates = candidateEnvelopes.filter((entry) => includedCandidates.has(entry.digest));
      const mismatchedCandidates = stagedCandidates.filter((entry) =>
        packetForKind(entry, CANDIDATE_KIND).briefDigest !== briefEnvelope.digest,
      );
      if (mismatchedCandidates.length > 0) {
        setMessage("Review refused: every candidate must reference the active brief.");
        return;
      }
      const candidateDigests = stagedCandidates.map((entry) => entry.digest);
      if (candidateDigests.length === 0) throw new Error("review-candidates-empty");
      const dispositions = candidateDigests.map((digest) => {
        const disposition = feedback[digest]?.disposition ?? "revise";
        const comment = feedback[digest]?.comment.trim() ?? "";
        return comment.length > 0
          ? { candidateDigest: digest, disposition, comment }
          : { candidateDigest: digest, disposition };
      });
      const input: ReviewInput = {
        schema: REVIEW_KIND,
        schemaVersion: 1,
        reviewId: review.reviewId.trim(),
        briefDigest: briefEnvelope.digest,
        candidateDigests,
        dispositions,
        overallDisposition: review.overallDisposition,
        summary: review.summary.trim(),
      } as ReviewInput;
      const envelope = await bridge.createPacket(createRequest(REVIEW_KIND, input));
      const retained = remember(envelope);
      if (!envelopeMatchesKind(retained, REVIEW_KIND)) throw new Error("review-envelope-invalid");
      setActiveReviewDigest(retained.digest);
      setMessage("Review created with explicit human dispositions; it does not adopt or save a candidate.");
    });
  }, [bridge, briefEnvelope, candidateEnvelopes, feedback, includedCandidates, remember, review, runAction]);

  const selectCandidate = useCallback((envelope: StoredEnvelope) => {
    if (pendingSave || actionBusy) return;
    setSelectedCandidateDigest(undefined);
    setBusy("select-candidate");
    setMessage(undefined);
    void onSelectCandidate(envelope, {
      brief: briefEnvelope,
      review: reviewEnvelope,
      feedback,
    }).then((outcome) => {
      if (outcome.accepted) {
        setSelectedCandidateDigest(envelope.digest);
        setMessage("Candidate requested for verification by the parent session.");
      } else {
        setSelectedCandidateDigest(undefined);
        setMessage(outcome.message ?? "Candidate request was refused; the current session remains unchanged.");
      }
    }).catch(() => {
      setSelectedCandidateDigest(undefined);
      setMessage(errorText("select-candidate"));
    }).finally(() => {
      setBusy((current) => current === "select-candidate" ? null : current);
    });
  }, [actionBusy, briefEnvelope, feedback, onSelectCandidate, pendingSave, reviewEnvelope]);

  const updateFeedback = useCallback((digest: string, patch: Partial<PairedV2CandidateFeedback>) => {
    setFeedback((current) => ({
      ...current,
      [digest]: {
        disposition: current[digest]?.disposition ?? "revise",
        comment: current[digest]?.comment ?? "",
        ...patch,
      },
    }));
  }, []);

  const reviewAssociation = useMemo(() => {
    if (selectedReviewPacket === undefined) return undefined;
    const knownCandidates = new Map(candidateEnvelopes.map((entry) => [entry.digest, entry]));
    const missing = selectedReviewPacket.candidateDigests.filter((digest) => !knownCandidates.has(digest));
    const briefMatches = briefEnvelope?.digest === selectedReviewPacket.briefDigest;
    let associationsValid = false;
    if (briefEnvelope !== undefined && missing.length === 0) {
      try {
        const briefPacket = packetForKind(briefEnvelope, BRIEF_KIND);
        const referencedCandidates = selectedReviewPacket.candidateDigests.map((digest) => {
          const candidate = knownCandidates.get(digest);
          if (candidate === undefined) throw new Error("candidate-missing");
          return packetForKind(candidate, CANDIDATE_KIND);
        });
        validatePairedV2PacketAssociations(briefPacket, referencedCandidates, selectedReviewPacket);
        associationsValid = true;
      } catch {
        associationsValid = false;
      }
    }
    return { missing, briefMatches, associationsValid, exact: missing.length === 0 && briefMatches && associationsValid };
  }, [briefEnvelope, candidateEnvelopes, selectedReviewPacket]);

  const activeBriefSourceStatus = useMemo(() => {
    if (briefEnvelope === undefined) return undefined;
    const packet = packetForKind(briefEnvelope, BRIEF_KIND);
    if (currentSourceIdentity === null) {
      return { rawMatches: false, canonicalMatches: false, unavailable: true };
    }
    return {
      rawMatches: packet.sourceProfileSha256 === currentSourceIdentity.rawSourceSha256,
      canonicalMatches: packet.sourceCanonicalDigest === currentSourceIdentity.canonicalDigest,
      unavailable: false,
    };
  }, [briefEnvelope, currentSourceIdentity]);

  return (
    <section className="paired-v2-packet-exchange" aria-labelledby="paired-v2-packet-exchange-title">
      <header className="paired-v2-packet-exchange__header">
        <div>
          <p className="paired-v2-packet-exchange__eyebrow">Portable paired v2 context</p>
          <h2 id="paired-v2-packet-exchange-title">Brief, compare, and review</h2>
          <p className="paired-v2-packet-exchange__muted">
            Native packet digests and canonical bytes are retained by identity. Human review never adopts, saves, or verifies a source by itself.
          </p>
        </div>
        <span className="paired-v2-packet-exchange__status">{actionBusy ? "Working" : "Ready"}</span>
      </header>

      {message !== undefined ? <p className="paired-v2-packet-exchange__message" role="status">{message}</p> : null}

      <section className="paired-v2-packet-exchange__section" aria-labelledby="paired-v2-source-title">
        <div className="paired-v2-packet-exchange__section-heading">
          <div>
            <p className="paired-v2-packet-exchange__eyebrow">Current source</p>
            <h3 id="paired-v2-source-title">
              {sourceIsCurrent ? "Current verified identity supplied by the parent session" : "Last verified identity (not current)"}
            </h3>
          </div>
          <span className="paired-v2-packet-exchange__badge">source verification is separate</span>
        </div>
        <dl className="paired-v2-packet-exchange__identity">
          <div><dt>Profile</dt><dd>{sourceIdentity.profileName} {sourceIdentity.profileVersion}</dd></div>
          <div><dt>Raw source</dt><dd><code>{shortDigest(sourceIdentity.rawSourceSha256)}</code></dd></div>
          <div><dt>Canonical</dt><dd><code>{shortDigest(sourceIdentity.canonicalDigest)}</code></dd></div>
          <div><dt>Modes</dt><dd>{sourceIdentity.allowedModes.join(", ")}</dd></div>
          <div><dt>Editable paths</dt><dd>{sourceIdentity.editablePaths.join(", ")}</dd></div>
        </dl>
        <p className="paired-v2-packet-exchange__muted">
          {currentSourceIdentity === null
            ? "The parent has no current source identity; this retained identity is historical context only."
            : sourceIsCurrent
              ? "This retained identity matches the current parent-owned raw and canonical source identity."
              : "The current parent-owned source differs from this retained identity; it is historical context only."}
          {" "}Editable paths and mode limits are parent-owned context; packet integrity is only the native <code>packetDigestVerified</code> result.
        </p>
      </section>

      <section className="paired-v2-packet-exchange__section" aria-labelledby="paired-v2-brief-title">
        <div className="paired-v2-packet-exchange__section-heading">
          <div>
            <p className="paired-v2-packet-exchange__eyebrow">1 · Brief</p>
            <h3 id="paired-v2-brief-title">Describe the requested change</h3>
          </div>
          {briefEnvelope !== undefined ? <span className="paired-v2-packet-exchange__badge">{shortDigest(briefEnvelope.digest)}</span> : null}
        </div>
        <div className="paired-v2-packet-exchange__field-grid">
          <label>Brief ID<input value={brief.briefId} onChange={(event) => setBrief((current) => ({ ...current, briefId: event.target.value }))} /></label>
          <label>Title<input value={brief.title} onChange={(event) => setBrief((current) => ({ ...current, title: event.target.value }))} /></label>
        </div>
        <label>Goal<textarea rows={3} value={brief.goal} onChange={(event) => setBrief((current) => ({ ...current, goal: event.target.value }))} /></label>
        <div className="paired-v2-packet-exchange__field-grid">
          <label>Acceptance criteria <span className="paired-v2-packet-exchange__field-hint">one criterion per line</span><textarea rows={4} value={brief.acceptanceCriteria} onChange={(event) => setBrief((current) => ({ ...current, acceptanceCriteria: event.target.value }))} /></label>
          <label>Prohibited changes <span className="paired-v2-packet-exchange__field-hint">one boundary per line</span><textarea rows={4} value={brief.prohibitedChanges} onChange={(event) => setBrief((current) => ({ ...current, prohibitedChanges: event.target.value }))} /></label>
        </div>
        <div className="paired-v2-packet-exchange__actions">
          <button type="button" disabled={actionBusy || !sourceIsCurrent} onClick={createBrief}>Create brief</button>
          <button type="button" disabled={actionBusy} onClick={() => importPacket(BRIEF_KIND, "import-brief")}>Import brief</button>
          <button type="button" disabled={actionBusy || briefEnvelope === undefined} onClick={() => exportEnvelope(briefEnvelope, "export-brief", "Brief")}>Export brief</button>
        </div>
        {briefEnvelope !== undefined ? <p className="paired-v2-packet-exchange__muted">Retained canonical JSON: <code>{briefEnvelope.canonicalJson.length.toLocaleString()} characters</code>. Export reuses these native bytes.</p> : null}
      </section>

      <section className="paired-v2-packet-exchange__section" aria-labelledby="paired-v2-candidates-title">
        <div className="paired-v2-packet-exchange__section-heading">
          <div>
            <p className="paired-v2-packet-exchange__eyebrow">2 · Candidates</p>
            <h3 id="paired-v2-candidates-title">Compare accepted current compiles</h3>
          </div>
          <span className="paired-v2-packet-exchange__badge">{candidateEnvelopes.length}/{MAX_CANDIDATES} staged</span>
        </div>
        <p className="paired-v2-packet-exchange__muted">
          Candidate creation is enabled only when the parent supplies one successful, verified current compile. Imported candidates remain inspection-only until that parent flow verifies them.
        </p>
        <div className="paired-v2-packet-exchange__field-grid">
          <label>Candidate ID<input value={candidate.candidateId} onChange={(event) => setCandidate((current) => ({ ...current, candidateId: event.target.value }))} /></label>
          <label>Rationale<textarea rows={3} value={candidate.rationale} onChange={(event) => setCandidate((current) => ({ ...current, rationale: event.target.value }))} /></label>
        </div>
        <div className="paired-v2-packet-exchange__actions">
          <button type="button" disabled={actionBusy || briefEnvelope === undefined || eligibleCurrentCompile === undefined || candidateEnvelopes.length >= MAX_CANDIDATES} onClick={createCandidate}>Create candidate</button>
          <button type="button" disabled={actionBusy || candidateEnvelopes.length >= MAX_CANDIDATES} onClick={() => importPacket(CANDIDATE_KIND, "import-candidate")}>Import candidate</button>
          {candidateEnvelopes.length > 0 ? <button type="button" disabled={actionBusy} onClick={() => exportEnvelope(candidateEnvelopes[candidateEnvelopes.length - 1], "export-candidate", "Candidate")}>Export latest candidate</button> : null}
        </div>
        {candidateEnvelopes.length === 0 ? <p className="paired-v2-packet-exchange__empty">No candidates staged yet.</p> : (
          <div className="paired-v2-packet-exchange__candidate-list">
            {candidateEnvelopes.map((entry) => {
              const packet = packetForKind(entry, CANDIDATE_KIND);
              const currentFeedback = feedback[entry.digest] ?? { disposition: "revise" as const, comment: "" };
              const selected = selectedCandidateDigest === entry.digest;
              return (
                <article className={`paired-v2-packet-exchange__candidate${selected ? " is-selected" : ""}`} key={entry.digest}>
                  <div className="paired-v2-packet-exchange__candidate-heading">
                    <div>
                      <h4>{packet.candidateId}</h4>
                      <p className="paired-v2-packet-exchange__muted"><code>{shortDigest(entry.digest)}</code> · {packet.rationale}</p>
                    </div>
                    <span className="paired-v2-packet-exchange__badge">packet self-integrity: {entry.packetDigestVerified ? "verified" : "unknown"}</span>
                  </div>
                  <label className="paired-v2-packet-exchange__check"><input type="checkbox" checked={includedCandidates.has(entry.digest)} onChange={(event) => setIncludedCandidates((current) => { const next = new Set(current); if (event.target.checked) next.add(entry.digest); else next.delete(entry.digest); return next; })} /> Include this candidate in the next review</label>
                  <div className="paired-v2-packet-exchange__field-grid">
                    <label>Disposition<select value={currentFeedback.disposition} onChange={(event) => { if (isDisposition(event.target.value)) updateFeedback(entry.digest, { disposition: event.target.value }); }}><option value="approve">Approve</option><option value="revise">Revise</option><option value="reject">Reject</option></select></label>
                    <label>Comment<textarea rows={2} value={currentFeedback.comment} onChange={(event) => updateFeedback(entry.digest, { comment: event.target.value })} /></label>
                  </div>
                  <div className="paired-v2-packet-exchange__actions">
                    <button type="button" disabled={pendingSave || selectionBusy || actionBusy} onClick={() => selectCandidate(entry)}>{selected ? "Candidate requested for verification" : "Select candidate"}</button>
                    <button type="button" disabled={actionBusy} onClick={() => exportEnvelope(entry, "export-candidate", "Candidate")}>Export candidate</button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="paired-v2-packet-exchange__section" aria-labelledby="paired-v2-review-title">
        <div className="paired-v2-packet-exchange__section-heading">
          <div>
            <p className="paired-v2-packet-exchange__eyebrow">3 · Review</p>
            <h3 id="paired-v2-review-title">Record the human decision explicitly</h3>
          </div>
          {reviewEnvelope !== undefined ? <span className="paired-v2-packet-exchange__badge">{shortDigest(reviewEnvelope.digest)}</span> : null}
        </div>
        <p className="paired-v2-packet-exchange__muted">
          Review guidance is not automatic compliance. Approval here never adopts the candidate, saves source bytes, or replaces native verification.
        </p>
        <div className="paired-v2-packet-exchange__field-grid">
          <label>Review ID<input value={review.reviewId} onChange={(event) => setReview((current) => ({ ...current, reviewId: event.target.value }))} /></label>
          <label>Overall disposition<select value={review.overallDisposition} onChange={(event) => { const value = event.target.value; setReview((current) => ({ ...current, overallDisposition: value === "" || isDisposition(value) ? value : current.overallDisposition })); }}><option value="">Choose a decision</option><option value="approve">Approve</option><option value="revise">Revise</option><option value="reject">Reject</option></select></label>
        </div>
        <label>Summary<textarea rows={3} value={review.summary} onChange={(event) => setReview((current) => ({ ...current, summary: event.target.value }))} /></label>
        <div className="paired-v2-packet-exchange__review-links">
          <h4>Referenced candidates</h4>
          {candidateEnvelopes.length === 0 ? <p className="paired-v2-packet-exchange__empty">Stage a candidate before composing a review.</p> : candidateEnvelopes.map((entry) => {
            const packet = packetForKind(entry, CANDIDATE_KIND);
            return <label className="paired-v2-packet-exchange__check" key={`review-${entry.digest}`}><input type="checkbox" checked={includedCandidates.has(entry.digest)} onChange={(event) => setIncludedCandidates((current) => { const next = new Set(current); if (event.target.checked) next.add(entry.digest); else next.delete(entry.digest); return next; })} /> {packet.candidateId} · <code>{shortDigest(entry.digest)}</code></label>;
          })}
        </div>
        <div className="paired-v2-packet-exchange__actions">
          <button type="button" disabled={actionBusy || briefEnvelope === undefined || review.overallDisposition === "" || review.summary.trim().length === 0} onClick={createReview}>Create review</button>
          <button type="button" disabled={actionBusy} onClick={() => importPacket(REVIEW_KIND, "import-review")}>Import review</button>
          <button type="button" disabled={actionBusy || reviewEnvelope === undefined} onClick={() => exportEnvelope(reviewEnvelope, "export-review", "Review")}>Export review</button>
        </div>
        {reviewAssociation !== undefined ? (
          <p className="paired-v2-packet-exchange__association" role="status">
            {reviewAssociation.exact
              ? "Imported review references the exact staged brief and candidate subset."
              : `Imported review is inspection-only: ${!reviewAssociation.briefMatches
                ? "brief identity differs"
                : reviewAssociation.missing.length > 0
                  ? "candidate references are incomplete"
                  : "candidate brief associations differ"}${reviewAssociation.missing.length > 0 ? ` (${reviewAssociation.missing.length} missing)` : ""}.`}
          </p>
        ) : null}
        {activeBriefSourceStatus !== undefined ? (
          <p className="paired-v2-packet-exchange__association" role="status">
            {activeBriefSourceStatus.unavailable
              ? "Active brief cannot be compared with a current source: current source identity is unavailable."
              : activeBriefSourceStatus.rawMatches && activeBriefSourceStatus.canonicalMatches
                ? "Active brief source matches the current raw and canonical source identity."
                : `Active brief source differs from current source: ${activeBriefSourceStatus.rawMatches ? "canonical identity mismatch" : activeBriefSourceStatus.canonicalMatches ? "raw identity mismatch" : "raw and canonical identity mismatch"}.`}
          </p>
        ) : null}
      </section>
    </section>
  );
}

