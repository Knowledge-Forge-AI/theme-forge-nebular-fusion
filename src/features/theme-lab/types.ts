export interface ThemePaletteAccent {
  base: string;
  low: string;
  high: string;
}

export interface ThemePaletteNeutrals {
  bg: string;
  bgNav: string;
  bgSidebar: string;
  bgInlineCode: string;
  bgAccent: string;
  text: string;
  textAccent: string;
  textInvert: string;
  hairline: string;
  hairlineLight: string;
  hairlineShade: string;
}

export interface ThemePaletteGrays {
  gray1: string;
  gray2: string;
  gray3: string;
  gray4: string;
  gray5: string;
  gray6: string;
  gray7: string;
}

export interface ThemePalette {
  accent: ThemePaletteAccent;
  neutrals: ThemePaletteNeutrals;
  grays: ThemePaletteGrays;
}

export interface ThemeColors {
  dark: ThemePalette;
  light: ThemePalette;
}

export interface ThemeTypography {
  bodyFont: string;
  codeFont: string;
  baseFontSize?: string | undefined;
  lineHeight?: number | undefined;
}

export interface ThemeLayout {
  contentWidth: string;
  sidebarWidth: string;
}

export interface ThemeSpecification {
  $schema?: string | undefined;
  name: string;
  version: string;
  schemaVersion: string;
  adapter: string;
  colors: ThemeColors;
  typography: ThemeTypography;
  layout: ThemeLayout;
}

export interface ThemeDescriptorProvenance {
  categories: readonly string[];
  compiler: string;
  compilerVersion: string;
}

export interface ThemeDescriptor {
  schema: string;
  schemaVersion: number;
  themeSchemaVersion: string;
  themeName: string;
  themeVersion: string;
  adapter: string;
  inputDigest: string;
  outputDigest: string;
  cssFile: string;
  provenance: ThemeDescriptorProvenance;
}

export interface ContrastDiagnostic {
  severity: string;
  code: string;
  role: string;
  mode: string;
  element: string;
  foreground: string;
  background: string;
  ratio: number;
  displayRatio: string;
  criterion: string;
  threshold: number;
  disposition: string;
  message: string;
}

export interface ThemeLabError {
  code: string;
  message: string;
  fieldPath?: string | undefined;
}

export interface ThemeLabStatusResponse {
  available: boolean;
  compilerVersion: string;
  sessionId?: string | undefined;
  latestRevision?: number | undefined;
  message?: string | undefined;
  dirty?: boolean | undefined;
  adoptedThemeDigest?: string | undefined;
}

export interface ThemeLabCompileRequest {
  uiRevision?: number | undefined;
  sessionId?: string | undefined;
  specification: ThemeSpecification;
  options?: {
    strictContrast?: boolean | undefined;
  } | undefined;
}

export interface ThemeLabCompileResponse {
  uiRevision: number;
  valid: boolean;
  compiledCss?: string | undefined;
  descriptor?: ThemeDescriptor | undefined;
  diagnostics: readonly ContrastDiagnostic[];
  error?: ThemeLabError | string | undefined;
}

export interface ThemeLabExampleResponse {
  uiRevision: number;
  valid: boolean;
  exampleName: string;
  specification?: ThemeSpecification | undefined;
  compiledCss?: string | undefined;
  descriptor?: ThemeDescriptor | undefined;
  diagnostics: readonly ContrastDiagnostic[];
  error?: ThemeLabError | string | undefined;
}

export interface ThemeLabOpenResponse {
  cancelled: boolean;
  displayName?: string | undefined;
  specification?: ThemeSpecification | undefined;
  compiledCss?: string | undefined;
  descriptor?: ThemeDescriptor | undefined;
  diagnostics: readonly ContrastDiagnostic[];
  error?: ThemeLabError | string | undefined;
}

export interface ThemeLabSaveRequest {
  saveAs: boolean;
  specification: ThemeSpecification;
}

