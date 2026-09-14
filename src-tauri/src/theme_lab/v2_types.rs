//! Closed transport types for the implemented Loom v2 envelope.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged, deny_unknown_fields)]
pub enum TokenDefinition {
    String(String),
    Value(TokenValueObject),
    Alias(TokenAliasObject),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccentVariantDefinition {
    pub token_set: String,
    pub light: BTreeMap<String, String>,
    pub dark: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TypographyRoleV2 {
    pub font: String,
    pub size: f64,
    pub line_height: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TypographyV2 {
    pub body: TypographyRoleV2,
    pub heading: TypographyRoleV2,
    pub ui: TypographyRoleV2,
    pub code: TypographyRoleV2,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfacesV2 {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub border_style: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub focus_offset: Option<f64>,
    pub spacing: f64,
    pub radii: f64,
    pub border: f64,
    pub focus: f64,
    pub content: f64,
    pub sidebar: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComponentsV2 {
    pub page_title: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum FontWeightV2 {
    Number(u32),
    String(String),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FontDeclarationV2 {
    pub id: String,
    pub family: String,
    pub style: String,
    pub weight: FontWeightV2,
    pub format: String,
    pub sha256: String,
    pub license: String,
    pub notice: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairedColorHex {
    pub light: String,
    pub dark: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MarkColor {
    Color(String),
    Paired(PairedColorHex),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyntaxRule {
    pub scopes: Vec<String>,
    pub foreground: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_style: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyntaxThemeMode {
    pub rules: Vec<SyntaxRule>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyntaxTheme {
    pub light: SyntaxThemeMode,
    pub dark: SyntaxThemeMode,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeMarks {
    pub marked: MarkColor,
    pub inserted: MarkColor,
    pub deleted: MarkColor,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodePresentationConfig {
    pub mode: String,
    pub syntax_theme: SyntaxTheme,
    pub frame: String,
    pub marks: CodeMarks,
    pub copy: String,
    pub tabs: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThemeDescriptorProvenanceV2 {
    pub categories: Vec<String>,
    pub semantic: String,
    pub compiler: String,
    pub compiler_version: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThemeDescriptorCatalogRef {
    pub identity: String,
    pub digest: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThemeDescriptorV2 {
    pub schema: String,
    pub schema_version: u32,
    pub theme_schema_version: String,
    pub theme_name: String,
    pub theme_version: String,
    pub adapter: String,
    pub selected_accent: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accent: Option<String>,
    pub input_digest: String,
    pub output_digest: String,
    pub inventory_digest: String,
    pub catalog_identity: String,
    pub catalog_digest: String,
    pub catalog: ThemeDescriptorCatalogRef,
    pub compiler_semantic: String,
    pub provenance: ThemeDescriptorProvenanceV2,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TokenValueObject {
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TokenAliasObject {
    pub alias: String,
}

#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CodePresentationOptionV2 {
    String(String),
    Config(CodePresentationConfig),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HeroAction {
    pub label: String,
    pub href: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HeroAnnouncementObject {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub href: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum HeroAnnouncement {
    Text(String),
    Object(HeroAnnouncementObject),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HeroRoute {
    pub route: String,
    pub layout: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub announcement: Option<HeroAnnouncement>,
    pub actions: Vec<HeroAction>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogHeroConfig {
    pub routes: Vec<HeroRoute>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogPageTitleConfig {
    pub copy: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogPaginationConfig {
    pub variant: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogSidebarConfig {
    pub mode: String,
    pub group_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogFontLicense {
    pub id: String,
    pub text: String,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThemeCatalogConfig {
    pub hero: CatalogHeroConfig,
    pub page_title: CatalogPageTitleConfig,
    pub pagination: CatalogPaginationConfig,
    pub sidebar: CatalogSidebarConfig,
    pub layout: String,
    pub font_licenses: Vec<CatalogFontLicense>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThemeSpecificationV2 {
    #[serde(rename = "$schema", skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub name: String,
    pub version: String,
    pub schema_version: String,
    pub adapter: String,
    pub token_sets: BTreeMap<String, BTreeMap<String, TokenDefinition>>,
    pub accent_variants: BTreeMap<String, AccentVariantDefinition>,
    pub default_accent: String,
    pub typography: TypographyV2,
    pub surfaces: SurfacesV2,
    pub layout_preset: String,
    pub components: ComponentsV2,
    pub code_presentation: CodePresentationOptionV2,
    pub fonts: Vec<FontDeclarationV2>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub catalog: Option<ThemeCatalogConfig>,
}
