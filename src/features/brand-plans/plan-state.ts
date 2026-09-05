import type { PlanPublicState, StudioBrandPlanStartResult, StudioPlanOperationEvent } from "../../brand-plans/contracts";

export interface PlanWorkspaceState {
  readonly state: PlanPublicState;
  readonly generation: number;
  readonly operationHandle?: string | undefined;
  readonly lastSequence: number;
  readonly event?: StudioPlanOperationEvent | undefined;
  readonly plan?: Extract<StudioBrandPlanStartResult, { readonly kind: "ready" }> | undefined;
  readonly acknowledged: boolean;
  readonly expiresAt?: number | undefined;
  readonly announcement?: string | undefined;
}

export const initialPlanState: PlanWorkspaceState = { state: "idle", generation: 0, lastSequence: 0, acknowledged: false };

const planning = ["validate", "snapshot", "analyze", "plan", "ready"] as const;
const applying = ["revalidate", "waiting-lock", "staging", "promoting", "cleanup", "complete"] as const;

export type PlanAction =
  | { readonly type: "begin"; readonly state: "planning" | "applying" | "discarding" }
  | { readonly type: "event"; readonly event: StudioPlanOperationEvent }
  | { readonly type: "ready"; readonly plan: Extract<StudioBrandPlanStartResult, { readonly kind: "ready" }>; readonly now: number }
  | { readonly type: "acknowledge"; readonly checked: boolean }
  | { readonly type: "preserve"; readonly announcement: string }
  | { readonly type: "terminal"; readonly state: Exclude<PlanPublicState, "idle" | "planning" | "ready" | "applying" | "discarding" | "cancellation-requested">; readonly announcement: string }
  | { readonly type: "expire" }
  | { readonly type: "reset"; readonly announcement?: string };

export function planReducer(state: PlanWorkspaceState, action: PlanAction): PlanWorkspaceState {
  if (action.type === "begin") return { ...state, state: action.state, generation: state.generation + 1, operationHandle: undefined, lastSequence: 0, event: undefined, acknowledged: false, announcement: undefined };
  if (action.type === "event") {
    const previous = state.event?.progress; const next = action.event.progress; const stages = state.state === "applying" || state.state === "cancellation-requested" && previous && applying.includes(previous.stage as never) ? applying : planning;
    const invalidProgress = next && (!stages.includes(next.stage as never) || previous && (stages.indexOf(next.stage as never) < stages.indexOf(previous.stage as never) || next.stage === previous.stage && (next.completed <= previous.completed || next.total !== previous.total)));
    if (action.event.sequence <= state.lastSequence || (state.operationHandle && state.operationHandle !== action.event.operationHandle) || invalidProgress) return { ...state, state: "failed", acknowledged: false, announcement: "The plan progress sequence was invalid." };
    return { ...state, state: action.event.state === "cancellation-requested" ? "cancellation-requested" : state.state, operationHandle: action.event.operationHandle, lastSequence: action.event.sequence, event: action.event };
  }
  if (action.type === "ready") return { ...state, state: "ready", plan: action.plan, acknowledged: false, expiresAt: action.now + action.plan.expiresInMs, announcement: "Plan ready for review." };
  if (action.type === "acknowledge") return state.state === "ready" ? { ...state, acknowledged: action.checked } : state;
  if (action.type === "preserve") return state.plan ? { ...state, state: "ready", acknowledged: false, operationHandle: undefined, event: undefined, announcement: action.announcement } : { ...state, state: "failed", acknowledged: false, announcement: "No reviewed plan remained to preserve." };
  if (action.type === "terminal") return { ...state, state: action.state, plan: undefined, acknowledged: false, expiresAt: undefined, operationHandle: undefined, announcement: action.announcement };
  if (action.type === "expire") return state.state === "ready" ? { ...state, state: "expired", plan: undefined, acknowledged: false, expiresAt: undefined, announcement: "The plan expired and can no longer be applied." } : state;
  return { ...initialPlanState, generation: state.generation + 1, announcement: action.announcement };
}
