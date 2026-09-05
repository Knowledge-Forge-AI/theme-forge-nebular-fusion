export type ProtocolVersion = "1.0" | "1.1" | "1.2";
export type StudioHostSource = "rust-tauri" | "fixture-test";
export type StudioHostState = "not-started" | "verifying" | "starting" | "initializing" | "ready" | "stopping" | "stopped" | "crashed" | "failed";
export type ProjectOpenMode = "existing" | "import-target";
export type SourceSelectKind = "content-directory" | "content-archive" | "source-map" | "normalization-map" | "shard-manifest" | "brand-bundle" | "npm-installed-package";

export interface StudioHostStateEvent {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly state: StudioHostState;
  readonly reasonCode?: string;
}

export interface StudioHostStatus {
  readonly schemaVersion: 1;
  readonly studioVersion: "0.1.0";
  readonly manifestDigest: string | null;
  readonly state: StudioHostState;
  readonly selectedProtocolVersion: "1.2" | null;
  readonly serverVersion: string | null;
  readonly methods: readonly string[];
  readonly capabilities: StudioHostCapabilitySummary | null;
  readonly raster: { readonly available: boolean; readonly qualificationIdentity: string | null };
  readonly projectOpenCount: number;
  readonly sourceOpenCount: number;
  readonly lastReasonCode: string | null;
}

export interface StudioHostCapabilitySummary {
  readonly baseMethods: readonly string[];
  readonly brandReads: readonly string[];
  readonly brandSourcePurposes: readonly ["brandBundle", "npmInstalledPackage"];
  readonly limits: {
    readonly assetPageSizeDefault: 64; readonly assetPageSizeMax: 128; readonly assetPageSizeMin: 1;
    readonly brandPageSizeDefault: 64; readonly brandPageSizeMax: 128; readonly brandPageSizeMin: 1;
    readonly maxDiffResultBytes: 16_777_216; readonly maxFrameBytes: 16_777_216; readonly maxQaResultBytes: 16_777_216;
  };
  readonly planCapabilities: {
    readonly consumerInstall: true; readonly consumerSync: true; readonly derive: true;
    readonly export: boolean; readonly qaBaseline: boolean;
  };
}

export interface StudioProjectOpen {
  readonly projectHandle: string;
  readonly rootKind: "project";
  readonly schemaVersion: 1 | 2 | null;
  readonly name: string | null;
  readonly canonicalDigest: string | null;
  readonly assetCount: number | null;
  readonly companionCount: number | null;
  readonly state: "uninitialized" | null;
}

export type StudioProjectSelectResult =
  | { readonly cancelled: true; readonly project?: never }
  | { readonly cancelled: false; readonly project: StudioProjectOpen };

export interface StudioSourceOpen {
  readonly sourceHandle: string;
  readonly rootKind: "source";
  readonly sourceKind: "directory" | "archive" | null;
  readonly authorityKind: "source-map" | "normalization-map" | "shard-manifest" | "brand-bundle" | "npm-installed-package" | null;
  readonly digest: string | null;
  readonly packageId: string | null;
  readonly brandVersion: string | null;
  readonly brandSystemDigest: string | null;
  readonly candidateCount: number | null;
  readonly profileCount: number | null;
  readonly assetCount: number | null;
  readonly companionCount: number | null;
}

export type StudioSourceSelectResult =
  | { readonly cancelled: true; readonly source?: never }
  | { readonly cancelled: false; readonly source: StudioSourceOpen };

export interface StudioHostBridge {
  readonly source: StudioHostSource;
  startHost(onEvent: (event: StudioHostStateEvent) => void): Promise<StudioHostStatus>;
  getStatus(): Promise<StudioHostStatus>;
  selectProject(mode: ProjectOpenMode): Promise<StudioProjectSelectResult>;
  selectSource(kind: SourceSelectKind): Promise<StudioSourceSelectResult>;
  startPlanOperation?(request: StudioBrandPlanStartRequest, onEvent: (event: StudioPlanOperationEvent) => void): Promise<StudioBrandPlanStartResult>;
  cancelPlanOperation?(operationHandle: string): Promise<StudioBrandPlanCancelResult>;
  shutdownHost(): Promise<void>;
  close(): void;
}

export type CandidateDisposition = "unreviewed" | "preferred" | "rejected" | "needs-revision";
export type CandidateGeometryIdentity = "nova-orbit-v1" | "nova-pulse-v1";
export type RenderBackground = "light" | "dark" | "transparent";

export interface RenderThumbnail { readonly background: RenderBackground; readonly accent: string; readonly renderIdentity: string }
export interface CandidateEvidence {
  readonly id: string; readonly name: string; readonly target: string; readonly semanticSummary: string; readonly pixelSummary: string;
  readonly geometry: CandidateGeometryIdentity;
  readonly qa: { readonly pass: number; readonly fail: number; readonly unavailable: number };
  readonly accessibilityFindings: readonly string[]; readonly paletteFindings: readonly string[];
  readonly candidateDigest: string; readonly evidenceDigest: string; readonly renders: readonly RenderThumbnail[];
}
export interface CandidateReviewFixture {
  readonly schemaVersion: 1; readonly fixtureId: string; readonly project: string; readonly brand: string;
  readonly protocolInventoryDigests: Readonly<Record<"1.0" | "1.1", string>>;
  readonly candidates: readonly [CandidateEvidence, CandidateEvidence];
}
import type { StudioBrandPlanCancelResult, StudioBrandPlanStartRequest, StudioBrandPlanStartResult, StudioPlanOperationEvent } from "../brand-plans/contracts";
