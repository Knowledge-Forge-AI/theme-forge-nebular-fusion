import { invoke } from "@tauri-apps/api/core";
import type {
  Artboard,
  ClipRule,
  FillRule,
  GradientDef,
  GradientStop,
  LayoutDirective,
  Paint,
  Presentation,
  SceneAccessibility,
  SceneAdoptRequest,
  SceneApplyRequest,
  SceneBriefRequest,
  SceneCompiledPreview,
  SceneCompileRequest,
  SceneCompileResponse,
  SceneDefinitions,
  SceneDiagnosticDto,
  SceneDisposeRequest,
  SceneDisposeResponse,
  SceneDraftResponse,
  SceneEditRequest,
  SceneElement,
  SceneError,
  SceneExpected,
  SceneExportPlanRequest,
  SceneImportResponse,
  SceneImportSvgRequest,
  SceneMetricsDto,
  SceneNewRequest,
  SceneOpenRequest,
  ScenePacketExportRequest,
  ScenePacketImportRequest,
  ScenePacketResponse,
  ScenePlanResponse,
  SceneProfile,
  SceneProvenance,
  ScenePublicationResponse,
  SceneReceiptDto,
  SceneReviewRequest,
  SceneSavePlanRequest,
  SceneSelectionResponse,
  SceneStatusRequest,
  SceneStatusResponse,
  SceneTokenBindRequest,
  SceneVerificationResponse,
  SceneVerifyRequest,
  StrokeLinecap,
  StrokeLinejoin,
  SymbolDef,
  TransformOperation,
  VectorGraphicsBridge,
  VectorScene,
} from "./types";

export const SCENE_COMMANDS = {
  new: "studio_scene_new",
  status: "studio_scene_status",
  dispose: "studio_scene_dispose",
  open: "studio_scene_open",
  importSvg: "studio_scene_import_svg",
  edit: "studio_scene_edit",
  compile: "studio_scene_compile",
  savePlan: "studio_scene_save_plan",
  saveApply: "studio_scene_save_apply",
  exportPlan: "studio_scene_export_plan",
  exportApply: "studio_scene_export_apply",
  bindTokens: "studio_scene_bind_tokens",
  briefCreate: "studio_scene_brief_create",
  packetImport: "studio_scene_packet_import",
  packetExport: "studio_scene_packet_export",
  reviewCreate: "studio_scene_review_create",
  candidateVerify: "studio_scene_candidate_verify",
  candidateAdopt: "studio_scene_candidate_adopt",
} as const;

export class VectorGraphicsValidationError extends Error {
  constructor(message = "Vector Graphics backend returned an invalid typed response") {
    super(message);
    this.name = "VectorGraphicsValidationError";
  }
}

// ---------------------------------------------------------------------------
// Strict Closed Type Assertions
// ---------------------------------------------------------------------------
export function expectClosedObject(
  value: unknown,
  allowedKeys: readonly string[],
  context = "value",
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new VectorGraphicsValidationError(`Expected object for ${context}`);
  }
  const obj = value as Record<string, unknown>;
  const allowedSet = new Set(allowedKeys);
  for (const k of Object.keys(obj)) {
    if (!allowedSet.has(k)) {
      throw new VectorGraphicsValidationError(`Unknown key "${k}" in ${context}`);
    }
  }
  return obj;
}

export function expectObject(
  value: unknown,
  allowedKeys: readonly string[],
  context = "value",
): Record<string, unknown> {
  return expectClosedObject(value, allowedKeys, context);
}

export function expectString(value: unknown, name: string, maxLength = 65536): string {
  if (typeof value !== "string") {
    throw new VectorGraphicsValidationError(`Expected string for ${name}`);
  }
  if (value.length > maxLength) {
    throw new VectorGraphicsValidationError(`String length exceeds ceiling of ${maxLength} for ${name}`);
  }
  return value;
}

export function expectNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new VectorGraphicsValidationError(`Expected finite number for ${name}`);
  }
  return value;
}

export function expectNonNegativeInteger(value: unknown, name: string): number {
  const n = expectNumber(value, name);
  if (!Number.isInteger(n) || n < 0) {
    throw new VectorGraphicsValidationError(`Expected non-negative integer for ${name}`);
  }
  return n;
}

export function expectBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new VectorGraphicsValidationError(`Expected boolean for ${name}`);
  }
  return value;
}

export function expectArray(value: unknown, name: string, maxItems = 10000): unknown[] {
  if (!Array.isArray(value)) {
    throw new VectorGraphicsValidationError(`Expected array for ${name}`);
  }
  if (value.length > maxItems) {
    throw new VectorGraphicsValidationError(`Array length exceeds ceiling of ${maxItems} for ${name}`);
  }
  return value;
}

export function validateDiagnostics(value: unknown): SceneDiagnosticDto[] {
  if (value === undefined || value === null) return [];
  const arr = expectArray(value, "diagnostics", 1000);
  return arr.map((entry, idx) => {
    const obj = expectClosedObject(
      entry,
      ["code", "message", "severity", "path"],
      `diagnostic[${idx}]`,
    );
    return {
      code: expectString(obj.code, `diagnostic[${idx}].code`),
      message: expectString(obj.message, `diagnostic[${idx}].message`),
      severity: typeof obj.severity === "string" ? expectString(obj.severity, `diagnostic[${idx}].severity`) : undefined,
      path: typeof obj.path === "string" ? expectString(obj.path, `diagnostic[${idx}].path`) : undefined,
    };
  });
}

export function validateMetrics(value: unknown): SceneMetricsDto {
  const obj = expectClosedObject(
    value,
    [
      "expandedElementCount",
      "authoredElementCount",
      "pathSegmentCount",
      "glyphCount",
      "maxNestingDepth",
      "gradientStopCount",
    ],
    "metrics",
  );
  return {
    expandedElementCount: expectNonNegativeInteger(obj.expandedElementCount, "metrics.expandedElementCount"),
    authoredElementCount: expectNonNegativeInteger(obj.authoredElementCount, "metrics.authoredElementCount"),
    pathSegmentCount: expectNonNegativeInteger(obj.pathSegmentCount, "metrics.pathSegmentCount"),
    glyphCount: expectNonNegativeInteger(obj.glyphCount, "metrics.glyphCount"),
    maxNestingDepth: expectNonNegativeInteger(obj.maxNestingDepth, "metrics.maxNestingDepth"),
    gradientStopCount: expectNonNegativeInteger(obj.gradientStopCount, "metrics.gradientStopCount"),
  };
}

