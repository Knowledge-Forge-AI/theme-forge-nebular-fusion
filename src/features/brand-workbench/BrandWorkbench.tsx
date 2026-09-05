import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  StudioBrandReadClient,
  VisualEvidence,
  VisualEvidenceRequest,
} from "../../brand-read/StudioBrandReadClient";
import type { StudioBrandPlanClient } from "../../brand-plans/StudioBrandPlanClient";
import { VisualBlobUrlSet } from "../../brand-read/blob-manager";
import type { StudioHostStatus, StudioProjectOpen, StudioSourceOpen } from "../../protocol/contracts";
import type { Proposal } from "../../design-evidence/types";
import { ConsumerView } from "./ConsumerView";
import { ExportView } from "./ExportView";
import { FamiliesView } from "./FamiliesView";
import { OverviewView } from "./OverviewView";
import { QaView } from "./QaView";
import { RecipesView } from "./RecipesView";
import { SemanticDiffView } from "./SemanticDiffView";
import { TokensView } from "./TokensView";
import { VisualEvidencePanel } from "./VisualEvidencePanel";
import { PlanWorkspace } from "../brand-plans/PlanWorkspace";
import {
  initialWorkbenchState,
  workbenchReducer,
  type SelectedEvidence,
  type ViewData,
  type WorkbenchView,
} from "./workbench-state";

const views: readonly { readonly id: WorkbenchView; readonly label: string; readonly description: string }[] = [
  { id: "overview", label: "Overview", description: "Brand presence, domains, completeness, and capability summary." },
  { id: "families", label: "Families", description: "Families, roles, variants, requirements, and exact bindings." },
  { id: "tokens", label: "Tokens", description: "Typed tokens, references, recipe use, and unused warnings." },
  { id: "recipes", label: "Recipes", description: "Deterministic recipe dependencies and target state." },
  { id: "qa", label: "QA", description: "Profiles, cases, current canonical result, and bounded baseline evidence." },
  { id: "semantic-diff", label: "Semantic diff", description: "The ten typed source/project comparison sections." },
  { id: "consumer", label: "Consumer", description: "Profile inventory, compatibility, composition, and lock status." },
  { id: "export", label: "Export", description: "Fixed raster capability and existing export output status." },
] as const;

interface VisualView { readonly evidence: VisualEvidence; readonly urls: readonly string[] }
interface LoadedView { readonly data: ViewData; readonly nextCursor: string | null }

function publicError(error: unknown): { readonly message: string; readonly stale: boolean } {
  const code = typeof error === "object" && error !== null && "reasonCode" in error ? String((error as { reasonCode: unknown }).reasonCode) : "";
  if (code === "cursor-stale") return { message: "The page changed and was restarted from its first cursor.", stale: true };
  if (code === "capability-unavailable") return { message: "Rendered visual evidence is unavailable; semantic evidence remains available.", stale: false };
  if (code === "domain-unavailable") return { message: "This brand domain is unavailable or invalid.", stale: false };
  if (code === "request-busy") return { message: "The bounded read lane is busy. Try again shortly.", stale: false };
  if (code === "request-timeout") return { message: "The bounded read timed out.", stale: false };
  return { message: "This live read could not be completed.", stale: false };
}

async function loadView(client: StudioBrandReadClient, view: WorkbenchView, project: StudioProjectOpen, source: StudioSourceOpen | undefined, consumerSources: readonly StudioSourceOpen[], cursor: string | undefined): Promise<LoadedView> {
  const handle = project.projectHandle;
  if (view === "overview") return { data: { view, status: await client.getBrandStatus(handle) }, nextCursor: null };
  if (view === "families") { const families = await client.listFamilies(handle, 64, cursor); return { data: { view, families }, nextCursor: families.page.nextCursor }; }
  if (view === "tokens") { const tokens = await client.listTokens(handle, 64, cursor); return { data: { view, tokens }, nextCursor: tokens.page.nextCursor }; }
  if (view === "recipes") return { data: { view, graph: await client.getRecipeGraph(handle) }, nextCursor: null };
  if (view === "qa") { const profiles = await client.listQaProfiles(handle, 64, cursor); return { data: { view, profiles, selectedProfileId: null, profile: null, result: null }, nextCursor: profiles.page.nextCursor }; }
  if (view === "semantic-diff") {
    if (!source?.sourceHandle) throw new Error("source-required");
    return { data: { view, semanticDiff: await client.getSemanticDiff(handle, source.sourceHandle) }, nextCursor: null };
  }
  if (view === "consumer") {
    const sourceHandles = consumerSources.map((entry) => entry.sourceHandle);
    const [profiles, lock] = await Promise.all([client.listConsumerProfiles(handle, sourceHandles, 64, cursor), client.getConsumerLockStatus(handle)]);
    return { data: { view, profiles, lock }, nextCursor: profiles.page.nextCursor };
  }
  const [capability, status] = await Promise.all([client.getExportCapability(handle), client.listExportStatus(handle, 64, cursor)]);
  return { data: { view, capability, status }, nextCursor: status.page.nextCursor };
}

