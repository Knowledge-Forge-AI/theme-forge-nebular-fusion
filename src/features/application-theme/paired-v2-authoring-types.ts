import type { PairedProfileV2Document } from "./types";

export const PAIRED_V2_LIMITS = {
  sourceBytes: 131_072,
  sourceBase64Chars: 175_104,
  profileJsonBytes: 262_144,
  targetCssBytes: 262_144,
  applicationAppearanceCssBytes: 524_288,
  applicationExtensionBytes: 65_536,
  mappingReportBytes: 245_760,
  diagnosticsBytes: 32_768,
  responseBytes: 2_097_152,
  editEntries: 64,
  diagnosticEntries: 256,
  stringValueChars: 500,
  errorMessageChars: 2_048,
} as const;

export const PAIRED_V2_COLOR_MODES = ["light", "dark"] as const;
export type PairedV2ColorMode = (typeof PAIRED_V2_COLOR_MODES)[number];

export const PAIRED_V2_COLOR_ROLES = [
  "canvas",
  "canvasText",
  "surface",
  "surfaceText",
  "elevatedSurface",
  "elevatedSurfaceText",
  "primaryAction",
  "primaryActionText",
  "secondaryAction",
  "secondaryActionText",
  "mutedSurface",
  "mutedText",
  "highlight",
  "highlightText",
  "danger",
  "dangerText",
  "border",
  "fieldBorder",
  "focus",
  "hover",
  "active",
  "selection",
  "selectionText",
] as const;
export type PairedV2ColorRole = (typeof PAIRED_V2_COLOR_ROLES)[number];

export const PAIRED_V2_TYPOGRAPHY_ROLES = ["body", "heading", "ui", "code"] as const;
export type PairedV2TypographyRole = (typeof PAIRED_V2_TYPOGRAPHY_ROLES)[number];

export const PAIRED_V2_RADIUS_ROLES = ["control", "surface", "overlay"] as const;
export type PairedV2RadiusRole = (typeof PAIRED_V2_RADIUS_ROLES)[number];

export type PairedV2ColorEditPath = string;
export type PairedV2TypographyEditPath = string;
export type PairedV2RadiusEditPath = string;
export type PairedV2ClearOptionalPath = string;
export type PairedV2EditPath =
  | PairedV2ColorEditPath
  | PairedV2TypographyEditPath
  | PairedV2RadiusEditPath;

export interface PairedV2SetColorEdit {
  readonly kind: "set-color";
  readonly path: PairedV2ColorEditPath;
  readonly value: string;
}

export interface PairedV2SetTypographyEdit {
  readonly kind: "set-typography";
  readonly path: PairedV2TypographyEditPath;
  readonly value: string | number;
}

export interface PairedV2SetRadiusEdit {
  readonly kind: "set-radius";
  readonly path: PairedV2RadiusEditPath;
  readonly value: string;
}

export interface PairedV2ClearOptionalEdit {
  readonly kind: "clear-optional";
  readonly path: PairedV2ClearOptionalPath;
}

export type PairedV2Edit =
  | PairedV2SetColorEdit
  | PairedV2SetTypographyEdit
  | PairedV2SetRadiusEdit
  | PairedV2ClearOptionalEdit;

export type PairedV2EditMap = Readonly<Record<string, PairedV2Edit>>;

export type PairedV2SourceReference =
  | {
      readonly documentId: string;
      readonly expectedRawSourceSha256: string;
      readonly expectedCanonicalDigest: string;
    }
  | {
      readonly rawSourceBase64: string;
      readonly expectedRawSourceSha256: string;
      readonly expectedCanonicalDigest: string;
    };

export interface PairedV2CompileRequest {
  readonly source: PairedV2SourceReference;
  readonly edits: readonly PairedV2Edit[];
  readonly uiRevision: number;
  readonly sessionId: string;
}

export type PairedV2Status = "success" | "partial" | "stale" | "cancelled" | "error";
export type PairedV2VerificationStatus = "verified" | "transformed";
export type PairedV2MappingClassification =
  | "consumed"
  | "normalized"
  | "overridden"
  | "target-specific"
  | "unsupported"
  | "generated-default";

