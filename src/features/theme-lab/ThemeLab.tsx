import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ContrastDiagnostic,
  ThemeAnnotation,
  ThemeAnnotationCategory,
  ThemeAnnotationSeverity,
  ThemeCandidateDisposition,
  ThemeCandidateVerificationResult,
  ThemeDescriptor,
  ThemeLabBridge,
  ThemePalette,
  ThemeReviewOverallDisposition,
  ThemeSpecification,
} from "./types";
import { SAMPLE_CYAN_THEME } from "./builtin-themes";
import { SAMPLE_THEME_V2, type ThemeSpecificationV2 } from "./v2-model";
import { ThemeV2Controls } from "./ThemeV2Controls";
import { ThemeV2Exchange } from "./ThemeV2Exchange";
import type { ThemeDescriptorV2 } from "./v2-bridge";
import { SenderEvidenceImage } from "./SenderEvidenceImage";
import { StarlightPreview, type ColorSchemeMode } from "./StarlightPreview";
import {
  buildThemeBriefCreateInput,
  buildThemeReviewCreateInput,
} from "./request-builders";

export interface ThemeLabProps {
  readonly bridge: ThemeLabBridge;
  readonly managed?: boolean;
}

export type EditorTab = "palette" | "typography" | "diagnostics" | "output" | "exchange";
type ThemeDocument = ThemeSpecification | ThemeSpecificationV2;
function isV2(specification: ThemeDocument): specification is ThemeSpecificationV2 {
  return specification.schemaVersion === "tfsl.theme-v2";
}

type PendingDiscardAction =
  | { type: "new-v2" }
  | { type: "reset" }
  | { type: "example"; name: string }
  | { type: "open" }
  | { type: "adopt"; candidate: Record<string, unknown>; revision: number; briefDigest: unknown };

function formatError(err: unknown): string {
  if (!err) return "Unknown error";
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    const obj = err as { code?: string; message?: string; fieldPath?: string };
    const msg = obj.message || String(err);
    if (obj.fieldPath) {
      return `${msg} (field: '${obj.fieldPath}')`;
    }
    return msg;
  }
  return String(err);
}

