import React from "react";
import type { Artboard, ArtboardPolicy, SceneAccessibility, ScenePresetName, SceneProfile } from "../types";

export interface ArtboardControlsProps {
  profile: SceneProfile;
  artboard: Artboard;
  accessibility: SceneAccessibility;
  onProfileChange: (profile: SceneProfile) => void;
  onArtboardChange: (artboard: Artboard) => void;
  onAccessibilityChange: (accessibility: SceneAccessibility) => void;
}

const PRESETS: Record<ScenePresetName, { width: number; height: number; viewBox: [number, number, number, number] }> = {
  hero: { width: 1440, height: 720, viewBox: [0, 0, 1440, 720] },
  section: { width: 1200, height: 600, viewBox: [0, 0, 1200, 600] },
  diagram: { width: 800, height: 600, viewBox: [0, 0, 800, 600] },
  figure: { width: 600, height: 400, viewBox: [0, 0, 600, 400] },
  social: { width: 1200, height: 630, viewBox: [0, 0, 1200, 630] },
};

export function ArtboardControls({
  profile,
  artboard,
  accessibility,
  onProfileChange,
  onArtboardChange,
  onAccessibilityChange,
}: ArtboardControlsProps) {
  const applyPreset = (name: ScenePresetName) => {
    const preset = PRESETS[name];
    onArtboardChange({
      ...artboard,
      width: preset.width,
      height: preset.height,
      viewBox: preset.viewBox,
    });
  };

  const updateViewBox = (index: 0 | 1 | 2 | 3, value: number) => {
    const vb = [...artboard.viewBox] as [number, number, number, number];
    vb[index] = value;
    onArtboardChange({ ...artboard, viewBox: vb });
  };

  return (
    <div className="artboard-controls-panel" data-testid="artboard-controls">
      <header className="inspector-header">
        <h3 className="section-kicker">Artboard & Profile</h3>
      </header>

      {/* Profile */}
      <div className="inspector-row">
        <label htmlFor="scene-profile">Profile</label>
        <select
          id="scene-profile"
          aria-label="Scene Profile"
          value={profile}
          onChange={(e) => onProfileChange(e.target.value as SceneProfile)}
        >
          <option value="illustration">Illustration</option>
          <option value="diagram">Diagram</option>
          <option value="editorial">Editorial</option>
          <option value="promotional">Promotional</option>
          <option value="pattern">Pattern</option>
        </select>
      </div>

      {/* Preset Quick Select */}
      <div className="inspector-row">
        <label>Presets</label>
        <div className="preset-btn-group">
          <button type="button" className="action-btn-xs" onClick={() => applyPreset("hero")}>Hero (1440×720)</button>
          <button type="button" className="action-btn-xs" onClick={() => applyPreset("section")}>Section (1200×600)</button>
          <button type="button" className="action-btn-xs" onClick={() => applyPreset("diagram")}>Diagram (800×600)</button>
          <button type="button" className="action-btn-xs" onClick={() => applyPreset("figure")}>Figure (600×400)</button>
          <button type="button" className="action-btn-xs" onClick={() => applyPreset("social")}>Social (1200×630)</button>
        </div>
      </div>

      {/* Dimensions */}
      <fieldset className="inspector-group">
        <legend className="inspector-legend">Canvas Dimensions</legend>
        <div className="inspector-coord-row">
          <label>
            Width:
            <input
              type="number"
              aria-label="Artboard Width"
              min="1"
              value={artboard.width}
              onChange={(e) => onArtboardChange({ ...artboard, width: parseFloat(e.target.value) || 1 })}
            />
          </label>
          <label>
            Height:
            <input
              type="number"
              aria-label="Artboard Height"
              min="1"
              value={artboard.height}
              onChange={(e) => onArtboardChange({ ...artboard, height: parseFloat(e.target.value) || 1 })}
            />
          </label>
        </div>

        <div className="inspector-row">
          <label htmlFor="artboard-policy">Policy</label>
          <select
            id="artboard-policy"
            aria-label="Artboard Policy"
            value={artboard.policy ?? "contain"}
            onChange={(e) => onArtboardChange({ ...artboard, policy: e.target.value as ArtboardPolicy })}
          >
            <option value="contain">Contain</option>
            <option value="pad">Pad</option>
          </select>
        </div>
      </fieldset>

      {/* ViewBox */}
      <fieldset className="inspector-group">
        <legend className="inspector-legend">viewBox [minX, minY, width, height]</legend>
        <div className="inspector-coord-row">
          <label>minX: <input type="number" aria-label="viewBox minX" value={artboard.viewBox[0]} onChange={(e) => updateViewBox(0, parseFloat(e.target.value) || 0)} /></label>
          <label>minY: <input type="number" aria-label="viewBox minY" value={artboard.viewBox[1]} onChange={(e) => updateViewBox(1, parseFloat(e.target.value) || 0)} /></label>
        </div>
        <div className="inspector-coord-row">
          <label>Width: <input type="number" aria-label="viewBox width" value={artboard.viewBox[2]} onChange={(e) => updateViewBox(2, parseFloat(e.target.value) || 1)} /></label>
          <label>Height: <input type="number" aria-label="viewBox height" value={artboard.viewBox[3]} onChange={(e) => updateViewBox(3, parseFloat(e.target.value) || 1)} /></label>
        </div>
      </fieldset>

      {/* Accessibility */}
      <fieldset className="inspector-group">
        <legend className="inspector-legend">Accessibility</legend>
        <div className="inspector-row">
          <label htmlFor="a11y-mode">Mode</label>
          <select
            id="a11y-mode"
            aria-label="Accessibility Mode"
            value={accessibility.mode}
            onChange={(e) => {
              const mode = e.target.value;
              if (mode === "decorative") {
                onAccessibilityChange({ mode: "decorative" });
              } else {
                onAccessibilityChange({ mode: "labelled", title: "Vector Graphic" });
              }
            }}
          >
            <option value="labelled">Labelled</option>
            <option value="decorative">Decorative</option>
          </select>
        </div>

        {accessibility.mode === "labelled" && (
          <>
            <div className="inspector-row">
              <label htmlFor="a11y-title">Title</label>
              <input
                type="text"
                id="a11y-title"
                aria-label="Accessibility Title"
                value={accessibility.title}
                onChange={(e) => onAccessibilityChange({ ...accessibility, title: e.target.value })}
              />
            </div>
            <div className="inspector-row">
              <label htmlFor="a11y-desc">Description</label>
              <textarea
                id="a11y-desc"
                aria-label="Accessibility Description"
                rows={2}
                value={accessibility.desc ?? ""}
                onChange={(e) => onAccessibilityChange({ ...accessibility, desc: e.target.value || undefined })}
              />
            </div>
          </>
        )}
      </fieldset>
    </div>
  );
}