function requestForSelection(selection: SelectedEvidence, projectHandle: string | undefined, sourceHandle: string | undefined): VisualEvidenceRequest | undefined {
  if (!projectHandle || selection.kind === "none") return undefined;
  if (selection.kind === "qa-baseline-case") return { kind: "qa-baseline", projectHandle, profileId: selection.profileId, caseId: selection.caseId };
  if (selection.kind === "brand-diff-asset" || selection.kind === "brand-diff-binding") {
    if (!sourceHandle) return undefined;
    return { kind: "brand-diff", projectHandle, sourceHandle, target: selection.target, width: selection.width, height: selection.height, background: selection.background };
  }
  return { kind: "project-render", projectHandle, target: selection.target, width: selection.width, height: selection.height, background: selection.background };
}

export function BrandWorkbench({ client, planClient, host, project, source, sources = source ? [source] : [], proposalDraft }: { readonly client: StudioBrandReadClient; readonly planClient?: StudioBrandPlanClient | undefined; readonly host: StudioHostStatus; readonly project: StudioProjectOpen | undefined; readonly source: StudioSourceOpen | undefined; readonly sources?: readonly StudioSourceOpen[]; readonly proposalDraft?: Proposal | undefined }) {
  const [state, dispatch] = useReducer(workbenchReducer, initialWorkbenchState);
  const [visual, setVisual] = useState<VisualView>();
  const [visualLoading, setVisualLoading] = useState(false);
  const [selectedConsumerSources, setSelectedConsumerSources] = useState<readonly string[]>(sources.map((entry) => entry.sourceHandle));
  const blobs = useRef(new VisualBlobUrlSet());
  const loadSeq = useRef(0);
  const visualSeq = useRef(0);
  const current = state.views[state.activeView];
  const active = views.find((view) => view.id === state.activeView) ?? views[0]!;
  const sourceIdentity = sources.map((entry) => entry.sourceHandle).join("|");
  const loadIdentity = `${host.state}|${project?.projectHandle ?? ""}|${source?.sourceHandle ?? ""}|${sourceIdentity}|${selectedConsumerSources.join("|")}|${state.activeView}`;
  const visualIdentity = `${loadIdentity}|${current?.pageNumber ?? 0}|${JSON.stringify(state.selection)}`;
  const loadIdentityRef = useRef(loadIdentity);
  const visualIdentityRef = useRef(visualIdentity);
  loadIdentityRef.current = loadIdentity;
  visualIdentityRef.current = visualIdentity;

  useEffect(() => { dispatch({ type: "host", ready: host.state === "ready" }); }, [host.state]);
  useEffect(() => { dispatch({ type: "project", project }); }, [project?.projectHandle]);
  useEffect(() => { dispatch({ type: "source", source }); }, [source?.sourceHandle]);
  useEffect(() => { setSelectedConsumerSources((current) => current.filter((handle) => sources.some((entry) => entry.sourceHandle === handle)).slice(0, 8)); }, [sourceIdentity]);
  useEffect(() => {
    visualSeq.current += 1;
    blobs.current.revokeAll();
    setVisual(undefined);
    setVisualLoading(false);
  }, [visualIdentity]);
  useEffect(() => () => blobs.current.revokeAll(), []);

  const runLoad = async (cursorStack: readonly (string | null)[] = [null], pageNumber = 1): Promise<void> => {
    if (!project || host.state !== "ready") return;
    const selectedView = state.activeView;
    const identity = loadIdentity;
    const cursor = cursorStack.at(-1) ?? undefined;
    const seq = ++loadSeq.current;
    dispatch({ type: "loading", view: selectedView });
    try {
      const loaded = await loadView(client, selectedView, project, source, sources.filter((entry) => selectedConsumerSources.includes(entry.sourceHandle)), cursor);
      if (seq !== loadSeq.current || identity !== loadIdentityRef.current) return;
      dispatch({ type: "loaded", view: selectedView, data: loaded.data, nextCursor: loaded.nextCursor, cursorStack, pageNumber });
    } catch (error) {
      if (seq !== loadSeq.current || identity !== loadIdentityRef.current) return;
      if (error instanceof Error && error.message === "source-required") { dispatch({ type: "error", view: selectedView, message: "Select one verified brand source to read semantic diff." }); return; }
      const publicState = publicError(error);
      if (publicState.stale && cursor) {
        dispatch({ type: "announce", message: publicState.message });
        await runLoad([null], 1);
        return;
      }
      dispatch({ type: "error", view: selectedView, message: publicState.message });
    }
  };

  useEffect(() => { if (project && host.state === "ready") void runLoad(); }, [loadIdentity]);

  const selectQaProfile = async (profileId: string | null): Promise<void> => {
    if (!project || !profileId || current?.data?.view !== "qa") {
      if (current?.data?.view === "qa") dispatch({ type: "loaded", view: "qa", data: { ...current.data, selectedProfileId: null, profile: null, result: null }, nextCursor: current.nextCursor, cursorStack: current.cursorStack, pageNumber: current.pageNumber });
      return;
    }
    const identity = loadIdentity;
    const seq = ++loadSeq.current;
    dispatch({ type: "loading", view: "qa" });
    try {
      const [profile, result] = await Promise.all([client.getQaProfile(project.projectHandle, profileId), client.getQaResult(project.projectHandle, profileId)]);
      if (seq !== loadSeq.current || identity !== loadIdentityRef.current) return;
      dispatch({ type: "loaded", view: "qa", data: { ...current.data, selectedProfileId: profileId, profile, result }, nextCursor: current.nextCursor, cursorStack: current.cursorStack, pageNumber: current.pageNumber });
    } catch (error) {
      if (seq === loadSeq.current && identity === loadIdentityRef.current) dispatch({ type: "announce", message: publicError(error).message });
    }
  };

  const visualRequest = useMemo(() => requestForSelection(state.selection, project?.projectHandle, source?.sourceHandle), [state.selection, project?.projectHandle, source?.sourceHandle]);
  const renderVisual = async (): Promise<void> => {
    if (!visualRequest) return;
    const identity = visualIdentity;
    const seq = ++visualSeq.current;
    setVisualLoading(true);
    try {
      const evidence = await client.getVisualEvidence(visualRequest);
      if (seq !== visualSeq.current || identity !== visualIdentityRef.current) return;
      blobs.current.revokeAll();
      const urls: string[] = [];
      try { for (const artifact of evidence.artifacts) urls.push(await blobs.current.create(artifact)); }
      catch (error) { blobs.current.revokeAll(); throw error; }
      if (seq !== visualSeq.current || identity !== visualIdentityRef.current) { for (const url of urls) blobs.current.revoke(url); return; }
      setVisual({ evidence, urls });
    } catch (error) {
      if (seq === visualSeq.current && identity === visualIdentityRef.current) dispatch({ type: "announce", message: publicError(error).message });
    } finally {
      if (seq === visualSeq.current && identity === visualIdentityRef.current) setVisualLoading(false);
    }
  };

  const reconcileAfterApply = async (): Promise<boolean> => {
    visualSeq.current += 1; blobs.current.revokeAll(); setVisual(undefined); setVisualLoading(false); dispatch({ type: "select", selection: { kind: "none" } });
    if (!project) return false;
    try { await client.getBrandStatus(project.projectHandle); await runLoad(current?.cursorStack ?? [null], current?.pageNumber ?? 1); return true; }
    catch { return false; }
  };

  const body = current?.data?.view === "overview" ? <OverviewView status={current.data.status} />
    : current?.data?.view === "families" ? <FamiliesView data={current.data.families} selection={state.selection} onSelect={(selection) => dispatch({ type: "select", selection })} />
    : current?.data?.view === "tokens" ? <TokensView data={current.data.tokens} />
    : current?.data?.view === "recipes" ? <RecipesView graph={current.data.graph} />
    : current?.data?.view === "qa" ? <QaView profiles={current.data.profiles} profile={current.data.profile} result={current.data.result} selection={state.selection} onProfile={(profileId) => void selectQaProfile(profileId)} onSelect={(selection) => dispatch({ type: "select", selection })} />
    : current?.data?.view === "semantic-diff" ? <SemanticDiffView data={current.data.semanticDiff} selection={state.selection} onSelect={(selection) => dispatch({ type: "select", selection })} />
    : current?.data?.view === "consumer" ? <ConsumerView profiles={current.data.profiles} lock={current.data.lock} />
    : current?.data?.view === "export" ? <ExportView capability={current.data.capability} status={current.data.status} selection={state.selection} onSelect={(selection) => dispatch({ type: "select", selection })} />
    : null;
  const paginated = current?.data?.view === "families" || current?.data?.view === "tokens" || current?.data?.view === "qa" || current?.data?.view === "consumer" || current?.data?.view === "export";

  return <section className="workbench-section" aria-labelledby="workbench-title">
    <div className="section-heading"><div><p className="section-kicker">Live typed project evidence and plans</p><h2 id="workbench-title">Brand workbench</h2></div><p>Every read and plan uses a fixed typed sidecar operation. Mutation requires review of one retained plan and explicit confirmation.</p></div>
    <nav className="workbench-nav" aria-label="Brand workbench views">{views.map((view) => <button key={view.id} type="button" aria-current={state.activeView === view.id ? "page" : undefined} onClick={() => dispatch({ type: "view", view: view.id })}>{view.label}</button>)}</nav>
    <article className="panel read-panel" aria-labelledby={`view-${active.id}`}>
      <header><h3 id={`view-${active.id}`}>{active.label}</h3><p>{active.description}</p></header>
      {!state.hostReady ? <p className="empty-state">Start the verified sidecar to enable live reads.</p> : !project ? <p className="empty-state">Choose an existing project to enable this view.</p> : null}
      {current?.loading ? <p role="status" aria-live="polite">Loading {active.label.toLowerCase()}…</p> : null}
      {current?.error ? <p role="alert">{current.error}</p> : null}
      <p className="sr-only" role="status" aria-live="polite">{state.announcement ?? ""}</p>
      {body}
      {project && current?.data && (["recipes", "qa", "consumer", "export"] as const).includes(current.data.view as "recipes" | "qa" | "consumer" | "export") ? <PlanWorkspace client={planClient} host={host} project={project} view={state.activeView} data={current.data} selection={state.selection} sources={sources} selectedSourceHandles={selectedConsumerSources} onSourceSelection={setSelectedConsumerSources} proposalDraft={proposalDraft} identity={`${host.state}|${host.selectedProtocolVersion ?? ""}|${host.raster.qualificationIdentity ?? ""}|${project.projectHandle}|${sourceIdentity}|${selectedConsumerSources.join("|")}`} onReconcile={async (_method, _indeterminate) => reconcileAfterApply()} /> : null}
      <div className="read-actions">
        <button type="button" disabled={!project || current?.loading} onClick={() => void runLoad(current?.cursorStack ?? [null], current?.pageNumber ?? 1)}>Refresh {active.label}</button>
        {paginated && current ? <><span className="page-position">Page {current.pageNumber} · deterministic cursor</span><button type="button" disabled={current.pageNumber <= 1 || current.loading} onClick={() => void runLoad(current.cursorStack.slice(0, -1), current.pageNumber - 1)}>Previous page</button><button type="button" disabled={!current.nextCursor || current.loading} onClick={() => void runLoad([...current.cursorStack, current.nextCursor], current.pageNumber + 1)}>Next page</button></> : null}
      </div>
      <VisualEvidencePanel selection={state.selection} evidence={visual?.evidence} urls={visual?.urls ?? []} available={host.raster.available} loading={visualLoading} onRender={() => void renderVisual()} />
    </article>
  </section>;
}