export interface ThemeLabSaveResponse {
  cancelled: boolean;
  displayName?: string | undefined;
}

// ---------------------------------------------------------------------------
// Design Exchange Protocol Types (TFSB53E-R1)
// ---------------------------------------------------------------------------

export type ThemeExchangePacketKind = "brief" | "candidate" | "review";

export interface ThemeVisualRecord {
  readonly schema: "tfsl.theme-visual-evidence";
  readonly schemaVersion: 1;
  readonly presence: "included" | "absent" | "unavailable";
  readonly reason?: string | undefined;
  readonly pngDigest?: string | undefined;
  readonly bytesBase64?: string | undefined;
  readonly byteCount?: number | undefined;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly mode?: "dark" | "light" | undefined;
  readonly viewport?: "desktop" | "mobile" | undefined;
  readonly themeDigest?: string | undefined;
  readonly fixtureId?: string | undefined;
  readonly evidenceDigest: string;
}

export type ThemeAnnotationTarget =
  | { readonly kind: "field"; readonly fieldPath: string; readonly mode?: "dark" | "light" | undefined }
  | { readonly kind: "visual"; readonly evidenceDigest: string; readonly pngDigest: string; readonly region: readonly [number, number, number, number] };

export type ThemeAnnotationCategory =
  | "contrast"
  | "color"
  | "typography"
  | "layout"
  | "brand-fit"
  | "accessibility"
  | "other";

export type ThemeAnnotationSeverity = "note" | "minor" | "substantive" | "blocking";

export interface ThemeAnnotation {
  readonly annotationId: string;
  readonly candidateDigest: string;
  readonly target: ThemeAnnotationTarget;
  readonly category: ThemeAnnotationCategory;
  readonly severity: ThemeAnnotationSeverity;
  readonly comment: string;
}

export type ThemeCandidateDisposition =
  | "unreviewed"
  | "preferred"
  | "approved"
  | "rejected"
  | "needs-revision"
  | "deferred";

export type ThemeReviewOverallDisposition =
  | { readonly kind: "no-decision" }
  | { readonly kind: "rejected-all" }
  | { readonly kind: "preferred" | "approved" | "needs-revision"; readonly candidateDigest: string };

export interface ThemeBriefPacket {
  readonly schema: "tfsl.theme-brief";
  readonly schemaVersion: 1;
  readonly briefId: string;
  readonly title: string;
  readonly goal: string;
  readonly baselineTheme: ThemeSpecification;
  readonly themeDigest: string;
  readonly compilerVersion: string;
  readonly adapter: string;
  readonly allowedFields: readonly string[];
  readonly allowedModes: readonly ("dark" | "light")[];
  readonly approvedTemplates: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly prohibitedChanges: readonly string[];
  readonly visualEvidence: readonly ThemeVisualRecord[];
  readonly metadata?: {
    readonly author?: string | undefined;
    readonly timestamp?: string | undefined;
  } | undefined;
  readonly briefDigest: string;
}

export interface ThemeCandidatePacket {
  readonly schema: "tfsl.theme-candidate";
  readonly schemaVersion: 1;
  readonly candidateId: string;
  readonly briefDigest: string;
  readonly theme: ThemeSpecification;
  readonly themeDigest: string;
  readonly rationale: string;
  readonly packageMetadata?: Record<string, unknown> | undefined;
  readonly claimedProvenance?: {
    readonly author?: string | undefined;
    readonly toolName?: string | undefined;
    readonly toolVersion?: string | undefined;
    readonly timestamp?: string | undefined;
  } | undefined;
  readonly claimedDiagnostics?: readonly ContrastDiagnostic[] | undefined;
  readonly claimedCssDigest?: string | undefined;
  readonly visualEvidence: readonly ThemeVisualRecord[];
  readonly candidateDigest: string;
}

