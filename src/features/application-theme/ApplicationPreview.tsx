import React, { useEffect, useRef, useState } from "react";
import {
  createPreviewFrameIdentity,
  normalizeComputedPreviewToken,
  previewState,
  type PreviewApplicationStateCallback,
  type PreviewFrameIdentity,
} from "./preview-application-state";

export interface ApplicationPreviewProps {
  css?: string;
  revision: number;
  mode: "light" | "dark";
  onModeChange?: (mode: "light" | "dark") => void;
  stale?: boolean;
  onPreviewState?: PreviewApplicationStateCallback;
}

function computeCssHash(css: string): string {
  let h = 5381;
  for (let i = 0; i < css.length; i++) {
    h = ((h << 5) + h) + css.charCodeAt(i);
    h |= 0;
  }
  return (h >>> 0).toString(16);
}

export function ApplicationPreview({
  css,
  revision,
  mode,
  onModeChange,
  stale = false,
  onPreviewState,
}: ApplicationPreviewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const previewStateCallback = useRef(onPreviewState);
  previewStateCallback.current = onPreviewState;
  const [viewport, setViewport] = useState<"desktop" | "mobile">("desktop");
  const [reload, setReload] = useState(0);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [frameIdentity, setFrameIdentity] = useState<PreviewFrameIdentity>(() => createPreviewFrameIdentity(0));
  const [appliedRevision, setAppliedRevision] = useState<number>(0);
  const [appliedPrimary, setAppliedPrimary] = useState<string>("");
  const [applicationState, setApplicationState] = useState<"pending" | "applied" | "failed">("pending");

  const contextId = `generation:${frameIdentity.generation}:frame:${frameIdentity.frameId}:revision:${revision}:mode:${mode}:css:${computeCssHash(css || "")}`;

  const notifyPending = (identity: PreviewFrameIdentity, identityContextId: string, applicationId?: string) => {
    previewStateCallback.current?.(previewState("pending", revision, mode, identity.frameId, {
      contextId: identityContextId,
      ...(applicationId === undefined ? {} : { applicationId }),
    }));
  };

  useEffect(() => {
    const frame = iframeRef.current;
    if (!frameLoaded || !frame?.contentWindow) return;

    setAppliedRevision(0);
    setAppliedPrimary("");
    setApplicationState("pending");
    notifyPending(frameIdentity, contextId);

    try {
      frame.contentWindow.postMessage(
        {
          type: "tfss:apply-theme",
          css: css || "",
          mode,
          revision,
          contextId,
          frameId: frameIdentity.frameId,
        },
        "*"
      );
    } catch {
      setApplicationState("failed");
      previewStateCallback.current?.(previewState("failed", revision, mode, frameIdentity.frameId, { contextId }));
    }

    return () => undefined;
  }, [css, contextId, frameIdentity, frameLoaded, mode, revision]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (!event.data || typeof event.data !== "object") return;
      if (!iframeRef.current || !iframeRef.current.contentWindow) return;
      if (event.source !== iframeRef.current.contentWindow) return;
      if (event.data.frameId !== frameIdentity.frameId) return;

      if (event.data.type === "tfss:theme-applied") {
        const ackRev = typeof event.data.revision === "number" ? event.data.revision : 0;
        const ackMode = event.data.mode;
        const ackContextId = event.data.contextId;
        if (ackRev === revision && ackMode === mode && ackContextId === contextId) {
          const computedPrimary = normalizeComputedPreviewToken(event.data.computedPrimary);
          if (computedPrimary === null) {
            setApplicationState("failed");
            previewStateCallback.current?.(previewState("failed", revision, mode, frameIdentity.frameId, { contextId }));
            return;
          }
          setAppliedRevision(ackRev);
          setAppliedPrimary(computedPrimary);
          setApplicationState("applied");
          previewStateCallback.current?.(previewState("applied", ackRev, mode, frameIdentity.frameId, {
            contextId,
            computedToken: computedPrimary,
          }));
        }
      } else if (event.data.type === "tfss:theme-apply-failed") {
        const ackRev = typeof event.data.revision === "number" ? event.data.revision : 0;
        const ackMode = event.data.mode;
        const ackContextId = event.data.contextId;
        if (ackRev === revision && ackMode === mode && ackContextId === contextId) {
          setApplicationState("failed");
          previewStateCallback.current?.(previewState("failed", revision, mode, frameIdentity.frameId, { contextId }));
        }
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [contextId, frameIdentity.frameId, mode, revision]);

  const reloadFrame = () => {
    setFrameLoaded(false);
    setAppliedRevision(0);
    setAppliedPrimary("");
    setApplicationState("pending");
    // Invalidate the old token now; onLoad creates one replacement identity
    // for the new iframe lifetime.
    notifyPending(frameIdentity, contextId);
    setReload(value => value + 1);
  };

  const handleFrameLoad = () => {
    const nextIdentity = createPreviewFrameIdentity(frameIdentity.generation + 1);
    setFrameIdentity(nextIdentity);
    setFrameLoaded(true);
    setAppliedRevision(0);
    setAppliedPrimary("");
    setApplicationState("pending");
  };

  const isConfirmed = applicationState === "applied" && appliedRevision === revision && !stale;
  const statusLabel = stale
    ? "Stale preview (compilation pending or engine degraded)"
    : isConfirmed
    ? "Live CSS applied to shadcn-style component adaptations"
    : applicationState === "failed"
    ? "Preview style application failed"
    : "Preview theme update pending...";

  return (
    <div
      className="preview-container app-preview-container"
      data-applied-state={applicationState}
      data-applied-primary={appliedPrimary || undefined}
    >
      <div className="preview-toolbar">
        <div className="preview-toolbar-group">
          <span className="preview-badge">Application Theme Preview</span>
          <span role="status" className="preview-status">
            {statusLabel}
          </span>
          {isConfirmed && appliedPrimary ? (
            <span className="preview-meta" data-testid="applied-primary-token">
              Primary: {appliedPrimary}
            </span>
          ) : null}
          <span className="preview-meta">Rev: {appliedRevision}</span>
          {stale ? <span className="preview-badge warning">(Stale)</span> : null}
        </div>

        <div className="preview-toolbar-group">
          <div className="segmented-control" role="group" aria-label="Theme mode switcher">
            {(["dark", "light"] as const).map((val) => (
              <button
                key={val}
                type="button"
                className={mode === val ? "active" : ""}
                aria-pressed={mode === val}
                onClick={() => onModeChange?.(val)}
              >
                {val === "dark" ? "Dark" : "Light"}
              </button>
            ))}
          </div>

          <div className="segmented-control" role="group" aria-label="Viewport switcher">
            {(["desktop", "mobile"] as const).map((v) => (
              <button
                key={v}
                type="button"
                className={viewport === v ? "active" : ""}
                aria-pressed={viewport === v}
                onClick={() => setViewport(v)}
              >
                {v === "desktop" ? "Desktop" : "Mobile (390px)"}
              </button>
            ))}
          </div>

          <button type="button" className="refresh-button" onClick={reloadFrame}>
            Reload
          </button>
        </div>
      </div>

      <div className="preview-disclosure">
        <p role="note" style={{ margin: 0, fontSize: "0.75rem", color: "var(--muted-foreground, #bcb3ce)" }}>
          Notice: Preview displays lightweight shadcn-style component adaptations in a sandboxed iframe adopting constructable stylesheets.
          Component interactions are live within the frame; zero native bridge or external network authority is granted.
        </p>
      </div>


      <div className={`preview-frame-wrapper ${viewport}`}>
        <iframe
          key={reload}
          ref={iframeRef}
          src="/preview/app/index.html"
          title="Application Theme Live Preview"
          className="preview-iframe"
          sandbox="allow-scripts"
          style={viewport === "mobile" ? { width: 390, maxWidth: "100%" } : undefined}
          onLoad={handleFrameLoad}
        />
      </div>
    </div>
  );
}
