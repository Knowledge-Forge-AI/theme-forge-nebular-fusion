import type { PlanWorkspaceState } from "./plan-state";

export function PlanProgress({ state, onCancel }: { readonly state: PlanWorkspaceState; readonly onCancel: () => void }) {
  if (!["planning", "applying", "discarding", "cancellation-requested"].includes(state.state)) return null;
  const progress = state.event?.progress;
  return <section className="plan-progress" role="status" aria-live="polite" aria-atomic="true" aria-label="Plan operation progress"><strong>{state.state === "cancellation-requested" ? "Cancellation requested" : `${state.state[0]!.toUpperCase()}${state.state.slice(1)}`}</strong>{progress ? <span> · {progress.stage} · {progress.completed}{progress.total === undefined ? "" : ` of ${progress.total}`}</span> : null}<button type="button" disabled={!state.operationHandle || state.state === "cancellation-requested"} onClick={onCancel}>Cancel operation</button></section>;
}
