import { useEffect, useMemo, useState } from "react";
import type { StudioBrandReadClient } from "../brand-read/StudioBrandReadClient";
import type { StudioBrandPlanClient } from "../brand-plans/StudioBrandPlanClient";
import { TauriStudioBrandReadClient } from "../brand-read/tauri-brand-read-client";
import type { Proposal } from "../design-evidence/types";
import { DesignExchange } from "../features/design-exchange/DesignExchange";
import { BrandWorkbench } from "../features/brand-workbench/BrandWorkbench";
import { Diagnostics } from "../features/diagnostics/Diagnostics";
import { ThemeLab } from "../features/theme-lab/ThemeLab";
import { TauriThemeLabBridge } from "../features/theme-lab/theme-lab-bridge";
import type { ThemeLabBridge } from "../features/theme-lab/types";
import type { StudioHostBridge, StudioHostStateEvent, StudioHostStatus, StudioProjectOpen, StudioSourceOpen } from "../protocol/contracts";

export function App({
  hostBridge,
  brandReadClient,
  themeLabBridge,
}: {
  readonly hostBridge: StudioHostBridge;
  readonly brandReadClient?: StudioBrandReadClient;
  readonly themeLabBridge?: ThemeLabBridge;
}) {
  const [activeDestination, setActiveDestination] = useState<"workbench" | "theme-lab">("workbench");
  const [status, setStatus] = useState<StudioHostStatus>();
  const [event, setEvent] = useState<StudioHostStateEvent>();
  const [proposalDraft, setProposalDraft] = useState<Proposal>();
  const [hostError, setHostError] = useState<string>();
  const [selectionStatus, setSelectionStatus] = useState("No project or source selected.");
  const [project, setProject] = useState<StudioProjectOpen>();
  const [source, setSource] = useState<StudioSourceOpen>();
  const [sources, setSources] = useState<readonly StudioSourceOpen[]>([]);
  const readClient = useMemo(() => brandReadClient ?? new TauriStudioBrandReadClient(), [brandReadClient]);
  const effectiveThemeLabBridge = useMemo(() => themeLabBridge ?? new TauriThemeLabBridge(), [themeLabBridge]);
  const planClient = useMemo<StudioBrandPlanClient | undefined>(() => hostBridge.startPlanOperation && hostBridge.cancelPlanOperation ? { startPlanOperation: hostBridge.startPlanOperation.bind(hostBridge), cancelPlanOperation: hostBridge.cancelPlanOperation.bind(hostBridge) } : undefined, [hostBridge]);

  useEffect(() => {
    let active = true;
    void hostBridge.getStatus().then((next) => { if (active) setStatus(next); }, () => { if (active) setHostError("The Studio host status is unavailable."); });
    return () => { active = false; hostBridge.close(); };
  }, [hostBridge]);

  useEffect(() => {
    if (status?.state !== "ready") return undefined;
    let active = true;
    const poll = window.setInterval(() => {
      void hostBridge.getStatus().then((next) => { if (active) setStatus(next); }, () => undefined);
    }, 1_000);
    return () => { active = false; window.clearInterval(poll); };
  }, [hostBridge, status?.state]);

  const run = async (operation: () => Promise<void>) => {
    setHostError(undefined);
    try { await operation(); }
    catch { setHostError("The bounded Studio host operation failed. No fixture fallback was used."); }
  };

  const start = () => run(async () => setStatus(await hostBridge.startHost((next) => { setEvent(next); void hostBridge.getStatus().then(setStatus, () => undefined); })));
  const stop = () => run(async () => { await hostBridge.shutdownHost(); setProject(undefined); setSource(undefined); setSources([]); setProposalDraft(undefined); setStatus(await hostBridge.getStatus()); });
  const selectProject = () => run(async () => {
    const result = await hostBridge.selectProject("existing");
    if (!result.cancelled) { setProject(result.project); setSource(undefined); setSources([]); setProposalDraft(undefined); }
    setSelectionStatus(result.cancelled ? "Project selection cancelled." : `Project opened: ${result.project.name ?? "unnamed project"}.`);
    setStatus(await hostBridge.getStatus());
  });
  const selectSource = (kind: "brand-bundle" | "npm-installed-package") => run(async () => {
    const result = await hostBridge.selectSource(kind);
    if (!result.cancelled) {
      const duplicate = sources.some((entry) => entry.sourceHandle === result.source.sourceHandle || (entry.packageId && entry.packageId === result.source.packageId));
      if (!duplicate && sources.length < 8) { setSources((current) => [...current, result.source]); setSource(result.source); setSelectionStatus(`Source opened: ${result.source.packageId ?? result.source.authorityKind ?? "content source"}.`); }
      else setSelectionStatus(duplicate ? "That verified package identity is already open." : "Studio v0.1 retains at most eight verified brand sources.");
    }
    else setSelectionStatus("Source selection cancelled.");
    setStatus(await hostBridge.getStatus());
  });

  return (
    <div className="studio-shell">
      <header className="studio-header">
        <p className="eyebrow">Human-first · evidence-bound · typed plan workbench</p>
        <h1>Theme Forge Nebular Fusion</h1>
        <p>Supervise the verified local TFSB service while TFSB remains the semantic authority.</p>
        <nav className="destination-nav" aria-label="Workbench destinations">
          <button
            type="button"
            className={activeDestination === "workbench" ? "destination-tab active" : "destination-tab"}
            onClick={() => setActiveDestination("workbench")}
            aria-pressed={activeDestination === "workbench"}
          >
            Brand Workbench
          </button>
          <button
            type="button"
            className={activeDestination === "theme-lab" ? "destination-tab active" : "destination-tab"}
            onClick={() => setActiveDestination("theme-lab")}
            aria-pressed={activeDestination === "theme-lab"}
          >
            Theme Lab
          </button>
        </nav>
      </header>
      <main id="main-content">
        {activeDestination === "theme-lab" ? (
          <ThemeLab bridge={effectiveThemeLabBridge} />
        ) : (
          <>
            {hostError ? <section className="panel bootstrap-error" role="alert" aria-live="assertive"><h2>Studio host unavailable</h2><p>{hostError}</p></section> : null}
            {status ? <Diagnostics source={hostBridge.source} status={status} event={event} selectionStatus={selectionStatus} onStart={start} onProject={selectProject} onSource={selectSource} onStop={stop} /> : <p role="status">Loading Studio host status…</p>}
            {status ? <BrandWorkbench client={readClient} planClient={planClient} host={status} project={project} source={source} sources={sources} proposalDraft={proposalDraft} /> : null}
            {status ? <DesignExchange host={status} project={project} sources={sources} readClient={readClient} onProposalPrefill={setProposalDraft} /> : null}
          </>
        )}
      </main>
      <footer>Nebular Fusion 0.2.0 · Studio protocol 1.2 live reads and typed plans · explicit human confirmation · no embedded model</footer>
    </div>
  );
}
