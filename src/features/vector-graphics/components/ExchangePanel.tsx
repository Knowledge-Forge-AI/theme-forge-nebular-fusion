import React from "react";
import type {
  ScenePacketResponse,
  SceneReviewAnnotationDto,
  SceneVerificationResponse,
} from "../types";

export interface ExchangePanelProps {
  retainedPackets: readonly ScenePacketResponse[];
  selectedPacketId: string | null;
  lastVerification: SceneVerificationResponse | null;
  isActionInProgress: boolean;
  onSelectPacket: (packetId: string) => void;
  onCreateBrief: (title: string, objective: string, criteria: string[]) => void;
  onImportPacket: (expectedKind?: string) => void;
  onExportPacket: (packetId: string) => void;
  onCreateReview: (briefId: string, candidateIds: string[], disposition: string, summary: string) => void;
  onVerifyCandidate: (candidatePacketId: string, briefPacketId?: string) => void;
  onAdoptCandidate: (verificationHandle: string) => void;
}

export function ExchangePanel({
  retainedPackets,
  selectedPacketId,
  lastVerification,
  isActionInProgress,
  onSelectPacket,
  onCreateBrief,
  onImportPacket,
  onExportPacket,
  onCreateReview,
  onVerifyCandidate,
  onAdoptCandidate,
}: ExchangePanelProps) {
  // Brief form state
  const [briefTitle, setBriefTitle] = React.useState("Hero Illustration Refinement");
  const [briefObjective, setBriefObjective] = React.useState("Refine shapes for responsive mobile layout");
  const [briefCriteria, setBriefCriteria] = React.useState("Valid SVG, max 50 elements, contrast ratio >= 4.5");

  // Review form state
  const [reviewDisposition, setReviewDisposition] = React.useState("approved");
  const [reviewSummary, setReviewSummary] = React.useState("Shapes match artboard guidelines and scale cleanly");
  const [selectedBriefId, setSelectedBriefId] = React.useState<string>("");

  const retainedBriefs = retainedPackets.filter((p) => p.packetKind === "brief");
  const selectedPacket = retainedPackets.find((p) => p.packetId === selectedPacketId);

  return (
    <div className="exchange-panel" data-testid="exchange-panel">
      <header className="exchange-header">
        <h3 className="section-kicker">Design Exchange Handoff</h3>
        <p className="section-subtitle">
          Iterative agent exchange via native retained handles. Sender claims remain separate from verified evidence.
        </p>
      </header>

      <div className="exchange-grid">
        {/* Left Column: Retained Packets */}
        <section className="exchange-column">
          <div className="column-header">
            <h4>Retained Packets ({retainedPackets.length})</h4>
            <div className="column-actions">
              <button
                type="button"
                className="action-btn-xs"
                onClick={() => onImportPacket()}
                disabled={isActionInProgress}
                aria-label="Import Packet"
              >
                📥 Import…
              </button>
            </div>
          </div>

          <ul className="packet-list" role="listbox" aria-label="Retained Exchange Packets">
            {retainedPackets.length === 0 ? (
              <li className="packet-empty">No exchange packets retained.</li>
            ) : (
              retainedPackets.map((pkt) => {
                const isSelected = pkt.packetId === selectedPacketId;
                return (
                  <li
                    key={pkt.packetId}
                    role="option"
                    aria-selected={isSelected}
                    className={`packet-item ${isSelected ? "selected" : ""}`}
                    onClick={() => pkt.packetId && onSelectPacket(pkt.packetId)}
                  >
                    <div className="packet-badge-line">
                      <span className="packet-kind-badge">{pkt.packetKind?.toUpperCase()}</span>
                      <span className="packet-id-text">{pkt.packetId}</span>
                    </div>
                    {pkt.packetDigest && (
                      <span className="packet-digest-text" title={pkt.packetDigest}>
                        {pkt.packetDigest.slice(0, 20)}…
                      </span>
                    )}
                  </li>
                );
              })
            )}
          </ul>

          {selectedPacket && selectedPacket.packetId && (
            <div className="selected-packet-actions" data-testid="selected-packet-actions">
              <h5>Packet: {selectedPacket.packetId}</h5>
              <div className="packet-button-row">
                <button
                  type="button"
                  className="action-btn-xs"
                  onClick={() => selectedPacket.packetId && onExportPacket(selectedPacket.packetId)}
                  disabled={isActionInProgress}
                  aria-label="Export Packet"
                >
                  Export…
                </button>
                {selectedPacket.packetKind === "candidate" && (
                  <div className="verify-block" style={{ marginTop: "4px" }}>
                    {retainedBriefs.length > 0 && (
                      <div className="inspector-row" style={{ marginBottom: "4px" }}>
                        <label htmlFor="verify-brief-select" style={{ fontSize: "11px" }}>Target Brief</label>
                        <select
                          id="verify-brief-select"
                          aria-label="Select Target Brief"
                          value={selectedBriefId || retainedBriefs[0]?.packetId || ""}
                          onChange={(e) => setSelectedBriefId(e.target.value)}
                          style={{ fontSize: "11px" }}
                        >
                          {retainedBriefs.map((b) => (
                            <option key={b.packetId} value={b.packetId}>
                              {b.packetId}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                    <button
                      type="button"
                      className="action-btn-xs verify-btn"
                      onClick={() =>
                        selectedPacket.packetId &&
                        onVerifyCandidate(
                          selectedPacket.packetId,
                          selectedBriefId || retainedBriefs[0]?.packetId || undefined,
                        )
                      }
                      disabled={isActionInProgress}
                      aria-label="Verify Candidate"
                    >
                      🔍 Verify
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </section>

        {/* Right Column: Workflows (Create Brief, Create Review, Verification & Adoption) */}
        <section className="exchange-column">
          {/* Create Brief Section */}
          <fieldset className="exchange-group">
            <legend className="inspector-legend">1. Create Brief</legend>
            <div className="inspector-row">
              <label htmlFor="brief-title">Title</label>
              <input
                type="text"
                id="brief-title"
                aria-label="Brief Title"
                value={briefTitle}
                onChange={(e) => setBriefTitle(e.target.value)}
              />
            </div>
            <div className="inspector-row">
              <label htmlFor="brief-obj">Objective</label>
              <textarea
                id="brief-obj"
                aria-label="Brief Objective"
                rows={2}
                value={briefObjective}
                onChange={(e) => setBriefObjective(e.target.value)}
              />
            </div>
            <div className="inspector-row">
              <label htmlFor="brief-crit">Criteria</label>
              <input
                type="text"
                id="brief-crit"
                aria-label="Brief Acceptance Criteria"
                value={briefCriteria}
                onChange={(e) => setBriefCriteria(e.target.value)}
              />
            </div>
            <button
              type="button"
              className="action-btn-small"
              onClick={() =>
                onCreateBrief(
                  briefTitle,
                  briefObjective,
                  briefCriteria.split(",").map((s) => s.trim()),
                )
              }
              disabled={isActionInProgress || !briefTitle.trim() || !briefObjective.trim()}
              aria-label="Create Brief Button"
            >
              + Create Retained Brief
            </button>
          </fieldset>

          {/* Verification & Adoption */}
          {lastVerification && (
            <fieldset className="exchange-group verification-group" data-testid="verification-box">
              <legend className="inspector-legend">2. Verified Candidate Evidence</legend>
              <div className="verification-details">
                <p><strong>Candidate ID:</strong> {lastVerification.candidatePacketId}</p>
                <p><strong>Status:</strong> {lastVerification.valid ? "✅ Valid" : "❌ Invalid"}</p>
                <p><strong>Digest:</strong> {lastVerification.candidateDigest.slice(0, 24)}…</p>
                {lastVerification.metrics && (
                  <p><strong>Elements:</strong> {lastVerification.metrics.authoredElementCount}</p>
                )}
              </div>
              <button
                type="button"
                className="action-btn-small adopt-btn"
                onClick={() => onAdoptCandidate(lastVerification.verificationHandle)}
                disabled={isActionInProgress || !lastVerification.valid || !lastVerification.verificationHandle}
                aria-label="Adopt Candidate"
              >
                ★ Adopt Candidate as Draft (Unsaved)
              </button>
            </fieldset>
          )}

          {/* Create Review */}
          <fieldset className="exchange-group">
            <legend className="inspector-legend">3. Create Review</legend>
            <div className="inspector-row">
              <label htmlFor="review-disp">Disposition</label>
              <select
                id="review-disp"
                aria-label="Review Disposition"
                value={reviewDisposition}
                onChange={(e) => setReviewDisposition(e.target.value)}
              >
                <option value="approved">Approved</option>
                <option value="revisions_requested">Revisions Requested</option>
                <option value="rejected">Rejected</option>
              </select>
            </div>
            <div className="inspector-row">
              <label htmlFor="review-sum">Summary</label>
              <textarea
                id="review-sum"
                aria-label="Review Summary"
                rows={2}
                value={reviewSummary}
                onChange={(e) => setReviewSummary(e.target.value)}
              />
            </div>
            <button
              type="button"
              className="action-btn-small"
              onClick={() =>
                onCreateReview(
                  selectedBriefId || retainedBriefs[0]?.packetId || "brief-1",
                  selectedPacketId ? [selectedPacketId] : [],
                  reviewDisposition,
                  reviewSummary,
                )
              }
              disabled={isActionInProgress || !reviewSummary.trim()}
              aria-label="Create Review Button"
            >
              + Create Review Packet
            </button>
          </fieldset>
        </section>
      </div>
    </div>
  );
}
