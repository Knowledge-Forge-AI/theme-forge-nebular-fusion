import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApplicationPreview } from "./ApplicationPreview";
import {
  PairedV2UiAdapter,
  PairedV2UiAdapterError,
  type PairedV2ApplicationAppearanceCandidate,
  type PairedV2AuthoringInput,
  type PairedV2NativeBridge,
  type PairedV2PreviewFrame,
  type PairedV2PreviewName,
  type PairedV2WorkflowState,
  type PairedV2UiSnapshot,
} from "./paired-v2-ui-adapter";
import type {
  PairedV2SaveResponse,
  PairedV2SuccessfulCompileResponse,
} from "./paired-v2-authoring-types";
import type { PreviewApplicationState } from "./preview-application-state";
import {
  isPairedV2ApplicationColorValue,
  isPairedV2ApplicationRadiusValue,
  isPairedV2ApplicationTypographyValue,
} from "./paired-v2-edit-contract";
import { StarlightPreview } from "../theme-lab/StarlightPreview";
import "./paired-v2-authoring-panel.css";

export interface PairedV2AuthoringPanelProps {
  readonly input: PairedV2AuthoringInput;
  readonly bridge: PairedV2NativeBridge;
  /** The parent retires the native v2 epoch after an open cancellation/error. */
  readonly sessionUnavailableReason?: string | null | undefined;
  readonly onReopen?: (() => void) | undefined;
  readonly onSaved?: ((result: PairedV2SaveResponse) => void) | undefined;
  readonly onAdopt?: ((candidate: PairedV2ApplicationAppearanceCandidate) => {
    readonly ok: boolean;
    readonly message?: string;
  }) | undefined;
  readonly onEdited?: ((snapshot: PairedV2UiSnapshot) => void) | undefined;
  readonly onWorkflowState?: ((state: PairedV2WorkflowState) => void) | undefined;
  readonly onPreviewState?: ((preview: PairedV2PreviewName, state: PreviewApplicationState) => void) | undefined;
  readonly requireCorrelatedAck?: boolean | undefined;
}

type TextBuffers = {
  color: string;
  typography: string;
  radius: string;
};

type BusyAction = "compile" | "save" | "save-as" | null;

type EditablePath = "color.dark.primaryAction" | "typography.ui.family" | "radius.surface";

const PREVIEW_MODE = "dark" as const;

function initialBuffers(input: PairedV2AuthoringInput): TextBuffers {
  if (input.mode === "detached") {
    return { color: "", typography: "", radius: "" };
  }
  return {
    color: input.v2Profile.color.dark.primaryAction ?? "",
    typography: input.v2Profile.typography?.ui?.family ?? "",
    radius: input.v2Profile.radius?.surface ?? "",
  };
}

function emptySnapshot(): PairedV2UiSnapshot {
  return Object.freeze({
    lifecycle: "empty" as const,
    pendingCompile: false,
    pendingSave: false,
    savedFrozen: false,
    canAdoptPaired: false,
  });
}

function bufferValue(buffers: TextBuffers, path: EditablePath): string {
  if (path === "color.dark.primaryAction") return buffers.color;
  if (path === "typography.ui.family") return buffers.typography;
  return buffers.radius;
}

function focusedValueIssue(
  path: "color.dark.primaryAction" | "typography.ui.family" | "radius.surface",
  value: string,
): string | undefined {
  if (value.length === 0) return undefined;
  if (path === "color.dark.primaryAction" && !isPairedV2ApplicationColorValue(path, value)) {
    return "Use a bounded color value without controls or CSS delimiters.";
  }
  if (path === "typography.ui.family" && !isPairedV2ApplicationTypographyValue(path, value)) {
    return "Use system-ui, monospace, sans-serif, or serif for the interface family.";
  }
  if (path === "radius.surface" && !isPairedV2ApplicationRadiusValue(path, value)) {
    return "Use a surface radius with px, rem, or em units (for example 8px).";
  }
  return undefined;
}