export interface ThemeReviewPacket {
  readonly schema: "tfsl.theme-review";
  readonly schemaVersion: 1;
  readonly reviewId: string;
  readonly briefDigest: string;
  readonly candidateDigests: readonly string[];
  readonly dispositions: readonly {
    readonly candidateDigest: string;
    readonly disposition: ThemeCandidateDisposition;
    readonly comment?: string | undefined;
  }[];
  readonly annotations: readonly ThemeAnnotation[];
  readonly overallDisposition: ThemeReviewOverallDisposition;
  readonly summary: string;
  readonly reviewDigest: string;
}

export interface ThemeBriefCreateInput {
  readonly briefId: string;
  readonly title: string;
  readonly goal: string;
  readonly baselineTheme: ThemeSpecification;
  readonly allowedFields?: readonly string[] | undefined;
  readonly allowedModes?: readonly ("dark" | "light")[] | undefined;
  readonly approvedTemplates?: readonly string[] | undefined;
  readonly acceptanceCriteria?: readonly string[] | undefined;
  readonly prohibitedChanges?: readonly string[] | undefined;
  readonly visualEvidence?: readonly ThemeVisualRecord[] | undefined;
  readonly metadata?: {
    readonly author?: string | undefined;
    readonly timestamp?: string | undefined;
  } | undefined;
  readonly adapter?: string | undefined;
}

export interface ThemeReviewCreateInput {
  readonly reviewId: string;
  readonly brief: ThemeBriefPacket | string;
  readonly candidateDigests: readonly string[];
  readonly dispositions: readonly {
    readonly candidateDigest: string;
    readonly disposition: ThemeCandidateDisposition;
    readonly comment?: string | undefined;
  }[];
  readonly annotations?: readonly ThemeAnnotation[] | undefined;
  readonly overallDisposition: ThemeReviewOverallDisposition;
  readonly summary: string;
}

