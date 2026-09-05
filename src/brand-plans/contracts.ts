export type BrandPlanMethod =
  | "brand.derive.plan"
  | "brand.qa.baseline.plan"
  | "brand.consumer.install.plan"
  | "brand.consumer.sync.plan"
  | "brand.export.plan";

export type ConsumerParameterSelection = {
  readonly profileId: string;
  readonly values: readonly { readonly parameter: string; readonly value: string }[];
};

export type StudioBrandPlanStartRequest =
  | { readonly kind: "create-derive"; readonly projectHandle: string; readonly selection: { readonly kind: "all" } | { readonly kind: "recipes"; readonly recipeIds: readonly string[] } }
  | { readonly kind: "create-qa-baseline"; readonly projectHandle: string; readonly profileId: string; readonly caseId: string }
  | { readonly kind: "create-consumer-install"; readonly projectHandle: string; readonly sourceHandles: readonly string[]; readonly profileIds: readonly string[]; readonly parameters: readonly ConsumerParameterSelection[] }
  | { readonly kind: "create-consumer-sync"; readonly projectHandle: string; readonly sourceHandles: readonly string[]; readonly profileIds?: readonly string[]; readonly parameters?: readonly ConsumerParameterSelection[] }
  | { readonly kind: "create-export"; readonly projectHandle: string; readonly profileId: string; readonly outputIds?: readonly string[] }
  | { readonly kind: "apply"; readonly planHandle: string; readonly expectedPlanDigest: string }
  | { readonly kind: "discard"; readonly planHandle: string };

export interface BrandDerivePlanSummary {
  readonly selectedRecipes: readonly string[];
  readonly transitiveRecipes: readonly string[];
  readonly affectedTargets: readonly string[];
  readonly createdCount: number;
  readonly updatedCount: number;
  readonly unchangedCount: number;
  readonly operationSummaries: readonly { readonly recipeId: string; readonly targetAssetId: string; readonly operations: readonly string[] }[];
  readonly targetStates: readonly { readonly targetAssetId: string; readonly recipeId: string; readonly state: "create" | "update" | "unchanged"; readonly oldDigest?: string; readonly newDigest: string; readonly newSvgDigest: string }[];
  readonly tokenDigest: string;
  readonly recipeDigest: string;
  readonly brandSystemDigest: string;
  readonly warnings: readonly string[];
  readonly dryRun: boolean;
}

export interface BrandQaBaselinePlanSummary {
  readonly profileId: string;
  readonly caseId: string;
  readonly baselinePath: string;
  readonly state: "create" | "update" | "rebaseline";
  readonly oldBaselineDigest: string | null;
  readonly newBaselineDigest: string;
  readonly oldQaDigest: string;
  readonly newQaDigest: string;
  readonly renderer: { readonly id: string; readonly version: string; readonly qualificationId: string; readonly platformClaim: string; readonly rendererBuildDigest: string };
  readonly assetDigests: { readonly old: string; readonly next: string };
  readonly svgDigests: { readonly old: string; readonly next: string };
  readonly brandSystemDigests: { readonly old: string; readonly next: string };
  readonly rasterDifference: { readonly changedPixels: number | null; readonly maximumChannelDelta: number | null; readonly changedBounds: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number } | null; readonly beforeDecodedPixelDigest: string | null; readonly afterDecodedPixelDigest: string };
}

export interface ConsumerPlanSummary {
  readonly operation: "install" | "sync";
  readonly packages: readonly string[];
  readonly profiles: readonly string[];
  readonly outputs: readonly { readonly kind: "asset" | "companion"; readonly packageId: string; readonly sourceId: string; readonly destination: string; readonly byteDigest: string }[];
  readonly omittedOptional: readonly string[];
  readonly lockDigest: string;
}

export interface BrandRasterExportPlanSummary {
  readonly profileId: string;
  readonly adapter: { readonly adapterId: string; readonly companionPackage: string; readonly companionVersion: string; readonly backend: "wasm" | "native"; readonly rendererPackage: string; readonly rendererVersion: string; readonly rendererBuildDigest: string; readonly nodeMajor: number; readonly platformClaim: string; readonly qualificationId: string };
  readonly outputs: readonly { readonly profileId: string; readonly outputId: string; readonly assetId: string; readonly destination: string; readonly state: "create" | "update" | "unchanged"; readonly width: number; readonly height: number; readonly purpose: string; readonly fit: string; readonly background: string; readonly alpha: string; readonly canonicalAssetDigest: string; readonly svgDigest: string; readonly profileDigest: string; readonly outputConfigDigest: string; readonly rendererBuildDigest: string; readonly pngDigest: string; readonly decodedPixelDigest: string; readonly receiptDigest: string }[];
  readonly counts: { readonly create: number; readonly update: number; readonly unchanged: number };
  readonly warnings: readonly string[];
}

export type StudioPlanSummary = BrandDerivePlanSummary | BrandQaBaselinePlanSummary | ConsumerPlanSummary | BrandRasterExportPlanSummary;

export type StudioBrandPlanStartResult =
  | { readonly kind: "ready"; readonly planHandle: string; readonly planDigest: string; readonly method: BrandPlanMethod; readonly expiresInMs: 600000; readonly summary: StudioPlanSummary; readonly projectHandle: string; readonly sourceHandles: readonly string[] }
  | { readonly kind: "applied"; readonly method: BrandPlanMethod }
  | { readonly kind: "discarded" }
  | { readonly kind: "indeterminate"; readonly method: BrandPlanMethod };

export type PlanningStage = "validate" | "snapshot" | "analyze" | "plan" | "ready";
export type ApplyStage = "revalidate" | "waiting-lock" | "staging" | "promoting" | "cleanup" | "complete";
export type StudioPlanOperationEvent = {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly operationHandle: string;
  readonly state: "started" | "progress" | "cancellation-requested";
  readonly progress?: { readonly stage: PlanningStage | ApplyStage; readonly completed: number; readonly total?: number };
};

export interface StudioBrandPlanCancelResult { readonly accepted: boolean }

export type PlanPublicState = "idle" | "planning" | "ready" | "applying" | "discarding" | "cancellation-requested" | "applied" | "discarded" | "expired" | "stale" | "cancelled" | "failed" | "indeterminate";