function inputIdentity(input: PairedV2AuthoringInput): string {
  if (input.mode === "detached") {
    return [
      "detached",
      input.capability.supported ? "supported" : "unsupported",
      input.capability.sessionId ?? "",
      input.sourceBytesBase64,
      input.expectedRawSourceSha256,
      input.expectedCanonicalDigest,
    ].join("\u0000");
  }
  return [
    input.capability.supported ? "supported" : "unsupported",
    input.capability.sessionId ?? "",
    input.document.documentId,
    input.document.displayName,
    input.document.rawSourceSha256,
    input.document.canonicalDigest,
    input.v2Profile.schemaVersion,
    input.v2Profile.name,
    input.v2Profile.version,
  ].join("\u0000");
}

function buffersFromSnapshot(snapshot: PairedV2UiSnapshot, input: PairedV2AuthoringInput): TextBuffers {
  const profile = snapshot.document?.v2Profile ?? snapshot.detachedSource?.v2Profile;
  if (profile === undefined) return initialBuffers(input);
  return {
    color: profile.color.dark.primaryAction ?? "",
    typography: profile.typography?.ui?.family ?? "",
    radius: profile.radius?.surface ?? "",
  };
}

function errorMessage(error: unknown, action: "open" | "compile" | "save" | "adopt"): string {
  if (error instanceof PairedV2UiAdapterError) {
    if (error.code === "unsupported") return "Paired v2 authoring is unavailable for this document.";
    if (error.code === "invalid-open-document") return "This source is not eligible for v2 editing.";
    if (error.code === "detached-promotion-refused") return "The detached candidate could not be verified; no previous session was reused.";
    if (error.code === "detached-requires-promotion") return "This detached candidate must be verified by the native compiler before editing.";
    if (error.code === "save-not-eligible") {
      return error.saveReason === "detached-no-custody"
        ? "This detached source has no custody record. Use Save as… and reopen the saved profile to continue."
        : "Compile the current edits before saving the source.";
    }
    if (error.code === "saved-frozen") return "This saved source is frozen. Reopen it explicitly before editing again.";
    if (error.code === "invalid-preview" || error.code === "not-adoptable") {
      return "Both current previews must be acknowledged before applying this appearance.";
    }
    if (error.code === "stale-operation") return "The source changed while this operation was running. Review it again.";
    if (error.code === "disposed") return "This authoring panel is no longer active.";
  }
  if (action === "open") return "The verified v2 source could not be opened for editing.";
  if (action === "compile") return "Compilation could not be completed. Review the source and try again.";
  if (action === "save") return "The source was not saved. The current edits remain available.";
  return "The application appearance could not be applied.";
}

function targetStateLabel(result: { readonly valid: boolean; readonly diagnostics: readonly { readonly severity: string }[] }): string {
  if (!result.valid) return "Unavailable";
  return result.diagnostics.some((diagnostic) => diagnostic.severity === "error") ? "Needs review" : "Ready";
}

function MappingDetails({
  label,
  result,
}: {
  readonly label: string;
  readonly result: PairedV2SuccessfulCompileResponse["solarSail"] | PairedV2SuccessfulCompileResponse["stellarLoom"];
}) {
  const summary = result.mappingReport.summary;
  const disclosed = summary.unsupported + summary.targetSpecific + summary.normalized + summary.overridden;
  return (
    <details className="paired-v2-target-details">
      <summary>{label}: {targetStateLabel(result)}</summary>
      <dl className="paired-v2-summary-grid">
        <div><dt>Consumed</dt><dd>{summary.consumed}</dd></div>
        <div><dt>Normalized</dt><dd>{summary.normalized}</dd></div>
        <div><dt>Overridden</dt><dd>{summary.overridden}</dd></div>
        <div><dt>Target-specific</dt><dd>{summary.targetSpecific}</dd></div>
        <div><dt>Unsupported</dt><dd>{summary.unsupported}</dd></div>
        <div><dt>Disclosed differences</dt><dd>{disclosed}</dd></div>
      </dl>
      <p className="paired-v2-muted">
        Source identity {result.sourceProfileSha256.slice(0, 12)}… · canonical {result.canonicalDigest.slice(0, 12)}…
      </p>
      {label === "Stellar Loom" ? (
        <p className="paired-v2-muted">
          Mapping limit: Starlight retains the template code frame, copy, and syntax presentation plus some secondary color surfaces.
          Those source values remain preserved; a consumed entry does not claim that every value is visibly applied by this consumer.
        </p>
      ) : null}
      {result.diagnostics.length > 0 ? (
        <ul className="paired-v2-diagnostics">
          {result.diagnostics.map((diagnostic, index) => (
            <li key={`${diagnostic.code}-${index}`}>
              <span>{diagnostic.severity}</span> {diagnostic.message}
            </li>
          ))}
        </ul>
      ) : <p className="paired-v2-muted">No target diagnostics.</p>}
    </details>
  );
}

