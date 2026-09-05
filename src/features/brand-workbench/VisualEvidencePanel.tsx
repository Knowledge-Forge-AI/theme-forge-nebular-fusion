import type { VisualEvidence } from "../../brand-read/StudioBrandReadClient";
import type { SelectedEvidence } from "./workbench-state";

function selectedIdentityText(selection: SelectedEvidence): { readonly label: string; readonly identity: string } {
  if (selection.kind === "none") return { label: "", identity: "" };
  if (selection.kind === "qa-baseline-case") {
    return {
      label: selection.label,
      identity: `QA baseline case ${selection.profileId}/${selection.caseId} (target: ${selection.assetId})`,
    };
  }
  if (selection.kind === "export-output-target") {
    return {
      label: selection.label,
      identity: `Export output ${selection.profileId}/${selection.outputId} (${selection.assetId}) · ${selection.width}×${selection.height} · ${selection.background}`,
    };
  }
  return {
    label: selection.label,
    identity: `${selection.assetId} · ${selection.width}×${selection.height} · ${selection.background}`,
  };
}

export function VisualEvidencePanel({
  selection,
  evidence,
  urls,
  available,
  loading,
  onRender,
}: {
  readonly selection: SelectedEvidence;
  readonly evidence: VisualEvidence | undefined;
  readonly urls: readonly string[];
  readonly available: boolean;
  readonly loading: boolean;
  readonly onRender: () => void;
}) {
  const selectionInfo = selectedIdentityText(selection);

  return (
    <aside className="visual-panel" aria-labelledby="visual-evidence-title">
      <h4 id="visual-evidence-title">Verified visual evidence</h4>
      {selection.kind === "none" ? (
        <p>Select one exact typed record before rendering.</p>
      ) : (
        <>
          <p>Selected: <strong>{selectionInfo.label}</strong></p>
          <p>Exact identity: <code>{selectionInfo.identity}</code></p>
        </>
      )}
      <button
        type="button"
        disabled={!available || selection.kind === "none" || loading}
        onClick={onRender}
      >
        {loading ? "Rendering…" : "Render selected evidence"}
      </button>
      {!available ? (
        <p className="semantic-fallback">Raster evidence is unavailable. Semantic evidence remains authoritative.</p>
      ) : null}
      {evidence ? (
        <>
          <div className="verified-target-summary">
            <p>
              Verified target: <code>{evidence.target.assetId}</code>
              {evidence.target.binding ? ` (${evidence.target.binding.family}/${evidence.target.binding.role}/${evidence.target.binding.variant})` : ""} · canonical digest <code>{evidence.target.canonicalAssetDigest}</code>
            </p>
            <p>
              Verified config: {evidence.configuration.width}×{evidence.configuration.height} · {evidence.configuration.background} background · renderer: {evidence.renderer.id} {evidence.renderer.version}
            </p>
          </div>
          <div className="visual-grid">
            {evidence.artifacts.map((artifact, index) => (
              <figure key={artifact.role}>
                <img
                  src={urls[index]}
                  alt={`${artifact.role} visual for ${selection.kind === "none" ? evidence.target.assetId : selection.label}; exact asset ${evidence.target.assetId}; ${artifact.width} by ${artifact.height}; ${evidence.configuration.background} background`}
                  width={artifact.width}
                  height={artifact.height}
                />
                <figcaption>
                  {artifact.role} · {artifact.width}×{artifact.height}<br />
                  <code>{artifact.pngDigest}</code>
                </figcaption>
              </figure>
            ))}
          </div>
        </>
      ) : null}
      {evidence?.difference ? (
        <p>
          {evidence.difference.claim}; changed pixels {evidence.difference.changedPixels}; maximum channel delta {evidence.difference.maximumChannelDelta}.
        </p>
      ) : null}
    </aside>
  );
}