export function ThemeLab({ bridge, managed = false }: ThemeLabProps) {
  const [spec, setSpec] = useState<ThemeDocument>(SAMPLE_CYAN_THEME);
  const [activeExample, setActiveExample] = useState<string>("stellar-cyan");
  const [displayName, setDisplayName] = useState<string | undefined>();
  const [dirty, setDirty] = useState<boolean>(false);
  const [draftRevision, setDraftRevision] = useState<number>(1);
  const [previewRevision, setPreviewRevision] = useState<number>(1);
  const [compiledCss, setCompiledCss] = useState<string | undefined>();
  const [lastGoodCss, setLastGoodCss] = useState<string | undefined>();
  const [previewSpec, setPreviewSpec] = useState<ThemeDocument | undefined>();
  const [descriptor, setDescriptor] = useState<ThemeDescriptor | ThemeDescriptorV2 | undefined>();
  const [fieldsValid, setFieldsValid] = useState(true);
  const fieldsValidRef = useRef(true);
  const [lineHeightDraft, setLineHeightDraft] = useState<string | undefined>();
  const [documentGeneration, setDocumentGeneration] = useState(0);
  const saveAsRequiredRef = useRef(false);
  const [previewAccent, setPreviewAccent] = useState<string | undefined>();
  const previewAccentRef = useRef<string | undefined>(undefined);
  const [diagnostics, setDiagnostics] = useState<readonly ContrastDiagnostic[]>([]);
  const [compileError, setCompileError] = useState<string | undefined>();
  const [backendAvailable, setBackendAvailable] = useState<boolean>(true);
  const [backendMessage, setBackendMessage] = useState<string | undefined>();
  const [activeTab, setActiveTab] = useState<EditorTab>("palette");
  const [paletteMode, setPaletteMode] = useState<ColorSchemeMode>("dark");
  const [previewMode, setPreviewMode] = useState<ColorSchemeMode>("dark");
  const [pendingDiscardAction, setPendingDiscardAction] = useState<PendingDiscardAction | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>("Ready");

  // ---------------------------------------------------------------------------
  // Empty Editable Exchange State (TFSB53E-R1)
  // No seeded samples; finite vocabularies; real verification preview
  // ---------------------------------------------------------------------------
  const [candidates, setCandidates] = useState<Record<string, unknown>[]>([]);
  const [selectedCandidateIndex, setSelectedCandidateIndex] = useState<number | null>(null);
  const [candidatePreviewCss, setCandidatePreviewCss] = useState<string | null>(null);
  const [candidateVerification, setCandidateVerification] = useState<ThemeCandidateVerificationResult | null>(null);
  const [activeBrief, setActiveBrief] = useState<Record<string, unknown> | null>(null);

  // Generated identities are stable; design intentions start empty.
  const [briefId, setBriefId] = useState(() => `brief-${crypto.randomUUID()}`);
  const [briefTitle, setBriefTitle] = useState("");
  const [briefGoal, setBriefGoal] = useState("");
  const [allowedFieldsText, setAllowedFieldsText] = useState("");
  const [acceptanceCriteriaText, setAcceptanceCriteriaText] = useState("");
  const [prohibitedChangesText, setProhibitedChangesText] = useState("");
  const [allowedModes, setAllowedModes] = useState<("dark" | "light")[]>(["dark", "light"]);
  const [allowTitleTemplate, setAllowTitleTemplate] = useState(false);
  const [candidatePreviewRevision, setCandidatePreviewRevision] = useState(0);

  // Review state
  const [reviewId, setReviewId] = useState(() => `review-${crypto.randomUUID()}`);
  const [dispositions, setDispositions] = useState<
    Record<string, { disposition: ThemeCandidateDisposition; comment?: string | undefined }>
  >({});
  const [overallDisposition, setOverallDisposition] = useState<ThemeReviewOverallDisposition>({
    kind: "no-decision",
  });
  const [annotations, setAnnotations] = useState<ThemeAnnotation[]>([]);
  const [reviewSummary, setReviewSummary] = useState<string>("");

  // New annotation form state (exact protocol vocabulary)
  const [newAnnotationComment, setNewAnnotationComment] = useState<string>("");
  const [newAnnotationCategory, setNewAnnotationCategory] = useState<ThemeAnnotationCategory>("contrast");
  const [newAnnotationSeverity, setNewAnnotationSeverity] = useState<ThemeAnnotationSeverity>("note");
  const [newAnnotationField, setNewAnnotationField] = useState<string>("");

  const compileTimerRef = useRef<number | null>(null);
  const pendingDraftCompileRef = useRef<ThemeDocument | null>(null);
  const pendingNativeRevisionRef = useRef<number | null>(null);
  const nativeInvalidationRef = useRef<Promise<void>>(Promise.resolve());
  const invalidatingRef = useRef(false);
  const latestIntendedOpRef = useRef<number>(1);
  const latestAppliedOpRef = useRef<number>(0);
  const sessionIdRef = useRef<string | undefined>(undefined);
  const packetTextsRef = useRef(new Map<string, string>());
  const invalidateNativeDraft = (revision: number) => {
    pendingNativeRevisionRef.current = revision;
    if (!bridge.updateDraft || !sessionIdRef.current || invalidatingRef.current) return;
    invalidatingRef.current = true;
    nativeInvalidationRef.current = (async () => {
      try {
        while (pendingNativeRevisionRef.current !== null) {
          const next = pendingNativeRevisionRef.current;
          pendingNativeRevisionRef.current = null;
          const response = await bridge.updateDraft!({ sessionId: sessionIdRef.current!, uiRevision: next });
          if (response.uiRevision !== next) throw new Error("Draft revision acknowledgement mismatch");
        }
      } finally {
        invalidatingRef.current = false;
      }
    })();
    void nativeInvalidationRef.current.catch(() => {
      setCompileError("Native draft synchronization failed; reopen Theme Lab before saving or adopting.");
    });
  };
  const packetText = (packet: Record<string, unknown>): string => {
    const digest = String(packet.candidateDigest ?? packet.briefDigest ?? packet.reviewDigest);
    const text = packetTextsRef.current.get(digest);
    if (!text) throw new Error("Canonical packet bytes are unavailable; import the packet again.");
    return text;
  };

  const checkStatus = useCallback(async () => {
    try {
      const status = await bridge.getStatus();
      if (status.sessionId) {
        sessionIdRef.current = status.sessionId;
      }
      if (typeof status.latestRevision === "number") {
        latestIntendedOpRef.current = Math.max(latestIntendedOpRef.current, status.latestRevision);
        latestAppliedOpRef.current = Math.max(latestAppliedOpRef.current, status.latestRevision);
      }
      if (!status.available) {
        setBackendAvailable(false);
        setBackendMessage(status.message ?? "Stellar Loom compiler adapter is not available. Check that loom-payload is built.");
        setStatusMessage("Compiler unavailable");
      } else {
        setBackendAvailable(true);
        setBackendMessage(undefined);
      }
      return status;
    } catch {
      setBackendAvailable(false);
      setBackendMessage("Failed to check Stellar Loom compiler status.");
      setStatusMessage("Status check failed");
      return null;
    }
  }, [bridge]);

  const loadExampleTheme = useCallback(
    async (name: string) => {
      let opId = 0;
      try {
        if (compileTimerRef.current !== null) {
          window.clearTimeout(compileTimerRef.current);
          compileTimerRef.current = null;
        }
        opId = ++latestIntendedOpRef.current;
        setStatusMessage(`Loading ${name} example…`);
        const res = await bridge.loadExample(name, opId, sessionIdRef.current);
        if (opId < latestIntendedOpRef.current || opId <= latestAppliedOpRef.current) {
          return;
        }
        latestAppliedOpRef.current = opId;
        if (res.valid && res.specification) {
          fieldsValidRef.current = true;
          setFieldsValid(true);
          setLineHeightDraft(undefined);
          saveAsRequiredRef.current = false;
          previewAccentRef.current = undefined;
          setPreviewAccent(undefined);
          pendingDraftCompileRef.current = null;
          setSpec(res.specification);
          setActiveExample(name);
          setDirty(false);
          setDisplayName(undefined);
          setDraftRevision(res.uiRevision);
          setPreviewRevision(res.uiRevision);
          setCompiledCss(res.compiledCss);
          setLastGoodCss(res.compiledCss);
          setPreviewSpec(res.specification);
          setCandidatePreviewCss(null);
          setPreviewRevision(latestIntendedOpRef.current);
          setDescriptor(res.descriptor);
          setDiagnostics(res.diagnostics);
          setCompileError(undefined);
          setStatusMessage(`Loaded ${res.specification.name}`);
        } else {
          setCompileError(formatError(res.error) || "Failed to load example");
          setDiagnostics(res.diagnostics);
          setStatusMessage("Error loading example");
        }
      } catch {
        if (opId < latestIntendedOpRef.current || opId <= latestAppliedOpRef.current) {
          return;
        }
        setCompileError("Backend error loading example");
        setStatusMessage("Error");
      }
    },
    [bridge],
  );

  useEffect(() => {
    let active = true;
    void (async () => {
      await checkStatus();
      if (active) {
        void loadExampleTheme("stellar-cyan");
      }
    })();
    return () => {
      active = false;
      if (compileTimerRef.current !== null) {
        window.clearTimeout(compileTimerRef.current);
        compileTimerRef.current = null;
      }
      latestIntendedOpRef.current++;
      latestAppliedOpRef.current = latestIntendedOpRef.current;
      pendingDraftCompileRef.current = null;
      packetTextsRef.current.clear();
      if (!managed) {
        void bridge.dispose?.();
      }
    };
  }, [checkStatus, loadExampleTheme, bridge, managed]);

  const executeCompile = async (nextSpec: ThemeDocument, nextRev: number) => {
    if (nextRev !== latestIntendedOpRef.current) return;
    try {
      await nativeInvalidationRef.current;
      if (nextRev !== latestIntendedOpRef.current || !fieldsValidRef.current) return;
      setStatusMessage("Compiling theme…");
      const request = {
        specification: nextSpec,
        uiRevision: nextRev,
        sessionId: sessionIdRef.current,
      };
      const res = isV2(nextSpec)
        ? await (bridge.compileV2 ? bridge.compileV2({ ...request, specification: nextSpec, options: { accent: previewAccentRef.current } }) : Promise.reject(new Error("Theme v2 compiler bridge unavailable")))
        : await bridge.compile({ ...request, specification: nextSpec });
      if (nextRev < latestIntendedOpRef.current || nextRev <= latestAppliedOpRef.current) {
        return;
      }
      if (res.uiRevision !== nextRev) {
        setCompiledCss(undefined);
        pendingDraftCompileRef.current = null;
        setCompileError("Compiler returned a mismatched revision; compile the current draft again.");
        setStatusMessage("Compilation result rejected");
        return;
      }
      latestAppliedOpRef.current = nextRev;
      pendingDraftCompileRef.current = null;
      if (res.valid && res.compiledCss) {
        setCompiledCss(res.compiledCss);
        setLastGoodCss(res.compiledCss);
          setPreviewSpec(nextSpec);
        setPreviewRevision(res.uiRevision);
        setDescriptor(res.descriptor);
        setDiagnostics(res.diagnostics);
        setCompileError(undefined);
        setStatusMessage("Theme compiled successfully");
      } else {
        setCompiledCss(undefined);
        setCompileError(formatError(res.error) || "Theme compilation rejected");
        setDiagnostics(res.diagnostics);
        setStatusMessage("Compilation error (retaining last valid preview)");
      }
    } catch {
      if (nextRev < latestIntendedOpRef.current || nextRev <= latestAppliedOpRef.current) {
        return;
      }
      setCompiledCss(undefined);
      pendingDraftCompileRef.current = null;
      setCompileError("Theme compiler unavailable");
      setStatusMessage("Compiler unavailable");
    }
  };

  const scheduleCompile = (nextSpec: ThemeDocument, nextRev: number) => {
    pendingDraftCompileRef.current = nextSpec;
    if (compileTimerRef.current !== null) {
      window.clearTimeout(compileTimerRef.current);
    }
    compileTimerRef.current = window.setTimeout(() => {
      compileTimerRef.current = null;
      void executeCompile(nextSpec, nextRev);
    }, 150);
  };

  const resumePendingDraftCompile = () => {
    const pending = pendingDraftCompileRef.current;
    if (!pending) return;
    const nextRev = ++latestIntendedOpRef.current;
    setDraftRevision(nextRev);
    scheduleCompile(pending, nextRev);
  };

  const handleManualCompile = () => {
    if (!fieldsValidRef.current) return;
    if (compileTimerRef.current !== null) {
      window.clearTimeout(compileTimerRef.current);
      compileTimerRef.current = null;
    }
    const nextRev = ++latestIntendedOpRef.current;
    setDraftRevision(nextRev);
    pendingDraftCompileRef.current = spec;
    void executeCompile(spec, nextRev);
  };

  const updateSpec = (mutator: (draft: ThemeSpecification) => void) => {
    if (isV2(spec)) return;
    const nextSpec: ThemeSpecification = JSON.parse(JSON.stringify(spec)) as ThemeSpecification;
    mutator(nextSpec);
    const nextRev = ++latestIntendedOpRef.current;
    setCandidatePreviewCss(null);
    setCompiledCss(undefined);
    setDiagnostics([]);
    setCompileError(undefined);
    setCandidateVerification(null);
    setPendingDiscardAction(null);
    setSpec(nextSpec);
    setDirty(true);
    setDraftRevision(nextRev);
    invalidateNativeDraft(nextRev);
    scheduleCompile(nextSpec, nextRev);
  };

  const updateV2Spec = (nextSpec: ThemeSpecificationV2) => {
    const nextRev = ++latestIntendedOpRef.current;
    setSpec(nextSpec);
    setDirty(true);
    setDraftRevision(nextRev);
    setCompiledCss(undefined);
    setDiagnostics([]);
    setCompileError(undefined);
    setCandidatePreviewCss(null);
    setCandidateVerification(null);
    setPendingDiscardAction(null);
    invalidateNativeDraft(nextRev);
    scheduleCompile(nextSpec, nextRev);
  };

  const createV2Draft = () => {
    fieldsValidRef.current = true;
    setFieldsValid(true);
    setDocumentGeneration((value) => value + 1);
    setDisplayName(undefined);
    saveAsRequiredRef.current = true;
    previewAccentRef.current = undefined;
    setPreviewAccent(undefined);
    setActiveTab("palette");
    setActiveBrief(null);
    setSelectedCandidateIndex(null);
    updateV2Spec(structuredClone(SAMPLE_THEME_V2));
  };

  const handleFieldsValidity = (valid: boolean) => {
    fieldsValidRef.current = valid;
    setFieldsValid(valid);
    if (!valid) {
      const revision = ++latestIntendedOpRef.current;
      if (compileTimerRef.current !== null) window.clearTimeout(compileTimerRef.current);
      pendingDraftCompileRef.current = null;
      setDirty(true);
      setDraftRevision(revision);
      setCompiledCss(undefined);
      setCandidatePreviewCss(null);
      setCandidateVerification(null);
      invalidateNativeDraft(revision);
    }
  };

  const executeOpen = async () => {
    let opId = 0;
    try {
      if (compileTimerRef.current !== null) {
        window.clearTimeout(compileTimerRef.current);
        compileTimerRef.current = null;
      }
      opId = ++latestIntendedOpRef.current;
      await nativeInvalidationRef.current;
      const res = bridge.openDocument
        ? await bridge.openDocument({ uiRevision: opId, sessionId: sessionIdRef.current })
        : await bridge.openTheme();
      if (opId < latestIntendedOpRef.current || opId <= latestAppliedOpRef.current) {
        return;
      }
      if (res.cancelled) {
        if (dirty || draftRevision > previewRevision) {
          const nextRev = ++latestIntendedOpRef.current;
          setDraftRevision(nextRev);
          scheduleCompile(spec, nextRev);
        }
        return;
      }
      latestAppliedOpRef.current = opId;
      if (res.specification) {
        fieldsValidRef.current = true;
        setFieldsValid(true);
        setDocumentGeneration((value) => value + 1);
        saveAsRequiredRef.current = false;
        previewAccentRef.current = undefined;
        setPreviewAccent(undefined);
        pendingDraftCompileRef.current = null;
        setSpec(res.specification);
        setDisplayName(res.displayName);
        setDirty(false);
        setDraftRevision(opId);
        setPreviewRevision(opId);
        setCompiledCss(res.compiledCss);
        setLastGoodCss(res.compiledCss);
          setPreviewSpec(res.specification);
        setCandidatePreviewCss(null);
        setPreviewRevision(latestIntendedOpRef.current);
        setDescriptor(res.descriptor);
        setDiagnostics(res.diagnostics);
        setCompileError(undefined);
        setStatusMessage(`Opened ${res.displayName ?? res.specification.name}`);
      } else {
        setCompileError(formatError(res.error) || "Failed to open theme file");
        setDiagnostics(res.diagnostics);
        setStatusMessage("Open rejected (preserving current draft)");
      }
    } catch {
      if (opId < latestIntendedOpRef.current || opId <= latestAppliedOpRef.current) {
        return;
      }
      setCompileError("Failed to open theme file");
    }
  };

  const handleOpenClick = () => {
    if (dirty) {
      setPendingDiscardAction({ type: "open" });
    } else {
      void executeOpen();
    }
  };

  const handleSave = async (saveAs: boolean) => {
    if (!fieldsValidRef.current) return;
    const saveDraftRevision = latestIntendedOpRef.current;
    try {
      await nativeInvalidationRef.current;
      if (latestIntendedOpRef.current !== saveDraftRevision) return;
      const request = { saveAs: saveAs || saveAsRequiredRef.current, specification: spec, uiRevision: saveDraftRevision, sessionId: sessionIdRef.current };
      const res = bridge.saveDocument
        ? await bridge.saveDocument(request)
        : !isV2(spec) ? await bridge.saveTheme({ saveAs: request.saveAs, specification: spec }) : await Promise.reject(new Error("Theme v2 save bridge unavailable"));
      if (latestIntendedOpRef.current !== saveDraftRevision) return;
      if (!res.cancelled) {
        saveAsRequiredRef.current = false;
        if (latestIntendedOpRef.current === saveDraftRevision) {
          setDirty(false);
        }
        if (res.displayName) {
          setDisplayName(res.displayName);
        }
        setStatusMessage(`Saved ${res.displayName ?? "theme"}`);
      }
    } catch {
      if (latestIntendedOpRef.current !== saveDraftRevision) return;
      setCompileError("Failed to save theme file");
    }
  };

  const handleExampleClick = (name: string) => {
    if (dirty) {
      setPendingDiscardAction({ type: "example", name });
    } else {
      void loadExampleTheme(name);
    }
  };

  const handleResetClick = () => {
    if (dirty) {
      setPendingDiscardAction({ type: "reset" });
    } else {
      if (isV2(spec)) createV2Draft();
      else void loadExampleTheme(activeExample);
    }
  };

  // ---------------------------------------------------------------------------
  // Host Adoption (TFSB53E-R1)
  // Must receive candidate + brief and dirty confirmation.
  // Adopted draft is dirty and file association is cleared.
  // ---------------------------------------------------------------------------
  const executeAdoptCandidate = async (candidate: Record<string, unknown>, force = false) => {
    let opId = 0;
    try {
      if (compileTimerRef.current !== null) {
        window.clearTimeout(compileTimerRef.current);
        compileTimerRef.current = null;
      }
      opId = ++latestIntendedOpRef.current;
      setStatusMessage(`Adopting candidate ${(candidate as any).candidateId ?? "candidate"}…`);

      if (!bridge.adoptCandidate) {
        setCompileError("Theme Lab bridge does not support candidate adoption");
        return;
      }

      const res = await bridge.adoptCandidate({
        candidate: packetText(candidate),
        brief: packetText(activeBrief!),
        sessionId: sessionIdRef.current!,
        uiRevision: opId,
        options: { strictContrast: false },
        force,
      });

      if (opId !== latestIntendedOpRef.current) return;
      if (res.requiresConfirmation && !force) {
        setPendingDiscardAction({ type: "adopt", candidate, revision: latestIntendedOpRef.current, briefDigest: activeBrief?.briefDigest });
        return;
      }

      if (opId < latestIntendedOpRef.current || opId <= latestAppliedOpRef.current) {
        return;
      }

      if (res.adopted && res.specification) {
        pendingDraftCompileRef.current = null;
        latestAppliedOpRef.current = opId;
        setSpec(res.specification);
        // TFSB53E-R1: adopted draft is dirty and file association is cleared
        setDisplayName(undefined);
        setDirty(true);
        setDraftRevision(opId);
        setPreviewRevision(opId);
        setCompiledCss(res.compiledCss);
        setLastGoodCss(res.compiledCss);
          setPreviewSpec(res.specification);
        setCandidatePreviewCss(null);
        setPreviewRevision(latestIntendedOpRef.current);
        setCandidateVerification(null);
        setDescriptor(res.descriptor);
        setDiagnostics(res.diagnostics ?? []);
        setCompileError(undefined);
        setStatusMessage(`Adopted candidate ${(candidate as any).candidateId ?? "candidate"} as active draft`);
      } else if (res.error) {
        setCompileError(formatError(res.error));
        setStatusMessage("Candidate adoption rejected");
      }
    } catch (err) {
      if (opId < latestIntendedOpRef.current || opId <= latestAppliedOpRef.current) {
        return;
      }
      setCompileError(formatError(err) || "Failed to adopt candidate");
      setStatusMessage("Failed to adopt candidate");
    } finally {
      if (opId === latestIntendedOpRef.current) resumePendingDraftCompile();
    }
  };

  const handleAdoptClick = (candidate: Record<string, unknown>) => {
    if (!activeBrief || !candidateVerification?.valid || candidateVerification.candidateDigest !== candidate.candidateDigest) {
      setCompileError("Select and locally verify this candidate before adoption.");
      return;
    }
    if (dirty) {
      setPendingDiscardAction({ type: "adopt", candidate, revision: latestIntendedOpRef.current, briefDigest: activeBrief?.briefDigest });
    } else {
      void executeAdoptCandidate(candidate, false);
    }
  };

  // ---------------------------------------------------------------------------
  // Candidate Verification Preview (TFSB53E-R1)
  // Calls bridge.verifyThemeCandidate; NO mock CSS for exchange
  // ---------------------------------------------------------------------------
  const handleToggleCandidatePreview = async (candidate: Record<string, unknown>) => {
    if (candidatePreviewCss) {
      latestIntendedOpRef.current++;
      setCandidatePreviewCss(null);
      setPreviewRevision(latestIntendedOpRef.current);
      resumePendingDraftCompile();
      return;
    }

    let opId = 0;
    try {
      opId = ++latestIntendedOpRef.current;
      setStatusMessage(`Verifying and previewing ${(candidate as any).candidateId ?? "candidate"}…`);

      if (!activeBrief) throw new Error("Import or create the candidate’s brief before previewing.");
      if (!bridge.verifyThemeCandidate) {
        setCompileError("Theme Lab bridge does not support candidate verification");
        return;
      }

      const res = await bridge.verifyThemeCandidate({
        candidate: packetText(candidate),
        brief: activeBrief ? packetText(activeBrief) : undefined,
        options: { strictContrast: false },
      });

      if (opId < latestIntendedOpRef.current || opId <= latestAppliedOpRef.current) {
        return;
      }
      latestAppliedOpRef.current = opId;

      if (res.valid && res.compiledCss && res.descriptor && res.candidateVerification?.valid
          && res.candidateVerification.candidateDigest === candidate.candidateDigest
          && res.candidateVerification.briefDigest === activeBrief.briefDigest) {
        setCandidatePreviewRevision(opId);
        setCandidatePreviewCss(res.compiledCss);
        setCandidateVerification(res.candidateVerification ?? null);
        setCompileError(undefined);
        setStatusMessage(`Previewing ${(candidate as any).candidateId ?? "candidate"}`);
      } else {
        setCandidatePreviewCss(null);
        setPreviewRevision(latestIntendedOpRef.current);
        setCandidateVerification(res.candidateVerification ?? null);
        const errMsg = formatError(res.error) || res.candidateVerification?.errors?.join("; ") || "Verification rejected candidate";
        setCompileError(`Candidate preview verification failed: ${errMsg}`);
        setStatusMessage("Candidate verification failed");
      }
    } catch (err) {
      if (opId < latestIntendedOpRef.current || opId <= latestAppliedOpRef.current) {
        return;
      }
      setCandidatePreviewCss(null);
      setPreviewRevision(latestIntendedOpRef.current);
      setCompileError(formatError(err) || "Failed to verify candidate for preview");
      setStatusMessage("Candidate verification error");
    } finally {
      if (opId === latestIntendedOpRef.current) resumePendingDraftCompile();
    }
  };

  // ---------------------------------------------------------------------------
  // Export Brief (TFSB53E-R1)
  // Uses production pure typed request builders with current draft constraints
  // ---------------------------------------------------------------------------
  const handleExportBrief = async () => {
    if (isV2(spec)) {
      setCompileError("Theme v2 brief context is not available through the historical Loom v1 packet owner.");
      return;
    }
    const exchangeOp = ++latestIntendedOpRef.current;
    try {
      setStatusMessage("Exporting theme brief…");
      if (!bridge.createBrief || !bridge.exportPacket) {
        setCompileError("Theme Lab bridge does not support brief export");
        return;
      }

      const allowedFields = allowedFieldsText
        .split(/[\n,]/)
        .map((f) => f.trim())
        .filter(Boolean);

      const acceptanceCriteria = acceptanceCriteriaText
        .split("\n")
        .map((c) => c.trim())
        .filter(Boolean);

      const prohibitedChanges = prohibitedChangesText
        .split(/[\n,]/)
        .map((p) => p.trim())
        .filter(Boolean);

      const briefInput = buildThemeBriefCreateInput({
        briefId,
        title: briefTitle,
        goal: briefGoal,
        baselineTheme: spec,
        allowedFields,
        allowedModes,
        approvedTemplates: allowTitleTemplate ? ["page-title-frame"] : [],
        acceptanceCriteria,
        prohibitedChanges,
        adapter: spec.adapter ?? "starlight-v0.42",
      });

      const briefRes = await bridge.createBrief({ briefInput });
      if (exchangeOp !== latestIntendedOpRef.current) return;
      if (activeBrief) packetTextsRef.current.delete(String(activeBrief.briefDigest));
      packetTextsRef.current.set(briefRes.digest, briefRes.canonicalJson);
      setActiveBrief(briefRes.packet);
      setCandidatePreviewCss(null);
      setPreviewRevision(latestIntendedOpRef.current);
      setCandidateVerification(null);

      if (exchangeOp !== latestIntendedOpRef.current) return;
      const exportRes = await bridge.exportPacket({
        packetJson: briefRes.canonicalJson,
        defaultName: `${spec.name}.tfsl-brief.json`,
      });

      if (exchangeOp !== latestIntendedOpRef.current) return;
      if (!exportRes.cancelled && exportRes.saved) {
        setStatusMessage(`Exported brief to ${exportRes.displayName ?? "file"}`);
      } else {
        setStatusMessage("Brief export cancelled");
      }
    } catch (err) {
      if (exchangeOp !== latestIntendedOpRef.current) return;
      setCompileError(formatError(err) || "Failed to export theme brief");
      setStatusMessage("Failed to export theme brief");
    } finally {
      if (exchangeOp === latestIntendedOpRef.current) resumePendingDraftCompile();
    }
  };

  // ---------------------------------------------------------------------------
  // Import Packet (TFSB53E-R1)
  // - Import candidate does NOT select/adopt/change draft
  // - Review hydrate ONLY after validateThemeReview success
  // - Selection restored via overallDisposition.candidateDigest or none
  // ---------------------------------------------------------------------------
  const handleImportPacket = async () => {
    const exchangeOp = ++latestIntendedOpRef.current;
    try {
      setStatusMessage("Importing exchange packet…");
      if (!bridge.importPacket) {
        setCompileError("Theme Lab bridge does not support packet import");
        return;
      }

      const res = await bridge.importPacket();
      if (exchangeOp !== latestIntendedOpRef.current) return;
      if (res.error) throw new Error(formatError(res.error));
      if (res.cancelled) {
        setStatusMessage("Packet import cancelled");
        return;
      }

      if (!res.packet) throw new Error("Packet import returned no validated packet.");
      if (!res.canonicalJson || !res.digest) throw new Error("Canonical packet identity is missing from import response.");
      const packet = res.packet as any;
      const schema = (packet.schema as string) || (res.kind as string) || "";

      if (schema === "tfsl.theme-candidate") {
        if (candidates.length >= 8 && !candidates.some((c) => c.candidateDigest === packet.candidateDigest)) throw new Error("At most eight candidates may be imported.");
        // Import does not select, adopt, or change the draft.
        packetTextsRef.current.set(res.digest, res.canonicalJson);
        setCandidates((prev) => {
          const idx = prev.findIndex((c: any) => c.candidateDigest === packet.candidateDigest);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = packet;
            return next;
          }
          return [...prev, packet];
        });
        setActiveTab("exchange");
        setStatusMessage(`Imported candidate ${packet.candidateId ?? packet.candidateDigest}`);
      } else if (schema === "tfsl.theme-brief") {
        if (activeBrief) packetTextsRef.current.delete(String(activeBrief.briefDigest));
        packetTextsRef.current.set(res.digest, res.canonicalJson);
        setActiveBrief(packet);
        setCandidatePreviewCss(null);
        setPreviewRevision(latestIntendedOpRef.current);
        setCandidateVerification(null);
        setSelectedCandidateIndex(null);
        setDispositions({});
        setAnnotations([]);
        setOverallDisposition({ kind: "no-decision" });
        setReviewSummary("");
        setAllowedModes(packet.allowedModes);
        setAllowTitleTemplate(packet.approvedTemplates.includes("page-title-frame"));
        if (packet.briefId) setBriefId(packet.briefId);
        if (packet.title) setBriefTitle(packet.title);
        if (packet.goal) setBriefGoal(packet.goal);
        if (Array.isArray(packet.allowedFields)) setAllowedFieldsText(packet.allowedFields.join("\n"));
        if (Array.isArray(packet.acceptanceCriteria)) setAcceptanceCriteriaText(packet.acceptanceCriteria.join("\n"));
        if (Array.isArray(packet.prohibitedChanges)) setProhibitedChangesText(packet.prohibitedChanges.join("\n"));
        setActiveTab("exchange");
        setStatusMessage(`Imported brief ${packet.briefId ?? packet.briefDigest}`);
      } else if (schema === "tfsl.theme-review") {
        // TFSB53E-R1: Validate before hydration
        if (!activeBrief || !bridge.validateThemeReview) throw new Error("Brief context and local review validation are required.");
        if (bridge.validateThemeReview) {
          const valRes = await bridge.validateThemeReview({
            review: res.canonicalJson!,
            brief: activeBrief ? packetText(activeBrief) : undefined,
            candidates: candidates.map(packetText),
          });
          if (exchangeOp !== latestIntendedOpRef.current) return;
          if (!valRes.valid || !valRes.reviewValidation?.valid) {
            const errMsg = formatError(valRes.error) || valRes.reviewValidation?.errors?.join("; ") || "Review failed link validation";
            setCompileError(`Review validation failed: ${errMsg}`);
            setStatusMessage("Review rejected by validation");
            return;
          }
        }

        setCandidatePreviewCss(null);
        setPreviewRevision(latestIntendedOpRef.current);
        setCandidateVerification(null);
        // Hydrate all validated controls together; never merge old decisions.
        if (packet.reviewId) {
          setReviewId(packet.reviewId);
        }
        if (packet.dispositions && Array.isArray(packet.dispositions)) {
          const newDisp: Record<string, { disposition: ThemeCandidateDisposition; comment?: string | undefined }> = {};
          for (const d of packet.dispositions) {
            newDisp[d.candidateDigest] = {
              disposition: d.disposition,
              comment: d.comment ?? undefined,
            };
          }
          setDispositions(newDisp);
        }
        if (packet.overallDisposition) {
          setOverallDisposition(packet.overallDisposition);
          // Restore selection via overallDisposition.candidateDigest or none
          if (
            "candidateDigest" in packet.overallDisposition &&
            typeof packet.overallDisposition.candidateDigest === "string"
          ) {
            const targetDig = packet.overallDisposition.candidateDigest;
            const foundIndex = candidates.findIndex((c: any) => c.candidateDigest === targetDig);
            setSelectedCandidateIndex(foundIndex >= 0 ? foundIndex : null);
          } else {
            setSelectedCandidateIndex(null);
          }
        }
        if (packet.annotations && Array.isArray(packet.annotations)) {
          setAnnotations(packet.annotations);
        }
        if (typeof packet.summary === "string") {
          setReviewSummary(packet.summary);
        }
        setActiveTab("exchange");
        setStatusMessage(`Imported and validated review ${packet.reviewId ?? packet.reviewDigest}`);
      } else {
        throw new Error("Unsupported exchange packet kind");
      }
    } catch (err) {
      if (exchangeOp !== latestIntendedOpRef.current) return;
      setCompileError(formatError(err) || "Failed to import exchange packet");
      setStatusMessage("Failed to import exchange packet");
    } finally {
      if (exchangeOp === latestIntendedOpRef.current) resumePendingDraftCompile();
    }
  };

  // ---------------------------------------------------------------------------
  // Export Review (TFSB53E-R1)
  // Pure typed request builder, actual brief + reviewId, no unknown digest or first candidate fallback
  // ---------------------------------------------------------------------------
  const handleExportReview = async () => {
    const exchangeOp = ++latestIntendedOpRef.current;
    try {
      setStatusMessage("Exporting design review…");
      if (!bridge.createReview || !bridge.exportPacket) {
        setCompileError("Theme Lab bridge does not support review export");
        return;
      }

      if (!activeBrief) {
        setCompileError("An active design brief is required to export a review. Import or export a brief first.");
        return;
      }

      const activeCandidateDigests = candidates.map((c: any) => c.candidateDigest as string);
      if (activeCandidateDigests.length === 0) {
        setCompileError("At least one candidate must be present to export a review.");
        return;
      }

      const reviewInput = buildThemeReviewCreateInput({
        reviewId,
        brief: activeBrief as any,
        candidateDigests: activeCandidateDigests,
        dispositions,
        overallDisposition,
        annotations,
        summary: reviewSummary,
      });

      const reviewRes = await bridge.createReview({ reviewInput });
      if (exchangeOp !== latestIntendedOpRef.current) return;
      if (!bridge.validateThemeReview) throw new Error("Local review context validation is unavailable.");
      const validated = await bridge.validateThemeReview({
        review: reviewRes.canonicalJson,
        brief: packetText(activeBrief),
        candidates: candidates.map(packetText),
      });
      if (exchangeOp !== latestIntendedOpRef.current) return;
      if (!validated.valid || !validated.reviewValidation?.valid) {
        throw new Error(formatError(validated.error) || "Review context is missing or stale.");
      }
      const exportRes = await bridge.exportPacket({
        packetJson: reviewRes.canonicalJson,
        defaultName: `${spec.name}-review.tfsl-review.json`,
      });

      if (exchangeOp !== latestIntendedOpRef.current) return;
      if (!exportRes.cancelled && exportRes.saved) {
        setStatusMessage(`Exported review to ${exportRes.displayName ?? "file"}`);
      } else {
        setStatusMessage("Review export cancelled");
      }
    } catch (err) {
      if (exchangeOp !== latestIntendedOpRef.current) return;
      setCompileError(formatError(err) || "Failed to export design review");
      setStatusMessage("Failed to export design review");
    } finally {
      if (exchangeOp === latestIntendedOpRef.current) resumePendingDraftCompile();
    }
  };

  const confirmDiscard = () => {
    const action = pendingDiscardAction;
    setPendingDiscardAction(null);
    if (action?.type === "new-v2") { createV2Draft(); return; }
    if (!action) return;
    if (action.type === "reset") {
      if (isV2(spec)) createV2Draft();
      else void loadExampleTheme(activeExample);
    } else if (action.type === "example") {
      void loadExampleTheme(action.name);
    } else if (action.type === "open") {
      void executeOpen();
    } else if (action.type === "adopt") {
      if (action.revision !== latestIntendedOpRef.current || action.briefDigest !== activeBrief?.briefDigest) {
        setCompileError("The draft or exchange changed; select and verify the candidate again.");
        return;
      }
      void executeAdoptCandidate(action.candidate, true);
    }
  };

  const cancelDiscard = () => {
    setPendingDiscardAction(null);
  };

  const currentPalette: ThemePalette | undefined = isV2(spec) ? undefined : spec.colors[paletteMode];

  const updateAccent = (key: keyof ThemePalette["accent"], value: string) => {
    updateSpec((draft) => {
      draft.colors[paletteMode].accent[key] = value;
    });
  };

  const updateNeutral = (key: keyof ThemePalette["neutrals"], value: string) => {
    updateSpec((draft) => {
      draft.colors[paletteMode].neutrals[key] = value;
    });
  };

  const updateGray = (key: keyof ThemePalette["grays"], value: string) => {
    updateSpec((draft) => {
      draft.colors[paletteMode].grays[key] = value;
    });
  };

  const activeCandidate = selectedCandidateIndex !== null ? candidates[selectedCandidateIndex] ?? null : null;
  const activeAnnotations = activeCandidate
    ? annotations.filter((a) => a.candidateDigest === (activeCandidate as any).candidateDigest)
    : [];

  return (
    <div className="theme-lab-workspace">
      <div className="theme-lab-header">
        <div className="theme-lab-header-left">
          <h2>Theme Lab</h2>
          <span className="theme-title">
            {spec.name} {spec.version ? `v${spec.version}` : ""}
          </span>
          <span className="preview-badge">{spec.schemaVersion}</span>
          {dirty ? <span className="dirty-indicator" title="Unsaved changes">* Modified</span> : null}
          {displayName ? <span className="file-path-badge">{displayName}</span> : null}
        </div>

        <div className="theme-lab-header-actions">
          <button type="button" disabled={!bridge.compileV2 || !backendAvailable} onClick={() => dirty ? setPendingDiscardAction({ type: "new-v2" }) : createV2Draft()}>New v2 Theme</button>
          <div className="button-group">
            <button
              type="button"
              className={activeExample === "stellar-cyan" && !dirty ? "active" : ""}
              onClick={() => handleExampleClick("stellar-cyan")}
            >
              Stellar Cyan
            </button>
            <button
              type="button"
              className={activeExample === "amber-forge" && !dirty ? "active" : ""}
              onClick={() => handleExampleClick("amber-forge")}
            >
              Amber Forge
            </button>
          </div>

          <div className="button-group">
            <button
              type="button"
              className="compile-button"
              onClick={handleManualCompile}
              disabled={!backendAvailable || !fieldsValid}
              title="Compile current theme draft"
            >
              Compile
            </button>
            <button type="button" onClick={handleOpenClick} disabled={!backendAvailable}>
              Open…
            </button>
            <button type="button" onClick={() => void handleSave(false)} disabled={!backendAvailable || !fieldsValid}>
              Save
            </button>
            <button type="button" onClick={() => void handleSave(true)} disabled={!backendAvailable || !fieldsValid}>
              Save As…
            </button>
            <button type="button" className="danger-button" onClick={handleResetClick} disabled={!backendAvailable}>
              Reset
            </button>
          </div>

          <div className="button-group">
            <button
              type="button"
              onClick={isV2(spec) ? () => setActiveTab("exchange") : handleExportBrief}
              disabled={!backendAvailable}
              title="Export theme brief for external authoring"
            >
              {isV2(spec) ? "Review context…" : "Export Brief…"}
            </button>
            <button
              type="button"
              onClick={isV2(spec) ? () => setActiveTab("exchange") : handleImportPacket}
              disabled={!backendAvailable}
              title="Import brief, candidate, or review packet"
            >
              Import Packet…
            </button>
          </div>
        </div>
      </div>

      {!backendAvailable ? (
        <div className="panel error-panel" role="alert">
          <strong>Stellar Loom Backend Unavailable:</strong> {backendMessage}
        </div>
      ) : null}

      {compileError ? (
        <div className="panel error-panel" role="alert">
          <strong>Theme Compilation Diagnostic:</strong> {compileError}
        </div>
      ) : null}

      <div className="theme-lab-layout">
        <div className="theme-lab-editor-column">
          <nav className="tabs-nav" role="tablist" aria-label="Editor sections">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "palette"}
              className={activeTab === "palette" ? "tab-button active" : "tab-button"}
              onClick={() => setActiveTab("palette")}
            >
              {isV2(spec) ? "Theme controls" : "Palette"}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "typography"}
              className={activeTab === "typography" ? "tab-button active" : "tab-button"}
              onClick={() => setActiveTab(isV2(spec) ? "palette" : "typography")}
            >
              Typography & Layout
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "diagnostics"}
              className={activeTab === "diagnostics" ? "tab-button active" : "tab-button"}
              onClick={() => setActiveTab("diagnostics")}
            >
              Contrast Diagnostics ({diagnostics.length})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "output"}
              className={activeTab === "output" ? "tab-button active" : "tab-button"}
              onClick={() => setActiveTab("output")}
            >
              CSS & Descriptor
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "exchange"}
              className={activeTab === "exchange" ? "tab-button active" : "tab-button"}
              onClick={() => setActiveTab("exchange")}
            >
              Design Exchange ({candidates.length})
            </button>
          </nav>

          <div className="tab-content">
            {isV2(spec) ? <div hidden={activeTab !== "palette"} inert={activeTab !== "palette" ? true : undefined}>
              <label>Preview accent <select aria-label="Preview accent" value={previewAccent ?? spec.defaultAccent} onChange={(event) => {
                previewAccentRef.current = event.target.value;
                setPreviewAccent(event.target.value);
                updateV2Spec(spec);
              }}>{Object.keys(spec.accentVariants).map((accent) => <option key={accent} value={accent}>{accent}</option>)}</select></label>
              <ThemeV2Controls key={documentGeneration} specification={spec} onChange={updateV2Spec} onValidityChange={handleFieldsValidity} />
            </div> : null}
            {activeTab === "palette" && currentPalette ? (
              <div className="palette-editor">
                <div className="mode-selector">
                  <span>Palette Mode:</span>
                  <div className="segmented-control" role="group" aria-label="Palette mode toggle">
                    <button
                      type="button"
                      className={paletteMode === "dark" ? "active" : ""}
                      onClick={() => setPaletteMode("dark")}
                    >
                      Dark
                    </button>
                    <button
                      type="button"
                      className={paletteMode === "light" ? "active" : ""}
                      onClick={() => setPaletteMode("light")}
                    >
                      Light
                    </button>
                  </div>
                </div>

                <fieldset className="color-section">
                  <legend>Accent Colors</legend>
                  <div className="color-grid">
                    {(["base", "low", "high"] as const).map((key) => (
                      <div key={key} className="color-field">
                        <label htmlFor={`accent-${paletteMode}-${key}`}>Accent {key}</label>
                        <div className="color-input-pair">
                          <input
                            type="color"
                            id={`accent-${paletteMode}-${key}`}
                            value={currentPalette.accent[key]}
                            onChange={(e) => updateAccent(key, e.target.value)}
                          />
                          <input
                            type="text"
                        maxLength={2048}
                            aria-label={`Accent ${key} hex code`}
                            value={currentPalette.accent[key]}
                            onChange={(e) => updateAccent(key, e.target.value)}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </fieldset>

                <fieldset className="color-section">
                  <legend>Neutrals</legend>
                  <div className="color-grid">
                    {(Object.keys(currentPalette.neutrals) as Array<keyof ThemePalette["neutrals"]>).map((key) => (
                      <div key={key} className="color-field">
                        <label htmlFor={`neutral-${paletteMode}-${key}`}>{key}</label>
                        <div className="color-input-pair">
                          <input
                            type="color"
                            id={`neutral-${paletteMode}-${key}`}
                            value={currentPalette.neutrals[key]}
                            onChange={(e) => updateNeutral(key, e.target.value)}
                          />
                          <input
                            type="text"
                        maxLength={2048}
                            aria-label={`Neutral ${key} hex code`}
                            value={currentPalette.neutrals[key]}
                            onChange={(e) => updateNeutral(key, e.target.value)}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </fieldset>

                <fieldset className="color-section">
                  <legend>Gray Scale</legend>
                  <div className="color-grid">
                    {(Object.keys(currentPalette.grays) as Array<keyof ThemePalette["grays"]>).map((key) => (
                      <div key={key} className="color-field">
                        <label htmlFor={`gray-${paletteMode}-${key}`}>{key}</label>
                        <div className="color-input-pair">
                          <input
                            type="color"
                            id={`gray-${paletteMode}-${key}`}
                            value={currentPalette.grays[key]}
                            onChange={(e) => updateGray(key, e.target.value)}
                          />
                          <input
                            type="text"
                        maxLength={2048}
                            aria-label={`Gray ${key} hex code`}
                            value={currentPalette.grays[key]}
                            onChange={(e) => updateGray(key, e.target.value)}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </fieldset>
              </div>
            ) : null}

            {activeTab === "typography" && !isV2(spec) ? (
              <div className="typography-editor">
                <fieldset className="form-section">
                  <legend>Typography</legend>
                  <div className="field-group">
                    <label htmlFor="field-body-font">Body Font</label>
                    <select
                      id="field-body-font"
                      value={spec.typography.bodyFont}
                      onChange={(e) =>
                        updateSpec((d) => {
                          d.typography.bodyFont = e.target.value;
                        })
                      }
                    >
                      <option value="system-sans">system-sans</option>
                      <option value="system-serif">system-serif</option>
                      <option value="system-mono">system-mono</option>
                    </select>
                  </div>
                  <div className="field-group">
                    <label htmlFor="field-code-font">Code Font</label>
                    <select
                      id="field-code-font"
                      value={spec.typography.codeFont}
                      onChange={(e) =>
                        updateSpec((d) => {
                          d.typography.codeFont = e.target.value;
                        })
                      }
                    >
                      <option value="system-mono">system-mono</option>
                      <option value="system-code">system-code</option>
                    </select>
                  </div>
                  <div className="field-group">
                    <label htmlFor="field-base-font-size">Base Font Size</label>
                    <input
                      id="field-base-font-size"
                      type="text"
                        maxLength={2048}
                      value={spec.typography.baseFontSize ?? ""}
                      placeholder="16px"
                      onChange={(e) =>
                        updateSpec((d) => {
                          d.typography.baseFontSize = e.target.value;
                        })
                      }
                    />
                  </div>
                  <div className="field-group">
                    <label htmlFor="field-line-height">Line Height</label>
                    <input
                      id="field-line-height"
                      type="text"
                      inputMode="decimal"
                      step="0.05"
                      value={lineHeightDraft ?? spec.typography.lineHeight ?? 1.6}
                      aria-invalid={lineHeightDraft !== undefined && !fieldsValid}
                      onChange={(e) => {
                        const raw = e.target.value;
                        setLineHeightDraft(raw);
                        const value = Number(raw);
                        const valid = raw.trim() !== "" && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw.trim()) && Number.isFinite(value) && value >= 1 && value <= 3;
                        handleFieldsValidity(valid);
                        if (valid) updateSpec((d) => { d.typography.lineHeight = value; });
                      }}
                    />
                    {lineHeightDraft !== undefined && !fieldsValid ? <span role="alert">Line height must be a number from 1 to 3. The draft has been retained.</span> : null}
                  </div>
                </fieldset>

                <fieldset className="form-section">
                  <legend>Layout Geometry</legend>
                  <div className="field-group">
                    <label htmlFor="field-content-width">Content Max Width</label>
                    <input
                      id="field-content-width"
                      type="text"
                        maxLength={2048}
                      value={spec.layout.contentWidth}
                      onChange={(e) =>
                        updateSpec((d) => {
                          d.layout.contentWidth = e.target.value;
                        })
                      }
                    />
                  </div>
                  <div className="field-group">
                    <label htmlFor="field-sidebar-width">Sidebar Width</label>
                    <input
                      id="field-sidebar-width"
                      type="text"
                        maxLength={2048}
                      value={spec.layout.sidebarWidth}
                      onChange={(e) =>
                        updateSpec((d) => {
                          d.layout.sidebarWidth = e.target.value;
                        })
                      }
                    />
                  </div>
                </fieldset>
              </div>
            ) : null}

            {activeTab === "diagnostics" ? (
              <div className="diagnostics-panel">
                <h3>WCAG Contrast Diagnostics</h3>
                {diagnostics.length === 0 ? (
                  <p className="empty-state">No contrast diagnostics reported.</p>
                ) : (
                  <div className="table-wrapper">
                    <table className="diagnostics-table">
                      <thead>
                        <tr>
                          <th>Severity</th>
                          <th>Mode</th>
                          <th>Role</th>
                          <th>Element</th>
                          <th>Colors</th>
                          <th>Ratio</th>
                          <th>Criterion</th>
                          <th>Message</th>
                        </tr>
                      </thead>
                      <tbody>
                        {diagnostics.map((diag, index) => (
                          <tr key={`${diag.code}-${index}`} className={`diag-row ${diag.severity}`}>
                            <td>
                              <span className={`badge ${diag.severity}`}>{diag.severity}</span>
                            </td>
                            <td>{diag.mode}</td>
                            <td>{diag.role}</td>
                            <td><code>{diag.element}</code></td>
                            <td>
                              <span className="swatch-pair">
                                <span
                                  className="color-swatch"
                                  style={{ backgroundColor: diag.foreground }}
                                  title={`FG: ${diag.foreground}`}
                                />
                                <span
                                  className="color-swatch"
                                  style={{ backgroundColor: diag.background }}
                                  title={`BG: ${diag.background}`}
                                />
                              </span>
                            </td>
                            <td><strong>{diag.displayRatio}</strong> (req: {diag.threshold}:1)</td>
                            <td>{diag.criterion}</td>
                            <td>{diag.message}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ) : null}

            {activeTab === "output" ? (
              <div className="output-panel">
                <div className="output-section">
                  <div className="output-header">
                    <h4>Generated CSS</h4>
                    {descriptor ? <span className="digest-tag">SHA-256: {descriptor.outputDigest}</span> : null}
                  </div>
                  <textarea
                    readOnly
                    className="code-output"
                    value={compiledCss ?? "/* No CSS compiled yet */"}
                    rows={12}
                    aria-label="Compiled CSS output"
                  />
                </div>

                <div className="output-section">
                  <div className="output-header">
                    <h4>Theme Descriptor</h4>
                  </div>
                  <textarea
                    readOnly
                    className="code-output"
                    value={descriptor ? JSON.stringify(descriptor, null, 2) : "/* No descriptor available */"}
                    rows={12}
                    aria-label="Theme descriptor JSON"
                  />
                </div>
              </div>
            ) : null}

            {isV2(spec) ? <div hidden={activeTab !== "exchange"} inert={activeTab !== "exchange"}>
              <ThemeV2Exchange bridge={bridge} sessionId={sessionIdRef.current} draftRevision={draftRevision} draftDirty={dirty}
                reserveAdoptionRevision={() => ++latestIntendedOpRef.current}
                onAdopt={(adopted, result) => {
                  const revision = latestIntendedOpRef.current;
                  latestAppliedOpRef.current = revision;
                  if (compileTimerRef.current !== null) window.clearTimeout(compileTimerRef.current);
                  pendingDraftCompileRef.current = null;
                  fieldsValidRef.current = true;
                  setFieldsValid(true);
                  setDocumentGeneration((value) => value + 1);
                  setSpec(adopted);
                  setDraftRevision(revision);
                  setPreviewRevision(revision);
                  setCompiledCss(result?.compiledCss);
                  if (result?.compiledCss) { setLastGoodCss(result.compiledCss); setPreviewSpec(adopted); }
                  setDescriptor(result?.descriptor);
                  setDiagnostics(result?.diagnostics ?? []);
                  setCompileError(undefined);
                  setDisplayName(undefined);
                  saveAsRequiredRef.current = true;
                  setDirty(true);
                  setStatusMessage("Candidate adopted as an unsaved v2 draft");
                }} />
            </div> : null}
            {activeTab === "exchange" && !isV2(spec) ? (
              <div className="exchange-panel">
                <div className="exchange-header">
                  <div className="exchange-title-row">
                    <h3>Theme Design Exchange</h3>
                    <span className="badge">Protocol: tfsl-theme-evidence-v1</span>
                  </div>
                  <p className="exchange-intro">
                    Exchange typed design briefs, candidates, and reviews with external agents or designers.
                  </p>
                  <div className="exchange-actions-bar">
                    <button type="button" onClick={handleExportBrief} disabled={!backendAvailable}>
                      Export Brief…
                    </button>
                    <button type="button" onClick={handleImportPacket} disabled={!backendAvailable}>
                      Import Packet…
                    </button>
                    <button
                      type="button"
                      onClick={handleExportReview}
                      disabled={!backendAvailable || candidates.length === 0 || !activeBrief}
                    >
                      Export Review…
                    </button>
                  </div>
                </div>

                {/* Editable Brief Controls derived from current draft */}
                <fieldset className="form-section brief-controls-section">
                  <legend>Theme Design Brief Configuration</legend>
                  <div className="form-row">
                    <div className="field-group">
                      <label htmlFor="brief-id-input">Brief ID</label>
                      <input
                        id="brief-id-input"
                        type="text"
                        maxLength={2048}
                        value={briefId}
                        onChange={(e) => setBriefId(e.target.value)}
                        placeholder="e.g. brief-stellar-cyan"
                      />
                    </div>
                    <div className="field-group">
                      <label htmlFor="brief-title-input">Brief Title</label>
                      <input
                        id="brief-title-input"
                        type="text"
                        maxLength={2048}
                        value={briefTitle}
                        onChange={(e) => setBriefTitle(e.target.value)}
                        placeholder="e.g. Stellar Cyan Design Brief"
                      />
                    </div>
                  </div>
                  <div className="field-group">
                    <label htmlFor="brief-goal-input">Goal</label>
                    <input
                      id="brief-goal-input"
                      type="text"
                        maxLength={2048}
                      value={briefGoal}
                      onChange={(e) => setBriefGoal(e.target.value)}
                      placeholder="Brief goal description…"
                    />
                  </div>
                  <div className="form-row">
                    <div className="field-group">
                      <label htmlFor="brief-allowed-fields">Allowed Fields (one per line)</label>
                      <textarea
                        id="brief-allowed-fields"
                        rows={3}
                        maxLength={8192}
                        value={allowedFieldsText}
                        onChange={(e) => setAllowedFieldsText(e.target.value)}
                      />
                    </div>
                    <div className="field-group">
                      <label htmlFor="brief-acceptance-criteria">Acceptance Criteria (one per line)</label>
                      <textarea
                        id="brief-acceptance-criteria"
                        rows={3}
                        maxLength={8192}
                        value={acceptanceCriteriaText}
                        onChange={(e) => setAcceptanceCriteriaText(e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="form-row">
                    {(["dark", "light"] as const).map((mode) => <label key={mode}>
                      <input type="checkbox" checked={allowedModes.includes(mode)} onChange={(event) => setAllowedModes((previous) => event.target.checked ? [...previous, mode] : previous.filter((entry) => entry !== mode))} />Allow {mode} changes
                    </label>)}
                    <label><input type="checkbox" checked={allowTitleTemplate} onChange={(event) => setAllowTitleTemplate(event.target.checked)} />Allow page title frame template</label>
                  </div>
                  <label htmlFor="brief-prohibited-changes">Prohibited Changes (one per line)</label>
                  <textarea id="brief-prohibited-changes" value={prohibitedChangesText} maxLength={8192} onChange={(event) => setProhibitedChangesText(event.target.value)} />
                  <p>Up to eight candidates. The complete packet context must fit the 32 MiB transport limit, including encoded images.</p>
                  {activeBrief ? (
                    <div className="active-brief-tag">
                      <span>Active Brief Digest: {(activeBrief as any).briefDigest ?? "N/A"}</span>
                    </div>
                  ) : null}
                </fieldset>

                {/* Candidate Selector */}
                <div className="candidate-selector-section">
                  <h4>Design Candidates ({candidates.length})</h4>
                  {candidates.length === 0 ? (
                    <p className="empty-message">No design candidates imported yet. Click &quot;Import Packet…&quot; to import candidate packets.</p>
                  ) : (
                    <div className="candidate-chips" role="tablist" aria-label="Candidates">
                      {candidates.map((cand: any, idx: number) => {
                        const isSelected = idx === selectedCandidateIndex;
                        const disp = dispositions[cand.candidateDigest]?.disposition ?? "unreviewed";
                        return (
                          <button
                            key={cand.candidateDigest || idx}
                            type="button"
                            role="tab"
                            aria-selected={isSelected}
                            className={`candidate-chip ${isSelected ? "active" : ""}`}
                            onClick={() => {
                              latestIntendedOpRef.current++;
                              setSelectedCandidateIndex(idx);
                              setCandidatePreviewCss(null);
                              setPreviewRevision(latestIntendedOpRef.current);
                              setCandidateVerification(null);
                              resumePendingDraftCompile();
                            }}
                          >
                            <span className="cand-name">{cand.candidateId ?? `Candidate ${idx + 1}`}</span>
                            <span className={`disp-tag disp-${disp}`}>{disp}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {activeCandidate ? (
                  <div className="candidate-detail-card">
                    <div className="candidate-meta-header">
                      <div className="candidate-meta-title">
                        <h4>{(activeCandidate as any).candidateId}</h4>
                        <span className="digest-tag">{(activeCandidate as any).candidateDigest}</span>
                      </div>
                      <div className="candidate-card-actions">
                        <button
                          type="button"
                          className="primary-button adopt-button"
                          onClick={() => handleAdoptClick(activeCandidate)}
                          disabled={!backendAvailable || !activeBrief || !candidateVerification?.valid || candidateVerification.candidateDigest !== activeCandidate.candidateDigest}
                          title="Adopt candidate as editable working draft"
                        >
                          Use as Draft
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleToggleCandidatePreview(activeCandidate)}
                          title="Verify and toggle preview of this candidate in the preview pane"
                        >
                          {candidatePreviewCss ? "Restore Draft Preview" : "Preview Candidate"}
                        </button>
                      </div>
                    </div>

                    {(activeCandidate as any).rationale ? (
                      <div className="candidate-section">
                        <div className="field-label">Rationale:</div>
                        <p className="candidate-rationale">{(activeCandidate as any).rationale}</p>
                      </div>
                    ) : null}

                    {candidateVerification ? (
                      <div className="candidate-section">
                        <div className="field-label">Local Verification Result:</div>
                        <div className="provenance-grid">
                          <span><strong>Valid:</strong> {candidateVerification.valid ? "Pass" : "Failed"}</span>
                          <span><strong>Theme Digest:</strong> {candidateVerification.themeDigest}</span>
                          {candidateVerification.constraintViolations.length > 0 ? (
                            <span className="error-text">
                              <strong>Violations:</strong> {candidateVerification.constraintViolations.join("; ")}
                            </span>
                          ) : null}
                          {candidateVerification.errors.length > 0 ? (
                            <span className="error-text">
                              <strong>Errors:</strong> {candidateVerification.errors.join("; ")}
                            </span>
                          ) : null}
                        </div>
                        <p>Digests establish content integrity, not sender authorship or screenshot authenticity.</p>
                        {candidateVerification.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
                        <ul aria-label="Locally compiled candidate contrast diagnostics">
                          {candidateVerification.diagnostics.map((diagnostic, index) => (
                            <li key={index}>{diagnostic.mode}: {diagnostic.message} ({diagnostic.displayRatio}, {diagnostic.disposition})</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    {(activeCandidate as any).claimedProvenance ? (
                      <div className="candidate-section">
                        <div className="field-label">Claimed Provenance:</div>
                        <div className="provenance-grid">
                          <span><strong>Author:</strong> {(activeCandidate as any).claimedProvenance.author ?? "Unknown"}</span>
                          <span><strong>Tool:</strong> {(activeCandidate as any).claimedProvenance.toolName ?? "tfsl"} ({(activeCandidate as any).claimedProvenance.toolVersion ?? "unknown"})</span>
                          <span><strong>Timestamp:</strong> {(activeCandidate as any).claimedProvenance.timestamp ?? "N/A"}</span>
                        </div>
                      </div>
                    ) : null}

                    {(activeCandidate as any).packageMetadata ? (
                      <div className="candidate-section">
                        <div className="field-label">Package Metadata:</div>
                        <div className="provenance-grid">
                          <span><strong>Package:</strong> {(activeCandidate as any).packageMetadata.name}</span>
                          <span><strong>Version:</strong> {(activeCandidate as any).packageMetadata.version}</span>
                          <span><strong>Template:</strong> {(activeCandidate as any).packageMetadata.template ?? "default"}</span>
                          <span><strong>License:</strong> {(activeCandidate as any).packageMetadata.license ?? "AGPL-3.0-or-later"}</span>
                        </div>
                      </div>
                    ) : null}

                    {(activeCandidate as any).visualEvidence && (activeCandidate as any).visualEvidence.length > 0 ? (
                      <div className="candidate-section">
                        <div className="field-label">Visual Evidence ({(activeCandidate as any).visualEvidence.length}):</div>
                        <div className="visual-evidence-gallery">
                          {(activeCandidate as any).visualEvidence.map((ev: any, evIdx: number) => (
                            <div key={ev.evidenceDigest || evIdx} className="visual-evidence-card">
                              <div className="visual-evidence-meta">
                                <span className="badge">{ev.fixtureId}</span>
                                <span className="badge">{ev.mode}</span>
                                <span className="badge">{ev.viewport}</span>
                                <span className="badge">{ev.width}×{ev.height}</span>
                              </div>
                              {ev.bytesBase64 ? (
                                <div className="visual-evidence-preview">
                                  <SenderEvidenceImage evidence={ev} candidateDigest={String(activeCandidate.candidateDigest)} />
                                </div>
                              ) : null}
                              <span className="digest-tag">Sender-supplied PNG: {ev.pngDigest}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    <div className="candidate-section">
                      <div className="field-label">Candidate Disposition:</div>
                      <div className="disposition-controls">
                        <label htmlFor="candidate-disposition-select">Decision:</label>
                        <select
                          id="candidate-disposition-select"
                          value={dispositions[(activeCandidate as any).candidateDigest]?.disposition ?? "unreviewed"}
                          onChange={(e) => {
                            const newKind = e.target.value as ThemeCandidateDisposition;
                            setDispositions((prev) => ({
                              ...prev,
                              [(activeCandidate as any).candidateDigest]: {
                                disposition: newKind,
                                comment: prev[(activeCandidate as any).candidateDigest]?.comment ?? undefined,
                              },
                            }));
                          }}
                        >
                          <option value="unreviewed">unreviewed</option>
                          <option value="preferred">preferred</option>
                          <option value="approved">approved</option>
                          <option value="needs-revision">needs-revision</option>
                          <option value="deferred">deferred</option>
                          <option value="rejected">rejected</option>
                        </select>

                        <label htmlFor="candidate-disposition-comment">Comment:</label>
                        <input
                          id="candidate-disposition-comment"
                          type="text"
                        maxLength={2048}
                          placeholder="Rationale for this disposition…"
                          value={dispositions[(activeCandidate as any).candidateDigest]?.comment ?? ""}
                          onChange={(e) => {
                            const comment = e.target.value;
                            setDispositions((prev) => ({
                              ...prev,
                              [(activeCandidate as any).candidateDigest]: {
                                disposition: prev[(activeCandidate as any).candidateDigest]?.disposition ?? "unreviewed",
                                comment: comment ? comment : undefined,
                              },
                            }));
                          }}
                        />
                      </div>
                    </div>

                    <div className="candidate-section">
                      <div className="field-label">Annotations ({activeAnnotations.length}):</div>
                      {activeAnnotations.length > 0 ? (
                        <ul className="annotation-list">
                          {activeAnnotations.map((ann, aIdx) => (
                            <li key={ann.annotationId || aIdx} className="annotation-item">
                              <div className="annotation-meta">
                                <span className={`badge severity-${ann.severity}`}>{ann.severity}</span>
                                <span className="badge category-tag">{ann.category}</span>
                                {ann.target.kind === "field" && ann.target.fieldPath ? (
                                  <span className="field-path-tag">{ann.target.fieldPath}</span>
                                ) : null}
                              </div>
                              <p className="annotation-comment">{ann.comment}</p>
                              <button
                                type="button"
                                className="small-button danger-button"
                                onClick={() => {
                                  setAnnotations((prev) => prev.filter((a) => a.annotationId !== ann.annotationId));
                                }}
                              >
                                Remove
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="empty-message">No annotations recorded for this candidate.</p>
                      )}

                      <div className="add-annotation-form">
                        <div className="form-row">
                          <select
                            aria-label="Annotation severity"
                            value={newAnnotationSeverity}
                            onChange={(e) => setNewAnnotationSeverity(e.target.value as ThemeAnnotationSeverity)}
                          >
                            <option value="note">note</option>
                            <option value="minor">minor</option>
                            <option value="substantive">substantive</option>
                            <option value="blocking">blocking</option>
                          </select>

                          <select
                            aria-label="Annotation category"
                            value={newAnnotationCategory}
                            onChange={(e) => setNewAnnotationCategory(e.target.value as ThemeAnnotationCategory)}
                          >
                            <option value="contrast">contrast</option>
                            <option value="color">color</option>
                            <option value="typography">typography</option>
                            <option value="layout">layout</option>
                            <option value="brand-fit">brand-fit</option>
                            <option value="accessibility">accessibility</option>
                            <option value="other">other</option>
                          </select>

                          <input
                            type="text"
                        maxLength={2048}
                            aria-label="Annotation field path"
                            placeholder="Target field path (e.g. colors.dark.accent.base)"
                            value={newAnnotationField}
                            onChange={(e) => setNewAnnotationField(e.target.value)}
                          />
                        </div>

                        <div className="form-row">
                          <input
                            type="text"
                        maxLength={2048}
                            aria-label="Annotation comment"
                            placeholder="Annotation comment…"
                            value={newAnnotationComment}
                            onChange={(e) => setNewAnnotationComment(e.target.value)}
                          />
                          <button
                            type="button"
                            onClick={() => {
                              if (!newAnnotationComment.trim() || !newAnnotationField.trim() || annotations.length >= 128) return;
                              const newAnn: ThemeAnnotation = {
                                annotationId: `ann-${Date.now()}`,
                                candidateDigest: (activeCandidate as any).candidateDigest,
                                target: {
                                  kind: "field",
                                  fieldPath: newAnnotationField.trim(),
                                  ...(newAnnotationField.startsWith("colors.dark.") ? { mode: "dark" as const } : newAnnotationField.startsWith("colors.light.") ? { mode: "light" as const } : {}),
                                },
                                severity: newAnnotationSeverity,
                                category: newAnnotationCategory,
                                comment: newAnnotationComment.trim(),
                              };
                              setAnnotations((prev) => [...prev, newAnn]);
                              setNewAnnotationComment("");
                            }}
                          >
                            Add Annotation
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : null}

                {/* Overall Review Section */}
                <div className="review-overall-section">
                  <h4>Overall Review Disposition</h4>
                  <div className="form-row">
                    <div className="field-group">
                      <label htmlFor="review-id-input">Review ID</label>
                      <input
                        id="review-id-input"
                        type="text"
                        maxLength={2048}
                        value={reviewId}
                        onChange={(e) => setReviewId(e.target.value)}
                        placeholder="e.g. review-stellar-cyan-01"
                      />
                    </div>
                  </div>

                  <div className="overall-disposition-row">
                    <label htmlFor="overall-disposition-select">Overall Result:</label>
                    <select
                      id="overall-disposition-select"
                      value={overallDisposition.kind}
                      onChange={(e) => {
                        const newKind = e.target.value as ThemeReviewOverallDisposition["kind"];
                        if (newKind === "no-decision") {
                          setOverallDisposition({ kind: "no-decision" });
                        } else if (newKind === "rejected-all") {
                          setOverallDisposition({ kind: "rejected-all" });
                        } else {
                          const currentDigest =
                            "candidateDigest" in overallDisposition
                              ? overallDisposition.candidateDigest
                              : "";
                          setOverallDisposition({
                            kind: newKind,
                            candidateDigest: currentDigest,
                          });
                        }
                      }}
                    >
                      <option value="no-decision">no-decision</option>
                      <option value="preferred">preferred</option>
                      <option value="approved">approved</option>
                      <option value="needs-revision">needs-revision</option>
                      <option value="rejected-all">rejected-all</option>
                    </select>

                    {"candidateDigest" in overallDisposition ? (
                      <>
                        <label htmlFor="overall-candidate-select">Selected Candidate:</label>
                        <select
                          id="overall-candidate-select"
                          value={overallDisposition.candidateDigest}
                          onChange={(e) => {
                            const newDig = e.target.value;
                            if (
                              overallDisposition.kind === "preferred" ||
                              overallDisposition.kind === "approved" ||
                              overallDisposition.kind === "needs-revision"
                            ) {
                              setOverallDisposition({
                                kind: overallDisposition.kind,
                                candidateDigest: newDig,
                              });
                            }
                          }}
                        >
                          <option value="">Choose a candidate</option>
                          {candidates.map((cand: any, idx: number) => (
                            <option key={cand.candidateDigest || idx} value={cand.candidateDigest}>
                              {cand.candidateId ?? `Candidate ${idx + 1}`}
                            </option>
                          ))}
                        </select>
                      </>
                    ) : null}
                  </div>

                  <div className="review-summary-row">
                    <label htmlFor="review-summary-text">Review Summary:</label>
                    <textarea
                      id="review-summary-text"
                      rows={3}
                        maxLength={8192}
                      value={reviewSummary}
                      onChange={(e) => setReviewSummary(e.target.value)}
                      placeholder="Executive summary of the design review…"
                    />
                  </div>

                  <div className="review-export-bar">
                    <button
                      type="button"
                      className="primary-button"
                      onClick={handleExportReview}
                      disabled={!backendAvailable || candidates.length === 0 || !activeBrief}
                    >
                      Export Final Review Packet…
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <div className="theme-lab-preview-column">
          {candidatePreviewCss ? (
            <div className="candidate-preview-banner">
              <span>Previewing Candidate</span>
              <button type="button" onClick={() => {
                latestIntendedOpRef.current++;
                setCandidatePreviewCss(null);
                setPreviewRevision(latestIntendedOpRef.current);
                resumePendingDraftCompile();
              }}>
                Restore Draft Preview
              </button>
            </div>
          ) : null}
          <StarlightPreview
            css={candidatePreviewCss ?? (compiledCss ?? lastGoodCss)}
            revision={candidatePreviewCss ? candidatePreviewRevision : previewRevision}
            mode={previewMode}
            isLastGood={(compileError !== undefined || draftRevision > previewRevision) && lastGoodCss !== undefined && !candidatePreviewCss}
            onModeChange={setPreviewMode}
            gallery={isV2(spec)}
            spec={candidatePreviewCss ? undefined : (isV2(spec) ? spec : undefined)}
            compiledSpec={previewSpec && isV2(previewSpec) ? previewSpec : undefined}
          />
        </div>
      </div>

      <div className="theme-lab-status-bar">
        <span>{statusMessage}</span>
        <span>Revision: {draftRevision}</span>
        {descriptor ? <span>Target: {descriptor.adapter}</span> : null}
      </div>

      {pendingDiscardAction ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="reset-modal-title">
          <div className="modal-box">
            <h3 id="reset-modal-title">Discard Unsaved Changes?</h3>
            <p>
              You have unsaved changes to <strong>{spec.name}</strong>. {
                pendingDiscardAction.type === "reset"
                  ? "Resetting will discard these modifications and restore the original template."
                  : pendingDiscardAction.type === "adopt"
                  ? "Adopting this candidate will discard your current modifications and replace the draft."
                  : "Proceeding will discard these modifications."
              }
            </p>
            <div className="modal-actions">
              <button type="button" onClick={cancelDiscard}>
                Cancel
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={confirmDiscard}
              >
                {pendingDiscardAction.type === "reset" ? "Confirm Reset" : pendingDiscardAction.type === "adopt" ? "Discard & Adopt" : "Discard & Proceed"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
