import "../features/vector-graphics/test/stale-and-queue.test";
import "../features/vector-graphics/test/bridge.test";
import "../features/vector-graphics/test/workbench.test";
import "../features/vector-graphics/test/blob-lifetime.test";

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { VectorGraphicsLab } from "../features/vector-graphics/components/VectorGraphicsLab";
import { MockVectorGraphicsBridge } from "../features/vector-graphics/mock-bridge";
import type {
  SceneApplyRequest,
  SceneExportPlanRequest,
  ScenePlanResponse,
  ScenePublicationResponse,
  SceneSavePlanRequest,
} from "../features/vector-graphics/types";

// Apply-error injection models post-consumption failure only; pre-take native
// failures may retain a backend plan after the UI discards its handle.
class PublicationTestBridge extends MockVectorGraphicsBridge {
  saveApplyError: unknown = null;
  exportApplyError: unknown = null;
  savePlanCancelled = false;
  exportPlanCancelled = false;

  override async savePlan(request: SceneSavePlanRequest): Promise<ScenePlanResponse> {
    if (this.savePlanCancelled) {
      return {
        cancelled: true,
        planId: undefined,
        targetDisplayName: undefined,
        targetKind: undefined,
        byteCount: undefined,
        canonicalDigest: undefined,
        expiresAtUnixMs: undefined,
      };
    }
    return super.savePlan(request);
  }

  override async exportPlan(request: SceneExportPlanRequest): Promise<ScenePlanResponse> {
    if (this.exportPlanCancelled) {
      return {
        cancelled: true,
        planId: undefined,
        targetDisplayName: undefined,
        targetKind: undefined,
        byteCount: undefined,
        canonicalDigest: undefined,
        expiresAtUnixMs: undefined,
      };
    }
    return super.exportPlan(request);
  }

  override async saveApply(request: SceneApplyRequest): Promise<ScenePublicationResponse> {
    if (this.saveApplyError) {
      this.retainedSavePlan = false;
      throw this.saveApplyError;
    }
    return super.saveApply(request);
  }

  override async exportApply(request: SceneApplyRequest): Promise<ScenePublicationResponse> {
    if (this.exportApplyError) {
      this.retainedExportPlan = false;
      throw this.exportApplyError;
    }
    return super.exportApply(request);
  }
}

