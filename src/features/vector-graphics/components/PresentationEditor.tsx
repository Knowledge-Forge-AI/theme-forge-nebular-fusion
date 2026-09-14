import React from "react";
import type {
  GradientDef,
  GradientStop,
  LinearGradientDef,
  Paint,
  Presentation,
  RadialGradientDef,
  SceneDefinitions,
  StrokeLinecap,
  StrokeLinejoin,
} from "../types";

export interface PresentationEditorProps {
  presentation?: Presentation | undefined;
  onChange: (presentation: Presentation) => void;
  definitions?: SceneDefinitions | undefined;
  onUpdateDefinitions?: ((definitions: SceneDefinitions) => void) | undefined;
}

interface GradientDefinitionEditorProps {
  label: string;
  gradientId: string;
  onSelectId: (id: string) => void;
  definitions?: SceneDefinitions | undefined;
  onUpdateDefinitions?: ((definitions: SceneDefinitions) => void) | undefined;
}

function GradientDefinitionEditor({
  label,
  gradientId,
  onSelectId,
  definitions,
  onUpdateDefinitions,
}: GradientDefinitionEditorProps) {
  const gradients = definitions?.gradients ?? [];
  const activeGrad = gradients.find((g) => g.id === gradientId);

  const handleCreateDefault = () => {
    if (!onUpdateDefinitions) return;
    const targetId = gradientId.trim() || `grad-${Date.now()}`;
    const newGrad: LinearGradientDef = {
      id: targetId,
      type: "linearGradient",
      x1: 0,
      y1: 0,
      x2: 1,
      y2: 1,
      stops: [
        { offset: 0, color: { type: "solid", color: "#38bdf8" }, opacity: 1 },
        { offset: 1, color: { type: "solid", color: "#818cf8" }, opacity: 1 },
      ],
    };
    onUpdateDefinitions({
      ...definitions,
      gradients: [...gradients.filter((g) => g.id !== targetId), newGrad],
    });
    onSelectId(targetId);
  };

  const updateActiveGrad = (updated: GradientDef) => {
    if (!onUpdateDefinitions) return;
    onUpdateDefinitions({
      ...definitions,
      gradients: gradients.map((g) => (g.id === activeGrad?.id ? updated : g)),
    });
  };

  const updateStop = (idx: number, patch: Partial<GradientStop>) => {
    if (!activeGrad) return;
    const newStops = activeGrad.stops.map((s, i) => (i === idx ? { ...s, ...patch } : s));
    updateActiveGrad({ ...activeGrad, stops: newStops });
  };

  const addStop = () => {
    if (!activeGrad) return;
    const newStop: GradientStop = {
      offset: 1,
      color: { type: "solid", color: "#ffffff" },
      opacity: 1,
    };
    updateActiveGrad({ ...activeGrad, stops: [...activeGrad.stops, newStop] });
  };

  const removeStop = (idx: number) => {
    if (!activeGrad || activeGrad.stops.length <= 2) return;
    updateActiveGrad({
      ...activeGrad,
      stops: activeGrad.stops.filter((_, i) => i !== idx),
    });
  };

  return (
    <div className="gradient-structure-editor" data-testid={`gradient-editor-${label.toLowerCase()}`}>
      <div className="inspector-row">
        <label htmlFor={`${label}-grad-id`}>{label} Gradient ID</label>
        <input
          type="text"
          id={`${label}-grad-id`}
          aria-label={`${label} gradient ID`}
          value={gradientId}
          onChange={(e) => onSelectId(e.target.value)}
        />
      </div>

      {gradients.length > 0 && (
        <div className="inspector-row">
          <label htmlFor={`${label}-grad-select`}>Select Defined Gradient</label>
          <select
            id={`${label}-grad-select`}
            aria-label={`${label} defined gradient selector`}
            value={gradientId}
            onChange={(e) => onSelectId(e.target.value)}
          >
            <option value="">-- Choose definition --</option>
            {gradients.map((g) => (
              <option key={g.id} value={g.id}>
                {g.id} ({g.type})
              </option>
            ))}
          </select>
        </div>
      )}

      {!activeGrad ? (
        onUpdateDefinitions && (
          <div className="inspector-row">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={handleCreateDefault}
              aria-label={`Create ${label} gradient definition`}
            >
              + Create Definition &quot;{gradientId || "new"}&quot;
            </button>
          </div>
        )
      ) : (
        <fieldset className="inspector-group nested" style={{ marginTop: "6px" }}>
          <legend className="inspector-legend">Gradient Parameters ({activeGrad.type})</legend>

          {/* Type Toggle */}
          {onUpdateDefinitions && (
            <div className="inspector-row">
              <label htmlFor={`${label}-grad-type`}>Gradient Type</label>
              <select
                id={`${label}-grad-type`}
                aria-label={`${label} gradient type`}
                value={activeGrad.type}
                onChange={(e) => {
                  const newType = e.target.value;
                  if (newType === "radialGradient" && activeGrad.type === "linearGradient") {
                    updateActiveGrad({
                      id: activeGrad.id,
                      type: "radialGradient",
                      cx: 0.5,
                      cy: 0.5,
                      r: 0.5,
                      stops: activeGrad.stops,
                    });
                  } else if (newType === "linearGradient" && activeGrad.type === "radialGradient") {
                    updateActiveGrad({
                      id: activeGrad.id,
                      type: "linearGradient",
                      x1: 0,
                      y1: 0,
                      x2: 1,
                      y2: 1,
                      stops: activeGrad.stops,
                    });
                  }
                }}
              >
                <option value="linearGradient">Linear</option>
                <option value="radialGradient">Radial</option>
              </select>
            </div>
          )}

          {/* Linear Coordinates */}
          {activeGrad.type === "linearGradient" && (
            <div className="inspector-coord-row">
              <label>
                X1:
                <input
                  type="number"
                  step="0.05"
                  aria-label={`${label} X1`}
                  value={activeGrad.x1}
                  onChange={(e) =>
                    updateActiveGrad({ ...activeGrad, x1: parseFloat(e.target.value) || 0 })
                  }
                />
              </label>
              <label>
                Y1:
                <input
                  type="number"
                  step="0.05"
                  aria-label={`${label} Y1`}
                  value={activeGrad.y1}
                  onChange={(e) =>
                    updateActiveGrad({ ...activeGrad, y1: parseFloat(e.target.value) || 0 })
                  }
                />
              </label>
              <label>
                X2:
                <input
                  type="number"
                  step="0.05"
                  aria-label={`${label} X2`}
                  value={activeGrad.x2}
                  onChange={(e) =>
                    updateActiveGrad({ ...activeGrad, x2: parseFloat(e.target.value) || 0 })
                  }
                />
              </label>
              <label>
                Y2:
                <input
                  type="number"
                  step="0.05"
                  aria-label={`${label} Y2`}
                  value={activeGrad.y2}
                  onChange={(e) =>
                    updateActiveGrad({ ...activeGrad, y2: parseFloat(e.target.value) || 0 })
                  }
                />
              </label>
            </div>
          )}

          {/* Radial Coordinates */}
          {activeGrad.type === "radialGradient" && (
            <div className="inspector-coord-row">
              <label>
                CX:
                <input
                  type="number"
                  step="0.05"
                  aria-label={`${label} CX`}
                  value={activeGrad.cx}
                  onChange={(e) =>
                    updateActiveGrad({ ...activeGrad, cx: parseFloat(e.target.value) || 0 })
                  }
                />
              </label>
              <label>
                CY:
                <input
                  type="number"
                  step="0.05"
                  aria-label={`${label} CY`}
                  value={activeGrad.cy}
                  onChange={(e) =>
                    updateActiveGrad({ ...activeGrad, cy: parseFloat(e.target.value) || 0 })
                  }
                />
              </label>
              <label>
                Radius:
                <input
                  type="number"
                  step="0.05"
                  min="0"
                  aria-label={`${label} R`}
                  value={activeGrad.r}
                  onChange={(e) =>
                    updateActiveGrad({ ...activeGrad, r: parseFloat(e.target.value) || 0 })
                  }
                />
              </label>
            </div>
          )}

          {/* Stops List */}
          <div className="stops-container" style={{ marginTop: "8px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
              <span style={{ fontSize: "11px", fontWeight: "bold" }}>Gradient Stops</span>
              {onUpdateDefinitions && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={addStop}
                  aria-label={`Add stop to ${label} gradient`}
                  style={{ fontSize: "10px", padding: "2px 6px" }}
                >
                  + Add Stop
                </button>
              )}
            </div>

            {activeGrad.stops.map((stop, idx) => (
              <div
                key={idx}
                className="gradient-stop-row"
                style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px" }}
              >
                <label style={{ fontSize: "10px", minWidth: "40px" }}>
                  Offset:
                  <input
                    type="number"
                    min="0"
                    max="1"
                    step="0.05"
                    style={{ width: "48px" }}
                    aria-label={`${label} stop ${idx} offset`}
                    value={stop.offset}
                    onChange={(e) => updateStop(idx, { offset: parseFloat(e.target.value) || 0 })}
                  />
                </label>

                {stop.color.type === "solid" && (
                  <div className="color-input-wrap" style={{ display: "flex", alignItems: "center", gap: "2px" }}>
                    <input
                      type="color"
                      aria-label={`${label} stop ${idx} color picker`}
                      value={stop.color.color.startsWith("#") && stop.color.color.length === 7 ? stop.color.color : "#38bdf8"}
                      onChange={(e) => updateStop(idx, { color: { type: "solid", color: e.target.value } })}
                    />
                    <input
                      type="text"
                      aria-label={`${label} stop ${idx} color`}
                      style={{ width: "60px", fontSize: "10px" }}
                      value={stop.color.color}
                      onChange={(e) => updateStop(idx, { color: { type: "solid", color: e.target.value } })}
                    />
                  </div>
                )}

                <label style={{ fontSize: "10px", minWidth: "40px" }}>
                  Opacity:
                  <input
                    type="number"
                    min="0"
                    max="1"
                    step="0.05"
                    style={{ width: "44px" }}
                    aria-label={`${label} stop ${idx} opacity`}
                    value={stop.opacity ?? 1}
                    onChange={(e) => updateStop(idx, { opacity: parseFloat(e.target.value) || 0 })}
                  />
                </label>

                {onUpdateDefinitions && activeGrad.stops.length > 2 && (
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    style={{ padding: "1px 5px", fontSize: "10px" }}
                    aria-label={`Remove stop ${idx} from ${label} gradient`}
                    onClick={() => removeStop(idx)}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
        </fieldset>
      )}
    </div>
  );
}

export function PresentationEditor({
  presentation = {},
  onChange,
  definitions,
  onUpdateDefinitions,
}: PresentationEditorProps) {
  const fill = presentation.fill ?? { type: "none" };
  const stroke = presentation.stroke ?? { type: "none" };

  const update = (patch: Partial<Presentation>) => {
    onChange({ ...presentation, ...patch });
  };

  const updateFill = (paint: Paint) => {
    update({ fill: paint });
  };

  const updateStroke = (paint: Paint) => {
    update({ stroke: paint });
  };

  return (
    <fieldset className="inspector-group" data-testid="presentation-editor">
      <legend className="inspector-legend">Presentation</legend>

      {/* Fill */}
      <div className="inspector-row">
        <label htmlFor="fill-type">Fill Type</label>
        <select
          id="fill-type"
          value={fill.type}
          onChange={(e) => {
            const type = e.target.value;
            if (type === "none") updateFill({ type: "none" });
            else if (type === "currentColor") updateFill({ type: "currentColor" });
            else if (type === "solid") updateFill({ type: "solid", color: "#38bdf8" });
            else if (type === "token") updateFill({ type: "token", name: "color.accent" });
            else if (type === "gradient") updateFill({ type: "gradient", id: "grad-1" });
          }}
        >
          <option value="none">None</option>
          <option value="currentColor">Current Color</option>
          <option value="solid">Solid Hex Color</option>
          <option value="token">Brand Token</option>
          <option value="gradient">Gradient</option>
        </select>
      </div>

      {fill.type === "solid" && (
        <div className="inspector-row">
          <label htmlFor="fill-solid-color">Fill Color</label>
          <div className="color-input-wrap">
            <input
              type="color"
              id="fill-solid-picker"
              aria-label="Fill color picker"
              value={fill.color.startsWith("#") && fill.color.length === 7 ? fill.color : "#38bdf8"}
              onChange={(e) => updateFill({ type: "solid", color: e.target.value })}
            />
            <input
              type="text"
              id="fill-solid-color"
              aria-label="Fill hex code"
              value={fill.color}
              onChange={(e) => updateFill({ type: "solid", color: e.target.value })}
            />
          </div>
        </div>
      )}

      {fill.type === "token" && (
        <div className="inspector-row">
          <label htmlFor="fill-token-name">Fill Token Name</label>
          <input
            type="text"
            id="fill-token-name"
            aria-label="Fill token name"
            value={fill.name}
            onChange={(e) => updateFill({ type: "token", name: e.target.value })}
          />
        </div>
      )}

      {fill.type === "gradient" && (
        <GradientDefinitionEditor
          label="Fill"
          gradientId={fill.id}
          onSelectId={(id) => updateFill({ type: "gradient", id })}
          definitions={definitions}
          onUpdateDefinitions={onUpdateDefinitions}
        />
      )}

      {/* Stroke */}
      <div className="inspector-row">
        <label htmlFor="stroke-type">Stroke Type</label>
        <select
          id="stroke-type"
          value={stroke.type}
          onChange={(e) => {
            const type = e.target.value;
            if (type === "none") updateStroke({ type: "none" });
            else if (type === "currentColor") updateStroke({ type: "currentColor" });
            else if (type === "solid") updateStroke({ type: "solid", color: "#f6c65b" });
            else if (type === "token") updateStroke({ type: "token", name: "color.border" });
            else if (type === "gradient") updateStroke({ type: "gradient", id: "grad-stroke" });
          }}
        >
          <option value="none">None</option>
          <option value="currentColor">Current Color</option>
          <option value="solid">Solid Hex Color</option>
          <option value="token">Brand Token</option>
          <option value="gradient">Gradient</option>
        </select>
      </div>

      {stroke.type === "solid" && (
        <div className="inspector-row">
          <label htmlFor="stroke-solid-color">Stroke Color</label>
          <div className="color-input-wrap">
            <input
              type="color"
              id="stroke-solid-picker"
              aria-label="Stroke color picker"
              value={stroke.color.startsWith("#") && stroke.color.length === 7 ? stroke.color : "#f6c65b"}
              onChange={(e) => updateStroke({ type: "solid", color: e.target.value })}
            />
            <input
              type="text"
              id="stroke-solid-color"
              aria-label="Stroke hex code"
              value={stroke.color}
              onChange={(e) => updateStroke({ type: "solid", color: e.target.value })}
            />
          </div>
        </div>
      )}

      {stroke.type === "token" && (
        <div className="inspector-row">
          <label htmlFor="stroke-token-name">Stroke Token Name</label>
          <input
            type="text"
            id="stroke-token-name"
            aria-label="Stroke token name"
            value={stroke.name}
            onChange={(e) => updateStroke({ type: "token", name: e.target.value })}
          />
        </div>
      )}

      {stroke.type === "gradient" && (
        <GradientDefinitionEditor
          label="Stroke"
          gradientId={stroke.id}
          onSelectId={(id) => updateStroke({ type: "gradient", id })}
          definitions={definitions}
          onUpdateDefinitions={onUpdateDefinitions}
        />
      )}

      {stroke.type !== "none" && (
        <>
          <div className="inspector-row">
            <label htmlFor="stroke-width">Stroke Width</label>
            <input
              type="number"
              id="stroke-width"
              aria-label="Stroke width"
              min="0"
              step="0.5"
              value={presentation.strokeWidth ?? 1}
              onChange={(e) => update({ strokeWidth: parseFloat(e.target.value) || 0 })}
            />
          </div>

          <div className="inspector-row">
            <label htmlFor="stroke-linecap">Line Cap</label>
            <select
              id="stroke-linecap"
              aria-label="Stroke line cap"
              value={presentation.strokeLinecap ?? "butt"}
              onChange={(e) => update({ strokeLinecap: e.target.value as StrokeLinecap })}
            >
              <option value="butt">Butt</option>
              <option value="round">Round</option>
              <option value="square">Square</option>
            </select>
          </div>

          <div className="inspector-row">
            <label htmlFor="stroke-linejoin">Line Join</label>
            <select
              id="stroke-linejoin"
              aria-label="Stroke line join"
              value={presentation.strokeLinejoin ?? "miter"}
              onChange={(e) => update({ strokeLinejoin: e.target.value as StrokeLinejoin })}
            >
              <option value="miter">Miter</option>
              <option value="round">Round</option>
              <option value="bevel">Bevel</option>
            </select>
          </div>
        </>
      )}

      {/* Opacity */}
      <div className="inspector-row">
        <label htmlFor="element-opacity">Opacity</label>
        <input
          type="number"
          id="element-opacity"
          aria-label="Element opacity"
          min="0"
          max="1"
          step="0.05"
          value={presentation.opacity ?? 1}
          onChange={(e) => update({ opacity: parseFloat(e.target.value) })}
        />
      </div>
    </fieldset>
  );
}
