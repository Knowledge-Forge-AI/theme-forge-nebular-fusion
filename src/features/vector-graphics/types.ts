// Vector Graphics types - local public-safe types matching src/scene/types.ts
// and native scene/protocol_dto.rs. No private core runtime imports.

export type SceneSchema = "tfsb.vector-scene-v1";
export type SceneCompatibility = 1;
export type SceneCompilerLevel = 1;

export type SceneProfile =
  | "illustration"
  | "diagram"
  | "editorial"
  | "promotional"
  | "pattern";

export type ScenePresetName =
  | "hero"
  | "section"
  | "diagram"
  | "figure"
  | "social";

export type ArtboardPolicy = "contain" | "pad";

export interface Artboard {
  readonly width: number;
  readonly height: number;
  readonly viewBox: readonly [number, number, number, number];
  readonly policy?: ArtboardPolicy | undefined;
}

export type Paint =
  | { readonly type: "none" }
  | { readonly type: "currentColor" }
  | { readonly type: "solid"; readonly color: string }
  | { readonly type: "token"; readonly name: string }
  | { readonly type: "gradient"; readonly id: string; readonly fallback?: string | undefined };

export type StrokeLinecap = "butt" | "round" | "square";
export type StrokeLinejoin = "miter" | "round" | "bevel";
export type FillRule = "nonzero" | "evenodd";
export type ClipRule = "nonzero" | "evenodd";

export interface Presentation {
  readonly fill?: Paint | undefined;
  readonly stroke?: Paint | undefined;
  readonly strokeWidth?: number | undefined;
  readonly strokeDasharray?: readonly number[] | undefined;
  readonly strokeDashoffset?: number | undefined;
  readonly strokeLinecap?: StrokeLinecap | undefined;
  readonly strokeLinejoin?: StrokeLinejoin | undefined;
  readonly strokeMiterlimit?: number | undefined;
  readonly opacity?: number | undefined;
  readonly fillOpacity?: number | undefined;
  readonly strokeOpacity?: number | undefined;
  readonly fillRule?: FillRule | undefined;
  readonly clipRule?: ClipRule | undefined;
  readonly ariaHidden?: boolean | undefined;
}

export type TransformOperation =
  | { readonly type: "translate"; readonly x: number; readonly y?: number | undefined }
  | { readonly type: "scale"; readonly x: number; readonly y?: number | undefined }
  | { readonly type: "rotate"; readonly angle: number; readonly cx?: number | undefined; readonly cy?: number | undefined }
  | { readonly type: "matrix"; readonly a: number; readonly b: number; readonly c: number; readonly d: number; readonly e: number; readonly f: number };

export interface GradientStop {
  readonly offset: number;
  readonly color: Paint;
  readonly opacity?: number | undefined;
}

export interface LinearGradientDef {
  readonly id: string;
  readonly type: "linearGradient";
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly gradientUnits?: "userSpaceOnUse" | "objectBoundingBox" | undefined;
  readonly spreadMethod?: "pad" | undefined;
  readonly stops: readonly GradientStop[];
}

export interface RadialGradientDef {
  readonly id: string;
  readonly type: "radialGradient";
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
  readonly fx?: number | undefined;
  readonly fy?: number | undefined;
  readonly gradientUnits?: "userSpaceOnUse" | "objectBoundingBox" | undefined;
  readonly spreadMethod?: "pad" | undefined;
  readonly stops: readonly GradientStop[];
}

export type GradientDef = LinearGradientDef | RadialGradientDef;

export interface SymbolDef {
  readonly id: string;
  readonly type: "symbol";
  readonly viewBox: readonly [number, number, number, number];
  readonly elements: readonly SceneElement[];
}

export interface SceneDefinitions {
  readonly gradients?: readonly GradientDef[] | undefined;
  readonly symbols?: readonly SymbolDef[] | undefined;
}

export type CardinalAnchor = "top" | "bottom" | "left" | "right" | "center";

export type ConnectorEndpoint =
  | { readonly x: number; readonly y: number }
  | { readonly elementId: string; readonly anchor: CardinalAnchor };

export type ArrowheadType = "none" | "triangle" | "chevron";
export type ConnectorRouting = "straight" | "orthogonal";

export type ElementBounds = readonly [number, number, number, number];

