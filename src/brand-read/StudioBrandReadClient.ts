export type Sha256Digest = `sha256:${string}`;
export type Page<T> = { readonly page: { readonly size: number; readonly count: number; readonly items: readonly T[]; readonly nextCursor: string | null }; readonly viewDigest: Sha256Digest };

export type BrandStatus =
  | { readonly present: false; readonly raster: { readonly available: boolean } }
  | {
    readonly present: true;
    readonly schemaVersion: 1;
    readonly brandDigest: Sha256Digest;
    readonly brandSystemDigest: Sha256Digest | null;
    readonly domains: readonly { readonly domain: string; readonly state: string; readonly digest: Sha256Digest | null }[];
    readonly counts: { readonly families: number; readonly roles: number; readonly variants: number; readonly bindings: number; readonly requirements: number; readonly tokens: number; readonly recipes: number; readonly qaProfiles: number; readonly qaCases: number; readonly qaBaselines: number; readonly consumerProfiles: number; readonly exportProfiles: number };
    readonly completeness: { readonly satisfied: boolean; readonly familyCount: number; readonly variantCount: number; readonly bindingCount: number; readonly requirementCount: number };
    readonly derived: Readonly<Record<string, number>>;
    readonly consumerLock: { readonly present: boolean; readonly status: string; readonly packages: number; readonly profiles: number; readonly mappings: number };
    readonly export: { readonly outputs: number; readonly receipts: number };
    readonly raster: { readonly available: boolean };
  };

export interface BrandVariant { readonly family: string; readonly id: string; readonly backgrounds: readonly ("any" | "light" | "dark" | "transparent")[]; readonly colorMode: "full-color" | "monochrome" | "reversed"; readonly scale: "standard" | "simplified"; readonly status: "primary" | "secondary"; readonly minimumWidthPx?: number; readonly minimumHeightPx?: number; readonly displayOrder?: number }
export interface BrandBinding { readonly family: string; readonly role: string; readonly variant: string; readonly asset: string; readonly authority: "source" | "derived"; readonly derivedState?: string }
export interface BrandRequirement { readonly family: string; readonly role: string; readonly background?: "any" | "light" | "dark" | "transparent"; readonly colorMode?: "full-color" | "monochrome" | "reversed"; readonly scale?: "standard" | "simplified" }
export interface BrandFamily { readonly id: string; readonly name: string; readonly requiredRoles: readonly string[]; readonly optionalRoles: readonly string[]; readonly variants: readonly BrandVariant[]; readonly bindings: readonly BrandBinding[]; readonly requirements: readonly BrandRequirement[]; readonly complete: boolean }
export type FamilyPage = Page<BrandFamily>;

export interface ColorToken { readonly id: string; readonly type: "color"; readonly value: string; readonly referenceCount: number; readonly recipeUseCount: number; readonly unused: boolean }
export interface GradientStop { readonly offset: number; readonly colorToken?: string; readonly color?: string }
export interface GradientToken { readonly id: string; readonly type: "gradient"; readonly kind: "linear"; readonly units: "object-bounding-box-millionth" | "user-space"; readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number; readonly stops: readonly GradientStop[]; readonly referenceCount: number; readonly recipeUseCount: number; readonly unused: boolean }
export interface DimensionToken { readonly id: string; readonly type: "dimension"; readonly unit: "px" | "percent-millionth" | "viewbox-millionth"; readonly value: number; readonly referenceCount: number; readonly recipeUseCount: number; readonly unused: boolean }
export interface OpacityToken { readonly id: string; readonly type: "opacity"; readonly value: number; readonly referenceCount: number; readonly recipeUseCount: number; readonly unused: boolean }
export type BrandToken = ColorToken | GradientToken | DimensionToken | OpacityToken;
export type TokenPage = Page<BrandToken>;

export interface RecipeNode { readonly recipeId: string; readonly sourceAsset: string; readonly targetAsset: string; readonly dependencies: readonly string[]; readonly dependents: readonly string[]; readonly operations: readonly string[]; readonly operationDigest: Sha256Digest; readonly depth: number; readonly targetState: string; readonly receiptDigest: Sha256Digest | null }
export interface RecipeGraph { readonly recipeDigest: Sha256Digest; readonly graphDigest: Sha256Digest; readonly nodes: readonly RecipeNode[]; readonly affectedTargetCount: number; readonly ownershipConflicts: number }

