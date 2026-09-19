import React, { useEffect, useRef, useState } from "react";

interface ApplicationPreviewProps {
  css?: string;
  revision: number;
  mode: "light" | "dark";
  onModeChange?: (mode: "light" | "dark") => void;
  stale?: boolean;
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
}: ApplicationPreviewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [viewport, setViewport] = useState<"desktop" | "mobile">("desktop");
  const [appliedRevision, setAppliedRevision] = useState<number>(0);
  const [appliedPrimary, setAppliedPrimary] = useState<string>("");
  const [applicationState, setApplicationState] = useState<"pending" | "applied" | "failed">("pending");

  const contextId = `${revision}:${mode}:${computeCssHash(css || "")}`;

  const sendThemeToFrame = () => {
    if (!iframeRef.current || !iframeRef.current.contentWindow) return;
    setApplicationState("pending");
    iframeRef.current.contentWindow.postMessage(
      {
        type: "tfss:apply-theme",
        css: css || "",
        mode,
        revision,
        contextId,
      },
      "*"
    );
  };

  useEffect(() => {
    sendThemeToFrame();
  }, [css, mode, revision, contextId]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (!event.data || typeof event.data !== "object") return;
      if (!iframeRef.current || !iframeRef.current.contentWindow) return;
      if (event.source !== iframeRef.current.contentWindow) return;

      if (event.data.type === "tfss:theme-applied") {
        const ackRev = typeof event.data.revision === "number" ? event.data.revision : 0;
        const ackMode = event.data.mode;
        const ackContextId = event.data.contextId;
        if (ackRev === revision && ackMode === mode && ackContextId === contextId) {
          setAppliedRevision(ackRev);
          setAppliedPrimary(event.data.computedPrimary || "");
          setApplicationState("applied");
        }
      } else if (event.data.type === "tfss:theme-apply-failed") {
        const ackRev = typeof event.data.revision === "number" ? event.data.revision : 0;
        const ackMode = event.data.mode;
        const ackContextId = event.data.contextId;
        if (ackRev === revision && ackMode === mode && ackContextId === contextId) {
          setApplicationState("failed");
        }
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [revision, mode, contextId]);

  const reloadFrame = () => {
    if (iframeRef.current) {
      iframeRef.current.src = "/preview/app/index.html";
    }
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
        <p role="note" style={{ margin: 0, fontSize: "0.75rem", color: "#bcb3ce" }}>
          Notice: Preview displays lightweight shadcn-style component adaptations in a sandboxed iframe adopting constructable stylesheets.
          Component interactions are live within the frame; zero native bridge or external network authority is granted.
        </p>
      </div>


      <div className={`preview-frame-wrapper ${viewport}`}>
        <iframe
          ref={iframeRef}
          src="/preview/app/index.html"
          title="Application Theme Live Preview"
          className="preview-iframe"
          sandbox="allow-scripts"
          style={viewport === "mobile" ? { width: 390, maxWidth: "100%" } : undefined}
          onLoad={sendThemeToFrame}
        />
      </div>
    </div>
  );
}
