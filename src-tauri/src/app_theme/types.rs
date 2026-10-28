use serde::{Deserialize, Serialize};

macro_rules! closed_opt_struct {
    (
        pub struct $name:ident {
            $(pub $req_field:ident : $req_ty:ty,)*
            $(@opt $(#[$fmeta:meta])* pub $opt_field:ident : Option<$opt_ty:ty>,)*
        }
    ) => {
        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        pub struct $name {
            $(pub $req_field: $req_ty,)*
            $(
                #[serde(skip_serializing_if = "Option::is_none")]
                $(#[$fmeta])*
                pub $opt_field: Option<$opt_ty>,
            )*
        }
    };
}

closed_opt_struct! {
    pub struct ColorTokensDto {
        pub background: String,
        pub foreground: String,
        pub card: String,
        pub card_foreground: String,
        pub popover: String,
        pub popover_foreground: String,
        pub primary: String,
        pub primary_foreground: String,
        pub secondary: String,
        pub secondary_foreground: String,
        pub muted: String,
        pub muted_foreground: String,
        pub accent: String,
        pub accent_foreground: String,
        pub destructive: String,
        pub destructive_foreground: String,
        pub border: String,
        pub input: String,
        pub ring: String,
        @opt pub chart1: Option<String>,
        @opt pub chart2: Option<String>,
        @opt pub chart3: Option<String>,
        @opt pub chart4: Option<String>,
        @opt pub chart5: Option<String>,
        @opt pub sidebar: Option<String>,
        @opt pub sidebar_foreground: Option<String>,
        @opt pub sidebar_primary: Option<String>,
        @opt pub sidebar_primary_foreground: Option<String>,
        @opt pub sidebar_accent: Option<String>,
        @opt pub sidebar_accent_foreground: Option<String>,
        @opt pub sidebar_border: Option<String>,
        @opt pub sidebar_ring: Option<String>,
    }
}

closed_opt_struct! {
    pub struct PartialColorTokensDto {
        @opt pub background: Option<String>,
        @opt pub foreground: Option<String>,
        @opt pub card: Option<String>,
        @opt pub card_foreground: Option<String>,
        @opt pub popover: Option<String>,
        @opt pub popover_foreground: Option<String>,
        @opt pub primary: Option<String>,
        @opt pub primary_foreground: Option<String>,
        @opt pub secondary: Option<String>,
        @opt pub secondary_foreground: Option<String>,
        @opt pub muted: Option<String>,
        @opt pub muted_foreground: Option<String>,
        @opt pub accent: Option<String>,
        @opt pub accent_foreground: Option<String>,
        @opt pub destructive: Option<String>,
        @opt pub destructive_foreground: Option<String>,
        @opt pub border: Option<String>,
        @opt pub input: Option<String>,
        @opt pub ring: Option<String>,
        @opt pub chart1: Option<String>,
        @opt pub chart2: Option<String>,
        @opt pub chart3: Option<String>,
        @opt pub chart4: Option<String>,
        @opt pub chart5: Option<String>,
        @opt pub sidebar: Option<String>,
        @opt pub sidebar_foreground: Option<String>,
        @opt pub sidebar_primary: Option<String>,
        @opt pub sidebar_primary_foreground: Option<String>,
        @opt pub sidebar_accent: Option<String>,
        @opt pub sidebar_accent_foreground: Option<String>,
        @opt pub sidebar_border: Option<String>,
        @opt pub sidebar_ring: Option<String>,
    }
}

closed_opt_struct! {
    pub struct PaletteOverridesDto {
        @opt pub light: Option<PartialColorTokensDto>,
        @opt pub dark: Option<PartialColorTokensDto>,
    }
}

closed_opt_struct! {
    pub struct SurfacesDto {
        pub radius: String,
        @opt pub border_width: Option<String>,
        @opt pub content: Option<u32>,
    }
}

closed_opt_struct! {
    pub struct TypographyDto {
        pub font_sans: String,
        @opt pub font_heading: Option<String>,
        @opt pub font_mono: Option<String>,
    }
}

closed_opt_struct! {
    pub struct PaletteDto {
        pub light: ColorTokensDto,
        pub dark: ColorTokensDto,
    }
}

closed_opt_struct! {
    pub struct SyntaxPaletteDto {
        @opt pub background: Option<String>,
        @opt pub foreground: Option<String>,
        @opt pub comment: Option<String>,
        @opt pub string: Option<String>,
        @opt pub number: Option<String>,
        @opt pub constant: Option<String>,
        @opt pub keyword: Option<String>,
        @opt pub function: Option<String>,
        @opt #[serde(rename = "type")] pub type_color: Option<String>,
        @opt pub variable: Option<String>,
        @opt pub punctuation: Option<String>,
        @opt pub tag: Option<String>,
        @opt pub attribute: Option<String>,
        @opt pub operator: Option<String>,
    }
}

closed_opt_struct! {
    pub struct SyntaxOverridesDto {
        @opt pub light: Option<SyntaxPaletteDto>,
        @opt pub dark: Option<SyntaxPaletteDto>,
    }
}

closed_opt_struct! {
    pub struct ChromeRoleColorsOverrideDto {
        @opt pub background: Option<String>,
        @opt pub foreground: Option<String>,
        @opt pub border: Option<String>,
        @opt pub focus: Option<String>,
        @opt pub tab_bar_background: Option<String>,
        @opt pub tab_bar_border: Option<String>,
        @opt pub active_tab_background: Option<String>,
        @opt pub active_tab_foreground: Option<String>,
        @opt pub active_tab_border: Option<String>,
        @opt pub terminal_titlebar_background: Option<String>,
        @opt pub terminal_titlebar_foreground: Option<String>,
        @opt pub copy_button_foreground: Option<String>,
        @opt pub copy_button_border: Option<String>,
        @opt pub tooltip_success_background: Option<String>,
        @opt pub tooltip_success_foreground: Option<String>,
    }
}

closed_opt_struct! {
    pub struct ChromePaletteOverrideDto {
        @opt pub light: Option<ChromeRoleColorsOverrideDto>,
        @opt pub dark: Option<ChromeRoleColorsOverrideDto>,
    }
}

closed_opt_struct! {
    pub struct DiffRoleColorsOverrideDto {
        @opt pub inserted: Option<String>,
        @opt pub deleted: Option<String>,
        @opt pub marked: Option<String>,
        @opt pub inserted_background: Option<String>,
        @opt pub deleted_background: Option<String>,
        @opt pub marked_background: Option<String>,
    }
}

closed_opt_struct! {
    pub struct DiffPaletteOverrideDto {
        @opt pub light: Option<DiffRoleColorsOverrideDto>,
        @opt pub dark: Option<DiffRoleColorsOverrideDto>,
    }
}

closed_opt_struct! {
    pub struct SyntaxTabsOverrideDto {
        @opt pub active_indicator: Option<String>,
    }
}

closed_opt_struct! {
    pub struct TargetSyntaxOverridesDto {
        @opt pub syntax: Option<SyntaxOverridesDto>,
        @opt pub chrome: Option<ChromePaletteOverrideDto>,
        @opt pub diffs: Option<DiffPaletteOverrideDto>,
        @opt pub copy: Option<String>,
        @opt pub frame: Option<String>,
        @opt pub tabs: Option<SyntaxTabsOverrideDto>,
        @opt pub light: Option<SyntaxPaletteDto>,
        @opt pub dark: Option<SyntaxPaletteDto>,
    }
}

closed_opt_struct! {
    pub struct LoomTypographyOverridesDto {
        @opt pub font_sans: Option<String>,
        @opt pub font_heading: Option<String>,
        @opt pub font_mono: Option<String>,
        @opt pub primary_family: Option<String>,
        @opt pub secondary_family: Option<String>,
    }
}

closed_opt_struct! {
    pub struct SolarSailSurfacesOverrideDto {
        @opt pub radius: Option<String>,
        @opt pub border_width: Option<String>,
        @opt pub content: Option<u32>,
    }
}

closed_opt_struct! {
    pub struct LoomTargetOverridesDto {
        @opt pub content: Option<u32>,
        @opt pub default_accent: Option<String>,
        @opt pub primary_family: Option<String>,
        @opt pub secondary_family: Option<String>,
        @opt pub palette: Option<PaletteOverridesDto>,
        @opt pub surfaces: Option<SolarSailSurfacesOverrideDto>,
        @opt pub typography: Option<LoomTypographyOverridesDto>,
        @opt pub syntax: Option<SyntaxOverridesDto>,
    }
}

closed_opt_struct! {
    pub struct SolarSailTargetOverridesDto {
        @opt pub surfaces: Option<SolarSailSurfacesOverrideDto>,
        @opt pub palette: Option<PaletteOverridesDto>,
    }
}

closed_opt_struct! {
    pub struct TargetOverridesDto {
        @opt pub loom: Option<LoomTargetOverridesDto>,
        @opt pub solar_sail: Option<SolarSailTargetOverridesDto>,
        @opt pub syntax: Option<TargetSyntaxOverridesDto>,
    }
}

closed_opt_struct! {
    pub struct ThemeSpecificationDto {
        pub schema_version: String,
        pub name: String,
        pub version: String,
        pub palette: PaletteDto,
        pub surfaces: SurfacesDto,
        pub typography: TypographyDto,
        @opt pub description: Option<String>,
        @opt pub target_overrides: Option<TargetOverridesDto>,
    }
}

closed_opt_struct! {
    pub struct PairedProfileDto {
        pub schema_version: String,
        pub name: String,
        pub version: String,
        pub palette: PaletteDto,
        pub surfaces: SurfacesDto,
        pub typography: TypographyDto,
        @opt pub description: Option<String>,
        @opt pub target_overrides: Option<TargetOverridesDto>,
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PairedProfileLegacyAliasDto {
    pub schema: String,
    pub name: String,
    pub version: String,
    pub description: Option<String>,
    pub palette: PaletteDto,
    pub surfaces: SurfacesDto,
    pub typography: TypographyDto,
    pub target_overrides: Option<TargetOverridesDto>,
}

impl PairedProfileDto {
    pub fn from_slice_with_alias_flag(bytes: &[u8]) -> Result<(Self, bool), String> {
        if let Ok(dto) = serde_json::from_slice::<PairedProfileDto>(bytes) {
            return Ok((dto, false));
        }
        match serde_json::from_slice::<PairedProfileLegacyAliasDto>(bytes) {
            Ok(legacy) => Ok((
                PairedProfileDto {
                    schema_version: legacy.schema,
                    name: legacy.name,
                    version: legacy.version,
                    description: legacy.description,
                    palette: legacy.palette,
                    surfaces: legacy.surfaces,
                    typography: legacy.typography,
                    target_overrides: legacy.target_overrides,
                },
                true,
            )),
            Err(err) => Err(err.to_string()),
        }
    }
}

closed_opt_struct! {
    pub struct ColorModeTokensV2Dto {
        pub canvas: String,
        pub canvas_text: String,
        pub surface: String,
        pub surface_text: String,
        pub elevated_surface: String,
        pub elevated_surface_text: String,
        pub primary_action: String,
        pub primary_action_text: String,
        pub secondary_action: String,
        pub secondary_action_text: String,
        pub muted_surface: String,
        pub muted_text: String,
        pub highlight: String,
        pub highlight_text: String,
        pub danger: String,
        pub danger_text: String,
        pub border: String,
        pub field_border: String,
        pub focus: String,
        @opt pub hover: Option<String>,
        @opt pub active: Option<String>,
        @opt pub selection: Option<String>,
        @opt pub selection_text: Option<String>,
    }
}

closed_opt_struct! {
    pub struct ColorSurfacesInteractionsV2Dto {
        pub light: ColorModeTokensV2Dto,
        pub dark: ColorModeTokensV2Dto,
    }
}

closed_opt_struct! {
    pub struct TypographyRoleV2Dto {
        pub family: String,
        @opt pub size: Option<String>,
        @opt pub line_height: Option<f64>,
    }
}

closed_opt_struct! {
    pub struct TypographyV2Dto {
        @opt pub body: Option<TypographyRoleV2Dto>,
        @opt pub heading: Option<TypographyRoleV2Dto>,
        @opt pub ui: Option<TypographyRoleV2Dto>,
        @opt pub code: Option<TypographyRoleV2Dto>,
    }
}

closed_opt_struct! {
    pub struct RadiusV2Dto {
        @opt pub control: Option<String>,
        @opt pub surface: Option<String>,
        @opt pub overlay: Option<String>,
    }
}

closed_opt_struct! {
    pub struct SpacingV2Dto {
        @opt pub base: Option<String>,
        @opt pub density: Option<String>,
    }
}

closed_opt_struct! {
    pub struct ElevationV2Dto {
        @opt pub emphasis: Option<String>,
        @opt pub border_width: Option<String>,
        @opt pub border_style: Option<String>,
    }
}

closed_opt_struct! {
    pub struct FocusColorV2Dto {
        @opt pub light: Option<String>,
        @opt pub dark: Option<String>,
    }
}

closed_opt_struct! {
    pub struct FocusV2Dto {
        @opt pub color: Option<FocusColorV2Dto>,
        @opt pub width: Option<String>,
        @opt pub offset: Option<String>,
    }
}

closed_opt_struct! {
    pub struct CodeV2Dto {
        @opt pub syntax: Option<SyntaxOverridesDto>,
        @opt pub chrome: Option<ChromePaletteOverrideDto>,
        @opt pub diffs: Option<DiffPaletteOverrideDto>,
        @opt pub tabs: Option<SyntaxTabsOverrideDto>,
        @opt pub frame: Option<String>,
        @opt pub copy: Option<String>,
    }
}

closed_opt_struct! {
    pub struct ReadingV2Dto {
        @opt pub measure: Option<String>,
    }
}

closed_opt_struct! {
    pub struct NavigationV2Dto {
        @opt pub prominence: Option<String>,
        @opt pub density: Option<String>,
    }
}

closed_opt_struct! {
    pub struct StellarLoomTargetOverrideV2Dto {
        @opt pub content: Option<u64>,
        @opt pub radii: Option<f64>,
        @opt pub border: Option<f64>,
        @opt pub primary_family: Option<String>,
        @opt pub secondary_family: Option<String>,
        @opt pub default_accent: Option<String>,
        @opt pub token_set_key: Option<String>,
    }
}

closed_opt_struct! {
    pub struct TargetOverridesV2Dto {
        pub version: String,
        @opt pub solar_sail: Option<SolarSailTargetOverridesDto>,
        @opt pub loom: Option<StellarLoomTargetOverrideV2Dto>,
        @opt pub syntax: Option<TargetSyntaxOverridesDto>,
    }
}

closed_opt_struct! {
    pub struct PairedProfileV2DocumentDto {
        pub schema_version: String,
        pub name: String,
        pub version: String,
        pub color: ColorSurfacesInteractionsV2Dto,
        @opt pub description: Option<String>,
        @opt pub typography: Option<TypographyV2Dto>,
        @opt pub radius: Option<RadiusV2Dto>,
        @opt pub spacing: Option<SpacingV2Dto>,
        @opt pub elevation: Option<ElevationV2Dto>,
        @opt pub focus: Option<FocusV2Dto>,
        @opt pub code: Option<CodeV2Dto>,
        @opt pub reading: Option<ReadingV2Dto>,
        @opt pub navigation: Option<NavigationV2Dto>,
        @opt pub target_overrides: Option<TargetOverridesV2Dto>,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum ProfileDocumentSchemaVersion {
    #[default]
    #[serde(rename = "tf-paired-profile-v1")]
    PairedProfileV1,
    #[serde(rename = "tf-paired-profile-v2")]
    PairedProfileV2,
    #[serde(rename = "corrupt")]
    Corrupt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum ProfileVerificationStatus {
    #[default]
    #[serde(rename = "verified")]
    Verified,
    #[serde(rename = "unverified-assertion")]
    UnverifiedAssertion,
    #[serde(rename = "transformed")]
    Transformed,
    #[serde(rename = "corrupt")]
    Corrupt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum ProfileSemanticStatus {
    #[default]
    #[serde(rename = "validated")]
    Validated,
    #[serde(rename = "rejected")]
    Rejected,
    #[serde(rename = "unavailable")]
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProfileSaveMode {
    #[serde(rename = "original")]
    Original,
    #[serde(rename = "edited")]
    Edited,
    #[serde(rename = "new-document")]
    NewDocument,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum OwnerBindingInputOrigin {
    #[default]
    #[serde(rename = "source-bytes")]
    SourceBytes,
    #[serde(rename = "resolved-legacy-alias")]
    ResolvedLegacyAlias,
}

closed_opt_struct! {
    pub struct OwnerBindingRecord {
        pub input_origin: OwnerBindingInputOrigin,
        pub raw_source_sha256: String,
        pub verification_status: ProfileVerificationStatus,
        pub is_transformed: bool,
        pub byte_length: u64,
        @opt pub normalized_sha256: Option<String>,
        @opt pub canonical_digest: Option<String>,
        @opt pub parent_source_sha256: Option<String>,
    }
}

closed_opt_struct! {
    pub struct AppThemeOpenedDocument {
        pub document_id: String,
        pub display_name: String,
        pub schema_version: ProfileDocumentSchemaVersion,
        pub alias_resolved: bool,
        pub verification_status: ProfileVerificationStatus,
        pub is_transformed: bool,
        pub semantic: ProfileSemanticStatus,
        pub raw_source_sha256: String,
        pub editable: bool,
        @opt pub owner_binding: Option<OwnerBindingRecord>,
        @opt pub parent_source_sha256: Option<String>,
        @opt pub normalized_sha256: Option<String>,
        @opt pub canonical_digest: Option<String>,
        @opt pub readonly_reason: Option<String>,
        @opt pub diagnostic_code: Option<String>,
        @opt pub diagnostic_summary: Option<String>,
        @opt pub profile: Option<PairedProfileDto>,
        @opt pub v2_profile: Option<PairedProfileV2DocumentDto>,
    }
}

closed_opt_struct! {
    pub struct ThemeDiagnosticDto {
        pub severity: String,
        pub code: String,
        pub message: String,
        @opt pub path: Option<String>,
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeDescriptorCompilerDto {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeDescriptorDto {
    pub schema: String,
    pub theme_name: String,
    pub theme_version: String,
    pub input_digest: String,
    pub output_digest: String,
    pub inventory_digest: String,
    pub compiler: ThemeDescriptorCompilerDto,
    pub diagnostics: Vec<ThemeDiagnosticDto>,
}

closed_opt_struct! {
    pub struct AppThemeStatus {
        pub available: bool,
        pub compiler_version: String,
        pub supported_formats: Vec<String>,
        pub session_id: String,
        pub latest_revision: u64,
        @opt pub message: Option<String>,
        @opt pub dirty: Option<bool>,
        @opt pub active_document_id: Option<String>,
        @opt pub active_display_name: Option<String>,
        @opt pub active_schema_version: Option<ProfileDocumentSchemaVersion>,
        @opt pub active_verification_status: Option<ProfileVerificationStatus>,
    }
}

closed_opt_struct! {
    pub struct AppThemeCompileRequest {
        pub specification: ThemeSpecificationDto,
        @opt pub ui_revision: Option<u64>,
        @opt pub session_id: Option<String>,
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppThemeCompileResponse {
    pub status: String,
    pub valid: bool,
    pub ui_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compiled_css: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub descriptor: Option<ThemeDescriptorDto>,
    pub diagnostics: Vec<ThemeDiagnosticDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoomSubprocessCompileResponse {
    pub valid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compiled_css: Option<String>,
    pub diagnostics: Vec<ThemeDiagnosticDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

closed_opt_struct! {
    pub struct AppThemePairedCompileRequest {
        pub profile: PairedProfileDto,
        @opt pub ui_revision: Option<u64>,
        @opt pub session_id: Option<String>,
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppThemePairedCompileResponse {
    pub status: String,
    pub valid: bool,
    pub ui_revision: u64,
    pub solar_sail: AppThemeCompileResponse,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stellar_loom: Option<LoomSubprocessCompileResponse>,
    pub shared_tokens: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

closed_opt_struct! {
    pub struct AppThemeOpenProfileResponse {
        pub cancelled: bool,
        @opt pub document: Option<AppThemeOpenedDocument>,
        @opt pub error: Option<String>,
    }
}

closed_opt_struct! {
    pub struct AppThemeSaveProfileRequest {
        @opt pub profile: Option<PairedProfileDto>,
        @opt pub document_id: Option<String>,
        @opt pub save_mode: Option<ProfileSaveMode>,
    }
}

closed_opt_struct! {
    pub struct AppThemeSaveProfileResponse {
        pub cancelled: bool,
        pub saved: bool,
        @opt pub document: Option<AppThemeOpenedDocument>,
        @opt pub error: Option<String>,
    }
}

closed_opt_struct! {
    pub struct AppThemeExportRequest {
        pub specification: ThemeSpecificationDto,
        @opt pub language: Option<String>,
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppThemeExportResponse {
    pub cancelled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AdapterSubprocessRequest {
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub specification: Option<ThemeSpecificationDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<PairedProfileDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_bytes_base64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ui_revision: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AdapterSubprocessResponse {
    pub status: String,
    pub valid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ui_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compiled_css: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub descriptor: Option<ThemeDescriptorDto>,
    #[serde(default)]
    pub diagnostics: Vec<ThemeDiagnosticDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub solar_sail: Option<Box<AppThemeCompileResponse>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stellar_loom: Option<Box<LoomSubprocessCompileResponse>>,
    #[serde(default)]
    pub shared_tokens: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema_version: Option<ProfileDocumentSchemaVersion>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alias_resolved: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verification_status: Option<ProfileVerificationStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_source_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub normalized_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canonical_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_binding: Option<OwnerBindingRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<Box<PairedProfileDto>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub v2_profile: Option<Box<PairedProfileV2DocumentDto>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(default)]
    pub details: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct AdapterBindDocumentResponse {
    pub status: String,
    pub valid: bool,
    pub schema_version: ProfileDocumentSchemaVersion,
    pub alias_resolved: bool,
    pub verification_status: ProfileVerificationStatus,
    pub raw_source_sha256: String,
    pub normalized_sha256: Option<String>,
    pub canonical_digest: Option<String>,
    pub owner_binding: Option<OwnerBindingRecord>,
    pub profile: Option<Box<PairedProfileDto>>,
    pub v2_profile: Option<Box<PairedProfileV2DocumentDto>>,
    pub error_code: Option<String>,
    pub error: Option<String>,
    pub details: Vec<String>,
}

pub fn sanitize_untrusted_text(input: &str, max_chars: usize) -> String {
    let mut chars = input.chars().peekable();
    let mut cleaned = String::with_capacity(input.len());
    while let Some(ch) = chars.next() {
        if ch == '\u{001b}' {
            match chars.peek().copied() {
                Some('[') => {
                    let _ = chars.next();
                    for c in chars.by_ref() {
                        if ('@'..='~').contains(&c) {
                            break;
                        }
                    }
                    cleaned.push(' ');
                    continue;
                }
                Some(']') => {
                    let _ = chars.next();
                    while let Some(c) = chars.next() {
                        if c == '\u{0007}' {
                            break;
                        }
                        if c == '\u{001b}' && chars.peek() == Some(&'\\') {
                            let _ = chars.next();
                            break;
                        }
                    }
                    cleaned.push(' ');
                    continue;
                }
                _ => {
                    cleaned.push(' ');
                    continue;
                }
            }
        }
        let code = ch as u32;
        let is_forbidden = code <= 0x1f
            || (0x7f..=0x9f).contains(&code)
            || code == 0x061c
            || code == 0x200e
            || code == 0x200f
            || (0x202a..=0x202e).contains(&code)
            || (0x2066..=0x2069).contains(&code);
        if is_forbidden || ch.is_whitespace() {
            cleaned.push(' ');
        } else {
            cleaned.push(ch);
        }
    }
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(max_chars).collect()
}

pub fn sanitize_error_code(input: &str, fallback: &str) -> String {
    let trimmed = input.trim();
    if !trimmed.is_empty()
        && trimmed.len() <= 64
        && trimmed
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
    {
        trimmed.to_owned()
    } else {
        fallback.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paired_profile_serialization_and_closed_dto_validation()
    -> Result<(), Box<dyn std::error::Error>> {
        let mut light = ColorTokensDto {
            background: "#ffffff".to_string(),
            foreground: "#09090b".to_string(),
            card: "#ffffff".to_string(),
            card_foreground: "#09090b".to_string(),
            popover: "#ffffff".to_string(),
            popover_foreground: "#09090b".to_string(),
            primary: "#00a896".to_string(),
            primary_foreground: "#ffffff".to_string(),
            secondary: "#f4f4f5".to_string(),
            secondary_foreground: "#18181b".to_string(),
            muted: "#f4f4f5".to_string(),
            muted_foreground: "#71717a".to_string(),
            accent: "#f4f4f5".to_string(),
            accent_foreground: "#18181b".to_string(),
            destructive: "#ef4444".to_string(),
            destructive_foreground: "#fafafa".to_string(),
            border: "#e4e4e7".to_string(),
            input: "#e4e4e7".to_string(),
            ring: "#00a896".to_string(),
            ..ColorTokensDto::default()
        };
        light.sidebar = Some("#f8fafc".to_string());
        light.sidebar_foreground = Some("#0f172a".to_string());
        let mut dark = light.clone();
        dark.background = "#09090b".to_string();
        dark.foreground = "#fafafa".to_string();
        dark.primary = "#02c39a".to_string();
        let profile = PairedProfileDto {
            schema_version: "tf-paired-profile-v1".to_string(),
            name: "Forge Console".to_string(),
            version: "0.1.0".to_string(),
            description: Some("Test profile".to_string()),
            palette: PaletteDto { light, dark },
            surfaces: SurfacesDto {
                radius: "0.5rem".to_string(),
                border_width: Some("1px".to_string()),
                content: Some(1280),
            },
            typography: TypographyDto {
                font_sans: "Inter, sans-serif".to_string(),
                font_heading: None,
                font_mono: None,
            },
            target_overrides: Some(TargetOverridesDto {
                loom: Some(LoomTargetOverridesDto {
                    content: Some(704),
                    default_accent: Some("cyan".to_string()),
                    primary_family: Some("cyan".to_string()),
                    secondary_family: Some("orange".to_string()),
                    syntax: Some(SyntaxOverridesDto {
                        light: Some(SyntaxPaletteDto {
                            comment: Some("#64748b".to_string()),
                            ..SyntaxPaletteDto::default()
                        }),
                        dark: None,
                    }),
                    ..LoomTargetOverridesDto::default()
                }),
                solar_sail: Some(SolarSailTargetOverridesDto {
                    surfaces: Some(SolarSailSurfacesOverrideDto {
                        radius: Some("0.75rem".to_string()),
                        border_width: None,
                        content: None,
                    }),
                    palette: None,
                }),
                syntax: None,
            }),
        };

        let json = serde_json::to_string(&profile)?;
        assert!(json.contains("\"schemaVersion\":\"tf-paired-profile-v1\""));
        assert!(json.contains("\"sidebar\":\"#f8fafc\""));
        let deserialized: PairedProfileDto = serde_json::from_str(&json)?;
        assert_eq!(deserialized, profile);

        let mut val = serde_json::to_value(&profile)?;
        val["extraRoot"] = serde_json::json!(true);
        assert!(serde_json::from_value::<PairedProfileDto>(val.clone()).is_err());
        if let Some(obj) = val.as_object_mut() {
            obj.remove("extraRoot");
        }
        val["palette"]["light"]["unknownToken"] = serde_json::json!("#123456");
        assert!(serde_json::from_value::<PairedProfileDto>(val).is_err());

        let mut alias_val = serde_json::to_value(&profile)?;
        if let Some(obj) = alias_val.as_object_mut() {
            obj.remove("schemaVersion");
            obj.insert(
                "schema".to_string(),
                serde_json::json!("tf-paired-profile-v1"),
            );
        }
        let alias_bytes = serde_json::to_vec(&alias_val)?;
        let (alias_dto, alias_resolved) =
            PairedProfileDto::from_slice_with_alias_flag(&alias_bytes)?;
        assert!(alias_resolved);
        assert_eq!(alias_dto.schema_version, "tf-paired-profile-v1");
        Ok(())
    }

    #[test]
    fn request_and_response_dto_serialization() -> Result<(), Box<dyn std::error::Error>> {
        let save_req = AppThemeSaveProfileRequest {
            profile: Some(PairedProfileDto::default()),
            document_id: Some("doc-1".to_string()),
            save_mode: Some(ProfileSaveMode::Edited),
        };
        let save_json = serde_json::to_string(&save_req)?;
        assert!(save_json.contains("\"saveMode\":\"edited\""));
        let de_save: AppThemeSaveProfileRequest = serde_json::from_str(&save_json)?;
        assert_eq!(de_save, save_req);

        let sanitized = sanitize_untrusted_text("bad\u{001b}[31m\u{202e}\0text\nline2", 64);
        assert_eq!(sanitized, "bad text line2");
        assert_eq!(
            sanitize_error_code("SCHEMA_VALIDATION", "FALLBACK"),
            "SCHEMA_VALIDATION"
        );
        assert_eq!(sanitize_error_code("bad-code!", "FALLBACK"), "FALLBACK");
        Ok(())
    }
}