export type QaStatus = "pass" | "fail" | "skipped" | "unavailable" | "error";
export interface QaProfileListItem { readonly id: string; readonly renderer: "optional" | "required"; readonly formats: readonly ("html" | "json" | "markdown")[]; readonly caseCount: number; readonly semanticCaseCount: number; readonly visualCaseCount: number; readonly baselineCaseCount: number; readonly qaDigest: Sha256Digest; readonly brandSystemDigest: Sha256Digest }
export type QaProfilePage = Page<QaProfileListItem>;
export interface QaProfileDescriptor { readonly id: string; readonly renderer: "optional" | "required"; readonly formats: readonly ("html" | "json" | "markdown")[]; readonly cases: readonly string[] }
export interface QaTargetSelector { readonly asset?: string; readonly family?: string; readonly role?: string; readonly variant?: string }
export type QaCase = ({ readonly id: string } & (
  | { readonly kind: "inventory"; readonly family: string; readonly roles?: readonly string[] }
  | ({ readonly kind: "accessibility"; readonly requireConsistentLabels: boolean } & QaTargetSelector)
  | ({ readonly kind: "palette"; readonly allowedTokens: readonly string[]; readonly allowLiterals: boolean } & QaTargetSelector)
  | ({ readonly kind: "external-reference"; readonly forbidExternalUrls: boolean; readonly forbidExternalImages: boolean; readonly forbidExternalUses: boolean; readonly forbidExternalStyles: boolean; readonly forbidExternalFonts: boolean } & QaTargetSelector)
  | ({ readonly kind: "embedded-content"; readonly forbidEmbeddedRaster: boolean; readonly forbidEmbeddedFonts: boolean } & QaTargetSelector)
  | { readonly kind: "recipe"; readonly recipe?: string; readonly family?: string; readonly verifyProvenance: boolean; readonly verifyReceipts: boolean }
  | ({ readonly kind: "canvas"; readonly requireViewbox: boolean; readonly enforceMinimumSize: boolean } & QaTargetSelector)
  | ({ readonly kind: "pixel-bounds" | "transparent-bounds"; readonly sizes: readonly (readonly [number, number])[]; readonly backgrounds: readonly string[]; readonly alphaThreshold: number } & QaTargetSelector)
  | ({ readonly kind: "clipping"; readonly sizes: readonly (readonly [number, number])[]; readonly backgrounds: readonly string[]; readonly forbiddenEdgePixels: number } & QaTargetSelector)
  | ({ readonly kind: "visible-padding"; readonly sizes: readonly (readonly [number, number])[]; readonly backgrounds: readonly string[]; readonly minimumPaddingPx?: number; readonly minimumPaddingToken?: string; readonly minimumPaddingRatio?: number } & QaTargetSelector)
  | ({ readonly kind: "small-size-visibility"; readonly sizes: readonly (readonly [number, number])[]; readonly backgrounds: readonly string[]; readonly minimumVisiblePixels?: number; readonly minimumVisibleRatio?: number } & QaTargetSelector)
  | ({ readonly kind: "baseline"; readonly sizes: readonly (readonly [number, number])[]; readonly backgrounds: readonly string[]; readonly baselineDigest: Sha256Digest; readonly rendererId: string; readonly rendererVersion: string; readonly platformClaim: string; readonly canonicalAssetDigest: Sha256Digest; readonly svgDigest: Sha256Digest } & QaTargetSelector)
));
export interface QaProfile { readonly profile: QaProfileDescriptor; readonly cases: readonly QaCase[]; readonly resolvedTargetCount: number; readonly evaluationCount: number; readonly qaDigest: Sha256Digest; readonly brandSystemDigest: Sha256Digest; readonly baselines: readonly { readonly caseId: string; readonly digest: Sha256Digest | null }[]; readonly raster: { readonly available: boolean } }

export type QaJsonValue = null | boolean | number | string | readonly QaJsonValue[] | { readonly [key: string]: QaJsonValue };
export interface QaDiagnostic { readonly code: string; readonly message: string; readonly location?: string }
export interface QaEvaluation { readonly target: { readonly assetId: string; readonly family?: string; readonly role?: string; readonly variant?: string }; readonly width?: number; readonly height?: number; readonly background?: string; readonly status: QaStatus; readonly measurements: Readonly<Record<string, QaJsonValue>>; readonly diagnostics: readonly QaDiagnostic[] }
export interface QaCaseResult { readonly caseId: string; readonly kind: string; readonly status: QaStatus; readonly capability: "semantic-core-v1" | "renderer"; readonly capabilityRequired: boolean; readonly measurements: Readonly<Record<string, QaJsonValue>>; readonly diagnostics: readonly QaDiagnostic[]; readonly evaluations: readonly QaEvaluation[] }
export interface QaResult { readonly schema: "tfsb.brand-qa-result"; readonly schemaVersion: 1; readonly profileId: string; readonly qaDigest: Sha256Digest; readonly brandSystemDigest: Sha256Digest; readonly status: QaStatus; readonly exitCode: 0 | 1 | 2 | 3; readonly counts: { readonly pass: number; readonly fail: number; readonly skipped: number; readonly unavailable: number; readonly error: number }; readonly renderer?: { readonly id: string; readonly version: string; readonly qualificationId: string; readonly platformClaim: string }; readonly results: readonly QaCaseResult[]; readonly resultDigest: Sha256Digest }

