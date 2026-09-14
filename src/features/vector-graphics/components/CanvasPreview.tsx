import React from "react";
import type { Artboard, SceneDiagnosticDto, SceneMetricsDto } from "../types";

export interface CanvasPreviewProps {
  previewUrl: string | null;
  previewRevision: number | null;
  currentRevision: number;
  isStale: boolean;
  dirty: boolean;
  isCompiling: boolean;
  artboard: Artboard;
  metrics: SceneMetricsDto | null;
  diagnostics: readonly SceneDiagnosticDto[];
  compileError?: string | null;
  onRefreshCompile: () => void;
}

export function CanvasPreview({
  previewUrl,
  previewRevision,
  currentRevision,
  isStale,
  dirty,
  isCompiling,
  artboard,
  metrics,
  diagnostics,
  compileError,
  onRefreshCompile,
}: CanvasPreviewProps) {
  const [zoom, setZoom] = React.useState(1.0);

  const errors = diagnostics.filter((d) => d.severity === "error");
  const warnings = diagnostics.filter((d) => d.severity === "warning");

  return (
    <div className="canvas-preview-container" data-testid="canvas-preview">
      {/* Top Status Bar */}
      <div className="canvas-status-bar">
        <div className="status-badges">
          <span className="preview-rev-badge">
            Preview Rev {previewRevision ?? 0}
          </span>
          {isStale && (
            <span className="stale-badge" aria-label="Stale preview warning" data-testid="stale-preview-badge">
              ⚠️ Stale Preview (Compiled at Rev {previewRevision ?? 0})
            </span>
          )}
          {isCompiling && (
            <span className="compiling-badge">
              Compiling…
            </span>
          )}
        </div>

        <div className="canvas-controls">
          <button
            type="button"
            className="action-btn-xs"
            onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))}
            aria-label="Zoom out"
          >
            -
          </button>
          <span className="zoom-text">{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            className="action-btn-xs"
            onClick={() => setZoom((z) => Math.min(3.0, z + 0.25))}
            aria-label="Zoom in"
          >
            +
          </button>
          <button
            type="button"
            className="action-btn-xs"
            onClick={() => setZoom(1.0)}
            aria-label="Reset zoom"
          >
            100%
          </button>
          <button
            type="button"
            className="action-btn-xs compile-btn"
            onClick={onRefreshCompile}
            disabled={isCompiling}
            aria-label="Compile Scene Preview"
          >
            ↻ Compile
          </button>
        </div>
      </div>

      {/* Main Inert Blob Canvas */}
      <div className="canvas-viewport" style={{ overflow: "auto" }}>
        <div
          className="canvas-artboard-frame"
          style={{
            transform: `scale(${zoom})`,
            transformOrigin: "top left",
            width: artboard.width,
            height: artboard.height,
          }}
        >
          {previewUrl ? (
            /* TFSB63A: Inert img Blob engine SVG only. No raw SVG markup injection. */
            <img
              src={previewUrl}
              alt="Vector Scene Preview"
              width={artboard.width}
              height={artboard.height}
              className={`inert-blob-preview ${isStale ? "stale-img" : ""}`}
              data-testid="inert-blob-img"
            />
          ) : (
            <div className="preview-placeholder">
              {isCompiling ? (
                <p>Compiling initial SVG blob preview…</p>
              ) : (
                <p>No preview compiled yet. Click ↻ Compile to render.</p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Compile Errors / Warnings */}
      {compileError && (
        <div className="preview-error-alert" role="alert" data-testid="compile-error-alert">
          <strong>Compile Failure:</strong> {compileError}
        </div>
      )}

      {errors.length > 0 && (
        <div className="preview-diagnostics-alert error" role="alert">
          <strong>{errors.length} Diagnostic Error(s):</strong>
          <ul>
            {errors.map((err, i) => (
              <li key={i}>{err.code}: {err.message}</li>
            ))}
          </ul>
        </div>
      )}

      {warnings.length > 0 && (
        <div className="preview-diagnostics-alert warning">
          <strong>{warnings.length} Warning(s):</strong>
          <ul>
            {warnings.map((warn, i) => (
              <li key={i}>{warn.code}: {warn.message}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Metrics Footer */}
      {metrics && (
        <footer className="canvas-metrics-bar" data-testid="metrics-bar">
          <span>Elements: {metrics.authoredElementCount} (expanded {metrics.expandedElementCount})</span>
          <span>Segments: {metrics.pathSegmentCount}</span>
          <span>Glyphs: {metrics.glyphCount}</span>
          <span>Max Nesting: {metrics.maxNestingDepth}</span>
          <span>Gradient Stops: {metrics.gradientStopCount}</span>
        </footer>
      )}
    </div>
  );
}