export function validateArtboard(value: unknown): Artboard {
  const obj = expectClosedObject(value, ["width", "height", "viewBox", "policy"], "artboard");
  const width = expectNumber(obj.width, "artboard.width");
  const height = expectNumber(obj.height, "artboard.height");
  if (width <= 0 || height <= 0) {
    throw new VectorGraphicsValidationError("Artboard width and height must be positive");
  }
  const vb = expectArray(obj.viewBox, "artboard.viewBox", 4);
  if (vb.length !== 4) {
    throw new VectorGraphicsValidationError("Expected artboard.viewBox to have exactly 4 numbers");
  }
  const viewBox: readonly [number, number, number, number] = [
    expectNumber(vb[0], "viewBox[0]"),
    expectNumber(vb[1], "viewBox[1]"),
    expectNumber(vb[2], "viewBox[2]"),
    expectNumber(vb[3], "viewBox[3]"),
  ];
  let policy: Artboard["policy"];
  if (obj.policy !== undefined) {
    if (obj.policy !== "contain" && obj.policy !== "pad") {
      throw new VectorGraphicsValidationError(`Invalid artboard policy: ${String(obj.policy)}`);
    }
    policy = obj.policy;
  }
  return { width, height, viewBox, policy };
}

export function validateReceipt(value: unknown): SceneReceiptDto {
  const obj = expectClosedObject(
    value,
    [
      "schema",
      "diagnostics",
      "sourceSnapshotDigest",
      "sceneSchema",
      "sceneCompatibility",
      "sceneCompilerLevel",
      "sourceDigest",
      "svgDigest",
      "profile",
      "artboard",
      "glyphCatalogDigest",
      "tokenDigest",
      "metrics",
    ],
    "receipt",
  );
  const rawDiag = expectArray(obj.diagnostics, "receipt.diagnostics");
  const diagnostics = rawDiag.map((d, i) => expectString(d, `receipt.diagnostics[${i}]`));
  const profile = expectString(obj.profile, "receipt.profile") as SceneProfile;
  if (!["illustration", "diagram", "editorial", "promotional", "pattern"].includes(profile)) {
    throw new VectorGraphicsValidationError(`Invalid scene profile in receipt: ${profile}`);
  }
  return {
    schema: expectString(obj.schema, "receipt.schema"),
    diagnostics,
    sourceSnapshotDigest: expectString(obj.sourceSnapshotDigest, "receipt.sourceSnapshotDigest"),
    sceneSchema: expectString(obj.sceneSchema, "receipt.sceneSchema"),
    sceneCompatibility: expectNonNegativeInteger(obj.sceneCompatibility, "receipt.sceneCompatibility"),
    sceneCompilerLevel: expectNonNegativeInteger(obj.sceneCompilerLevel, "receipt.sceneCompilerLevel"),
    sourceDigest: expectString(obj.sourceDigest, "receipt.sourceDigest"),
    svgDigest: expectString(obj.svgDigest, "receipt.svgDigest"),
    profile,
    artboard: validateArtboard(obj.artboard),
    glyphCatalogDigest: expectString(obj.glyphCatalogDigest, "receipt.glyphCatalogDigest"),
    tokenDigest: expectString(obj.tokenDigest, "receipt.tokenDigest"),
    metrics: validateMetrics(obj.metrics),
  };
}

export function validateCompiledPreview(value: unknown): SceneCompiledPreview | undefined {
  if (value === null || value === undefined) return undefined;
  const obj = expectClosedObject(value, ["svg", "svgDigest", "receipt", "metrics"], "compiled");
  return {
    svg: expectString(obj.svg, "compiled.svg", 16 * 1024 * 1024),
    svgDigest: expectString(obj.svgDigest, "compiled.svgDigest"),
    receipt: validateReceipt(obj.receipt),
    metrics: validateMetrics(obj.metrics),
  };
}

export function validatePaint(value: unknown, context = "paint"): Paint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new VectorGraphicsValidationError(`Expected object for ${context}`);
  }
  const raw = value as { type?: unknown };
  const type = expectString(raw.type, `${context}.type`);
  switch (type) {
    case "none":
      expectClosedObject(value, ["type"], context);
      return { type: "none" };
    case "currentColor":
      expectClosedObject(value, ["type"], context);
      return { type: "currentColor" };
    case "solid": {
      const obj = expectClosedObject(value, ["type", "color"], context);
      return { type: "solid", color: expectString(obj.color, `${context}.color`) };
    }
    case "token": {
      const obj = expectClosedObject(value, ["type", "name"], context);
      return { type: "token", name: expectString(obj.name, `${context}.name`) };
    }
    case "gradient": {
      const obj = expectClosedObject(value, ["type", "id", "fallback"], context);
      return {
        type: "gradient",
        id: expectString(obj.id, `${context}.id`),
        fallback: typeof obj.fallback === "string" ? expectString(obj.fallback, `${context}.fallback`) : undefined,
      };
    }
    default:
      throw new VectorGraphicsValidationError(`Invalid paint type "${type}" in ${context}`);
  }
}

export function validatePresentation(value: unknown, context = "presentation"): Presentation {
  const allowedKeys = [
    "fill",
    "stroke",
    "strokeWidth",
    "strokeDasharray",
    "strokeDashoffset",
    "strokeLinecap",
    "strokeLinejoin",
    "strokeMiterlimit",
    "opacity",
    "fillOpacity",
    "strokeOpacity",
    "fillRule",
    "clipRule",
    "ariaHidden",
  ];
  const obj = expectClosedObject(value, allowedKeys, context);
  const res: Presentation = {};

  if (obj.fill !== undefined) (res as any).fill = validatePaint(obj.fill, `${context}.fill`);
  if (obj.stroke !== undefined) (res as any).stroke = validatePaint(obj.stroke, `${context}.stroke`);
  if (obj.strokeWidth !== undefined) (res as any).strokeWidth = expectNumber(obj.strokeWidth, `${context}.strokeWidth`);
  if (obj.strokeDasharray !== undefined) {
    const arr = expectArray(obj.strokeDasharray, `${context}.strokeDasharray`, 100);
    (res as any).strokeDasharray = arr.map((item, i) => expectNumber(item, `${context}.strokeDasharray[${i}]`));
  }
  if (obj.strokeDashoffset !== undefined) (res as any).strokeDashoffset = expectNumber(obj.strokeDashoffset, `${context}.strokeDashoffset`);
  if (obj.strokeLinecap !== undefined) {
    const val = expectString(obj.strokeLinecap, `${context}.strokeLinecap`);
    if (!["butt", "round", "square"].includes(val)) throw new VectorGraphicsValidationError(`Invalid strokeLinecap "${val}"`);
    (res as any).strokeLinecap = val as StrokeLinecap;
  }
  if (obj.strokeLinejoin !== undefined) {
    const val = expectString(obj.strokeLinejoin, `${context}.strokeLinejoin`);
    if (!["miter", "round", "bevel"].includes(val)) throw new VectorGraphicsValidationError(`Invalid strokeLinejoin "${val}"`);
    (res as any).strokeLinejoin = val as StrokeLinejoin;
  }
  if (obj.strokeMiterlimit !== undefined) (res as any).strokeMiterlimit = expectNumber(obj.strokeMiterlimit, `${context}.strokeMiterlimit`);
  if (obj.opacity !== undefined) (res as any).opacity = expectNumber(obj.opacity, `${context}.opacity`);
  if (obj.fillOpacity !== undefined) (res as any).fillOpacity = expectNumber(obj.fillOpacity, `${context}.fillOpacity`);
  if (obj.strokeOpacity !== undefined) (res as any).strokeOpacity = expectNumber(obj.strokeOpacity, `${context}.strokeOpacity`);
  if (obj.fillRule !== undefined) {
    const val = expectString(obj.fillRule, `${context}.fillRule`);
    if (!["nonzero", "evenodd"].includes(val)) throw new VectorGraphicsValidationError(`Invalid fillRule "${val}"`);
    (res as any).fillRule = val as FillRule;
  }
  if (obj.clipRule !== undefined) {
    const val = expectString(obj.clipRule, `${context}.clipRule`);
    if (!["nonzero", "evenodd"].includes(val)) throw new VectorGraphicsValidationError(`Invalid clipRule "${val}"`);
    (res as any).clipRule = val as ClipRule;
  }
  if (obj.ariaHidden !== undefined) (res as any).ariaHidden = expectBoolean(obj.ariaHidden, `${context}.ariaHidden`);

  return res;
}

