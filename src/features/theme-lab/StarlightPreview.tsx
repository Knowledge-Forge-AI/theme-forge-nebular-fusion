import { useEffect, useMemo, useRef, useState } from "react";
import { BRIDGE_CONTRACT, GALLERY_AXES, GALLERY_SCENARIOS, GALLERY_SCENARIO_IDS, SYNTAX_PREVIEW_NOTICE,
  isLegacyThemeAck, isThemeAppliedBridgeAck, isThemeFailure, normalizeCommandAttemptResult,
  resolveDraftGallerySelection, validatePreSendCss, type GalleryAxis, type GalleryScenarioId } from "./gallery-contract";
import type { ThemeSpecificationV2 } from "./v2-model";

export type ViewportMode = "desktop" | "mobile";
export type ColorSchemeMode = "dark" | "light";
export interface StarlightPreviewProps {
  readonly css?: string | undefined; readonly revision: number; readonly mode: ColorSchemeMode;
  readonly isLastGood?: boolean | undefined; readonly onModeChange?: ((mode: ColorSchemeMode) => void) | undefined;
  readonly gallery?: boolean | undefined; readonly spec?: ThemeSpecificationV2 | undefined;
  readonly compiledSpec?: ThemeSpecificationV2 | undefined;
}
type Pending = { revision: number; generation: number; scenario: GalleryScenarioId; applicationId: string; source: Window };
export function StarlightPreview({ css, revision, mode, isLastGood = false, onModeChange, gallery = false, spec, compiledSpec }: StarlightPreviewProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [viewport, setViewport] = useState<ViewportMode>("desktop");
  const [axis, setAxis] = useState<GalleryAxis>("sidebarMode");
  const [manual, setManual] = useState<GalleryScenarioId | null>(null);
  const [heroIndex, setHeroIndex] = useState(0);
  const [reload, setReload] = useState(0);
  const [loadedKey, setLoadedKey] = useState("");
  const [loadSerial, setLoadSerial] = useState(0);
  const [navigated, setNavigated] = useState(false);
  const [appliedRevision, setAppliedRevision] = useState(0);
  const [applicationState, setApplicationState] = useState<"pending" | "applied" | "failed">("pending");
  const [failure, setFailure] = useState<string | null>(null);
  const pending = useRef<Pending | null>(null);
  const sequence = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const preflight = validatePreSendCss(css);
  const sourceSpec = isLastGood ? compiledSpec : spec;
  const desired = useMemo(() => resolveDraftGallerySelection(sourceSpec, axis, manual, heroIndex), [sourceSpec, axis, manual, heroIndex]);
  const lastGoodView = useRef(desired);
  // Oversize input is refused before replacing a frame as well as before posting.
  const view = preflight.valid ? desired : lastGoodView.current;
  const key = `${gallery ? view.entryPath : "neutral"}:${reload}`;
  const currentKey = useRef(key);
  const generation = useRef(0);
  if (currentKey.current !== key) { currentKey.current = key; generation.current++; pending.current = null; }
  const stopTimer = () => { if (timer.current !== null) clearTimeout(timer.current); timer.current = null; };

  useEffect(() => {
    stopTimer(); pending.current = null;
    if (!preflight.valid) { setApplicationState("failed"); setFailure(preflight.error ?? "Preview CSS rejected."); return; }
    if (loadedKey !== key || css === undefined || !frameRef.current?.contentWindow) return;
    const applicationId = `application-${++sequence.current}`;
    const next = { revision, generation: generation.current, scenario: view.scenarioId, applicationId, source: frameRef.current.contentWindow };
    pending.current = next;
    setApplicationState("pending"); setFailure(null);
    timer.current = setTimeout(() => {
      if (pending.current === next) {
        pending.current = null; setApplicationState("failed");
        setFailure("Preview application was not acknowledged. The displayed result is unconfirmed; retry or reload.");
      }
    }, BRIDGE_CONTRACT.acknowledgementTimeoutMs);
    try {
      next.source.postMessage({ type: "tfsl:apply-theme", css, mode, revision,
        ...(gallery ? { frameGeneration: next.generation, scenarioId: next.scenario, applicationId } : {}) }, "*");
    } catch {
      stopTimer(); pending.current = null; setApplicationState("failed"); setFailure("Preview application failed. Retry or reload.");
    }
    return () => { stopTimer(); pending.current = null; };
  }, [css, revision, mode, loadedKey, loadSerial, key, gallery, view.scenarioId, preflight.valid]);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame?.contentWindow || event.source !== frame.contentWindow) return;
      const probe = normalizeCommandAttemptResult(event.data);
      if (probe) { frame.dataset.commandAttempt = JSON.stringify(probe); return; }
      const expected = pending.current;
      if (!expected || expected.source !== event.source) return;
      const matches = (data: {revision: number; frameGeneration: number; scenarioId: string; applicationId: string}) =>
        data.revision === expected.revision && data.frameGeneration === expected.generation
        && data.scenarioId === expected.scenario && data.applicationId === expected.applicationId;
      if (gallery && isThemeFailure(event.data) && matches(event.data)) {
        stopTimer(); pending.current = null; setApplicationState("failed");
        setFailure("Preview rejected this application. The last confirmed revision has not advanced."); return;
      }
      const ack = gallery ? (isThemeAppliedBridgeAck(event.data) && matches(event.data) ? event.data : null)
        : (isLegacyThemeAck(event.data) && event.data.revision === expected.revision ? event.data : null);
      if (!ack) return;
      stopTimer(); pending.current = null; setAppliedRevision(ack.revision); setApplicationState("applied"); setFailure(null);
      lastGoodView.current = view;
      if (ack.computedAccent !== undefined) frame.dataset.computedAccent = ack.computedAccent;
      if (ack.renderedLinkColor !== undefined) frame.dataset.renderedLinkColor = ack.renderedLinkColor;
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [gallery, view]);

  const reloadFrame = () => { stopTimer(); pending.current = null; setLoadedKey(""); setAppliedRevision(0); setApplicationState("pending"); setReload(value => value + 1); };
  const confirmed = applicationState === "applied" && loadedKey === key && appliedRevision === revision && preflight.valid;
  const status = !preflight.valid ? "Preview application failure; last-good preview retained"
    : applicationState === "failed" ? "Preview application failure"
    : !confirmed ? "Preview application pending"
    : isLastGood ? "Last-good preview from an older revision"
    : gallery && navigated ? "Navigated fixture: structural coverage unconfirmed"
    : gallery ? (view.exactAxis ? `Exact preview of subset: ${view.represented.join(", ")}` : "Structural value not represented in this view")
    : "Exact current CSS preview";
  return <div className="preview-container">
    <div className="preview-toolbar">
      <div className="preview-toolbar-group">
        <span className="preview-badge">{gallery ? "Structural Starlight Gallery" : "Live Starlight Fixture"}</span>
        <span role="status" className="preview-status">{status}</span>
        <span className="preview-meta">Rev: {loadedKey === key ? appliedRevision : 0}</span>
        {isLastGood ? <span className="preview-badge warning">(Previewing last valid theme)</span> : null}
      </div>
      <div className="preview-toolbar-group">
        <div className="segmented-control" role="group" aria-label="Theme mode switcher">
          {(["dark", "light"] as const).map(value => <button key={value} type="button" className={mode === value ? "active" : ""} aria-pressed={mode === value} onClick={() => onModeChange?.(value)}>{value === "dark" ? "Dark" : "Light"}</button>)}
        </div>
        <div className="segmented-control" role="group" aria-label="Viewport size switcher">
          {(["desktop", "mobile"] as const).map(value => <button key={value} type="button" className={viewport === value ? "active" : ""} aria-pressed={viewport === value} onClick={() => setViewport(value)}>{value === "desktop" ? "Desktop" : "Mobile (390px)"}</button>)}
        </div>
        <button type="button" className="refresh-button" disabled={!preflight.valid} onClick={reloadFrame}>Reload</button>
      </div>
    </div>
    {failure || preflight.error ? <p role="alert">{preflight.error ?? failure}</p> : null}
    {gallery ? <div className="preview-gallery-controls">
      <label>Structural axis <select aria-label="Structural axis" value={axis} onChange={event => {
        if (GALLERY_AXES.includes(event.target.value as GalleryAxis)) { setAxis(event.target.value as GalleryAxis); setManual(null); }
      }}>{GALLERY_AXES.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      {axis === "heroLayout" ? <label>Hero route <select aria-label="Hero route" value={heroIndex} onChange={event => { setHeroIndex(Number(event.target.value)); setManual(null); }}>
        {sourceSpec?.catalog?.hero.routes.map((route, index) => <option key={index} value={index}>{route.route}: {route.layout}</option>)}
      </select></label> : null}
      <label>Gallery scenario <select aria-label="Gallery scenario" value={view.scenarioId} onChange={event => {
        if (GALLERY_SCENARIO_IDS.includes(event.target.value as GalleryScenarioId)) setManual(event.target.value as GalleryScenarioId);
      }}>{GALLERY_SCENARIO_IDS.map(id => <option key={id} value={id}>{GALLERY_SCENARIOS[id].name}</option>)}</select></label>
      {manual ? <button type="button" onClick={() => setManual(null)}>Sync to Draft</button> : null}
      <p>{GALLERY_SCENARIOS[view.scenarioId].description}</p>
      <p>{navigated ? "Navigation changed the view; the following configured coverage is unconfirmed. " : ""}Represented structural subset: {view.represented.join(", ") || "none"}. Not represented in this view: {view.unrepresented.join(", ") || "none of the listed axes"}.</p>
      <p>{view.exactAxis ? `Selected ${axis}: ${String(view.value)}.` : `Selected ${axis} is not represented.`} Fixed fixture content is shown; this is not a whole-draft preview.</p>
      <p role="note">{SYNTAX_PREVIEW_NOTICE}</p>
      <p role="note">Not structurally previewable: {view.notices.join("; ")}. Layout widths, palette and system font variables use the acknowledged compiled CSS; older revisions retain their older CSS values.</p>
    </div> : null}
    <div className={`preview-frame-wrapper ${viewport}`}>
      <iframe key={key} ref={frameRef} src={gallery ? view.entryPath : "/preview/index.html"} title="Starlight Theme Preview"
        className="preview-iframe" sandbox="allow-scripts" style={viewport === "mobile" ? { width: 390, maxWidth: "100%" } : undefined}
        onLoad={() => { stopTimer(); pending.current = null; setAppliedRevision(0); setApplicationState("pending"); setNavigated(loadedKey === key); generation.current++; setLoadedKey(key); setLoadSerial(value => value + 1); }} />
    </div>
  </div>;
}
