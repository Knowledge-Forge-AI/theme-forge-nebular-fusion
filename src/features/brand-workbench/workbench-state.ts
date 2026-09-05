import type {
  BrandStatus, ConsumerLockStatus, ConsumerProfilePage, ExportCapability, ExportStatus,
  ExportStatusPage, FamilyPage, QaProfile, QaProfilePage, QaResult, RecipeGraph,
  SemanticDiff, TokenPage, VisualTarget,
} from "../../brand-read/StudioBrandReadClient";
import type { StudioProjectOpen, StudioSourceOpen } from "../../protocol/contracts";

export type WorkbenchView = "overview" | "families" | "tokens" | "recipes" | "qa" | "semantic-diff" | "consumer" | "export";
export type ViewData =
  | { readonly view: "overview"; readonly status: BrandStatus }
  | { readonly view: "families"; readonly families: FamilyPage }
  | { readonly view: "tokens"; readonly tokens: TokenPage }
  | { readonly view: "recipes"; readonly graph: RecipeGraph }
  | { readonly view: "qa"; readonly profiles: QaProfilePage; readonly selectedProfileId: string | null; readonly profile: QaProfile | null; readonly result: QaResult | null }
  | { readonly view: "semantic-diff"; readonly semanticDiff: SemanticDiff }
  | { readonly view: "consumer"; readonly profiles: ConsumerProfilePage; readonly lock: ConsumerLockStatus }
  | { readonly view: "export"; readonly capability: ExportCapability; readonly status: ExportStatusPage };

interface EvidenceBase { readonly label: string; readonly assetId: string; readonly width: number; readonly height: number; readonly background: string }
export type SelectedEvidence =
  | { readonly kind: "none" }
  | (EvidenceBase & { readonly kind: "project-asset"; readonly target: Extract<VisualTarget, { readonly kind: "asset" }> })
  | (EvidenceBase & { readonly kind: "project-binding"; readonly target: Extract<VisualTarget, { readonly kind: "binding" }> })
  | { readonly kind: "qa-baseline-case"; readonly label: string; readonly profileId: string; readonly caseId: string; readonly assetId: string; readonly width: number; readonly height: number; readonly background: string }
  | (EvidenceBase & { readonly kind: "brand-diff-asset"; readonly target: Extract<VisualTarget, { readonly kind: "asset" }> })
  | (EvidenceBase & { readonly kind: "brand-diff-binding"; readonly target: Extract<VisualTarget, { readonly kind: "binding" }> })
  | (EvidenceBase & { readonly kind: "export-output-target"; readonly profileId: string; readonly outputId: string; readonly target: VisualTarget; readonly output: ExportStatus });

export interface ViewState { readonly loading: boolean; readonly data?: ViewData; readonly error?: string; readonly nextCursor: string | null; readonly cursorStack: readonly (string | null)[]; readonly pageNumber: number }
export interface WorkbenchState {
  readonly hostReady: boolean;
  readonly project: StudioProjectOpen | undefined;
  readonly source: StudioSourceOpen | undefined;
  readonly activeView: WorkbenchView;
  readonly views: Readonly<Partial<Record<WorkbenchView, ViewState>>>;
  readonly selection: SelectedEvidence;
  readonly announcement: string | undefined;
}
export type WorkbenchAction =
  | { readonly type: "host"; readonly ready: boolean }
  | { readonly type: "project"; readonly project: StudioProjectOpen | undefined }
  | { readonly type: "source"; readonly source: StudioSourceOpen | undefined }
  | { readonly type: "view"; readonly view: WorkbenchView }
  | { readonly type: "loading"; readonly view: WorkbenchView }
  | { readonly type: "loaded"; readonly view: WorkbenchView; readonly data: ViewData; readonly nextCursor: string | null; readonly cursorStack: readonly (string | null)[]; readonly pageNumber: number }
  | { readonly type: "error"; readonly view: WorkbenchView; readonly message: string }
  | { readonly type: "select"; readonly selection: SelectedEvidence }
  | { readonly type: "announce"; readonly message?: string };

export const initialWorkbenchState: WorkbenchState = { hostReady: false, project: undefined, source: undefined, activeView: "overview", views: {}, selection: { kind: "none" }, announcement: undefined };

export function workbenchReducer(state: WorkbenchState, action: WorkbenchAction): WorkbenchState {
  if (action.type === "host") return action.ready ? { ...state, hostReady: true } : { ...initialWorkbenchState, activeView: state.activeView, project: state.project, source: state.source };
  if (action.type === "project") return { ...initialWorkbenchState, hostReady: state.hostReady, activeView: state.activeView, project: action.project, source: state.source };
  if (action.type === "source") return { ...state, source: action.source, views: {}, selection: { kind: "none" }, announcement: undefined };
  if (action.type === "view") return { ...state, activeView: action.view, selection: { kind: "none" }, announcement: undefined };
  if (action.type === "loading") return { ...state, views: { ...state.views, [action.view]: { ...(state.views[action.view] ?? { nextCursor: null, cursorStack: [null], pageNumber: 1 }), loading: true } } };
  if (action.type === "loaded") return { ...state, views: { ...state.views, [action.view]: { loading: false, data: action.data, nextCursor: action.nextCursor, cursorStack: action.cursorStack, pageNumber: action.pageNumber } }, selection: { kind: "none" } };
  if (action.type === "error") return { ...state, views: { ...state.views, [action.view]: { loading: false, error: action.message, nextCursor: null, cursorStack: [null], pageNumber: 1 } }, selection: { kind: "none" } };
  if (action.type === "select") return { ...state, selection: action.selection };
  return { ...state, announcement: action.message };
}
