import { useEffect, useReducer, useRef, useState } from "react";
import type { StudioBrandPlanClient } from "../../brand-plans/StudioBrandPlanClient";
import type { BrandDerivePlanSummary, BrandQaBaselinePlanSummary, BrandRasterExportPlanSummary, ConsumerPlanSummary, StudioBrandPlanStartRequest } from "../../brand-plans/contracts";
import type { StudioHostStatus, StudioProjectOpen, StudioSourceOpen } from "../../protocol/contracts";
import type { SelectedEvidence, ViewData, WorkbenchView } from "../brand-workbench/workbench-state";
import { ConsumerPlanForm } from "./ConsumerPlanForm";
import { ConsumerPlanReview } from "./ConsumerPlanReview";
import { DerivePlanForm } from "./DerivePlanForm";
import { DerivePlanReview } from "./DerivePlanReview";
import { ExportPlanForm } from "./ExportPlanForm";
import { ExportPlanReview } from "./ExportPlanReview";
import { PlanConfirmation } from "./PlanConfirmation";
import { PlanProgress } from "./PlanProgress";
import { QaBaselinePlanReview } from "./QaBaselinePlanReview";
import { initialPlanState, planReducer } from "./plan-state";
import { classifyPlanEffect } from "./plan-effect";
import type { Proposal } from "../../design-evidence/types";

export function publicPlanFailure(error: unknown): { readonly state: "ready" | "stale" | "cancelled" | "failed" | "indeterminate"; readonly message: string } {
  const reason = typeof error === "object" && error !== null && "reasonCode" in error ? String((error as { reasonCode: unknown }).reasonCode) : "";
  const mapped: Record<string, string> = {
    "capability-unavailable": "The selected plan capability is unavailable.", "request-busy": "Another plan operation is active.", cancelled: "The operation was cancelled.", "plan-invalid": "The retained plan is no longer valid.", stale: "The retained plan is stale and was retired.", "digest-mismatch": "The reviewed digest did not match; the ready plan was preserved.", "context-invalid": "The project or source context is invalid.", "context-stale": "The project or source context changed.", "domain-failed": "TFSB rejected the domain operation.", "result-too-large": "The typed plan result exceeded the bounded result limit.", "plan-active": "Discard or apply the pending plan before creating another.", "plan-expired": "The retained plan expired.", "request-timeout": "The bounded plan operation timed out.",
  };
  if (reason === "cancelled") return { state: "cancelled", message: mapped[reason]! };
  if (reason === "digest-mismatch") return { state: "ready", message: mapped[reason]! };
  if (["stale", "context-stale", "plan-expired"].includes(reason)) return { state: "stale", message: mapped[reason]! };
  return { state: "failed", message: mapped[reason] ?? "The typed plan operation failed without exposing private sidecar details." };
}

