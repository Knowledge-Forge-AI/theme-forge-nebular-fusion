import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ThemeLab } from "../features/theme-lab/ThemeLab";
import { MockThemeLabBridge, SAMPLE_BRIEF_PACKET, SAMPLE_CANDIDATE_A_PACKET, SAMPLE_CANDIDATE_B_PACKET, SAMPLE_REVIEW_PACKET } from "../features/theme-lab/test/mock-bridge";
import { SenderEvidenceImage } from "../features/theme-lab/SenderEvidenceImage";
import type { ThemeLabBridge, ThemeLabCompileRequest, ThemeLabCompileResponse } from "../features/theme-lab/types";
import type { ThemeDocumentSaveRequest } from "../features/theme-lab/v2-bridge";

describe("Theme Lab Component", () => {
  it("creates a separate unsaved v2 draft and retains invalid controls across sections", async () => {
    const compileV2 = vi.fn(async (request: { uiRevision: number }) => ({ uiRevision: request.uiRevision, valid: true, compiledCss: "body {}", diagnostics: [] }));
    const saveDocument = vi.fn(async (_request: ThemeDocumentSaveRequest) => ({ cancelled: false, displayName: "new-v2.json" }));
    const bridge = Object.assign(new MockThemeLabBridge(), { compileV2, saveDocument });
    render(<ThemeLab bridge={bridge} />);
    await screen.findByText(/Loaded stellar-cyan/);
    expect(compileV2).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "New v2 Theme" }));
    await waitFor(() => expect(compileV2).toHaveBeenCalled());
    expect(screen.getByText(/\* Modified/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("body Font Size"), { target: { value: "oops" } });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("tab", { name: "CSS & Descriptor" }));
    fireEvent.click(screen.getByRole("tab", { name: "Theme controls" }));
    expect((screen.getByLabelText("body Font Size") as HTMLInputElement).value).toBe("oops");
    fireEvent.change(screen.getByLabelText("body Font Size"), { target: { value: "18" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveDocument).toHaveBeenCalled());
    expect(saveDocument.mock.calls[0]?.[0]).toMatchObject({ saveAs: true, specification: { schemaVersion: "tfsl.theme-v2", typography: { body: { size: 18 } } } });
  });

  it("labels retained CSS stale immediately while the edited draft is pending", async () => {
    const bridge = new MockThemeLabBridge();
    vi.spyOn(bridge, "compile").mockImplementation(() => new Promise(() => {}));
    render(<ThemeLab bridge={bridge} />);
    await screen.findByText(/Loaded stellar-cyan/);
    fireEvent.change(screen.getByLabelText("Accent base hex code"), { target: { value: "#123456" } });
    expect(screen.getByText(/Previewing last valid theme/)).toBeTruthy();
  });

  it("rejects a successful compiler result bound to a different revision", async () => {
    const bridge = new MockThemeLabBridge();
    const compile = bridge.compile.bind(bridge);
    vi.spyOn(bridge, "compile").mockImplementation(async (request) => ({
      ...await compile(request), uiRevision: (request.uiRevision ?? 0) + 1,
    }));
    render(<ThemeLab bridge={bridge} />);
    await screen.findByText(/Loaded stellar-cyan/);
    fireEvent.change(screen.getByLabelText("Accent base hex code"), { target: { value: "#123456" } });
    await screen.findByText(/Compiler returned a mismatched revision/);
    expect(screen.queryByText("Theme compiled successfully")).toBeNull();
    expect(screen.getByText(/Previewing last valid theme/)).toBeTruthy();
  });

  it("does not attach an older save completion to a newly loaded draft", async () => {
    const bridge = new MockThemeLabBridge();
    let finishSave!: (result: { cancelled: boolean; displayName: string }) => void;
    vi.spyOn(bridge, "saveTheme").mockImplementation(() => new Promise((resolve) => { finishSave = resolve; }));
    render(<ThemeLab bridge={bridge} />);
    await screen.findByText(/Loaded stellar-cyan/);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(bridge.saveTheme).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Amber Forge" }));
    await screen.findByText(/Loaded amber-forge/);
    finishSave({ cancelled: false, displayName: "older.theme.json" });
    await waitFor(() => expect(screen.queryByText(/Saved older.theme.json/)).toBeNull());
    expect(screen.getByText(/Loaded amber-forge/)).toBeTruthy();
  });

  it("resumes only the latest pending draft compilation after packet selection cancels", async () => {
    const bridge = new MockThemeLabBridge();
    bridge.importPacket = async () => ({ cancelled: true });
    const compile = vi.spyOn(bridge, "compile");
    render(<ThemeLab bridge={bridge} />);
    await screen.findByText(/Loaded stellar-cyan/);
    fireEvent.change(screen.getByLabelText("Accent base hex code"), { target: { value: "#123456" } });
    fireEvent.change(screen.getByLabelText("Accent base hex code"), { target: { value: "#654321" } });
    fireEvent.click(screen.getByRole("button", { name: "Import Packet…" }));
    await screen.findByText("Theme compiled successfully");
    expect(compile).toHaveBeenCalledTimes(1);
    expect(compile.mock.calls[0]?.[0].specification.colors.dark.accent.base).toBe("#654321");
    expect(screen.getByText(/\* Modified/)).toBeTruthy();
  });
  it("loads default Stellar Cyan example and renders the theme editor", async () => {
    const bridge = new MockThemeLabBridge();
    const { container } = render(<ThemeLab bridge={bridge} />);

    expect(await screen.findByRole("heading", { name: "Theme Lab" })).toBeTruthy();
    expect(container.querySelector(".theme-title")?.textContent).toContain("stellar-cyan");
    expect(screen.queryByText(/\* Modified/)).toBeNull();
    expect(screen.getByRole("tab", { name: "Palette" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Typography & Layout" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Contrast Diagnostics/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "CSS & Descriptor" })).toBeTruthy();
  });

  it("switches between Stellar Cyan and Amber Forge examples", async () => {
    const bridge = new MockThemeLabBridge();
    const { container } = render(<ThemeLab bridge={bridge} />);

    expect(await screen.findByRole("heading", { name: "Theme Lab" })).toBeTruthy();
    expect(container.querySelector(".theme-title")?.textContent).toContain("stellar-cyan");

    const amberBtn = screen.getByRole("button", { name: "Amber Forge" });
    fireEvent.click(amberBtn);

    await waitFor(() => {
      expect(container.querySelector(".theme-title")?.textContent).toContain("amber-forge");
    });
    expect(screen.queryByText(/\* Modified/)).toBeNull();
  });

  it("tracks modifications as dirty and displays the modified indicator", async () => {
    const bridge = new MockThemeLabBridge();
    render(<ThemeLab bridge={bridge} />);

    expect(await screen.findByRole("heading", { name: "Theme Lab" })).toBeTruthy();
    expect(screen.queryByText(/\* Modified/)).toBeNull();

    const hexInput = screen.getByLabelText("Accent base hex code");
    fireEvent.change(hexInput, { target: { value: "#38bdf8" } });

    await waitFor(() => {
      expect(screen.getByText(/\* Modified/)).toBeTruthy();
    });
  });

  it("prompts confirmation modal on reset when modified and resets upon confirm", async () => {
    const bridge = new MockThemeLabBridge();
    const { container } = render(<ThemeLab bridge={bridge} />);

    expect(await screen.findByRole("heading", { name: "Theme Lab" })).toBeTruthy();

    const hexInput = screen.getByLabelText("Accent base hex code");
    fireEvent.change(hexInput, { target: { value: "#ef4444" } });

    await waitFor(() => {
      expect(screen.getByText(/\* Modified/)).toBeTruthy();
    });

    const resetBtn = screen.getByRole("button", { name: "Reset" });
    fireEvent.click(resetBtn);

    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Discard Unsaved Changes?")).toBeTruthy();

    const confirmBtn = screen.getByRole("button", { name: "Confirm Reset" });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.queryByText(/\* Modified/)).toBeNull();
    });
  });

  it("cancels reset without discarding modifications", async () => {
    const bridge = new MockThemeLabBridge();
    render(<ThemeLab bridge={bridge} />);

    expect(await screen.findByRole("heading", { name: "Theme Lab" })).toBeTruthy();

    const hexInput = screen.getByLabelText("Accent base hex code");
    fireEvent.change(hexInput, { target: { value: "#10b981" } });

    await waitFor(() => {
      expect(screen.getByText(/\* Modified/)).toBeTruthy();
    });

    const resetBtn = screen.getByRole("button", { name: "Reset" });
    fireEvent.click(resetBtn);

    expect(await screen.findByRole("dialog")).toBeTruthy();

    const cancelBtn = screen.getByRole("button", { name: "Cancel" });
    fireEvent.click(cancelBtn);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText(/\* Modified/)).toBeTruthy();
  });

  it("retains last valid compilation in preview upon compilation error and shows warning badge", async () => {
    const bridge = new MockThemeLabBridge();
    let shouldFail = false;
    const failingBridge: ThemeLabBridge = {
      getStatus: () => bridge.getStatus(),
      loadExample: (name, rev) => bridge.loadExample(name, rev),
      openTheme: () => bridge.openTheme(),
      saveTheme: (req) => bridge.saveTheme(req),
      compile: async (req: ThemeLabCompileRequest): Promise<ThemeLabCompileResponse> => {
        if (shouldFail) {
          return {
            uiRevision: req.uiRevision ?? 99,
            valid: false,
            error: "Syntax error: invalid hex color token",
            diagnostics: [],
          };
        }
        return bridge.compile(req);
      },
    };

    render(<ThemeLab bridge={failingBridge} />);
    expect(await screen.findByRole("heading", { name: "Theme Lab" })).toBeTruthy();

    // Trigger failure on next compile
    shouldFail = true;
    const hexInput = screen.getByLabelText("Accent base hex code");
    fireEvent.change(hexInput, { target: { value: "invalid-color" } });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
      expect(screen.getByText(/Syntax error: invalid hex color token/)).toBeTruthy();
      expect(screen.getByText(/\(Previewing last valid theme\)/)).toBeTruthy();
    });
  });

  it("handles saving without error and resets dirty state", async () => {
    const bridge = new MockThemeLabBridge();
    render(<ThemeLab bridge={bridge} />);

    expect(await screen.findByRole("heading", { name: "Theme Lab" })).toBeTruthy();

    const hexInput = screen.getByLabelText("Accent base hex code");
    fireEvent.change(hexInput, { target: { value: "#6366f1" } });

    await waitFor(() => {
      expect(screen.getByText(/\* Modified/)).toBeTruthy();
    });

    const saveBtn = screen.getByRole("button", { name: "Save" });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(screen.queryByText(/\* Modified/)).toBeNull();
      expect(screen.getByText(/Saved theme\.json/)).toBeTruthy();
    });
  });

  it("switches tabs between Palette, Typography, Diagnostics, and Output", async () => {
    const bridge = new MockThemeLabBridge();
    render(<ThemeLab bridge={bridge} />);

    expect(await screen.findByRole("heading", { name: "Theme Lab" })).toBeTruthy();

    // Typography Tab
    fireEvent.click(screen.getByRole("tab", { name: "Typography & Layout" }));
    expect(await screen.findByLabelText("Body Font")).toBeTruthy();
    expect(screen.getByLabelText("Content Max Width")).toBeTruthy();

    // Diagnostics Tab
    fireEvent.click(screen.getByRole("tab", { name: /Contrast Diagnostics/ }));
    expect(await screen.findByText("WCAG Contrast Diagnostics")).toBeTruthy();

    // Output Tab
    fireEvent.click(screen.getByRole("tab", { name: "CSS & Descriptor" }));
    expect(await screen.findByText("Generated CSS")).toBeTruthy();
    expect(screen.getByText("Theme Descriptor")).toBeTruthy();
  });

  it("toggles preview viewport between Desktop and Mobile", async () => {
    const bridge = new MockThemeLabBridge();
    const { container } = render(<ThemeLab bridge={bridge} />);

    expect(await screen.findByRole("heading", { name: "Theme Lab" })).toBeTruthy();

    const mobileBtn = screen.getByRole("button", { name: "Mobile (390px)" });
    fireEvent.click(mobileBtn);

    const frameWrapper = container.querySelector(".preview-frame-wrapper");
    expect(frameWrapper?.classList.contains("mobile")).toBe(true);

    const desktopBtn = screen.getByRole("button", { name: "Desktop" });
    fireEvent.click(desktopBtn);
    expect(frameWrapper?.classList.contains("desktop")).toBe(true);
  });

  it("discards out-of-order stale compilation responses", async () => {
    const bridge = new MockThemeLabBridge();
    let resolveStaleCompile: ((res: ThemeLabCompileResponse) => void) | null = null;
    let callCount = 0;

    const orderingBridge: ThemeLabBridge = {
      getStatus: () => bridge.getStatus(),
      loadExample: (name, rev) => bridge.loadExample(name, rev),
      openTheme: () => bridge.openTheme(),
      saveTheme: (req) => bridge.saveTheme(req),
      compile: async (req: ThemeLabCompileRequest): Promise<ThemeLabCompileResponse> => {
        callCount++;
        if (callCount === 1) {
          // First compile call: delay resolution
          return new Promise((resolve) => {
            resolveStaleCompile = resolve;
          });
        }
        // Subsequent calls resolve immediately
        return bridge.compile(req);
      },
    };

    render(<ThemeLab bridge={orderingBridge} />);
    expect(await screen.findByRole("heading", { name: "Theme Lab" })).toBeTruthy();

    // Trigger first compile (will fire after 150ms debounce and hang until manually resolved)
    const hexInput = screen.getByLabelText("Accent base hex code");
    fireEvent.change(hexInput, { target: { value: "#111111" } });
    await new Promise((r) => setTimeout(r, 200));

    // Trigger second compile with newer revision
    fireEvent.change(hexInput, { target: { value: "#222222" } });
    await new Promise((r) => setTimeout(r, 200));

    await waitFor(() => {
      expect(screen.getByText("Theme compiled successfully")).toBeTruthy();
    });

    // Now resolve the older, stale compile call with an error
    if (resolveStaleCompile) {
      (resolveStaleCompile as (res: ThemeLabCompileResponse) => void)({
        uiRevision: 2,
        valid: false,
        error: "Stale error that should be discarded",
        diagnostics: [],
      });
    }

    // The newer successful compile must NOT be overwritten by the stale older response
    await waitFor(() => {
      expect(screen.queryByText("Stale error that should be discarded")).toBeNull();
      expect(screen.getByText("Theme compiled successfully")).toBeTruthy();
    });
  });

  it("renders actionable banner when Stellar Loom backend is unavailable", async () => {
    const unavailableBridge: ThemeLabBridge = {
      getStatus: async () => ({
        available: false,
        compilerVersion: "0.0.0-mock",
        message: "Stellar Loom compiler adapter is not available. Check that loom-payload is built.",
      }),
      loadExample: async () => { throw new Error("not available"); },
      openTheme: async () => { throw new Error("not available"); },
      saveTheme: async () => { throw new Error("not available"); },
      compile: async () => { throw new Error("not available"); },
    };

    render(<ThemeLab bridge={unavailableBridge} />);
    expect(await screen.findByRole("heading", { name: "Theme Lab" })).toBeTruthy();

    await waitFor(() => {
      expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
      expect(screen.getByText(/Stellar Loom Backend Unavailable:/)).toBeTruthy();
      expect(screen.getByText(/Check that loom-payload is built/)).toBeTruthy();
    });
  });

  it("formats fieldPath in field-level structural compilation errors", async () => {
    const bridge = new MockThemeLabBridge();
    const failingBridge: ThemeLabBridge = {
      getStatus: () => bridge.getStatus(),
      loadExample: (name, rev) => bridge.loadExample(name, rev),
      openTheme: () => bridge.openTheme(),
      saveTheme: (req) => bridge.saveTheme(req),
      compile: async (req: ThemeLabCompileRequest): Promise<ThemeLabCompileResponse> => {
        return {
          uiRevision: req.uiRevision ?? 99,
          valid: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid hex color format",
            fieldPath: "colors.dark.accent.base",
          },
          diagnostics: [],
        };
      },
    };

    render(<ThemeLab bridge={failingBridge} />);
    expect(await screen.findByRole("heading", { name: "Theme Lab" })).toBeTruthy();

    const hexInput = screen.getByLabelText("Accent base hex code");
    fireEvent.change(hexInput, { target: { value: "bad-hex" } });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
      expect(screen.getByText(/Invalid hex color format \(field: 'colors\.dark\.accent\.base'\)/)).toBeTruthy();
    });
  });

  it("handles edit -> compile -> confirmed Reset correctly", async () => {
    const bridge = new MockThemeLabBridge();
    const { container } = render(<ThemeLab bridge={bridge} />);

    expect(await screen.findByRole("heading", { name: "Theme Lab" })).toBeTruthy();

    const hexInput = screen.getByLabelText("Accent base hex code");
    fireEvent.change(hexInput, { target: { value: "#123456" } });

    await waitFor(() => {
      expect(screen.getByText(/\* Modified/)).toBeTruthy();
    });

    const resetBtn = screen.getByRole("button", { name: "Reset" });
    fireEvent.click(resetBtn);

    const confirmBtn = await screen.findByRole("button", { name: "Confirm Reset" });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.queryByText(/\* Modified/)).toBeNull();
      expect(container.querySelector(".theme-title")?.textContent).toContain("stellar-cyan");
    });
  });

  it("switches example cleanly after edit", async () => {
    const bridge = new MockThemeLabBridge();
    const { container } = render(<ThemeLab bridge={bridge} />);

    expect(await screen.findByRole("heading", { name: "Theme Lab" })).toBeTruthy();

    const hexInput = screen.getByLabelText("Accent base hex code");
    fireEvent.change(hexInput, { target: { value: "#abcdef" } });

    await waitFor(() => {
      expect(screen.getByText(/\* Modified/)).toBeTruthy();
    });

    const amberBtn = screen.getByRole("button", { name: "Amber Forge" });
    fireEvent.click(amberBtn);

    expect(await screen.findByRole("dialog")).toBeTruthy();
    const proceedBtn = screen.getByRole("button", { name: "Discard & Proceed" });
    fireEvent.click(proceedBtn);

    await waitFor(() => {
      expect(container.querySelector(".theme-title")?.textContent).toContain("amber-forge");
      expect(screen.queryByText(/\* Modified/)).toBeNull();
    });
  });

  it("does not overwrite opened theme with an older pending compile", async () => {
    const bridge = new MockThemeLabBridge();
    let resolvePendingCompile: ((res: ThemeLabCompileResponse) => void) | null = null;

    const delayedBridge: ThemeLabBridge = {
      getStatus: () => bridge.getStatus(),
      loadExample: (name, rev, sess) => bridge.loadExample(name, rev, sess),
      openTheme: async () => {
        return {
          cancelled: false,
          displayName: "custom.theme.json",
          specification: {
            ...bridge["currentSpec"],
            name: "custom-opened-theme",
          },
          compiledCss: "/* custom opened theme css */",
          diagnostics: [],
        };
      },
      saveTheme: (req) => bridge.saveTheme(req),
      compile: async (req: ThemeLabCompileRequest): Promise<ThemeLabCompileResponse> => {
        return new Promise((resolve) => {
          resolvePendingCompile = resolve;
        });
      },
    };

    const { container } = render(<ThemeLab bridge={delayedBridge} />);
    expect(await screen.findByRole("heading", { name: "Theme Lab" })).toBeTruthy();

    // Trigger an edit that queues a delayed compile
    const hexInput = screen.getByLabelText("Accent base hex code");
    fireEvent.change(hexInput, { target: { value: "#334455" } });

    // While compile is in-flight, trigger Open
    const openBtn = screen.getByRole("button", { name: "Open…" });
    fireEvent.click(openBtn);

    expect(await screen.findByRole("dialog")).toBeTruthy();
    const proceedOpenBtn = screen.getByRole("button", { name: "Discard & Proceed" });
    fireEvent.click(proceedOpenBtn);

    await waitFor(() => {
      expect(container.querySelector(".theme-title")?.textContent).toContain("custom-opened-theme");
    });

    // Now resolve the older compile
    if (resolvePendingCompile) {
      (resolvePendingCompile as (res: ThemeLabCompileResponse) => void)({
        uiRevision: 2,
        valid: true,
        compiledCss: "/* stale older css */",
        diagnostics: [],
      });
    }

    // Opened theme must NOT be replaced
    await waitFor(() => {
      expect(container.querySelector(".theme-title")?.textContent).toContain("custom-opened-theme");
    });
  });

  it("preserves dirty status when an edit occurs while save is pending", async () => {
    const bridge = new MockThemeLabBridge();
    let resolvePendingSave: ((res: any) => void) | null = null;

    const delayedSaveBridge: ThemeLabBridge = {
      getStatus: () => bridge.getStatus(),
      loadExample: (name, rev, sess) => bridge.loadExample(name, rev, sess),
      openTheme: () => bridge.openTheme(),
      compile: (req) => bridge.compile(req),
      saveTheme: async () => {
        return new Promise((resolve) => {
          resolvePendingSave = resolve;
        });
      },
    };

    render(<ThemeLab bridge={delayedSaveBridge} />);
    expect(await screen.findByRole("heading", { name: "Theme Lab" })).toBeTruthy();

    // First edit
    const hexInput = screen.getByLabelText("Accent base hex code");
    fireEvent.change(hexInput, { target: { value: "#112233" } });
    await waitFor(() => {
      expect(screen.getByText(/\* Modified/)).toBeTruthy();
    });

    // Start Save
    const saveBtn = screen.getByRole("button", { name: "Save" });
    fireEvent.click(saveBtn);

    // Edit again while save is in-flight
    fireEvent.change(hexInput, { target: { value: "#445566" } });

    // Now complete the save
    if (resolvePendingSave) {
      (resolvePendingSave as (res: any) => void)({
        cancelled: false,
        displayName: "saved.theme.json",
      });
    }

    // Since edits occurred while save was in flight, dirty flag must remain true!
    await waitFor(() => {
      expect(screen.getByText(/\* Modified/)).toBeTruthy();
    });
  });

  it("survives unmount and remount (leaving and re-entering Theme Lab)", async () => {
    const bridge = new MockThemeLabBridge();
    const { unmount, container } = render(<ThemeLab bridge={bridge} />);

    expect(await screen.findByRole("heading", { name: "Theme Lab" })).toBeTruthy();
    expect(container.querySelector(".theme-title")?.textContent).toContain("stellar-cyan");

    // Perform edits in first session to advance the revision counter
    const hexInput = screen.getByLabelText("Accent base hex code");
    fireEvent.change(hexInput, { target: { value: "#112233" } });
    await waitFor(() => {
      expect(screen.getByText("Theme compiled successfully")).toBeTruthy();
    });

    // Leave the lab
    unmount();

    // Re-enter the lab with the persisting host bridge
    const { container: reentered } = render(<ThemeLab bridge={bridge} />);
    expect(await screen.findByRole("heading", { name: "Theme Lab" })).toBeTruthy();
    expect(reentered.querySelector(".theme-title")?.textContent).toContain("stellar-cyan");
    expect(screen.queryByText("Error loading example")).toBeNull();

    // Perform an edit after re-entry to ensure counter high-water mark is respected
    const reenteredHexInput = screen.getByLabelText("Accent base hex code");
    fireEvent.change(reenteredHexInput, { target: { value: "#445566" } });
    await waitFor(() => {
      expect(screen.getByText("Theme compiled successfully")).toBeTruthy();
    });
  });

  it("prompts confirmation modal when switching example with dirty changes and cancels cleanly", async () => {
    const bridge = new MockThemeLabBridge();
    const { container } = render(<ThemeLab bridge={bridge} />);
    expect(await screen.findByRole("heading", { name: "Theme Lab" })).toBeTruthy();

    const hexInput = screen.getByLabelText("Accent base hex code");
    fireEvent.change(hexInput, { target: { value: "#eeddcc" } });
    await waitFor(() => {
      expect(screen.getByText(/\* Modified/)).toBeTruthy();
    });

    // Click Amber Forge
    fireEvent.click(screen.getByRole("button", { name: "Amber Forge" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();

    // Cancel discard
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    // Draft remains modified and stellar-cyan preserved
    expect(screen.getByText(/\* Modified/)).toBeTruthy();
    expect(container.querySelector(".theme-title")?.textContent).toContain("stellar-cyan");
  });

  it("prompts confirmation modal on Open with dirty changes and cancels cleanly", async () => {
    const bridge = new MockThemeLabBridge();
    const { container } = render(<ThemeLab bridge={bridge} />);
    expect(await screen.findByRole("heading", { name: "Theme Lab" })).toBeTruthy();

    const hexInput = screen.getByLabelText("Accent base hex code");
    fireEvent.change(hexInput, { target: { value: "#778899" } });
    await waitFor(() => {
      expect(screen.getByText(/\* Modified/)).toBeTruthy();
    });

    // Click Open
    fireEvent.click(screen.getByRole("button", { name: "Open…" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();

    // Cancel discard
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    // Draft remains modified and stellar-cyan preserved
    expect(screen.getByText(/\* Modified/)).toBeTruthy();
    expect(container.querySelector(".theme-title")?.textContent).toContain("stellar-cyan");
  });

  it("restores truthful compilation on Edit -> Open -> Cancel", async () => {
    let compileCount = 0;
    const bridge: ThemeLabBridge = {
      getStatus: async () => ({
        available: true,
        compilerVersion: "0.0.0-mock",
        sessionId: "mock-session-1",
        latestRevision: 1,
      }),
      loadExample: async (name, rev) => ({
        uiRevision: rev ?? 1,
        valid: true,
        exampleName: name,
        specification: JSON.parse(JSON.stringify(bridgeImpl["currentSpec"])),
        compiledCss: "/* initial css */",
        diagnostics: [],
      }),
      openTheme: async () => ({
        cancelled: true,
        diagnostics: [],
      }),
      saveTheme: async () => ({ cancelled: false }),
      compile: async (req) => {
        compileCount++;
        return {
          uiRevision: req.uiRevision ?? 2,
          valid: true,
          compiledCss: "/* restored compile css */",
          diagnostics: [],
        };
      },
    };
    const bridgeImpl = new MockThemeLabBridge();

    render(<ThemeLab bridge={bridge} />);
    expect(await screen.findByRole("heading", { name: "Theme Lab" })).toBeTruthy();

    // 1. Edit accent base
    const hexInput = screen.getByLabelText("Accent base hex code");
    fireEvent.change(hexInput, { target: { value: "#4499ff" } });

    // 2. Immediately click Open… before debounce finishes (not dirty yet or debounce cancelled)
    fireEvent.click(screen.getByRole("button", { name: "Open…" }));

    // 3. Open was cancelled, but draft had pending changes -> verify compile is scheduled/executed
    await waitFor(() => {
      expect(compileCount).toBeGreaterThan(0);
      expect(screen.getByText("Theme compiled successfully")).toBeTruthy();
    });
  });

  it("invokes bridge.dispose on unmount", async () => {
    let disposeCalled = false;
    const bridge = new MockThemeLabBridge();
    const disposingBridge: ThemeLabBridge = {
      ...bridge,
      getStatus: () => bridge.getStatus(),
      loadExample: (n, r, s) => bridge.loadExample(n, r, s),
      compile: (r) => bridge.compile(r),
      openTheme: () => bridge.openTheme(),
      saveTheme: (r) => bridge.saveTheme(r),
      dispose: async () => {
        disposeCalled = true;
      },
    };

    const { unmount } = render(<ThemeLab bridge={disposingBridge} />);
    expect(await screen.findByRole("heading", { name: "Theme Lab" })).toBeTruthy();

    unmount();
    expect(disposeCalled).toBe(true);
  });

  it("does not invoke bridge.dispose on unmount when managed", async () => {
    let disposeCalled = false;
    const bridge = new MockThemeLabBridge();
    const disposingBridge: ThemeLabBridge = {
      ...bridge,
      getStatus: () => bridge.getStatus(),
      loadExample: (n, r, s) => bridge.loadExample(n, r, s),
      compile: (r) => bridge.compile(r),
      openTheme: () => bridge.openTheme(),
      saveTheme: (r) => bridge.saveTheme(r),
      dispose: async () => {
        disposeCalled = true;
      },
    };

    const { unmount } = render(<ThemeLab bridge={disposingBridge} managed />);
    expect(await screen.findByRole("heading", { name: "Theme Lab" })).toBeTruthy();

    unmount();
    expect(disposeCalled).toBe(false);
  });

  it("explicit Compile button compiles current draft immediately", async () => {
    let compiledRevisions: number[] = [];
    const bridge = new MockThemeLabBridge();
    const compileTrackingBridge: ThemeLabBridge = {
      ...bridge,
      getStatus: () => bridge.getStatus(),
      loadExample: (n, r, s) => bridge.loadExample(n, r, s),
      openTheme: () => bridge.openTheme(),
      saveTheme: (r) => bridge.saveTheme(r),
      compile: async (req) => {
        if (req.uiRevision) compiledRevisions.push(req.uiRevision);
        return bridge.compile(req);
      },
    };

    render(<ThemeLab bridge={compileTrackingBridge} />);
    expect(await screen.findByRole("heading", { name: "Theme Lab" })).toBeTruthy();

    // Make an edit
    const hexInput = screen.getByLabelText("Accent base hex code");
    fireEvent.change(hexInput, { target: { value: "#9900ee" } });

    // Click explicit Compile button
    const compileBtn = screen.getByRole("button", { name: "Compile" });
    fireEvent.click(compileBtn);

    await waitFor(() => {
      expect(screen.getByText("Theme compiled successfully")).toBeTruthy();
      expect(compiledRevisions.length).toBeGreaterThan(0);
    });
  });

  describe("Human-Agent Design Exchange Flows", () => {
    function wrapBridge(bridge: MockThemeLabBridge, overrides?: Partial<ThemeLabBridge>): ThemeLabBridge {
      return {
        getStatus: () => bridge.getStatus(),
        compile: (r) => bridge.compile(r),
        loadExample: (n, r, s) => bridge.loadExample(n, r, s),
        openTheme: () => bridge.openTheme(),
        saveTheme: (r) => bridge.saveTheme(r),
        createBrief: (r) => (bridge.createBrief ? bridge.createBrief(r) : Promise.reject(new Error("unsupported"))),
        importPacket: (r) => (bridge.importPacket ? bridge.importPacket(r) : Promise.reject(new Error("unsupported"))),
        exportPacket: (r) => (bridge.exportPacket ? bridge.exportPacket(r) : Promise.reject(new Error("unsupported"))),
        createReview: (r) => (bridge.createReview ? bridge.createReview(r) : Promise.reject(new Error("unsupported"))),
        adoptCandidate: (r) => (bridge.adoptCandidate ? bridge.adoptCandidate(r) : Promise.reject(new Error("unsupported"))),
        verifyThemeCandidate: (r) => bridge.verifyThemeCandidate?.(r) ?? Promise.resolve({ valid: true, diagnostics: [] }),
        validateThemeReview: (r) => bridge.validateThemeReview?.(r) ?? Promise.resolve({ valid: true }),
        dispose: () => bridge.dispose?.() ?? Promise.resolve(),
        ...overrides,
      };
    }

    it("exports a theme brief when Export Brief is clicked", async () => {
      let createdBriefReq: any = null;
      let exportedPacketReq: any = null;
      const bridge = new MockThemeLabBridge();
      const exchangeTrackingBridge = wrapBridge(bridge, {
        createBrief: async (req) => {
          createdBriefReq = req;
          return bridge.createBrief!(req);
        },
        exportPacket: async (req) => {
          exportedPacketReq = req;
          return bridge.exportPacket!(req);
        },
      });

      render(<ThemeLab bridge={exchangeTrackingBridge} />);
      expect(await screen.findByRole("heading", { name: "Theme Lab" })).toBeTruthy();

      // Open Exchange tab
      const exchangeTab = screen.getByRole("tab", { name: /Design Exchange/ });
      fireEvent.click(exchangeTab);

      // Fill brief human intent fields
      fireEvent.change(screen.getByLabelText("Brief Title"), { target: { value: "Stellar Cyan Aesthetic Refresh" } });
      fireEvent.change(screen.getByLabelText("Goal"), { target: { value: "Refine Starlight theme aesthetics and contrast while preserving brand identity" } });
      fireEvent.change(screen.getByLabelText(/Allowed Fields/), { target: { value: "colors.dark.accent.base\ncolors.dark.accent.high" } });

      const exportBriefBtn = screen.getAllByRole("button", { name: "Export Brief…" })[0]!;
      fireEvent.click(exportBriefBtn);

      await waitFor(() => {
        expect(createdBriefReq).not.toBeNull();
        expect(createdBriefReq.briefInput.goal).toContain("Refine Starlight theme aesthetics");
        expect(createdBriefReq.briefInput.baselineTheme.name).toBe("stellar-cyan");
        expect(exportedPacketReq).not.toBeNull();
        expect(exportedPacketReq.defaultName).toBe("stellar-cyan.tfsl-brief.json");
        expect(screen.getByText(/Exported brief to/)).toBeTruthy();
      });
    });

    it("imports an exchange packet and displays candidates in the Design Exchange tab", async () => {
      let importCalled = false;
      const bridge = new MockThemeLabBridge();
      const exchangeTrackingBridge = wrapBridge(bridge, {
        importPacket: async (req) => {
          importCalled = true;
          return bridge.importPacket!(req);
        },
      });

      render(<ThemeLab bridge={exchangeTrackingBridge} />);
      expect(await screen.findByRole("heading", { name: "Theme Lab" })).toBeTruthy();

      const importBtn = screen.getAllByRole("button", { name: "Import Packet…" })[0]!;
      fireEvent.click(importBtn);

      await waitFor(() => {
        expect(importCalled).toBe(true);
        expect(screen.getByRole("heading", { name: "Theme Design Exchange" })).toBeTruthy();
        expect(screen.getByRole("tab", { name: /cyan-accessible-high-contrast/ })).toBeTruthy();
      });

      // Explicit select shows the candidate detail card
      const candChip = screen.getByRole("tab", { name: /cyan-accessible-high-contrast/ });
      fireEvent.click(candChip);

      await waitFor(() => {
        expect(screen.getByRole("heading", { name: "cyan-accessible-high-contrast" })).toBeTruthy();
      });
    });

    it("inspects candidate details, visual evidence PNGs, adds annotations and dispositions, and exports review", async () => {
      let createdReviewReq: any = null;
      let exportedReviewReq: any = null;
      const bridge = new MockThemeLabBridge();
      const exchangeTrackingBridge = wrapBridge(bridge, {
        createReview: async (req) => {
          createdReviewReq = req;
          return bridge.createReview!(req);
        },
        exportPacket: async (req) => {
          exportedReviewReq = req;
          return bridge.exportPacket!(req);
        },
      });

      render(<ThemeLab bridge={exchangeTrackingBridge} />);
      expect(await screen.findByRole("heading", { name: "Theme Lab" })).toBeTruthy();

      // Open Exchange tab first
      const exchangeTab = screen.getByRole("tab", { name: /Design Exchange/ });
      fireEvent.click(exchangeTab);

      // Fill brief controls
      fireEvent.change(screen.getByLabelText("Brief Title"), { target: { value: "Stellar Cyan Aesthetic Refresh" } });
      fireEvent.change(screen.getByLabelText("Goal"), { target: { value: "Refine Starlight theme aesthetics and contrast while preserving brand identity" } });
      fireEvent.change(screen.getByLabelText(/Allowed Fields/), { target: { value: "colors.dark.accent.base\ncolors.dark.accent.high" } });

      // Export brief first so activeBrief exists for review export
      const exportBriefBtn = screen.getAllByRole("button", { name: "Export Brief…" })[0]!;
      fireEvent.click(exportBriefBtn);
      await screen.findByText(/Exported brief to/);

      // Verify empty exchange initially
      expect(screen.getByText(/No design candidates imported yet/)).toBeTruthy();

      // Import candidate packet
      const importBtn = screen.getAllByRole("button", { name: "Import Packet…" })[0]!;
      fireEvent.click(importBtn);

      // Explicitly select imported candidate chip
      const candChip = await screen.findByRole("tab", { name: /cyan-accessible-high-contrast/ });
      fireEvent.click(candChip);

      // Verify candidate inspection details
      expect(await screen.findByRole("heading", { name: "cyan-accessible-high-contrast" })).toBeTruthy();
      expect(screen.getByText(/Improves WCAG 2.2 AA contrast/)).toBeTruthy();
      expect(screen.getByText("@knowledge-forge-ai/starlight-theme-cyan-accessible")).toBeTruthy();

      // Verify visual evidence rendered
      const evidenceImgs = screen.getAllByRole("img");
      expect(evidenceImgs.length).toBeGreaterThan(0);
      expect(evidenceImgs[0]?.getAttribute("src")).toMatch(/^blob:/);

      // Add an annotation with explicit field path
      const fieldInput = screen.getByLabelText("Annotation field path");
      fireEvent.change(fieldInput, { target: { value: "colors.dark.accent.base" } });
      const commentInput = screen.getByLabelText("Annotation comment");
      fireEvent.change(commentInput, { target: { value: "Accent color is very legible on dark mode" } });
      const addAnnBtn = screen.getByRole("button", { name: "Add Annotation" });
      fireEvent.click(addAnnBtn);

      await waitFor(() => {
        expect(screen.getByText("Accent color is very legible on dark mode")).toBeTruthy();
      });

      // Change disposition
      const dispSelect = screen.getByLabelText("Decision:");
      fireEvent.change(dispSelect, { target: { value: "approved" } });

      const dispComment = screen.getByLabelText("Comment:");
      fireEvent.change(dispComment, { target: { value: "Approved after contrast review" } });

      // Change overall disposition to approved matching candidate and explicitly choose digest
      const overallSelect = screen.getByLabelText("Overall Result:");
      fireEvent.change(overallSelect, { target: { value: "approved" } });

      const candidateSelect = screen.getByLabelText("Selected Candidate:");
      fireEvent.change(candidateSelect, { target: { value: SAMPLE_CANDIDATE_A_PACKET.candidateDigest } });

      const summaryInput = screen.getByLabelText("Review Summary:");
      fireEvent.change(summaryInput, { target: { value: "Candidate approved after accessibility contrast review" } });

      // Export review
      const exportReviewBtn = screen.getByRole("button", { name: "Export Final Review Packet…" });
      fireEvent.click(exportReviewBtn);

      await waitFor(() => {
        expect(createdReviewReq).not.toBeNull();
        expect(createdReviewReq.reviewInput.dispositions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              disposition: "approved",
              comment: "Approved after contrast review",
            }),
          ])
        );
        expect(exportedReviewReq).not.toBeNull();
        expect(exportedReviewReq.defaultName).toContain(".tfsl-review.json");
        expect(screen.getByText(/Exported review to/)).toBeTruthy();
      });
    });

    it("adopts candidate as draft directly when draft is not modified", async () => {
      let adoptReq: any = null;
      const bridge = new MockThemeLabBridge();
      const exchangeTrackingBridge = wrapBridge(bridge, {
        adoptCandidate: async (req) => {
          adoptReq = req;
          return bridge.adoptCandidate!(req);
        },
      });

      const { container } = render(<ThemeLab bridge={exchangeTrackingBridge} />);
      expect(await screen.findByRole("heading", { name: "Theme Lab" })).toBeTruthy();

      // Open Exchange tab
      const exchangeTab = screen.getByRole("tab", { name: /Design Exchange/ });
      fireEvent.click(exchangeTab);

      // Export brief so activeBrief is present
      fireEvent.change(screen.getByLabelText("Brief Title"), { target: { value: "Stellar Cyan Aesthetic Refresh" } });
      fireEvent.change(screen.getByLabelText("Goal"), { target: { value: "Refine Starlight theme aesthetics" } });
      const exportBriefBtn = screen.getAllByRole("button", { name: "Export Brief…" })[0]!;
      fireEvent.click(exportBriefBtn);
      await screen.findByText(/Exported brief to/);

      // Import candidate
      const importBtn = screen.getAllByRole("button", { name: "Import Packet…" })[0]!;
      fireEvent.click(importBtn);

      // Select candidate
      const candChip = await screen.findByRole("tab", { name: /cyan-accessible-high-contrast/ });
      fireEvent.click(candChip);

      // Preview candidate before Use as Draft
      const previewBtn = screen.getByRole("button", { name: "Preview Candidate" });
      fireEvent.click(previewBtn);
      await screen.findByText("Previewing Candidate");

      // Click Use as Draft
      const adoptBtn = screen.getByRole("button", { name: "Use as Draft" });
      fireEvent.click(adoptBtn);

      await waitFor(() => {
        expect(adoptReq).not.toBeNull();
        expect(adoptReq.force).toBe(false);
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(container.querySelector(".theme-title")?.textContent).toContain("cyan-accessible-high-contrast");
        expect(screen.getByText(/Adopted candidate/)).toBeTruthy();
        expect(screen.getByText(/\* Modified/)).toBeTruthy();
      });
    });

    it("prompts confirmation when adopting candidate with dirty changes and adopts upon confirm", async () => {
      let adoptCalls: any[] = [];
      const bridge = new MockThemeLabBridge();
      const exchangeTrackingBridge = wrapBridge(bridge, {
        adoptCandidate: async (req) => {
          adoptCalls.push(req);
          return bridge.adoptCandidate!(req);
        },
      });

      const { container } = render(<ThemeLab bridge={exchangeTrackingBridge} />);
      expect(await screen.findByRole("heading", { name: "Theme Lab" })).toBeTruthy();

      // Edit a color to make draft dirty
      const hexInput = screen.getByLabelText("Accent base hex code");
      fireEvent.change(hexInput, { target: { value: "#ff0077" } });

      await waitFor(() => {
        expect(screen.getByText(/\* Modified/)).toBeTruthy();
      });

      // Open Exchange tab
      const exchangeTab = screen.getByRole("tab", { name: /Design Exchange/ });
      fireEvent.click(exchangeTab);

      // Export brief so activeBrief is set
      fireEvent.change(screen.getByLabelText("Brief Title"), { target: { value: "Stellar Cyan Aesthetic Refresh" } });
      fireEvent.change(screen.getByLabelText("Goal"), { target: { value: "Refine Starlight theme aesthetics" } });
      const exportBriefBtn = screen.getAllByRole("button", { name: "Export Brief…" })[0]!;
      fireEvent.click(exportBriefBtn);
      await screen.findByText(/Exported brief to/);

      // Import candidate
      const importBtn = screen.getAllByRole("button", { name: "Import Packet…" })[0]!;
      fireEvent.click(importBtn);

      // Select candidate
      const candChip = await screen.findByRole("tab", { name: /cyan-accessible-high-contrast/ });
      fireEvent.click(candChip);

      // Preview candidate before Use as Draft
      const previewBtn = screen.getByRole("button", { name: "Preview Candidate" });
      fireEvent.click(previewBtn);
      await screen.findByText("Previewing Candidate");

      // Click Use as Draft
      const adoptBtn = screen.getByRole("button", { name: "Use as Draft" });
      fireEvent.click(adoptBtn);

      // Verify modal appears
      expect(await screen.findByRole("dialog")).toBeTruthy();
      expect(screen.getByText("Discard Unsaved Changes?")).toBeTruthy();
      expect(screen.getByText(/Adopting this candidate will discard your current modifications/)).toBeTruthy();

      // Confirm adoption
      const confirmBtn = screen.getByRole("button", { name: "Discard & Adopt" });
      fireEvent.click(confirmBtn);

      await waitFor(() => {
        expect(adoptCalls.length).toBe(1);
        expect(adoptCalls[0].force).toBe(true);
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(container.querySelector(".theme-title")?.textContent).toContain("cyan-accessible-high-contrast");
        expect(screen.getByText(/Adopted candidate/)).toBeTruthy();
        expect(screen.getByText(/\* Modified/)).toBeTruthy();
      });
    });

    it("cancels candidate adoption without modifying dirty draft", async () => {
      const bridge = new MockThemeLabBridge();
      render(<ThemeLab bridge={bridge} />);
      expect(await screen.findByRole("heading", { name: "Theme Lab" })).toBeTruthy();

      // Edit a color to make draft dirty
      const hexInput = screen.getByLabelText("Accent base hex code");
      fireEvent.change(hexInput, { target: { value: "#33bb55" } });

      await waitFor(() => {
        expect(screen.getByText(/\* Modified/)).toBeTruthy();
      });

      // Open Exchange tab
      const exchangeTab = screen.getByRole("tab", { name: /Design Exchange/ });
      fireEvent.click(exchangeTab);

      // Export brief so activeBrief is set
      fireEvent.change(screen.getByLabelText("Brief Title"), { target: { value: "Stellar Cyan Aesthetic Refresh" } });
      fireEvent.change(screen.getByLabelText("Goal"), { target: { value: "Refine Starlight theme aesthetics" } });
      const exportBriefBtn = screen.getAllByRole("button", { name: "Export Brief…" })[0]!;
      fireEvent.click(exportBriefBtn);
      await screen.findByText(/Exported brief to/);

      // Import candidate
      const importBtn = screen.getAllByRole("button", { name: "Import Packet…" })[0]!;
      fireEvent.click(importBtn);

      // Select candidate
      const candChip = await screen.findByRole("tab", { name: /cyan-accessible-high-contrast/ });
      fireEvent.click(candChip);

      // Preview candidate
      const previewBtn = screen.getByRole("button", { name: "Preview Candidate" });
      fireEvent.click(previewBtn);
      await screen.findByText("Previewing Candidate");

      // Click Use as Draft
      const adoptBtn = screen.getByRole("button", { name: "Use as Draft" });
      fireEvent.click(adoptBtn);

      expect(await screen.findByRole("dialog")).toBeTruthy();

      // Cancel
      const cancelBtn = screen.getByRole("button", { name: "Cancel" });
      fireEvent.click(cancelBtn);

      await waitFor(() => {
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(screen.getByText(/\* Modified/)).toBeTruthy();
      });
    });

    it("guards against stale candidate adoption if selection changes while discard confirmation modal is open", async () => {
      const bridge = new MockThemeLabBridge();
      const packets = [SAMPLE_CANDIDATE_A_PACKET, SAMPLE_CANDIDATE_B_PACKET];
      const customBridge = wrapBridge(bridge, {
        importPacket: async () => {
          const next = packets.shift() ?? SAMPLE_CANDIDATE_B_PACKET;
          return {
            cancelled: false,
            displayName: "packet.json",
            packet: next as any,
            canonicalJson: JSON.stringify(next),
            kind: next.schema,
            digest: next.candidateDigest,
          };
        },
      });

      render(<ThemeLab bridge={customBridge} />);
      expect(await screen.findByRole("heading", { name: "Theme Lab" })).toBeTruthy();

      // Make dirty
      fireEvent.change(screen.getByLabelText("Accent base hex code"), { target: { value: "#123456" } });

      // Exchange tab
      fireEvent.click(screen.getByRole("tab", { name: /Design Exchange/ }));

      // Export brief
      fireEvent.change(screen.getByLabelText("Brief Title"), { target: { value: "Guard Test Brief" } });
      fireEvent.change(screen.getByLabelText("Goal"), { target: { value: "Test late candidate guard" } });
      fireEvent.click(screen.getAllByRole("button", { name: "Export Brief…" })[0]!);
      await screen.findByText(/Exported brief to/);

      // Import both candidates
      const importBtn = screen.getAllByRole("button", { name: "Import Packet…" })[0]!;
      fireEvent.click(importBtn);
      await screen.findByRole("tab", { name: /cyan-accessible-high-contrast/ });
      fireEvent.click(importBtn);
      await screen.findByRole("tab", { name: /cyan-neon-burst/ });

      // Select candidate A and preview
      fireEvent.click(screen.getByRole("tab", { name: /cyan-accessible-high-contrast/ }));
      fireEvent.click(screen.getByRole("button", { name: "Preview Candidate" }));
      await screen.findByText("Previewing Candidate");

      // Click Use as Draft -> modal opens
      fireEvent.click(screen.getByRole("button", { name: "Use as Draft" }));
      expect(await screen.findByRole("dialog")).toBeTruthy();

      // Switch selection to candidate B while modal is open (increments latestIntendedOpRef)
      fireEvent.click(screen.getByRole("tab", { name: /cyan-neon-burst/ }));

      // Confirm adoption from the stale modal
      fireEvent.click(screen.getByRole("button", { name: "Discard & Adopt" }));

      // Guard triggers: error displayed, candidate not adopted
      await waitFor(() => {
        expect(screen.getByText("The draft or exchange changed; select and verify the candidate again.")).toBeTruthy();
      });
    });

    it("leaves exchange state unchanged upon invalid import response", async () => {
      const bridge = new MockThemeLabBridge();
      const customBridge = wrapBridge(bridge, {
        importPacket: async () => ({
          cancelled: false,
          error: { code: "INVALID_JSON", message: "Corrupted packet data" },
        }),
      });

      render(<ThemeLab bridge={customBridge} />);
      expect(await screen.findByRole("heading", { name: "Theme Lab" })).toBeTruthy();

      fireEvent.click(screen.getByRole("tab", { name: /Design Exchange/ }));
      expect(screen.getByText(/No design candidates imported yet/)).toBeTruthy();

      const importBtn = screen.getAllByRole("button", { name: "Import Packet…" })[0]!;
      fireEvent.click(importBtn);

      await waitFor(() => {
        expect(screen.getByText(/Failed to import exchange packet/)).toBeTruthy();
      });
      // State remains unchanged
      expect(screen.getByText(/No design candidates imported yet/)).toBeTruthy();
    });

    it("restores no candidate selection when imported review has no-decision overall disposition", async () => {
      const bridge = new MockThemeLabBridge();
      const reviewNoDecision = {
        ...SAMPLE_REVIEW_PACKET,
        briefDigest: SAMPLE_BRIEF_PACKET.briefDigest,
        candidateDigests: [SAMPLE_CANDIDATE_A_PACKET.candidateDigest],
        dispositions: [
          {
            candidateDigest: SAMPLE_CANDIDATE_A_PACKET.candidateDigest,
            disposition: "unreviewed" as const,
          },
        ],
        annotations: [],
        overallDisposition: { kind: "no-decision" as const },
      };

      const packets = [SAMPLE_CANDIDATE_A_PACKET, reviewNoDecision];
      const customBridge = wrapBridge(bridge, {
        importPacket: async () => {
          const next = packets.shift() ?? reviewNoDecision;
          return {
            cancelled: false,
            displayName: "packet.json",
            packet: next as any,
            canonicalJson: JSON.stringify(next),
            kind: next.schema,
            digest: (next as any).candidateDigest ?? (next as any).reviewDigest,
          };
        },
      });

      render(<ThemeLab bridge={customBridge} />);
      expect(await screen.findByRole("heading", { name: "Theme Lab" })).toBeTruthy();

      fireEvent.click(screen.getByRole("tab", { name: /Design Exchange/ }));

      // Export brief so activeBrief is present
      fireEvent.change(screen.getByLabelText("Brief Title"), { target: { value: "Review Brief" } });
      fireEvent.change(screen.getByLabelText("Goal"), { target: { value: "Test review hydration" } });
      fireEvent.click(screen.getAllByRole("button", { name: "Export Brief…" })[0]!);
      await screen.findByText(/Exported brief to/);

      // Import candidate A and explicitly select it
      const importBtn = screen.getAllByRole("button", { name: "Import Packet…" })[0]!;
      fireEvent.click(importBtn);
      const candChip = await screen.findByRole("tab", { name: /cyan-accessible-high-contrast/ });
      fireEvent.click(candChip);

      // Detail card is visible
      expect(await screen.findByRole("heading", { name: "cyan-accessible-high-contrast" })).toBeTruthy();

      // Now import review with no-decision
      fireEvent.click(importBtn);
      await waitFor(() => {
        expect(screen.getByText(/Imported and validated review/)).toBeTruthy();
      });

      // Selected candidate is restored to none (detail card no longer rendered)
      expect(screen.queryByRole("heading", { name: "cyan-accessible-high-contrast" })).toBeNull();
    });

    it("cleans up blob URLs when SenderEvidenceImage unmounts", () => {
      const createSpy = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:tfsb-evidence-test");
      const revokeSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

      const validEvidence = SAMPLE_CANDIDATE_A_PACKET.visualEvidence[0]!;
      const { unmount } = render(
        <SenderEvidenceImage evidence={validEvidence as any} candidateDigest={SAMPLE_CANDIDATE_A_PACKET.candidateDigest} />
      );

      expect(createSpy).toHaveBeenCalled();
      unmount();
      expect(revokeSpy).toHaveBeenCalledWith("blob:tfsb-evidence-test");

      createSpy.mockRestore();
      revokeSpy.mockRestore();
    });
  });
});
