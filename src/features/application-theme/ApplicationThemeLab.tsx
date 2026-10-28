import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TauriAppThemeBridge } from "./app-theme-bridge";
import { BUILTIN_FORGE_CONSOLE_PROFILE } from "./builtin-profiles";
import { ApplicationPreview } from "./ApplicationPreview";
import { StarlightPreview } from "../theme-lab/StarlightPreview";
import type {
  AppThemeBridge,
  AppThemeStatus,
  AppThemeOpenedDocument,
  AppThemeSaveProfileRequest,
  ProfileSaveMode,
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
  const [activeDocument, setActiveDocument] = useState<AppThemeOpenedDocument | null>(null);
  const isReadOnly = activeDocument !== null && !activeDocument.editable;
  const [errors, setErrors] = useState<string[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [viewMode, setViewMode] = useState<"application" | "paired">("paired");
  const [themeMode, setThemeMode] = useState<"light" | "dark">("dark");
  const [solarSailCss, setSolarSailCss] = useState<string>("");
  const [starlightCss, setStarlightCss] = useState<string>("");
  const [currentSolarSailCss, setCurrentSolarSailCss] = useState<string | null>(null);
  const [currentStarlightCss, setCurrentStarlightCss] = useState<string | null>(null);
  const [revision, setRevision] = useState<number>(1);
  const [compiledEditRev, setCompiledEditRev] = useState<number | null>(null);
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
  const docGenRef = useRef<number>(0);
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

  const runCompile = useCallback(async (
    compileProfile: PairedProfile = profile,
    targetEditRev: number = editRevRef.current,
    preserveDocumentMessage: boolean = false,
  ) => {
    if (isReadOnly && compileProfile === profile) return;
    const opId = ++compileOpSeqRef.current;
    activeCompileOpIdRef.current = opId;

    setIsCompiling(true);
    if (!preserveDocumentMessage) setActionMessage(null);

    try {
      if (viewMode === "paired") {
        const result = await bridge.pairedCompile(compileProfile, targetEditRev);
        if (!isMountedRef.current || activeCompileOpIdRef.current !== opId || editRevRef.current !== targetEditRev) {
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
        if (preserveDocumentMessage) {
          // Opening feedback and custody diagnostics remain visible after compilation.
        } else if (ssValid && loomValid) {
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
        if (!preserveDocumentMessage) {
          setActionMessage(ssValid ? "Application theme compilation succeeded." : "Compilation reported issues.");
        }
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
  }, [bridge, profile, viewMode, refreshStatus, isReadOnly]);

  // Initial compilation on mount
  useEffect(() => {
    void runCompile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleProfileChange = (updater: (prev: PairedProfile) => PairedProfile) => {
    if (isReadOnly) return;
    editRevRef.current += 1;
    setCurrentSolarSailCss(null);
    setCurrentStarlightCss(null);
    setProfile(updater);
    setDirty(true);
  };

  const handleReset = async () => {
    editRevRef.current += 1;
    docGenRef.current += 1;
    try {
      await bridge.reset();
    } catch {
      // Keep reset usable even when compiler backend is offline
    }
    if (!isMountedRef.current) return;
    setActiveDocument(null);
    setErrors([]);
    setDiagnostics([]);
    setCompiledEditRev(null);
    setExportOpen(false);
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
      if (res.cancelled) {
        setActionMessage("Open profile cancelled.");
        return;
      }
      if (res.error) {
        setErrors([res.error]);
        setActionMessage(null);
        return;
      }
      if (res.document) {
        if (editRevRef.current !== openRev) {
          setActionMessage("Open ignored: document was modified while opening.");
          return;
        }
        editRevRef.current += 1;
        docGenRef.current += 1;
        const newRev = editRevRef.current;
        const document = res.document;
        activeCompileOpIdRef.current = null;
        setIsCompiling(false);
        setActiveDocument(document);
        setDirty(false);
        setCompiledEditRev(null);
        setAdoptedDigest(null);
        setCurrentSolarSailCss(null);
        setCurrentStarlightCss(null);
        setSolarSailCss("");
        setStarlightCss("");
        setDiagnostics([]);
        setStellarLoomError(null);
        setExportOpen(false);
        if (document.editable && document.profile) {
          setProfile(document.profile);
          if (document.semantic === "rejected") {
            setErrors([document.diagnosticSummary ?? "Profile has semantic validation issues."]);
            setActionMessage(`Loaded profile from ${document.displayName} (semantic validation issues)`);
          } else {
            setErrors([]);
            setActionMessage(`Loaded profile from ${document.displayName}`);
          }
          void runCompile(document.profile, newRev, true);
        } else if (document.schemaVersion === "tf-paired-profile-v2") {
          setErrors([]);
          setActionMessage(`Opened ${document.displayName} (tf-paired-profile-v2 · verified read-only custody)`);
        } else if (document.schemaVersion === "tf-paired-profile-v1") {
          const reason = document.diagnosticSummary ?? document.readonlyReason ?? "Profile uses v1 extension fields and is in read-only custody.";
          setErrors([reason]);
          setActionMessage(`Read-only custody: ${document.displayName} (${document.diagnosticCode ?? "READ_ONLY_V1"})`);
        } else {
          const diagnostic = document.diagnosticSummary ?? document.readonlyReason ?? "Document is corrupt and cannot be edited.";
          setErrors([diagnostic]);
          setActionMessage(`Inspection only: ${document.displayName} (${document.diagnosticCode ?? "CORRUPT_DOCUMENT"})`);
        }
      }
    } catch (err: any) {
      if (isMountedRef.current) {
        setErrors([`Open failed: ${err?.message || err}`]);
        setActionMessage(null);
      }
    }
  };

  const handleSaveProfile = async (modeOverride?: ProfileSaveMode) => {
    if (activeDocument?.schemaVersion === "corrupt" || isSaving) return;
    const saveMode: ProfileSaveMode =
      activeDocument !== null && !activeDocument.editable
        ? "original"
        : (modeOverride ?? (
            activeDocument === null ? "new-document"
              : !dirty && !activeDocument.aliasResolved && activeDocument.semantic !== "rejected" ? "original"
              : "edited"
          ));
    const request: AppThemeSaveProfileRequest = {
      saveMode,
      ...(activeDocument ? { documentId: activeDocument.documentId } : {}),
      ...(saveMode !== "original" ? { profile } : {}),
    };
    const saveRev = editRevRef.current;
    const saveDocGen = docGenRef.current;
    setIsSaving(true);
    try {
      const res = await bridge.saveProfile(request);
      if (!isMountedRef.current || docGenRef.current !== saveDocGen) return;
      if (res.cancelled) {
        setActionMessage("Save profile cancelled.");
      } else if (res.error) {
        setErrors([res.error]);
        setActionMessage(`Save failed: ${res.error}`);
      } else if (res.saved) {
        if (res.document) setActiveDocument(res.document);
        const label = res.document?.displayName ?? activeDocument?.displayName ?? "profile";
        if (saveMode === "original" && dirty) {
          setActionMessage(`Saved original source to ${label} (unsaved editor changes remain)`);
        } else if (editRevRef.current === saveRev) {
          setDirty(false);
          setActionMessage(`Saved profile to ${label}`);
        } else {
          setActionMessage(`Saved earlier snapshot to ${label} (newer unsaved changes present)`);
        }
      }
    } catch (err: any) {
      if (isMountedRef.current && docGenRef.current === saveDocGen) {
        setErrors([`Save failed: ${err?.message || err}`]);
      }
    } finally {
      if (isMountedRef.current) setIsSaving(false);
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
    if (isReadOnly) return;
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
    if (isReadOnly || isExporting) return;
    setIsExporting(true);
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
    } finally {
      if (isMountedRef.current) setIsExporting(false);
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
          {activeDocument ? (
            <>
              <span className="meta-badge">Document: {activeDocument.displayName}</span>
              <span className="meta-badge">Schema: {activeDocument.schemaVersion}</span>
              <span className="meta-badge">Verification: {activeDocument.verificationStatus}</span>
              <span className="meta-badge">
                Owner binding:{" "}
                {activeDocument.ownerBinding
                  ? `${activeDocument.ownerBinding.verificationStatus} (${activeDocument.ownerBinding.inputOrigin})`
                  : "unavailable"}
              </span>
              <span className="meta-badge">
                Studio history:{" "}
                {activeDocument.isTransformed
                  ? `transformed from ${activeDocument.parentSourceSha256 ?? "prior source"}`
                  : "original source"}
              </span>
              {activeDocument.aliasResolved ? <span className="meta-badge">Alias: schema → schemaVersion</span> : null}
              {activeDocument.readonlyReason ? <span className="meta-badge">Read-only: {activeDocument.readonlyReason}</span> : null}
            </>
          ) : <span className="meta-badge">Built-in Profile</span>}
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

      {errors.length > 0 ? (
        <div className="panel bootstrap-error" role="alert">
          {errors.map((error, index) => <p key={index}>{error}</p>)}
        </div>
      ) : null}

      {/* Toolbar Controls */}
      <div className="host-controls theme-lab-actions" style={{ marginBottom: "1.5rem" }}>
        <button
          type="button"
          disabled={isReadOnly}
          onClick={() => {
            if (isReadOnly) return;
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
        {activeDocument !== null && !activeDocument.editable && activeDocument.schemaVersion !== "corrupt" ? (
          <button type="button" onClick={() => void handleSaveProfile("original")} disabled={isSaving}>
            Save Original
          </button>
        ) : (
          <>
            <button type="button" onClick={() => void handleSaveProfile()} disabled={isSaving || activeDocument?.schemaVersion === "corrupt"}>
              Save Profile…
            </button>
            {activeDocument !== null && activeDocument.editable && (activeDocument.aliasResolved || activeDocument.semantic === "rejected" || dirty) ? (
              <button type="button" onClick={() => void handleSaveProfile("original")} disabled={isSaving}>
                Save Original
              </button>
            ) : null}
          </>
        )}

        <button type="button" onClick={handleReset}>
          Reset to Bundled
        </button>
        <button type="button" onClick={handleAdoptDraft} disabled={isReadOnly}>
          Adopt as Draft
        </button>
        <button type="button" onClick={() => setExportOpen(true)} disabled={isExporting || isReadOnly}>
          Export Package…
        </button>
        <button
          type="button"
          className="btn-primary"
          style={{ marginLeft: "auto" }}
          disabled={isCompiling || isReadOnly}
          onClick={() => void runCompile()}
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
            <button type="button" className="btn-primary" onClick={handleExport} disabled={isExporting || isReadOnly}>Select Destination & Export</button>
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
          {isReadOnly && activeDocument ? (
            <ReadOnlyProfileInspection document={activeDocument} themeMode={themeMode} />
          ) : (
            <>
              <h3 style={{ fontSize: "1.1rem", marginBottom: "1rem" }}>Design Tokens ({themeMode})</h3>

              <div style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
                <label>
                  Name
                  <input aria-label="Name" value={profile.name} disabled={isReadOnly}
                    onChange={(event) => handleProfileChange((previous) => ({ ...previous, name: event.target.value }))} />
                </label>
                <label>
                  Version
                  <input aria-label="Version" value={profile.version} disabled={isReadOnly}
                    onChange={(event) => handleProfileChange((previous) => ({ ...previous, version: event.target.value }))} />
                </label>
                <label>
                  Description
                  <input aria-label="Description" value={profile.description ?? ""} disabled={isReadOnly}
                    onChange={(event) => handleProfileChange((previous) => ({ ...previous, description: event.target.value }))} />
                </label>
                {([
                  ["primary", "Primary"],
                  ["accent", "Accent"],
                  ["background", "Background"],
                  ["foreground", "Foreground"],
                  ["card", "Card Surface"],
                ] as const).map(([token, label]) => (
                  <ColorControl key={token} label={label} value={currentColors[token]} disabled={isReadOnly}
                    onChange={(value) => handleProfileChange((previous) => ({
                      ...previous,
                      palette: {
                        ...previous.palette,
                        [themeMode]: {
                          ...previous.palette[themeMode],
                          [token]: value,
                          ...(token === "primary" ? { ring: value } : {}),
                        },
                      },
                    }))} />
                ))}

                <hr style={{ border: "none", borderTop: "1px solid #3e3159", margin: "0.5rem 0" }} />

                <label style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
                  <span>Corner Radius: {profile.surfaces.radius}</span>
                  <select
                    aria-label="Radius"
                    disabled={isReadOnly}
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
                  <span>
                    Reading Content Measure:{" "}
                    {profile.surfaces.content !== undefined ? `${profile.surfaces.content}px` : "Not set"}
                  </span>
                  <input
                    aria-label="Reading Content Measure"
                    disabled={isReadOnly}
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
                <label>
                  Border Width
                  <input aria-label="Border Width" value={profile.surfaces.borderWidth ?? ""} disabled={isReadOnly}
                    onChange={(event) => handleProfileChange((previous) => ({
                      ...previous, surfaces: { ...previous.surfaces, borderWidth: event.target.value },
                    }))} />
                </label>
                {([
                  ["fontSans", "Sans Font"],
                  ["fontHeading", "Heading Font"],
                  ["fontMono", "Mono Font"],
                ] as const).map(([field, label]) => (
                  <label key={field}>
                    {label}
                    <input aria-label={label} value={profile.typography[field] ?? ""} disabled={isReadOnly}
                      onChange={(event) => handleProfileChange((previous) => ({
                        ...previous, typography: { ...previous.typography, [field]: event.target.value },
                      }))} />
                  </label>
                ))}
              </div>
            </>
          )}

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
          <div key={`app-preview-${activeDocument?.documentId ?? "built-in"}`} className="panel" style={{ padding: "1.5rem" }}>
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
            <div key={`loom-preview-${activeDocument?.documentId ?? "built-in"}`} className="panel" style={{ padding: "1.5rem" }}>
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

function ReadOnlyProfileInspection({ document, themeMode }: { document: AppThemeOpenedDocument; themeMode: "light" | "dark" }) {
  const ownerSummary = document.ownerBinding
    ? `${document.ownerBinding.verificationStatus} (${document.ownerBinding.inputOrigin}, ${document.ownerBinding.byteLength} bytes)`
    : "unavailable";
  const historySummary = document.isTransformed ? `transformed from ${document.parentSourceSha256 ?? "prior source"}` : "original source";

  if (document.schemaVersion === "tf-paired-profile-v2" && document.v2Profile) {
    const v2 = document.v2Profile;
    const mc = v2.color[themeMode];
    const fmtRole = (role?: { family: string; size?: string; lineHeight?: number }) =>
      role ? `${role.family}${role.size ? ` · ${role.size}` : ""}${role.lineHeight !== undefined ? ` · lh ${role.lineHeight}` : ""}` : "Not specified";
    const fmtKV = (obj?: Record<string, string | number | undefined>) => {
      const entries = obj ? Object.entries(obj).filter(([, v]) => v !== undefined) : [];
      return entries.length ? entries.map(([k, v]) => `${k}:${v}`).join(",") : "Not specified";
    };
    const fmtDual = (dual?: { light?: Record<string, string | undefined>; dark?: Record<string, string | undefined> }) =>
      dual && (dual.light || dual.dark) ? `light={${fmtKV(dual.light)}}, dark={${fmtKV(dual.dark)}}` : "Not specified";

    return (
      <div className="readonly-inspection-view" data-testid="readonly-v2-inspection" style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <h3 style={{ fontSize: "1.1rem", marginBottom: "0.25rem" }}>Read-Only Profile Inspection (tf-paired-profile-v2)</h3>
        <div><strong>Name:</strong> <span>{v2.name}</span></div>
        <div><strong>Version:</strong> <span>{v2.version}</span></div>
        <div><strong>Description:</strong> <span>{v2.description ?? "Not specified"}</span></div>
        <div><strong>Canonical Digest:</strong> <span>{document.canonicalDigest ?? "Not specified"}</span></div>
        <div><strong>Raw Source SHA-256:</strong> <span>{document.rawSourceSha256}</span></div>
        <div><strong>Owner binding:</strong> <span>{ownerSummary}</span></div>
        <div><strong>Studio history:</strong> <span>{historySummary}</span></div>
        <hr style={{ border: "none", borderTop: "1px solid #3e3159", margin: "0.25rem 0" }} />
        <h4>Color Tokens ({themeMode})</h4>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.35rem", fontSize: "0.85rem" }}>
          <div>canvas: {mc.canvas}</div><div>canvasText: {mc.canvasText}</div>
          <div>surface: {mc.surface}</div><div>surfaceText: {mc.surfaceText}</div>
          <div>elevatedSurface: {mc.elevatedSurface}</div><div>elevatedSurfaceText: {mc.elevatedSurfaceText}</div>
          <div>primaryAction: {mc.primaryAction}</div><div>primaryActionText: {mc.primaryActionText}</div>
          <div>secondaryAction: {mc.secondaryAction}</div><div>secondaryActionText: {mc.secondaryActionText}</div>
          <div>mutedSurface: {mc.mutedSurface}</div><div>mutedText: {mc.mutedText}</div>
          <div>highlight: {mc.highlight}</div><div>highlightText: {mc.highlightText}</div>
          <div>danger: {mc.danger}</div><div>dangerText: {mc.dangerText}</div>
          <div>border: {mc.border}</div><div>fieldBorder: {mc.fieldBorder}</div>
          <div>focus: {mc.focus}</div><div>hover: {mc.hover ?? "Not specified"}</div>
          <div>active: {mc.active ?? "Not specified"}</div><div>selection: {mc.selection ?? "Not specified"}</div>
          <div>selectionText: {mc.selectionText ?? "Not specified"}</div>
        </div>
        <hr style={{ border: "none", borderTop: "1px solid #3e3159", margin: "0.25rem 0" }} />
        <h4>Optional V2 Groups</h4>
        <div><strong>Typography:</strong> {v2.typography ? <span>body={fmtRole(v2.typography.body)}; heading={fmtRole(v2.typography.heading)}; ui={fmtRole(v2.typography.ui)}; code={fmtRole(v2.typography.code)}</span> : <span>Not specified</span>}</div>
        <div><strong>Radius:</strong> {v2.radius ? <span>control={v2.radius.control ?? "Not specified"}; surface={v2.radius.surface ?? "Not specified"}; overlay={v2.radius.overlay ?? "Not specified"}</span> : <span>Not specified</span>}</div>
        <div><strong>Spacing:</strong> {v2.spacing ? <span>base={v2.spacing.base ?? "Not specified"}; density={v2.spacing.density ?? "Not specified"}</span> : <span>Not specified</span>}</div>
        <div><strong>Elevation:</strong> {v2.elevation ? <span>emphasis={v2.elevation.emphasis ?? "Not specified"}; borderWidth={v2.elevation.borderWidth ?? "Not specified"}; borderStyle={v2.elevation.borderStyle ?? "Not specified"}</span> : <span>Not specified</span>}</div>
        <div><strong>Focus:</strong> {v2.focus ? <span>width={v2.focus.width ?? "Not specified"}; offset={v2.focus.offset ?? "Not specified"}; light={v2.focus.color?.light ?? "Not specified"}; dark={v2.focus.color?.dark ?? "Not specified"}</span> : <span>Not specified</span>}</div>
        <div><strong>Code:</strong> {v2.code ? <span>frame={v2.code.frame ?? "Not specified"}; copy={v2.code.copy ?? "Not specified"}; syntax={fmtDual(v2.code.syntax)}</span> : <span>Not specified</span>}</div>
        <div><strong>Reading Measure:</strong> <span>{v2.reading?.measure ?? "Not specified"}</span></div>
        <div><strong>Navigation:</strong> {v2.navigation ? <span>prominence={v2.navigation.prominence ?? "Not specified"}; density={v2.navigation.density ?? "Not specified"}</span> : <span>Not specified</span>}</div>
        <div><strong>Target Overrides:</strong> {v2.targetOverrides ? <span>version={v2.targetOverrides.version}; loom.content={v2.targetOverrides.loom?.content !== undefined ? String(v2.targetOverrides.loom.content) : "Not specified"}; loom.radii={v2.targetOverrides.loom?.radii ?? "Not specified"}; loom.border={v2.targetOverrides.loom?.border ?? "Not specified"}; loom.primaryFamily={v2.targetOverrides.loom?.primaryFamily ?? "Not specified"}; loom.secondaryFamily={v2.targetOverrides.loom?.secondaryFamily ?? "Not specified"}; loom.defaultAccent={v2.targetOverrides.loom?.defaultAccent ?? "Not specified"}; loom.tokenSetKey={v2.targetOverrides.loom?.tokenSetKey ?? "Not specified"}; solarSail.radius={v2.targetOverrides.solarSail?.surfaces?.radius ?? "Not specified"}; solarSail.borderWidth={v2.targetOverrides.solarSail?.surfaces?.borderWidth ?? "Not specified"}; solarSail.palette={fmtDual(v2.targetOverrides.solarSail?.palette as any)}; syntax.frame={v2.targetOverrides.syntax?.frame ?? "Not specified"}; syntax.copy={v2.targetOverrides.syntax?.copy ?? "Not specified"}; syntax.tabs={v2.targetOverrides.syntax?.tabs?.activeIndicator ?? "Not specified"}; syntax.syntax={fmtDual(v2.targetOverrides.syntax?.syntax)}; syntax.chrome={fmtDual(v2.targetOverrides.syntax?.chrome as any)}; syntax.diffs={fmtDual(v2.targetOverrides.syntax?.diffs as any)}</span> : <span>Not specified</span>}</div>
      </div>
    );
  }

  if (document.schemaVersion === "tf-paired-profile-v1") {
    const p = document.profile;
    return (
      <div className="readonly-inspection-view" data-testid="readonly-v1-inspection" style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <h3 style={{ fontSize: "1.1rem", marginBottom: "0.25rem" }}>Read-Only Profile Inspection (tf-paired-profile-v1)</h3>
        <div><strong>Display Name:</strong> <span>{document.displayName}</span></div>
        <div><strong>Diagnostic Code:</strong> <span>{document.diagnosticCode ?? "READ_ONLY_V1"}</span></div>
        <div><strong>Read-only Reason:</strong> <span>{document.readonlyReason ?? "Not specified"}</span></div>
        <div><strong>Raw Source SHA-256:</strong> <span>{document.rawSourceSha256}</span></div>
        <div><strong>Normalized SHA-256:</strong> <span>{document.normalizedSha256 ?? "Not specified"}</span></div>
        <div><strong>Owner binding:</strong> <span>{ownerSummary}</span></div>
        <div><strong>Studio history:</strong> <span>{historySummary}</span></div>
        {p ? (
          <>
            <div><strong>Name:</strong> <span>{p.name}</span></div>
            <div><strong>Version:</strong> <span>{p.version}</span></div>
            <div><strong>Description:</strong> <span>{p.description ?? "Not specified"}</span></div>
            <div><strong>Corner Radius:</strong> <span>{p.surfaces.radius}</span></div>
            <div><strong>Border Width:</strong> <span>{p.surfaces.borderWidth ?? "Not specified"}</span></div>
            <div><strong>Reading Content Measure:</strong> <span>{p.surfaces.content !== undefined ? `${p.surfaces.content}px` : "Unavailable (omitted or not representable by the Studio v1 DTO)"}</span></div>
            <div><strong>Sans Font:</strong> <span>{p.typography.fontSans}</span></div>
            <div><strong>Heading Font:</strong> <span>{p.typography.fontHeading ?? "Not specified"}</span></div>
            <div><strong>Mono Font:</strong> <span>{p.typography.fontMono ?? "Not specified"}</span></div>
          </>
        ) : (
          <div>No projected v1 profile payload available.</div>
        )}
      </div>
    );
  }

  return (
    <div className="readonly-inspection-view" data-testid="corrupt-document-inspection" style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      <h3 style={{ fontSize: "1.1rem", marginBottom: "0.25rem" }}>Corrupt Document Inspection</h3>
      <div><strong>Display Name:</strong> <span>{document.displayName}</span></div>
      <div><strong>Schema Version:</strong> <span>{document.schemaVersion}</span></div>
      <div><strong>Verification Status:</strong> <span>{document.verificationStatus}</span></div>
      <div><strong>Raw Source SHA-256:</strong> <span>{document.rawSourceSha256}</span></div>
      <div><strong>Owner binding:</strong> <span>{ownerSummary}</span></div>
      <div><strong>Studio history:</strong> <span>{historySummary}</span></div>
      <div><strong>Diagnostic Code:</strong> <span>{document.diagnosticCode ?? "CORRUPT_DOCUMENT"}</span></div>
      <div><strong>Diagnostic Summary:</strong> <span>{document.diagnosticSummary ?? document.readonlyReason ?? "Document is corrupt."}</span></div>
      <p>No profile tokens are available.</p>
    </div>
  );
}

function ColorControl({ label, value, onChange, disabled = false }: { label: string; value: string; onChange: (value: string) => void; disabled?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem" }}>
      <span>{label}</span>
      <input type="color" aria-label={`${label} color`} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
      <input type="text" aria-label={label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}
