import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  ThemeCandidateVerificationResultV2,
  ThemeLabBridge,
  ThemeReviewContextV1,
  ThemeReviewDispositionV2,
  ThemeSpecificationV2,
} from "./types";
import {
  DISPOSITIONS,
  MAX_GOAL_LENGTH,
  MAX_SUMMARY_LENGTH,
  MAX_TITLE_LENGTH,
  ParsedCandidateV2,
  createReviewContextV1,
  executeCandidateAdoption,
  executeCandidateVerification,
  parseCandidatePacketV2,
} from "./v2-exchange";

export interface ThemeV2ExchangeProps {
  bridge: ThemeLabBridge;
  sessionId?: string | undefined;
  draftRevision: number;
  draftDirty?: boolean | undefined;
  onAdopt: (spec: ThemeSpecificationV2, compiledResult?: ThemeCandidateVerificationResultV2) => void;
  reserveAdoptionRevision?: (() => number) | undefined;
}

export function ThemeV2Exchange({
  bridge,
  sessionId,
  draftRevision,
  draftDirty = false,
  onAdopt,
  reserveAdoptionRevision,
}: ThemeV2ExchangeProps): React.JSX.Element {
  // IDs for accessibility
  const titleId = useId();
  const goalId = useId();
  const dispositionId = useId();
  const summaryId = useId();

  // Controlled Brief prose
  const [briefTitle, setBriefTitle] = useState<string>("Theme Enhancement Brief");
  const [briefGoal, setBriefGoal] = useState<string>(
    "Refine theme aesthetics, contrast compliance, and visual hierarchy for Starlight documentation."
  );

  // Controlled Review prose
  const [reviewDisposition, setReviewDisposition] = useState<ThemeReviewDispositionV2>("approve");
  const [reviewSummary, setReviewSummary] = useState<string>(
    "Candidate reviewed and verified against Starlight v0.42 design contracts."
  );

  // Imported Candidate state
  const [candidate, setCandidate] = useState<ParsedCandidateV2 | null>(null);
  const [rawCandidateBytes, setRawCandidateBytes] = useState<string | null>(null);

  // Verification state
  const [verification, setVerification] = useState<ThemeCandidateVerificationResultV2 | null>(null);
  const [verifying, setVerifying] = useState<boolean>(false);

  // Adoption & Dialog state
  const [adopting, setAdopting] = useState<boolean>(false);
  const [showDirtyModal, setShowDirtyModal] = useState<boolean>(false);

  // Status & feedback
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);

  // Operation sequence tracker for race condition prevention
  const latestOpRef = useRef<number>(0);
  const prevDraftRevisionRef = useRef<number>(draftRevision);
  const draftRevisionRef = useRef<number>(draftRevision);
  draftRevisionRef.current = draftRevision;

  // Invalidate verification and context results when parent draftRevision advances
  useEffect(() => {
    if (prevDraftRevisionRef.current !== draftRevision) {
      prevDraftRevisionRef.current = draftRevision;
      latestOpRef.current++;
      setVerifying(false);
      setAdopting(false);
      setVerification(null);
      setErrorMessage(null);
    }
  }, [draftRevision]);

  // Derived current local review context (Nebular-owned 'tfsb.theme-review-context-v1')
  const currentContext: ThemeReviewContextV1 | null = useMemo(() => {
    if (!candidate) return null;
    try {
      return createReviewContextV1({
        title: briefTitle,
        goal: briefGoal,
        candidateDigest: candidate.candidateDigest,
        disposition: reviewDisposition,
        summary: reviewSummary,
      });
    } catch {
      return null;
    }
  }, [candidate, briefTitle, briefGoal, reviewDisposition, reviewSummary]);

  // Handler for brief title change (revokes verification)
  const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    setBriefTitle(e.target.value);
    latestOpRef.current++;
    setVerification(null);
    setErrorMessage(null);
    setSuccessMessage(null);
  };

  // Handler for brief goal change (revokes verification)
  const handleGoalChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    setBriefGoal(e.target.value);
    latestOpRef.current++;
    setVerification(null);
    setErrorMessage(null);
    setSuccessMessage(null);
  };

  // Handler for review disposition change (revokes verification)
  const handleDispositionChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    setReviewDisposition(e.target.value as ThemeReviewDispositionV2);
    latestOpRef.current++;
    setVerification(null);
    setErrorMessage(null);
    setSuccessMessage(null);
  };

  // Handler for review summary change (revokes verification)
  const handleSummaryChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    setReviewSummary(e.target.value);
    latestOpRef.current++;
    setVerification(null);
    setErrorMessage(null);
    setSuccessMessage(null);
  };

  // Native Candidate Import
  const handleImportCandidate = async (): Promise<void> => {
    const opId = ++latestOpRef.current;
    const intendedRevision = draftRevisionRef.current;
    setVerification(null);
    setVerifying(false);
    setErrorMessage(null);
    setSuccessMessage(null);
    setExportNotice(null);

    if (typeof bridge.importPacket !== "function") {
      setErrorMessage("Theme Lab bridge does not support packet import");
      return;
    }

    try {
      const res = await bridge.importPacket({ expectedKind: "candidate" });
      if (opId !== latestOpRef.current || intendedRevision !== draftRevisionRef.current) return;
      if (res.cancelled) {
        return;
      }
      if (res.error) {
        const msg = typeof res.error === "string" ? res.error : res.error.message;
        setErrorMessage(msg);
        return;
      }

      const raw = res.canonicalJson ?? (res.packet ? JSON.stringify(res.packet) : undefined);
      if (!raw) {
        setErrorMessage("Imported packet payload is empty");
        return;
      }

      // Strict parse & family validation: rejects v1, accepts catalog v1 or core/code v2
      const parsed = parseCandidatePacketV2(raw);

      // NO AUTO ADOPTION: only store candidate in component state, revoke verification
      setCandidate(parsed);
      setRawCandidateBytes(raw);
      setVerification(null);
      const noticeSuffix = parsed.overrideNotice ? ` — Notice: ${parsed.overrideNotice}` : "";
      setSuccessMessage(
        `Imported candidate '${parsed.candidateId}' (${parsed.family} candidate, digest: ${parsed.candidateDigest.slice(0, 12)}…)${noticeSuffix}`
      );
    } catch (err: any) {
      if (opId === latestOpRef.current && intendedRevision === draftRevisionRef.current) {
        setErrorMessage(err.message || String(err));
      }
    }
  };

  // Verify Candidate Action
  const handleVerify = async (): Promise<void> => {
    if (!candidate || !rawCandidateBytes || !currentContext) {
      setErrorMessage("Cannot verify: missing candidate or invalid review context");
      return;
    }

    const opId = ++latestOpRef.current;
    const intendedRevision = draftRevision;
    setVerifying(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const result = await executeCandidateVerification(bridge, {
        rawCandidateBytes,
        candidate,
        context: currentContext,
        sessionId,
        draftRevision: intendedRevision,
      });

      // Stale response guard
      if (opId !== latestOpRef.current || draftRevisionRef.current !== intendedRevision) {
        return;
      }

      setVerification(result);
      if (result.valid) {
        setSuccessMessage(`Candidate '${candidate.candidateId}' verified successfully`);
      } else {
        setErrorMessage(
          result.errors.length > 0 ? result.errors.join("; ") : "Candidate verification failed"
        );
      }
    } catch (err: any) {
      if (opId !== latestOpRef.current) return;
      setVerification(null);
      setErrorMessage(err.message || String(err));
    } finally {
      setVerifying(false);
    }
  };

  // Adopt Confirmation Click
  const handleAdoptClick = (): void => {
    if (!candidate || !verification || !verification.valid || !currentContext) {
      setErrorMessage("Only currently verified valid candidates can be adopted");
      return;
    }

    if (draftDirty) {
      setShowDirtyModal(true);
    } else {
      executeAdopt(false);
    }
  };

  // Execute Adopt
  const executeAdopt = async (force: boolean): Promise<void> => {
    if (!candidate || !verification || !verification.valid || !currentContext || !rawCandidateBytes) {
      return;
    }

    const opId = ++latestOpRef.current;
    const intendedRevision = draftRevision;
    setAdopting(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const res = await executeCandidateAdoption(bridge, {
        rawCandidateBytes,
        candidate,
        context: currentContext,
        verifiedResult: verification,
        adoptionRevision: reserveAdoptionRevision?.(),
        sessionId,
        draftRevision: intendedRevision,
        force,
      });

      if (opId !== latestOpRef.current || draftRevisionRef.current !== intendedRevision) {
        return;
      }

      if (res.requiresConfirmation && !force) {
        setShowDirtyModal(true);
        return;
      }

      if (res.adopted && res.specification) {
        const adoptedId = candidate.candidateId;
        const adoptedSpec = res.specification;
        const compiledResult = res.compiledResult;

        // CONSUME ONCE: clear imported candidate and verification from state
        setCandidate(null);
        setRawCandidateBytes(null);
        setVerification(null);
        setShowDirtyModal(false);
        setSuccessMessage(`Adopted candidate '${adoptedId}' as active draft`);

        // Notify parent callback
        onAdopt(adoptedSpec, compiledResult);
      } else {
        const msg = typeof res.error === "string" ? res.error : res.error?.message ?? "Candidate adoption failed";
        setErrorMessage(msg);
      }
    } catch (err: any) {
      if (opId !== latestOpRef.current) return;
      setErrorMessage(err.message || String(err));
    } finally {
      setAdopting(false);
    }
  };

  // Export Local Review Context
  const handleExportContext = async (): Promise<void> => {
    setExportNotice(null);
    if (!currentContext) {
      setErrorMessage("No active review context to export");
      return;
    }

    if (typeof bridge.exportPacket === "function") {
      try {
        const res = await bridge.exportPacket({
          packetJson: JSON.stringify(currentContext, null, 2),
          defaultName: `review-context-${candidate?.candidateId ?? "v2"}.json`,
        });
        if (res.saved) {
          setExportNotice(`Exported review context: ${res.displayName ?? "saved"}`);
        } else if (!res.cancelled) {
          setExportNotice("Local review context cannot be exported to portable packets: local Nebular context only.");
        }
      } catch {
        setExportNotice("Local review context cannot be exported to portable packets: local Nebular context only.");
      }
    } else {
      setExportNotice("Local review context cannot be exported to portable packets: local Nebular context only.");
    }
  };

  const isVerifiedValid = verification !== null && verification.valid;

  return (
    <div className="theme-v2-exchange-container" data-testid="theme-v2-exchange">
      <div className="exchange-header">
        <div className="exchange-title-row">
          <h3>Theme Design Exchange (v2)</h3>
          <span className="badge" data-testid="protocol-badge">
            Protocol: tfsb.theme-review-context-v1 / v2
          </span>
        </div>
        <p className="exchange-intro">
          Review, verify, and adopt v2 theme candidates. Edits to context or candidate revoke verification.
        </p>
      </div>

      {/* Messages */}
      {errorMessage && (
        <div className="exchange-alert exchange-alert-error" role="alert" data-testid="exchange-error">
          <strong>Error:</strong> {errorMessage}
        </div>
      )}
      {successMessage && (
        <div className="exchange-alert exchange-alert-success" role="status" data-testid="exchange-success">
          {successMessage}
        </div>
      )}
      {exportNotice && (
        <div className="exchange-alert exchange-alert-notice" role="note" data-testid="export-notice">
          {exportNotice}
        </div>
      )}

      {/* Action Bar */}
      <div className="exchange-actions-bar">
        <button
          type="button"
          onClick={handleImportCandidate}
          disabled={verifying || adopting}
          data-testid="import-candidate-btn"
        >
          Import Candidate…
        </button>
        <button
          type="button"
          onClick={handleVerify}
          disabled={!candidate || verifying || adopting || !currentContext}
          data-testid="verify-candidate-btn"
        >
          {verifying ? "Verifying Candidate…" : "Verify Candidate"}
        </button>
        <button
          type="button"
          onClick={handleAdoptClick}
          disabled={!isVerifiedValid || verifying || adopting}
          data-testid="adopt-candidate-btn"
        >
          {adopting ? "Adopting…" : "Adopt Candidate"}
        </button>
        <button
          type="button"
          onClick={handleExportContext}
          disabled={!currentContext || verifying || adopting}
          data-testid="export-context-btn"
        >
          Export Local Context…
        </button>
      </div>

      {/* Step 1: Brief Prose Configuration */}
      <fieldset className="form-section exchange-brief-section">
        <legend>Theme Design Brief (Local Context)</legend>
        <div className="field-group">
          <label htmlFor={titleId}>
            Brief Title ({briefTitle.length}/{MAX_TITLE_LENGTH})
          </label>
          <input
            id={titleId}
            type="text"
            maxLength={MAX_TITLE_LENGTH}
            value={briefTitle}
            onChange={handleTitleChange}
            placeholder="Brief title…"
            data-testid="brief-title-input"
          />
        </div>
        <div className="field-group">
          <label htmlFor={goalId}>
            Brief Goal ({briefGoal.length}/{MAX_GOAL_LENGTH})
          </label>
          <textarea
            id={goalId}
            rows={3}
            maxLength={MAX_GOAL_LENGTH}
            value={briefGoal}
            onChange={handleGoalChange}
            placeholder="Describe design brief goals…"
            data-testid="brief-goal-textarea"
          />
        </div>
      </fieldset>

      {/* Step 2: Review Prose Configuration */}
      <fieldset className="form-section exchange-review-section">
        <legend>Candidate Review Prose</legend>
        <div className="field-group">
          <label htmlFor={dispositionId}>Review Disposition</label>
          <select
            id={dispositionId}
            value={reviewDisposition}
            onChange={handleDispositionChange}
            data-testid="review-disposition-select"
          >
            {DISPOSITIONS.map((disp) => (
              <option key={disp} value={disp}>
                {disp.charAt(0).toUpperCase() + disp.slice(1)}
              </option>
            ))}
          </select>
        </div>
        <div className="field-group">
          <label htmlFor={summaryId}>
            Review Summary ({reviewSummary.length}/{MAX_SUMMARY_LENGTH})
          </label>
          <textarea
            id={summaryId}
            rows={3}
            maxLength={MAX_SUMMARY_LENGTH}
            value={reviewSummary}
            onChange={handleSummaryChange}
            placeholder="Reviewer summary…"
            data-testid="review-summary-textarea"
          />
        </div>
      </fieldset>

      {/* Visual Digest Identity Inspector */}
      <div className="exchange-inspector-section" data-testid="identity-inspector">
        <h4>Visual Digest Identity Inspector</h4>
        {candidate ? (
          <dl className="digest-inspector-grid">
            <dt>Candidate ID</dt>
            <dd data-testid="inspector-candidate-id">{candidate.candidateId}</dd>

            {candidate.overrideNotice && (
              <>
                <dt>Candidate ID Notice</dt>
                <dd data-testid="inspector-candidate-id-notice">{candidate.overrideNotice}</dd>
              </>
            )}

            <dt>Candidate Family</dt>
            <dd data-testid="inspector-family">
              {candidate.family} ({candidate.schema} v{candidate.schemaVersion})
            </dd>

            <dt>Candidate Digest</dt>
            <dd data-testid="inspector-candidate-digest">
              <code>{candidate.candidateDigest}</code>
            </dd>

            <dt>Verification Status</dt>
            <dd data-testid="inspector-status">
              {verifying
                ? "Verifying…"
                : verification
                ? verification.valid
                  ? "Verified (Valid)"
                  : "Verification Failed"
                : "Unverified"}
            </dd>

            {verification && (
              <>
                <dt>Input Digest</dt>
                <dd data-testid="inspector-input-digest">
                  <code>{verification.inputDigest || "—"}</code>
                </dd>

                <dt>Output Digest</dt>
                <dd data-testid="inspector-output-digest">
                  <code>{verification.outputDigest || "—"}</code>
                </dd>

                <dt>Inventory Digest</dt>
                <dd data-testid="inspector-inventory-digest">
                  <code>{verification.descriptor?.inventoryDigest || "—"}</code>
                </dd>

                <dt>Catalog Identity</dt>
                <dd data-testid="inspector-catalog-identity">
                  {verification.descriptor?.catalogIdentity || "—"}
                </dd>

                <dt>Compiler Semantic</dt>
                <dd data-testid="inspector-compiler-semantic">
                  {verification.descriptor?.compilerSemantic || "—"}
                </dd>
              </>
            )}
          </dl>
        ) : (
          <p className="empty-state-text" data-testid="no-candidate-notice">
            No design candidate imported yet. Click "Import Candidate…" to load a candidate packet.
          </p>
        )}
      </div>

      {/* Dirty Draft Adoption Confirmation Modal */}
      {showDirtyModal && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" data-testid="dirty-adopt-dialog">
          <div className="modal-card">
            <h4>Discard Unsaved Changes?</h4>
            <p>
              Your active draft has unsaved modifications. Adopting candidate "
              {candidate?.candidateId ?? "candidate"}" will replace the draft with the verified theme and
              discard your current changes.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setShowDirtyModal(false)}
                data-testid="dirty-cancel-btn"
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-danger"
                onClick={() => executeAdopt(true)}
                data-testid="dirty-confirm-btn"
              >
                Discard & Adopt
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
