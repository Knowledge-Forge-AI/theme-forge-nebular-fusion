import React from "react";
import type { TransformOperation } from "../types";

export interface TransformEditorProps {
  transforms?: readonly TransformOperation[] | undefined;
  onChange: (transforms: readonly TransformOperation[]) => void;
}

export function TransformEditor({ transforms = [], onChange }: TransformEditorProps) {
  const addTransform = (type: TransformOperation["type"]) => {
    let newOp: TransformOperation;
    if (type === "translate") newOp = { type: "translate", x: 10, y: 10 };
    else if (type === "scale") newOp = { type: "scale", x: 1.5, y: 1.5 };
    else if (type === "rotate") newOp = { type: "rotate", angle: 45 };
    else newOp = { type: "matrix", a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    onChange([...transforms, newOp]);
  };

  const removeTransform = (index: number) => {
    const next = transforms.filter((_, idx) => idx !== index);
    onChange(next);
  };

  const updateOp = (index: number, updated: TransformOperation) => {
    const next = transforms.map((op, idx) => (idx === index ? updated : op));
    onChange(next);
  };

  return (
    <fieldset className="inspector-group" data-testid="transform-editor">
      <legend className="inspector-legend">Transforms ({transforms.length})</legend>

      {transforms.map((op, idx) => (
        <div key={idx} className="transform-op-card">
          <div className="transform-op-header">
            <span className="transform-op-type">{op.type.toUpperCase()}</span>
            <button
              type="button"
              className="remove-op-btn"
              onClick={() => removeTransform(idx)}
              aria-label={`Remove transform ${idx + 1}`}
            >
              ✕
            </button>
          </div>

          {op.type === "translate" && (
            <div className="inspector-coord-row">
              <label>
                ΔX:
                <input
                  type="number"
                  aria-label={`Translate X ${idx + 1}`}
                  value={op.x}
                  onChange={(e) => updateOp(idx, { ...op, x: parseFloat(e.target.value) || 0 })}
                />
              </label>
              <label>
                ΔY:
                <input
                  type="number"
                  aria-label={`Translate Y ${idx + 1}`}
                  value={op.y ?? 0}
                  onChange={(e) => updateOp(idx, { ...op, y: parseFloat(e.target.value) || 0 })}
                />
              </label>
            </div>
          )}

          {op.type === "scale" && (
            <div className="inspector-coord-row">
              <label>
                Scale X:
                <input
                  type="number"
                  step="0.1"
                  aria-label={`Scale X ${idx + 1}`}
                  value={op.x}
                  onChange={(e) => updateOp(idx, { ...op, x: parseFloat(e.target.value) || 1 })}
                />
              </label>
              <label>
                Scale Y:
                <input
                  type="number"
                  step="0.1"
                  aria-label={`Scale Y ${idx + 1}`}
                  value={op.y ?? op.x}
                  onChange={(e) => updateOp(idx, { ...op, y: parseFloat(e.target.value) || 1 })}
                />
              </label>
            </div>
          )}

          {op.type === "rotate" && (
            <div className="inspector-coord-row">
              <label>
                Angle (°):
                <input
                  type="number"
                  aria-label={`Rotate angle ${idx + 1}`}
                  value={op.angle}
                  onChange={(e) => updateOp(idx, { ...op, angle: parseFloat(e.target.value) || 0 })}
                />
              </label>
              <label>
                CX:
                <input
                  type="number"
                  aria-label={`Rotate CX ${idx + 1}`}
                  value={op.cx ?? 0}
                  onChange={(e) => updateOp(idx, { ...op, cx: parseFloat(e.target.value) || 0 })}
                />
              </label>
              <label>
                CY:
                <input
                  type="number"
                  aria-label={`Rotate CY ${idx + 1}`}
                  value={op.cy ?? 0}
                  onChange={(e) => updateOp(idx, { ...op, cy: parseFloat(e.target.value) || 0 })}
                />
              </label>
            </div>
          )}

          {op.type === "matrix" && (
            <div className="inspector-matrix-grid">
              <label>a: <input type="number" step="0.1" value={op.a} onChange={(e) => updateOp(idx, { ...op, a: parseFloat(e.target.value) || 0 })} /></label>
              <label>b: <input type="number" step="0.1" value={op.b} onChange={(e) => updateOp(idx, { ...op, b: parseFloat(e.target.value) || 0 })} /></label>
              <label>c: <input type="number" step="0.1" value={op.c} onChange={(e) => updateOp(idx, { ...op, c: parseFloat(e.target.value) || 0 })} /></label>
              <label>d: <input type="number" step="0.1" value={op.d} onChange={(e) => updateOp(idx, { ...op, d: parseFloat(e.target.value) || 0 })} /></label>
              <label>e: <input type="number" step="0.1" value={op.e} onChange={(e) => updateOp(idx, { ...op, e: parseFloat(e.target.value) || 0 })} /></label>
              <label>f: <input type="number" step="0.1" value={op.f} onChange={(e) => updateOp(idx, { ...op, f: parseFloat(e.target.value) || 0 })} /></label>
            </div>
          )}
        </div>
      ))}

      <div className="transform-add-row">
        <button type="button" className="action-btn-xs" onClick={() => addTransform("translate")}>+ Translate</button>
        <button type="button" className="action-btn-xs" onClick={() => addTransform("scale")}>+ Scale</button>
        <button type="button" className="action-btn-xs" onClick={() => addTransform("rotate")}>+ Rotate</button>
      </div>
    </fieldset>
  );
}
