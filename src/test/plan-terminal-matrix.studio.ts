import { describe, expect, it } from "vitest";

import type { StudioBrandPlanStartResult } from "../brand-plans/contracts";
import { publicPlanFailure } from "../features/brand-plans/PlanWorkspace";
import { initialPlanState, planReducer } from "../features/brand-plans/plan-state";

const digest: `sha256:${string}` = `sha256:${"a".repeat(64)}`;
const ready: Extract<StudioBrandPlanStartResult, { readonly kind: "ready" }> = {
  kind: "ready", planHandle: `plan_${"b".repeat(64)}`, planDigest: digest,
  method: "brand.derive.plan", expiresInMs: 600000, projectHandle: "project_safe", sourceHandles: [],
  summary: { selectedRecipes: ["recipe-one"], transitiveRecipes: [], affectedTargets: [], createdCount: 0, updatedCount: 0, unchangedCount: 0, operationSummaries: [], targetStates: [], tokenDigest: digest, recipeDigest: digest, brandSystemDigest: digest, warnings: [], dryRun: true },
};

describe("complete plan terminal-state matrix", () => {
  it("executes planning, applying, cancellation-requested, expiry, discard, and reset transitions", () => {
    const planning = planReducer(initialPlanState, { type: "begin", state: "planning" });
    const progressed = planReducer(planning, { type: "event", event: { schemaVersion: 1, sequence: 1, operationHandle: `operation_${"c".repeat(64)}`, state: "progress", progress: { stage: "validate", completed: 0, total: 1 } } });
    expect(progressed.state).toBe("planning");
    const cancellation = planReducer(progressed, { type: "event", event: { schemaVersion: 1, sequence: 2, operationHandle: `operation_${"c".repeat(64)}`, state: "cancellation-requested" } });
    expect(cancellation.state).toBe("cancellation-requested");

    const retained = planReducer(initialPlanState, { type: "ready", plan: ready, now: 1_000 });
    expect(retained.expiresAt).toBe(601_000);
    expect(planReducer(retained, { type: "expire" })).toMatchObject({ state: "expired", plan: undefined, acknowledged: false });
    expect(planReducer(retained, { type: "begin", state: "applying" })).toMatchObject({ state: "applying", acknowledged: false });
    expect(planReducer(retained, { type: "begin", state: "discarding" })).toMatchObject({ state: "discarding", acknowledged: false });
    const reset = planReducer(retained, { type: "reset", announcement: "identity changed" });
    expect(reset).toMatchObject({ state: "idle", announcement: "identity changed" });
    expect("plan" in reset).toBe(false);
  });

  it("executes stale, failed, unavailable, busy, active, cancellation, timeout, and indeterminate public outcomes", () => {
    for (const [reasonCode, state, phrase] of [
      ["context-stale", "stale", "context changed"], ["plan-expired", "stale", "expired"],
      ["cancelled", "cancelled", "cancelled"], ["capability-unavailable", "failed", "unavailable"],
      ["request-busy", "failed", "operation is active"], ["plan-active", "failed", "pending plan"],
      ["request-timeout", "failed", "timed out"], ["domain-failed", "failed", "domain operation"],
    ] as const) {
      const outcome = publicPlanFailure({ reasonCode });
      expect(outcome.state).toBe(state);
      expect(outcome.message).toContain(phrase);
    }
    expect(planReducer(initialPlanState, { type: "terminal", state: "indeterminate", announcement: "inspect" })).toMatchObject({ state: "indeterminate", announcement: "inspect" });
  });

  it("preserves a ready plan after digest mismatch and rejects stale or regressing UI progress", () => {
    const retained = planReducer(initialPlanState, { type: "ready", plan: ready, now: 0 });
    const applying = planReducer(planReducer(retained, { type: "acknowledge", checked: true }), { type: "begin", state: "applying" });
    const preserved = planReducer(applying, { type: "preserve", announcement: publicPlanFailure({ reasonCode: "digest-mismatch" }).message });
    expect(preserved).toMatchObject({ state: "ready", plan: ready, acknowledged: false });

    const first = planReducer(planReducer(initialPlanState, { type: "begin", state: "planning" }), { type: "event", event: { schemaVersion: 1, sequence: 2, operationHandle: `operation_${"c".repeat(64)}`, state: "progress", progress: { stage: "snapshot", completed: 2, total: 3 } } });
    for (const event of [
      { schemaVersion: 1, sequence: 2, operationHandle: `operation_${"c".repeat(64)}`, state: "progress", progress: { stage: "analyze", completed: 3, total: 3 } },
      { schemaVersion: 1, sequence: 3, operationHandle: `operation_${"c".repeat(64)}`, state: "progress", progress: { stage: "validate", completed: 3, total: 3 } },
      { schemaVersion: 1, sequence: 3, operationHandle: `operation_${"c".repeat(64)}`, state: "progress", progress: { stage: "snapshot", completed: 2, total: 3 } },
    ] as const) expect(planReducer(first, { type: "event", event })).toMatchObject({ state: "failed", announcement: "The plan progress sequence was invalid." });
  });
});