export type DiffValue = null | boolean | number | string | readonly DiffValue[] | { readonly [key: string]: DiffValue };
export interface DiffChange { readonly id: string; readonly change: "added" | "removed" | "changed"; readonly before: DiffValue | null; readonly after: DiffValue | null }
export interface SemanticDiff { readonly diff: { readonly schema: "tfsb.brand-diff"; readonly schemaVersion: 1; readonly beforeDigest: Sha256Digest; readonly afterDigest: Sha256Digest; readonly status: "equal" | "changed"; readonly inventory: { readonly families: readonly DiffChange[]; readonly roles: readonly DiffChange[]; readonly variants: readonly DiffChange[]; readonly requirements: readonly DiffChange[]; readonly completeness: DiffChange | null }; readonly bindings: { readonly records: readonly DiffChange[] }; readonly tokens: { readonly records: readonly DiffChange[] }; readonly recipes: { readonly records: readonly DiffChange[]; readonly affectedTargets: readonly string[] }; readonly derived: { readonly records: readonly DiffChange[] }; readonly geometry: { readonly records: readonly DiffChange[]; readonly canonicalTypedGeometryChanged: boolean; readonly equivalenceClaim: "none" }; readonly qaImpact: { readonly profiles: readonly DiffChange[]; readonly cases: readonly DiffChange[]; readonly affectedCases: readonly string[] }; readonly packageAndLegal: { readonly package: DiffChange | null; readonly companions: readonly DiffChange[]; readonly bundleRelevantChanged: boolean }; readonly consumerProfiles: { readonly beforeState: string; readonly afterState: string; readonly status: "available" | "unavailable"; readonly records: readonly DiffChange[] }; readonly exports: { readonly beforeState: string; readonly afterState: string; readonly status: "available" | "unavailable"; readonly records: readonly DiffChange[] }; readonly resultDigest: Sha256Digest }; readonly beforeBindingDigest: Sha256Digest; readonly afterBindingDigest: Sha256Digest; readonly visualDiff: { readonly available: boolean } }

export interface ConsumerParameter { readonly id: string; readonly values: readonly string[] }
export interface ConsumerRule { readonly asset?: string; readonly companion?: string; readonly family?: string; readonly role?: string; readonly variant?: string; readonly destination?: string; readonly destinationDirectory?: string; readonly filenamePolicy?: "asset-id.svg" | "source-basename"; readonly requirement: "required" | "optional"; readonly collision: "error"; readonly when: readonly { readonly parameter: string; readonly equals: string }[] }
export interface ConsumerProfile { readonly id: string; readonly qualifiedId: string; readonly version: number; readonly compatiblePackage: string; readonly minimumBrandVersion?: string; readonly maximumBrandVersionExclusive?: string; readonly composes: readonly string[]; readonly parameters: readonly ConsumerParameter[]; readonly outputs: readonly ConsumerRule[] }
export interface ConsumerProfileItem { readonly qualifiedProfileId: string; readonly authorityKind: "producer-project" | "producer-package" | "consumer-local"; readonly packageId: string; readonly profile: ConsumerProfile; readonly outputRuleCount: number; readonly resolvedOutputCount: number | null }
export type ConsumerProfilePage = Page<ConsumerProfileItem>;
export interface ConsumerLockStatus { readonly status: "ok" | "source-unavailable" | "stale" | "drift" | "collision" | "invalid"; readonly exitCode: 0 | 1 | 2; readonly lockDigest?: Sha256Digest; readonly consumerProjectDigest?: Sha256Digest; readonly packages: readonly { readonly packageId: string; readonly brandVersion: string; readonly sourceKind: "local-bundle" | "npm-installed"; readonly profiles: readonly { readonly id: string; readonly version: number; readonly digest: Sha256Digest; readonly parameters: Readonly<Record<string, string>> }[] }[]; readonly mappings: readonly { readonly packageId: string; readonly kind: "asset" | "companion"; readonly sourceId: string; readonly destination: string; readonly expectedDigest: Sha256Digest; readonly current: "exact" | "missing" | "different" | "unsafe" }[]; readonly localProfiles: readonly string[] }

