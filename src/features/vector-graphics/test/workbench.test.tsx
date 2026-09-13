// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { VectorGraphicsLab } from "../components/VectorGraphicsLab";
import { MockVectorGraphicsBridge } from "../mock-bridge";
import { VectorGraphicsValidationError } from "../vector-graphics-bridge";

describe("Vector Graphics Workbench (VectorGraphicsLab)", () => {
  let createdBlobUrls: string[] = [];
  let revokedBlobUrls: string[] = [];

  beforeEach(() => {
    createdBlobUrls = [];
    revokedBlobUrls = [];
    vi.stubGlobal("Image", class {
      src = "";
      decode = vi.fn().mockResolvedValue(undefined);
    });

    globalThis.URL.createObjectURL = vi.fn((blob: Blob) => {
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

  it("renders the Vector Graphics Lab and compiles initial inert blob preview", async () => {
    const bridge = new MockVectorGraphicsBridge();
    render(<VectorGraphicsLab bridge={bridge} />);

    expect(await screen.findByRole("heading", { name: "Vector Graphics Lab" })).toBeTruthy();
    expect(await screen.findByText("Revision 1")).toBeTruthy();

    // Verify inert <img> element rendering (TFSB63A: inert img Blob engine SVG only)
    const img = await screen.findByTestId("inert-blob-img");
    expect(img).toBeTruthy();
    expect(img.tagName.toLowerCase()).toBe("img");
    expect((img as HTMLImageElement).src).toContain("blob:test-svg/");

    // Verify metrics bar
    expect(await screen.findByTestId("metrics-bar")).toBeTruthy();
    expect(screen.getByText(/Elements: 3/)).toBeTruthy();
  });

  it("New clears the previous token binding before compiling", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const bridge = new MockVectorGraphicsBridge();
    render(<VectorGraphicsLab bridge={bridge} />);
    await screen.findByTestId("inert-blob-img");
    fireEvent.click(screen.getByRole("button", { name: "Bind Brand Tokens" }));
    await screen.findByText("Revision 2");
    expect(bridge.tokenSnapshotId).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "New Scene" }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(createdBlobUrls).toHaveLength(2));
    expect(bridge.tokenSnapshotId).toBeUndefined();
    expect(screen.queryByTestId("stale-preview-badge")).toBeNull();
    expect((screen.getByRole("button", { name: "Save As Plan" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it.each(["New Scene", "Open Scene JSON", "Import SVG"])("preserves the dirty scene when %s discard is declined", async action => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const bridge = new MockVectorGraphicsBridge();
    render(<VectorGraphicsLab bridge={bridge} />);
    const img = await screen.findByTestId("inert-blob-img");
    expect(bridge.dirty).toBe(true);
    const originalUrl = img.getAttribute("src");
    const callCount = bridge.calls.length;
    fireEvent.click(screen.getByRole("button", { name: action }));
    if (action === "New Scene") {
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
    }
    expect(confirm).toHaveBeenCalledOnce();
    expect(bridge.calls).toHaveLength(callCount);
    expect(screen.getByText("Revision 1")).toBeTruthy();
    expect(bridge.dirty).toBe(true);
    expect(img.getAttribute("src")).toBe(originalUrl);
    expect(createdBlobUrls).toHaveLength(1);
    expect(revokedBlobUrls).toHaveLength(0);
  });

  it("compiles the adopted Open draft with its full source binding", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const bridge = new MockVectorGraphicsBridge();
    render(<VectorGraphicsLab bridge={bridge} />);
    await screen.findByTestId("inert-blob-img");
    fireEvent.click(screen.getByRole("button", { name: "Open Scene JSON" }));
    await screen.findByText("Revision 2");
    await waitFor(() => {
      expect(screen.queryByTestId("stale-preview-badge")).toBeNull();
      expect((screen.getByRole("button", { name: "Save As Plan" }) as HTMLButtonElement).disabled).toBe(false);
      expect((screen.getByRole("button", { name: "Export SVG Plan" }) as HTMLButtonElement).disabled).toBe(false);
    });
    expect(screen.queryByText(/Compile Failure/)).toBeNull();
    expect(createdBlobUrls).toHaveLength(2);
  });

  it("compiles imported SVG with its source binding", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const bridge = new MockVectorGraphicsBridge();
    render(<VectorGraphicsLab bridge={bridge} />);
    await screen.findByTestId("inert-blob-img");
    fireEvent.click(screen.getByRole("button", { name: "Import SVG" }));
    await screen.findByText("Revision 2");
    await waitFor(() => expect(createdBlobUrls).toHaveLength(2));
    expect(screen.queryByTestId("stale-preview-badge")).toBeNull();
    expect((screen.getByRole("button", { name: "Save As Plan" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("refreshes with the token snapshot binding after Bind", async () => {
    const bridge = new MockVectorGraphicsBridge();
    render(<VectorGraphicsLab bridge={bridge} />);
    await screen.findByTestId("inert-blob-img");
    fireEvent.click(screen.getByRole("button", { name: "Bind Brand Tokens" }));
    await screen.findByText("Revision 2");
    fireEvent.click(screen.getByRole("button", { name: "Compile Scene Preview" }));
    await waitFor(() => expect(createdBlobUrls).toHaveLength(2));
    expect(screen.queryByTestId("stale-preview-badge")).toBeNull();
    expect((screen.getByRole("button", { name: "Export SVG Plan" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("refreshes with the new source binding after Save Apply", async () => {
    const bridge = new MockVectorGraphicsBridge();
    render(<VectorGraphicsLab bridge={bridge} />);
    await screen.findByTestId("inert-blob-img");
    fireEvent.click(screen.getByRole("button", { name: "Save As Plan" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm Save Plan" }));
    await screen.findByText("new-scene.json");
    fireEvent.click(screen.getByRole("button", { name: "Compile Scene Preview" }));
    await waitFor(() => expect(createdBlobUrls).toHaveLength(2));
    expect(screen.queryByText(/Compile Failure/)).toBeNull();
    expect((screen.getByRole("button", { name: "Export SVG Plan" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it.each([
    "context-stale", "context-invalid", "stale", "digest-mismatch", "domain-failed",
    "sidecar-artifact-unavailable", "sidecar-artifact-invalid", "sidecar-crashed",
    "sidecar-protocol-invalid", "sidecar-startup-timeout", "sidecar-request-timeout",
    "sidecar-shutdown-failed", "sidecar-remote-rejected", "sidecar-busy",
    "request-busy", "request-timeout", "protocol-invalid", "cancelled",
  ])("maps the closed backend %s code after adoption without rendering backend text", async reasonCode => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const bridge = new MockVectorGraphicsBridge();
    render(<VectorGraphicsLab bridge={bridge} />);
    const img = await screen.findByTestId("inert-blob-img");
    const originalUrl = img.getAttribute("src");
    vi.spyOn(bridge, "compileScene").mockRejectedValueOnce({
      schemaVersion: 1, reasonCode, message: "PRIVATE_PATH_SENTINEL stderr executable data",
    });
    fireEvent.click(screen.getByRole("button", { name: "Open Scene JSON" }));
    await screen.findByText(`Scene operation failed (${reasonCode}):`, { exact: false });
    expect(screen.getByText("Revision 2")).toBeTruthy();
    expect(screen.getByTestId("stale-preview-badge")).toBeTruthy();
    expect(img.getAttribute("src")).toBe(originalUrl);
    expect(createdBlobUrls).toHaveLength(1);
    expect(revokedBlobUrls).toHaveLength(0);
    expect(screen.queryByText(/PRIVATE_PATH_SENTINEL/)).toBeNull();
    expect((screen.getByRole("button", { name: "Save As Plan" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Export SVG Plan" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it.each([
    [{ schemaVersion: 1, reasonCode: "unknown", message: "PRIVATE_PATH_SENTINEL" }, "An unexpected error occurred"],
    [{ schemaVersion: 2, reasonCode: "context-stale", message: "PRIVATE_PATH_SENTINEL" }, "An unexpected error occurred"],
    [{ schemaVersion: 1, reasonCode: "context-stale" }, "An unexpected error occurred"],
    [{ schemaVersion: 1, reasonCode: "context-stale", message: "PRIVATE_PATH_SENTINEL", extra: true }, "An unexpected error occurred"],
    [{ schemaVersion: 1, reasonCode: "context-stale", message: 42 }, "An unexpected error occurred"],
    [Object.create({ schemaVersion: 1, reasonCode: "context-stale", message: "PRIVATE_PATH_SENTINEL" }), "An unexpected error occurred"],
    [new VectorGraphicsValidationError("Expected object for scene"), "Expected object for scene"],
    ["Descriptive frontend rejection", "Descriptive frontend rejection"],
    ["", "An unexpected error occurred"],
    [new Error(""), "An unexpected error occurred"],
    [null, "An unexpected error occurred"],
    [undefined, "An unexpected error occurred"],
  ])("keeps Open rejection bounded while preserving validator and string diagnostics (%#)", async (error, expectedText) => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const bridge = new MockVectorGraphicsBridge();
    render(<VectorGraphicsLab bridge={bridge} />);
    const img = await screen.findByTestId("inert-blob-img");
    const originalUrl = img.getAttribute("src");
    vi.spyOn(bridge, "openScene").mockRejectedValueOnce(error);
    fireEvent.click(screen.getByRole("button", { name: "Open Scene JSON" }));
    await screen.findByText(expectedText as string);
    expect(screen.getByText("Revision 1")).toBeTruthy();
    expect(img.getAttribute("src")).toBe(originalUrl);
    expect(screen.queryByText(/PRIVATE_PATH_SENTINEL/)).toBeNull();
    expect((screen.getByRole("button", { name: "Save As Plan" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("displays fixed frontend wording on local Open rejection (selection-rejected) with no data leaked", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const bridge = new MockVectorGraphicsBridge();
    render(<VectorGraphicsLab bridge={bridge} />);
    const img = await screen.findByTestId("inert-blob-img");
    const originalUrl = img.getAttribute("src");

    // Rust returns SelectionRejected for local legs: malformed JSON, valid non-Scene JSON, incompatible schema
    vi.spyOn(bridge, "openScene").mockRejectedValueOnce({
      schemaVersion: 1,
      reasonCode: "selection-rejected",
      message: "PRIVATE_PATH_SENTINEL /secret/path/user-file.json malformed or incompatible",
    });

    fireEvent.click(screen.getByRole("button", { name: "Open Scene JSON" }));

    // Fixed frontend wording from SAFE_SCENE_REASON_MESSAGES
    const alert = await screen.findByTestId("compile-error-alert");
    expect(alert.textContent).toContain(
      "Scene operation failed (selection-rejected): The selected file was rejected."
    );

    // Unchanged state: revision remains 1, preview unchanged, no secret leaked
    expect(screen.getByText("Revision 1")).toBeTruthy();
    expect(img.getAttribute("src")).toBe(originalUrl);
    expect(screen.queryByText(/PRIVATE_PATH_SENTINEL/)).toBeNull();
    expect(alert.textContent).not.toContain("PRIVATE_PATH_SENTINEL");
    expect(alert.textContent).not.toContain("/secret/path");
    expect((screen.getByRole("button", { name: "Save As Plan" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("switches navigation tabs cleanly between canvas, layers, inspector, artboard, and exchange", async () => {
    const bridge = new MockVectorGraphicsBridge();
    render(<VectorGraphicsLab bridge={bridge} />);

    await screen.findByText("Revision 1");

    // Click Layers tab
    fireEvent.click(screen.getByRole("tab", { name: /Layers/ }));
    expect(await screen.findByTestId("layer-list")).toBeTruthy();

    // Click Shape Inspector tab
    fireEvent.click(screen.getByRole("tab", { name: "Shape Inspector" }));
    expect(await screen.findByTestId("shape-inspector")).toBeTruthy();

    // Click Artboard tab
    fireEvent.click(screen.getByRole("tab", { name: "Artboard & Profile" }));
    expect(await screen.findByTestId("artboard-controls")).toBeTruthy();

    // Click Exchange tab
    fireEvent.click(screen.getByRole("tab", { name: /Design Exchange/ }));
    expect(await screen.findByTestId("exchange-panel")).toBeTruthy();
  });

  it("adds, selects, moves, and deletes layers in z-order", async () => {
    const bridge = new MockVectorGraphicsBridge();
    render(<VectorGraphicsLab bridge={bridge} />);

    await screen.findByText("Revision 1");
    fireEvent.click(screen.getByRole("tab", { name: /Layers/ }));

    expect(screen.getAllByTestId("layer-row")).toHaveLength(3);

    // Select layer type to add
    const typeSelect = screen.getByLabelText("New layer type");
    fireEvent.change(typeSelect, { target: { value: "circle" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Layer" }));

    // Now has 4 layers, revision incremented to 2
    await waitFor(() => {
      expect(screen.getAllByTestId("layer-row")).toHaveLength(4);
    });
    expect(await screen.findByText("Revision 2")).toBeTruthy();
    expect(screen.getByText("* Modified (Unsaved)")).toBeTruthy();

    // Stale preview warning should be visible because edit incremented revision
    expect(screen.getByTestId("stale-preview-badge")).toBeTruthy();

    // Reorder: move up
    const moveUpBtn = screen.getByRole("button", { name: "Move Layer Up" });
    fireEvent.click(moveUpBtn);
    await waitFor(() => {
      expect(screen.getByText("Revision 3")).toBeTruthy();
    });

    // Delete selected layer
    const removeBtn = screen.getByRole("button", { name: "Delete Layer" });
    fireEvent.click(removeBtn);
    await waitFor(() => {
      expect(screen.getAllByTestId("layer-row")).toHaveLength(3);
    });
    expect(screen.getByText("Revision 4")).toBeTruthy();
  });

  it("updates shape geometry and presentation in the Shape Inspector without raw JSON", async () => {
    const bridge = new MockVectorGraphicsBridge();
    render(<VectorGraphicsLab bridge={bridge} />);

    await screen.findByText("Revision 1");
    fireEvent.click(screen.getByRole("tab", { name: /Layers/ }));

    // Click first layer (bg-rect)
    const firstLayer = screen.getAllByTestId("layer-row")[0]!;
    fireEvent.click(firstLayer);

    // Automatically navigated to inspector
    expect(await screen.findByTestId("shape-inspector")).toBeTruthy();
    expect(screen.getByLabelText("Rectangle Width")).toBeTruthy();

    // Change width
    const widthInput = screen.getByLabelText("Rectangle Width");
    fireEvent.change(widthInput, { target: { value: "950" } });

    await waitFor(() => {
      expect(screen.getByText("Revision 2")).toBeTruthy();
    });
    expect(bridge.scene.elements[0]).toMatchObject({ width: 950 });
  });

  it("recompiles preview and clears stale badge on compile action", async () => {
    const bridge = new MockVectorGraphicsBridge();
    render(<VectorGraphicsLab bridge={bridge} />);

    await screen.findByText("Revision 1");
    fireEvent.click(screen.getByRole("tab", { name: /Layers/ }));

    // Add a layer to create an unsaved edit
    fireEvent.click(screen.getByRole("button", { name: "Add Layer" }));
    await waitFor(() => {
      expect(screen.getByText("Revision 2")).toBeTruthy();
    });

    // Verify stale badge is shown
    expect(screen.getByTestId("stale-preview-badge")).toBeTruthy();

    // Trigger recompile
    const compileBtn = screen.getByRole("button", { name: "Compile Scene Preview" });
    fireEvent.click(compileBtn);

    // Wait for compilation to complete and stale badge to disappear
    await waitFor(() => {
      expect(screen.queryByTestId("stale-preview-badge")).toBeNull();
    });
  });

  it("executes two-step Save As Plan and Apply workflow", async () => {
    const bridge = new MockVectorGraphicsBridge();
    render(<VectorGraphicsLab bridge={bridge} />);

    await screen.findByText("Revision 1");

    // Initiate Save Plan
    const savePlanBtn = screen.getByRole("button", { name: "Save As Plan" });
    fireEvent.click(savePlanBtn);

    // Confirmation box appears
    expect(await screen.findByTestId("save-plan-box")).toBeTruthy();
    expect(screen.getByText(/Save to: new-scene.json/)).toBeTruthy();

    // Confirm save
    const confirmBtn = screen.getByRole("button", { name: "Confirm Save Plan" });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(screen.queryByTestId("save-plan-box")).toBeNull();
      expect(screen.getByText("Saved")).toBeTruthy();
    });
    expect(bridge.dirty).toBe(false);
  });

  it("executes two-step Export SVG Plan and Apply workflow without marking draft saved", async () => {
    const bridge = new MockVectorGraphicsBridge();
    render(<VectorGraphicsLab bridge={bridge} />);

    await screen.findByText("Revision 1");

    // Make dirty first
    fireEvent.click(screen.getByRole("tab", { name: /Layers/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add Layer" }));
    await waitFor(() => {
      expect(screen.getByText("* Modified (Unsaved)")).toBeTruthy();
    });

    expect((screen.getByRole("button", { name: "Export SVG Plan" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Compile Scene Preview" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Export SVG Plan" }) as HTMLButtonElement).disabled).toBe(false));

    // Initiate Export Plan
    const exportPlanBtn = screen.getByRole("button", { name: "Export SVG Plan" });
    fireEvent.click(exportPlanBtn);

    expect(await screen.findByTestId("export-plan-box")).toBeTruthy();

    // Confirm export
    const confirmBtn = screen.getByRole("button", { name: "Confirm Export Plan" });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(screen.queryByTestId("export-plan-box")).toBeNull();
    });

    // Exporting SVG does NOT mark document saved
    expect(screen.getByText("* Modified (Unsaved)")).toBeTruthy();
  });

  it("binds brand tokens into the scene", async () => {
    const bridge = new MockVectorGraphicsBridge();
    render(<VectorGraphicsLab bridge={bridge} />);

    await screen.findByText("Revision 1");

    const bindTokensBtn = screen.getByRole("button", { name: "Bind Brand Tokens" });
    fireEvent.click(bindTokensBtn);

    await waitFor(() => {
      expect(screen.getByText("Revision 2")).toBeTruthy();
    });
    expect(bridge.scene.tokenBindings?.["color.accent"]).toBe("#38bdf8");
  });

  it("orchestrates Design Exchange: create brief, import, verify, and adopt", async () => {
    const bridge = new MockVectorGraphicsBridge();
    render(<VectorGraphicsLab bridge={bridge} />);

    await screen.findByText("Revision 1");
    fireEvent.click(screen.getByRole("tab", { name: /Design Exchange/ }));

    // 1. Create Brief
    const createBriefBtn = screen.getByRole("button", { name: "Create Brief Button" });
    fireEvent.click(createBriefBtn);

    await waitFor(() => {
      expect(screen.getByText(/BRIEF/)).toBeTruthy();
    });

    // 2. Import Packet
    const importBtn = screen.getByRole("button", { name: "Import Packet" });
    fireEvent.click(importBtn);

    await waitFor(() => {
      expect(screen.getByText(/CANDIDATE/)).toBeTruthy();
    });

    // 3. Verify Candidate
    const verifyBtn = screen.getByRole("button", { name: "Verify Candidate" });
    fireEvent.click(verifyBtn);

    expect(await screen.findByTestId("verification-box")).toBeTruthy();
    expect(screen.getByText(/✅ Valid/)).toBeTruthy();

    // 4. Adopt Candidate
    const adoptBtn = screen.getByRole("button", { name: "Adopt Candidate" });
    fireEvent.click(adoptBtn);

    await waitFor(() => {
      expect(screen.getByText("Revision 2")).toBeTruthy();
    });
    expect(screen.getByText("* Modified (Unsaved)")).toBeTruthy();
  });

  it("cleans up Blob URLs on unmount", async () => {
    const bridge = new MockVectorGraphicsBridge();
    const { unmount } = render(<VectorGraphicsLab bridge={bridge} />);

    await screen.findByTestId("inert-blob-img");
    expect(createdBlobUrls.length).toBeGreaterThanOrEqual(1);

    unmount();
    expect(revokedBlobUrls.length).toBeGreaterThanOrEqual(1);
  });

  it("invalidates pending save/export plans immediately when a new edit occurs", async () => {
    const bridge = new MockVectorGraphicsBridge();
    render(<VectorGraphicsLab bridge={bridge} />);

    await screen.findByText("Revision 1");

    // Initiate Save Plan
    const savePlanBtn = screen.getByRole("button", { name: "Save As Plan" });
    fireEvent.click(savePlanBtn);

    expect(await screen.findByTestId("save-plan-box")).toBeTruthy();

    // Now edit the document (add layer)
    fireEvent.click(screen.getByRole("tab", { name: /Layers/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add Layer" }));

    // Pending save plan MUST be invalidated immediately so stale plan cannot be applied
    await waitFor(() => {
      expect(screen.queryByTestId("save-plan-box")).toBeNull();
      expect(screen.getByText("Revision 2")).toBeTruthy();
    });
  });

  it("rebinds source identity after applying Save Plan", async () => {
    const bridge = new MockVectorGraphicsBridge();
    render(<VectorGraphicsLab bridge={bridge} />);

    await screen.findByText("Revision 1");

    // Click Save As Plan
    const savePlanBtn = screen.getByRole("button", { name: "Save As Plan" });
    fireEvent.click(savePlanBtn);

    const confirmBtn = await screen.findByRole("button", { name: "Confirm Save Plan" });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(screen.queryByTestId("save-plan-box")).toBeNull();
      expect(screen.getByText("Saved")).toBeTruthy();
      expect(screen.getByText("new-scene.json")).toBeTruthy();
    });
  });

  it("renders structured gradient, group, and symbol controls in Inspector", async () => {
    const bridge = new MockVectorGraphicsBridge();
    render(<VectorGraphicsLab bridge={bridge} />);

    await screen.findByText("Revision 1");

    // Select Layers tab and select first element
    fireEvent.click(screen.getByRole("tab", { name: /Layers/ }));
    const layerItems = screen.getAllByTestId("layer-row");
    expect(layerItems.length).toBeGreaterThan(0);
    fireEvent.click(layerItems[0]!);

    // Go to Inspector
    fireEvent.click(screen.getByRole("tab", { name: "Shape Inspector" }));
    expect(await screen.findByTestId("shape-inspector")).toBeTruthy();

    // Switch fill type to gradient
    const fillTypeSelect = screen.getByLabelText("Fill Type");
    fireEvent.change(fillTypeSelect, { target: { value: "gradient" } });

    // Gradient definition editor should appear
    expect(await screen.findByTestId("gradient-editor-fill")).toBeTruthy();

    // Add a group element to test group children editor
    fireEvent.click(screen.getByRole("tab", { name: /Layers/ }));
    const layerTypeSelect = screen.getByLabelText("New layer type");
    fireEvent.change(layerTypeSelect, { target: { value: "group" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Layer" }));

    // Select the new group element
    fireEvent.click(screen.getByRole("tab", { name: "Shape Inspector" }));
    expect(await screen.findByTestId("group-children-editor")).toBeTruthy();

    // Add child rect inside group
    const addChildBtn = screen.getByRole("button", { name: "Add child to group" });
    fireEvent.click(addChildBtn);

    await waitFor(() => {
      expect(screen.getByText(/Group Children \(1\)/)).toBeTruthy();
    });
  });
});
