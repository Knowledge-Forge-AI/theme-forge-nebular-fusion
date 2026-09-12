import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  Artboard,
  ElementType,
  LayoutDirective,
  SceneAccessibility,
  SceneDefinitions,
  SceneDiagnosticDto,
  SceneDraftResponse,
  SceneEditOperation,
  SceneElement,
  SceneMetricsDto,
  ScenePacketResponse,
  ScenePlanResponse,
  ScenePresetName,
  SceneProfile,
  SceneReceiptDto,
  SceneStatusResponse,
  SceneVerificationResponse,
  VectorGraphicsBridge,
  VectorGraphicsLabProps,
  VectorScene,
} from "../types";
import { TauriVectorGraphicsBridge } from "../vector-graphics-bridge";
import { SerializedEditQueue } from "../edit-queue";
import { BlobPreviewManager } from "../blob-preview";
import { ActionToolbar } from "./ActionToolbar";
import { CanvasPreview } from "./CanvasPreview";
import { LayerList } from "./LayerList";
import { ShapeInspector } from "./ShapeInspector";
import { ArtboardControls } from "./ArtboardControls";
import { ExchangePanel } from "./ExchangePanel";

type ActiveTab = "canvas" | "layers" | "inspector" | "artboard" | "exchange";

function sanitizeErrorMessage(err: unknown, fallback = "An unexpected error occurred"): string {
  if (!err) return fallback;
  if (err instanceof Error) {
    return err.message || fallback;
  }
  if (typeof err === "string") {
    return err;
  }
  if (typeof err === "object" && err !== null
    && Reflect.ownKeys(err).length === 3
    && ["schemaVersion", "reasonCode", "message"].every(key => Object.hasOwn(err, key))
    && "schemaVersion" in err && err.schemaVersion === 1
    && "reasonCode" in err && typeof err.reasonCode === "string"
    && "message" in err && typeof err.message === "string"
    && Object.hasOwn(SAFE_SCENE_REASON_MESSAGES, err.reasonCode)) {
    return `Scene operation failed (${err.reasonCode}): ${SAFE_SCENE_REASON_MESSAGES[err.reasonCode]}`;
  }
  return fallback;
}

const SAFE_REASON_MESSAGES: Record<string, string> = {
  "selection-rejected": "Destination already exists (collision) or target selection was rejected.",
  "plan-invalid": "The retained publication plan is invalid or was already consumed.",
  "plan-expired": "The retained publication plan expired.",
  "digest-mismatch": "The scene content changed and does not match the publication plan digest.",
  "stale": "The publication plan is stale due to scene revisions.",
  "context-stale": "The project or scene session context changed.",
  "context-invalid": "The project or scene context is invalid.",
  "domain-failed": "The vector publication operation failed.",
  "sidecar-crashed": "The scene session failed. Restart the application before retrying.",
  "cancelled": "The publication operation was cancelled.",
  "capability-unavailable": "The requested publication capability is unavailable.",
  "request-busy": "Another publication operation is active.",
  "request-timeout": "The bounded publication operation timed out.",
  "protocol-invalid": "The publication request protocol was invalid.",
  "plan-active": "Another publication plan is currently active.",
  "result-too-large": "The publication payload exceeded the size limit.",
  "dialog-unavailable": "The system file dialog is unavailable.",
};

// Use the same fixed-message boundary as publication, with Scene operation wording.
// The serialized backend message is never rendered.
const SAFE_SCENE_REASON_MESSAGES: Record<string, string> = {
  ...SAFE_REASON_MESSAGES,
  "selection-rejected": "The selected file was rejected.",
  "plan-invalid": "The retained plan is invalid or was already consumed.",
  "plan-expired": "The retained plan expired.",
  "digest-mismatch": "The scene content changed and does not match the expected digest.",
  "stale": "The scene revision changed. Retry with the current draft.",
  "domain-failed": "The scene operation failed.",
  "cancelled": "The scene operation was cancelled.",
  "capability-unavailable": "The requested scene capability is unavailable.",
  "request-busy": "Another scene operation is active.",
  "request-timeout": "The bounded scene operation timed out.",
  "protocol-invalid": "The scene request protocol was invalid.",
  "plan-active": "Another plan is currently active.",
  "result-too-large": "The scene payload exceeded the size limit.",
  "cursor-stale": "The retained cursor is stale.",
  "sidecar-artifact-unavailable": "The scene engine artifact is unavailable.",
  "sidecar-artifact-invalid": "The scene engine artifact failed authentication.",
  "sidecar-busy": "The scene engine is busy.",
  "sidecar-protocol-invalid": "The scene engine returned an invalid protocol response.",
  "sidecar-startup-timeout": "The scene engine startup timed out.",
  "sidecar-request-timeout": "The scene engine request timed out.",
  "sidecar-shutdown-failed": "The scene engine did not shut down cleanly. Restart the application before retrying.",
  "sidecar-remote-rejected": "The scene engine rejected the request.",
};

