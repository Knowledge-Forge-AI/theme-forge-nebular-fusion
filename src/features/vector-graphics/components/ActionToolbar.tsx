import React from "react";
import type { ScenePlanResponse, ScenePresetName, SceneProfile } from "../types";

export interface ActionToolbarProps {
  revision: number;
  sourceId?: string | undefined;
  sourceDisplayName?: string | undefined;
  dirty: boolean;
  isActionInProgress: boolean;
  canSaveOrExport?: boolean | undefined;
  pendingSavePlan: ScenePlanResponse | null;
  pendingExportPlan: ScenePlanResponse | null;
  onNewScene: (preset: ScenePresetName, profile: SceneProfile) => void;
  onOpenScene: () => void;
  onImportSvg: () => void;
  onInitiateSavePlan: () => void;
  onApplySavePlan: (planId: string) => void;
  onCancelSavePlan: () => void;
  onInitiateExportPlan: () => void;
  onApplyExportPlan: (planId: string) => void;
  onCancelExportPlan: () => void;
  onBindTokens: () => void;
}

export function ActionToolbar({
  revision,
  sourceId,
  sourceDisplayName,
  dirty,
  isActionInProgress,
  canSaveOrExport = true,
  pendingSavePlan,
  pendingExportPlan,
  onNewScene,
  onOpenScene,
  onImportSvg,
  onInitiateSavePlan,
  onApplySavePlan,
  onCancelSavePlan,
  onInitiateExportPlan,
  onApplyExportPlan,
  onCancelExportPlan,
  onBindTokens,
}: ActionToolbarProps) {
  const [showNewModal, setShowNewModal] = React.useState(false);
  const [newPreset, setNewPreset] = React.useState<ScenePresetName>("hero");
  const [newProfile, setNewProfile] = React.useState<SceneProfile>("illustration");

  return (
    <header className="action-toolbar" data-testid="action-toolbar">
      <div className="toolbar-left">
        <h2 className="toolbar-title">Vector Graphics Lab</h2>
        <span className="revision-badge">Revision {revision}</span>
        <span className="source-label" title={sourceId ?? "Unsaved new scene"}>
          {sourceDisplayName ?? (sourceId ? sourceId.split("/").pop() : "Untitled Scene")}
        </span>
        {dirty ? (
          <span className="dirty-badge" aria-label="Unsaved modified indicator">
            * Modified (Unsaved)
          </span>
        ) : (
          <span className="saved-badge">
            Saved
          </span>
        )}
      </div>

      <div className="toolbar-actions">
        {/* New Scene Button */}
        <button
          type="button"
          className="toolbar-btn"
          onClick={() => setShowNewModal(true)}
          disabled={isActionInProgress}
          aria-label="New Scene"
        >
          + New…
        </button>

        {/* Native Open Button */}
        <button
          type="button"
          className="toolbar-btn"
          onClick={onOpenScene}
          disabled={isActionInProgress}
          aria-label="Open Scene JSON"
        >
          📂 Open…
        </button>

        {/* Native SVG Import Button */}
        <button
          type="button"
          className="toolbar-btn"
          onClick={onImportSvg}
          disabled={isActionInProgress}
          aria-label="Import SVG"
        >
          📥 Import SVG…
        </button>

        {/* Save As Plan / Apply Workflow */}
        {!pendingSavePlan ? (
          <button
            type="button"
            className="toolbar-btn primary"
            onClick={onInitiateSavePlan}
            disabled={isActionInProgress || !canSaveOrExport}
            aria-label="Save As Plan"
            title={!canSaveOrExport ? "Compilation evidence required before publishing" : undefined}
          >
            💾 Save As Plan…
          </button>
        ) : (
          <div className="plan-confirmation-box" data-testid="save-plan-box">
            <span className="plan-label">
              Save to: {pendingSavePlan.targetDisplayName ?? "target.json"}
            </span>
            <button
              type="button"
              className="toolbar-btn confirm-btn"
              onClick={() => pendingSavePlan.planId && onApplySavePlan(pendingSavePlan.planId)}
              disabled={isActionInProgress || !pendingSavePlan.planId}
              aria-label="Confirm Save Plan"
            >
              ✓ Confirm Save
            </button>
            <button
              type="button"
              className="toolbar-btn cancel-btn"
              onClick={onCancelSavePlan}
              disabled={isActionInProgress}
              aria-label="Cancel Save Plan"
            >
              ✕
            </button>
          </div>
        )}

        {/* Export SVG Plan / Apply Workflow */}
        {!pendingExportPlan ? (
          <button
            type="button"
            className="toolbar-btn"
            onClick={onInitiateExportPlan}
            disabled={isActionInProgress || !canSaveOrExport}
            aria-label="Export SVG Plan"
            title={!canSaveOrExport ? "Compilation evidence required before publishing" : undefined}
          >
            📤 Export SVG…
          </button>
        ) : (
          <div className="plan-confirmation-box" data-testid="export-plan-box">
            <span className="plan-label">
              Export to: {pendingExportPlan.targetDisplayName ?? "export.svg"}
            </span>
            <button
              type="button"
              className="toolbar-btn confirm-btn"
              onClick={() => pendingExportPlan.planId && onApplyExportPlan(pendingExportPlan.planId)}
              disabled={isActionInProgress || !pendingExportPlan.planId}
              aria-label="Confirm Export Plan"
            >
              ✓ Confirm Export
            </button>
            <button
              type="button"
              className="toolbar-btn cancel-btn"
              onClick={onCancelExportPlan}
              disabled={isActionInProgress}
              aria-label="Cancel Export Plan"
            >
              ✕
            </button>
          </div>
        )}

        {/* Token Bind */}
        <button
          type="button"
          className="toolbar-btn"
          onClick={onBindTokens}
          disabled={isActionInProgress}
          aria-label="Bind Brand Tokens"
        >
          🎨 Bind Tokens
        </button>
      </div>

      {/* New Scene Modal */}
      {showNewModal && (
        <div className="modal-backdrop" data-testid="new-scene-modal">
          <div className="modal-dialog">
            <h3>Create New Vector Scene</h3>
            <div className="inspector-row">
              <label htmlFor="new-profile-select">Profile</label>
              <select
                id="new-profile-select"
                value={newProfile}
                onChange={(e) => setNewProfile(e.target.value as SceneProfile)}
              >
                <option value="illustration">Illustration</option>
                <option value="diagram">Diagram</option>
                <option value="editorial">Editorial</option>
                <option value="promotional">Promotional</option>
                <option value="pattern">Pattern</option>
              </select>
            </div>
            <div className="inspector-row">
              <label htmlFor="new-preset-select">Preset</label>
              <select
                id="new-preset-select"
                value={newPreset}
                onChange={(e) => setNewPreset(e.target.value as ScenePresetName)}
              >
                <option value="hero">Hero (1440×720)</option>
                <option value="section">Section (1200×600)</option>
                <option value="diagram">Diagram (800×600)</option>
                <option value="figure">Figure (600×400)</option>
                <option value="social">Social (1200×630)</option>
              </select>
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="toolbar-btn primary"
                onClick={() => {
                  setShowNewModal(false);
                  onNewScene(newPreset, newProfile);
                }}
              >
                Create
              </button>
              <button
                type="button"
                className="toolbar-btn"
                onClick={() => setShowNewModal(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
