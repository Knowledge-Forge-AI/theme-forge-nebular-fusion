import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BUILTIN_FORGE_CONSOLE_PROFILE } from "../features/application-theme/builtin-profiles";
import type { AppThemeOpenedDocument } from "../features/application-theme/types";
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
    const resetBtn = screen.getByRole("button", { name: "Reset to Bundled" });
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
      expect(screen.getByText(/Loaded profile from forge-console.profile.json/i)).toBeTruthy();
    });
  });

  it("saves profile via bridge when Save Profile is clicked", async () => {
    const bridge = new MockAppThemeBridge();
    render(<ApplicationThemeLab bridge={bridge} />);

    const saveBtn = await screen.findByRole("button", { name: "Save Profile…" });
    fireEvent.click(saveBtn);


    await waitFor(() => {
      expect(screen.getByText(/Saved profile to forge-console.profile.json/i)).toBeTruthy();
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
    const resetBtn = screen.getByRole("button", { name: "Reset to Bundled" });
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
      saved: false,
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
      supportedFormats: [],
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

    const resetBtn = screen.getByRole("button", { name: "Reset to Bundled" });
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

    const resetBtn = screen.getByRole("button", { name: "Reset to Bundled" });
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
      const resetBtn = screen.getByRole("button", { name: "Reset to Bundled" });
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
        saved: true,
        document: custodyDocument(),
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


function custodyDocument(overrides: Partial<AppThemeOpenedDocument> = {}): AppThemeOpenedDocument {
  return {
    documentId: "custody-document-1",
    displayName: "forge-console.profile.json",
    schemaVersion: "tf-paired-profile-v1",
    aliasResolved: false,
    verificationStatus: "verified",
    isTransformed: false,
    semantic: "validated",
    rawSourceSha256: "a".repeat(64),
    normalizedSha256: "b".repeat(64),
    ownerBinding: {
      inputOrigin: "source-bytes",
      rawSourceSha256: "a".repeat(64),
      verificationStatus: "verified",
      isTransformed: false,
      byteLength: 512,
      normalizedSha256: "b".repeat(64),
    },
    editable: true,
    profile: JSON.parse(JSON.stringify(BUILTIN_FORGE_CONSOLE_PROFILE)),
    ...overrides,
  };
}

async function openCustodyDocument(document: AppThemeOpenedDocument) {
  const bridge = new MockAppThemeBridge();
  bridge.openProfile = vi.fn(async () => ({ cancelled: false, document }));
  const compile = vi.spyOn(bridge, "pairedCompile");
  const save = vi.spyOn(bridge, "saveProfile");
  const rendered = render(<ApplicationThemeLab bridge={bridge} />);
  await screen.findByText("Paired theme compilation succeeded.");
  compile.mockClear();
  const previousFrames = Array.from(rendered.container.querySelectorAll("iframe"));
  fireEvent.click(screen.getByRole("button", { name: "Open Profile…" }));
  await screen.findByText(`Document: ${document.displayName}`);
  return { bridge, compile, save, previousFrames, ...rendered };
}

describe("TFNC13 profile document custody", () => {
  it("opens v1 with a display name, custody badges, editor data, and fresh compilation", async () => {
    const profile = { ...BUILTIN_FORGE_CONSOLE_PROFILE, name: "Opened V1 Theme" };
    const document = custodyDocument({ displayName: "opened-v1.json", profile });
    const { compile, container } = await openCustodyDocument(document);

    expect(screen.getByText("Schema: tf-paired-profile-v1")).toBeTruthy();
    expect(screen.getByText("Verification: verified")).toBeTruthy();
    expect(screen.getByText("Owner binding: verified (source-bytes)")).toBeTruthy();
    expect(screen.getByText("Studio history: original source")).toBeTruthy();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Opened V1 Theme");
    expect(screen.getByText("Loaded profile from opened-v1.json")).toBeTruthy();
    expect(container.textContent).not.toContain("/mock/");
    expect(container.textContent).not.toContain("File:");
    await waitFor(() => expect(compile).toHaveBeenCalledWith(profile, expect.any(Number)));
  });

  it("offers original custody for legacy aliases and canonical edited saving", async () => {
    const document = custodyDocument({
      aliasResolved: true,
      ownerBinding: {
        inputOrigin: "resolved-legacy-alias",
        rawSourceSha256: "e".repeat(64),
        verificationStatus: "verified",
        isTransformed: false,
        byteLength: 521,
        normalizedSha256: "b".repeat(64),
      },
    });
    const { save } = await openCustodyDocument(document);
    save.mockResolvedValue({ cancelled: false, saved: true, document });

    expect(screen.getByText("Alias: schema → schemaVersion")).toBeTruthy();
    expect(screen.getByText("Owner binding: verified (resolved-legacy-alias)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save Original" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ documentId: document.documentId, saveMode: "original" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Save Profile…" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Save Profile…" }));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith({ documentId: document.documentId, saveMode: "edited", profile: document.profile }));
  });

  it("keeps verified v2 in read-only custody, renders schema-faithful v2 inspection without v1 form inputs, clears v1 previews, and saves only original bytes", async () => {
    const v2Mode = {
      canvas: "#09090b",
      canvasText: "#fafafa",
      surface: "#18181b",
      surfaceText: "#fafafa",
      elevatedSurface: "#27272a",
      elevatedSurfaceText: "#fafafa",
      primaryAction: "#02c39a",
      primaryActionText: "#09090b",
      secondaryAction: "#27272a",
      secondaryActionText: "#fafafa",
      mutedSurface: "#09090b",
      mutedText: "#a1a1aa",
      highlight: "#02c39a",
      highlightText: "#09090b",
      danger: "#450a0a",
      dangerText: "#fee2e2",
      border: "#3f3f46",
      fieldBorder: "#27272a",
      focus: "#02c39a",
    };
    const document = custodyDocument({
      displayName: "verified-v2.json",
      schemaVersion: "tf-paired-profile-v2",
      verificationStatus: "verified",
      semantic: "validated",
      canonicalDigest: "c".repeat(64),
      ownerBinding: {
        inputOrigin: "source-bytes",
        rawSourceSha256: "a".repeat(64),
        verificationStatus: "verified",
        isTransformed: false,
        byteLength: 768,
        canonicalDigest: "c".repeat(64),
      },
      editable: false,
      readonlyReason: "V2 editing is unavailable.",
      v2Profile: {
        schemaVersion: "tf-paired-profile-v2",
        name: "Verified V2",
        version: "2.1.0",
        description: "Read-only v2 custody",
        color: { light: v2Mode, dark: v2Mode },
        radius: { control: "0.375rem", surface: "1.25rem", overlay: "1.5rem" },
        spacing: { base: "0.25rem", density: "comfortable" },
        elevation: { emphasis: "raised", borderWidth: "1px", borderStyle: "dashed" },
        code: { frame: "terminal", copy: "minimal", syntax: { dark: { keyword: "#ff55aa" } } },
        reading: { measure: "65rem" },
        navigation: { prominence: "quiet", density: "spacious" },
        targetOverrides: {
          version: "v2",
          loom: {
            content: 4294967296,
            radii: 12,
            border: 2,
            primaryFamily: "cyan",
            secondaryFamily: "orange",
            defaultAccent: "cyan",
            tokenSetKey: "flexoki-palette",
          },
          solarSail: {
            surfaces: { radius: "0.75rem", borderWidth: "1px" },
            palette: { dark: { sidebar: "#101820" } },
          },
          syntax: {
            frame: "editor",
            copy: "standard",
            tabs: { activeIndicator: "accent" },
            syntax: { light: { string: "#22863a" } },
            chrome: { dark: { foreground: "#6a737d" } },
            diffs: { dark: { insertedBackground: "#12261e" } },
          },
        },
      },
    });
    delete document.profile;
    delete document.normalizedSha256;
    const { compile, save, container, previousFrames } = await openCustodyDocument(document);
    save.mockResolvedValue({ cancelled: false, saved: true, document });

    expect(screen.getByText("Verification: verified")).toBeTruthy();
    expect(screen.getByText("Owner binding: verified (source-bytes)")).toBeTruthy();
    expect(screen.getByText("Studio history: original source")).toBeTruthy();
    expect(screen.getByText("Read-only: V2 editing is unavailable.")).toBeTruthy();
    expect(screen.getByText(/verified read-only custody/)).toBeTruthy();

    const inspection = screen.getByTestId("readonly-v2-inspection");
    expect(inspection.textContent).toContain("Verified V2");
    expect(inspection.textContent).toContain("2.1.0");
    expect(inspection.textContent).toContain("65rem");
    expect(inspection.textContent).not.toContain("65px");
    expect(inspection.textContent).not.toContain("704px");
    expect(inspection.textContent).toContain("surface=1.25rem");
    expect(inspection.textContent).toContain("emphasis=raised; borderWidth=1px; borderStyle=dashed");
    expect(inspection.textContent).toContain("frame=terminal; copy=minimal; syntax=light={Not specified}, dark={keyword:#ff55aa}");
    expect(inspection.textContent).toContain("prominence=quiet; density=spacious");
    expect(inspection.textContent).toContain(
      "version=v2; loom.content=4294967296; loom.radii=12; loom.border=2; loom.primaryFamily=cyan; loom.secondaryFamily=orange; loom.defaultAccent=cyan; loom.tokenSetKey=flexoki-palette; solarSail.radius=0.75rem; solarSail.borderWidth=1px; solarSail.palette=light={Not specified}, dark={sidebar:#101820}; syntax.frame=editor; syntax.copy=standard; syntax.tabs=accent; syntax.syntax=light={string:#22863a}, dark={Not specified}; syntax.chrome=light={Not specified}, dark={foreground:#6a737d}; syntax.diffs=light={Not specified}, dark={insertedBackground:#12261e}"
    );
    expect(inspection.textContent).toContain("Typography: Not specified");
    expect(inspection.textContent).toContain("Focus: Not specified");

    expect(container.querySelectorAll(".design-controls-panel input, .design-controls-panel select")).toHaveLength(0);
    expect((screen.getByRole("button", { name: "Compile Theme" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Export Package…" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Load Forge Console" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Save Profile…" })).toBeNull();
    expect(compile).not.toHaveBeenCalled();
    const frames = Array.from(container.querySelectorAll("iframe"));
    expect(frames).toHaveLength(2);
    for (const frame of frames) expect(previousFrames).not.toContain(frame);
    const applicationFrame = screen.getByTitle("Application Theme Live Preview") as HTMLIFrameElement;
    const postMessage = vi.spyOn(applicationFrame.contentWindow!, "postMessage");
    try {
      fireEvent.load(applicationFrame);
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "tfss:apply-theme", css: "" }), "*");
    } finally {
      postMessage.mockRestore();
    }
    fireEvent.click(screen.getByRole("button", { name: "Save Original" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ documentId: document.documentId, saveMode: "original" }));
  });

  it("renders Save Original and schema-faithful read-only v1 inspection for UNSUPPORTED_V1_EXTENSION documents, including missing content", async () => {
    const extProfile = JSON.parse(JSON.stringify(BUILTIN_FORGE_CONSOLE_PROFILE)) as typeof BUILTIN_FORGE_CONSOLE_PROFILE;
    extProfile.name = "Extended V1 Profile";
    extProfile.surfaces = { radius: "0.75rem", borderWidth: "2px" };
    const document = custodyDocument({
      displayName: "extended-v1.json",
      schemaVersion: "tf-paired-profile-v1",
      verificationStatus: "verified",
      semantic: "validated",
      editable: false,
      readonlyReason: "Profile uses v1 extension fields beyond Studio's closed v1 editor contract; opened in read-only custody to prevent silent data loss.",
      diagnosticCode: "UNSUPPORTED_V1_EXTENSION",
      diagnosticSummary: "Profile is owner-valid tf-paired-profile-v1 but contains extension fields outside Studio's v1 DTO.",
      profile: extProfile,
    });
    const { compile, save, container } = await openCustodyDocument(document);
    save.mockResolvedValue({ cancelled: false, saved: true, document });

    expect(screen.getByText("Verification: verified")).toBeTruthy();
    expect(screen.getByText(/Read-only custody: extended-v1\.json \(UNSUPPORTED_V1_EXTENSION\)/)).toBeTruthy();
    const inspection = screen.getByTestId("readonly-v1-inspection");
    expect(inspection.textContent).toContain("Extended V1 Profile");
    expect(inspection.textContent).toContain("0.75rem");
    expect(inspection.textContent).toContain("Unavailable (omitted or not representable by the Studio v1 DTO)");
    expect(inspection.textContent).not.toContain("704px");
    expect(container.querySelectorAll(".design-controls-panel input, .design-controls-panel select")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Save Profile…" })).toBeNull();
    expect(compile).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Save Original" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ documentId: document.documentId, saveMode: "original" }));
  });

  it("ignores stale in-flight saveProfile completion after Reset to Bundled", async () => {
    const document = custodyDocument({ displayName: "before-reset.json" });
    const { save } = await openCustodyDocument(document);
    let resolveSave!: (value: { cancelled: boolean; saved: boolean; document?: AppThemeOpenedDocument }) => void;
    save.mockImplementation(
      () => new Promise((resolve) => {
        resolveSave = resolve;
      })
    );

    fireEvent.click(screen.getByRole("button", { name: "Save Profile…" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset to Bundled" }));
    await screen.findByText("Built-in Profile");

    resolveSave({ cancelled: false, saved: true, document });
    await waitFor(() => expect(screen.getByText("Built-in Profile")).toBeTruthy());
    expect(screen.queryByText("Document: before-reset.json")).toBeNull();
  });

  it("inspects corrupt documents without built-in Forge Console token values or editing/saving, and reset restores bundled editing", async () => {
    const document = custodyDocument({
      displayName: "broken.json", schemaVersion: "corrupt", verificationStatus: "corrupt",
      semantic: "rejected", editable: false,
      diagnosticCode: "INVALID_JSON", diagnosticSummary: "The document contains invalid JSON.",
    });
    delete document.profile;
    delete document.ownerBinding;
    const { compile, save, container } = await openCustodyDocument(document);

    expect(screen.getByText("Inspection only: broken.json (INVALID_JSON)")).toBeTruthy();
    expect(screen.getByText("Owner binding: unavailable")).toBeTruthy();
    const inspection = screen.getByTestId("corrupt-document-inspection");
    expect(inspection.textContent).toContain("broken.json");
    expect(inspection.textContent).toContain("INVALID_JSON");
    expect(inspection.textContent).toContain("The document contains invalid JSON.");
    expect(inspection.textContent).toContain("No profile tokens are available.");
    expect(inspection.textContent).not.toContain("Forge Console");
    expect(inspection.textContent).not.toContain("#69d3e4");
    expect(inspection.textContent).not.toContain("704px");
    expect(container.querySelectorAll(".design-controls-panel input, .design-controls-panel select")).toHaveLength(0);
    for (const name of ["Compile Theme", "Export Package…", "Save Profile…"]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(screen.getByRole("button", { name }));
    }
    expect(screen.getByText("Clean")).toBeTruthy();
    expect(compile).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Reset to Bundled" }));
    await screen.findByText("Built-in Profile");
    expect(screen.queryByText(/Inspection only:/)).toBeNull();
    expect(screen.queryByText("The document contains invalid JSON.")).toBeNull();
    expect((screen.getByLabelText("Name") as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(BUILTIN_FORGE_CONSOLE_PROFILE.name);
    expect((screen.getByRole("button", { name: "Compile Theme" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Export Package…" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Save Profile…" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("opens rejected v1 for repair and saves an edited profile", async () => {
    const profile = { ...BUILTIN_FORGE_CONSOLE_PROFILE, name: "Needs Repair", version: "invalid" };
    const document = custodyDocument({
      profile, semantic: "rejected", verificationStatus: "unverified-assertion",
      diagnosticCode: "INVALID_VERSION", diagnosticSummary: "Version must be semver.",
    });
    delete document.ownerBinding;
    const { compile, save } = await openCustodyDocument(document);
    save.mockResolvedValue({ cancelled: false, saved: true });

    expect(screen.getByText("Version must be semver.")).toBeTruthy();
    expect(screen.getByText(/semantic validation issues/)).toBeTruthy();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Needs Repair");
    expect((screen.getByLabelText("Version") as HTMLInputElement).disabled).toBe(false);
    await waitFor(() => expect(compile).toHaveBeenCalledWith(profile, expect.any(Number)));
    fireEvent.click(screen.getByRole("button", { name: "Save Profile…" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ documentId: document.documentId, saveMode: "edited", profile }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Save Profile…" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Version"), { target: { value: "1.0.0" } });
    expect(screen.getByText("Unsaved Changes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save Profile…" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({
      documentId: document.documentId, saveMode: "edited", profile: { ...profile, version: "1.0.0" },
    }));
  });

  it("shows 'Not set' for omitted surfaces.content in editable v1 until edited", async () => {
    const profile = JSON.parse(JSON.stringify(BUILTIN_FORGE_CONSOLE_PROFILE)) as typeof BUILTIN_FORGE_CONSOLE_PROFILE;
    delete profile.surfaces.content;
    const document = custodyDocument({ displayName: "no-content.json", profile });
    await openCustodyDocument(document);

    expect(screen.getByText("Reading Content Measure: Not set")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Reading Content Measure"), { target: { value: "768" } });
    expect(screen.getByText("Reading Content Measure: 768px")).toBeTruthy();
  });

  it("defaults clean unavailable v1 document to Save Original and preserves dirty state when Save Original is clicked on a dirty editable v1 document", async () => {
    const document = custodyDocument({
      displayName: "unavailable-v1.json",
      semantic: "unavailable",
      verificationStatus: "unverified-assertion",
    });
    delete document.ownerBinding;
    const { save } = await openCustodyDocument(document);
    save.mockResolvedValue({ cancelled: false, saved: true, document });

    // Clean unavailable v1 defaults Save Profile… to "original" so raw bytes are preserved
    fireEvent.click(screen.getByRole("button", { name: "Save Profile…" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ documentId: document.documentId, saveMode: "original" }));

    // Edit Name so dirty is true; clicking Save Original preserves dirty state
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Dirty Local Edit" } });
    expect(screen.getByText("Unsaved Changes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save Original" }));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith({ documentId: document.documentId, saveMode: "original" }));
    await waitFor(() => expect(screen.getByText(/Saved original source to unavailable-v1\.json \(unsaved editor changes remain\)/)).toBeTruthy());
    expect(screen.getByText("Unsaved Changes")).toBeTruthy();
  });

  it("retains dirty state when an edited save fails or is cancelled, and displays transformed Studio history separately from verified Owner binding after a successful edited save", async () => {
    const document = custodyDocument({ displayName: "editable-v1.json" });
    const { save } = await openCustodyDocument(document);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Edited Theme Name" } });
    expect(screen.getByText("Unsaved Changes")).toBeTruthy();

    // 1. Save fails -> dirty remains true
    save.mockResolvedValueOnce({
      cancelled: false,
      saved: false,
      error: "Sidecar process crashed or exited unexpectedly",
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Profile…" }));
    await waitFor(() => expect(screen.getByText("Save failed: Sidecar process crashed or exited unexpectedly")).toBeTruthy());
    expect(screen.getByText("Unsaved Changes")).toBeTruthy();

    // 2. Save cancelled -> dirty remains true
    save.mockResolvedValueOnce({ cancelled: true, saved: false });
    fireEvent.click(screen.getByRole("button", { name: "Save Profile…" }));
    await waitFor(() => expect(screen.getByText("Save profile cancelled.")).toBeTruthy());
    expect(screen.getByText("Unsaved Changes")).toBeTruthy();

    // 3. Save succeeds -> dirty becomes false, Owner binding is verified (source-bytes), Studio history is transformed from parent
    const savedDoc = custodyDocument({
      displayName: "editable-v1.json",
      verificationStatus: "transformed",
      isTransformed: true,
      parentSourceSha256: "a".repeat(64),
      rawSourceSha256: "d".repeat(64),
      normalizedSha256: "e".repeat(64),
      ownerBinding: {
        inputOrigin: "source-bytes",
        rawSourceSha256: "d".repeat(64),
        verificationStatus: "verified",
        isTransformed: false,
        byteLength: 530,
        normalizedSha256: "e".repeat(64),
      },
    });
    save.mockResolvedValueOnce({ cancelled: false, saved: true, document: savedDoc });
    fireEvent.click(screen.getByRole("button", { name: "Save Profile…" }));
    await waitFor(() => expect(screen.getByText("Saved profile to editable-v1.json")).toBeTruthy());
    expect(screen.getByText("Clean")).toBeTruthy();
    expect(screen.getByText("Verification: transformed")).toBeTruthy();
    expect(screen.getByText("Owner binding: verified (source-bytes)")).toBeTruthy();
    expect(screen.getByText(`Studio history: transformed from ${"a".repeat(64)}`)).toBeTruthy();
  });
});