export function PlanWorkspace({ client, host, project, view, data, selection, sources, selectedSourceHandles, onSourceSelection, proposalDraft, identity, onReconcile }: { readonly client: StudioBrandPlanClient | undefined; readonly host: StudioHostStatus; readonly project: StudioProjectOpen; readonly view: WorkbenchView; readonly data: ViewData; readonly selection: SelectedEvidence; readonly sources: readonly StudioSourceOpen[]; readonly selectedSourceHandles: readonly string[]; readonly onSourceSelection: (handles: readonly string[]) => void; readonly proposalDraft?: Proposal | undefined; readonly identity: string; readonly onReconcile: (method: string, indeterminate: boolean) => Promise<boolean> }) {
  const [state, dispatch] = useReducer(planReducer, initialPlanState); const [now, setNow] = useState(Date.now()); const uiGeneration = useRef(0); const actionInFlight = useRef(false);
  const stateRef = useRef(state); stateRef.current = state;
  const abandon = () => {
    const current = stateRef.current;
    if (!client) return;
    if (current.operationHandle && ["planning", "applying", "discarding", "cancellation-requested"].includes(current.state)) void client.cancelPlanOperation(current.operationHandle).catch(() => undefined);
    else if (current.plan) void client.startPlanOperation({ kind: "discard", planHandle: current.plan.planHandle }, () => undefined).catch(() => undefined);
  };
  useEffect(() => { abandon(); actionInFlight.current = false; uiGeneration.current += 1; dispatch({ type: "reset", announcement: "Plan authority cleared because the host or project/source identity changed." }); }, [identity]);
  useEffect(() => () => abandon(), []);
  useEffect(() => { if (state.state !== "ready") return undefined; const timer = window.setInterval(() => { const next = Date.now(); setNow(next); if (state.expiresAt !== undefined && next >= state.expiresAt) dispatch({ type: "expire" }); }, 1_000); return () => window.clearInterval(timer); }, [state.state, state.expiresAt]);
  const disabled = !client || state.state !== "idle" && !["applied", "discarded", "expired", "stale", "cancelled", "failed", "indeterminate"].includes(state.state);
  const operate = async (request: StudioBrandPlanStartRequest, lane: "planning" | "applying" | "discarding") => {
    if (!client || actionInFlight.current) return; actionInFlight.current = true; const generation = ++uiGeneration.current; dispatch({ type: "begin", state: lane });
    try {
      const result = await client.startPlanOperation(request, (event) => { if (generation === uiGeneration.current) dispatch({ type: "event", event }); });
      if (generation !== uiGeneration.current) return;
      if (result.kind === "ready") { dispatch({ type: "ready", plan: result, now: Date.now() }); return; }
      if (result.kind === "discarded") { dispatch({ type: "terminal", state: "discarded", announcement: "The plan was discarded." }); return; }
      const refresh = await onReconcile(result.method, result.kind === "indeterminate"); if (generation !== uiGeneration.current) return;
      if (result.kind === "indeterminate") dispatch({ type: "terminal", state: "indeterminate", announcement: "The apply outcome is indeterminate. Canonical reads were refreshed; inspect them before planning again." });
      else dispatch({ type: "terminal", state: "applied", announcement: refresh ? "The exact plan was applied and canonical reads refreshed." : "The exact plan was applied, but the canonical read refresh failed. Mutation was not rolled back." });
    } catch (error) { if (generation !== uiGeneration.current) return; const failure = publicPlanFailure(error); if (failure.state === "ready") dispatch({ type: "preserve", announcement: failure.message }); else dispatch({ type: "terminal", state: failure.state, announcement: failure.message }); }
    finally { if (generation === uiGeneration.current) actionInFlight.current = false; }
  };
  const cancel = async () => { if (!client || !state.operationHandle) return; try { const result = await client.cancelPlanOperation(state.operationHandle); if (!result.accepted) dispatch({ type: "terminal", state: "failed", announcement: "The operation was already complete or did not belong to this session." }); } catch (error) { const failure = publicPlanFailure(error); if (failure.state === "ready") dispatch({ type: "preserve", announcement: failure.message }); else dispatch({ type: "terminal", state: failure.state, announcement: failure.message }); } };
  const plan = state.plan; const remaining = state.expiresAt === undefined ? 0 : Math.max(0, state.expiresAt - now);
  const projectEvidence = project.name ?? (project.canonicalDigest ? `${project.canonicalDigest.slice(0, 15)}…` : "Selected project");
  const planSources = !plan ? [] : sources.filter((source) => plan.sourceHandles.includes(source.sourceHandle));
  const sourceEvidence = planSources.length ? planSources.map((source) => `${source.packageId ?? "brand source"}${source.brandVersion ? ` ${source.brandVersion}` : ""}`).join(", ") : plan?.sourceHandles.length ? `${plan.sourceHandles.length} selected brand source${plan.sourceHandles.length === 1 ? "" : "s"}` : "none";
  const qaSelection = proposalDraft?.kind === "qa-baseline" ? proposalDraft : selection.kind === "qa-baseline-case" ? selection : undefined;
  const form = data.view === "recipes" ? <DerivePlanForm projectHandle={project.projectHandle} graph={data.graph} disabled={disabled} prefill={proposalDraft?.kind === "derive" ? proposalDraft : undefined} onCreate={(request) => void operate(request, "planning")} />
    : data.view === "qa" ? <fieldset disabled={disabled || !host.raster.available || !qaSelection}><legend>Create a typed QA baseline plan</legend><p>{host.raster.available ? qaSelection ? `Selected ${qaSelection.profileId}/${qaSelection.caseId}` : "Select one exact validated baseline case above." : "The qualified raster capability is unavailable."}</p><button type="button" onClick={() => { if (qaSelection) void operate({ kind: "create-qa-baseline", projectHandle: project.projectHandle, profileId: qaSelection.profileId, caseId: qaSelection.caseId }, "planning"); }}>Review QA baseline plan</button></fieldset>
    : data.view === "consumer" ? <ConsumerPlanForm projectHandle={project.projectHandle} profiles={data.profiles} sources={sources} selectedSourceHandles={selectedSourceHandles} disabled={disabled} prefill={proposalDraft?.kind === "consumer-install" || proposalDraft?.kind === "consumer-sync" ? proposalDraft : undefined} onSourceSelection={onSourceSelection} onCreate={(request) => void operate(request, "planning")} />
    : data.view === "export" ? <ExportPlanForm projectHandle={project.projectHandle} status={data.status} available={host.raster.available && data.capability.available} disabled={disabled} prefill={proposalDraft?.kind === "export" ? proposalDraft : undefined} onCreate={(request) => void operate(request, "planning")} /> : null;
  const review = !plan ? null : plan.method === "brand.derive.plan" ? <DerivePlanReview summary={plan.summary as BrandDerivePlanSummary} /> : plan.method === "brand.qa.baseline.plan" ? <QaBaselinePlanReview summary={plan.summary as BrandQaBaselinePlanSummary} /> : plan.method === "brand.export.plan" ? <ExportPlanReview summary={plan.summary as BrandRasterExportPlanSummary} /> : <ConsumerPlanReview summary={plan.summary as ConsumerPlanSummary} />;
  return <section className="plan-workspace" aria-labelledby="plan-workspace-heading"><h3 id="plan-workspace-heading">Human-controlled plan workflow</h3><p>Plan creation is non-mutating. TFSB alone creates and applies the semantic plan.</p>{form}<PlanProgress state={state} onCancel={() => void cancel()} />{plan ? <article className="plan-review"><header><h4>Ready plan: {plan.method}</h4><p>Complete plan digest: <code>{plan.planDigest}</code></p><p>Time remaining: {Math.ceil(remaining / 1000)} seconds</p><p>Project: {projectEvidence}; sources: {sourceEvidence}</p></header>{review}<PlanConfirmation acknowledged={state.acknowledged} effect={classifyPlanEffect(plan.method, plan.summary)} disabled={state.state !== "ready"} onAcknowledge={(checked) => dispatch({ type: "acknowledge", checked })} onApply={() => void operate({ kind: "apply", planHandle: plan.planHandle, expectedPlanDigest: plan.planDigest }, "applying")} onDiscard={() => void operate({ kind: "discard", planHandle: plan.planHandle }, "discarding")} /></article> : null}<p role="status" aria-live="polite">{state.announcement ?? ""}</p></section>;
}
