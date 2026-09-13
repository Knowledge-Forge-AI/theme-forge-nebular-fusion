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

import { VectorGraphicsLab } from "../features/vector-graphics";
import type { VectorGraphicsBridge } from "../features/vector-graphics/types";
import "../features/vector-graphics/styles.css";

export type Destination = "brand-system" | "vector-graphics" | "starlight-theme";


export function App({
  hostBridge,
  brandReadClient,
  themeLabBridge,
  vectorGraphicsBridge,
}: {
  readonly hostBridge: StudioHostBridge;
  readonly brandReadClient?: StudioBrandReadClient;
  readonly themeLabBridge?: ThemeLabBridge;
  readonly vectorGraphicsBridge?: VectorGraphicsBridge;
}) {
  const [activeDestination, setActiveDestination] = useState<Destination>("brand-system");
  const [visitedDestinations, setVisitedDestinations] = useState<ReadonlySet<Destination>>(
    () => new Set<Destination>(["brand-system"]),
  );
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
    return () => {
      active = false;
      hostBridge.close();
      void effectiveThemeLabBridge.dispose?.();
    };
  }, [hostBridge, effectiveThemeLabBridge]);

  const selectDestination = (destination: Destination) => {
    setActiveDestination(destination);
    setVisitedDestinations((current) => {
      if (current.has(destination)) return current;
      const next = new Set(current);
      next.add(destination);
      return next;
    });
  };

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
            className={activeDestination === "brand-system" ? "destination-tab active" : "destination-tab"}
            onClick={() => selectDestination("brand-system")}
            aria-pressed={activeDestination === "brand-system"}
          >
            Brand / System
          </button>
          <button
            type="button"
            className={activeDestination === "vector-graphics" ? "destination-tab active" : "destination-tab"}
            onClick={() => selectDestination("vector-graphics")}
            aria-pressed={activeDestination === "vector-graphics"}
          >
            Vector / Graphics
          </button>
          <button
            type="button"
            className={activeDestination === "starlight-theme" ? "destination-tab active" : "destination-tab"}
            onClick={() => selectDestination("starlight-theme")}
            aria-pressed={activeDestination === "starlight-theme"}
          >
            Starlight Theme
          </button>
        </nav>
      </header>
      <main id="main-content">
        {visitedDestinations.has("brand-system") ? (
          <div
            className="work-area work-area-brand-system"
            data-destination="brand-system"
            hidden={activeDestination !== "brand-system"}
            inert={activeDestination !== "brand-system" ? true : undefined}
          >
            {hostError ? <section className="panel bootstrap-error" role="alert" aria-live="assertive"><h2>Studio host unavailable</h2><p>{hostError}</p></section> : null}
            {status ? <Diagnostics source={hostBridge.source} status={status} event={event} selectionStatus={selectionStatus} onStart={start} onProject={selectProject} onSource={selectSource} onStop={stop} /> : <p role="status">Loading Studio host status…</p>}
            {status ? <BrandWorkbench client={readClient} planClient={planClient} host={status} project={project} source={source} sources={sources} proposalDraft={proposalDraft} /> : null}
            {status ? <DesignExchange host={status} project={project} sources={sources} readClient={readClient} onProposalPrefill={setProposalDraft} /> : null}
          </div>
        ) : null}
        {visitedDestinations.has("vector-graphics") ? (
          <div
            className="work-area work-area-vector-graphics"
            data-destination="vector-graphics"
            hidden={activeDestination !== "vector-graphics"}
            inert={activeDestination !== "vector-graphics" ? true : undefined}
          >
            <h2>Vector / Graphics</h2>
            <VectorGraphicsLab bridge={vectorGraphicsBridge} projectHandle={project?.projectHandle} />
          </div>
        ) : null}
        {visitedDestinations.has("starlight-theme") ? (
          <div
            className="work-area work-area-starlight-theme"
            data-destination="starlight-theme"
            hidden={activeDestination !== "starlight-theme"}
            inert={activeDestination !== "starlight-theme" ? true : undefined}
          >
            <ThemeLab bridge={effectiveThemeLabBridge} managed />
          </div>
        ) : null}
      </main>
      <footer>Nebular Fusion 0.2.0 · Studio protocol 1.2 live reads and typed plans · explicit human confirmation · no embedded model</footer>
    </div>
  );
}
