use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chart1: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chart2: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chart3: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chart4: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chart5: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SurfacesDto {
    pub radius: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub border_width: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TypographyDto {
    pub font_sans: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_heading: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_mono: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PaletteDto {
    pub light: ColorTokensDto,
    pub dark: ColorTokensDto,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeSpecificationDto {
    pub schema_version: String,
    pub name: String,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub palette: PaletteDto,
    pub surfaces: SurfacesDto,
    pub typography: TypographyDto,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_overrides: Option<TargetOverridesDto>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LoomTargetOverridesDto {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_accent: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SolarSailSurfacesOverrideDto {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub radius: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub border_width: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SolarSailTargetOverridesDto {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub surfaces: Option<SolarSailSurfacesOverrideDto>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TargetOverridesDto {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loom: Option<LoomTargetOverridesDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub solar_sail: Option<SolarSailTargetOverridesDto>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedProfileDto {
    #[serde(alias = "schema")]
    pub schema_version: String,
    pub name: String,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub palette: PaletteDto,
    pub surfaces: SurfacesDto,
    pub typography: TypographyDto,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_overrides: Option<TargetOverridesDto>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeDiagnosticDto {
    pub severity: String,
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppThemeStatus {
    pub available: bool,
    pub compiler_version: String,
    pub session_id: String,
    pub latest_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dirty: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_file_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppThemeCompileRequest {
    pub specification: ThemeSpecificationDto,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ui_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppThemePairedCompileRequest {
    pub profile: PairedProfileDto,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ui_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppThemeOpenProfileResponse {
    pub cancelled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<PairedProfileDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppThemeSaveProfileRequest {
    pub profile: PairedProfileDto,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub save_as: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppThemeSaveProfileResponse {
    pub cancelled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppThemeExportRequest {
    pub specification: ThemeSpecificationDto,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
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
    pub solar_sail: Option<AppThemeCompileResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stellar_loom: Option<LoomSubprocessCompileResponse>,
    #[serde(default)]
    pub shared_tokens: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paired_profile_serialization_round_trip() -> Result<(), Box<dyn std::error::Error>> {
        let profile = PairedProfileDto {
            schema_version: "1.0.0".to_string(),
            name: "Forge Console".to_string(),
            version: "0.1.0".to_string(),
            description: Some("Test profile".to_string()),
            palette: PaletteDto {
                light: ColorTokensDto {
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
                    chart1: None,
                    chart2: None,
                    chart3: None,
                    chart4: None,
                    chart5: None,
                },
                dark: ColorTokensDto {
                    background: "#09090b".to_string(),
                    foreground: "#fafafa".to_string(),
                    card: "#09090b".to_string(),
                    card_foreground: "#fafafa".to_string(),
                    popover: "#09090b".to_string(),
                    popover_foreground: "#fafafa".to_string(),
                    primary: "#02c39a".to_string(),
                    primary_foreground: "#09090b".to_string(),
                    secondary: "#27272a".to_string(),
                    secondary_foreground: "#fafafa".to_string(),
                    muted: "#27272a".to_string(),
                    muted_foreground: "#a1a1aa".to_string(),
                    accent: "#27272a".to_string(),
                    accent_foreground: "#fafafa".to_string(),
                    destructive: "#7f1d1d".to_string(),
                    destructive_foreground: "#fafafa".to_string(),
                    border: "#27272a".to_string(),
                    input: "#27272a".to_string(),
                    ring: "#02c39a".to_string(),
                    chart1: None,
                    chart2: None,
                    chart3: None,
                    chart4: None,
                    chart5: None,
                },
            },
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
            target_overrides: None,
        };

        let json = serde_json::to_string(&profile)?;
        assert!(json.contains("\"schemaVersion\":\"1.0.0\""));
        assert!(json.contains("\"name\":\"Forge Console\""));
        assert!(json.contains("\"primary\":\"#00a896\""));

        let deserialized: PairedProfileDto = serde_json::from_str(&json)?;
        assert_eq!(deserialized, profile);
        Ok(())
    }

    #[test]
    fn compile_response_serialization() -> Result<(), Box<dyn std::error::Error>> {
        let response = AppThemeCompileResponse {
            status: "ok".to_string(),
            valid: true,
            ui_revision: 1,
            compiled_css: Some(":root { --primary: #00a896; }".to_string()),
            descriptor: None,
            diagnostics: vec![],
            error: None,
        };

        let json = serde_json::to_string(&response)?;
        assert!(json.contains("\"status\":\"ok\""));
        assert!(json.contains("\"valid\":true"));
        assert!(json.contains("\"uiRevision\":1"));
        assert!(json.contains("\"compiledCss\":\":root { --primary: #00a896; }\""));

        let deserialized: AppThemeCompileResponse = serde_json::from_str(&json)?;
        assert_eq!(deserialized, response);
        Ok(())
    }

    #[test]
    fn save_and_export_request_serialization() -> Result<(), Box<dyn std::error::Error>> {
        let save_req = AppThemeSaveProfileRequest {
            profile: PairedProfileDto {
                schema_version: "1.0.0".to_string(),
                name: "Test Profile".to_string(),
                version: "0.1.0".to_string(),
                description: None,
                palette: PaletteDto::default(),
                surfaces: SurfacesDto::default(),
                typography: TypographyDto::default(),
                target_overrides: None,
            },
            save_as: Some(true),
        };
        let save_json = serde_json::to_string(&save_req)?;
        assert!(save_json.contains("\"saveAs\":true"));
        let de_save: AppThemeSaveProfileRequest = serde_json::from_str(&save_json)?;
        assert_eq!(de_save, save_req);

        let export_req = AppThemeExportRequest {
            specification: ThemeSpecificationDto {
                schema_version: "tfss.theme-v1".to_string(),
                name: "Test".to_string(),
                version: "0.1.0".to_string(),
                description: None,
                palette: PaletteDto::default(),
                surfaces: SurfacesDto::default(),
                typography: TypographyDto::default(),
                target_overrides: None,
            },
            language: Some("typescript".to_string()),
        };
        let export_json = serde_json::to_string(&export_req)?;
        assert!(export_json.contains("\"language\":\"typescript\""));
        let de_export: AppThemeExportRequest = serde_json::from_str(&export_json)?;
        assert_eq!(de_export, export_req);
        Ok(())
    }

    #[test]
    fn paired_profile_with_target_overrides_round_trip() -> Result<(), Box<dyn std::error::Error>> {
        let profile = PairedProfileDto {
            schema_version: "tf-paired-profile-v1".to_string(),
            name: "forge-console".to_string(),
            version: "0.1.0".to_string(),
            description: Some("Test profile with target overrides".to_string()),
            palette: PaletteDto::default(),
            surfaces: SurfacesDto {
                radius: "0.5rem".to_string(),
                border_width: Some("1px".to_string()),
                content: Some(704),
            },
            typography: TypographyDto::default(),
            target_overrides: Some(TargetOverridesDto {
                loom: Some(LoomTargetOverridesDto {
                    content: Some(704),
                    default_accent: Some("cyan".to_string()),
                }),
                solar_sail: Some(SolarSailTargetOverridesDto {
                    surfaces: Some(SolarSailSurfacesOverrideDto {
                        radius: Some("0.75rem".to_string()),
                        border_width: None,
                        content: None,
                    }),
                }),
            }),
        };

        let json = serde_json::to_string_pretty(&profile)?;
        assert!(json.contains("\"targetOverrides\""));
        assert!(json.contains("\"defaultAccent\": \"cyan\""));
        assert!(json.contains("\"radius\": \"0.75rem\""));

        let deserialized: PairedProfileDto = serde_json::from_str(&json)?;
        assert_eq!(deserialized, profile);
        assert_eq!(
            deserialized
                .target_overrides
                .as_ref()
                .and_then(|to| to.loom.as_ref())
                .and_then(|l| l.default_accent.as_deref()),
            Some("cyan")
        );
        assert_eq!(
            deserialized
                .target_overrides
                .as_ref()
                .and_then(|to| to.solar_sail.as_ref())
                .and_then(|ss| ss.surfaces.as_ref())
                .and_then(|s| s.radius.as_deref()),
            Some("0.75rem")
        );
        Ok(())
    }

    #[test]
    fn paired_profile_schema_alias_compatibility() -> Result<(), Box<dyn std::error::Error>> {
        let json_with_schema = r##"{
            "schema": "tf-paired-profile-v1",
            "name": "forge-console",
            "version": "0.1.0",
            "palette": {
                "light": {
                    "background": "#ffffff", "foreground": "#000000", "card": "#ffffff", "cardForeground": "#000000",
                    "popover": "#ffffff", "popoverForeground": "#000000", "primary": "#126475", "primaryForeground": "#ffffff",
                    "secondary": "#f0f0f0", "secondaryForeground": "#000000", "muted": "#f0f0f0", "mutedForeground": "#888888",
                    "accent": "#9c3e0b", "accentForeground": "#ffffff", "destructive": "#ff0000", "destructiveForeground": "#ffffff",
                    "border": "#e0e0e0", "input": "#e0e0e0", "ring": "#126475"
                },
                "dark": {
                    "background": "#000000", "foreground": "#ffffff", "card": "#111111", "cardForeground": "#ffffff",
                    "popover": "#111111", "popoverForeground": "#ffffff", "primary": "#69d3e4", "primaryForeground": "#000000",
                    "secondary": "#222222", "secondaryForeground": "#ffffff", "muted": "#222222", "mutedForeground": "#aaaaaa",
                    "accent": "#ff8a3d", "accentForeground": "#000000", "destructive": "#ff3333", "destructiveForeground": "#ffffff",
                    "border": "#333333", "input": "#333333", "ring": "#69d3e4"
                }
            },
            "surfaces": { "radius": "0.5rem" },
            "typography": { "fontSans": "Inter, sans-serif" }
        }"##;

        let deserialized: PairedProfileDto = serde_json::from_str(json_with_schema)?;
        assert_eq!(deserialized.schema_version, "tf-paired-profile-v1");
        assert_eq!(deserialized.name, "forge-console");

        let re_serialized = serde_json::to_string(&deserialized)?;
        assert!(re_serialized.contains("\"schemaVersion\":\"tf-paired-profile-v1\""));
        Ok(())
    }

    #[test]
    fn paired_compile_adapter_stdout_deserialization() -> Result<(), Box<dyn std::error::Error>> {
        // Exact JSON emitted by solar-sail-adapter for paired_compile
        let adapter_stdout = r##"{
            "status": "success",
            "valid": true,
            "uiRevision": 15,
            "solarSail": {
                "status": "success",
                "valid": true,
                "uiRevision": 15,
                "compiledCss": "/* compiled css */",
                "descriptor": null,
                "diagnostics": [],
                "error": null
            },
            "stellarLoom": {
                "valid": true,
                "compiledCss": "/* loom css */",
                "diagnostics": [],
                "error": null
            },
            "sharedTokens": ["primary", "accent", "background", "foreground", "card", "muted", "border", "ring", "radius"],
            "error": null
        }"##;

        let resp: AppThemePairedCompileResponse = serde_json::from_str(adapter_stdout)?;
        assert_eq!(resp.status, "success");
        assert!(resp.valid);
        assert_eq!(resp.ui_revision, 15);
        assert_eq!(resp.solar_sail.status, "success");
        assert!(resp.solar_sail.valid);
        assert_eq!(resp.solar_sail.ui_revision, 15);
        assert_eq!(
            resp.solar_sail.compiled_css.as_deref(),
            Some("/* compiled css */")
        );
        let loom = resp
            .stellar_loom
            .as_ref()
            .ok_or("stellar_loom should be present")?;
        assert!(loom.valid);
        assert_eq!(resp.shared_tokens.len(), 9);
        Ok(())
    }

    #[test]
    fn validation_failure_adapter_stdout_deserialization() -> Result<(), Box<dyn std::error::Error>>
    {
        // Exact JSON emitted by solar-sail-adapter when validation fails
        let adapter_stdout = r##"{
            "status": "success",
            "valid": false,
            "uiRevision": 12,
            "compiledCss": null,
            "descriptor": null,
            "diagnostics": [
                {
                    "severity": "error",
                    "code": "INVALID_SCHEMA_VERSION",
                    "message": "Invalid schemaVersion: expected 'tfss.theme-v1'",
                    "path": "schemaVersion"
                },
                {
                    "severity": "error",
                    "code": "INVALID_NAME",
                    "message": "Field 'name' must be a lowercase kebab-case string",
                    "path": "name"
                }
            ],
            "error": "Invalid schemaVersion: expected 'tfss.theme-v1'"
        }"##;

        let resp: AppThemeCompileResponse = serde_json::from_str(adapter_stdout)?;
        assert_eq!(resp.status, "success");
        assert!(!resp.valid);
        assert_eq!(resp.ui_revision, 12);
        assert!(resp.compiled_css.is_none());
        assert_eq!(resp.diagnostics.len(), 2);
        assert_eq!(resp.diagnostics[0].code, "INVALID_SCHEMA_VERSION");
        assert_eq!(resp.diagnostics[0].severity, "error");
        assert_eq!(resp.diagnostics[0].path.as_deref(), Some("schemaVersion"));
        assert_eq!(
            resp.error.as_deref(),
            Some("Invalid schemaVersion: expected 'tfss.theme-v1'")
        );
        Ok(())
    }

    #[test]
    fn missing_loom_adapter_stdout_deserialization() -> Result<(), Box<dyn std::error::Error>> {
        let adapter_stdout = r##"{
            "status": "success",
            "valid": true,
            "uiRevision": 4,
            "solarSail": {
                "status": "success",
                "valid": true,
                "uiRevision": 4,
                "compiledCss": "/* ss css */",
                "descriptor": null,
                "diagnostics": [],
                "error": null
            },
            "stellarLoom": {
                "valid": false,
                "compiledCss": null,
                "diagnostics": [],
                "error": "Stellar Loom payload not available for paired preview"
            },
            "sharedTokens": ["primary", "accent"],
            "error": null
        }"##;

        let resp: AppThemePairedCompileResponse = serde_json::from_str(adapter_stdout)?;
        assert_eq!(resp.status, "success");
        assert!(resp.valid);
        assert_eq!(resp.ui_revision, 4);
        assert!(resp.solar_sail.valid);
        let loom = resp
            .stellar_loom
            .as_ref()
            .ok_or("stellar_loom should be present")?;
        assert!(!loom.valid);
        assert!(loom.compiled_css.is_none());
        assert!(
            loom.error
                .as_deref()
                .is_some_and(|e| e.contains("not available"))
        );
        Ok(())
    }
}
