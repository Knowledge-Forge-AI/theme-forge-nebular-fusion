import { useState } from "react";
import type {
  CandidateDisposition,
  CandidateEvidence,
  CandidateReviewFixture,
} from "../../protocol/contracts";

const dispositions: readonly CandidateDisposition[] = [
  "unreviewed",
  "preferred",
  "rejected",
  "needs-revision",
];

function Thumbnail({ candidate, background, accent }: {
  readonly candidate: CandidateEvidence;
  readonly background: "light" | "dark" | "transparent";
  readonly accent: string;
}) {
  const geometry = candidate.geometry === "nova-orbit-v1" ? (
    <>
      <path data-geometry-part="orbit-burst" d="M60 8 67 29 90 19 77 40 102 45 78 53 88 75 66 61 60 78 54 61 32 75 42 53 18 45 43 40 30 19 53 29Z" fill={accent} />
      <circle data-geometry-part="orbit-core" cx="60" cy="45" r="10" fill="currentColor" />
      <circle data-geometry-part="orbit-ring" cx="60" cy="45" r="20" fill="none" stroke="currentColor" strokeWidth="2" />
    </>
  ) : (
    <>
      <path data-geometry-part="pulse-rays" d="M16 40H43L31 25 50 34 60 10 70 34 89 25 77 40H104L77 50 89 65 70 56 60 78 50 56 31 65 43 50Z" fill={accent} />
      <circle data-geometry-part="pulse-outer" cx="60" cy="45" r="17" fill="currentColor" />
      <circle data-geometry-part="pulse-inner" cx="60" cy="45" r="8" fill={accent} />
    </>
  );
  return (
    <figure className={`thumbnail thumbnail-${background}`}>
      <svg viewBox="0 0 120 80" role="img" aria-labelledby={`${candidate.id}-${background}-title`} data-geometry={candidate.geometry} data-render-identity={`${candidate.geometry}:${background}`}>
        <title id={`${candidate.id}-${background}-title`}>{candidate.name} on {background}</title>
        {geometry}
      </svg>
      <figcaption>{background}</figcaption>
    </figure>
  );
}

function CandidateCard({ candidate, disposition, onDisposition }: {
  readonly candidate: CandidateEvidence;
  readonly disposition: CandidateDisposition;
  readonly onDisposition: (next: CandidateDisposition) => void;
}) {
  return (
    <article className="candidate-card" aria-labelledby={`${candidate.id}-heading`}>
      <header>
        <p className="candidate-target">{candidate.target}</p>
        <h3 id={`${candidate.id}-heading`}>{candidate.name}</h3>
      </header>
      <div className="thumbnail-row">
        {candidate.renders.map((render) => (
          <Thumbnail key={render.background} candidate={candidate} {...render} />
        ))}
      </div>
      <dl className="evidence-list">
        <div><dt>Semantic change</dt><dd>{candidate.semanticSummary}</dd></div>
        <div><dt>Pixel change</dt><dd>{candidate.pixelSummary}</dd></div>
        <div><dt>QA</dt><dd>{candidate.qa.pass} pass · {candidate.qa.fail} fail · {candidate.qa.unavailable} unavailable</dd></div>
        <div><dt>Accessibility</dt><dd>{candidate.accessibilityFindings.join("; ")}</dd></div>
        <div><dt>Palette</dt><dd>{candidate.paletteFindings.join("; ")}</dd></div>
        <div><dt>Candidate digest</dt><dd><code>{candidate.candidateDigest}</code></dd></div>
        <div><dt>Evidence digest</dt><dd><code>{candidate.evidenceDigest}</code></dd></div>
      </dl>
      <fieldset>
        <legend>Fixture-local human disposition</legend>
        {dispositions.map((option) => (
          <label key={option}>
            <input
              type="radio"
              name={`${candidate.id}-disposition`}
              value={option}
              checked={disposition === option}
              onChange={() => onDisposition(option)}
            />
            {option}
          </label>
        ))}
      </fieldset>
      <p className="local-note" role="status">Local disposition: {disposition}. This is not a TFSB plan.</p>
    </article>
  );
}

export function CandidateReview({ fixture }: { readonly fixture: CandidateReviewFixture }) {
  const [dispositionByCandidate, setDispositionByCandidate] = useState<Readonly<Record<string, CandidateDisposition>>>({});

  return (
    <section aria-labelledby="candidate-heading" className="candidate-section">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Synthetic human-agent design lab preview</p>
          <p className="section-kicker">{fixture.project}</p>
          <h2 id="candidate-heading">Candidate review · {fixture.brand}</h2>
        </div>
        <p>Human judgment stays local; every visual remains bound to deterministic fixture evidence.</p>
      </div>
      <div className="candidate-grid">
        {fixture.candidates.map((candidate) => (
          <CandidateCard
            key={candidate.id}
            candidate={candidate}
            disposition={dispositionByCandidate[candidate.id] ?? "unreviewed"}
            onDisposition={(next) => setDispositionByCandidate((current) => ({ ...current, [candidate.id]: next }))}
          />
        ))}
      </div>
    </section>
  );
}
