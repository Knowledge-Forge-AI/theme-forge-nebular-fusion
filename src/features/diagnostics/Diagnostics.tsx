import type { StudioHostSource, StudioHostStateEvent, StudioHostStatus } from "../../protocol/contracts";

export function Diagnostics({ source, status, event, selectionStatus, onStart, onProject, onSource, onStop }: {
  readonly source: StudioHostSource;
  readonly status: StudioHostStatus;
  readonly event: StudioHostStateEvent | undefined;
  readonly selectionStatus: string;
  readonly onStart: () => void;
  readonly onProject: () => void;
  readonly onSource: (kind: "brand-bundle" | "npm-installed-package") => void;
  readonly onStop: () => void;
}) {
  const transitioning = ["verifying", "starting", "initializing", "stopping"].includes(status.state);
  const ready = status.state === "ready";
  const rows = [
    ["Host source", source === "rust-tauri" ? "Real Rust sidecar host" : "Fixture host bridge (test/development only)"],
    ["Studio version", status.studioVersion], ["Sidecar state", status.state],
    ["Artifact verification", status.manifestDigest ? `verified · ${status.manifestDigest}` : "not verified"],
    ["Selected protocol", status.selectedProtocolVersion ?? "not initialized"], ["Server version", status.serverVersion ?? "unavailable"],
    ["Method summary", status.methods.length ? `${status.methods.length} bounded methods` : "unavailable"],
    ["Raster capability", status.raster.available ? status.raster.qualificationIdentity ?? "available" : "unavailable"],
    ["Open handles", `${status.projectOpenCount} projects · ${status.sourceOpenCount} sources`],
    ["Latest event", event ? `${event.sequence} · ${event.state}${event.reasonCode ? ` · ${event.reasonCode}` : ""}` : "none"],
  ] as const;

  return (
    <section aria-labelledby="diagnostics-heading" className="panel diagnostics-panel">
      <div><p className="section-kicker">Verified local host</p><h2 id="diagnostics-heading">Diagnostics</h2></div>
      <dl className="diagnostic-grid">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <div className="host-controls" aria-label="Studio host controls">
        <button type="button" onClick={onStart} disabled={transitioning}>{ready ? "Restart sidecar" : "Start sidecar"}</button>
        <button type="button" onClick={onProject} disabled={!ready}>Open existing project</button>
        <button type="button" onClick={() => onSource("brand-bundle")} disabled={!ready}>Open brand bundle</button>
        <button type="button" onClick={() => onSource("npm-installed-package")} disabled={!ready}>Open npm-installed package</button>
        <button type="button" onClick={onStop} disabled={!ready}>Stop sidecar</button>
      </div>
      <p role="status" aria-live="polite">{selectionStatus}</p>
      <p><strong>Fixture boundary:</strong> the candidate-review board below remains synthetic and is not driven by the selected project, sources, or plan authority.</p>
    </section>
  );
}
