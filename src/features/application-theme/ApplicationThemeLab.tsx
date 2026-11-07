import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { TauriAppThemeBridge } from "./app-theme-bridge";
import { BUILTIN_FORGE_CONSOLE_PROFILE } from "./builtin-profiles";
import { ApplicationPreview } from "./ApplicationPreview";
import { StarlightPreview } from "../theme-lab/StarlightPreview";
import { PairedV2AuthoringPanel } from "./PairedV2AuthoringPanel";
import {
  PairedV2PacketExchange,
  type PairedV2CandidateSelectionContext,
  type PairedV2EligibleCurrentCompile,
  type PairedV2VerifiedSourceIdentity,
} from "./PairedV2PacketExchange";
import { TauriPairedV2NativeBridge } from "./paired-v2-native-bridge";
import {
  createTauriPairedV2PacketBridge,
  type PairedV2PacketBridge,
} from "./paired-v2-packet-bridge";
import type {
  PairedV2ApplicationAppearanceCandidate,
  PairedV2DetachedOpenInput,
  PairedV2NativeBridge,
  PairedV2OpenInput,
  PairedV2WorkflowState,
  PairedV2UiSnapshot,
} from "./paired-v2-ui-adapter";
import type { PairedV2NativePacketEnvelope } from "./paired-v2-packets";
import type { PairedV2SaveResponse } from "./paired-v2-authoring-types";
import { createAppearanceController, type AppearanceController } from "../appearance/appearance-controller";
import { bundledAppearanceCatalog } from "../appearance/bundled-appearance-catalog";
import type { EditorHandle } from "../appearance/appearance-session";
import type {
  AppThemeBridge,
  AppThemeStatus,
  AppThemeOpenedDocument,
  AppThemeOpenProfileResponse,
  AppThemeSaveProfileRequest,
  ProfileSaveMode,
  PairedProfile,
  ThemeDiagnostic,
  OwnerBindingRecord,
} from "./types";

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

const PAIRED_V2_EDITABLE_PATHS = Object.freeze([
  "color.dark.primaryAction",
  "typography.ui.family",
  "radius.surface",
] as const);
const PAIRED_V2_ALLOWED_MODES = Object.freeze(["light", "dark"] as const);

function verifiedDirectV2Input(
  document: AppThemeOpenedDocument | null,
  status: AppThemeStatus | null,
): PairedV2OpenInput | null {
  const capability = status?.pairedV2Authoring;
  if (
    document === null ||
    capability?.supported !== true ||
    typeof capability.sessionId !== "string" ||
    capability.sessionId.length === 0 ||
    new TextEncoder().encode(capability.sessionId).byteLength > 128 ||
    document.schemaVersion !== "tf-paired-profile-v2" ||
    document.v2AuthoringEligible !== true ||
    document.editable !== false ||
    document.verificationStatus !== "verified" ||
    document.isTransformed ||
    document.semantic !== "validated" ||
    document.aliasResolved ||
    document.parentSourceSha256 !== undefined ||
    !isDigest(document.rawSourceSha256) ||
    !isDigest(document.canonicalDigest) ||
    document.v2Profile?.schemaVersion !== "tf-paired-profile-v2"
  ) return null;

  const owner = document.ownerBinding as OwnerBindingRecord | undefined;
  if (
    owner === undefined ||
    owner.inputOrigin !== "source-bytes" ||
    owner.verificationStatus !== "verified" ||
    owner.isTransformed ||
    owner.parentSourceSha256 !== undefined ||
    owner.rawSourceSha256 !== document.rawSourceSha256 ||
    owner.canonicalDigest !== document.canonicalDigest ||
    !Number.isSafeInteger(owner.byteLength) ||
    owner.byteLength <= 0
  ) return null;

  return {
    capability: { supported: true, sessionId: capability.sessionId },
    document: {
      documentId: document.documentId,
      displayName: document.displayName,
      schemaVersion: "tf-paired-profile-v2",
      v2AuthoringEligible: true,
      editable: false,
      verificationStatus: "verified",
      isTransformed: false,
      semantic: "validated",
      rawSourceSha256: document.rawSourceSha256,
      canonicalDigest: document.canonicalDigest,
      ownerBinding: owner,
    },
    v2Profile: document.v2Profile,
  };
}

