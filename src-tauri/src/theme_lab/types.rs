pub use super::v2_types::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemePaletteAccent {
    pub base: String,
    pub low: String,
    pub high: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemePaletteNeutrals {
    pub bg: String,
    pub bg_nav: String,
    pub bg_sidebar: String,
    pub bg_inline_code: String,
    pub bg_accent: String,
    pub text: String,
    pub text_accent: String,
    pub text_invert: String,
    pub hairline: String,
    pub hairline_light: String,
    pub hairline_shade: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemePaletteGrays {
    pub gray1: String,
    pub gray2: String,
    pub gray3: String,
    pub gray4: String,
    pub gray5: String,
    pub gray6: String,
    pub gray7: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemePalette {
    pub accent: ThemePaletteAccent,
    pub neutrals: ThemePaletteNeutrals,
    pub grays: ThemePaletteGrays,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeColors {
    pub dark: ThemePalette,
    pub light: ThemePalette,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeTypography {
    pub body_font: String,
    pub code_font: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_font_size: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_height: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeLayout {
    pub content_width: String,
    pub sidebar_width: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeSpecification {
    #[serde(rename = "$schema", skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub name: String,
    pub version: String,
    pub schema_version: String,
    pub adapter: String,
    pub colors: ThemeColors,
    pub typography: ThemeTypography,
    pub layout: ThemeLayout,
}

#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ThemeDocument {
    V2(ThemeSpecificationV2),
    V1(ThemeSpecification),
}

impl ThemeDocument {
    pub fn name(&self) -> &str {
        match self {
            ThemeDocument::V1(s) => &s.name,
            ThemeDocument::V2(s) => &s.name,
        }
    }

    pub fn version(&self) -> &str {
        match self {
            ThemeDocument::V1(s) => &s.version,
            ThemeDocument::V2(s) => &s.version,
        }
    }

    pub fn schema_version(&self) -> &str {
        match self {
            ThemeDocument::V1(s) => &s.schema_version,
            ThemeDocument::V2(s) => &s.schema_version,
        }
    }

    pub fn adapter(&self) -> &str {
        match self {
            ThemeDocument::V1(s) => &s.adapter,
            ThemeDocument::V2(s) => &s.adapter,
        }
    }

    pub fn is_v2(&self) -> bool {
        matches!(self, ThemeDocument::V2(_))
    }
}

impl From<ThemeSpecification> for ThemeDocument {
    fn from(spec: ThemeSpecification) -> Self {
        ThemeDocument::V1(spec)
    }
}

impl From<ThemeSpecificationV2> for ThemeDocument {
    fn from(spec: ThemeSpecificationV2) -> Self {
        ThemeDocument::V2(spec)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeDescriptorProvenance {
    pub categories: Vec<String>,
    pub compiler: String,
    pub compiler_version: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeDescriptorV1 {
    pub schema: String,
    pub schema_version: u32,
    pub theme_schema_version: String,
    pub theme_name: String,
    pub theme_version: String,
    pub adapter: String,
    pub input_digest: String,
    pub output_digest: String,
    pub css_file: String,
    pub provenance: ThemeDescriptorProvenance,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ThemeDescriptor {
    V2(ThemeDescriptorV2),
    V1(ThemeDescriptorV1),
}

impl ThemeDescriptor {
    pub fn schema(&self) -> &str {
        match self {
            ThemeDescriptor::V1(d) => &d.schema,
            ThemeDescriptor::V2(d) => &d.schema,
        }
    }

    pub fn schema_version(&self) -> u32 {
        match self {
            ThemeDescriptor::V1(d) => d.schema_version,
            ThemeDescriptor::V2(d) => d.schema_version,
        }
    }

    pub fn adapter(&self) -> &str {
        match self {
            ThemeDescriptor::V1(d) => &d.adapter,
            ThemeDescriptor::V2(d) => &d.adapter,
        }
    }

    pub fn output_digest(&self) -> &str {
        match self {
            ThemeDescriptor::V1(d) => &d.output_digest,
            ThemeDescriptor::V2(d) => &d.output_digest,
        }
    }

    pub fn input_digest(&self) -> &str {
        match self {
            ThemeDescriptor::V1(d) => &d.input_digest,
            ThemeDescriptor::V2(d) => &d.input_digest,
        }
    }

    pub fn theme_name(&self) -> &str {
        match self {
            ThemeDescriptor::V1(d) => &d.theme_name,
            ThemeDescriptor::V2(d) => &d.theme_name,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThemeStyleFile {
    pub path: String,
    pub css: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContrastDiagnostic {
    pub severity: String,
    pub code: String,
    pub role: String,
    pub mode: String,
    pub element: String,
    pub foreground: String,
    pub background: String,
    pub ratio: f64,
    pub display_ratio: String,
    pub criterion: String,
    pub threshold: f64,
    pub disposition: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeLabError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThemeCompileOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strict_contrast: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accent: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeLabStatus {
    pub available: bool,
    pub compiler_version: String,
    pub session_id: String,
    pub latest_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dirty: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adopted_theme_digest: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThemeLabCompileRequest {
    pub specification: ThemeDocument,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<ThemeCompileOptions>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ui_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeLabCompileResponse {
    pub ui_revision: u64,
    pub valid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compiled_css: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub descriptor: Option<ThemeDescriptor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub styles: Option<Vec<ThemeStyleFile>>,
    pub diagnostics: Vec<ContrastDiagnostic>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ThemeLabError>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeLabExampleResponse {
    pub ui_revision: u64,
    pub valid: bool,
    pub example_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub specification: Option<ThemeDocument>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compiled_css: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub descriptor: Option<ThemeDescriptor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub styles: Option<Vec<ThemeStyleFile>>,
    pub diagnostics: Vec<ContrastDiagnostic>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ThemeLabError>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThemeLabOpenRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ui_revision: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeLabOpenResponse {
    pub cancelled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub specification: Option<ThemeDocument>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compiled_css: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub descriptor: Option<ThemeDescriptor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub styles: Option<Vec<ThemeStyleFile>>,
    #[serde(default)]
    pub diagnostics: Vec<ContrastDiagnostic>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ThemeLabError>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThemeLabSaveRequest {
    pub specification: ThemeDocument,
    pub save_as: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ui_revision: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeLabSaveResponse {
    pub cancelled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BatchSubprocessRequest {
    pub opaque_packets: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidates: Option<Vec<String>>,
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub specification: Option<ThemeDocument>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub example_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<ThemeCompileOptions>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ui_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub brief_input: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub packet_json: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub packet_bytes_base64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub brief: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review_input: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BatchSubprocessResponse {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ui_revision: Option<u64>,
    pub valid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub example_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub specification: Option<ThemeDocument>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compiled_css: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub descriptor: Option<ThemeDescriptor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub styles: Option<Vec<ThemeStyleFile>>,
    #[serde(default)]
    pub diagnostics: Vec<ContrastDiagnostic>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ThemeLabError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canonical_json: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub byte_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate_verification: Option<ThemeCandidateVerificationResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review_validation: Option<ThemeReviewValidation>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThemeBriefCreateRequest {
    pub brief_input: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeBriefCreateResponse {
    pub error: Option<ThemeLabError>,
    pub canonical_json: String,
    pub digest: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThemePacketImportRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_kind: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemePacketImportResponse {
    pub cancelled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canonical_json: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ThemeLabError>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThemePacketExportRequest {
    pub packet_json: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemePacketExportResponse {
    pub cancelled: bool,
    pub saved: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ThemeLabError>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThemeReviewCreateRequest {
    pub review_input: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeReviewCreateResponse {
    pub error: Option<ThemeLabError>,
    pub canonical_json: String,
    pub digest: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThemeCandidateAdoptRequest {
    pub candidate: String,
    pub brief: String,
    pub session_id: String,
    pub ui_revision: u64,
    pub options: Option<ThemeCompileOptions>,
    #[serde(default)]
    pub force: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeCandidateAdoptResponse {
    pub adopted: bool,
    #[serde(default)]
    pub requires_confirmation: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub specification: Option<ThemeDocument>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compiled_css: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub descriptor: Option<ThemeDescriptor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub styles: Option<Vec<ThemeStyleFile>>,
    #[serde(default)]
    pub diagnostics: Vec<ContrastDiagnostic>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ThemeLabError>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThemeCandidateVerification {
    pub valid: bool,
    pub candidate_id: String,
    pub candidate_digest: String,
    pub brief_digest: String,
    pub theme_digest: String,
    pub computed_css_digest: Option<String>,
    pub diagnostics: Vec<ContrastDiagnostic>,
    pub constraint_violations: Vec<String>,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThemeCandidateV2Verification {
    pub schema: String,
    pub schema_version: u32,
    pub valid: bool,
    pub candidate_id: String,
    pub candidate_digest: String,
    pub input_digest: String,
    pub output_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub descriptor: Option<ThemeDescriptorV2>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compiled_css: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub styles: Option<Vec<ThemeStyleFile>>,
    #[serde(default)]
    pub diagnostics: Vec<ContrastDiagnostic>,
    #[serde(default)]
    pub errors: Vec<String>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ThemeCandidateVerificationResult {
    V2(ThemeCandidateV2Verification),
    V1(ThemeCandidateVerification),
}

impl ThemeCandidateVerificationResult {
    pub fn is_valid(&self) -> bool {
        match self {
            ThemeCandidateVerificationResult::V1(v) => v.valid,
            ThemeCandidateVerificationResult::V2(v) => v.valid,
        }
    }

    pub fn candidate_id(&self) -> &str {
        match self {
            ThemeCandidateVerificationResult::V1(v) => &v.candidate_id,
            ThemeCandidateVerificationResult::V2(v) => &v.candidate_id,
        }
    }

    pub fn candidate_digest(&self) -> &str {
        match self {
            ThemeCandidateVerificationResult::V1(v) => &v.candidate_digest,
            ThemeCandidateVerificationResult::V2(v) => &v.candidate_digest,
        }
    }

    pub fn diagnostics(&self) -> &[ContrastDiagnostic] {
        match self {
            ThemeCandidateVerificationResult::V1(v) => &v.diagnostics,
            ThemeCandidateVerificationResult::V2(v) => &v.diagnostics,
        }
    }

    pub fn errors(&self) -> &[String] {
        match self {
            ThemeCandidateVerificationResult::V1(v) => &v.errors,
            ThemeCandidateVerificationResult::V2(v) => &v.errors,
        }
    }

    pub fn warnings(&self) -> &[String] {
        match self {
            ThemeCandidateVerificationResult::V1(v) => &v.warnings,
            ThemeCandidateVerificationResult::V2(v) => &v.warnings,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThemeReviewValidation {
    pub valid: bool,
    pub review_id: String,
    pub review_digest: String,
    pub brief_digest: String,
    pub candidate_matches: bool,
    pub disposition_matches: bool,
    pub annotation_errors: Vec<String>,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThemeCandidateVerifyRequest {
    pub candidate: String,
    pub brief: String,
    pub options: Option<ThemeCompileOptions>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThemeReviewValidateRequest {
    pub review: String,
    pub brief: String,
    pub candidates: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThemeDraftUpdateRequest {
    pub session_id: String,
    pub ui_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThemeDraftUpdateResponse {
    pub ui_revision: u64,
}
