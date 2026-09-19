import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApplicationThemeLab } from "../features/application-theme/ApplicationThemeLab";
import { MockAppThemeBridge } from "../features/application-theme/app-theme-bridge";

describe("ApplicationThemeLab component", () => {
  it("renders with initial Forge Console profile and paired view mode", async () => {
    const bridge = new MockAppThemeBridge();
    render(<ApplicationThemeLab bridge={bridge} />);

    expect(await screen.findByRole("heading", { name: "Application Theme Lab" })).toBeTruthy();
    expect(await screen.findByText(/Solar Sail Available/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Paired Comparison (Solar Sail + Loom)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Application Preview Only" })).toBeTruthy();
  });

  it("switches view mode between paired and application-only", async () => {
    const bridge = new MockAppThemeBridge();
    render(<ApplicationThemeLab bridge={bridge} />);

    expect(await screen.findByRole("heading", { name: "Application Theme Lab" })).toBeTruthy();

    const appOnlyBtn = screen.getByRole("button", { name: "Application Preview Only" });
    fireEvent.click(appOnlyBtn);

    // Starlight preview should not be rendered in application-only mode
    expect(screen.queryByText(/Stellar Loom Documentation Preview/i)).toBeNull();

    const pairedBtn = screen.getByRole("button", { name: "Paired Comparison (Solar Sail + Loom)" });
    fireEvent.click(pairedBtn);
    expect(await screen.findByText(/Stellar Loom Documentation Preview/i)).toBeTruthy();
  });

  it("toggles theme mode between Dark and Light", async () => {
    const bridge = new MockAppThemeBridge();
    render(<ApplicationThemeLab bridge={bridge} />);

    expect(await screen.findByRole("heading", { name: "Application Theme Lab" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Design Tokens (dark)" })).toBeTruthy();

    const lightBtn = screen.getByRole("button", { name: "Edit Light Palette" });
    fireEvent.click(lightBtn);
    expect(screen.getByRole("heading", { name: "Design Tokens (light)" })).toBeTruthy();

    const darkBtn = screen.getByRole("button", { name: "Edit Dark Palette" });
    fireEvent.click(darkBtn);
    expect(screen.getByRole("heading", { name: "Design Tokens (dark)" })).toBeTruthy();
  });

  it("modifies primary color token, marks dirty, and triggers compilation", async () => {
    const bridge = new MockAppThemeBridge();
    render(<ApplicationThemeLab bridge={bridge} />);

    expect(await screen.findByRole("heading", { name: "Application Theme Lab" })).toBeTruthy();

    const primaryInputs = screen.getAllByDisplayValue("#69d3e4");
    expect(primaryInputs.length).toBeGreaterThan(0);

    fireEvent.change(primaryInputs[0]!, { target: { value: "#9333ea" } });
    expect(screen.getByText("Unsaved Changes")).toBeTruthy();

    const compileBtn = screen.getByRole("button", { name: "Compile Theme" });
    fireEvent.click(compileBtn);

    await waitFor(() => {
      expect(screen.getByText("Paired theme compilation succeeded.")).toBeTruthy();
    });
  });

  it("adopts compiled theme draft into Studio shell self-theme", async () => {
    const bridge = new MockAppThemeBridge();
    render(<ApplicationThemeLab bridge={bridge} />);

    expect(await screen.findByRole("heading", { name: "Application Theme Lab" })).toBeTruthy();

    const adoptBtn = screen.getByRole("button", { name: "Adopt as Draft" });
    fireEvent.click(adoptBtn);

    expect(document.body.classList.contains("self-theme")).toBe(true);
    expect(screen.getByText(/Adopted theme candidate as unsaved draft/i)).toBeTruthy();

    // Verify reset removes self-theme
    const resetBtn = screen.getByRole("button", { name: "Reset to Self-Theme" });
    fireEvent.click(resetBtn);
    await waitFor(() => {
      expect(document.body.classList.contains("self-theme")).toBe(false);
    });
  });

  it("opens and closes the export package modal dialog", async () => {
    const bridge = new MockAppThemeBridge();
    render(<ApplicationThemeLab bridge={bridge} />);

    expect(await screen.findByRole("heading", { name: "Application Theme Lab" })).toBeTruthy();

    const exportBtn = screen.getByRole("button", { name: "Export Package…" });
    fireEvent.click(exportBtn);

    expect(await screen.findByRole("heading", { name: "Export Theme Package" })).toBeTruthy();

    const cancelBtn = screen.getByRole("button", { name: "Cancel" });
    fireEvent.click(cancelBtn);

    expect(screen.queryByRole("heading", { name: "Export Theme Package" })).toBeNull();
  });

  it("opens profile via bridge when Open Profile is clicked", async () => {
    const bridge = new MockAppThemeBridge();
    render(<ApplicationThemeLab bridge={bridge} />);

    const openBtn = await screen.findByRole("button", { name: "Open Profile…" });
    fireEvent.click(openBtn);

    await waitFor(() => {
      expect(screen.getByText(/Opened profile: forge-console.profile.json/i)).toBeTruthy();
    });
  });

  it("saves profile via bridge when Save Profile is clicked", async () => {
    const bridge = new MockAppThemeBridge();
    render(<ApplicationThemeLab bridge={bridge} />);

    const saveBtn = await screen.findByRole("button", { name: "Save Profile…" });
    fireEvent.click(saveBtn);


    await waitFor(() => {
      expect(screen.getByText(/Saved profile to: \/mock\/forge-console.profile.json/i)).toBeTruthy();
    });
  });

  it("exports package via bridge when Select Destination & Export is clicked", async () => {
    const bridge = new MockAppThemeBridge();
    render(<ApplicationThemeLab bridge={bridge} />);

    const exportBtn = await screen.findByRole("button", { name: "Export Package…" });
    fireEvent.click(exportBtn);

    const confirmBtn = screen.getByRole("button", { name: "Select Destination & Export" });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(screen.getByText(/Exported TYPESCRIPT package \(11 files\) to \/mock\/forge-console-theme/i)).toBeTruthy();
    });
  });

  it("discards out-of-order stale compilation responses after edit/reset", async () => {
    const bridge = new MockAppThemeBridge();
    let resolveCompile: (val: any) => void = () => {};
    const compilePromise = new Promise((resolve) => {
      resolveCompile = resolve;
    });

    let firstCall = true;
    bridge.pairedCompile = async (_prof, rev = 1) => {
      if (firstCall) {
        firstCall = false;
        await compilePromise;
        return {
          status: "success",
          valid: true,
          uiRevision: rev,
          solarSail: {
            status: "success",
            valid: true,
            uiRevision: rev,
            compiledCss: ":root { --primary: #stale-css; }",
            diagnostics: [],
          },
          stellarLoom: {
            valid: true,
            compiledCss: ":root { --sl-color-accent: #stale-css; }",
            diagnostics: [],
          },
          sharedTokens: ["primary"],
        };
      }
      return {
        status: "success",
        valid: true,
        uiRevision: rev,
        solarSail: {
          status: "success",
          valid: true,
          uiRevision: rev,
          compiledCss: ":root { --primary: #fresh-css; }",
          diagnostics: [],
        },
        stellarLoom: {
          valid: true,
          compiledCss: ":root { --sl-color-accent: #fresh-css; }",
          diagnostics: [],
        },
        sharedTokens: ["primary"],
      };
    };

    render(<ApplicationThemeLab bridge={bridge} />);
    expect(await screen.findByRole("heading", { name: "Application Theme Lab" })).toBeTruthy();

    // Reset before first compile resolves
    const resetBtn = screen.getByRole("button", { name: "Reset to Self-Theme" });
    fireEvent.click(resetBtn);

    // Now resolve the stale in-flight compilation
    resolveCompile(null);

    await waitFor(() => {
      expect(screen.getByText("Reset to default self-theme.")).toBeTruthy();
    });

    // The stale compilation message must NOT have overwritten the reset message
    expect(screen.queryByText("Paired theme compilation succeeded.")).toBeNull();
  });

  it("preserves dirty state when save profile fails", async () => {
    const bridge = new MockAppThemeBridge();
    bridge.saveProfile = async () => ({
      cancelled: false,
      error: "Disk write permission denied",
    });

    render(<ApplicationThemeLab bridge={bridge} />);
    expect(await screen.findByRole("heading", { name: "Application Theme Lab" })).toBeTruthy();

    const primaryInputs = screen.getAllByDisplayValue("#69d3e4");
    fireEvent.change(primaryInputs[0]!, { target: { value: "#112233" } });
    expect(screen.getByText("Unsaved Changes")).toBeTruthy();

    const saveBtn = screen.getByRole("button", { name: "Save Profile…" });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(screen.getByText("Save failed: Disk write permission denied")).toBeTruthy();
    });
    expect(screen.getByText("Unsaved Changes")).toBeTruthy();
  });

  it("allows reset to default self-theme even when compiler backend is offline", async () => {
    const bridge = new MockAppThemeBridge();
    bridge.getStatus = async () => ({
      available: false,
      compilerVersion: "unavailable",
      sessionId: "offline",
      latestRevision: 0,
      message: "Compiler backend is offline.",
      dirty: false,
    });
    bridge.reset = async () => {
      throw new Error("Sidecar unreachable");
    };

    render(<ApplicationThemeLab bridge={bridge} />);
    expect(await screen.findByRole("heading", { name: "Solar Sail Compiler Degraded" })).toBeTruthy();

    const resetBtn = screen.getByRole("button", { name: "Reset to Self-Theme" });
    fireEvent.click(resetBtn);

    await waitFor(() => {
      expect(screen.getByText("Reset to default self-theme.")).toBeTruthy();
    });
    expect(screen.getByText("Clean")).toBeTruthy();
  });

  it("displays structured error banner when package export fails", async () => {
    const bridge = new MockAppThemeBridge();
    bridge.exportPackage = async () => ({
      cancelled: false,
      error: "Destination folder is not empty",
    });

    render(<ApplicationThemeLab bridge={bridge} />);
    expect(await screen.findByRole("heading", { name: "Application Theme Lab" })).toBeTruthy();

    const exportBtn = screen.getByRole("button", { name: "Export Package…" });
    fireEvent.click(exportBtn);

    const confirmBtn = screen.getByRole("button", { name: "Select Destination & Export" });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(screen.getByText("Export failed: Destination folder is not empty")).toBeTruthy();
    });
  });

  it("releases compile busy state after edit or reset during in-flight compilation (Finding A)", async () => {
    const bridge = new MockAppThemeBridge();
    let resolveCompile: (val: any) => void = () => {};
    let compileCount = 0;

    bridge.pairedCompile = async (_prof, rev = 1) => {
      compileCount++;
      if (compileCount === 2 || compileCount === 4) {
        await new Promise((res) => {
          resolveCompile = res;
        });
      }
      return {
        status: "success",
        valid: true,
        uiRevision: rev,
        solarSail: {
          status: "success",
          valid: true,
          uiRevision: rev,
          compiledCss: ":root { --primary: #resolved; }",
          diagnostics: [],
        },
        stellarLoom: {
          valid: true,
          compiledCss: ":root { --sl-color-accent: #resolved; }",
          diagnostics: [],
        },
        sharedTokens: ["primary"],
      };
    };

    render(<ApplicationThemeLab bridge={bridge} />);
    expect(await screen.findByRole("heading", { name: "Application Theme Lab" })).toBeTruthy();

    // 1. Edit during pending compile
    const compileBtn = await screen.findByRole("button", { name: "Compile Theme" });
    fireEvent.click(compileBtn);
    expect(screen.getByRole("button", { name: "Compiling…" })).toBeTruthy();

    const primaryInputs = screen.getAllByDisplayValue("#69d3e4");
    fireEvent.change(primaryInputs[0]!, { target: { value: "#112233" } });

    // Delayed compile completes
    resolveCompile(null);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Compile Theme" })).toBeTruthy();
    });

    // 2. Reset during pending compile
    fireEvent.click(screen.getByRole("button", { name: "Compile Theme" }));
    expect(screen.getByRole("button", { name: "Compiling…" })).toBeTruthy();

    const resetBtn = screen.getByRole("button", { name: "Reset to Self-Theme" });
    fireEvent.click(resetBtn);

    // Older compile completes after reset
    resolveCompile(null);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Compile Theme" })).toBeTruthy();
      expect(screen.getByText("Reset to default self-theme.")).toBeTruthy();
    });
  });

  it("adopts compiled edited theme as draft and reset cleanly detaches owned stylesheet (Findings B & F3)", async () => {
    const origAdopted = (document as any).adoptedStyleSheets;
    const origCSSStyleSheet = (window as any).CSSStyleSheet;

    let replacedCss = "";
    (document as any).adoptedStyleSheets = [];
    (window as any).CSSStyleSheet = class {
      replaceSync(css: string) {
        replacedCss = css;
      }
    };

    try {
      const bridge = new MockAppThemeBridge();
      render(<ApplicationThemeLab bridge={bridge} />);
      expect(await screen.findByRole("heading", { name: "Application Theme Lab" })).toBeTruthy();

      await screen.findByRole("button", { name: "Compile Theme" });

      // Edit a token so dirty is true
      const primaryInputs = screen.getAllByDisplayValue("#69d3e4");
      fireEvent.change(primaryInputs[0]!, { target: { value: "#ff0055" } });
      expect(screen.getByText("Unsaved Changes")).toBeTruthy();

      // Compile the edited theme
      const compileBtn = screen.getByRole("button", { name: "Compile Theme" });
      fireEvent.click(compileBtn);
      await waitFor(() => {
        expect(screen.getByText("Paired theme compilation succeeded.")).toBeTruthy();
      });

      // Adopt draft: Even though dirty is true, adoption MUST succeed because compilation is current
      const adoptBtn = screen.getByRole("button", { name: "Adopt as Draft" });
      fireEvent.click(adoptBtn);

      expect(document.body.classList.contains("self-theme")).toBe(true);
      expect((window as any).__selfThemeAdoptedSheet).toBeDefined();
      expect(document.adoptedStyleSheets).toContain((window as any).__selfThemeAdoptedSheet);
      expect(replacedCss).toContain("#ff0055");
      expect(screen.getByText(/Adopted theme candidate as unsaved draft/i)).toBeTruthy();

      // Click Reset
      const resetBtn = screen.getByRole("button", { name: "Reset to Self-Theme" });
      fireEvent.click(resetBtn);

      await waitFor(() => {
        expect(document.body.classList.contains("self-theme")).toBe(false);
        expect((window as any).__selfThemeAdoptedSheet).toBeUndefined();
        expect(document.adoptedStyleSheets).not.toContain((window as any).__selfThemeAdoptedSheet);
        expect(screen.getByText("Reset to default self-theme.")).toBeTruthy();
      });
    } finally {
      (document as any).adoptedStyleSheets = origAdopted;
      (window as any).CSSStyleSheet = origCSSStyleSheet;
      delete (window as any).__selfThemeAdoptedSheet;
      document.body.classList.remove("self-theme");
    }
  });

  it("preserves dirty state when profile is edited during in-flight save (Finding C)", async () => {
    const bridge = new MockAppThemeBridge();
    let resolveSave: (val: any) => void = () => {};
    bridge.saveProfile = async () => {
      await new Promise((res) => {
        resolveSave = res;
      });
      return {
        cancelled: false,
        filePath: "/mock/forge-console.profile.json",
      };
    };

    render(<ApplicationThemeLab bridge={bridge} />);
    expect(await screen.findByRole("heading", { name: "Application Theme Lab" })).toBeTruthy();

    // Edit token
    const primaryInputs = screen.getAllByDisplayValue("#69d3e4");
    fireEvent.change(primaryInputs[0]!, { target: { value: "#123456" } });
    expect(screen.getByText("Unsaved Changes")).toBeTruthy();

    // Click Save Profile
    const saveBtn = screen.getByRole("button", { name: "Save Profile…" });
    fireEvent.click(saveBtn);

    // While save is in flight, user makes another edit
    fireEvent.change(primaryInputs[0]!, { target: { value: "#789abc" } });

    // Resolve save
    resolveSave(null);

    // Save should report that an earlier snapshot was saved, but dirty MUST remain true!
    await waitFor(() => {
      expect(screen.getByText(/newer unsaved changes present/i)).toBeTruthy();
    });
    expect(screen.getByText("Unsaved Changes")).toBeTruthy();
  });

  it("truthfully reports compilation outcomes when Solar Sail and Loom fail or succeed independently (Finding D)", async () => {
    const bridge = new MockAppThemeBridge();

    // 1. Both Solar Sail and Loom report issues
    bridge.pairedCompile = async (_prof, rev = 1) => ({
      status: "error",
      valid: false,
      uiRevision: rev,
      solarSail: {
        status: "error",
        valid: false,
        uiRevision: rev,
        compiledCss: "",
        diagnostics: [{ severity: "error", code: "INVALID_HEX", message: "Invalid hex color in palette" }],
      },
      stellarLoom: {
        valid: false,
        compiledCss: "",
        error: "Color contrast failed",
        diagnostics: [{ severity: "error", code: "CONTRAST_FAILURE", message: "Color contrast failed" }],
      },
      sharedTokens: [],
    });

    const { rerender } = render(<ApplicationThemeLab bridge={bridge} />);
    expect(await screen.findByRole("heading", { name: "Application Theme Lab" })).toBeTruthy();

    const compileBtn = screen.getByRole("button", { name: "Compile Theme" });
    fireEvent.click(compileBtn);

    await waitFor(() => {
      expect(screen.getByText("Both Solar Sail and Stellar Loom compilation reported issues.")).toBeTruthy();
    });

    // Cannot adopt draft when compilation reported errors
    const adoptBtn = screen.getByRole("button", { name: "Adopt as Draft" });
    fireEvent.click(adoptBtn);
    expect(screen.getByText("Cannot adopt draft: valid compilation is required.")).toBeTruthy();

    // 2. Solar Sail succeeds while Loom reports error (degraded)
    bridge.pairedCompile = async (_prof, rev = 2) => ({
      status: "success",
      valid: true,
      uiRevision: rev,
      solarSail: {
        status: "success",
        valid: true,
        uiRevision: rev,
        compiledCss: ":root { --primary: #00a896; }",
        diagnostics: [],
      },
      stellarLoom: {
        valid: false,
        compiledCss: "",
        error: "Stellar Loom compiler binary offline",
        diagnostics: [],
      },
      sharedTokens: ["primary"],
    });

    fireEvent.click(compileBtn);
    await waitFor(() => {
      expect(screen.getByText(/Solar Sail succeeded; Stellar Loom unavailable \(Stellar Loom compiler binary offline\)\. Showing last good preview\./i)).toBeTruthy();
    });

    // Can adopt draft because Solar Sail compilation succeeded!
    fireEvent.click(adoptBtn);
    await waitFor(() => {
      expect(screen.getByText(/Adopted theme candidate as unsaved draft/i)).toBeTruthy();
    });

    // 3. Solar Sail succeeds and Loom yields no output and no error
    bridge.pairedCompile = async (_prof, rev = 3) => ({
      status: "success",
      valid: true,
      uiRevision: rev,
      solarSail: {
        status: "success",
        valid: true,
        uiRevision: rev,
        compiledCss: ":root { --primary: #00a896; }",
        diagnostics: [],
      },
      stellarLoom: null,
      sharedTokens: ["primary"],
    });

    fireEvent.click(compileBtn);
    await waitFor(() => {
      expect(screen.getByText("Solar Sail succeeded; Stellar Loom yielded no output.")).toBeTruthy();
    });
  });
});