export function ApplicationThemeLab({
  bridge: propBridge,
  appearanceController,
  pairedV2Bridge: propPairedV2Bridge,
  pairedV2PacketBridge: propPairedV2PacketBridge,
}: {
  bridge?: AppThemeBridge | undefined;
  appearanceController?: AppearanceController | undefined;
  pairedV2Bridge?: PairedV2NativeBridge | undefined;
  pairedV2PacketBridge?: PairedV2PacketBridge | undefined;
}) {
  const [localAppearance] = useState(() => createAppearanceController(bundledAppearanceCatalog));
  const appearance = appearanceController ?? localAppearance;
  const appearanceState = useSyncExternalStore(appearance.subscribe, appearance.getSnapshot, appearance.getSnapshot);
  const bridge = useMemo(() => propBridge ?? new TauriAppThemeBridge(), [propBridge]);
  const [status, setStatus] = useState<AppThemeStatus | null>(null);
  const nativePairedV2Bridge = useMemo(() => {
    if (
      propBridge !== undefined
      || propPairedV2Bridge !== undefined
      || propPairedV2PacketBridge !== undefined
    ) return undefined;
    return new TauriPairedV2NativeBridge();
  }, [propBridge, propPairedV2Bridge, propPairedV2PacketBridge]);
  const pairedV2Bridge = propPairedV2Bridge ?? nativePairedV2Bridge;
  const nativePairedV2PacketBridge = useMemo(() => {
    if (
      propBridge !== undefined
      || propPairedV2Bridge !== undefined
      || propPairedV2PacketBridge !== undefined
    ) return undefined;
    return createTauriPairedV2PacketBridge();
  }, [propBridge, propPairedV2Bridge, propPairedV2PacketBridge]);
  const pairedV2PacketBridge = propPairedV2PacketBridge ?? nativePairedV2PacketBridge;
  const [profile, setProfile] = useState<PairedProfile>(() => JSON.parse(JSON.stringify(BUILTIN_FORGE_CONSOLE_PROFILE)));
  const [activeDocument, setActiveDocument] = useState<AppThemeOpenedDocument | null>(null);
  const [custodyPairedV2Input, setCustodyPairedV2Input] = useState<PairedV2OpenInput | null>(null);
  const [detachedPairedV2Input, setDetachedPairedV2Input] = useState<PairedV2DetachedOpenInput | null>(null);
  const [pairedV2WorkflowState, setPairedV2WorkflowState] = useState<PairedV2WorkflowState | null>(null);
  const [pairedV2PacketSourceIdentity, setPairedV2PacketSourceIdentity] = useState<PairedV2VerifiedSourceIdentity | null>(null);
  const [pairedV2SelectionPending, setPairedV2SelectionPending] = useState(false);
  const [pairedV2ReopenPending, setPairedV2ReopenPending] = useState(false);
  const [pairedV2SessionUnavailableReason, setPairedV2SessionUnavailableReason] = useState<string | null>(null);
  const [resetPending, setResetPending] = useState(false);
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
  const [pairedV2Dirty, setPairedV2Dirty] = useState<boolean>(false);
  const [pairedV2Revision, setPairedV2Revision] = useState<number>(0);
  const [diagnostics, setDiagnostics] = useState<ThemeDiagnostic[]>([]);
  const [isCompiling, setIsCompiling] = useState<boolean>(false);
  const [adoptedDigest, setAdoptedDigest] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState<boolean>(false);
  const [exportLang, setExportLang] = useState<"typescript" | "javascript">("typescript");
  const [stellarLoomError, setStellarLoomError] = useState<string | null>(null);
  const pairedV2Input = detachedPairedV2Input ?? custodyPairedV2Input;
  const pairedV2Pending = Boolean(
    pairedV2WorkflowState?.snapshot.pendingCompile
    || pairedV2WorkflowState?.snapshot.pendingSave
  );
  const isReadOnly =
    (activeDocument !== null && !activeDocument.editable)
    || detachedPairedV2Input !== null
    || pairedV2SelectionPending
    || pairedV2ReopenPending
    || pairedV2SessionUnavailableReason !== null;
  const pairedV2Identity = pairedV2Input === null ? null : [
    pairedV2Input.mode ?? "custody",
    pairedV2Input.capability.sessionId,
    pairedV2Input.mode === "detached"
      ? pairedV2Input.sourceBytesBase64
      : pairedV2Input.document.documentId,
    pairedV2Input.mode === "detached"
      ? pairedV2Input.expectedRawSourceSha256
      : pairedV2Input.document.rawSourceSha256,
    pairedV2Input.mode === "detached"
      ? pairedV2Input.expectedCanonicalDigest
      : pairedV2Input.document.canonicalDigest,
  ].join("\u0000");

  const currentPairedV2SourceIdentity = useMemo<PairedV2VerifiedSourceIdentity | null>(() => {
    const snapshot = pairedV2WorkflowState?.snapshot;
    if (
      pairedV2Input === null
      || pairedV2Pending
      || pairedV2SelectionPending
      || pairedV2ReopenPending
      || resetPending
      || pairedV2SessionUnavailableReason !== null
      || snapshot === undefined
      || snapshot.lifecycle !== "ready"
      || snapshot.savedFrozen
      || snapshot.capability?.sessionId !== pairedV2Input.capability.sessionId
    ) return null;
    if (pairedV2Input.mode === "detached") {
      const detached = pairedV2WorkflowState?.snapshot.detachedSource;
      if (
        pairedV2WorkflowState?.snapshot.lifecycle !== "ready"
        || detached === undefined
        || pairedV2WorkflowState.snapshot.capability?.sessionId !== pairedV2Input.capability.sessionId
      ) return null;
      return {
        profileName: detached.v2Profile.name,
        profileVersion: detached.v2Profile.version,
        rawSourceSha256: detached.rawSourceSha256,
        canonicalDigest: detached.canonicalDigest,
        editablePaths: PAIRED_V2_EDITABLE_PATHS,
        allowedModes: PAIRED_V2_ALLOWED_MODES,
      };
    }
    if (snapshot.sourceMode !== "custody") return null;
    return {
      profileName: pairedV2Input.v2Profile.name,
      profileVersion: pairedV2Input.v2Profile.version,
      rawSourceSha256: pairedV2Input.document.rawSourceSha256,
      canonicalDigest: pairedV2Input.document.canonicalDigest,
      editablePaths: PAIRED_V2_EDITABLE_PATHS,
      allowedModes: PAIRED_V2_ALLOWED_MODES,
    };
  }, [pairedV2Input, pairedV2Pending, pairedV2ReopenPending, pairedV2SelectionPending, pairedV2SessionUnavailableReason, pairedV2WorkflowState, resetPending]);

  const eligiblePairedV2Compile = useMemo<PairedV2EligibleCurrentCompile | undefined>(() => {
    const workflow = pairedV2WorkflowState;
    const input = pairedV2Input;
    const accepted = workflow?.acceptedCompile;
    const snapshot = workflow?.snapshot;
    const authoring = snapshot?.authoring;
    if (
      input === null
      || accepted === undefined
      || snapshot === undefined
      || authoring === undefined
      || snapshot.lifecycle !== "ready"
      || snapshot.pendingCompile
      || snapshot.pendingSave
      || snapshot.savedFrozen
      || pairedV2SelectionPending
      || pairedV2ReopenPending
      || resetPending
      || pairedV2SessionUnavailableReason !== null
      || snapshot.capability?.sessionId !== input.capability.sessionId
      || accepted.sessionId !== input.capability.sessionId
      || accepted.uiRevision !== authoring.revision
      || accepted.draft.sourceBytesBase64.length === 0
      || !isDigest(accepted.draft.rawSourceSha256)
      || !isDigest(accepted.draft.canonicalDigest)
      || (accepted.draft.verificationStatus === "verified" && accepted.draft.isTransformed)
      || (accepted.draft.verificationStatus === "transformed" && !accepted.draft.isTransformed)
    ) return undefined;
    const expectedRaw = input.mode === "detached"
      ? input.expectedRawSourceSha256
      : input.document.rawSourceSha256;
    const expectedCanonical = input.mode === "detached"
      ? input.expectedCanonicalDigest
      : input.document.canonicalDigest;
    if (expectedRaw === undefined || expectedCanonical === undefined) return undefined;
    if (accepted.draft.baselineRawSourceSha256 !== expectedRaw) return undefined;
    if (accepted.draft.baselineCanonicalDigest !== expectedCanonical) return undefined;
    return {
      sourceBytesBase64: accepted.draft.sourceBytesBase64,
      sourceProfileSha256: accepted.draft.rawSourceSha256,
      sourceCanonicalDigest: accepted.draft.canonicalDigest,
      verificationStatus: accepted.draft.verificationStatus,
      isTransformed: accepted.draft.isTransformed,
    };
  }, [pairedV2Input, pairedV2ReopenPending, pairedV2SelectionPending, pairedV2SessionUnavailableReason, pairedV2WorkflowState, resetPending]);

  useEffect(() => {
    if (currentPairedV2SourceIdentity !== null) {
      setPairedV2PacketSourceIdentity(currentPairedV2SourceIdentity);
    }
  }, [currentPairedV2SourceIdentity]);

  useEffect(() => {
    if (pairedV2Identity === null) {
      setPairedV2Dirty(false);
      setPairedV2Revision(0);
    }
  }, [pairedV2Identity]);

  const statusRefreshSeqRef = useRef<number>(0);

  const refreshStatus = useCallback(async (): Promise<AppThemeStatus | null> => {
    const refreshSeq = ++statusRefreshSeqRef.current;
    try {
      const s = await bridge.getStatus();
      if (statusRefreshSeqRef.current !== refreshSeq) return null;
      setStatus(s);
      return s;
    } catch {
      if (statusRefreshSeqRef.current === refreshSeq) setStatus(null);
      return null;
    }
  }, [bridge]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  // Finding A & C: Separate document edit revision from compile operation ID
  const editRevRef = useRef<number>(1);
  const docGenRef = useRef<number>(0);
  const openGenerationRef = useRef<number>(0);
  const compileOpSeqRef = useRef<number>(0);
  const activeCompileOpIdRef = useRef<number | null>(null);
  const isMountedRef = useRef<boolean>(true);
  const appearanceOwnerRef = useRef<EditorHandle | null>(null);

  useLayoutEffect(() => {
    const ownsApplicationLifetime = appearanceController === undefined;
    const media = ownsApplicationLifetime && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    if (ownsApplicationLifetime) appearance.attach(document, media?.matches ? "dark" : "light");
    const owner = appearance.registerEditor();
    appearanceOwnerRef.current = owner;
    const followSystem = () => appearance.change({ kind: "set-system-mode", mode: media?.matches ? "dark" : "light" });
    media?.addEventListener("change", followSystem);
    return () => {
      appearanceOwnerRef.current = null;
      media?.removeEventListener("change", followSystem);
      appearance.disposeEditor(owner);
      if (ownsApplicationLifetime) appearance.detach();
    };
  }, [appearance, appearanceController]);

  useEffect(() => {
    const owner = appearanceOwnerRef.current;
    if (owner && !appearance.isDraftOwner(owner)) {
      setAdoptedDigest(null);
      setActionMessage((current) => current?.startsWith("Adopted theme candidate as unsaved draft")
        ? "Selected application appearance restored. Your profile is unchanged." : current);
    }
  }, [appearance, appearanceState.hasDraft, appearanceState.appearanceEpoch]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
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
    if (resetPending || pairedV2Pending || pairedV2SelectionPending || pairedV2ReopenPending) {
      setActionMessage("Reset is unavailable while the current source is busy.");
      return;
    }
    const owner = appearanceOwnerRef.current;
    if (owner && appearance.isDraftOwner(owner) && !appearance.releaseDraft(owner).ok) {
      setActionMessage("The application draft could not be released. Your profile has not been reset.");
      return;
    }
    editRevRef.current += 1;
    const resetGeneration = ++docGenRef.current;
    const resetOpenGeneration = ++openGenerationRef.current;
    setResetPending(true);
    try {
      await bridge.reset();
    } catch {
      // Keep reset usable even when compiler backend is offline
    }
    if (
      !isMountedRef.current
      || docGenRef.current !== resetGeneration
      || openGenerationRef.current !== resetOpenGeneration
    ) {
      if (isMountedRef.current) setResetPending(false);
      return;
    }
    setActiveDocument(null);
    setCustodyPairedV2Input(null);
    setDetachedPairedV2Input(null);
    setPairedV2WorkflowState(null);
    setPairedV2SelectionPending(false);
    setPairedV2ReopenPending(false);
    setPairedV2SessionUnavailableReason(null);
    setErrors([]);
    setDiagnostics([]);
    setCompiledEditRev(null);
    setExportOpen(false);
    setProfile(JSON.parse(JSON.stringify(BUILTIN_FORGE_CONSOLE_PROFILE)));
    setDirty(false);
    setPairedV2Dirty(false);
    setPairedV2Revision(0);
    setAdoptedDigest(null);
    setStellarLoomError(null);
    setCurrentSolarSailCss(null);
    setCurrentStarlightCss(null);
    setSolarSailCss("");
    setStarlightCss("");

    setActionMessage("Editor reset to its bundled profile. Selected application appearance is unchanged.");
    void refreshStatus();
    if (isMountedRef.current) setResetPending(false);
  };

  const handleOpenProfile = useCallback(async (): Promise<boolean> => {
    const openGeneration = ++openGenerationRef.current;
    const openRev = editRevRef.current;
    const hadPairedV2Context = pairedV2Input !== null;
    const refreshAfterOpen = async (): Promise<AppThemeStatus | null> => {
      const refreshSeq = ++statusRefreshSeqRef.current;
      try {
        const nextStatus = await bridge.getStatus();
        if (
          !isMountedRef.current
          || openGenerationRef.current !== openGeneration
          || statusRefreshSeqRef.current !== refreshSeq
        ) return null;
        setStatus(nextStatus);
        return nextStatus;
      } catch {
        if (
          isMountedRef.current
          && openGenerationRef.current === openGeneration
          && statusRefreshSeqRef.current === refreshSeq
        ) setStatus(null);
        return null;
      }
    };

    let res: AppThemeOpenProfileResponse;
    try {
      res = await bridge.openProfile();
    } catch (err: any) {
      const nextStatus = await refreshAfterOpen();
      if (!isMountedRef.current || openGenerationRef.current !== openGeneration) return false;
      if (hadPairedV2Context) {
        setPairedV2SessionUnavailableReason("The native v2 session ended while opening; reopen to restore authoring.");
      }
      setErrors([`Open failed: ${err?.message || err}`]);
      setActionMessage(nextStatus === null ? "Open failed; native status is unavailable. Reopen to retry." : null);
      return false;
    }

    const statusAfterOpen = await refreshAfterOpen();
    if (!isMountedRef.current || openGenerationRef.current !== openGeneration) return false;
    if (res.cancelled) {
      if (hadPairedV2Context) {
        setPairedV2SessionUnavailableReason("Open was cancelled after the native session ended; reopen to restore authoring.");
      }
      setActionMessage(hadPairedV2Context ? "Open profile cancelled. Reopen to restore paired v2 authoring." : "Open profile cancelled.");
      return false;
    }
    if (res.error) {
      if (hadPairedV2Context) {
        setPairedV2SessionUnavailableReason("The native v2 session ended while opening; reopen to restore authoring.");
      }
      setErrors([res.error]);
      setActionMessage(statusAfterOpen === null ? "Open failed; native status is unavailable. Reopen to retry." : null);
      return false;
    }
    if (res.document === undefined) {
      if (hadPairedV2Context) {
        setPairedV2SessionUnavailableReason("No document was opened after the native session ended; reopen to restore authoring.");
      }
      setActionMessage("Open profile returned no document.");
      return false;
    }
    if (editRevRef.current !== openRev) {
      setActionMessage("Open ignored: document was modified while opening.");
      return false;
    }

    editRevRef.current += 1;
    const newRev = editRevRef.current;
    docGenRef.current += 1;
    const document = res.document;
    const nextCustodyInput = document.schemaVersion === "tf-paired-profile-v2" && pairedV2Bridge !== undefined
      ? verifiedDirectV2Input(document, statusAfterOpen)
      : null;
    activeCompileOpIdRef.current = null;
    setActiveDocument(document);
    setCustodyPairedV2Input(nextCustodyInput);
    setDetachedPairedV2Input(null);
    setPairedV2WorkflowState(null);
    setPairedV2SelectionPending(false);
    setPairedV2SessionUnavailableReason(
      document.schemaVersion === "tf-paired-profile-v2"
      && document.v2AuthoringEligible === true
      && pairedV2Bridge !== undefined
      && nextCustodyInput === null
        ? "Fresh native status did not authorize this v2 document; reopen after the capability is available."
        : null,
    );
    setIsCompiling(false);
    setDirty(false);
    setPairedV2Dirty(false);
    setPairedV2Revision(0);
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
      setActionMessage(document.v2AuthoringEligible === true && nextCustodyInput !== null
        ? `Opened ${document.displayName} (tf-paired-profile-v2 · verified v2 authoring custody)`
        : `Opened ${document.displayName} (tf-paired-profile-v2 · verified read-only custody)`);
    } else if (document.schemaVersion === "tf-paired-profile-v1") {
      const reason = document.diagnosticSummary ?? document.readonlyReason ?? "Profile uses v1 extension fields and is in read-only custody.";
      setErrors([reason]);
      setActionMessage(`Read-only custody: ${document.displayName} (${document.diagnosticCode ?? "READ_ONLY_V1"})`);
    } else {
      const diagnostic = document.diagnosticSummary ?? document.readonlyReason ?? "Document is corrupt and cannot be edited.";
      setErrors([diagnostic]);
      setActionMessage(`Inspection only: ${document.displayName} (${document.diagnosticCode ?? "CORRUPT_DOCUMENT"})`);
    }
    return true;
  }, [bridge, pairedV2Bridge, pairedV2Input, runCompile]);

  const handleSaveProfile = async (modeOverride?: ProfileSaveMode) => {
    const canSaveOriginalV2WithoutAuthoring =
      activeDocument?.schemaVersion === "tf-paired-profile-v2"
      && activeDocument.editable === false
      && pairedV2Input === null;
    if (
      pairedV2Input !== null
      ||
      detachedPairedV2Input !== null
      || pairedV2SelectionPending
      || pairedV2Pending
      || pairedV2ReopenPending
      || resetPending
      || (pairedV2SessionUnavailableReason !== null && !canSaveOriginalV2WithoutAuthoring)
      || activeDocument?.schemaVersion === "corrupt"
      || isSaving
    ) return;
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

    const owner = appearanceOwnerRef.current;
    const eligibility = owner ? appearance.captureApplyEligibility(owner) : null;
    if (!owner || !eligibility || !appearance.applyDraft(owner, eligibility, currentSolarSailCss).ok) {
      setActionMessage("The compiled theme could not be applied. Your profile is unchanged.");
      return;
    }
    setAdoptedDigest(digest);
    setActionMessage(`Adopted theme candidate as unsaved draft (${digest}).`);
  };

  const handlePairedV2Edited = useCallback((snapshot: PairedV2UiSnapshot) => {
    const nextRevision = snapshot.authoring?.revision ?? 0;
    setPairedV2Revision(nextRevision);
    setPairedV2Dirty(nextRevision > 0 && snapshot.lifecycle === "ready" && !snapshot.savedFrozen);
  }, []);

  const handlePairedV2WorkflowState = useCallback((state: PairedV2WorkflowState) => {
    setPairedV2WorkflowState(state);
    const nextRevision = state.snapshot.authoring?.revision ?? 0;
    setPairedV2Revision(nextRevision);
    setPairedV2Dirty(nextRevision > 0 && state.snapshot.lifecycle === "ready" && !state.snapshot.savedFrozen);
  }, []);

  const handlePairedV2Saved = useCallback((result: PairedV2SaveResponse) => {
    if (!result.saved || result.cancelled) return;
    // The panel calls this only after a native save reply is confirmed. The
    // adapter remains on the saved session but the UI requires explicit
    // reopen before another edit, so no automatic rebase occurs here. The
    // adapter snapshot's savedFrozen value remains the authority for dirty
    // state; this callback only reports the confirmed operation.
    setActionMessage("Paired v2 source saved. Reopen explicitly before editing again.");
  }, []);

  const handlePairedV2Reopen = useCallback(() => {
    if (resetPending || isSaving || pairedV2Pending || pairedV2SelectionPending || pairedV2ReopenPending) {
      setActionMessage("Reopen is unavailable while the paired v2 source is busy.");
      return;
    }
    if (dirty || pairedV2Dirty || appearanceState.hasDraft) {
      const confirmed = typeof window !== "undefined" && typeof window.confirm === "function"
        ? window.confirm("Discard the current unsaved editor or application draft and reopen the source?")
        : false;
      if (!confirmed) {
        setActionMessage("Reopen cancelled; the current session remains unchanged.");
        return;
      }
      const owner = appearanceOwnerRef.current;
      if (owner !== null && appearance.isDraftOwner(owner) && !appearance.releaseDraft(owner).ok) {
        setActionMessage("The current application appearance draft could not be released.");
        return;
      }
    }
    setPairedV2ReopenPending(true);
    void handleOpenProfile().finally(() => {
      if (isMountedRef.current) setPairedV2ReopenPending(false);
    });
  }, [appearance, appearanceState.hasDraft, dirty, handleOpenProfile, isSaving, pairedV2Dirty, pairedV2Pending, pairedV2ReopenPending, pairedV2SelectionPending, resetPending]);

  const handleAdoptPairedV2 = useCallback((candidate: PairedV2ApplicationAppearanceCandidate) => {
    const accepted = pairedV2WorkflowState?.acceptedCompile;
    const expectedSessionId = pairedV2WorkflowState?.snapshot.capability?.sessionId ?? pairedV2Input?.capability.sessionId;
    const expectedRevision = accepted?.uiRevision ?? pairedV2Revision;
    const expectedRawSourceSha256 = accepted?.draft.rawSourceSha256
      ?? (pairedV2Input?.mode === "detached" ? pairedV2Input.expectedRawSourceSha256 : pairedV2Input?.document.rawSourceSha256);
    const expectedCanonicalDigest = accepted?.draft.canonicalDigest
      ?? (pairedV2Input?.mode === "detached" ? pairedV2Input.expectedCanonicalDigest : pairedV2Input?.document.canonicalDigest);
    if (
      pairedV2Input === null ||
      currentPairedV2SourceIdentity === null ||
      pairedV2Pending ||
      pairedV2SessionUnavailableReason !== null ||
      expectedSessionId === undefined ||
      expectedRawSourceSha256 === undefined ||
      expectedCanonicalDigest === undefined ||
      candidate.sessionId !== expectedSessionId ||
      candidate.uiRevision !== expectedRevision ||
      candidate.rawSourceSha256 !== expectedRawSourceSha256 ||
      candidate.canonicalDigest !== expectedCanonicalDigest ||
      (accepted !== undefined && candidate.sourceBytesBase64 !== accepted.draft.sourceBytesBase64) ||
      candidate.profile.schemaVersion !== "tf-paired-profile-v2" ||
      candidate.compiledCss.trim().length === 0
    ) {
      return { ok: false, message: "This v2 appearance candidate is no longer current." };
    }
    const owner = appearanceOwnerRef.current;
    const eligibility = owner ? appearance.captureApplyEligibility(owner) : null;
    if (owner === null || eligibility === null) {
      return { ok: false, message: "The application editor is not ready to adopt this appearance." };
    }
    try {
      const applied = appearance.applyDraft(owner, eligibility, candidate.compiledCss);
      if (!applied.ok) return { ok: false, message: "The application appearance could not be applied." };
      setAdoptedDigest(`v2-${candidate.canonicalDigest.slice(0, 12)}`);
      setActionMessage("Adopted paired v2 application appearance as an unsaved draft.");
      return { ok: true, message: "Applied the native full application appearance as an unsaved draft." };
    } catch {
      return { ok: false, message: "The application appearance could not be applied." };
    }
  }, [appearance, currentPairedV2SourceIdentity, pairedV2Input, pairedV2Pending, pairedV2Revision, pairedV2SessionUnavailableReason, pairedV2WorkflowState]);

  const handleSelectPairedV2Candidate = useCallback(async (
    envelope: PairedV2NativePacketEnvelope,
    _context: PairedV2CandidateSelectionContext,
  ): Promise<{ readonly accepted: boolean; readonly message?: string }> => {
    if (
      envelope.kind !== "tf-paired-profile-v2-candidate"
      || envelope.packet.schema !== "tf-paired-profile-v2-candidate"
      || !isDigest(envelope.packet.sourceProfileSha256)
      || !isDigest(envelope.packet.sourceCanonicalDigest)
    ) {
      return { accepted: false, message: "This packet is not a supported paired v2 candidate." };
    }
    if (
      isSaving
      || pairedV2Pending
      || pairedV2WorkflowState?.snapshot.pendingSave
      || pairedV2SelectionPending
      || pairedV2ReopenPending
      || resetPending
      || pairedV2SessionUnavailableReason !== null
    ) {
      return { accepted: false, message: "Candidate selection is unavailable while the source is saving or resetting." };
    }
    if (dirty || pairedV2Dirty || appearanceState.hasDraft) {
      const confirmed = typeof window !== "undefined" && typeof window.confirm === "function"
        ? window.confirm("Discard the current unsaved editor or appearance draft and verify this candidate?")
        : false;
      if (!confirmed) {
        await refreshStatus();
        return { accepted: false, message: "Candidate selection cancelled; the current session remains unchanged." };
      }
      const owner = appearanceOwnerRef.current;
      if (owner !== null && appearance.isDraftOwner(owner) && !appearance.releaseDraft(owner).ok) {
        await refreshStatus();
        return { accepted: false, message: "The current application appearance draft could not be released." };
      }
    }

    const operationGeneration = ++docGenRef.current;
    const operationOpenGeneration = ++openGenerationRef.current;
    editRevRef.current += 1;
    activeCompileOpIdRef.current = null;
    setIsCompiling(false);
    setPairedV2SelectionPending(true);
    setActiveDocument(null);
    setCustodyPairedV2Input(null);
    setDetachedPairedV2Input(null);
    setPairedV2WorkflowState(null);
    setPairedV2Dirty(false);
    setPairedV2Revision(0);
    setDirty(false);
    setErrors([]);
    setDiagnostics([]);
    setCompiledEditRev(null);
    setCurrentSolarSailCss(null);
    setCurrentStarlightCss(null);
    setSolarSailCss("");
    setStarlightCss("");
    setStellarLoomError(null);
    setExportOpen(false);
    setProfile(JSON.parse(JSON.stringify(BUILTIN_FORGE_CONSOLE_PROFILE)));
    setAdoptedDigest(null);
    try {
      const resetStatus = await bridge.reset();
      if (
        !isMountedRef.current
        || docGenRef.current !== operationGeneration
        || openGenerationRef.current !== operationOpenGeneration
      ) {
        return { accepted: false, message: "Candidate selection became stale; reopen the source before retrying." };
      }
      let nextStatus = resetStatus;
      if (nextStatus.pairedV2Authoring?.supported !== true) {
        try {
          const refreshed = await bridge.getStatus();
          if (
            isMountedRef.current
            && docGenRef.current === operationGeneration
            && openGenerationRef.current === operationOpenGeneration
          ) nextStatus = refreshed;
        } catch {
          // The required finally refresh below still reports an unavailable status.
        }
      }
      if (
        !isMountedRef.current
        || docGenRef.current !== operationGeneration
        || openGenerationRef.current !== operationOpenGeneration
      ) {
        return { accepted: false, message: "Candidate selection became stale; reopen the source before retrying." };
      }
      setStatus(nextStatus);
      const capability = nextStatus.pairedV2Authoring;
      if (capability?.supported !== true || typeof capability.sessionId !== "string" || capability.sessionId.length === 0) {
        setPairedV2SessionUnavailableReason("The native v2 capability is unavailable for this candidate.");
        return { accepted: false, message: "The native v2 authoring capability is unavailable for this candidate." };
      }
      setPairedV2SessionUnavailableReason(null);
      setDetachedPairedV2Input({
        mode: "detached",
        capability: { supported: true, sessionId: capability.sessionId },
        sourceBytesBase64: envelope.packet.sourceBytesBase64,
        expectedRawSourceSha256: envelope.packet.sourceProfileSha256,
        expectedCanonicalDigest: envelope.packet.sourceCanonicalDigest,
      });
      setActionMessage("Candidate selected. Verifying its exact source bytes in a fresh native session…");
      return { accepted: true, message: "Candidate selected; native detached verification is in progress." };
    } catch {
      if (
        isMountedRef.current
        && docGenRef.current === operationGeneration
        && openGenerationRef.current === operationOpenGeneration
      ) {
        setPairedV2SessionUnavailableReason("Candidate selection could not restore a native v2 session.");
        setActionMessage("Candidate selection could not reset the native v2 session.");
      }
      return { accepted: false, message: "Candidate selection could not reset the native v2 session." };
    } finally {
      if (
        isMountedRef.current
        && docGenRef.current === operationGeneration
        && openGenerationRef.current === operationOpenGeneration
      ) {
        setPairedV2SelectionPending(false);
        await refreshStatus();
      }
    }
  }, [appearance, appearanceState.hasDraft, bridge, dirty, isSaving, pairedV2Dirty, pairedV2Pending, pairedV2ReopenPending, pairedV2SelectionPending, pairedV2SessionUnavailableReason, pairedV2WorkflowState, refreshStatus, resetPending]);

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
  const editorDirty = dirty || pairedV2Dirty;
  const pairedV2InteractionBusy = Boolean(
    pairedV2Pending
    || pairedV2SelectionPending
    || pairedV2ReopenPending
    || resetPending
  );
  const profileSaveBusy = isSaving || pairedV2InteractionBusy;
  const pairedV2Live = pairedV2Input !== null;
  const pairedV2ParentTransitionReason =
    pairedV2ReopenPending || resetPending || pairedV2SelectionPending
      ? "The paired v2 source is changing; editing, compiling, and saving are paused."
      : pairedV2SessionUnavailableReason;

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
          ) : detachedPairedV2Input !== null ? (
            <>
              <span className="meta-badge">Detached paired v2 candidate</span>
              <span className="meta-badge">Paired v2 revision: {pairedV2Revision}</span>
            </>
          ) : pairedV2SessionUnavailableReason !== null ? (
            <span className="meta-badge warning">Paired v2 authoring unavailable / reopen required</span>
          ) : <span className="meta-badge">Built-in Profile</span>}
          <span className={`status-badge ${status?.available ? "success" : "warning"}`}>
            Solar Sail {status?.available ? "Available" : "Degraded"}
          </span>
          <span className="meta-badge">Rev: {revision}</span>
          <span className={`meta-badge ${editorDirty ? "warning" : "success"}`}>
            {editorDirty ? "Unsaved Changes" : adoptedDigest ? "Adopted Draft" : "Clean"}
          </span>
          {pairedV2SessionUnavailableReason !== null ? (
            <span className="meta-badge warning">{pairedV2SessionUnavailableReason}</span>
          ) : null}
        </div>
      </header>

      {/* Engine degraded notice */}
      {status && !status.available ? (
        <div className="panel bootstrap-error" role="alert">
          <h3>Solar Sail Compiler Degraded</h3>
          <p>{status.message || "Compiler backend is offline. Preview and fallback self-theme remain active."}</p>
          <button type="button" className="btn-secondary" onClick={handleReset} disabled={pairedV2InteractionBusy}>
            Reset offline editor profile
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

      {pairedV2Input !== null && pairedV2Bridge !== undefined ? (
        <div className="panel paired-v2-lab-surface" data-testid="paired-v2-lab-surface">
          <PairedV2AuthoringPanel
            key={`paired-v2-${docGenRef.current}-${pairedV2Identity ?? ""}`}
            input={pairedV2Input}
            bridge={pairedV2Bridge}
            sessionUnavailableReason={pairedV2ParentTransitionReason}
            onAdopt={handleAdoptPairedV2}
            onEdited={handlePairedV2Edited}
            onWorkflowState={handlePairedV2WorkflowState}
            onSaved={handlePairedV2Saved}
            onReopen={handlePairedV2Reopen}
          />
          <p className="paired-v2-muted" data-testid="paired-v2-editor-revision">Editor revision {pairedV2Revision}</p>
        </div>
      ) : null}

      {pairedV2Bridge !== undefined && pairedV2PacketBridge !== undefined && pairedV2PacketSourceIdentity !== null ? (
        <PairedV2PacketExchange
          bridge={pairedV2PacketBridge}
          sourceIdentity={pairedV2PacketSourceIdentity}
          currentSourceIdentity={currentPairedV2SourceIdentity}
          {...(eligiblePairedV2Compile === undefined ? {} : { eligibleCurrentCompile: eligiblePairedV2Compile })}
          pendingSave={Boolean(
            pairedV2SelectionPending
            || pairedV2WorkflowState?.snapshot.pendingSave,
          )}
          onSelectCandidate={handleSelectPairedV2Candidate}
        />
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
        <button type="button" onClick={() => void handleOpenProfile()} disabled={pairedV2InteractionBusy || pairedV2Live}>
          Open Profile…
        </button>
        {activeDocument !== null && !activeDocument.editable && activeDocument.schemaVersion !== "corrupt" ? (
          <button
            type="button"
            onClick={() => void handleSaveProfile("original")}
            disabled={profileSaveBusy || pairedV2Live}
          >
            Save Original
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={() => void handleSaveProfile()}
              disabled={profileSaveBusy || pairedV2Live || pairedV2SessionUnavailableReason !== null || activeDocument?.schemaVersion === "corrupt"}
            >
              Save Profile…
            </button>
            {activeDocument !== null && activeDocument.editable && (activeDocument.aliasResolved || activeDocument.semantic === "rejected" || dirty) ? (
              <button type="button" onClick={() => void handleSaveProfile("original")} disabled={profileSaveBusy || pairedV2Live}>
                Save Original
              </button>
            ) : null}
          </>
        )}

        <button type="button" onClick={handleReset} disabled={pairedV2InteractionBusy}>
          Reset editor profile
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
        <div className="panel export-dialog" role="dialog" aria-label="Export Theme Package" style={{ padding: "1.5rem", marginBottom: "1.5rem", border: "1px solid var(--accent, #f6c65b)" }}>
          <h3>Export Theme Package</h3>
          <p style={{ fontSize: "0.875rem", color: "var(--muted-foreground, #bcb3ce)" }}>
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

                <hr style={{ border: "none", borderTop: "1px solid var(--border, #3e3159)", margin: "0.5rem 0" }} />

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
              <ul style={{ paddingLeft: "1.2rem", fontSize: "0.8rem", color: "var(--accent, #f6c65b)" }}>
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
            <h3 style={{ fontSize: "1rem", marginBottom: "0.5rem", color: "var(--primary, #b8a9ff)" }}>
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
              <h3 style={{ fontSize: "1rem", marginBottom: "0.5rem", color: "var(--primary, #b8a9ff)", display: "flex", alignItems: "center", gap: "0.5rem" }}>
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
        <hr style={{ border: "none", borderTop: "1px solid var(--border, #3e3159)", margin: "0.25rem 0" }} />
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
        <hr style={{ border: "none", borderTop: "1px solid var(--border, #3e3159)", margin: "0.25rem 0" }} />
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