function formatPublicationError(err: unknown): string {
  // Tauri serializes StudioCommandError as an object with a kebab-case reasonCode.
  // Only recognized constants cross into UI text; never echo exception messages.
  const reason = typeof err === "object" && err !== null && "reasonCode" in err
    ? err.reasonCode : undefined;
  const code = typeof reason === "string" && Object.hasOwn(SAFE_REASON_MESSAGES, reason)
    ? reason : "domain-failed";
  return `Publication failed (${code}): ${SAFE_REASON_MESSAGES[code]}`;
}

export function VectorGraphicsLab({ bridge: bridgeProp, projectHandle }: VectorGraphicsLabProps) {
  const bridge = useMemo<VectorGraphicsBridge>(
    () => bridgeProp ?? new TauriVectorGraphicsBridge(),
    [bridgeProp],
  );

  // Core Session & Draft State
  const [sessionId, setSessionId] = useState<string>("scene-init");
  const [revision, setRevision] = useState<number>(1);
  const [draftInputDigest, setDraftInputDigest] = useState<string>("");
  const [sourceId, setSourceId] = useState<string | undefined>();
  const [dirty, setDirty] = useState<boolean>(false);
  const [scene, setScene] = useState<VectorScene | null>(null);

  // Selection
  const [selectedLayerIndex, setSelectedLayerIndex] = useState<number | null>(null);

  // Preview & Blob Lifetime State
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewRevision, setPreviewRevision] = useState<number | null>(null);
  const [isCompiling, setIsCompiling] = useState<boolean>(false);
  const [compileError, setCompileError] = useState<string | null>(null);
  const [publicationError, setPublicationError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<readonly SceneDiagnosticDto[]>([]);
  const [metrics, setMetrics] = useState<SceneMetricsDto | null>(null);
  const [receipt, setReceipt] = useState<SceneReceiptDto | null>(null);
  const [previewReceipt, setPreviewReceipt] = useState<SceneReceiptDto | null>(null);
  const [sourceWarning, setSourceWarning] = useState<string | null>(null);

  // Workflows & Plans
  const [pendingSavePlan, setPendingSavePlan] = useState<ScenePlanResponse | null>(null);
  const [pendingExportPlan, setPendingExportPlan] = useState<ScenePlanResponse | null>(null);
  const [retainedPackets, setRetainedPackets] = useState<readonly ScenePacketResponse[]>([]);
  const [selectedPacketId, setSelectedPacketId] = useState<string | null>(null);
  const [lastVerification, setLastVerification] = useState<SceneVerificationResponse | null>(null);
  const [isActionInProgress, setIsActionInProgress] = useState<boolean>(false);

  // Navigation
  const [activeTab, setActiveTab] = useState<ActiveTab>("canvas");

  // Edit Queue and Blob Preview refs
  const editQueueRef = useRef<SerializedEditQueue | null>(null);
  const blobPreviewRef = useRef<BlobPreviewManager>(new BlobPreviewManager());
  const isMountedRef = useRef<boolean>(true);
  const sessionIdRef = useRef<string>("scene-init");
  const latestRevisionRef = useRef<number>(1);
  latestRevisionRef.current = revision;

  // Initialize draft on mount
  useEffect(() => {
    isMountedRef.current = true;
    const blobManager = blobPreviewRef.current;

    async function initSession() {
      try {
        let status: SceneStatusResponse | null = null;
        try {
          status = await bridge.getStatus();
        } catch {
          // No active session or status check unsupported
        }

        if (status && !status.disposed && status.scene) {
          if (!isMountedRef.current) return;
          sessionIdRef.current = status.sessionId;
          latestRevisionRef.current = status.revision;
          setSessionId(status.sessionId);
          setRevision(status.revision);
          setDraftInputDigest(status.draftInputDigest);
          setSourceId(status.sourceId);
          setDirty(status.dirty);
          setScene(status.scene);

          const restoredDraft: SceneDraftResponse = {
            sessionId: status.sessionId,
            revision: status.revision,
            sourceId: status.sourceId,
            dirty: status.dirty,
            scene: status.scene,
            canonicalJson: JSON.stringify(status.scene),
            draftInputDigest: status.draftInputDigest,
            tokenSnapshotId: status.tokenSnapshotId,
            diagnostics: [],
          };
          editQueueRef.current = new SerializedEditQueue(bridge, restoredDraft);
          await triggerCompile();
          return;
        }

        const initialDraft = await bridge.newScene({
          preset: "hero",
          profile: "illustration",
        });
        if (!isMountedRef.current) return;

        sessionIdRef.current = initialDraft.sessionId;
        latestRevisionRef.current = initialDraft.revision;
        setSessionId(initialDraft.sessionId);
        setRevision(initialDraft.revision);
        setDraftInputDigest(initialDraft.draftInputDigest);
        setSourceId(initialDraft.sourceId);
        setDirty(initialDraft.dirty);
        setScene(initialDraft.scene);

        // Initialize serialized edit queue
        editQueueRef.current = new SerializedEditQueue(bridge, initialDraft);

        // Trigger compile for initial SVG blob
        await triggerCompile();
      } catch (err) {
        if (!isMountedRef.current) return;
        setCompileError(sanitizeErrorMessage(err));
      }
    }

    void initSession();

    return () => {
      isMountedRef.current = false;
      blobManager.dispose();
    };
  }, [bridge]);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const status = await bridge.getStatus();
        if (active && status.sessionId === sessionIdRef.current) {
          setSourceWarning(status.diagnostics?.find(d => d.code === "TOKEN_SOURCE_CHANGED")?.message ?? null);
        }
      } catch { /* Cached freshness is unavailable until a session exists. */ }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => { active = false; clearInterval(timer); };
  }, [bridge, projectHandle]);

  // Stale check
  const isStale = previewRevision !== null && previewRevision !== revision;

  // Publication gating: require valid compile evidence and no compile error
  const canSaveOrExport = !compileError && !isCompiling && previewRevision === revision && receipt !== null;

  // Trigger Compilation with Stale Response Discarding
  const triggerCompile = async () => {
    if (!isMountedRef.current || !editQueueRef.current) return;
    // Snapshot the complete adopted binding. Native equality treats absent source
    // and token identities as meaningful, including after Open, Bind and Save.
    const compileExpected = editQueueRef.current.getExpected();
    const { revision: targetRevision, sessionId: targetSessionId, draftInputDigest: targetDigest } = compileExpected;
    setIsCompiling(true);
    setCompileError(null);

    try {
      const response = await bridge.compileScene({ expected: compileExpected });

      // Stale check: discard out-of-order stale compilation responses
      if (
        !isMountedRef.current ||
        sessionIdRef.current !== targetSessionId ||
        response.sessionId !== targetSessionId ||
        response.revision !== targetRevision ||
        response.draftInputDigest !== targetDigest ||
        latestRevisionRef.current !== targetRevision
      ) {
        // Discard stale response
        return;
      }

      setDiagnostics(response.diagnostics);
      if (response.metrics) setMetrics(response.metrics);
      if (response.receipt) setReceipt(response.receipt);

      if (response.svg) {
        const updateResult = await blobPreviewRef.current.updatePreview(
          response.svg,
          response.revision,
          () =>
            isMountedRef.current &&
            sessionIdRef.current === targetSessionId &&
            latestRevisionRef.current === targetRevision,
        );

        if (
          updateResult &&
          isMountedRef.current &&
          sessionIdRef.current === targetSessionId &&
          latestRevisionRef.current === targetRevision
        ) {
          setPreviewReceipt(response.receipt ?? null);
          setPreviewUrl(updateResult.url);
          setPreviewRevision(updateResult.revision);
        }
      } else {
        setReceipt(null);
        setCompileError("Current scene compilation failed. Last-good preview is stale.");
      }
    } catch (err) {
      if (
        isMountedRef.current &&
        sessionIdRef.current === targetSessionId &&
        latestRevisionRef.current === targetRevision
      ) {
        setCompileError(sanitizeErrorMessage(err));
      }
    } finally {
      if (isMountedRef.current) {
        setIsCompiling(false);
      }
    }
  };

  // Enqueue Edit Operation
  const applyEditOperations = async (ops: readonly SceneEditOperation[]) => {
    if (!editQueueRef.current) return;
    // Invalidate pending publication plans and candidate verification on edit
    setPendingSavePlan(null);
    setPendingExportPlan(null);
    setLastVerification(null);
    setPublicationError(null);

    try {
      const updatedDraft = await editQueueRef.current.enqueue(ops);
      if (!isMountedRef.current) return;

      latestRevisionRef.current = updatedDraft.revision;
      setRevision(updatedDraft.revision);
      setDraftInputDigest(updatedDraft.draftInputDigest);
      setDirty(updatedDraft.dirty);
      setScene(updatedDraft.scene);
    } catch (err) {
      setCompileError(sanitizeErrorMessage(err));
    }
  };

  // Layer Operations
  const handleAddLayer = (type: ElementType) => {
    let newElement: SceneElement;
    const count = scene?.elements.length ?? 0;
    const baseId = `${type}-${count + 1}`;

    switch (type) {
      case "rect":
        newElement = { type: "rect", id: baseId, x: 50, y: 50, width: 200, height: 120, presentation: { fill: { type: "solid", color: "#38bdf8" } } };
        break;
      case "circle":
        newElement = { type: "circle", id: baseId, cx: 150, cy: 150, r: 60, presentation: { fill: { type: "solid", color: "#8b5cf6" } } };
        break;
      case "ellipse":
        newElement = { type: "ellipse", id: baseId, cx: 200, cy: 150, rx: 80, ry: 50, presentation: { fill: { type: "solid", color: "#ec4899" } } };
        break;
      case "line":
        newElement = { type: "line", id: baseId, x1: 20, y1: 20, x2: 220, y2: 120, presentation: { stroke: { type: "solid", color: "#f6c65b" }, strokeWidth: 3 } };
        break;
      case "polyline":
        newElement = { type: "polyline", id: baseId, points: [[20, 20], [80, 80], [140, 30]], presentation: { stroke: { type: "solid", color: "#10b981" }, strokeWidth: 2 } };
        break;
      case "polygon":
        newElement = { type: "polygon", id: baseId, points: [[50, 20], [90, 80], [10, 80]], presentation: { fill: { type: "solid", color: "#f59e0b" } } };
        break;
      case "path":
        newElement = { type: "path", id: baseId, d: "M 10 10 C 20 20, 40 20, 50 10 Z", presentation: { fill: { type: "solid", color: "#6366f1" } } };
        break;
      case "group":
        newElement = { type: "group", id: baseId, children: [] };
        break;
      case "use":
        newElement = { type: "use", id: baseId, href: "#symbol-1", x: 40, y: 40 };
        break;
      case "diagramNode":
        newElement = { type: "diagramNode", id: baseId, label: "Node", x: 100, y: 100, width: 140, height: 60, rx: 8, ry: 8 };
        break;
      case "connector":
        newElement = { type: "connector", id: baseId, routing: "straight", from: { x: 50, y: 50 }, to: { x: 200, y: 200 } };
        break;
      case "label":
        newElement = { type: "label", id: baseId, text: "New Text", x: 100, y: 100, scale: 18, presentation: { fill: { type: "solid", color: "#ffffff" } } };
        break;
    }

    void applyEditOperations([{ type: "insertElement", element: newElement }]);
    setSelectedLayerIndex(count);
  };

  const handleRemoveLayer = (index: number) => {
    if (!scene || index < 0 || index >= scene.elements.length) return;
    const elem = scene.elements[index];
    if (!elem?.id) return;
    void applyEditOperations([{ type: "removeElement", id: elem.id }]);
    setSelectedLayerIndex(null);
  };

  const handleMoveUp = (index: number) => {
    if (!scene || index <= 0) return;
    const elem = scene.elements[index];
    if (!elem?.id) return;
    void applyEditOperations([{ type: "moveElement", id: elem.id, newIndex: index - 1 }]);
    setSelectedLayerIndex(index - 1);
  };

  const handleMoveDown = (index: number) => {
    if (!scene || index >= scene.elements.length - 1) return;
    const elem = scene.elements[index];
    if (!elem?.id) return;
    void applyEditOperations([{ type: "moveElement", id: elem.id, newIndex: index + 1 }]);
    setSelectedLayerIndex(index + 1);
  };

  const handleUpdateElement = (updated: SceneElement) => {
    if (!updated.id) return;
    void applyEditOperations([{ type: "updateElement", id: updated.id, element: updated }]);
  };

  // Artboard & Profile
  const handleProfileChange = (newProfile: SceneProfile) => {
    void applyEditOperations([{ type: "setProfile", profile: newProfile }]);
  };

  const handleArtboardChange = (newArtboard: Artboard) => {
    void applyEditOperations([{ type: "setArtboard", artboard: newArtboard }]);
  };

  const handleAccessibilityChange = (newA11y: SceneAccessibility) => {
    void applyEditOperations([{ type: "setAccessibility", accessibility: newA11y }]);
  };

  // Flush Helper before Actions
  const flushBeforeAction = async () => {
    if (editQueueRef.current) {
      await editQueueRef.current.flush();
    }
  };

  // Action Toolbar Handlers
  const handleNewScene = async (preset: ScenePresetName, profile: SceneProfile) => {
    if (dirty && !window.confirm("You have unsaved changes. Discard them and create a new scene?")) {
      return;
    }
    setIsActionInProgress(true);
    try {
      await flushBeforeAction();
      const expected = editQueueRef.current?.getExpected();
      const draft = await bridge.newScene({
        expected,
        replacementIntentId: `replace-${Date.now()}`,
        preset,
        profile,
      });
      sessionIdRef.current = draft.sessionId;
      latestRevisionRef.current = draft.revision;
      setSessionId(draft.sessionId);
      setRevision(draft.revision);
      setDraftInputDigest(draft.draftInputDigest);
      setSourceId(undefined);
      setDirty(draft.dirty);
      setScene(draft.scene);
      setSelectedLayerIndex(null);
      editQueueRef.current = new SerializedEditQueue(bridge, draft);
      await triggerCompile();
    } catch (err) {
      setCompileError(sanitizeErrorMessage(err));
    } finally {
      setIsActionInProgress(false);
    }
  };

  const handleOpenScene = async () => {
    if (dirty && !window.confirm("You have unsaved changes. Discard them and open another scene?")) {
      return;
    }
    setIsActionInProgress(true);
    try {
      await flushBeforeAction();
      const expected = editQueueRef.current?.getExpected();
      const res = await bridge.openScene({
        expected,
        replacementIntentId: `replace-${Date.now()}`,
      });
      if (!res.cancelled && res.draft) {
        const draft = res.draft;
        sessionIdRef.current = draft.sessionId;
        latestRevisionRef.current = draft.revision;
        setSessionId(draft.sessionId);
        setRevision(draft.revision);
        setDraftInputDigest(draft.draftInputDigest);
        setSourceId(draft.sourceId);
        setDirty(draft.dirty);
        setScene(draft.scene);
        setSelectedLayerIndex(null);
        editQueueRef.current = new SerializedEditQueue(bridge, draft);
        await triggerCompile();
      }
    } catch (err) {
      setCompileError(sanitizeErrorMessage(err));
    } finally {
      setIsActionInProgress(false);
    }
  };

  const handleImportSvg = async () => {
    if (dirty && !window.confirm("You have unsaved changes. Discard them and import SVG?")) {
      return;
    }
    setIsActionInProgress(true);
    try {
      await flushBeforeAction();
      const expected = editQueueRef.current?.getExpected();
      const res = await bridge.importSvg({
        expected,
        replacementIntentId: `replace-${Date.now()}`,
      });
      if (!res.cancelled && res.draft) {
        const draft = res.draft;
        sessionIdRef.current = draft.sessionId;
        latestRevisionRef.current = draft.revision;
        setSessionId(draft.sessionId);
        setRevision(draft.revision);
        setDraftInputDigest(draft.draftInputDigest);
        setSourceId(draft.sourceId);
        setDirty(draft.dirty);
        setScene(draft.scene);
        setSelectedLayerIndex(null);
        editQueueRef.current = new SerializedEditQueue(bridge, draft);
        await triggerCompile();
      }
    } catch (err) {
      setCompileError(sanitizeErrorMessage(err));
    } finally {
      setIsActionInProgress(false);
    }
  };

  // Save As Plan / Apply
  const handleInitiateSavePlan = async () => {
    setIsActionInProgress(true);
    setPublicationError(null);
    try {
      await flushBeforeAction();
      if (!editQueueRef.current) return;
      const plan = await bridge.savePlan({ expected: editQueueRef.current.getExpected() });
      if (!plan.cancelled) {
        setPendingSavePlan(plan);
      }
    } catch (err) {
      setPublicationError(formatPublicationError(err));
    } finally {
      setIsActionInProgress(false);
    }
  };

  const handleApplySavePlan = async (planId: string) => {
    setIsActionInProgress(true);
    setPublicationError(null);
    try {
      await flushBeforeAction();
      if (!editQueueRef.current) return;
      const res = await bridge.saveApply({
        expected: editQueueRef.current.getExpected(),
        planId,
      });
      if (res.published) {
        setDirty(false);
        if (res.sourceId) {
          setSourceId(res.sourceId);
          editQueueRef.current.updateSourceId(res.sourceId);
        }
        setPendingSavePlan(null);
        setPendingExportPlan(null);
        setLastVerification(null);
        setPublicationError(null);
      }
    } catch (err) {
      setPendingSavePlan(null);
      setPublicationError(formatPublicationError(err));
    } finally {
      setIsActionInProgress(false);
    }
  };

  // Export SVG Plan / Apply
  const handleInitiateExportPlan = async () => {
    setIsActionInProgress(true);
    setPublicationError(null);
    try {
      await flushBeforeAction();
      if (!editQueueRef.current) return;
      const plan = await bridge.exportPlan({ expected: editQueueRef.current.getExpected() });
      if (!plan.cancelled) {
        setPendingExportPlan(plan);
      }
    } catch (err) {
      setPublicationError(formatPublicationError(err));
    } finally {
      setIsActionInProgress(false);
    }
  };

  const handleApplyExportPlan = async (planId: string) => {
    setIsActionInProgress(true);
    setPublicationError(null);
    try {
      await flushBeforeAction();
      if (!editQueueRef.current) return;
      const res = await bridge.exportApply({
        expected: editQueueRef.current.getExpected(),
        planId,
      });
      if (res.published) {
        setPendingExportPlan(null);
        setPublicationError(null);
      }
    } catch (err) {
      setPendingExportPlan(null);
      setPublicationError(formatPublicationError(err));
    } finally {
      setIsActionInProgress(false);
    }
  };

  // Token Bind
  const handleBindTokens = async () => {
    setIsActionInProgress(true);
    try {
      await flushBeforeAction();
      if (!editQueueRef.current) return;
      const draft = await bridge.bindTokens({
        expected: editQueueRef.current.getExpected(),
        projectHandle: projectHandle || "default",
      });
      setRevision(draft.revision);
      setDraftInputDigest(draft.draftInputDigest);
      setDirty(draft.dirty);
      setScene(draft.scene);
      editQueueRef.current.rebind(draft);
    } catch (err) {
      setCompileError(sanitizeErrorMessage(err));
    } finally {
      setIsActionInProgress(false);
    }
  };

  // Exchange Panel Handlers
  const handleCreateBrief = async (title: string, objective: string, criteria: string[]) => {
    setIsActionInProgress(true);
    try {
      await flushBeforeAction();
      if (!editQueueRef.current) return;
      const pkt = await bridge.createBrief({
        expected: editQueueRef.current.getExpected(),
        title,
        objective,
        acceptanceCriteria: criteria,
      });
      setRetainedPackets((pkts) => [...pkts, pkt]);
      if (pkt.packetId) setSelectedPacketId(pkt.packetId);
    } catch (err) {
      setCompileError(sanitizeErrorMessage(err));
    } finally {
      setIsActionInProgress(false);
    }
  };

  const handleImportPacket = async () => {
    setIsActionInProgress(true);
    try {
      await flushBeforeAction();
      const pkt = await bridge.importPacket();
      if (!pkt.cancelled) {
        setRetainedPackets((pkts) => [...pkts, pkt]);
        if (pkt.packetId) setSelectedPacketId(pkt.packetId);
      }
    } catch (err) {
      setCompileError(sanitizeErrorMessage(err));
    } finally {
      setIsActionInProgress(false);
    }
  };

  const handleExportPacket = async (packetId: string) => {
    setIsActionInProgress(true);
    setPublicationError(null);
    try {
      await flushBeforeAction();
      if (!editQueueRef.current) return;
      await bridge.exportPacket({
        expected: editQueueRef.current.getExpected(),
        packetId,
      });
    } catch (err) {
      setPublicationError(formatPublicationError(err));
    } finally {
      setIsActionInProgress(false);
    }
  };

  const handleCreateReview = async (
    briefId: string,
    candidateIds: string[],
    disposition: string,
    summary: string,
  ) => {
    setIsActionInProgress(true);
    try {
      await flushBeforeAction();
      if (!editQueueRef.current) return;
      const pkt = await bridge.createReview({
        expected: editQueueRef.current.getExpected(),
        briefPacketId: briefId,
        candidatePacketIds: candidateIds,
        overallDisposition: disposition,
        summary,
      });
      setRetainedPackets((pkts) => [...pkts, pkt]);
    } catch (err) {
      setCompileError(sanitizeErrorMessage(err));
    } finally {
      setIsActionInProgress(false);
    }
  };

  const handleVerifyCandidate = async (candidatePacketId: string, briefPacketId?: string) => {
    setIsActionInProgress(true);
    try {
      await flushBeforeAction();
      if (!editQueueRef.current) return;
      const ver = await bridge.verifyCandidate({
        expected: editQueueRef.current.getExpected(),
        candidatePacketId,
        briefPacketId,
      });
      setLastVerification(ver);
    } catch (err) {
      setCompileError(sanitizeErrorMessage(err));
    } finally {
      setIsActionInProgress(false);
    }
  };

  const handleAdoptCandidate = async (verificationHandle: string) => {
    setIsActionInProgress(true);
    try {
      await flushBeforeAction();
      if (!editQueueRef.current) return;
      const draft = await bridge.adoptCandidate({
        expected: editQueueRef.current.getExpected(),
        verificationHandle,
      });
      setRevision(draft.revision);
      setDraftInputDigest(draft.draftInputDigest);
      setDirty(draft.dirty);
      setSourceId(undefined); // Adoption clears source
      setScene(draft.scene);
      editQueueRef.current.rebind(draft);
      setLastVerification(null);
      await triggerCompile();
    } catch (err) {
      setCompileError(sanitizeErrorMessage(err));
    } finally {
      setIsActionInProgress(false);
    }
  };

  const handleUpdateDefinitions = (newDefinitions: SceneDefinitions) => {
    void applyEditOperations([{ type: "setDefinitions", definitions: newDefinitions }]);
  };

  const selectedElement =
    scene && selectedLayerIndex !== null && selectedLayerIndex >= 0 && selectedLayerIndex < scene.elements.length
      ? scene.elements[selectedLayerIndex] ?? null
      : null;

  return (
    <div className="vector-graphics-lab" data-testid="vector-graphics-lab">
      {/* Action Toolbar */}
      <ActionToolbar
        revision={revision}
        sourceId={sourceId}
        dirty={dirty}
        isActionInProgress={isActionInProgress}
        canSaveOrExport={canSaveOrExport}
        pendingSavePlan={pendingSavePlan}
        pendingExportPlan={pendingExportPlan}
        onNewScene={handleNewScene}
        onOpenScene={handleOpenScene}
        onImportSvg={handleImportSvg}
        onInitiateSavePlan={handleInitiateSavePlan}
        onApplySavePlan={handleApplySavePlan}
        onCancelSavePlan={() => setPendingSavePlan(null)}
        onInitiateExportPlan={handleInitiateExportPlan}
        onApplyExportPlan={handleApplyExportPlan}
        onCancelExportPlan={() => setPendingExportPlan(null)}
        onBindTokens={handleBindTokens}
      />

      {/* Publication Error Feedback */}
      {publicationError && (
        <div
          className="preview-error-alert publication-error-alert"
          role="alert"
          data-testid="publication-error-alert"
        >
          <div data-testid="publication-error">
            <strong>Publication Failure:</strong> {publicationError}
          </div>
          <button
            type="button"
            className="toolbar-btn cancel-btn"
            onClick={() => setPublicationError(null)}
            aria-label="Dismiss Publication Error"
          >
            ✕
          </button>
        </div>
      )}

      {/* Navigation Tabs */}
      <nav className="workbench-nav" role="tablist" aria-label="Vector Graphics Sections">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "canvas"}
          aria-current={activeTab === "canvas" ? "page" : undefined}
          onClick={() => setActiveTab("canvas")}
        >
          Canvas Preview
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "layers"}
          aria-current={activeTab === "layers" ? "page" : undefined}
          onClick={() => setActiveTab("layers")}
        >
          Layers ({scene?.elements.length ?? 0})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "inspector"}
          aria-current={activeTab === "inspector" ? "page" : undefined}
          onClick={() => setActiveTab("inspector")}
        >
          Shape Inspector
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "artboard"}
          aria-current={activeTab === "artboard" ? "page" : undefined}
          onClick={() => setActiveTab("artboard")}
        >
          Artboard & Profile
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "exchange"}
          aria-current={activeTab === "exchange" ? "page" : undefined}
          onClick={() => setActiveTab("exchange")}
        >
          Design Exchange ({retainedPackets.length})
        </button>
      </nav>

      {/* Main Workspace Layout */}
      <aside aria-label="Scene evidence" className="scene-evidence">
        <p>{sourceWarning}</p>
        <p>Session <code>{sessionId}</code> · Revision {revision} · {isStale || compileError ? "Last-good preview is stale" : "Current preview"}</p>
        <details><summary>Scene and compiled SVG digests</summary>
          <p>Draft input <code>{draftInputDigest}</code></p>
          <p>Canonical scene <code>{previewReceipt?.sourceDigest ?? "Not compiled"}</code></p>
          <p>Compiled SVG <code>{previewReceipt?.svgDigest ?? "Not compiled"}</code></p>
        </details>
        <p>Save As creates a fresh JSON file each time. SVG export is separate. PNG/raster export is deferred.</p>
      </aside>
      <main className="workbench-main">
        {scene ? (
          <>
            {activeTab === "canvas" && (
              <CanvasPreview
                previewUrl={previewUrl}
                previewRevision={previewRevision}
                currentRevision={revision}
                isStale={isStale}
                dirty={dirty}
                isCompiling={isCompiling}
                artboard={scene.artboard}
                metrics={metrics}
                diagnostics={diagnostics}
                compileError={compileError}
                onRefreshCompile={() => triggerCompile()}
              />
            )}

            {activeTab === "layers" && (
              <div className="tab-pane-two-col">
                <LayerList
                  elements={scene.elements}
                  selectedIndex={selectedLayerIndex}
                  onSelect={(idx) => {
                    setSelectedLayerIndex(idx);
                    setActiveTab("inspector");
                  }}
                  onAdd={handleAddLayer}
                  onRemove={handleRemoveLayer}
                  onMoveUp={handleMoveUp}
                  onMoveDown={handleMoveDown}
                />
                <CanvasPreview
                  previewUrl={previewUrl}
                  previewRevision={previewRevision}
                  currentRevision={revision}
                  isStale={isStale}
                  dirty={dirty}
                  isCompiling={isCompiling}
                  artboard={scene.artboard}
                  metrics={metrics}
                  diagnostics={diagnostics}
                  compileError={compileError}
                  onRefreshCompile={() => triggerCompile()}
                />
              </div>
            )}

            {activeTab === "inspector" && (
              <div className="tab-pane-two-col">
                <ShapeInspector
                  element={selectedElement}
                  onChange={handleUpdateElement}
                  definitions={scene.definitions}
                  onUpdateDefinitions={handleUpdateDefinitions}
                />
                <CanvasPreview
                  previewUrl={previewUrl}
                  previewRevision={previewRevision}
                  currentRevision={revision}
                  isStale={isStale}
                  dirty={dirty}
                  isCompiling={isCompiling}
                  artboard={scene.artboard}
                  metrics={metrics}
                  diagnostics={diagnostics}
                  compileError={compileError}
                  onRefreshCompile={() => triggerCompile()}
                />
              </div>
            )}

            {activeTab === "artboard" && (
              <div className="tab-pane-two-col">
                <ArtboardControls
                  profile={scene.profile}
                  artboard={scene.artboard}
                  accessibility={scene.accessibility}
                  onProfileChange={handleProfileChange}
                  onArtboardChange={handleArtboardChange}
                  onAccessibilityChange={handleAccessibilityChange}
                />
                <CanvasPreview
                  previewUrl={previewUrl}
                  previewRevision={previewRevision}
                  currentRevision={revision}
                  isStale={isStale}
                  dirty={dirty}
                  isCompiling={isCompiling}
                  artboard={scene.artboard}
                  metrics={metrics}
                  diagnostics={diagnostics}
                  compileError={compileError}
                  onRefreshCompile={() => triggerCompile()}
                />
              </div>
            )}

            {activeTab === "exchange" && (
              <ExchangePanel
                retainedPackets={retainedPackets}
                selectedPacketId={selectedPacketId}
                lastVerification={lastVerification}
                isActionInProgress={isActionInProgress}
                onSelectPacket={setSelectedPacketId}
                onCreateBrief={handleCreateBrief}
                onImportPacket={handleImportPacket}
                onExportPacket={handleExportPacket}
                onCreateReview={handleCreateReview}
                onVerifyCandidate={handleVerifyCandidate}
                onAdoptCandidate={handleAdoptCandidate}
              />
            )}
          </>
        ) : (
          <div className="loading-state">
            <p>Initializing Vector Graphics Lab…</p>
          </div>
        )}
      </main>
    </div>
  );
}
