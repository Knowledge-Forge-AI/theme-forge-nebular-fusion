import { useEffect, useRef, useState } from "react";

export type ViewportMode = "desktop" | "mobile";
export type ColorSchemeMode = "dark" | "light";

export interface StarlightPreviewProps {
  readonly css?: string | undefined;
  readonly revision: number;
  readonly mode: ColorSchemeMode;
  readonly isLastGood?: boolean | undefined;
  readonly onModeChange?: ((mode: ColorSchemeMode) => void) | undefined;
}

export function StarlightPreview({
  css,
  revision,
  mode,
  isLastGood = false,
  onModeChange,
}: StarlightPreviewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [viewport, setViewport] = useState<ViewportMode>("desktop");
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [appliedRevision, setAppliedRevision] = useState<number>(0);
  const highestSentRevision = useRef(0);

  const sendThemeToIframe = () => {
    if (!iframeRef.current?.contentWindow) return;
    if (css === undefined) return;

    if (revision < highestSentRevision.current) {
      return;
    }
    highestSentRevision.current = Math.max(highestSentRevision.current, revision);

    iframeRef.current.contentWindow.postMessage(
      {
        type: "tfsl:apply-theme",
        css,
        mode,
        revision,
      },
      "*",
    );
  };

  useEffect(() => {
    if (iframeLoaded) {
      sendThemeToIframe();
    }
  }, [css, revision, mode, iframeLoaded]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (!iframeRef.current?.contentWindow || event.source !== iframeRef.current.contentWindow) {
        return;
      }
      if (!event.data || typeof event.data !== "object") return;
      if (event.data.type === "tfsl:theme-applied" && typeof event.data.revision === "number") {
        setAppliedRevision((prev) => Math.max(prev, event.data.revision));
        if (typeof event.data.computedAccent === "string" && iframeRef.current) {
          iframeRef.current.dataset.computedAccent = event.data.computedAccent;
        }
        if (typeof event.data.renderedLinkColor === "string" && iframeRef.current) {
          iframeRef.current.dataset.renderedLinkColor = event.data.renderedLinkColor;
        }
      }
      if (event.data.type === "tfsl:command-attempt-result" && iframeRef.current) {
        iframeRef.current.dataset.commandAttempt = JSON.stringify(event.data);
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  const handleIframeLoad = () => {
    setIframeLoaded(true);
    sendThemeToIframe();
  };

  const reloadIframe = () => {
    if (iframeRef.current) {
      setIframeLoaded(false);
      iframeRef.current.src = "/preview/index.html";
    }
  };

  return (
    <div className="preview-container">
      <div className="preview-toolbar">
        <div className="preview-toolbar-group">
          <span className="preview-badge">Live Starlight Fixture</span>
          {isLastGood ? (
            <span className="preview-badge warning" title="Displaying previous valid compilation">
              (Previewing last valid theme)
            </span>
          ) : null}
          <span className="preview-meta">
            Rev: {appliedRevision}
          </span>
        </div>

        <div className="preview-toolbar-group">
          <div className="segmented-control" role="group" aria-label="Theme mode switcher">
            <button
              type="button"
              className={mode === "dark" ? "active" : ""}
              onClick={() => onModeChange?.("dark")}
              aria-pressed={mode === "dark"}
            >
              Dark
            </button>
            <button
              type="button"
              className={mode === "light" ? "active" : ""}
              onClick={() => onModeChange?.("light")}
              aria-pressed={mode === "light"}
            >
              Light
            </button>
          </div>

          <div className="segmented-control" role="group" aria-label="Viewport size switcher">
            <button
              type="button"
              className={viewport === "desktop" ? "active" : ""}
              onClick={() => setViewport("desktop")}
              aria-pressed={viewport === "desktop"}
            >
              Desktop
            </button>
            <button
              type="button"
              className={viewport === "mobile" ? "active" : ""}
              onClick={() => setViewport("mobile")}
              aria-pressed={viewport === "mobile"}
            >
              Mobile (375px)
            </button>
          </div>

          <button
            type="button"
            className="refresh-button"
            onClick={reloadIframe}
            title="Reload preview frame"
          >
            Reload
          </button>
        </div>
      </div>

      <div className={`preview-frame-wrapper ${viewport}`}>
        <iframe
          ref={iframeRef}
          src="/preview/index.html"
          title="Starlight Theme Preview"
          className="preview-iframe"
          sandbox="allow-scripts"
          onLoad={handleIframeLoad}
        />
      </div>
    </div>
  );
}
