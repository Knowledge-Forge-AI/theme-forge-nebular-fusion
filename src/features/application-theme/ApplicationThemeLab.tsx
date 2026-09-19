import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TauriAppThemeBridge } from "./app-theme-bridge";
import { BUILTIN_FORGE_CONSOLE_PROFILE } from "./builtin-profiles";
import { ApplicationPreview } from "./ApplicationPreview";
import { StarlightPreview } from "../theme-lab/StarlightPreview";
import type {
  AppThemeBridge,
  AppThemeStatus,
  PairedProfile,
  ThemeDiagnostic,
} from "./types";

export function ApplicationThemeLab({
  bridge: propBridge,
}: {
  bridge?: AppThemeBridge | undefined;
}) {
  const bridge = useMemo(() => propBridge ?? new TauriAppThemeBridge(), [propBridge]);
  const [status, setStatus] = useState<AppThemeStatus | null>(null);
  const [profile, setProfile] = useState<PairedProfile>(() => JSON.parse(JSON.stringify(BUILTIN_FORGE_CONSOLE_PROFILE)));
  const [viewMode, setViewMode] = useState<"application" | "paired">("paired");
  const [themeMode, setThemeMode] = useState<"light" | "dark">("dark");
  const [solarSailCss, setSolarSailCss] = useState<string>("");
  const [starlightCss, setStarlightCss] = useState<string>("");
  const [currentSolarSailCss, setCurrentSolarSailCss] = useState<string | null>(null);
  const [currentStarlightCss, setCurrentStarlightCss] = useState<string | null>(null);
  const [revision, setRevision] = useState<number>(1);
  const [compiledEditRev, setCompiledEditRev] = useState<number>(0);
  const [dirty, setDirty] = useState<boolean>(false);
  const [diagnostics, setDiagnostics] = useState<ThemeDiagnostic[]>([]);
  const [isCompiling, setIsCompiling] = useState<boolean>(false);
  const [adoptedDigest, setAdoptedDigest] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState<boolean>(false);
  const [exportLang, setExportLang] = useState<"typescript" | "javascript">("typescript");
  const [stellarLoomError, setStellarLoomError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await bridge.getStatus();
      setStatus(s);
    } catch {
      setStatus(null);
    }
  }, [bridge]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  // Finding A & C: Separate document edit revision from compile operation ID
  const editRevRef = useRef<number>(1);
  const compileOpSeqRef = useRef<number>(0);
  const activeCompileOpIdRef = useRef<number | null>(null);
  const isMountedRef = useRef<boolean>(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (typeof document !== "undefined") {
        if ((window as any).__selfThemeAdoptedSheet) {
          const sheet = (window as any).__selfThemeAdoptedSheet;
          if (document.adoptedStyleSheets) {
            document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s: CSSStyleSheet) => s !== sheet);
          }
          delete (window as any).__selfThemeAdoptedSheet;
        }
        const styleEl = document.getElementById("self-theme-draft-style");
        if (styleEl && styleEl.parentNode) {
          styleEl.parentNode.removeChild(styleEl);
        }
        if (document.body) {
          document.body.classList.remove("self-theme");
        }
      }
    };
  }, []);

  const runCompile = useCallback(async () => {
    const opId = ++compileOpSeqRef.current;
    activeCompileOpIdRef.current = opId;
    const targetEditRev = editRevRef.current;
    const compileProfile = profile;

    setIsCompiling(true);
    setActionMessage(null);

    try {
      if (viewMode === "paired") {
        const result = await bridge.pairedCompile(compileProfile, targetEditRev);
        if (activeCompileOpIdRef.current !== opId || editRevRef.current !== targetEditRev) {
          return;
        }

        const ssValid = Boolean(result.solarSail?.compiledCss) && !(result.solarSail?.diagnostics?.some((d) => d.severity === "error"));
        const loomValid = Boolean(result.stellarLoom?.compiledCss) && !result.stellarLoom?.error;
        const loomErr = result.stellarLoom?.error;

        setRevision(targetEditRev);
        setCompiledEditRev(targetEditRev);

        if (result.solarSail?.compiledCss) {
          if (ssValid) {
            setSolarSailCss(result.solarSail.compiledCss);
            setCurrentSolarSailCss(result.solarSail.compiledCss);
          } else {
            setCurrentSolarSailCss(null);
          }
        } else {
          setCurrentSolarSailCss(null);
        }

        if (result.stellarLoom?.compiledCss) {
          if (loomValid) {
            setStarlightCss(result.stellarLoom.compiledCss);
            setCurrentStarlightCss(result.stellarLoom.compiledCss);
          } else {
            setCurrentStarlightCss(null);
          }
        } else {
          setCurrentStarlightCss(null);
        }

        if (loomErr) {
          setStellarLoomError(loomErr);
        } else {
          setStellarLoomError(null);
        }

        setDiagnostics(result.solarSail?.diagnostics || []);

        // Finding D: Truthful status derived from actual per-engine outcomes
        if (ssValid && loomValid) {
          setActionMessage("Paired theme compilation succeeded.");
        } else if (ssValid && loomErr) {
          setActionMessage(
            `Solar Sail succeeded; Stellar Loom unavailable (${loomErr}). Showing last good preview.`
          );
        } else if (ssValid && !loomValid) {
          setActionMessage("Solar Sail succeeded; Stellar Loom yielded no output.");
        } else if (!ssValid && loomValid) {
          setActionMessage("Solar Sail compilation reported issues; Stellar Loom succeeded.");
        } else {
          setActionMessage("Both Solar Sail and Stellar Loom compilation reported issues.");
        }
      } else {
        setStellarLoomError(null);
        const result = await bridge.compile(compileProfile, targetEditRev);
        if (!isMountedRef.current || activeCompileOpIdRef.current !== opId || editRevRef.current !== targetEditRev) {
          return;
        }

        const ssValid = Boolean(result.compiledCss) && !(result.diagnostics?.some((d) => d.severity === "error"));

        setRevision(targetEditRev);
        setCompiledEditRev(targetEditRev);

        if (result.compiledCss) {
          if (ssValid) {
            setSolarSailCss(result.compiledCss);
            setCurrentSolarSailCss(result.compiledCss);
          } else {
            setCurrentSolarSailCss(null);
          }
        } else {
          setCurrentSolarSailCss(null);
        }

        setDiagnostics(result.diagnostics || []);
        setActionMessage(ssValid ? "Application theme compilation succeeded." : "Compilation reported issues.");
      }
    } catch (err: any) {
      if (isMountedRef.current && activeCompileOpIdRef.current === opId && editRevRef.current === targetEditRev) {
        setActionMessage(`Compilation error: ${err?.message || err}`);
      }
    } finally {
      // Finding A: Always clear busy state for current operation without stranding Compile button
      if (activeCompileOpIdRef.current === opId) {
        activeCompileOpIdRef.current = null;
        if (isMountedRef.current) {
          setIsCompiling(false);
          void refreshStatus();
        }
      }
    }
  }, [bridge, profile, viewMode, refreshStatus]);

  // Initial compilation on mount
  useEffect(() => {
    void runCompile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleProfileChange = (updater: (prev: PairedProfile) => PairedProfile) => {
    editRevRef.current += 1;
    setCurrentSolarSailCss(null);
    setCurrentStarlightCss(null);
    setProfile(updater);
    setDirty(true);
  };

  const handleReset = async () => {
    editRevRef.current += 1;
    try {
      await bridge.reset();
    } catch {
      // Keep reset usable even when compiler backend is offline
    }
    setProfile(JSON.parse(JSON.stringify(BUILTIN_FORGE_CONSOLE_PROFILE)));
    setDirty(false);
    setAdoptedDigest(null);
    setStellarLoomError(null);
    setCurrentSolarSailCss(null);
    setCurrentStarlightCss(null);
    setSolarSailCss("");
    setStarlightCss("");

    // Finding B: Owned stylesheet cleanup and complete detachment
    if (typeof document !== "undefined") {
      if ((window as any).__selfThemeAdoptedSheet) {
        const sheet = (window as any).__selfThemeAdoptedSheet;
        if (document.adoptedStyleSheets) {
          document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s: CSSStyleSheet) => s !== sheet);
        }
        delete (window as any).__selfThemeAdoptedSheet;
      }
      const styleEl = document.getElementById("self-theme-draft-style");
      if (styleEl && styleEl.parentNode) {
        styleEl.parentNode.removeChild(styleEl);
      }
      if (document.body) {
        document.body.classList.remove("self-theme");
        const toRemove: string[] = [];
        for (let i = 0; i < document.body.style.length; i++) {
          const prop = document.body.style[i];
          if (prop && prop.startsWith("--theme-")) {
            toRemove.push(prop);
          }
        }
        for (const prop of toRemove) {
          document.body.style.removeProperty(prop);
        }
        document.body.style.removeProperty("--theme-primary");
        document.body.style.removeProperty("--theme-bg");
        document.body.style.removeProperty("--theme-fg");
      }
    }
    if (isMountedRef.current) {
      setActionMessage("Reset to default self-theme.");
      void refreshStatus();
    }
  };

  const handleOpenProfile = async () => {
    const openRev = editRevRef.current;
    try {
      const res = await bridge.openProfile();
      if (!isMountedRef.current) return;
      if (!res.cancelled && res.profile) {
        if (editRevRef.current === openRev) {
          editRevRef.current += 1;
          setProfile(res.profile);
          setDirty(false);
          setAdoptedDigest(null);
          setCurrentSolarSailCss(null);
          setCurrentStarlightCss(null);
          setActionMessage(`Opened profile: ${res.displayName || res.filePath || "profile.json"}`);
        } else {
          setActionMessage("Open ignored: document was modified while opening.");
        }
      } else if (res.cancelled) {
        setActionMessage("Open profile cancelled.");
      } else if (res.error) {
        setActionMessage(`Open failed: ${res.error}`);
      }
    } catch (err: any) {
      if (isMountedRef.current) {
        setActionMessage(`Open failed: ${err?.message || err}`);
      }
    }
  };

  const handleSaveProfile = async (saveAs: boolean = false) => {
    const saveRev = editRevRef.current;
    const saveSnapshot = profile;
    try {
      const res = await bridge.saveProfile(saveSnapshot, saveAs);
      if (!isMountedRef.current) return;
      if (!res.cancelled && !res.error && res.filePath) {
        if (editRevRef.current === saveRev) {
          setDirty(false);
          setActionMessage(`Saved profile to: ${res.filePath}`);
        } else {
          setActionMessage(`Saved earlier snapshot to ${res.filePath} (newer unsaved changes present)`);
        }
      } else if (res.error) {
        setActionMessage(`Save failed: ${res.error}`);
      } else if (res.cancelled) {
        setActionMessage("Save profile cancelled.");
      }
    } catch (err: any) {
      if (isMountedRef.current) {
        setActionMessage(`Save failed: ${err?.message || err}`);
      }
    }
  };

  // Synchronous deterministic content digest for theme output identity
  const computeDigest = (content: string): string => {
    let hash = 5381;
    for (let i = 0; i < content.length; i++) {
      hash = ((hash << 5) + hash) + content.charCodeAt(i);
      hash = hash & hash;
    }
    return `draft-${(hash >>> 0).toString(16)}`;
  };

  const handleAdoptDraft = () => {
    if (!currentSolarSailCss || diagnostics.some((d) => d.severity === "error")) {
      setActionMessage("Cannot adopt draft: valid compilation is required.");
      return;
    }
    if (compiledEditRev !== editRevRef.current) {
      setActionMessage("Cannot adopt draft: current edits require recompilation.");
      return;
    }

    const digest = computeDigest(currentSolarSailCss);

    if (typeof document !== "undefined" && document.body) {
      try {
        if (typeof CSSStyleSheet !== "undefined" && "adoptedStyleSheets" in document) {
          let adoptedSheet = (window as any).__selfThemeAdoptedSheet;
          const currentSheets = (document.adoptedStyleSheets as any) || [];
          if (!adoptedSheet || (typeof currentSheets.includes === "function" && !currentSheets.includes(adoptedSheet))) {
            adoptedSheet = new CSSStyleSheet();
            (window as any).__selfThemeAdoptedSheet = adoptedSheet;
            document.adoptedStyleSheets = [...currentSheets.filter((s: any) => s !== adoptedSheet), adoptedSheet];
          }
          adoptedSheet.replaceSync(currentSolarSailCss);
        } else {
          let styleEl = document.getElementById("self-theme-draft-style");
          if (!styleEl) {
            styleEl = document.createElement("style");
            styleEl.id = "self-theme-draft-style";
            document.head.appendChild(styleEl);
          }
          styleEl.textContent = currentSolarSailCss;
        }
        document.body.classList.add("self-theme");
      } catch (err: any) {
        setActionMessage(`Failed to apply compiled stylesheet: ${err?.message || err}`);
        return;
      }
    }
    setAdoptedDigest(digest);
    setActionMessage(`Adopted theme candidate as unsaved draft (${digest}).`);
  };

  const handleExport = async () => {
    try {
      const res = await bridge.exportPackage(profile, exportLang);
      if (!isMountedRef.current) return;

      if (!res.cancelled && !res.error && res.destination) {
        setExportOpen(false);
        setActionMessage(`Exported ${exportLang.toUpperCase()} package (${res.fileCount ?? 0} files) to ${res.destination}`);
      } else if (res.error) {
        setActionMessage(`Export failed: ${res.error}`);
      } else if (res.cancelled) {
        setActionMessage("Package export cancelled.");
      }
    } catch (err: any) {
      if (isMountedRef.current) {
        setActionMessage(`Export error: ${err?.message || err}`);
      }
    }
  };

  const currentColors = profile.palette[themeMode];

  return (
    <div className="application-theme-lab">
      {/* Header & Status Bar */}
      <header className="theme-lab-header">
        <div>
          <h2>Application Theme Lab</h2>
          <p className="section-kicker">
            Tailwind CSS v4 & shadcn/ui Theme Builder · Paired Engine Integration
          </p>
        </div>

        <div className="theme-lab-status-strip">
          <span className={`status-badge ${status?.available ? "success" : "warning"}`}>
            Solar Sail {status?.available ? "Available" : "Degraded"}
          </span>
          <span className="meta-badge">Rev: {revision}</span>
          <span className={`meta-badge ${dirty ? "warning" : "success"}`}>
            {dirty ? "Unsaved Changes" : adoptedDigest ? "Adopted Draft" : "Clean"}
          </span>
        </div>
      </header>

      {/* Engine degraded notice */}
      {status && !status.available ? (
        <div className="panel bootstrap-error" role="alert">
          <h3>Solar Sail Compiler Degraded</h3>
          <p>{status.message || "Compiler backend is offline. Preview and fallback self-theme remain active."}</p>
          <button type="button" className="btn-secondary" onClick={handleReset}>
            Reset to Bundled Self-Theme
          </button>
        </div>
      ) : null}

      {/* Action feedback message */}
      {actionMessage ? (
        <div className="panel action-banner" role="status" style={{ padding: "0.75rem 1rem", marginBottom: "1rem" }}>
          <span>{actionMessage}</span>
        </div>
      ) : null}

      {/* Toolbar Controls */}
      <div className="host-controls" style={{ marginBottom: "1.5rem" }}>
        <button
          type="button"
          onClick={() => {
            editRevRef.current += 1;
            setCurrentSolarSailCss(null);
            setCurrentStarlightCss(null);
            setProfile(JSON.parse(JSON.stringify(BUILTIN_FORGE_CONSOLE_PROFILE)));
            setDirty(true);
            setActionMessage("Loaded built-in Forge Console profile.");
          }}
        >
          Load Forge Console
        </button>
        <button type="button" onClick={() => void handleOpenProfile()}>
          Open Profile…
        </button>
        <button type="button" onClick={() => void handleSaveProfile(false)}>
          Save Profile…
        </button>

        <button type="button" onClick={handleReset}>
          Reset to Self-Theme
        </button>
        <button type="button" onClick={handleAdoptDraft}>
          Adopt as Draft
        </button>
        <button type="button" onClick={() => setExportOpen(true)}>
          Export Package…
        </button>
        <button
          type="button"
          className="btn-primary"
          style={{ marginLeft: "auto" }}
          disabled={isCompiling}
          onClick={runCompile}
        >
          {isCompiling ? "Compiling…" : "Compile Theme"}
        </button>
      </div>

      {/* Export Modal / Dialog */}
      {exportOpen ? (
        <div className="panel export-dialog" role="dialog" aria-label="Export Theme Package" style={{ padding: "1.5rem", marginBottom: "1.5rem", border: "1px solid #f6c65b" }}>
          <h3>Export Theme Package</h3>
          <p style={{ fontSize: "0.875rem", color: "#bcb3ce" }}>
            Export generated package source directory. An unbuilt TypeScript package contains source and tsconfig; run build before distribution. Destination directory is selected via native system directory picker.
          </p>
          <div style={{ display: "flex", gap: "1rem", alignItems: "center", margin: "1rem 0" }}>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              Language:
              <select
                aria-label="Export Language"
                value={exportLang}
                onChange={(e) => setExportLang(e.target.value as "typescript" | "javascript")}
              >
                <option value="typescript">TypeScript (Source + tsconfig)</option>
                <option value="javascript">JavaScript (Zero-build Runtime)</option>
              </select>
            </label>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
            <button type="button" onClick={() => setExportOpen(false)}>Cancel</button>
            <button type="button" className="btn-primary" onClick={handleExport}>Select Destination & Export</button>
          </div>
        </div>
      ) : null}


      {/* Mode Switcher */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
        <div className="segmented-control" role="group" aria-label="Preview layout mode">
          <button
            type="button"
            className={viewMode === "application" ? "active" : ""}
            aria-pressed={viewMode === "application"}
            onClick={() => setViewMode("application")}
          >
            Application Preview Only
          </button>
          <button
            type="button"
            className={viewMode === "paired" ? "active" : ""}
            aria-pressed={viewMode === "paired"}
            onClick={() => setViewMode("paired")}
          >
            Paired Comparison (Solar Sail + Loom)
          </button>
        </div>

        <div className="segmented-control" role="group" aria-label="Editor color scheme mode">
          {(["dark", "light"] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={themeMode === m ? "active" : ""}
              aria-pressed={themeMode === m}
              onClick={() => setThemeMode(m)}
            >
              Edit {m === "dark" ? "Dark" : "Light"} Palette
            </button>
          ))}
        </div>
      </div>

      {/* Main Workspace: Controls & Previews */}
      <div className="app-theme-lab-workspace">
        {/* Design Controls Column */}
        <aside className="panel design-controls-panel" style={{ padding: "1.5rem" }}>
          <h3 style={{ fontSize: "1.1rem", marginBottom: "1rem" }}>Design Tokens ({themeMode})</h3>

          <div style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
            <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>Primary</span>
              <input
                type="color"
                value={currentColors.primary}
                onChange={(e) => {
                  const val = e.target.value;
                  handleProfileChange((prev) => ({
                    ...prev,
                    palette: {
                      ...prev.palette,
                      [themeMode]: { ...prev.palette[themeMode], primary: val, ring: val },
                    },
                  }));
                }}
              />
            </label>

            <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>Accent</span>
              <input
                type="color"
                value={currentColors.accent}
                onChange={(e) => {
                  const val = e.target.value;
                  handleProfileChange((prev) => ({
                    ...prev,
                    palette: {
                      ...prev.palette,
                      [themeMode]: { ...prev.palette[themeMode], accent: val },
                    },
                  }));
                }}
              />
            </label>

            <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>Background</span>
              <input
                type="color"
                value={currentColors.background}
                onChange={(e) => {
                  const val = e.target.value;
                  handleProfileChange((prev) => ({
                    ...prev,
                    palette: {
                      ...prev.palette,
                      [themeMode]: { ...prev.palette[themeMode], background: val },
                    },
                  }));
                }}
              />
            </label>

            <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>Foreground</span>
              <input
                type="color"
                value={currentColors.foreground}
                onChange={(e) => {
                  const val = e.target.value;
                  handleProfileChange((prev) => ({
                    ...prev,
                    palette: {
                      ...prev.palette,
                      [themeMode]: { ...prev.palette[themeMode], foreground: val },
                    },
                  }));
                }}
              />
            </label>

            <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>Card Surface</span>
              <input
                type="color"
                value={currentColors.card}
                onChange={(e) => {
                  const val = e.target.value;
                  handleProfileChange((prev) => ({
                    ...prev,
                    palette: {
                      ...prev.palette,
                      [themeMode]: { ...prev.palette[themeMode], card: val },
                    },
                  }));
                }}
              />
            </label>

            <hr style={{ border: "none", borderTop: "1px solid #3e3159", margin: "0.5rem 0" }} />

            <label style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
              <span>Corner Radius: {profile.surfaces.radius}</span>
              <select
                value={profile.surfaces.radius}
                onChange={(e) => {
                  const r = e.target.value;
                  handleProfileChange((prev) => ({
                    ...prev,
                    surfaces: { ...prev.surfaces, radius: r },
                  }));
                }}
              >
                <option value="0.25rem">0.25rem (Compact)</option>
                <option value="0.5rem">0.5rem (Standard / Medium)</option>
                <option value="0.75rem">0.75rem (Rounded)</option>
                <option value="1rem">1rem (Pill / Large)</option>
              </select>
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
              <span>Reading Content Measure: {profile.surfaces.content ?? 704}px</span>
              <input
                type="range"
                min={576}
                max={960}
                step={32}
                value={profile.surfaces.content ?? 704}
                onChange={(e) => {
                  const c = Number(e.target.value);
                  handleProfileChange((prev) => ({
                    ...prev,
                    surfaces: { ...prev.surfaces, content: c },
                  }));
                }}
              />
            </label>
          </div>

          {diagnostics.length > 0 ? (
            <div style={{ marginTop: "1.5rem" }}>
              <h4>Diagnostics</h4>
              <ul style={{ paddingLeft: "1.2rem", fontSize: "0.8rem", color: "#f6c65b" }}>
                {diagnostics.map((d, i) => (
                  <li key={i}>{d.message}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </aside>

        {/* Live Previews Column */}
        <section className="previews-column" style={{ display: "flex", flexDirection: "column", gap: "2rem" }}>
          {/* Application Preview */}
          <div className="panel" style={{ padding: "1.5rem" }}>
            <h3 style={{ fontSize: "1rem", marginBottom: "0.5rem", color: "#b8a9ff" }}>
              Solar Sail Application Preview (Tailwind v4 / shadcn-style adaptations)
            </h3>

            <ApplicationPreview
              css={solarSailCss}
              revision={revision}
              mode={themeMode}
              onModeChange={setThemeMode}
              stale={currentSolarSailCss === null || compiledEditRev !== editRevRef.current || isCompiling}
            />
          </div>

          {/* Paired Starlight Preview (when in paired mode) */}
          {viewMode === "paired" ? (
            <div className="panel" style={{ padding: "1.5rem" }}>
              <h3 style={{ fontSize: "1rem", marginBottom: "0.5rem", color: "#b8a9ff", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <span>Stellar Loom Documentation Preview (Starlight v0.42 / Reading Layout)</span>
                {stellarLoomError ? (
                  <span className="status-badge warning" style={{ fontSize: "0.75rem", padding: "0.2rem 0.5rem" }}>
                    Stale / Unavailable: {stellarLoomError}
                  </span>
                ) : null}
              </h3>
              <StarlightPreview
                css={starlightCss}
                revision={revision}
                mode={themeMode}
                onModeChange={setThemeMode}
                isLastGood={Boolean(stellarLoomError) || currentStarlightCss === null || compiledEditRev !== editRevRef.current}
              />
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