function ExtensionDetails({ response }: { readonly response: PairedV2SuccessfulCompileResponse }) {
  const extension = response.applicationExtension;
  return (
    <details className="paired-v2-target-details">
      <summary>Supplementary application roles: {extension.valid ? "Ready" : "Unavailable"}</summary>
      <p>
        {extension.mappingReport.entries.length} admitted application-only roles are reported separately.
        This is not the full application appearance handoff.
      </p>
      <ul className="paired-v2-mapping-list">
        {extension.mappingReport.entries.map((entry) => (
          <li key={`${entry.sourcePath}-${entry.target}`}>
            <code>{entry.sourcePath}</code> → <code>{entry.target}</code>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function PairedV2AuthoringPanel({
  input,
  bridge,
  sessionUnavailableReason = null,
  onReopen,
  onSaved,
  onAdopt,
  onEdited,
  onWorkflowState,
  onPreviewState,
  requireCorrelatedAck = true,
}: PairedV2AuthoringPanelProps) {
  const identity = useMemo(() => inputIdentity(input), [input]);
  const inputRef = useRef(input);
  inputRef.current = input;
  const mountedRef = useRef(false);
  const panelEpochRef = useRef(0);
  const activeIdentityRef = useRef<string | null>(null);
  const adapterRef = useRef<PairedV2UiAdapter | null>(null);
  const openedIdentityRef = useRef<string | null>(null);
  const frameRefs = useRef<Partial<Record<PairedV2PreviewName, PairedV2PreviewFrame>>>({});
  const responseRef = useRef<PairedV2SuccessfulCompileResponse | null>(null);
  const [adapter, setAdapter] = useState<PairedV2UiAdapter | null>(null);
  const [snapshot, setSnapshot] = useState<PairedV2UiSnapshot>(() => emptySnapshot());
  const [response, setResponse] = useState<PairedV2SuccessfulCompileResponse | null>(null);
  const [buffers, setBuffers] = useState<TextBuffers>(() => initialBuffers(input));
  const [sourceBuffers, setSourceBuffers] = useState<TextBuffers>(() => initialBuffers(input));
  const [busy, setBusy] = useState<BusyAction>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [messageIsError, setMessageIsError] = useState(false);
  const [themeMode, setThemeMode] = useState<"dark" | "light">(PREVIEW_MODE);
  const [saved, setSaved] = useState(false);

  responseRef.current = response;
  const sessionUnavailable = sessionUnavailableReason !== null && sessionUnavailableReason !== undefined;
  const editablePaths: readonly EditablePath[] = [
    "color.dark.primaryAction",
    "typography.ui.family",
    "radius.surface",
  ];
  const changedPaths = editablePaths.filter((path) => bufferValue(buffers, path) !== bufferValue(sourceBuffers, path));
  const invalidBuffer = changedPaths.some((path) => bufferValue(buffers, path).length === 0);
  const invalidFocusedValue = changedPaths
    .map((path) => focusedValueIssue(path, bufferValue(buffers, path)))
    .find((issue): issue is string => issue !== undefined);
  const hasBlockingFocusedValue = invalidBuffer || invalidFocusedValue !== undefined;

  const setPanelMessage = useCallback((next: string | null, error = false) => {
    if (!mountedRef.current) return;
    if (sessionUnavailable) {
      setMessage(sessionUnavailableReason ?? "The native v2 authoring session is unavailable.");
      setMessageIsError(true);
      return;
    }
    setMessage(next);
    setMessageIsError(error);
  }, [sessionUnavailable, sessionUnavailableReason]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const nextAdapter = new PairedV2UiAdapter(bridge);
    setAdapter(nextAdapter);
    return () => {
      nextAdapter.dispose();
      setAdapter((current) => current === nextAdapter ? null : current);
    };
  }, [bridge]);

  useEffect(() => {
    onWorkflowState?.({
      snapshot,
      ...(sessionUnavailable || snapshot.authoring?.latestSuccessful === undefined
        ? {}
        : { acceptedCompile: snapshot.authoring.latestSuccessful }),
    });
  }, [onWorkflowState, sessionUnavailable, snapshot]);

  useEffect(() => {
    if (adapter === null) {
      if (adapterRef.current !== null) {
        adapterRef.current = null;
        openedIdentityRef.current = null;
        activeIdentityRef.current = null;
        panelEpochRef.current += 1;
        frameRefs.current = {};
        responseRef.current = null;
        setResponse(null);
        setSnapshot(emptySnapshot());
        setBusy(null);
        setSaved(false);
        const initial = initialBuffers(inputRef.current);
        setBuffers(initial);
        setSourceBuffers(initial);
      }
      return;
    }
    if (adapterRef.current !== adapter) {
      adapterRef.current = adapter;
      openedIdentityRef.current = null;
      activeIdentityRef.current = null;
      panelEpochRef.current += 1;
      frameRefs.current = {};
      responseRef.current = null;
      setResponse(null);
      setBusy(null);
      setSaved(false);
      const initial = initialBuffers(inputRef.current);
      setBuffers(initial);
      setSourceBuffers(initial);
    }
    if (openedIdentityRef.current === identity) return;
    panelEpochRef.current += 1;
    activeIdentityRef.current = identity;
    const nextInput = inputRef.current;
    const operationEpoch = panelEpochRef.current;
    try {
      const current = adapter.snapshot();
      if (nextInput.mode === "detached") {
        if (current.lifecycle !== "empty") adapter.reset(nextInput.capability);
        setSnapshot(adapter.snapshot());
        setResponse(null);
        const initial = initialBuffers(nextInput);
        setBuffers(initial);
        setSourceBuffers(initial);
        frameRefs.current = {};
        responseRef.current = null;
        setBusy(null);
        setPanelMessage("Verifying the detached candidate with a fresh native session…");
        setSaved(false);
        openedIdentityRef.current = identity;
        void adapter.promoteDetached(nextInput).then((outcome) => {
          if (!mountedRef.current || panelEpochRef.current !== operationEpoch || activeIdentityRef.current !== identity) return;
          setSnapshot(outcome.snapshot);
          if (outcome.accepted) {
            responseRef.current = outcome.response;
            setResponse(outcome.response);
            const verified = buffersFromSnapshot(outcome.snapshot, nextInput);
            setBuffers(verified);
            setSourceBuffers(verified);
            setPanelMessage("Detached source verified. Review the native result before editing or applying it.");
          } else if (outcome.reason === "refused") {
            responseRef.current = null;
            setResponse(null);
            setPanelMessage("The detached candidate could not be verified; no previous session was reused.", true);
          }
        }).catch((error) => {
          if (mountedRef.current && panelEpochRef.current === operationEpoch && activeIdentityRef.current === identity) {
            setSnapshot(adapter.snapshot());
            setPanelMessage(errorMessage(error, "open"), true);
          }
        });
      } else {
        if (current.lifecycle === "empty" || current.lifecycle === "refused") adapter.open(nextInput);
        else adapter.reopen(nextInput);
        openedIdentityRef.current = identity;
        frameRefs.current = {};
        responseRef.current = null;
        setResponse(null);
        const opened = buffersFromSnapshot(adapter.snapshot(), nextInput);
        setBuffers(opened);
        setSourceBuffers(opened);
        setBusy(null);
        if (sessionUnavailable) {
          setPanelMessage(sessionUnavailableReason ?? "The native v2 authoring session is unavailable.", true);
        } else {
          setMessage(null);
          setMessageIsError(false);
        }
        setSaved(false);
        if (mountedRef.current) setSnapshot(adapter.snapshot());
      }
    } catch (error) {
      openedIdentityRef.current = identity;
      frameRefs.current = {};
      responseRef.current = null;
      setResponse(null);
      setPanelMessage(errorMessage(error, "open"), true);
      if (mountedRef.current) setSnapshot(adapter.snapshot());
    }
  }, [adapter, identity, setPanelMessage]);

  useEffect(() => {
    if (!sessionUnavailable) return;
    frameRefs.current = {};
    setPanelMessage(sessionUnavailableReason ?? "The native v2 authoring session is unavailable.", true);
  }, [sessionUnavailable, sessionUnavailableReason, setPanelMessage]);

  const updateEditedSnapshot = useCallback((next: PairedV2UiSnapshot) => {
    if (!mountedRef.current) return;
    setSnapshot(next);
    onEdited?.(next);
  }, [onEdited]);

  const commitEdit = useCallback((
    path: EditablePath,
    kind: "set-color" | "set-typography" | "set-radius",
    value: string,
  ) => {
    if (saved || sessionUnavailable || adapter === null) return;
    const issue = focusedValueIssue(path, value);
    const removePathAndInvalidate = () => {
      const before = adapter.snapshot();
      const hadEdit = before.authoring?.edits[path] !== undefined;
      const hadSuccessfulCompile = before.authoring?.latestSuccessful !== undefined;
      const next = adapter.removeEdit(path);
      if (!hadEdit && hadSuccessfulCompile) {
        return adapter.setEdits(Object.values(before.authoring?.edits ?? {}));
      }
      return next;
    };
    try {
      const next = value.length === 0 || issue !== undefined || value === bufferValue(sourceBuffers, path)
        ? removePathAndInvalidate()
        : adapter.setEdit({ kind, path, value } as PairedV2EditForPanel);
      frameRefs.current = {};
      responseRef.current = null;
      setResponse(null);
      updateEditedSnapshot(next);
      setPanelMessage(issue ?? (value.length === 0 ? "Enter a value before compiling." : "Unsaved edits ready to compile."), issue !== undefined);
    } catch (error) {
      frameRefs.current = {};
      responseRef.current = null;
      setResponse(null);
      try {
        const next = removePathAndInvalidate();
        updateEditedSnapshot(next);
      } catch {
        // The adapter may already be retired; the local response is still cleared.
      }
      setPanelMessage(errorMessage(error, "compile"), true);
    }
  }, [adapter, saved, sessionUnavailable, setPanelMessage, sourceBuffers, updateEditedSnapshot]);

  const handlePreviewState = useCallback((preview: PairedV2PreviewName, state: PreviewApplicationState) => {
    if (!mountedRef.current) return;
    if (sessionUnavailable || adapter === null) {
      onPreviewState?.(preview, state);
      return;
    }
    const currentResponse = responseRef.current;
    if (currentResponse !== null && state.revision === currentResponse.uiRevision) {
      if (state.state === "pending") {
        try {
          frameRefs.current[preview] = adapter.beginPreviewFrame(preview, state.frameId);
        } catch {
          delete frameRefs.current[preview];
        }
      } else if (state.state === "failed") {
        const frame = frameRefs.current[preview];
        if (frame?.frameToken === state.frameId) {
          adapter.resetPreviewFrame(frame);
          delete frameRefs.current[preview];
        }
      } else if (state.state === "applied") {
        const frame = frameRefs.current[preview];
        if (frame?.frameToken === state.frameId) {
          const ack = {
            frameToken: state.frameId,
            sessionId: frame.sessionId,
            uiRevision: state.revision,
            rawSourceSha256: frame.rawSourceSha256,
            canonicalDigest: frame.canonicalDigest,
            frameId: state.frameId,
          };
          const accepted = preview === "application"
            ? adapter.recordApplicationAck(frame, ack)
            : adapter.recordStarlightAck(frame, ack);
          if (!accepted) {
            adapter.resetPreviewFrame(frame);
            delete frameRefs.current[preview];
          }
        }
      }
      setSnapshot(adapter.snapshot());
    }
    onPreviewState?.(preview, state);
  }, [adapter, onPreviewState, sessionUnavailable]);

  const handleCompile = useCallback(async () => {
    if (
      saved ||
      sessionUnavailable ||
      adapter === null ||
      busy !== null ||
      snapshot.pendingCompile ||
      snapshot.pendingSave ||
      snapshot.lifecycle !== "ready"
    ) return;
    if (hasBlockingFocusedValue) {
      setPanelMessage(invalidFocusedValue ?? "Enter all three focused values before compiling.", true);
      return;
    }
    setBusy("compile");
    frameRefs.current = {};
    responseRef.current = null;
    setResponse(null);
    setPanelMessage("Compiling the current source with both target adapters…");
    setSnapshot(adapter.snapshot());
    const operationEpoch = panelEpochRef.current;
    const operationIdentity = activeIdentityRef.current;
    try {
      const compilePromise = adapter.compile();
      setSnapshot(adapter.snapshot());
      const outcome = await compilePromise;
      if (!mountedRef.current || panelEpochRef.current !== operationEpoch || activeIdentityRef.current !== operationIdentity) return;
      setSnapshot(adapter.snapshot());
      if (outcome.accepted) {
        responseRef.current = outcome.response;
        setResponse(outcome.response);
        setPanelMessage(
          outcome.response.status === "partial"
            ? "Compiled. Target-specific and unsupported differences remain disclosed below."
            : "Compiled. Review both previews before applying the appearance."
        );
      } else {
        setResponse(null);
        setPanelMessage(
          outcome.reason === "stale" || outcome.reason === "superseded"
            ? "This compile was superseded by a newer edit."
            : "Compilation did not produce a current draft.",
          true
        );
      }
    } catch (error) {
      if (mountedRef.current && panelEpochRef.current === operationEpoch && activeIdentityRef.current === operationIdentity) {
        setPanelMessage(errorMessage(error, "compile"), true);
      }
    } finally {
      if (mountedRef.current && panelEpochRef.current === operationEpoch && activeIdentityRef.current === operationIdentity) {
        setBusy(null);
        setSnapshot(adapter.snapshot());
      }
    }
  }, [adapter, busy, hasBlockingFocusedValue, invalidFocusedValue, saved, sessionUnavailable, setPanelMessage, snapshot.lifecycle, snapshot.pendingCompile, snapshot.pendingSave]);

  const handleSave = useCallback(async (mode: "edited" | "new-document") => {
    if (
      saved ||
      sessionUnavailable ||
      adapter === null ||
      busy !== null ||
      snapshot.pendingCompile ||
      snapshot.pendingSave ||
      responseRef.current === null
    ) return;
    setBusy(mode === "edited" ? "save" : "save-as");
    setPanelMessage(mode === "edited" ? "Saving the verified source…" : "Preparing the native Save as… dialog…");
    setSnapshot(adapter.snapshot());
    const operationEpoch = panelEpochRef.current;
    const operationIdentity = activeIdentityRef.current;
    try {
      const savePromise = adapter.save(mode);
      setSnapshot(adapter.snapshot());
      const result = await savePromise;
      if (!mountedRef.current || panelEpochRef.current !== operationEpoch || activeIdentityRef.current !== operationIdentity) return;
      setSnapshot(adapter.snapshot());
      if (result.saved) {
        setSaved(true);
        setPanelMessage("Source saved. Reopen the saved profile to continue editing; no automatic rebase was performed.");
      } else if (result.cancelled) {
        setPanelMessage("Save cancelled. Your unsaved edits remain available.");
      } else {
        setPanelMessage("Source was not saved. Your unsaved edits remain available.", true);
      }
      onSaved?.(result);
    } catch (error) {
      if (mountedRef.current && panelEpochRef.current === operationEpoch && activeIdentityRef.current === operationIdentity) {
        setPanelMessage(errorMessage(error, "save"), true);
      }
    } finally {
      if (mountedRef.current && panelEpochRef.current === operationEpoch && activeIdentityRef.current === operationIdentity) {
        setBusy(null);
        setSnapshot(adapter.snapshot());
      }
    }
  }, [adapter, busy, onSaved, saved, sessionUnavailable, setPanelMessage, snapshot.pendingCompile, snapshot.pendingSave]);

  const handleAdopt = useCallback(() => {
    if (
      saved ||
      sessionUnavailable ||
      adapter === null ||
      busy !== null ||
      snapshot.pendingCompile ||
      snapshot.pendingSave
    ) return;
    const candidate = adapter.applicationAppearanceCandidate();
    if (candidate === undefined) {
      setPanelMessage("Both current previews must acknowledge this compile before applying it.", true);
      return;
    }
    if (onAdopt === undefined) {
      setPanelMessage("Application adoption is not available from this parent.", true);
      return;
    }
    try {
      const result = onAdopt(candidate);
      setPanelMessage(result.ok ? (result.message ?? "Application appearance applied as an unsaved draft.") : (result.message ?? "Application appearance was not applied."), !result.ok);
    } catch (error) {
      setPanelMessage(errorMessage(error, "adopt"), true);
    }
  }, [adapter, busy, onAdopt, saved, sessionUnavailable, setPanelMessage, snapshot.pendingCompile, snapshot.pendingSave]);

  const handleReopen = useCallback(() => {
    if (busy !== null || snapshot.pendingCompile || snapshot.pendingSave) return;
    if (onReopen === undefined) {
      setPanelMessage("Reopen is controlled by the parent so the saved source can be verified explicitly.", true);
      return;
    }
    onReopen();
  }, [busy, onReopen, setPanelMessage, snapshot.pendingCompile, snapshot.pendingSave]);

  const sourceProfile = snapshot.document?.v2Profile ?? snapshot.detachedSource?.v2Profile;
  const ready = snapshot.lifecycle === "ready" && sourceProfile !== undefined;
  const detached = snapshot.sourceMode === "detached";
  const hasCompiledResponse = response !== null;
  const actionBusy = busy !== null || snapshot.pendingCompile || snapshot.pendingSave;

  return (
    <article className="paired-v2-authoring-panel" data-testid="paired-v2-authoring-panel" aria-labelledby="paired-v2-authoring-title">
      <header className="paired-v2-panel-header">
        <div>
          <p className="paired-v2-eyebrow">Application appearance</p>
          <h2 id="paired-v2-authoring-title">Refine a verified v2 profile</h2>
          <p className="paired-v2-source-name">
            {snapshot.document?.displayName ?? (snapshot.detachedSource === undefined ? (input.mode === "detached" ? "Detached candidate" : input.document.displayName) : "Detached verified candidate")}
          </p>
        </div>
        <span className={`paired-v2-status-pill ${ready ? "ready" : "unavailable"}`}>
          {ready ? "Ready to edit" : "Read-only / unavailable"}
        </span>
      </header>

      {message !== null ? <p className={messageIsError ? "paired-v2-message error" : "paired-v2-message"} role={messageIsError ? "alert" : "status"}>{message}</p> : null}

      {!ready ? (
        <div className="paired-v2-empty-state" role="status">
          <strong>{adapter === null ? "Preparing v2 authoring…" : "Editing is unavailable for this source."}</strong>
          <p>A verified v2 source and the separate native v2 authoring capability are required. Detached candidates remain unavailable until native verification completes; the legacy v1 editor is not used as a fallback.</p>
        </div>
      ) : (
        <>
          <section className="paired-v2-source-summary" aria-label="Verified source summary">
            <div><span>Profile</span><strong>{sourceProfile?.name} · {sourceProfile?.version}</strong></div>
            <div><span>Custody</span><strong>{detached ? "Detached verified bytes" : "Verified source bytes"}</strong></div>
            <div><span>Revision</span><strong>{snapshot.authoring?.revision ?? 0}</strong></div>
            <div><span>Edits</span><strong>{Object.keys(snapshot.authoring?.edits ?? {}).length}</strong></div>
          </section>
          {detached ? <p className="paired-v2-muted">This source is verified but has no document custody. Save as… creates a new document; reopen it explicitly before continuing.</p> : null}

          <section className="paired-v2-controls" aria-labelledby="paired-v2-controls-title">
            <div className="paired-v2-section-heading">
              <div><h3 id="paired-v2-controls-title">Focused controls</h3><p>Make a small visual change, then compile both previews.</p></div>
              <span className="paired-v2-muted">Other v2 groups stay unchanged.</span>
            </div>
            <div className="paired-v2-control-grid">
              <label>
                <span>Primary action color <small>dark mode</small></span>
                <input aria-label="Primary action color" value={buffers.color} onChange={(event) => {
                  const value = event.target.value;
                  setBuffers((current) => ({ ...current, color: value }));
                  commitEdit("color.dark.primaryAction", "set-color", value);
                }} disabled={actionBusy || saved || sessionUnavailable} />
              </label>
              <label>
                <span>Interface font family</span>
                <input aria-label="Interface font family" value={buffers.typography} onChange={(event) => {
                  const value = event.target.value;
                  setBuffers((current) => ({ ...current, typography: value }));
                  commitEdit("typography.ui.family", "set-typography", value);
                }} disabled={actionBusy || saved || sessionUnavailable} />
              </label>
              <label>
                <span>Surface radius</span>
                <input aria-label="Surface radius" value={buffers.radius} onChange={(event) => {
                  const value = event.target.value;
                  setBuffers((current) => ({ ...current, radius: value }));
                  commitEdit("radius.surface", "set-radius", value);
                }} disabled={actionBusy || saved || sessionUnavailable} />
              </label>
            </div>
            {saved ? <p className="paired-v2-saved-lock" role="status">This saved source is held unchanged. Reopen it explicitly before making another edit.</p> : null}
            {invalidBuffer ? <p className="paired-v2-field-hint">A temporarily empty field is allowed while editing, but compile and save wait until all focused values are filled.</p> : invalidFocusedValue !== undefined ? <p className="paired-v2-field-hint">{invalidFocusedValue}</p> : null}
          </section>

          <section className="paired-v2-actions" aria-label="Profile actions">
            <div className="paired-v2-mode-buttons" role="group" aria-label="Preview color mode">
              {(["dark", "light"] as const).map((mode) => <button key={mode} type="button" className={themeMode === mode ? "selected" : ""} aria-pressed={themeMode === mode} onClick={() => setThemeMode(mode)}>{mode === "dark" ? "Dark preview" : "Light preview"}</button>)}
            </div>
            <div className="paired-v2-action-buttons">
              <button type="button" onClick={() => void handleCompile()} disabled={actionBusy || saved || sessionUnavailable || hasBlockingFocusedValue}>
                {busy === "compile" ? "Compiling…" : "Compile"}
              </button>
              <button type="button" onClick={handleAdopt} disabled={actionBusy || saved || sessionUnavailable || !snapshot.canAdoptPaired || onAdopt === undefined}>Apply to application</button>
              <button type="button" onClick={() => void handleSave("edited")} disabled={actionBusy || saved || sessionUnavailable || detached || !hasCompiledResponse}>Save profile</button>
              <button type="button" onClick={() => void handleSave("new-document")} disabled={actionBusy || saved || sessionUnavailable || !hasCompiledResponse}>Save as…</button>
              <button type="button" className="secondary" onClick={handleReopen} disabled={actionBusy}>Reopen</button>
            </div>
          </section>

          {response !== null ? (
            <section className="paired-v2-compile-review" aria-labelledby="paired-v2-review-title">
              <div className="paired-v2-section-heading"><div><h3 id="paired-v2-review-title">Review the compiled result</h3><p>{response.status === "partial" ? "Both targets compiled with disclosed differences." : "Both targets compiled successfully."}</p></div><span className="paired-v2-review-identity">Revision {response.uiRevision}</span></div>
              <div className="paired-v2-details-list">
                <MappingDetails label="Solar Sail" result={response.solarSail} />
                <MappingDetails label="Stellar Loom" result={response.stellarLoom} />
                <ExtensionDetails response={response} />
                <details className="paired-v2-target-details">
                  <summary>Full application appearance: {response.applicationAppearance.valid ? "Ready" : "Unavailable"}</summary>
                  <p>The native shared recipe supplied the complete application CSS used for adoption. It is distinct from the supplementary extension report.</p>
                </details>
              </div>
            </section>
          ) : null}

          {response !== null ? (
            <section className="paired-v2-previews" aria-label="Compiled previews">
              <ApplicationPreview
                css={response.solarSail.compiledCss ?? ""}
                revision={response.uiRevision}
                mode={themeMode}
                onPreviewState={(state) => handlePreviewState("application", state)}
              />
              <StarlightPreview
                css={response.stellarLoom.compiledCss ?? ""}
                revision={response.uiRevision}
                mode={themeMode}
                requireCorrelatedAck={requireCorrelatedAck}
                onPreviewState={(state) => handlePreviewState("starlight", state)}
              />
            </section>
          ) : (
            <div className="paired-v2-preview-empty"><p>Compile to open the Solar Sail and Starlight previews.</p></div>
          )}
        </>
      )}
    </article>
  );
}

type PairedV2EditForPanel =
  | { readonly kind: "set-color"; readonly path: "color.dark.primaryAction"; readonly value: string }
  | { readonly kind: "set-typography"; readonly path: "typography.ui.family"; readonly value: string }
  | { readonly kind: "set-radius"; readonly path: "radius.surface"; readonly value: string };

