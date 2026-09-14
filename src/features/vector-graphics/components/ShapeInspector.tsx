import React from "react";
import type {
  ArrowheadType,
  CardinalAnchor,
  ConnectorEndpoint,
  ConnectorRouting,
  LabelElement,
  Presentation,
  SceneDefinitions,
  SceneElement,
  TransformOperation,
} from "../types";
import { PresentationEditor } from "./PresentationEditor";
import { TransformEditor } from "./TransformEditor";

export interface ShapeInspectorProps {
  element: SceneElement | null;
  onChange: (updated: SceneElement) => void;
  definitions?: SceneDefinitions | undefined;
  onUpdateDefinitions?: ((definitions: SceneDefinitions) => void) | undefined;
}

export function ShapeInspector({
  element,
  onChange,
  definitions,
  onUpdateDefinitions,
}: ShapeInspectorProps) {
  if (!element) {
    return (
      <div className="shape-inspector-panel empty" data-testid="shape-inspector">
        <p className="empty-message">Select a layer to view and edit its properties.</p>
      </div>
    );
  }

  const update = (patch: Partial<SceneElement>) => {
    onChange({ ...element, ...patch } as SceneElement);
  };

  const updateId = (id: string) => {
    update({ id: id.trim() || undefined });
  };

  const updatePresentation = (presentation: Presentation) => {
    update({ presentation });
  };

  const updateTransforms = (transform: readonly TransformOperation[]) => {
    update({ transform });
  };

  return (
    <div className="shape-inspector-panel" data-testid="shape-inspector">
      <header className="inspector-header">
        <h3 className="section-kicker">Inspector: {element.type.toUpperCase()}</h3>
      </header>

      {/* ID Field */}
      <div className="inspector-row">
        <label htmlFor="elem-id">Element ID</label>
        <input
          type="text"
          id="elem-id"
          aria-label="Element ID"
          placeholder="e.g. hero-title"
          value={element.id ?? ""}
          onChange={(e) => updateId(e.target.value)}
        />
      </div>

      {/* 1. Rect */}
      {element.type === "rect" && (
        <fieldset className="inspector-group">
          <legend className="inspector-legend">Geometry</legend>
          <div className="inspector-coord-row">
            <label>
              X:
              <input
                type="number"
                aria-label="Rectangle X"
                value={element.x}
                onChange={(e) => update({ x: parseFloat(e.target.value) || 0 })}
              />
            </label>
            <label>
              Y:
              <input
                type="number"
                aria-label="Rectangle Y"
                value={element.y}
                onChange={(e) => update({ y: parseFloat(e.target.value) || 0 })}
              />
            </label>
          </div>
          <div className="inspector-coord-row">
            <label>
              Width:
              <input
                type="number"
                aria-label="Rectangle Width"
                min="0"
                value={element.width}
                onChange={(e) => update({ width: parseFloat(e.target.value) || 0 })}
              />
            </label>
            <label>
              Height:
              <input
                type="number"
                aria-label="Rectangle Height"
                min="0"
                value={element.height}
                onChange={(e) => update({ height: parseFloat(e.target.value) || 0 })}
              />
            </label>
          </div>
          <div className="inspector-coord-row">
            <label>
              Rx:
              <input
                type="number"
                aria-label="Rectangle Rx"
                min="0"
                value={element.rx ?? 0}
                onChange={(e) => update({ rx: parseFloat(e.target.value) || 0 })}
              />
            </label>
            <label>
              Ry:
              <input
                type="number"
                aria-label="Rectangle Ry"
                min="0"
                value={element.ry ?? 0}
                onChange={(e) => update({ ry: parseFloat(e.target.value) || 0 })}
              />
            </label>
          </div>
        </fieldset>
      )}

      {/* 2. Circle */}
      {element.type === "circle" && (
        <fieldset className="inspector-group">
          <legend className="inspector-legend">Geometry</legend>
          <div className="inspector-coord-row">
            <label>
              CX:
              <input
                type="number"
                aria-label="Circle CX"
                value={element.cx}
                onChange={(e) => update({ cx: parseFloat(e.target.value) || 0 })}
              />
            </label>
            <label>
              CY:
              <input
                type="number"
                aria-label="Circle CY"
                value={element.cy}
                onChange={(e) => update({ cy: parseFloat(e.target.value) || 0 })}
              />
            </label>
          </div>
          <div className="inspector-coord-row">
            <label>
              Radius:
              <input
                type="number"
                aria-label="Circle Radius"
                min="0"
                value={element.r}
                onChange={(e) => update({ r: parseFloat(e.target.value) || 0 })}
              />
            </label>
          </div>
        </fieldset>
      )}

      {/* 3. Ellipse */}
      {element.type === "ellipse" && (
        <fieldset className="inspector-group">
          <legend className="inspector-legend">Geometry</legend>
          <div className="inspector-coord-row">
            <label>
              CX:
              <input
                type="number"
                aria-label="Ellipse CX"
                value={element.cx}
                onChange={(e) => update({ cx: parseFloat(e.target.value) || 0 })}
              />
            </label>
            <label>
              CY:
              <input
                type="number"
                aria-label="Ellipse CY"
                value={element.cy}
                onChange={(e) => update({ cy: parseFloat(e.target.value) || 0 })}
              />
            </label>
          </div>
          <div className="inspector-coord-row">
            <label>
              RX:
              <input
                type="number"
                aria-label="Ellipse RX"
                min="0"
                value={element.rx}
                onChange={(e) => update({ rx: parseFloat(e.target.value) || 0 })}
              />
            </label>
            <label>
              RY:
              <input
                type="number"
                aria-label="Ellipse RY"
                min="0"
                value={element.ry}
                onChange={(e) => update({ ry: parseFloat(e.target.value) || 0 })}
              />
            </label>
          </div>
        </fieldset>
      )}

      {/* 4. Line */}
      {element.type === "line" && (
        <fieldset className="inspector-group">
          <legend className="inspector-legend">Line Coordinates</legend>
          <div className="inspector-coord-row">
            <label>
              X1:
              <input
                type="number"
                aria-label="Line X1"
                value={element.x1}
                onChange={(e) => update({ x1: parseFloat(e.target.value) || 0 })}
              />
            </label>
            <label>
              Y1:
              <input
                type="number"
                aria-label="Line Y1"
                value={element.y1}
                onChange={(e) => update({ y1: parseFloat(e.target.value) || 0 })}
              />
            </label>
          </div>
          <div className="inspector-coord-row">
            <label>
              X2:
              <input
                type="number"
                aria-label="Line X2"
                value={element.x2}
                onChange={(e) => update({ x2: parseFloat(e.target.value) || 0 })}
              />
            </label>
            <label>
              Y2:
              <input
                type="number"
                aria-label="Line Y2"
                value={element.y2}
                onChange={(e) => update({ y2: parseFloat(e.target.value) || 0 })}
              />
            </label>
          </div>
        </fieldset>
      )}

      {/* 5. Polyline & 6. Polygon */}
      {(element.type === "polyline" || element.type === "polygon") && (
        <fieldset className="inspector-group">
          <legend className="inspector-legend">
            Points ({element.points.length})
          </legend>
          <div className="points-editor-list">
            {element.points.map(([px, py], pIdx) => (
              <div key={pIdx} className="point-item-row">
                <span>P{pIdx}:</span>
                <input
                  type="number"
                  aria-label={`Point ${pIdx} X`}
                  value={px}
                  onChange={(e) => {
                    const nextPoints = element.points.map((pt, i) =>
                      i === pIdx ? ([parseFloat(e.target.value) || 0, pt[1]] as const) : pt,
                    );
                    update({ points: nextPoints });
                  }}
                />
                <input
                  type="number"
                  aria-label={`Point ${pIdx} Y`}
                  value={py}
                  onChange={(e) => {
                    const nextPoints = element.points.map((pt, i) =>
                      i === pIdx ? ([pt[0], parseFloat(e.target.value) || 0] as const) : pt,
                    );
                    update({ points: nextPoints });
                  }}
                />
                <button
                  type="button"
                  className="remove-op-btn"
                  onClick={() => {
                    const nextPoints = element.points.filter((_, i) => i !== pIdx);
                    update({ points: nextPoints });
                  }}
                  aria-label={`Remove point ${pIdx}`}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="action-btn-xs"
            onClick={() => {
              const last = element.points[element.points.length - 1] ?? [0, 0];
              update({ points: [...element.points, [last[0] + 20, last[1] + 20]] });
            }}
          >
            + Add Point
          </button>
        </fieldset>
      )}

      {/* 7. Path */}
      {element.type === "path" && (
        <fieldset className="inspector-group">
          <legend className="inspector-legend">SVG Path Data</legend>
          <div className="inspector-row">
            <label htmlFor="path-d">Path Data (d)</label>
            <textarea
              id="path-d"
              aria-label="Path d attribute"
              rows={4}
              value={element.d}
              onChange={(e) => update({ d: e.target.value })}
            />
          </div>
        </fieldset>
      )}

      {/* 8. Group */}
      {element.type === "group" && (
        <fieldset className="inspector-group" data-testid="group-children-editor">
          <legend className="inspector-legend">Group Children ({element.children.length})</legend>
          {element.children.length === 0 ? (
            <p className="empty-message">No children in this group.</p>
          ) : (
            <ul className="group-children-list" style={{ listStyle: "none", padding: 0, margin: "0 0 8px 0" }}>
              {element.children.map((child, idx) => (
                <li
                  key={child.id ?? idx}
                  className="group-child-item"
                  style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px" }}
                >
                  <span className="child-type-badge" style={{ fontWeight: "bold", fontSize: "11px", minWidth: "50px" }}>
                    {child.type}
                  </span>
                  <span className="child-id-label" style={{ fontSize: "11px", color: "#b8a9ff", flex: 1 }}>
                    {child.id || `child-${idx}`}
                  </span>
                  <button
                    type="button"
                    className="toolbar-btn btn-xs"
                    style={{ padding: "2px 6px", fontSize: "10px" }}
                    aria-label={`Move child ${idx} up`}
                    disabled={idx === 0}
                    onClick={() => {
                      const newChildren = [...element.children];
                      const [moved] = newChildren.splice(idx, 1);
                      if (moved) {
                        newChildren.splice(idx - 1, 0, moved);
                        update({ children: newChildren });
                      }
                    }}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="toolbar-btn btn-xs"
                    style={{ padding: "2px 6px", fontSize: "10px" }}
                    aria-label={`Move child ${idx} down`}
                    disabled={idx === element.children.length - 1}
                    onClick={() => {
                      const newChildren = [...element.children];
                      const [moved] = newChildren.splice(idx, 1);
                      if (moved) {
                        newChildren.splice(idx + 1, 0, moved);
                        update({ children: newChildren });
                      }
                    }}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="toolbar-btn btn-xs"
                    style={{ padding: "2px 6px", fontSize: "10px", color: "#f87171" }}
                    aria-label={`Remove child ${idx}`}
                    onClick={() => {
                      const newChildren = element.children.filter((_, i) => i !== idx);
                      update({ children: newChildren });
                    }}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="inspector-row" style={{ marginTop: "6px" }}>
            <button
              type="button"
              className="toolbar-btn"
              style={{ fontSize: "11px", padding: "4px 8px" }}
              aria-label="Add child to group"
              onClick={() => {
                const newChild: SceneElement = {
                  type: "rect",
                  id: `rect-${Date.now()}`,
                  x: 0,
                  y: 0,
                  width: 50,
                  height: 50,
                  presentation: { fill: { type: "solid", color: "#38bdf8" } },
                };
                update({ children: [...element.children, newChild] });
              }}
            >
              + Add Child Rect
            </button>
          </div>
        </fieldset>
      )}

      {/* 9. Use */}
      {element.type === "use" && (
        <fieldset className="inspector-group">
          <legend className="inspector-legend">Symbol Instance (Use)</legend>
          {definitions?.symbols && definitions.symbols.length > 0 && (
            <div className="inspector-row">
              <label htmlFor="use-symbol-select">Symbol Reference</label>
              <select
                id="use-symbol-select"
                aria-label="Select symbol reference"
                value={element.href.startsWith("#") ? element.href.slice(1) : ""}
                onChange={(e) => {
                  if (e.target.value) {
                    update({ href: `#${e.target.value}` });
                  }
                }}
              >
                <option value="">-- Choose local symbol --</option>
                {definitions.symbols.map((sym) => (
                  <option key={sym.id} value={sym.id}>
                    {sym.id}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="inspector-row">
            <label htmlFor="use-href">Symbol Href</label>
            <input
              type="text"
              id="use-href"
              aria-label="Use href"
              value={element.href}
              onChange={(e) => update({ href: e.target.value })}
            />
          </div>
          <div className="inspector-coord-row">
            <label>
              X:
              <input
                type="number"
                aria-label="Use X"
                value={element.x ?? 0}
                onChange={(e) => update({ x: parseFloat(e.target.value) || 0 })}
              />
            </label>
            <label>
              Y:
              <input
                type="number"
                aria-label="Use Y"
                value={element.y ?? 0}
                onChange={(e) => update({ y: parseFloat(e.target.value) || 0 })}
              />
            </label>
          </div>
        </fieldset>
      )}

      {/* 10. Diagram Node */}
      {element.type === "diagramNode" && (
        <fieldset className="inspector-group">
          <legend className="inspector-legend">Diagram Node</legend>
          <div className="inspector-row">
            <label htmlFor="node-label">Label</label>
            <input
              type="text"
              id="node-label"
              aria-label="Diagram node label"
              value={element.label ?? ""}
              onChange={(e) => update({ label: e.target.value })}
            />
          </div>
          <div className="inspector-coord-row">
            <label>
              X:
              <input
                type="number"
                aria-label="Node X"
                value={element.x}
                onChange={(e) => update({ x: parseFloat(e.target.value) || 0 })}
              />
            </label>
            <label>
              Y:
              <input
                type="number"
                aria-label="Node Y"
                value={element.y}
                onChange={(e) => update({ y: parseFloat(e.target.value) || 0 })}
              />
            </label>
          </div>
          <div className="inspector-coord-row">
            <label>
              Width:
              <input
                type="number"
                aria-label="Node Width"
                value={element.width}
                onChange={(e) => update({ width: parseFloat(e.target.value) || 0 })}
              />
            </label>
            <label>
              Height:
              <input
                type="number"
                aria-label="Node Height"
                value={element.height}
                onChange={(e) => update({ height: parseFloat(e.target.value) || 0 })}
              />
            </label>
          </div>
          <div className="inspector-coord-row">
            <label>
              Label Scale:
              <input
                type="number"
                step="0.1"
                aria-label="Node label scale"
                value={element.labelScale ?? 1}
                onChange={(e) => update({ labelScale: parseFloat(e.target.value) || 1 })}
              />
            </label>
          </div>
        </fieldset>
      )}

      {/* 11. Connector */}
      {element.type === "connector" && (
        <fieldset className="inspector-group">
          <legend className="inspector-legend">Connector</legend>
          <div className="inspector-row">
            <label htmlFor="connector-routing">Routing</label>
            <select
              id="connector-routing"
              aria-label="Connector routing"
              value={element.routing}
              onChange={(e) => update({ routing: e.target.value as ConnectorRouting })}
            >
              <option value="straight">Straight</option>
              <option value="orthogonal">Orthogonal</option>
            </select>
          </div>

          <div className="inspector-row">
            <label htmlFor="start-arrowhead">Start Arrowhead</label>
            <select
              id="start-arrowhead"
              aria-label="Start arrowhead"
              value={element.startArrowhead ?? "none"}
              onChange={(e) => update({ startArrowhead: e.target.value as ArrowheadType })}
            >
              <option value="none">None</option>
              <option value="triangle">Triangle</option>
              <option value="chevron">Chevron</option>
            </select>
          </div>

          <div className="inspector-row">
            <label htmlFor="end-arrowhead">End Arrowhead</label>
            <select
              id="end-arrowhead"
              aria-label="End arrowhead"
              value={element.endArrowhead ?? "none"}
              onChange={(e) => update({ endArrowhead: e.target.value as ArrowheadType })}
            >
              <option value="none">None</option>
              <option value="triangle">Triangle</option>
              <option value="chevron">Chevron</option>
            </select>
          </div>

          <div className="inspector-coord-row">
            <label>
              Arrowhead Size:
              <input
                type="number"
                aria-label="Arrowhead size"
                value={element.arrowheadSize ?? 8}
                onChange={(e) => update({ arrowheadSize: parseFloat(e.target.value) || 8 })}
              />
            </label>
          </div>
        </fieldset>
      )}

      {/* 12. Label */}
      {element.type === "label" && (
        <fieldset className="inspector-group">
          <legend className="inspector-legend">Text Label</legend>
          <div className="inspector-row">
            <label htmlFor="label-text">Text</label>
            <input
              type="text"
              id="label-text"
              aria-label="Label text"
              value={element.text}
              onChange={(e) => update({ text: e.target.value })}
            />
          </div>
          <div className="inspector-coord-row">
            <label>
              X:
              <input
                type="number"
                aria-label="Label X"
                value={element.x}
                onChange={(e) => update({ x: parseFloat(e.target.value) || 0 })}
              />
            </label>
            <label>
              Y:
              <input
                type="number"
                aria-label="Label Y"
                value={element.y}
                onChange={(e) => update({ y: parseFloat(e.target.value) || 0 })}
              />
            </label>
          </div>
          <div className="inspector-coord-row">
            <label>
              Font Scale (px):
              <input
                type="number"
                aria-label="Label scale"
                min="6"
                value={element.scale ?? 16}
                onChange={(e) => update({ scale: parseFloat(e.target.value) || 16 })}
              />
            </label>
            <label>
              Align:
              <select
                aria-label="Label alignment"
                value={element.align ?? "left"}
                onChange={(e) => update({ align: e.target.value as LabelElement["align"] })}
              >
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </select>
            </label>
          </div>
        </fieldset>
      )}

      {/* Presentation Editor */}
      <PresentationEditor
        presentation={element.presentation}
        onChange={updatePresentation}
        definitions={definitions}
        onUpdateDefinitions={onUpdateDefinitions}
      />

      {/* Transform Editor */}
      <TransformEditor
        transforms={element.transform}
        onChange={updateTransforms}
      />
    </div>
  );
}