export type PairedV2JsonPrimitive = string | number | boolean | null;
export type PairedV2JsonValue =
  | PairedV2JsonPrimitive
  | PairedV2JsonValue[]
  | { [key: string]: PairedV2JsonValue };

export interface PairedV2Diagnostic {
  readonly severity: "error" | "warning" | "info";
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export interface PairedV2MappingEntry {
  readonly sourcePath: string;
  readonly sourceValue?: PairedV2JsonValue;
  readonly classification: PairedV2MappingClassification;
  readonly reason?: string;
  readonly targetPath?: string;
  readonly targetValue?: PairedV2JsonValue;
}

export interface PairedV2ApplicationMappingEntry {
  readonly sourcePath: string;
  readonly target: string;
  readonly value: PairedV2JsonValue;
}

export interface PairedV2MappingGroup {
  readonly group: string;
  readonly applicable: boolean;
  readonly reason: string;
}

export interface PairedV2MappingDefault {
  readonly targetPath: string;
  readonly targetValue: PairedV2JsonValue;
  readonly reason: string;
}

export interface PairedV2MappingSummary {
  readonly totalSemanticLeaves: number;
  readonly consumed: number;
  readonly normalized: number;
  readonly overridden: number;
  readonly targetSpecific: number;
  readonly unsupported: number;
  readonly generatedDefaultsCount: number;
}

export interface PairedV2AdapterIdentity {
  readonly name: string;
  readonly version: string;
}

export interface PairedV2MappingReport {
  readonly schema: "tf-paired-mapping-report-v2";
  readonly target: string;
  readonly profileName: string;
  readonly profileVersion: string;
  readonly sourceSha256: string;
  readonly sourceVerification: "source-bytes";
  readonly canonicalDigest: string;
  readonly adapter: PairedV2AdapterIdentity;
  readonly compiler: PairedV2AdapterIdentity;
  readonly options: PairedV2JsonValue;
  readonly entries: readonly PairedV2MappingEntry[];
  readonly groups: readonly PairedV2MappingGroup[];
  readonly defaults: readonly PairedV2MappingDefault[];
  readonly summary: PairedV2MappingSummary;
  readonly digest: string;
}

export interface PairedV2ApplicationMappingReport {
  readonly schema: "theme-forge.application-appearance-extension.v1";
  readonly entries: readonly PairedV2ApplicationMappingEntry[];
  readonly scope: string;
}

export interface PairedV2TargetResult {
  readonly valid: boolean;
  readonly compiledCss?: string;
  readonly diagnostics: readonly PairedV2Diagnostic[];
  readonly mappingReport: PairedV2MappingReport;
  readonly sourceProfileSha256: string;
  readonly canonicalDigest: string;
}

export interface PairedV2ApplicationAppearanceResult {
  readonly valid: boolean;
  readonly compiledCss: string;
  readonly sourceProfileSha256: string;
  readonly canonicalDigest: string;
}

export interface PairedV2ApplicationExtensionResult {
  readonly valid: boolean;
  readonly compiledCss?: string;
  readonly diagnostics: readonly PairedV2Diagnostic[];
  readonly mappingReport: PairedV2ApplicationMappingReport;
  readonly sourceProfileSha256: string;
  readonly canonicalDigest: string;
}

export interface PairedV2Draft {
  readonly profile: PairedProfileV2Document;
  readonly sourceBytesBase64: string;
  readonly rawSourceSha256: string;
  readonly canonicalDigest: string;
  readonly baselineRawSourceSha256: string;
  readonly baselineCanonicalDigest: string;
  readonly verificationStatus: PairedV2VerificationStatus;
  readonly isTransformed: boolean;
  readonly parentSourceSha256?: string;
}

export interface PairedV2Error {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export interface PairedV2SuccessfulCompileResponse {
  readonly status: "success" | "partial";
  readonly valid: true;
  readonly uiRevision: number;
  readonly sessionId: string;
  readonly draft: PairedV2Draft;
  readonly solarSail: PairedV2TargetResult;
  readonly stellarLoom: PairedV2TargetResult;
  readonly applicationExtension: PairedV2ApplicationExtensionResult;
  readonly applicationAppearance: PairedV2ApplicationAppearanceResult;
  readonly diagnostics: readonly PairedV2Diagnostic[];
}

export interface PairedV2FailedCompileResponse {
  readonly status: "stale" | "cancelled" | "error";
  readonly valid: false;
  readonly uiRevision: number;
  readonly sessionId: string;
  readonly draft?: never;
  readonly solarSail: null;
  readonly stellarLoom: null;
  readonly applicationExtension: null;
  readonly applicationAppearance: null;
  readonly diagnostics: readonly PairedV2Diagnostic[];
  readonly error?: PairedV2Error;
}

export type PairedV2CompileResponse =
  | PairedV2SuccessfulCompileResponse
  | PairedV2FailedCompileResponse;

export interface PairedV2SavedDocument {
  readonly documentId: string;
  readonly rawSourceSha256: string;
  readonly canonicalDigest: string;
  readonly displayName: string;
}

export interface PairedV2SaveRequest {
  readonly sessionId: string;
  readonly documentId?: string;
  readonly draftSourceBase64: string;
  readonly expectedDraftRawSourceSha256: string;
  readonly expectedCanonicalDigest: string;
  readonly expectedParentSourceSha256?: string;
  readonly expectedCompileRawSourceSha256: string;
  readonly expectedCompileCanonicalDigest: string;
  readonly expectedCompileUiRevision: number;
  readonly saveMode: "edited" | "new-document";
  readonly uiRevision: number;
}

export interface PairedV2SaveResponse {
  readonly cancelled: boolean;
  readonly saved: boolean;
  readonly sessionId: string;
  readonly uiRevision: number;
  readonly document?: PairedV2SavedDocument;
  readonly error?: PairedV2Error;
}

export interface PairedV2PreviewAck {
  readonly preview: "application" | "starlight";
  readonly sessionId: string;
  readonly uiRevision: number;
  readonly rawSourceSha256: string;
  readonly canonicalDigest: string;
  readonly frameId: string;
}

export type PairedV2Baseline =
  | {
      readonly sourceKind: "document";
      readonly documentId: string;
      readonly rawSourceSha256: string;
      readonly canonicalDigest: string;
    }
  | {
      readonly sourceKind: "detached";
      readonly rawSourceBase64: string;
      readonly rawSourceSha256: string;
      readonly canonicalDigest: string;
    };

export interface PairedV2AuthoringSnapshot {
  readonly sessionId: string;
  readonly revision: number;
  readonly baseline?: PairedV2Baseline;
  readonly edits: PairedV2EditMap;
  readonly latestSuccessful?: PairedV2SuccessfulCompileResponse;
  readonly previewAcks: Readonly<{
    application: PairedV2PreviewAck | undefined;
    starlight: PairedV2PreviewAck | undefined;
  }>;
}

export interface PairedV2CompileTicket {
  readonly request: PairedV2CompileRequest;
  readonly sessionId: string;
  readonly uiRevision: number;
}

export type PairedV2CompileAcceptance =
  | { readonly accepted: true; readonly response: PairedV2SuccessfulCompileResponse }
  | {
      readonly accepted: false;
      readonly reason:
        | "stale"
        | "cancelled"
        | "superseded"
        | "session-mismatch"
        | "revision-mismatch"
        | "invalid";
      readonly response?: PairedV2CompileResponse;
    };

export type PairedV2SaveEligibility =
  | { readonly eligible: true; readonly request: PairedV2SaveRequest }
  | {
      readonly eligible: false;
      readonly reason:
        | "no-baseline"
        | "no-successful-compile"
        | "compile-not-current"
        | "detached-no-custody"
        | "missing-document-parent"
        | "unexpected-document-parent";
    };