export function validateTransformOperations(value: unknown, context = "transform"): TransformOperation[] {
  const arr = expectArray(value, context, 100);
  return arr.map((item, idx) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new VectorGraphicsValidationError(`Expected object for ${context}[${idx}]`);
    }
    const type = expectString((item as { type?: unknown }).type, `${context}[${idx}].type`);
    switch (type) {
      case "translate": {
        const obj = expectClosedObject(item, ["type", "x", "y"], `${context}[${idx}]`);
        return {
          type: "translate",
          x: expectNumber(obj.x, `${context}[${idx}].x`),
          y: obj.y !== undefined ? expectNumber(obj.y, `${context}[${idx}].y`) : undefined,
        };
      }
      case "scale": {
        const obj = expectClosedObject(item, ["type", "x", "y"], `${context}[${idx}]`);
        return {
          type: "scale",
          x: expectNumber(obj.x, `${context}[${idx}].x`),
          y: obj.y !== undefined ? expectNumber(obj.y, `${context}[${idx}].y`) : undefined,
        };
      }
      case "rotate": {
        const obj = expectClosedObject(item, ["type", "angle", "cx", "cy"], `${context}[${idx}]`);
        return {
          type: "rotate",
          angle: expectNumber(obj.angle, `${context}[${idx}].angle`),
          cx: obj.cx !== undefined ? expectNumber(obj.cx, `${context}[${idx}].cx`) : undefined,
          cy: obj.cy !== undefined ? expectNumber(obj.cy, `${context}[${idx}].cy`) : undefined,
        };
      }
      case "matrix": {
        const obj = expectClosedObject(item, ["type", "a", "b", "c", "d", "e", "f"], `${context}[${idx}]`);
        return {
          type: "matrix",
          a: expectNumber(obj.a, `${context}[${idx}].a`),
          b: expectNumber(obj.b, `${context}[${idx}].b`),
          c: expectNumber(obj.c, `${context}[${idx}].c`),
          d: expectNumber(obj.d, `${context}[${idx}].d`),
          e: expectNumber(obj.e, `${context}[${idx}].e`),
          f: expectNumber(obj.f, `${context}[${idx}].f`),
        };
      }
      default:
        throw new VectorGraphicsValidationError(`Invalid transform operation type "${type}" at ${context}[${idx}]`);
    }
  });
}

export function validateGradientStop(value: unknown, context = "gradientStop"): GradientStop {
  const obj = expectClosedObject(value, ["offset", "color", "opacity"], context);
  return {
    offset: expectNumber(obj.offset, `${context}.offset`),
    color: validatePaint(obj.color, `${context}.color`),
    opacity: obj.opacity !== undefined ? expectNumber(obj.opacity, `${context}.opacity`) : undefined,
  };
}

export function validateGradientDef(value: unknown, context = "gradientDef"): GradientDef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new VectorGraphicsValidationError(`Expected object for ${context}`);
  }
  const type = expectString((value as { type?: unknown }).type, `${context}.type`);
  if (type === "linearGradient") {
    const obj = expectClosedObject(
      value,
      ["id", "type", "x1", "y1", "x2", "y2", "gradientUnits", "spreadMethod", "stops"],
      context,
    );
    const stopsArr = expectArray(obj.stops, `${context}.stops`, 100);
    return {
      id: expectString(obj.id, `${context}.id`),
      type: "linearGradient",
      x1: expectNumber(obj.x1, `${context}.x1`),
      y1: expectNumber(obj.y1, `${context}.y1`),
      x2: expectNumber(obj.x2, `${context}.x2`),
      y2: expectNumber(obj.y2, `${context}.y2`),
      gradientUnits: obj.gradientUnits as any,
      spreadMethod: obj.spreadMethod as any,
      stops: stopsArr.map((s, i) => validateGradientStop(s, `${context}.stops[${i}]`)),
    };
  } else if (type === "radialGradient") {
    const obj = expectClosedObject(
      value,
      ["id", "type", "cx", "cy", "r", "fx", "fy", "gradientUnits", "spreadMethod", "stops"],
      context,
    );
    const stopsArr = expectArray(obj.stops, `${context}.stops`, 100);
    return {
      id: expectString(obj.id, `${context}.id`),
      type: "radialGradient",
      cx: expectNumber(obj.cx, `${context}.cx`),
      cy: expectNumber(obj.cy, `${context}.cy`),
      r: expectNumber(obj.r, `${context}.r`),
      fx: obj.fx !== undefined ? expectNumber(obj.fx, `${context}.fx`) : undefined,
      fy: obj.fy !== undefined ? expectNumber(obj.fy, `${context}.fy`) : undefined,
      gradientUnits: obj.gradientUnits as any,
      spreadMethod: obj.spreadMethod as any,
      stops: stopsArr.map((s, i) => validateGradientStop(s, `${context}.stops[${i}]`)),
    };
  }
  throw new VectorGraphicsValidationError(`Invalid gradient type "${type}" in ${context}`);
}

export function validateSymbolDef(value: unknown, depth = 0, context = "symbolDef"): SymbolDef {
  const obj = expectClosedObject(value, ["id", "type", "viewBox", "elements"], context);
  const type = expectString(obj.type, `${context}.type`);
  if (type !== "symbol") throw new VectorGraphicsValidationError(`Expected type "symbol" in ${context}`);
  const vb = expectArray(obj.viewBox, `${context}.viewBox`, 4);
  if (vb.length !== 4) throw new VectorGraphicsValidationError(`viewBox must have 4 numbers in ${context}`);
  const elemArr = expectArray(obj.elements, `${context}.elements`, 1000);
  return {
    id: expectString(obj.id, `${context}.id`),
    type: "symbol",
    viewBox: [
      expectNumber(vb[0], `${context}.viewBox[0]`),
      expectNumber(vb[1], `${context}.viewBox[1]`),
      expectNumber(vb[2], `${context}.viewBox[2]`),
      expectNumber(vb[3], `${context}.viewBox[3]`),
    ],
    elements: elemArr.map((el, i) => validateSceneElement(el, depth + 1, `${context}.elements[${i}]`)),
  };
}