export interface ThemeCandidateVerificationResult {
  readonly valid: boolean;
  readonly candidateId: string;
  readonly candidateDigest: string;
  readonly briefDigest: string;
  readonly themeDigest: string;
  readonly computedCssDigest?: string | undefined;
  readonly diagnostics: readonly ContrastDiagnostic[];
  readonly constraintViolations: readonly string[];
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

export interface ThemeReviewValidationResult {
  readonly valid: boolean;
  readonly reviewId: string;
  readonly reviewDigest: string;
  readonly briefDigest: string;
  readonly candidateMatches: boolean;
  readonly dispositionMatches: boolean;
  readonly annotationErrors: readonly string[];
  readonly errors: readonly string[];
}

// ---------------------------------------------------------------------------
// Bridge Requests and Responses
// ---------------------------------------------------------------------------

export interface ThemeBriefCreateRequest {
  briefInput: ThemeBriefCreateInput | Record<string, unknown>;
}

export interface ThemeBriefCreateResponse {
  packet: Record<string, unknown>;
  canonicalJson: string;
  digest: string;
}

export interface ThemePacketImportRequest {
  expectedKind?: string | undefined;
}

export interface ThemePacketImportResponse {
  displayName?: string | undefined;
  cancelled: boolean;
  packet?: Record<string, unknown> | undefined;
  canonicalJson?: string | undefined;
  kind?: string | undefined;
  digest?: string | undefined;
  error?: ThemeLabError | string | undefined;
}

export interface ThemePacketExportRequest {
  packetJson: string;
  defaultName?: string | undefined;
}

export interface ThemePacketExportResponse {
  displayName?: string | undefined;
  cancelled: boolean;
  saved: boolean;
  digest?: string | undefined;
  error?: ThemeLabError | string | undefined;
}

export interface ThemeReviewCreateRequest {
  reviewInput: ThemeReviewCreateInput | Record<string, unknown>;
}

export interface ThemeReviewCreateResponse {
  packet: Record<string, unknown>;
  canonicalJson: string;
  digest: string;
}

export interface ThemeCandidateAdoptRequest {
  candidate: string;
  brief: string;
  sessionId: string;
  uiRevision: number;
  options?: { strictContrast?: boolean | undefined } | undefined;
  force?: boolean | undefined;
}

export interface ThemeCandidateAdoptResponse {
  adopted: boolean;
  requiresConfirmation?: boolean | undefined;
  specification?: ThemeSpecification | undefined;
  compiledCss?: string | undefined;
  descriptor?: ThemeDescriptor | undefined;
  diagnostics?: readonly ContrastDiagnostic[] | undefined;
  error?: ThemeLabError | string | undefined;
}

export interface ThemeCandidateVerifyRequest {
  candidate: string; // JSON.stringify(packet)
  brief?: string | undefined; // JSON.stringify(brief)
  options?: {
    strictContrast?: boolean | undefined;
  } | undefined;
}

export interface ThemeCandidateVerifyResponse {
  valid: boolean;
  compiledCss?: string | undefined;
  descriptor?: ThemeDescriptor | undefined;
  diagnostics?: readonly ContrastDiagnostic[] | undefined;
  candidateVerification?: ThemeCandidateVerificationResult | undefined;
  error?: ThemeLabError | string | undefined;
}

export interface ThemeReviewValidateRequest {
  review: string; // JSON.stringify(review)
  brief?: string | undefined; // JSON.stringify(brief)
  candidates?: readonly string[] | undefined; // candidates.map(JSON.stringify)
}

export interface ThemeReviewValidateResponse {
  valid: boolean;
  reviewValidation?: ThemeReviewValidationResult | undefined;
  error?: ThemeLabError | string | undefined;
}

import type {
  ThemeSpecificationV2,
  ThemeDescriptorV2,
  ThemeV2CompileResponse,
  ThemeDocumentOpenResponse,
  ThemeV2CompileRequest,
  ThemeDocumentOpenRequest,
  ThemeDocumentSaveRequest,
  ThemeDraftUpdateRequest,
  ThemeDraftUpdateResponse,
  ThemeV2StyleFile,
} from "./v2-bridge";

export type {
  ThemeSpecificationV2,
  ThemeDescriptorV2,
  ThemeV2CompileResponse,
  ThemeDocumentOpenResponse,
  ThemeV2CompileRequest,
  ThemeDocumentOpenRequest,
  ThemeDocumentSaveRequest,
  ThemeDraftUpdateRequest,
  ThemeDraftUpdateResponse,
  ThemeV2StyleFile,
};

export interface ThemeLabBridge {
  getStatus(): Promise<ThemeLabStatusResponse>;
  compile(request: ThemeLabCompileRequest): Promise<ThemeLabCompileResponse>;
  loadExample(name: string, uiRevision?: number, sessionId?: string): Promise<ThemeLabExampleResponse>;
  openTheme(): Promise<ThemeLabOpenResponse>;
  saveTheme(request: ThemeLabSaveRequest): Promise<ThemeLabSaveResponse>;
  createBrief?(request: ThemeBriefCreateRequest): Promise<ThemeBriefCreateResponse>;
  importPacket?(request?: ThemePacketImportRequest): Promise<ThemePacketImportResponse>;
  exportPacket?(request: ThemePacketExportRequest): Promise<ThemePacketExportResponse>;
  createReview?(request: ThemeReviewCreateRequest): Promise<ThemeReviewCreateResponse>;
  adoptCandidate?(request: ThemeCandidateAdoptRequest): Promise<ThemeCandidateAdoptResponse>;
  verifyThemeCandidate?(request: ThemeCandidateVerifyRequest): Promise<ThemeCandidateVerifyResponse>;
  validateThemeReview?(request: ThemeReviewValidateRequest): Promise<ThemeReviewValidateResponse>;
  dispose?: () => Promise<void>;

