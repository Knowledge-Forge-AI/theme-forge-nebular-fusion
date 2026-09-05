import { useState } from "react";
import type { VisualArtifact, VisualEvidence } from "../../brand-read/StudioBrandReadClient";
import type { CandidatePacket, ClaimCategory, ClaimSeverity, ReviewAnnotation } from "../../design-evidence/types";
import { artifactKeyFor } from "./blob-identity";

interface AnnotationEditorProps {
  readonly candidate: CandidatePacket;
  readonly visual: VisualEvidence;
  readonly artifact: VisualArtifact;
  readonly imageUrl: string;
  readonly editing?: ReviewAnnotation;
  readonly onCancelEdit?: () => void;
  readonly onSave: (annotation: ReviewAnnotation) => void;
}

export function AnnotationEditor({ candidate, visual, artifact, imageUrl, editing, onCancelEdit, onSave }: AnnotationEditorProps) {
  const artifactKey = artifactKeyFor(candidate, visual, artifact);
  const initialRegion = editing?.scope.kind === "region" ? editing.scope : undefined;
  const [region, setRegion] = useState(editing?.scope.kind === "region");
  const [x, setX] = useState(initialRegion?.xMillionths ?? 0);
  const [y, setY] = useState(initialRegion?.yMillionths ?? 0);
  const [width, setWidth] = useState(initialRegion?.widthMillionths ?? 250_000);
  const [height, setHeight] = useState(initialRegion?.heightMillionths ?? 250_000);
  const [comment, setComment] = useState(editing?.comment ?? "");
  const [elementId, setElementId] = useState(editing?.elementId ?? "");
  const [category, setCategory] = useState<ClaimCategory>(editing?.category ?? "composition");
  const [severity, setSeverity] = useState<ClaimSeverity>(editing?.severity ?? "note");
  const bounded = Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && x >= 0 && y >= 0 && x + width <= 1_000_000 && y + height <= 1_000_000;
  const pick = (event: React.PointerEvent<HTMLImageElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0 || event.currentTarget.naturalWidth <= 0 || event.currentTarget.naturalHeight <= 0) return;
    setX(Math.max(0, Math.min(750_000, Math.round((event.clientX - box.left) / box.width * 1_000_000) - 125_000)));
    setY(Math.max(0, Math.min(750_000, Math.round((event.clientY - box.top) / box.height * 1_000_000) - 125_000)));
    setWidth(250_000); setHeight(250_000); setRegion(true);
  };
  const save = () => {
    if (!comment || !bounded) return;
    onSave({
      annotationId: editing?.annotationId ?? `annotation-${crypto.randomUUID().replaceAll("-", "")}`,
      candidateDigest: candidate.candidateDigest,
      visualEvidenceDigest: visual.evidenceDigest,
      artifactRole: artifact.role,
      pngDigest: artifact.pngDigest,
      scope: region ? { kind: "region", xMillionths: x, yMillionths: y, widthMillionths: width, heightMillionths: height } : { kind: "artifact" },
      category,
      severity,
      comment,
      ...(elementId ? { elementId } : {}),
    });
    setComment(""); onCancelEdit?.();
  };
  return <section className="annotation-editor" aria-labelledby="annotation-heading">
    <h4 id="annotation-heading">{editing ? "Edit structured annotation" : "Structured annotation"}</h4>
    <p>Annotating <code>{artifactKey}</code></p>
    <div className="annotated-image" data-artifact-key={artifactKey}><img src={imageUrl} onPointerDown={pick} alt={`${candidate.title}, ${visual.target.assetId}, ${artifact.role}, ${artifact.width} by ${artifact.height}, ${visual.configuration.background}`} />{region ? <svg className="annotation-overlay" viewBox="0 0 1000000 1000000" preserveAspectRatio="none" aria-hidden="true" data-artifact-key={artifactKey}><rect className="annotation-rect" x={x} y={y} width={width} height={height} vectorEffect="non-scaling-stroke" /></svg> : null}</div>
    <label><input type="checkbox" checked={region} onChange={(event) => setRegion(event.target.checked)} /> Region annotation</label>
    {region ? <div className="coordinate-grid"><label>X<input type="number" min="0" max="1000000" value={x} onChange={(event) => setX(Number(event.target.value))} /></label><label>Y<input type="number" min="0" max="1000000" value={y} onChange={(event) => setY(Number(event.target.value))} /></label><label>Width<input type="number" min="1" max="1000000" value={width} onChange={(event) => setWidth(Number(event.target.value))} /></label><label>Height<input type="number" min="1" max="1000000" value={height} onChange={(event) => setHeight(Number(event.target.value))} /></label></div> : null}
    <label>Category <select value={category} onChange={(event) => setCategory(event.target.value as ClaimCategory)}><option>composition</option><option>alignment</option><option>spacing</option><option>legibility</option><option>contrast</option><option>color</option><option>brand-fit</option><option>accessibility</option><option>small-size</option><option>technical</option><option>other</option></select></label>
    <label>Severity <select value={severity} onChange={(event) => setSeverity(event.target.value as ClaimSeverity)}><option>note</option><option>minor</option><option>substantive</option><option>blocking</option></select></label>
    <label>Optional public element ID <input value={elementId} onChange={(event) => setElementId(event.target.value)} /></label>
    <label>Comment <textarea maxLength={2048} value={comment} onChange={(event) => setComment(event.target.value)} /></label>
    <div className="exchange-controls"><button type="button" disabled={!comment || !bounded} onClick={save}>{editing ? "Save annotation changes" : "Save annotation"}</button>{editing ? <button type="button" onClick={onCancelEdit}>Cancel edit</button> : null}</div>
    {!bounded ? <p role="alert">Region must stay within the image.</p> : null}
  </section>;
}
