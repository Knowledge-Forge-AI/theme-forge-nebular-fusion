import React from "react";
import type { AlignAxis, CardinalAnchor, DistributeAxis, LayoutDirective } from "../types";

export interface LayoutEditorProps {
  layout?: readonly LayoutDirective[];
  onChange: (layout: readonly LayoutDirective[]) => void;
}

export function LayoutEditor({ layout = [], onChange }: LayoutEditorProps) {
  const addAlign = () => {
    const directive: LayoutDirective = {
      type: "align",
      alignment: "center",
      targets: ["hero-circle", "title-label"],
    };
    onChange([...layout, directive]);
  };

  const addDistribute = () => {
    const directive: LayoutDirective = {
      type: "distribute",
      axis: "horizontal",
      targets: ["hero-circle", "title-label"],
      spacing: 20,
    };
    onChange([...layout, directive]);
  };

  const addGrid = () => {
    const directive: LayoutDirective = {
      type: "grid",
      columns: 3,
      columnGap: 16,
      rowGap: 16,
      targets: ["hero-circle", "title-label"],
    };
    onChange([...layout, directive]);
  };

  const addAnchor = () => {
    const directive: LayoutDirective = {
      type: "anchor",
      target: "title-label",
      targetAnchor: "top",
      relativeTo: "hero-circle",
      relativeToAnchor: "bottom",
      offsetY: 12,
    };
    onChange([...layout, directive]);
  };

  const removeDirective = (index: number) => {
    onChange(layout.filter((_, idx) => idx !== index));
  };

  return (
    <fieldset className="inspector-group" data-testid="layout-editor">
      <legend className="inspector-legend">Layout Directives ({layout.length})</legend>

      {layout.map((dir, idx) => (
        <div key={idx} className="layout-directive-card">
          <div className="layout-directive-header">
            <span className="layout-badge">{dir.type.toUpperCase()}</span>
            <button
              type="button"
              className="remove-op-btn"
              onClick={() => removeDirective(idx)}
              aria-label={`Remove layout directive ${idx + 1}`}
            >
              ✕
            </button>
          </div>

          {dir.type === "align" && (
            <div className="inspector-row">
              <label htmlFor={`align-axis-${idx}`}>Axis</label>
              <select
                id={`align-axis-${idx}`}
                value={dir.alignment}
                onChange={(e) => {
                  const next = [...layout];
                  next[idx] = { ...dir, alignment: e.target.value as AlignAxis };
                  onChange(next);
                }}
              >
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
                <option value="top">Top</option>
                <option value="middle">Middle</option>
                <option value="bottom">Bottom</option>
              </select>
            </div>
          )}

          {dir.type === "distribute" && (
            <div className="inspector-row">
              <label htmlFor={`dist-axis-${idx}`}>Axis</label>
              <select
                id={`dist-axis-${idx}`}
                value={dir.axis}
                onChange={(e) => {
                  const next = [...layout];
                  next[idx] = { ...dir, axis: e.target.value as DistributeAxis };
                  onChange(next);
                }}
              >
                <option value="horizontal">Horizontal</option>
                <option value="vertical">Vertical</option>
              </select>
            </div>
          )}

          {dir.type === "grid" && (
            <div className="inspector-row">
              <label htmlFor={`grid-cols-${idx}`}>Columns</label>
              <input
                id={`grid-cols-${idx}`}
                type="number"
                min="1"
                value={dir.columns}
                onChange={(e) => {
                  const next = [...layout];
                  next[idx] = { ...dir, columns: parseInt(e.target.value, 10) || 1 };
                  onChange(next);
                }}
              />
            </div>
          )}

          {dir.type === "anchor" && (
            <div className="inspector-row">
              <label>Target: {dir.target} ({dir.targetAnchor})</label>
              <label>Relative to: {dir.relativeTo} ({dir.relativeToAnchor})</label>
            </div>
          )}
        </div>
      ))}

      <div className="layout-add-row">
        <button type="button" className="action-btn-xs" onClick={addAlign}>+ Align</button>
        <button type="button" className="action-btn-xs" onClick={addDistribute}>+ Distribute</button>
        <button type="button" className="action-btn-xs" onClick={addGrid}>+ Grid</button>
        <button type="button" className="action-btn-xs" onClick={addAnchor}>+ Anchor</button>
      </div>
    </fieldset>
  );
}