export function validateDefinitions(value: unknown, context = "definitions"): SceneDefinitions {
  const obj = expectClosedObject(value, ["gradients", "symbols"], context);
  let gradients: GradientDef[] | undefined;
  let symbols: SymbolDef[] | undefined;
  if (obj.gradients !== undefined) {
    const arr = expectArray(obj.gradients, `${context}.gradients`, 500);
    gradients = arr.map((g, i) => validateGradientDef(g, `${context}.gradients[${i}]`));
  }
  if (obj.symbols !== undefined) {
    const arr = expectArray(obj.symbols, `${context}.symbols`, 500);
    symbols = arr.map((s, i) => validateSymbolDef(s, 0, `${context}.symbols[${i}]`));
  }
  return { gradients, symbols };
}

export function validateSceneElement(value: unknown, depth = 0, context = "element"): SceneElement {
  if (depth > 32) {
    throw new VectorGraphicsValidationError(`Scene element nesting depth exceeded maximum of 32 at ${context}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new VectorGraphicsValidationError(`Expected object for ${context}`);
  }
  const raw = value as { type?: unknown };
  const type = expectString(raw.type, `${context}.type`);
  const baseKeys = ["id", "presentation", "transform", "bounds", "type"];

  switch (type) {
    case "path": {
      const obj = expectClosedObject(value, [...baseKeys, "d"], context);
      return {
        type: "path",
        id: typeof obj.id === "string" ? expectString(obj.id, `${context}.id`) : undefined,
        presentation: obj.presentation ? validatePresentation(obj.presentation, `${context}.presentation`) : undefined,
        transform: obj.transform ? validateTransformOperations(obj.transform, `${context}.transform`) : undefined,
        bounds: obj.bounds as any,
        d: expectString(obj.d, `${context}.d`, 1024 * 1024),
      };
    }
    case "rect": {
      const obj = expectClosedObject(value, [...baseKeys, "x", "y", "width", "height", "rx", "ry"], context);
      return {
        type: "rect",
        id: typeof obj.id === "string" ? expectString(obj.id, `${context}.id`) : undefined,
        presentation: obj.presentation ? validatePresentation(obj.presentation, `${context}.presentation`) : undefined,
        transform: obj.transform ? validateTransformOperations(obj.transform, `${context}.transform`) : undefined,
        bounds: obj.bounds as any,
        x: expectNumber(obj.x, `${context}.x`),
        y: expectNumber(obj.y, `${context}.y`),
        width: expectNumber(obj.width, `${context}.width`),
        height: expectNumber(obj.height, `${context}.height`),
        rx: obj.rx !== undefined ? expectNumber(obj.rx, `${context}.rx`) : undefined,
        ry: obj.ry !== undefined ? expectNumber(obj.ry, `${context}.ry`) : undefined,
      };
    }
    case "circle": {
      const obj = expectClosedObject(value, [...baseKeys, "cx", "cy", "r"], context);
      return {
        type: "circle",
        id: typeof obj.id === "string" ? expectString(obj.id, `${context}.id`) : undefined,
        presentation: obj.presentation ? validatePresentation(obj.presentation, `${context}.presentation`) : undefined,
        transform: obj.transform ? validateTransformOperations(obj.transform, `${context}.transform`) : undefined,
        bounds: obj.bounds as any,
        cx: expectNumber(obj.cx, `${context}.cx`),
        cy: expectNumber(obj.cy, `${context}.cy`),
        r: expectNumber(obj.r, `${context}.r`),
      };
    }
    case "ellipse": {
      const obj = expectClosedObject(value, [...baseKeys, "cx", "cy", "rx", "ry"], context);
      return {
        type: "ellipse",
        id: typeof obj.id === "string" ? expectString(obj.id, `${context}.id`) : undefined,
        presentation: obj.presentation ? validatePresentation(obj.presentation, `${context}.presentation`) : undefined,
        transform: obj.transform ? validateTransformOperations(obj.transform, `${context}.transform`) : undefined,
        bounds: obj.bounds as any,
        cx: expectNumber(obj.cx, `${context}.cx`),
        cy: expectNumber(obj.cy, `${context}.cy`),
        rx: expectNumber(obj.rx, `${context}.rx`),
        ry: expectNumber(obj.ry, `${context}.ry`),
      };
    }
    case "line": {
      const obj = expectClosedObject(value, [...baseKeys, "x1", "y1", "x2", "y2"], context);
      return {
        type: "line",
        id: typeof obj.id === "string" ? expectString(obj.id, `${context}.id`) : undefined,
        presentation: obj.presentation ? validatePresentation(obj.presentation, `${context}.presentation`) : undefined,
        transform: obj.transform ? validateTransformOperations(obj.transform, `${context}.transform`) : undefined,
        bounds: obj.bounds as any,
        x1: expectNumber(obj.x1, `${context}.x1`),
        y1: expectNumber(obj.y1, `${context}.y1`),
        x2: expectNumber(obj.x2, `${context}.x2`),
        y2: expectNumber(obj.y2, `${context}.y2`),
      };
    }
    case "polyline": {
      const obj = expectClosedObject(value, [...baseKeys, "points"], context);
      const pts = expectArray(obj.points, `${context}.points`, 5000);
      return {
        type: "polyline",
        id: typeof obj.id === "string" ? expectString(obj.id, `${context}.id`) : undefined,
        presentation: obj.presentation ? validatePresentation(obj.presentation, `${context}.presentation`) : undefined,
        transform: obj.transform ? validateTransformOperations(obj.transform, `${context}.transform`) : undefined,
        bounds: obj.bounds as any,
        points: pts.map((p, i) => {
          const pt = expectArray(p, `${context}.points[${i}]`, 2);
          if (pt.length !== 2) throw new VectorGraphicsValidationError(`Point must have 2 numbers in ${context}`);
          return [expectNumber(pt[0], `${context}.points[${i}][0]`), expectNumber(pt[1], `${context}.points[${i}][1]`)] as const;
        }),
      };
    }
    case "polygon": {
      const obj = expectClosedObject(value, [...baseKeys, "points"], context);
      const pts = expectArray(obj.points, `${context}.points`, 5000);
      return {
        type: "polygon",
        id: typeof obj.id === "string" ? expectString(obj.id, `${context}.id`) : undefined,
        presentation: obj.presentation ? validatePresentation(obj.presentation, `${context}.presentation`) : undefined,
        transform: obj.transform ? validateTransformOperations(obj.transform, `${context}.transform`) : undefined,
        bounds: obj.bounds as any,
        points: pts.map((p, i) => {
          const pt = expectArray(p, `${context}.points[${i}]`, 2);
          if (pt.length !== 2) throw new VectorGraphicsValidationError(`Point must have 2 numbers in ${context}`);
          return [expectNumber(pt[0], `${context}.points[${i}][0]`), expectNumber(pt[1], `${context}.points[${i}][1]`)] as const;
        }),
      };
    }
    case "group": {
      const obj = expectClosedObject(value, [...baseKeys, "children"], context);
      const children = expectArray(obj.children, `${context}.children`, 1000);
      return {
        type: "group",
        id: typeof obj.id === "string" ? expectString(obj.id, `${context}.id`) : undefined,
        presentation: obj.presentation ? validatePresentation(obj.presentation, `${context}.presentation`) : undefined,
        transform: obj.transform ? validateTransformOperations(obj.transform, `${context}.transform`) : undefined,
        bounds: obj.bounds as any,
        children: children.map((c, i) => validateSceneElement(c, depth + 1, `${context}.children[${i}]`)),
      };
    }
    case "use": {
      const obj = expectClosedObject(value, [...baseKeys, "href", "x", "y", "width", "height"], context);
      return {
        type: "use",
        id: typeof obj.id === "string" ? expectString(obj.id, `${context}.id`) : undefined,
        presentation: obj.presentation ? validatePresentation(obj.presentation, `${context}.presentation`) : undefined,
        transform: obj.transform ? validateTransformOperations(obj.transform, `${context}.transform`) : undefined,
        bounds: obj.bounds as any,
        href: expectString(obj.href, `${context}.href`),
        x: obj.x !== undefined ? expectNumber(obj.x, `${context}.x`) : undefined,
        y: obj.y !== undefined ? expectNumber(obj.y, `${context}.y`) : undefined,
        width: obj.width !== undefined ? expectNumber(obj.width, `${context}.width`) : undefined,
        height: obj.height !== undefined ? expectNumber(obj.height, `${context}.height`) : undefined,
      };
    }
    case "diagramNode": {
      const obj = expectClosedObject(
        value,
        [...baseKeys, "x", "y", "width", "height", "rx", "ry", "label", "labelColor", "labelScale"],
        context,
      );
      return {
        type: "diagramNode",
        id: expectString(obj.id, `${context}.id`),
        presentation: obj.presentation ? validatePresentation(obj.presentation, `${context}.presentation`) : undefined,
        transform: obj.transform ? validateTransformOperations(obj.transform, `${context}.transform`) : undefined,
        bounds: obj.bounds as any,
        x: expectNumber(obj.x, `${context}.x`),
        y: expectNumber(obj.y, `${context}.y`),
        width: expectNumber(obj.width, `${context}.width`),
        height: expectNumber(obj.height, `${context}.height`),
        rx: obj.rx !== undefined ? expectNumber(obj.rx, `${context}.rx`) : undefined,
        ry: obj.ry !== undefined ? expectNumber(obj.ry, `${context}.ry`) : undefined,
        label: typeof obj.label === "string" ? expectString(obj.label, `${context}.label`) : undefined,
        labelColor: obj.labelColor ? validatePaint(obj.labelColor, `${context}.labelColor`) : undefined,
        labelScale: obj.labelScale !== undefined ? expectNumber(obj.labelScale, `${context}.labelScale`) : undefined,
      };
    }
    case "connector": {
      const obj = expectClosedObject(
        value,
        [...baseKeys, "routing", "from", "to", "waypoints", "startArrowhead", "endArrowhead", "arrowheadSize"],
        context,
      );
      return {
        type: "connector",
        id: typeof obj.id === "string" ? expectString(obj.id, `${context}.id`) : undefined,
        presentation: obj.presentation ? validatePresentation(obj.presentation, `${context}.presentation`) : undefined,
        transform: obj.transform ? validateTransformOperations(obj.transform, `${context}.transform`) : undefined,
        bounds: obj.bounds as any,
        routing: obj.routing as any,
        from: obj.from as any,
        to: obj.to as any,
        waypoints: obj.waypoints as any,
        startArrowhead: obj.startArrowhead as any,
        endArrowhead: obj.endArrowhead as any,
        arrowheadSize: obj.arrowheadSize !== undefined ? expectNumber(obj.arrowheadSize, `${context}.arrowheadSize`) : undefined,
      };
    }
    case "label": {
      const obj = expectClosedObject(
        value,
        [...baseKeys, "text", "x", "y", "scale", "color", "lineSpacing", "align"],
        context,
      );
      return {
        type: "label",
        id: typeof obj.id === "string" ? expectString(obj.id, `${context}.id`) : undefined,
        presentation: obj.presentation ? validatePresentation(obj.presentation, `${context}.presentation`) : undefined,
        transform: obj.transform ? validateTransformOperations(obj.transform, `${context}.transform`) : undefined,
        bounds: obj.bounds as any,
        text: expectString(obj.text, `${context}.text`),
        x: expectNumber(obj.x, `${context}.x`),
        y: expectNumber(obj.y, `${context}.y`),
        scale: obj.scale !== undefined ? expectNumber(obj.scale, `${context}.scale`) : undefined,
        color: obj.color ? validatePaint(obj.color, `${context}.color`) : undefined,
        lineSpacing: obj.lineSpacing !== undefined ? expectNumber(obj.lineSpacing, `${context}.lineSpacing`) : undefined,
        align: obj.align as any,
      };
    }
    default:
      throw new VectorGraphicsValidationError(`Unknown scene element type "${type}" in ${context}`);
  }
}

export function validateAccessibility(value: unknown, context = "accessibility"): SceneAccessibility {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new VectorGraphicsValidationError(`Expected object for ${context}`);
  }
  const raw = value as { mode?: unknown };
  const mode = expectString(raw.mode, `${context}.mode`);
  if (mode === "labelled") {
    const obj = expectClosedObject(value, ["mode", "title", "desc", "focusable"], context);
    return {
      mode: "labelled",
      title: expectString(obj.title, `${context}.title`),
      desc: typeof obj.desc === "string" ? expectString(obj.desc, `${context}.desc`) : undefined,
      focusable: typeof obj.focusable === "boolean" ? expectBoolean(obj.focusable, `${context}.focusable`) : undefined,
    };
  } else if (mode === "decorative") {
    const obj = expectClosedObject(value, ["mode", "focusable"], context);
    return {
      mode: "decorative",
      focusable: typeof obj.focusable === "boolean" ? expectBoolean(obj.focusable, `${context}.focusable`) : undefined,
    };
  }
  throw new VectorGraphicsValidationError(`Invalid accessibility mode "${mode}" in ${context}`);
}

export function validateProvenance(value: unknown, context = "provenance"): SceneProvenance {
  const obj = expectClosedObject(value, ["author", "license", "sourceDigest", "created", "note"], context);
  return {
    author: typeof obj.author === "string" ? expectString(obj.author, `${context}.author`) : undefined,
    license: typeof obj.license === "string" ? expectString(obj.license, `${context}.license`) : undefined,
    sourceDigest: typeof obj.sourceDigest === "string" ? expectString(obj.sourceDigest, `${context}.sourceDigest`) : undefined,
    created: typeof obj.created === "string" ? expectString(obj.created, `${context}.created`) : undefined,
    note: typeof obj.note === "string" ? expectString(obj.note, `${context}.note`) : undefined,
  };
}

export function validateLayoutDirective(value: unknown, context = "layout"): LayoutDirective {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new VectorGraphicsValidationError(`Expected object for ${context}`);
  }
  const type = expectString((value as { type?: unknown }).type, `${context}.type`);
  switch (type) {
    case "align": {
      const obj = expectClosedObject(value, ["type", "alignment", "targets", "relativeTo"], context);
      const targets = expectArray(obj.targets, `${context}.targets`).map((t, i) => expectString(t, `${context}.targets[${i}]`));
      return {
        type: "align",
        alignment: expectString(obj.alignment, `${context}.alignment`) as any,
        targets,
        relativeTo: typeof obj.relativeTo === "string" ? expectString(obj.relativeTo, `${context}.relativeTo`) : undefined,
      };
    }
    case "distribute": {
      const obj = expectClosedObject(value, ["type", "axis", "targets", "spacing"], context);
      const targets = expectArray(obj.targets, `${context}.targets`).map((t, i) => expectString(t, `${context}.targets[${i}]`));
      return {
        type: "distribute",
        axis: expectString(obj.axis, `${context}.axis`) as any,
        targets,
        spacing: obj.spacing !== undefined ? expectNumber(obj.spacing, `${context}.spacing`) : undefined,
      };
    }
    case "grid": {
      const obj = expectClosedObject(value, ["type", "targets", "columns", "columnGap", "rowGap", "startX", "startY"], context);
      const targets = expectArray(obj.targets, `${context}.targets`).map((t, i) => expectString(t, `${context}.targets[${i}]`));
      return {
        type: "grid",
        targets,
        columns: expectNonNegativeInteger(obj.columns, `${context}.columns`),
        columnGap: obj.columnGap !== undefined ? expectNumber(obj.columnGap, `${context}.columnGap`) : undefined,
        rowGap: obj.rowGap !== undefined ? expectNumber(obj.rowGap, `${context}.rowGap`) : undefined,
        startX: obj.startX !== undefined ? expectNumber(obj.startX, `${context}.startX`) : undefined,
        startY: obj.startY !== undefined ? expectNumber(obj.startY, `${context}.startY`) : undefined,
      };
    }
    case "anchor": {
      const obj = expectClosedObject(value, ["type", "target", "targetAnchor", "relativeTo", "relativeToAnchor", "offsetX", "offsetY"], context);
      return {
        type: "anchor",
        target: expectString(obj.target, `${context}.target`),
        targetAnchor: expectString(obj.targetAnchor, `${context}.targetAnchor`) as any,
        relativeTo: expectString(obj.relativeTo, `${context}.relativeTo`),
        relativeToAnchor: expectString(obj.relativeToAnchor, `${context}.relativeToAnchor`) as any,
        offsetX: obj.offsetX !== undefined ? expectNumber(obj.offsetX, `${context}.offsetX`) : undefined,
        offsetY: obj.offsetY !== undefined ? expectNumber(obj.offsetY, `${context}.offsetY`) : undefined,
      };
    }
    default:
      throw new VectorGraphicsValidationError(`Invalid layout directive type "${type}" in ${context}`);
  }
}

export function validateScene(value: unknown): VectorScene {
  const obj = expectClosedObject(
    value,
    [
      "schema",
      "compatibility",
      "compilerLevel",
      "profile",
      "artboard",
      "accessibility",
      "elements",
      "definitions",
      "tokenBindings",
      "layout",
      "provenance",
    ],
    "scene",
  );
  const profile = expectString(obj.profile, "scene.profile") as SceneProfile;
  if (!["illustration", "diagram", "editorial", "promotional", "pattern"].includes(profile)) {
    throw new VectorGraphicsValidationError(`Invalid scene profile "${profile}"`);
  }
  const elementsArr = expectArray(obj.elements, "scene.elements", 10000);

  let tokenBindings: Record<string, string> | undefined;
  if (obj.tokenBindings !== undefined && obj.tokenBindings !== null) {
    if (typeof obj.tokenBindings !== "object" || Array.isArray(obj.tokenBindings)) {
      throw new VectorGraphicsValidationError("Expected object for scene.tokenBindings");
    }
    tokenBindings = {};
    for (const [k, v] of Object.entries(obj.tokenBindings as Record<string, unknown>)) {
      tokenBindings[expectString(k, "tokenBinding key")] = expectString(v, `tokenBinding value for ${k}`);
    }
  }

  let layout: LayoutDirective[] | undefined;
  if (obj.layout !== undefined && obj.layout !== null) {
    const layoutArr = expectArray(obj.layout, "scene.layout", 500);
    layout = layoutArr.map((l, i) => validateLayoutDirective(l, `scene.layout[${i}]`));
  }

  return {
    schema: expectString(obj.schema, "scene.schema"),
    compatibility: expectNonNegativeInteger(obj.compatibility, "scene.compatibility"),
    compilerLevel: expectNonNegativeInteger(obj.compilerLevel, "scene.compilerLevel"),
    profile,
    artboard: validateArtboard(obj.artboard),
    accessibility: validateAccessibility(obj.accessibility, "scene.accessibility"),
    elements: elementsArr.map((el, i) => validateSceneElement(el, 0, `scene.elements[${i}]`)),
    definitions: obj.definitions ? validateDefinitions(obj.definitions, "scene.definitions") : undefined,
    tokenBindings,
    layout,
    provenance: obj.provenance ? validateProvenance(obj.provenance, "scene.provenance") : undefined,
  };
}

export function validateDraftResponse(value: unknown): SceneDraftResponse {
  const obj = expectClosedObject(
    value,
    [
      "sessionId",
      "revision",
      "sourceId",
      "dirty",
      "scene",
      "canonicalJson",
      "draftInputDigest",
      "tokenSnapshotId",
      "compiled",
      "diagnostics",
    ],
    "draft response",
  );
  return {
    sessionId: expectString(obj.sessionId, "draft.sessionId"),
    revision: expectNonNegativeInteger(obj.revision, "draft.revision"),
    sourceId: typeof obj.sourceId === "string" ? expectString(obj.sourceId, "draft.sourceId") : undefined,
    dirty: expectBoolean(obj.dirty, "draft.dirty"),
    scene: validateScene(obj.scene),
    canonicalJson: expectString(obj.canonicalJson, "draft.canonicalJson", 16 * 1024 * 1024),
    draftInputDigest: expectString(obj.draftInputDigest, "draft.draftInputDigest"),
    tokenSnapshotId: typeof obj.tokenSnapshotId === "string" ? expectString(obj.tokenSnapshotId, "draft.tokenSnapshotId") : undefined,
    compiled: validateCompiledPreview(obj.compiled),
    diagnostics: validateDiagnostics(obj.diagnostics),
  };
}

export function validateStatusResponse(value: unknown): SceneStatusResponse {
  const obj = expectClosedObject(
    value,
    [
      "sessionId",
      "revision",
      "sourceId",
      "sourceDisplayName",
      "dirty",
      "disposed",
      "draftInputDigest",
      "tokenSnapshotId",
      "hasCompiledSvg",
      "compiledSvgDigest",
      "retainedSavePlan",
      "retainedExportPlan",
      "retainedPacketsCount",
      "diagnostics",
      "scene",
    ],
    "status response",
  );
  return {
    sessionId: expectString(obj.sessionId, "status.sessionId"),
    revision: expectNonNegativeInteger(obj.revision, "status.revision"),
    sourceId: typeof obj.sourceId === "string" ? expectString(obj.sourceId, "status.sourceId") : undefined,
    sourceDisplayName: typeof obj.sourceDisplayName === "string" ? expectString(obj.sourceDisplayName, "status.sourceDisplayName") : undefined,
    dirty: expectBoolean(obj.dirty, "status.dirty"),
    disposed: expectBoolean(obj.disposed, "status.disposed"),
    draftInputDigest: expectString(obj.draftInputDigest, "status.draftInputDigest"),
    tokenSnapshotId: typeof obj.tokenSnapshotId === "string" ? expectString(obj.tokenSnapshotId, "status.tokenSnapshotId") : undefined,
    hasCompiledSvg: expectBoolean(obj.hasCompiledSvg, "status.hasCompiledSvg"),
    compiledSvgDigest: typeof obj.compiledSvgDigest === "string" ? expectString(obj.compiledSvgDigest, "status.compiledSvgDigest") : undefined,
    retainedSavePlan: expectBoolean(obj.retainedSavePlan, "status.retainedSavePlan"),
    retainedExportPlan: expectBoolean(obj.retainedExportPlan, "status.retainedExportPlan"),
    retainedPacketsCount: expectNonNegativeInteger(obj.retainedPacketsCount, "status.retainedPacketsCount"),
    diagnostics: validateDiagnostics(obj.diagnostics),
    scene: obj.scene !== undefined ? validateScene(obj.scene) : undefined,
  };
}

export function validateDisposeResponse(value: unknown): SceneDisposeResponse {
  const obj = expectClosedObject(value, ["sessionId", "disposed"], "dispose response");
  return {
    sessionId: expectString(obj.sessionId, "dispose.sessionId"),
    disposed: expectBoolean(obj.disposed, "dispose.disposed"),
  };
}

export function validateSelectionResponse(value: unknown): SceneSelectionResponse {
  const obj = expectClosedObject(value, ["cancelled", "draft"], "selection response");
  return {
    cancelled: expectBoolean(obj.cancelled, "selection.cancelled"),
    draft: obj.draft ? validateDraftResponse(obj.draft) : undefined,
  };
}

export function validateImportResponse(value: unknown): SceneImportResponse {
  const obj = expectClosedObject(
    value,
    ["cancelled", "classification", "reasonCodes", "draft", "normalizations", "diagnostics"],
    "import response",
  );
  const rc = expectArray(obj.reasonCodes ?? [], "import.reasonCodes").map(String);
  const norm = expectArray(obj.normalizations ?? [], "import.normalizations").map(String);
  return {
    cancelled: expectBoolean(obj.cancelled, "import.cancelled"),
    classification: typeof obj.classification === "string" ? expectString(obj.classification, "import.classification") : undefined,
    reasonCodes: rc,
    draft: obj.draft ? validateDraftResponse(obj.draft) : undefined,
    normalizations: norm,
    diagnostics: validateDiagnostics(obj.diagnostics),
  };
}

export function validateCompileResponse(value: unknown): SceneCompileResponse {
  const obj = expectClosedObject(
    value,
    ["sessionId", "revision", "draftInputDigest", "svg", "receipt", "metrics", "diagnostics"],
    "compile response",
  );
  return {
    sessionId: expectString(obj.sessionId, "compile.sessionId"),
    revision: expectNonNegativeInteger(obj.revision, "compile.revision"),
    draftInputDigest: expectString(obj.draftInputDigest, "compile.draftInputDigest"),
    svg: typeof obj.svg === "string" ? expectString(obj.svg, "compile.svg", 16 * 1024 * 1024) : undefined,
    receipt: obj.receipt ? validateReceipt(obj.receipt) : undefined,
    metrics: obj.metrics ? validateMetrics(obj.metrics) : undefined,
    diagnostics: validateDiagnostics(obj.diagnostics),
  };
}

export function validatePlanResponse(value: unknown): ScenePlanResponse {
  const obj = expectClosedObject(
    value,
    ["cancelled", "planId", "targetDisplayName", "targetKind", "byteCount", "canonicalDigest", "expiresAtUnixMs"],
    "plan response",
  );
  return {
    cancelled: expectBoolean(obj.cancelled, "plan.cancelled"),
    planId: typeof obj.planId === "string" ? expectString(obj.planId, "plan.planId") : undefined,
    targetDisplayName: typeof obj.targetDisplayName === "string" ? expectString(obj.targetDisplayName, "plan.targetDisplayName") : undefined,
    targetKind: typeof obj.targetKind === "string" ? expectString(obj.targetKind, "plan.targetKind") : undefined,
    byteCount: obj.byteCount !== undefined ? expectNonNegativeInteger(obj.byteCount, "plan.byteCount") : undefined,
    canonicalDigest: typeof obj.canonicalDigest === "string" ? expectString(obj.canonicalDigest, "plan.canonicalDigest") : undefined,
    expiresAtUnixMs: obj.expiresAtUnixMs !== undefined ? expectNonNegativeInteger(obj.expiresAtUnixMs, "plan.expiresAtUnixMs") : undefined,
  };
}

export function validatePublicationResponse(value: unknown): ScenePublicationResponse {
  const obj = expectClosedObject(
    value,
    ["published", "targetDisplayName", "sourceId", "digest", "byteCount"],
    "publication response",
  );
  return {
    published: expectBoolean(obj.published, "publication.published"),
    targetDisplayName: typeof obj.targetDisplayName === "string" ? expectString(obj.targetDisplayName, "publication.targetDisplayName") : undefined,
    sourceId: typeof obj.sourceId === "string" ? expectString(obj.sourceId, "publication.sourceId") : undefined,
    digest: typeof obj.digest === "string" ? expectString(obj.digest, "publication.digest") : undefined,
    byteCount: obj.byteCount !== undefined ? expectNonNegativeInteger(obj.byteCount, "publication.byteCount") : undefined,
  };
}

export function validatePacketResponse(value: unknown): ScenePacketResponse {
  const obj = expectClosedObject(
    value,
    ["cancelled", "packetId", "packetKind", "canonicalJson", "packetDigest", "senderClaims", "diagnostics"],
    "packet response",
  );
  const claims = expectArray(obj.senderClaims ?? [], "packet.senderClaims").map(String);
  return {
    cancelled: expectBoolean(obj.cancelled ?? false, "packet.cancelled"),
    packetId: typeof obj.packetId === "string" ? expectString(obj.packetId, "packet.packetId") : undefined,
    packetKind: typeof obj.packetKind === "string" ? expectString(obj.packetKind, "packet.packetKind") : undefined,
    canonicalJson: typeof obj.canonicalJson === "string" ? expectString(obj.canonicalJson, "packet.canonicalJson", 16 * 1024 * 1024) : undefined,
    packetDigest: typeof obj.packetDigest === "string" ? expectString(obj.packetDigest, "packet.packetDigest") : undefined,
    senderClaims: claims,
    diagnostics: validateDiagnostics(obj.diagnostics),
  };
}

export function validateVerificationResponse(value: unknown): SceneVerificationResponse {
  const obj = expectClosedObject(
    value,
    ["valid", "candidatePacketId", "candidateDigest", "compiledSvgDigest", "metrics", "diagnostics", "verificationHandle"],
    "verification response",
  );
  return {
    valid: expectBoolean(obj.valid, "verification.valid"),
    candidatePacketId: expectString(obj.candidatePacketId, "verification.candidatePacketId"),
    candidateDigest: expectString(obj.candidateDigest, "verification.candidateDigest"),
    compiledSvgDigest: typeof obj.compiledSvgDigest === "string" ? expectString(obj.compiledSvgDigest, "verification.compiledSvgDigest") : undefined,
    metrics: obj.metrics ? validateMetrics(obj.metrics) : undefined,
    diagnostics: validateDiagnostics(obj.diagnostics),
    verificationHandle: expectString(obj.verificationHandle, "verification.verificationHandle"),
  };
}

// ---------------------------------------------------------------------------
// Request Boundary & Ceiling Check
// ---------------------------------------------------------------------------
function boundSceneRequest(request: unknown, maxBytes = 16 * 1024 * 1024): void {
  if (request === undefined || request === null) return;
  const json = JSON.stringify(request);
  if (new TextEncoder().encode(json).byteLength > maxBytes) {
    throw new VectorGraphicsValidationError(`Request payload exceeds ceiling of ${maxBytes} bytes`);
  }
}

// ---------------------------------------------------------------------------
// Tauri Native Bridge Implementation
// ---------------------------------------------------------------------------
export class TauriVectorGraphicsBridge implements VectorGraphicsBridge {
  async newScene(request: SceneNewRequest): Promise<SceneDraftResponse> {
    boundSceneRequest(request);
    const raw = await invoke(SCENE_COMMANDS.new, { request });
    return validateDraftResponse(raw);
  }

  async getStatus(request?: SceneStatusRequest): Promise<SceneStatusResponse> {
    boundSceneRequest(request);
    const raw = await invoke(SCENE_COMMANDS.status, { request: request ?? {} });
    return validateStatusResponse(raw);
  }

  async dispose(request: SceneDisposeRequest): Promise<SceneDisposeResponse> {
    boundSceneRequest(request);
    const raw = await invoke(SCENE_COMMANDS.dispose, { request });
    return validateDisposeResponse(raw);
  }

  async openScene(request?: SceneOpenRequest): Promise<SceneSelectionResponse> {
    boundSceneRequest(request);
    const raw = await invoke(SCENE_COMMANDS.open, { request: request ?? {} });
    return validateSelectionResponse(raw);
  }

  async importSvg(request?: SceneImportSvgRequest): Promise<SceneImportResponse> {
    boundSceneRequest(request);
    const raw = await invoke(SCENE_COMMANDS.importSvg, { request: request ?? {} });
    return validateImportResponse(raw);
  }

  async editScene(request: SceneEditRequest): Promise<SceneDraftResponse> {
    boundSceneRequest(request);
    const raw = await invoke(SCENE_COMMANDS.edit, { request });
    return validateDraftResponse(raw);
  }

  async compileScene(request: SceneCompileRequest): Promise<SceneCompileResponse> {
    boundSceneRequest(request);
    const raw = await invoke(SCENE_COMMANDS.compile, { request });
    return validateCompileResponse(raw);
  }

  async savePlan(request: SceneSavePlanRequest): Promise<ScenePlanResponse> {
    boundSceneRequest(request);
    const raw = await invoke(SCENE_COMMANDS.savePlan, { request });
    return validatePlanResponse(raw);
  }

  async saveApply(request: SceneApplyRequest): Promise<ScenePublicationResponse> {
    boundSceneRequest(request);
    const raw = await invoke(SCENE_COMMANDS.saveApply, { request });
    return validatePublicationResponse(raw);
  }

  async exportPlan(request: SceneExportPlanRequest): Promise<ScenePlanResponse> {
    boundSceneRequest(request);
    const raw = await invoke(SCENE_COMMANDS.exportPlan, { request });
    return validatePlanResponse(raw);
  }

  async exportApply(request: SceneApplyRequest): Promise<ScenePublicationResponse> {
    boundSceneRequest(request);
    const raw = await invoke(SCENE_COMMANDS.exportApply, { request });
    return validatePublicationResponse(raw);
  }

  async bindTokens(request: SceneTokenBindRequest): Promise<SceneDraftResponse> {
    boundSceneRequest(request);
    const raw = await invoke(SCENE_COMMANDS.bindTokens, { request });
    return validateDraftResponse(raw);
  }

  async createBrief(request: SceneBriefRequest): Promise<ScenePacketResponse> {
    boundSceneRequest(request);
    const raw = await invoke(SCENE_COMMANDS.briefCreate, { request });
    return validatePacketResponse(raw);
  }

  async importPacket(request?: ScenePacketImportRequest): Promise<ScenePacketResponse> {
    boundSceneRequest(request);
    const raw = await invoke(SCENE_COMMANDS.packetImport, { request: request ?? {} });
    return validatePacketResponse(raw);
  }

  async exportPacket(request: ScenePacketExportRequest): Promise<ScenePublicationResponse> {
    boundSceneRequest(request);
    const raw = await invoke(SCENE_COMMANDS.packetExport, { request });
    return validatePublicationResponse(raw);
  }

  async createReview(request: SceneReviewRequest): Promise<ScenePacketResponse> {
    boundSceneRequest(request);
    const raw = await invoke(SCENE_COMMANDS.reviewCreate, { request });
    return validatePacketResponse(raw);
  }

  async verifyCandidate(request: SceneVerifyRequest): Promise<SceneVerificationResponse> {
    boundSceneRequest(request);
    const raw = await invoke(SCENE_COMMANDS.candidateVerify, { request });
    return validateVerificationResponse(raw);
  }

  async adoptCandidate(request: SceneAdoptRequest): Promise<SceneDraftResponse> {
    boundSceneRequest(request);
    const raw = await invoke(SCENE_COMMANDS.candidateAdopt, { request });
    return validateDraftResponse(raw);
  }
}