export type ExportCapability = { readonly available: false } | { readonly available: true; readonly adapterId: "resvg-png-v1"; readonly rendererPackage: string; readonly rendererVersion: string; readonly rendererBuildDigest: Sha256Digest; readonly nodeMajor: 22; readonly platformClaim: "darwin-arm64"; readonly qualificationId: string };
export interface ExportStatus { readonly profileId: string; readonly outputId: string; readonly assetId: string | null; readonly binding: { readonly family: string; readonly role: string; readonly variant: string } | null; readonly destination: string; readonly state: string; readonly width: number | null; readonly height: number | null; readonly purpose: string | null; readonly background: string | null; readonly alpha: "straight" | "opaque" | null; readonly canonicalAssetDigest: Sha256Digest | null; readonly svgDigest: Sha256Digest | null; readonly profileDigest: Sha256Digest | null; readonly outputConfigDigest: Sha256Digest | null; readonly pngDigest: Sha256Digest | null; readonly decodedPixelDigest: Sha256Digest | null; readonly receiptDigest: Sha256Digest | null; readonly capabilityAvailable: boolean }
export type ExportStatusPage = Page<ExportStatus>;

export type VisualRole = "current" | "baseline" | "before" | "after";
export interface VisualArtifact { readonly role: VisualRole; readonly mediaType: "image/png"; readonly encoding: "base64"; readonly width: number; readonly height: number; readonly byteLength: number; readonly pngDigest: Sha256Digest; readonly decodedPixelDigest: Sha256Digest; readonly bytesBase64: string }
export interface VisualEvidence { readonly schema: "tfsb.studio-visual-evidence"; readonly schemaVersion: 1; readonly kind: "project-render" | "qa-baseline" | "brand-diff"; readonly projectDigest: Sha256Digest; readonly brandSystemDigest: Sha256Digest; readonly sourceDigest?: Sha256Digest; readonly qaDigest?: Sha256Digest; readonly target: { readonly assetId: string; readonly canonicalAssetDigest: Sha256Digest; readonly svgDigest: Sha256Digest; readonly binding?: { readonly family: string; readonly role: string; readonly variant: string } }; readonly configuration: { readonly width: number; readonly height: number; readonly background: string }; readonly renderer: { readonly id: string; readonly version: string; readonly qualificationId: string; readonly platformClaim: string }; readonly artifacts: readonly VisualArtifact[]; readonly difference?: { readonly changedPixels: number; readonly maximumChannelDelta: number; readonly changedBounds: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number } | null; readonly claim: "pixel-equal-for-this-renderer-and-case-only" | "pixel-different-for-this-renderer-and-case-only" }; readonly evidenceDigest: Sha256Digest }
export type VisualTarget = { readonly kind: "asset"; readonly assetId: string } | { readonly kind: "binding"; readonly family: string; readonly role: string; readonly variant: string };
export interface AssetIdentity { readonly assetId: string; readonly canonicalAssetDigest: Sha256Digest; readonly svgDigest: Sha256Digest }
export type VisualEvidenceRequest =
  | { readonly kind: "project-render"; readonly projectHandle: string; readonly target: VisualTarget; readonly width: number; readonly height: number; readonly background: string }
  | { readonly kind: "qa-baseline"; readonly projectHandle: string; readonly profileId: string; readonly caseId: string }
  | { readonly kind: "brand-diff"; readonly projectHandle: string; readonly sourceHandle: string; readonly target: VisualTarget; readonly width: number; readonly height: number; readonly background: string };

export interface StudioBrandReadClient {
  getAssetIdentity(projectHandle: string, assetId: string): Promise<AssetIdentity>;
  getBrandStatus(projectHandle: string): Promise<BrandStatus>;
  listFamilies(projectHandle: string, pageSize: number, cursor?: string): Promise<FamilyPage>;
  listTokens(projectHandle: string, pageSize: number, cursor?: string): Promise<TokenPage>;
  getRecipeGraph(projectHandle: string): Promise<RecipeGraph>;
  listQaProfiles(projectHandle: string, pageSize: number, cursor?: string): Promise<QaProfilePage>;
  getQaProfile(projectHandle: string, profileId: string): Promise<QaProfile>;
  getQaResult(projectHandle: string, profileId: string): Promise<QaResult>;
  getSemanticDiff(projectHandle: string, sourceHandle: string): Promise<SemanticDiff>;
  listConsumerProfiles(projectHandle: string, sourceHandles: readonly string[], pageSize: number, cursor?: string): Promise<ConsumerProfilePage>;
  getConsumerLockStatus(projectHandle: string): Promise<ConsumerLockStatus>;
  getExportCapability(projectHandle: string): Promise<ExportCapability>;
  listExportStatus(projectHandle: string, pageSize: number, cursor?: string): Promise<ExportStatusPage>;
  getVisualEvidence(request: VisualEvidenceRequest): Promise<VisualEvidence>;
}