describe("TFSB64-R1 Publication Error Recovery & Plan Lifecycle", () => {
  let createdBlobUrls: string[] = [];
  let revokedBlobUrls: string[] = [];

  beforeEach(() => {
    createdBlobUrls = [];
    revokedBlobUrls = [];
    vi.stubGlobal("Image", class {
      src = "";
      decode = vi.fn().mockResolvedValue(undefined);
    });

    globalThis.URL.createObjectURL = vi.fn(() => {
      const url = `blob:test-svg/${createdBlobUrls.length + 1}`;
      createdBlobUrls.push(url);
      return url;
    });

    globalThis.URL.revokeObjectURL = vi.fn((url: string) => {
      revokedBlobUrls.push(url);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("surfaces save collision error (selection-rejected) on Design Exchange tab without invalidating preview compile", async () => {
    const bridge = new PublicationTestBridge();
    render(React.createElement(VectorGraphicsLab, { bridge }));

    await screen.findByText("Revision 1");
    expect(screen.getByText(/Current preview/)).toBeTruthy();

    // Switch to Design Exchange tab
    fireEvent.click(screen.getByRole("tab", { name: /Design Exchange/ }));
    expect(await screen.findByTestId("exchange-panel")).toBeTruthy();

    // Initiate Save As Plan
    const savePlanBtn = screen.getByRole("button", { name: "Save As Plan" });
    fireEvent.click(savePlanBtn);
    expect(await screen.findByTestId("save-plan-box")).toBeTruthy();

    // Simulate Rust absent-only publication rejection (target collision)
    bridge.saveApplyError = {
      schemaVersion: 1,
      reasonCode: "selection-rejected",
      message: "The requested Studio host operation could not be completed.",
    };

    // Confirm save plan
    const confirmBtn = screen.getByRole("button", { name: "Confirm Save Plan" });
    fireEvent.click(confirmBtn);

    // 1. Error MUST be visible on the Design Exchange tab near the toolbar
    const errorAlert = await screen.findByTestId("publication-error-alert");
    expect(errorAlert).toBeTruthy();
    expect(errorAlert.textContent).toContain("selection-rejected");
    expect(errorAlert.textContent).toContain("Destination already exists (collision) or target selection was rejected.");
    // Ensure no raw filesystem path leakage
    expect(errorAlert.textContent).not.toContain("/");
    expect(errorAlert.textContent).not.toContain("\\");

    // 2. Failed consumed apply plan is cleared from frontend state to match Rust consumption
    expect(screen.queryByTestId("save-plan-box")).toBeNull();

    // 3. Compile error is NOT set and preview evidence remains current
    expect(screen.queryByTestId("compile-error-alert")).toBeNull();
    expect(screen.getByText(/Current preview/)).toBeTruthy();
    expect(screen.queryByText(/Last-good preview is stale/)).toBeNull();

    // 4. Save and Export remain enabled for fresh retry
    const retrySaveBtn = screen.getByRole("button", { name: "Save As Plan" }) as HTMLButtonElement;
    expect(retrySaveBtn.disabled).toBe(false);
    const exportBtn = screen.getByRole("button", { name: "Export SVG Plan" }) as HTMLButtonElement;
    expect(exportBtn.disabled).toBe(false);

    // 5. Fresh retry: initiate new save plan with collision resolved
    bridge.saveApplyError = null;
    fireEvent.click(retrySaveBtn);
    expect(await screen.findByTestId("save-plan-box")).toBeTruthy();

    const retryConfirmBtn = screen.getByRole("button", { name: "Confirm Save Plan" });
    fireEvent.click(retryConfirmBtn);

    await waitFor(() => {
      expect(screen.queryByTestId("save-plan-box")).toBeNull();
      expect(screen.getByText("Saved")).toBeTruthy();
      expect(screen.queryByTestId("publication-error-alert")).toBeNull();
    });
  });

  it("surfaces export collision error (selection-rejected) on Design Exchange tab and clears consumed plan", async () => {
    const bridge = new PublicationTestBridge();
    render(React.createElement(VectorGraphicsLab, { bridge }));

    await screen.findByText("Revision 1");
    fireEvent.click(screen.getByRole("tab", { name: /Design Exchange/ }));

    // Initiate Export Plan
    const exportPlanBtn = screen.getByRole("button", { name: "Export SVG Plan" });
    fireEvent.click(exportPlanBtn);
    expect(await screen.findByTestId("export-plan-box")).toBeTruthy();

    // Simulate Rust collision on export
    bridge.exportApplyError = {
      schemaVersion: 1,
      reasonCode: "selection-rejected",
    };

    const confirmBtn = screen.getByRole("button", { name: "Confirm Export Plan" });
    fireEvent.click(confirmBtn);

    // Visible on exchange tab
    const alert = await screen.findByTestId("publication-error-alert");
    expect(alert.textContent).toContain("selection-rejected");
    expect(alert.textContent).toContain("Destination already exists (collision) or target selection was rejected.");

    // Consumed export plan was cleared
    expect(screen.queryByTestId("export-plan-box")).toBeNull();

    // Compile remains valid
    expect(screen.getByText(/Current preview/)).toBeTruthy();

    // Retry export successfully
    bridge.exportApplyError = null;
    const retryExportBtn = screen.getByRole("button", { name: "Export SVG Plan" });
    fireEvent.click(retryExportBtn);
    expect(await screen.findByTestId("export-plan-box")).toBeTruthy();

    const retryConfirmBtn = screen.getByRole("button", { name: "Confirm Export Plan" });
    fireEvent.click(retryConfirmBtn);

    await waitFor(() => {
      expect(screen.queryByTestId("export-plan-box")).toBeNull();
      expect(screen.queryByTestId("publication-error-alert")).toBeNull();
    });
  });

  it("clears pending export plan when a save plan succeeds", async () => {
    const bridge = new PublicationTestBridge();
    render(React.createElement(VectorGraphicsLab, { bridge }));

    await screen.findByText("Revision 1");

    // Initiate Export Plan
    fireEvent.click(screen.getByRole("button", { name: "Export SVG Plan" }));
    expect(await screen.findByTestId("export-plan-box")).toBeTruthy();

    // Initiate Save Plan
    fireEvent.click(screen.getByRole("button", { name: "Save As Plan" }));
    expect(await screen.findByTestId("save-plan-box")).toBeTruthy();
    expect(screen.getByTestId("export-plan-box")).toBeTruthy();

    // Confirm Save Plan successfully
    fireEvent.click(screen.getByRole("button", { name: "Confirm Save Plan" }));

    await waitFor(() => {
      expect(screen.queryByTestId("save-plan-box")).toBeNull();
      // Successful save invalidates native export plan; frontend stale plan must be cleared!
      expect(screen.queryByTestId("export-plan-box")).toBeNull();
      expect(screen.getByText("Saved")).toBeTruthy();
    });
  });

  it("preserves cancel semantics without mutating existing retained plans", async () => {
    const bridge = new PublicationTestBridge();
    render(React.createElement(VectorGraphicsLab, { bridge }));

    await screen.findByText("Revision 1");

    const initialDirty = bridge.dirty;

    // Retain an Export Plan
    fireEvent.click(screen.getByRole("button", { name: "Export SVG Plan" }));
    expect(await screen.findByTestId("export-plan-box")).toBeTruthy();

    // Initiate a Save Plan, but simulate user cancelling the native file picker dialog
    bridge.savePlanCancelled = true;
    fireEvent.click(screen.getByRole("button", { name: "Save As Plan" }));

    // Wait for async initiateSavePlan to complete
    await waitFor(() => {
      expect(screen.queryByTestId("save-plan-box")).toBeNull();
      expect((screen.getByRole("button", { name: "Cancel Export Plan" }) as HTMLButtonElement).disabled).toBe(false);
    });

    // Existing export plan is NOT mutated or discarded
    expect(screen.getByTestId("export-plan-box")).toBeTruthy();

    // Cancel the Export Plan via UI Cancel button
    const cancelExportBtn = screen.getByRole("button", { name: "Cancel Export Plan" });
    fireEvent.click(cancelExportBtn);
    await waitFor(() => {
      expect(screen.queryByTestId("export-plan-box")).toBeNull();
    });

    // Scene and dirty status were not mutated
    expect(bridge.dirty).toBe(initialDirty);
    expect(screen.getByText(/Current preview/)).toBeTruthy();
  });

  it("upholds publication gating when preview is stale and correctly handles stale plan rejection", async () => {
    const bridge = new PublicationTestBridge();
    render(React.createElement(VectorGraphicsLab, { bridge }));

    await screen.findByText("Revision 1");

    // Edit scene to increment revision without recompiling
    fireEvent.click(screen.getByRole("tab", { name: /Layers/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add Layer" }));

    await waitFor(() => {
      expect(screen.getByText("Revision 2")).toBeTruthy();
    });

    // Preview is now stale
    expect(screen.getByTestId("stale-preview-badge")).toBeTruthy();
    expect(screen.getByText(/Last-good preview is stale/)).toBeTruthy();

    // Gating check: Save As Plan and Export SVG Plan MUST be disabled!
    const saveBtn = screen.getByRole("button", { name: "Save As Plan" }) as HTMLButtonElement;
    const exportBtn = screen.getByRole("button", { name: "Export SVG Plan" }) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
    expect(exportBtn.disabled).toBe(true);

    // Recompile preview to clear staleness
    fireEvent.click(screen.getByRole("button", { name: "Compile Scene Preview" }));
    await waitFor(() => {
      expect(screen.queryByTestId("stale-preview-badge")).toBeNull();
    });
    expect(saveBtn.disabled).toBe(false);
    expect(exportBtn.disabled).toBe(false);

    // Now test stale plan failure: simulate bridge rejecting saveApply with 'stale'
    fireEvent.click(saveBtn);
    expect(await screen.findByTestId("save-plan-box")).toBeTruthy();

    bridge.saveApplyError = { reasonCode: "stale" };
    fireEvent.click(screen.getByRole("button", { name: "Confirm Save Plan" }));

    // Stale failure must be surfaced as an error, NOT treated as valid publication
    const alert = await screen.findByTestId("publication-error-alert");
    expect(alert.textContent).toContain("stale");
    expect(alert.textContent).toContain("The publication plan is stale due to scene revisions.");
    // Document must remain dirty (not saved)
    expect(screen.getByText("* Modified (Unsaved)")).toBeTruthy();
    expect(bridge.dirty).toBe(true);
  });

  it.each([
    "selection-rejected", "plan-invalid", "plan-expired", "digest-mismatch",
    "stale", "context-stale", "context-invalid", "domain-failed",
    "protocol-invalid", "result-too-large", "sidecar-crashed",
  ])("preserves reachable publication reason %s without exposing host details", async (reasonCode) => {
    const bridge = new PublicationTestBridge();
    render(React.createElement(VectorGraphicsLab, { bridge }));
    await screen.findByText("Revision 1");
    fireEvent.click(screen.getByRole("button", { name: "Save As Plan" }));
    await screen.findByTestId("save-plan-box");
    bridge.saveApplyError = { reasonCode, message: "private-host-details" };
    fireEvent.click(screen.getByRole("button", { name: "Confirm Save Plan" }));
    const alert = await screen.findByTestId("publication-error-alert");
    expect(alert.textContent).toContain(`Publication failed (${reasonCode})`);
    expect(alert.textContent).not.toContain("private-host-details");
    if (reasonCode === "sidecar-crashed") {
      expect(alert.textContent).toContain("Restart the application before retrying.");
    }
  });

  it.each([
    new Error("/private/example/scene.json: Permission denied"),
    { reasonCode: "private-user-secret", message: "private-details" },
    { reasonCode: "constructor" },
    { reasonCode: "__proto__" },
    "selection-rejected private-details",
  ])("maps unrecognized error details to fixed wording without leakage", async (failure) => {
    const bridge = new PublicationTestBridge();
    render(React.createElement(VectorGraphicsLab, { bridge }));

    await screen.findByText("Revision 1");

    fireEvent.click(screen.getByRole("button", { name: "Save As Plan" }));
    expect(await screen.findByTestId("save-plan-box")).toBeTruthy();

    // Error containing raw paths and sensitive internal message
    bridge.saveApplyError = failure;
    fireEvent.click(screen.getByRole("button", { name: "Confirm Save Plan" }));

    const alert = await screen.findByTestId("publication-error-alert");
    expect(alert.textContent).toContain("Publication failed (domain-failed)");
    expect(alert.textContent).not.toContain("/private/example");
    expect(alert.textContent).not.toContain("private-user-secret");
    expect(alert.textContent).not.toContain("private-details");
    expect(alert.textContent).not.toContain("Permission denied");
  });
});