  // TFSB63B v2 methods
  compileV2?(request: {
    specification: ThemeSpecificationV2;
    uiRevision: number;
    sessionId?: string | undefined;
    options?: {
      accent?: string | undefined;
      strictContrast?: boolean | undefined;
    } | undefined;
  }): Promise<ThemeV2CompileResponse>;

  openDocument?(request?: {
    uiRevision?: number | undefined;
    sessionId?: string | undefined;
  } | undefined): Promise<ThemeDocumentOpenResponse>;

  saveDocument?(request: {
    saveAs: boolean;
    specification: ThemeSpecification | ThemeSpecificationV2;
    uiRevision: number;
    sessionId?: string | undefined;
  }): Promise<ThemeLabSaveResponse>;

  updateDraft?(request: {
    sessionId: string;
    uiRevision: number;
  }): Promise<{ uiRevision: number }>;

  // TFSB63B/V2 Design Exchange methods
  verifyCandidateV2?(request: ThemeCandidateVerifyRequestV2): Promise<ThemeCandidateVerifyResponseV2>;
  adoptCandidateV2?(request: ThemeCandidateAdoptRequestV2): Promise<ThemeCandidateAdoptResponseV2>;
}

// ---------------------------------------------------------------------------
// V2 Design Exchange Types
// ---------------------------------------------------------------------------

export type ThemeReviewDispositionV2 = "approve" | "revise" | "reject";

export interface ThemeReviewContextV1 {
  readonly schema: "tfsb.theme-review-context-v1";
  readonly schemaVersion: 1;
  readonly brief: {
    readonly title: string;
    readonly goal: string;
  };
  readonly candidateDigest: string;
  readonly disposition: ThemeReviewDispositionV2;
  readonly summary: string;
}

export interface ThemeCandidateVerificationResultV2 {
  readonly schema: "tfsb.theme-candidate-verification-v2";
  readonly schemaVersion: 2;
  readonly valid: boolean;
  readonly candidateId: string;
  readonly candidateDigest: string;
  readonly inputDigest: string;
  readonly outputDigest: string;
  readonly descriptor?: ThemeDescriptorV2 | undefined;
  readonly styles?: readonly ThemeV2StyleFile[] | undefined;
  readonly compiledCss?: string | undefined;
  readonly diagnostics: readonly ContrastDiagnostic[];
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

export interface ThemeCandidateVerifyRequestV2 {
  candidate: string;
  brief?: string | undefined;
  sessionId?: string | undefined;
  uiRevision?: number | undefined;
  options?: {
    strictContrast?: boolean | undefined;
    accent?: string | undefined;
  } | undefined;
}

export interface ThemeCandidateVerifyResponseV2 {
  valid: boolean;
  candidateVerification?: ThemeCandidateVerificationResultV2 | undefined;
  compiledCss?: string | undefined;
  descriptor?: ThemeDescriptorV2 | undefined;
  styles?: readonly ThemeV2StyleFile[] | undefined;
  diagnostics?: readonly ContrastDiagnostic[] | undefined;
  error?: ThemeLabError | string | undefined;
  uiRevision?: number | undefined;
}

export interface ThemeCandidateAdoptRequestV2 {
  candidate: string;
  brief: string;
  sessionId: string;
  uiRevision: number;
  options?: {
    strictContrast?: boolean | undefined;
    accent?: string | undefined;
  } | undefined;
  force?: boolean | undefined;
}

export interface ThemeCandidateAdoptResponseV2 {
  adopted: boolean;
  requiresConfirmation?: boolean | undefined;
  specification?: ThemeSpecificationV2 | undefined;
  specificationV2?: ThemeSpecificationV2 | undefined;
  descriptor?: ThemeDescriptorV2 | undefined;
  styles?: readonly ThemeV2StyleFile[] | undefined;
  compiledCss?: string | undefined;
  css?: string | undefined;
  diagnostics?: readonly ContrastDiagnostic[] | undefined;
  error?: ThemeLabError | string | undefined;
}
