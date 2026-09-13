import React from "react";
import type { ElementType, SceneElement } from "../types";

export interface LayerListProps {
  elements: readonly SceneElement[];
  selectedIndex: number | null;
  onSelect: (index: number) => void;
  onAdd: (type: ElementType) => void;
  onRemove: (index: number) => void;
  onMoveUp: (index: number) => void;
  onMoveDown: (index: number) => void;
}

const ALL_ELEMENT_TYPES: readonly { type: ElementType; label: string }[] = [
  { type: "rect", label: "Rectangle" },
  { type: "circle", label: "Circle" },
  { type: "ellipse", label: "Ellipse" },
  { type: "line", label: "Line" },
  { type: "polyline", label: "Polyline" },
  { type: "polygon", label: "Polygon" },
  { type: "path", label: "Path" },
  { type: "group", label: "Group" },
  { type: "use", label: "Use (Symbol)" },
  { type: "diagramNode", label: "Diagram Node" },
  { type: "connector", label: "Connector" },
  { type: "label", label: "Text Label" },
];

function getElementSummary(elem: SceneElement, idx: number): string {
  if (elem.id) return elem.id;
  switch (elem.type) {
    case "rect":
      return `Rect (${elem.width}×${elem.height})`;
    case "circle":
      return `Circle (r=${elem.r})`;
    case "ellipse":
      return `Ellipse (${elem.rx}×${elem.ry})`;
    case "line":
      return `Line (${elem.x1},${elem.y1} → ${elem.x2},${elem.y2})`;
    case "polyline":
      return `Polyline (${elem.points.length} pts)`;
    case "polygon":
      return `Polygon (${elem.points.length} pts)`;
    case "path":
      return `Path (${elem.d.slice(0, 15)}…)`;
    case "group":
      return `Group (${elem.children.length} items)`;
    case "use":
      return `Use (${elem.href})`;
    case "diagramNode":
      return `Node: ${elem.label ?? elem.id}`;
    case "connector":
      return `Connector (${elem.routing})`;
    case "label":
      return `Label: "${elem.text.slice(0, 15)}"`;
    default:
      return `Layer ${idx + 1}`;
  }
}

export function LayerList({
  elements,
  selectedIndex,
  onSelect,
  onAdd,
  onRemove,
  onMoveUp,
  onMoveDown,
}: LayerListProps) {
  const [selectedAddType, setSelectedAddType] = React.useState<ElementType>("rect");

  return (
    <div className="layer-list-panel" data-testid="layer-list">
      <header className="layer-list-header">
        <h3 className="section-kicker">Layers ({elements.length})</h3>
        <div className="layer-add-controls">
          <select
            aria-label="New layer type"
            value={selectedAddType}
            onChange={(e) => setSelectedAddType(e.target.value as ElementType)}
            className="layer-type-select"
          >
            {ALL_ELEMENT_TYPES.map(({ type, label }) => (
              <option key={type} value={type}>
                {label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="action-btn-small"
            onClick={() => onAdd(selectedAddType)}
            aria-label="Add Layer"
          >
            + Add
          </button>
        </div>
      </header>

      <ul className="layer-items" role="listbox" aria-label="Scene Layers">
        {elements.length === 0 ? (
          <li className="layer-item-empty">No layers in scene</li>
        ) : (
          elements.map((elem, idx) => {
            const isSelected = selectedIndex === idx;
            return (
              <li
                key={elem.id ?? `elem-${idx}`}
                role="option"
                aria-selected={isSelected}
                data-testid="layer-row"
                className={`layer-item ${isSelected ? "selected" : ""}`}
                onClick={() => onSelect(idx)}
              >
                <span className="layer-badge">{elem.type}</span>
                <span className="layer-name">{getElementSummary(elem, idx)}</span>
                <span className="layer-index">#{idx}</span>
              </li>
            );
          })
        )}
      </ul>

      <footer className="layer-reorder-controls">
        <button
          type="button"
          disabled={selectedIndex === null || selectedIndex <= 0}
          onClick={() => selectedIndex !== null && onMoveUp(selectedIndex)}
          aria-label="Move Layer Up"
          className="reorder-btn"
        >
          ↑ Move Up
        </button>
        <button
          type="button"
          disabled={selectedIndex === null || selectedIndex >= elements.length - 1}
          onClick={() => selectedIndex !== null && onMoveDown(selectedIndex)}
          aria-label="Move Layer Down"
          className="reorder-btn"
        >
          ↓ Move Down
        </button>
        <button
          type="button"
          disabled={selectedIndex === null}
          onClick={() => selectedIndex !== null && onRemove(selectedIndex)}
          aria-label="Delete Layer"
          className="delete-layer-btn"
        >
          ✕ Remove
        </button>
      </footer>
    </div>
  );
}