export interface BaseElement {
  readonly id?: string | undefined;
  readonly presentation?: Presentation | undefined;
  readonly transform?: readonly TransformOperation[] | undefined;
  readonly bounds?: ElementBounds | undefined;
}

export interface PathElement extends BaseElement {
  readonly type: "path";
  readonly d: string;
}

export interface RectElement extends BaseElement {
  readonly type: "rect";
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly rx?: number | undefined;
  readonly ry?: number | undefined;
}

export interface CircleElement extends BaseElement {
  readonly type: "circle";
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
}

export interface EllipseElement extends BaseElement {
  readonly type: "ellipse";
  readonly cx: number;
  readonly cy: number;
  readonly rx: number;
  readonly ry: number;
}

export interface LineElement extends BaseElement {
  readonly type: "line";
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export interface PolylineElement extends BaseElement {
  readonly type: "polyline";
  readonly points: readonly (readonly [number, number])[];
}

export interface PolygonElement extends BaseElement {
  readonly type: "polygon";
  readonly points: readonly (readonly [number, number])[];
}

export interface GroupElement extends BaseElement {
  readonly type: "group";
  readonly children: readonly SceneElement[];
}

export interface UseElement extends BaseElement {
  readonly type: "use";
  readonly href: string;
  readonly x?: number | undefined;
  readonly y?: number | undefined;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
}

export interface DiagramNodeElement extends BaseElement {
  readonly type: "diagramNode";
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly rx?: number | undefined;
  readonly ry?: number | undefined;
  readonly label?: string | undefined;
  readonly labelColor?: Paint | undefined;
  readonly labelScale?: number | undefined;
}

export interface ConnectorElement extends BaseElement {
  readonly type: "connector";
  readonly routing: ConnectorRouting;
  readonly from: ConnectorEndpoint;
  readonly to: ConnectorEndpoint;
  readonly waypoints?: readonly (readonly [number, number])[] | undefined;
  readonly startArrowhead?: ArrowheadType | undefined;
  readonly endArrowhead?: ArrowheadType | undefined;
  readonly arrowheadSize?: number | undefined;
}

export interface LabelElement extends BaseElement {
  readonly type: "label";
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly scale?: number | undefined;
  readonly color?: Paint | undefined;
  readonly lineSpacing?: number | undefined;
  readonly align?: ("left" | "center" | "right") | undefined;
}

export type SceneElement =
  | PathElement
  | RectElement
  | CircleElement
  | EllipseElement
  | LineElement
  | PolylineElement
  | PolygonElement
  | GroupElement
  | UseElement
  | DiagramNodeElement
  | ConnectorElement
  | LabelElement;

export type ElementType = SceneElement["type"];

export type AlignAxis = "left" | "center" | "right" | "top" | "middle" | "bottom";
export type DistributeAxis = "horizontal" | "vertical";

export type LayoutDirective =
  | {
      readonly type: "align";
      readonly alignment: AlignAxis;
      readonly targets: readonly string[];
      readonly relativeTo?: string | undefined;
    }
  | {
      readonly type: "distribute";
      readonly axis: DistributeAxis;
      readonly targets: readonly string[];
      readonly spacing?: number | undefined;
    }
  | {
      readonly type: "grid";
      readonly targets: readonly string[];
      readonly columns: number;
      readonly columnGap?: number | undefined;
      readonly rowGap?: number | undefined;
      readonly startX?: number | undefined;
      readonly startY?: number | undefined;
    }
  | {
      readonly type: "anchor";
      readonly target: string;
      readonly targetAnchor: CardinalAnchor;
      readonly relativeTo: string;
      readonly relativeToAnchor: CardinalAnchor;
      readonly offsetX?: number | undefined;
      readonly offsetY?: number | undefined;
    };

export type SceneAccessibility =
  | {
      readonly mode: "labelled";
      readonly title: string;
      readonly desc?: string | undefined;
      readonly focusable?: boolean | undefined;
    }
  | {
      readonly mode: "decorative";
      readonly focusable?: boolean | undefined;
    };

export interface SceneProvenance {
  readonly author?: string | undefined;
  readonly license?: string | undefined;
  readonly sourceDigest?: string | undefined;
  readonly created?: string | undefined;
  readonly note?: string | undefined;
}

export interface VectorScene {
  readonly schema: string;
  readonly compatibility: number;
  readonly compilerLevel: number;
  readonly profile: SceneProfile;
  readonly artboard: Artboard;
  readonly accessibility: SceneAccessibility;
  readonly elements: readonly SceneElement[];
  readonly definitions?: SceneDefinitions | undefined;
  readonly tokenBindings?: Readonly<Record<string, string>> | undefined;
  readonly layout?: readonly LayoutDirective[] | undefined;
  readonly provenance?: SceneProvenance | undefined;
}

export interface SceneMetricsDto {
  readonly expandedElementCount: number;
  readonly authoredElementCount: number;
  readonly pathSegmentCount: number;
  readonly glyphCount: number;
  readonly maxNestingDepth: number;
  readonly gradientStopCount: number;
}

export type SceneMetrics = SceneMetricsDto;

export interface SceneReceiptDto {
  readonly schema: string;
  readonly diagnostics: readonly string[];
  readonly sourceSnapshotDigest: string;
  readonly sceneSchema: string;
  readonly sceneCompatibility: number;
  readonly sceneCompilerLevel: number;
  readonly sourceDigest: string;
  readonly svgDigest: string;
  readonly profile: SceneProfile;
  readonly artboard: Artboard;
  readonly glyphCatalogDigest: string;
  readonly tokenDigest: string;
  readonly metrics: SceneMetricsDto;
}

export type SceneReceipt = SceneReceiptDto;

export interface SceneDiagnosticDto {
  readonly code: string;
  readonly message: string;
  readonly severity?: string | undefined;
  readonly path?: string | undefined;
}

export type SceneDiagnostic = SceneDiagnosticDto;

export interface SceneCompiledPreview {
  readonly svg: string;
  readonly svgDigest: string;
  readonly receipt: SceneReceiptDto;
  readonly metrics: SceneMetricsDto;
}

export interface SceneError {
  readonly code: string;
  readonly message: string;
  readonly fieldPath?: string | undefined;
}

// ---------------------------------------------------------------------------
// Expected binding interface
// Binds sessionId, revision, draftInputDigest, sourceId, tokenSnapshotId, engineIdentity
// ---------------------------------------------------------------------------
export interface SceneExpected {
  readonly sessionId: string;
  readonly revision: number;
  readonly draftInputDigest?: string | undefined;
  readonly sourceId?: string | undefined;
  readonly tokenSnapshotId?: string | undefined;
  readonly engineIdentity?: string | undefined;
}

export type ExpectedBinding = SceneExpected;

// ---------------------------------------------------------------------------
// Typed Scene Edit Operations (aligned with native SceneEditOperation enum)
// ---------------------------------------------------------------------------
export type SceneEditOperation =
  | { readonly type: "setArtboard"; readonly artboard: Artboard }
  | { readonly type: "setProfile"; readonly profile: SceneProfile }
  | { readonly type: "setAccessibility"; readonly accessibility: SceneAccessibility }
  | { readonly type: "insertElement"; readonly index?: number | undefined; readonly element: SceneElement }
  | { readonly type: "updateElement"; readonly id: string; readonly element: SceneElement }
  | { readonly type: "removeElement"; readonly id: string }
  | { readonly type: "moveElement"; readonly id: string; readonly newIndex: number }
  | { readonly type: "setDefinitions"; readonly definitions?: SceneDefinitions | undefined }
  | { readonly type: "setTokenBindings"; readonly tokenBindings?: Readonly<Record<string, string>> | undefined }
  | { readonly type: "setLayout"; readonly layout?: readonly LayoutDirective[] | undefined }
  | { readonly type: "setProvenance"; readonly provenance?: SceneProvenance | undefined }
  | { readonly type: "replaceScene"; readonly scene: VectorScene };

// ---------------------------------------------------------------------------
// 18 Fixed Command Request & Response DTOs
// ---------------------------------------------------------------------------

// 1. studio_scene_new
export interface SceneNewRequest {
  readonly expected?: SceneExpected | undefined;
  readonly replacementIntentId?: string | undefined;
  readonly profile?: SceneProfile | undefined;
  readonly preset?: string | undefined;
  readonly artboard?: Artboard | undefined;
  readonly title?: string | undefined;
}

export interface SceneDraftResponse {
  readonly sessionId: string;
  readonly revision: number;
  readonly sourceId?: string | undefined;
  readonly dirty: boolean;
  readonly scene: VectorScene;
  readonly canonicalJson: string;
  readonly draftInputDigest: string;
  readonly tokenSnapshotId?: string | undefined;
  readonly compiled?: SceneCompiledPreview | undefined;
  readonly diagnostics: readonly SceneDiagnosticDto[];
  readonly error?: SceneError | undefined;
}

// 2. studio_scene_status
export interface SceneStatusRequest {
  readonly expected?: SceneExpected | undefined;
}

export interface SceneStatusResponse {
  readonly sessionId: string;
  readonly revision: number;
  readonly sourceId?: string | undefined;
  readonly sourceDisplayName?: string | undefined;
  readonly dirty: boolean;
  readonly disposed: boolean;
  readonly draftInputDigest: string;
  readonly tokenSnapshotId?: string | undefined;
  readonly hasCompiledSvg: boolean;
  readonly compiledSvgDigest?: string | undefined;
  readonly retainedSavePlan: boolean;
  readonly retainedExportPlan: boolean;
  readonly retainedPacketsCount: number;
  readonly diagnostics: readonly SceneDiagnosticDto[];
  readonly scene?: VectorScene | undefined;
  readonly message?: string | undefined;
  readonly error?: SceneError | undefined;
}

// 3. studio_scene_dispose
export interface SceneDisposeRequest {
  readonly expected: SceneExpected;
}

export interface SceneDisposeResponse {
  readonly sessionId: string;
  readonly disposed: boolean;
  readonly error?: SceneError | undefined;
}

// 4. studio_scene_open
export interface SceneOpenRequest {
  readonly expected?: SceneExpected | undefined;
  readonly replacementIntentId?: string | undefined;
}

export interface SceneSelectionResponse {
  readonly cancelled: boolean;
  readonly draft?: SceneDraftResponse | undefined;
  readonly error?: SceneError | undefined;
}

// 5. studio_scene_import_svg
export interface SceneImportSvgRequest {
  readonly expected?: SceneExpected | undefined;
  readonly replacementIntentId?: string | undefined;
}

export interface SceneImportResponse {
  readonly cancelled: boolean;
  readonly classification?: string | undefined;
  readonly reasonCodes: readonly string[];
  readonly draft?: SceneDraftResponse | undefined;
  readonly normalizations: readonly string[];
  readonly diagnostics: readonly SceneDiagnosticDto[];
  readonly error?: SceneError | undefined;
}

// 6. studio_scene_edit
export interface SceneEditRequest {
  readonly expected: SceneExpected;
  readonly operations: readonly SceneEditOperation[];
}

// 7. studio_scene_compile
export interface SceneCompileRequest {
  readonly expected: SceneExpected;
  readonly dryRun?: boolean | undefined;
}

export interface SceneCompileResponse {
  readonly sessionId: string;
  readonly revision: number;
  readonly draftInputDigest: string;
  readonly svg?: string | undefined;
  readonly receipt?: SceneReceiptDto | undefined;
  readonly metrics?: SceneMetricsDto | undefined;
  readonly diagnostics: readonly SceneDiagnosticDto[];
  readonly error?: SceneError | undefined;
}

// 8. studio_scene_save_plan
export interface SceneSavePlanRequest {
  readonly expected: SceneExpected;
  readonly defaultName?: string | undefined;
}

export interface ScenePlanResponse {
  readonly cancelled: boolean;
  readonly planId?: string | undefined;
  readonly targetDisplayName?: string | undefined;
  readonly targetKind?: string | undefined;
  readonly byteCount?: number | undefined;
  readonly canonicalDigest?: string | undefined;
  readonly expiresAtUnixMs?: number | undefined;
  readonly error?: SceneError | undefined;
}

// 9. studio_scene_save_apply & 11. studio_scene_export_apply
export interface SceneApplyRequest {
  readonly expected: SceneExpected;
  readonly planId: string;
}

export interface ScenePublicationResponse {
  readonly published: boolean;
  readonly targetDisplayName?: string | undefined;
  readonly sourceId?: string | undefined;
  readonly digest?: string | undefined;
  readonly byteCount?: number | undefined;
  readonly error?: SceneError | undefined;
}

// 10. studio_scene_export_plan
export interface SceneExportPlanRequest {
  readonly expected: SceneExpected;
  readonly defaultName?: string | undefined;
}

// 12. studio_scene_bind_tokens
export interface SceneTokenBindRequest {
  readonly expected: SceneExpected;
  readonly projectHandle: string;
}

// 13. studio_scene_brief_create
export interface SceneBriefRequest {
  readonly expected: SceneExpected;
  readonly title: string;
  readonly objective: string;
  readonly acceptanceCriteria?: readonly string[] | undefined;
  readonly prohibitedChanges?: readonly string[] | undefined;
}

export interface ScenePacketResponse {
  readonly cancelled: boolean;
  readonly packetId?: string | undefined;
  readonly packetKind?: string | undefined;
  readonly canonicalJson?: string | undefined;
  readonly packetDigest?: string | undefined;
  readonly senderClaims: readonly string[];
  readonly diagnostics: readonly SceneDiagnosticDto[];
  readonly error?: SceneError | undefined;
}

// 14. studio_scene_packet_import
export interface ScenePacketImportRequest {
  readonly expected?: SceneExpected | undefined;
  readonly expectedKind?: string | undefined;
}

// 15. studio_scene_packet_export
export interface ScenePacketExportRequest {
  readonly expected: SceneExpected;
  readonly packetId: string;
}

// 16. studio_scene_review_create
export interface SceneReviewAnnotationDto {
  readonly annotationId: string;
  readonly candidateId: string;
  readonly comment: string;
  readonly severity: string;
  readonly elementId?: string | undefined;
}

export interface SceneReviewRequest {
  readonly expected: SceneExpected;
  readonly briefPacketId: string;
  readonly candidatePacketIds: readonly string[];
  readonly overallDisposition: string;
  readonly summary: string;
  readonly annotations?: readonly SceneReviewAnnotationDto[] | undefined;
}

// 17. studio_scene_candidate_verify
export interface SceneVerifyRequest {
  readonly expected: SceneExpected;
  readonly candidatePacketId: string;
  readonly briefPacketId?: string | undefined;
}

export interface SceneVerificationResponse {
  readonly valid: boolean;
  readonly candidatePacketId: string;
  readonly candidateDigest: string;
  readonly compiledSvgDigest?: string | undefined;
  readonly metrics?: SceneMetricsDto | undefined;
  readonly diagnostics: readonly SceneDiagnosticDto[];
  readonly verificationHandle: string;
  readonly error?: SceneError | undefined;
}

// 18. studio_scene_candidate_adopt
export interface SceneAdoptRequest {
  readonly expected: SceneExpected;
  readonly verificationHandle: string;
}

// ---------------------------------------------------------------------------
// Vector Graphics Bridge Interface
// ---------------------------------------------------------------------------
export interface VectorGraphicsBridge {
  newScene(request: SceneNewRequest): Promise<SceneDraftResponse>;
  getStatus(request?: SceneStatusRequest): Promise<SceneStatusResponse>;
  dispose(request: SceneDisposeRequest): Promise<SceneDisposeResponse>;
  openScene(request?: SceneOpenRequest): Promise<SceneSelectionResponse>;
  importSvg(request?: SceneImportSvgRequest): Promise<SceneImportResponse>;
  editScene(request: SceneEditRequest): Promise<SceneDraftResponse>;
  compileScene(request: SceneCompileRequest): Promise<SceneCompileResponse>;
  savePlan(request: SceneSavePlanRequest): Promise<ScenePlanResponse>;
  saveApply(request: SceneApplyRequest): Promise<ScenePublicationResponse>;
  exportPlan(request: SceneExportPlanRequest): Promise<ScenePlanResponse>;
  exportApply(request: SceneApplyRequest): Promise<ScenePublicationResponse>;
  bindTokens(request: SceneTokenBindRequest): Promise<SceneDraftResponse>;
  createBrief(request: SceneBriefRequest): Promise<ScenePacketResponse>;
  importPacket(request?: ScenePacketImportRequest): Promise<ScenePacketResponse>;
  exportPacket(request: ScenePacketExportRequest): Promise<ScenePublicationResponse>;
  createReview(request: SceneReviewRequest): Promise<ScenePacketResponse>;
  verifyCandidate(request: SceneVerifyRequest): Promise<SceneVerificationResponse>;
  adoptCandidate(request: SceneAdoptRequest): Promise<SceneDraftResponse>;
}

export interface VectorGraphicsLabProps {
  bridge?: VectorGraphicsBridge | undefined;
  projectHandle?: string | undefined;
}
