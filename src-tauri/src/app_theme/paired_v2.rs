//! Source-only transport contract for paired profile v2 authoring.
//!
//! This module is intentionally limited to closed serde DTOs and bounded,
//! semantic-free transport checks. The native Solar binder remains the owner
//! of profile parsing, edit application, JSON canonicalization, value syntax,
//! normalized values, and source/hash authority.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use base64::Engine as _;
use serde::de::{self, MapAccess, Visitor};
use serde::ser::{SerializeMap, SerializeSeq};
use serde::{Deserialize, Deserializer, Serialize};

pub use super::types::PairedV2AuthoringCapability;
use super::types::{PairedProfileV2DocumentDto, ThemeDiagnosticDto};

pub const PAIRED_V2_MAX_SOURCE_BYTES: usize = 128 * 1024;
pub const PAIRED_V2_MAX_SOURCE_BASE64_CHARS: usize = 175_104;
pub const PAIRED_V2_MAX_COMPILE_REQUEST_BYTES: usize = 2 * 1024 * 1024;
pub const PAIRED_V2_MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
pub const PAIRED_V2_MAX_EDIT_ENTRIES: usize = 64;
pub const PAIRED_V2_MAX_DIAGNOSTIC_ENTRIES: usize = 256;
pub const PAIRED_V2_MAX_MAPPING_ENTRIES: usize = 4_096;
pub const PAIRED_V2_MAX_MAPPING_GROUPS: usize = 64;
pub const PAIRED_V2_MAX_MAPPING_DEFAULTS: usize = 256;
pub const PAIRED_V2_MAX_PROFILE_JSON_BYTES: usize = 262_144;
pub const PAIRED_V2_MAX_SOLAR_CSS_BYTES: usize = 262_144;
pub const PAIRED_V2_MAX_LOOM_CSS_BYTES: usize = 262_144;
pub const PAIRED_V2_MAX_APPLICATION_APPEARANCE_CSS_BYTES: usize = 524_288;
pub const PAIRED_V2_MAX_MAPPING_REPORT_BYTES: usize = 245_760;
pub const PAIRED_V2_MAX_APPLICATION_EXTENSION_BYTES: usize = 65_536;
pub const PAIRED_V2_MAX_DIAGNOSTICS_AND_FRAMING_BYTES: usize = 32_768;
pub const PAIRED_V2_MAX_SESSION_ID_CHARS: usize = 128;
pub const PAIRED_V2_MAX_REVISION: u64 = 9_007_199_254_740_991;
pub const PAIRED_V2_MAX_DOCUMENT_ID_CHARS: usize = 256;
pub const PAIRED_V2_MAX_PROFILE_NAME_CHARS: usize = 64;
pub const PAIRED_V2_MAX_PROFILE_VERSION_CHARS: usize = 64;
pub const PAIRED_V2_MAX_HEX_VALUE_CHARS: usize = 9;
pub const PAIRED_V2_MAX_EXPLICIT_LENGTH_CHARS: usize = 64;
pub const PAIRED_V2_MAX_FONT_STACK_CHARS: usize = 500;
pub const PAIRED_V2_MAX_FONT_FAMILY_ITEM_CHARS: usize = 100;
pub const PAIRED_V2_MAX_NUMERIC_EDIT_VALUE: f64 = 100_000.0;
pub const PAIRED_V2_MAX_LINE_HEIGHT: f64 = 10.0;
pub const PAIRED_V2_MAX_DIAGNOSTIC_CODE_CHARS: usize = 128;
pub const PAIRED_V2_MAX_DIAGNOSTIC_MESSAGE_CHARS: usize = 2_048;
pub const PAIRED_V2_MAX_PATH_CHARS: usize = 256;
pub const PAIRED_V2_MAX_ERROR_CODE_CHARS: usize = 128;
pub const PAIRED_V2_MAX_ERROR_MESSAGE_CHARS: usize = 2_048;

const MAX_SUMMARY_COUNT: u64 = 1_000_000;

#[derive(Debug, Clone, PartialEq)]
pub enum PairedV2JsonValue {
    Null,
    Bool(bool),
    Number(serde_json::Number),
    String(String),
    Array(Vec<Self>),
    Object(BTreeMap<String, Self>),
}

impl Serialize for PairedV2JsonValue {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            Self::Null => serializer.serialize_none(),
            Self::Bool(value) => serializer.serialize_bool(*value),
            Self::Number(value) => value.serialize(serializer),
            Self::String(value) => serializer.serialize_str(value),
            Self::Array(values) => {
                let mut sequence = serializer.serialize_seq(Some(values.len()))?;
                for value in values {
                    sequence.serialize_element(value)?;
                }
                sequence.end()
            }
            Self::Object(values) => {
                let mut map = serializer.serialize_map(Some(values.len()))?;
                for (key, value) in values {
                    map.serialize_entry(key, value)?;
                }
                map.end()
            }
        }
    }
}

struct PairedV2JsonValueVisitor;

impl<'de> Visitor<'de> for PairedV2JsonValueVisitor {
    type Value = PairedV2JsonValue;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a bounded JSON value")
    }

    fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(PairedV2JsonValue::Bool(value))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(PairedV2JsonValue::Number(serde_json::Number::from(value)))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(PairedV2JsonValue::Number(serde_json::Number::from(value)))
    }

    fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        serde_json::Number::from_f64(value)
            .map(PairedV2JsonValue::Number)
            .ok_or_else(|| E::custom("JSON number must be finite"))
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(PairedV2JsonValue::String(value.to_owned()))
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(PairedV2JsonValue::String(value))
    }

    fn visit_none<E>(self) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(PairedV2JsonValue::Null)
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(PairedV2JsonValue::Null)
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: de::SeqAccess<'de>,
    {
        let mut values = Vec::new();
        while let Some(value) = sequence.next_element::<PairedV2JsonValue>()? {
            values.push(value);
        }
        Ok(PairedV2JsonValue::Array(values))
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut values = BTreeMap::new();
        while let Some((key, value)) = map.next_entry::<String, PairedV2JsonValue>()? {
            if values.insert(key.clone(), value).is_some() {
                return Err(de::Error::custom("duplicate JSON object key"));
            }
        }
        Ok(PairedV2JsonValue::Object(values))
    }
}

impl<'de> Deserialize<'de> for PairedV2JsonValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(PairedV2JsonValueVisitor)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairedV2ContractError {
    pub field: String,
    pub reason: String,
}

impl PairedV2ContractError {
    fn new(field: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            field: field.into(),
            reason: reason.into(),
        }
    }
}

impl fmt::Display for PairedV2ContractError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} {}", self.field, self.reason)
    }
}

impl std::error::Error for PairedV2ContractError {}

pub type PairedV2ContractResult<T> = Result<T, PairedV2ContractError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PairedV2EditKind {
    SetColor,
    SetTypography,
    SetRadius,
    ClearOptional,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PairedV2EditValue {
    Text(String),
    Number(f64),
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum PairedV2Edit {
    SetColor {
        path: String,
        value: String,
    },
    SetTypography {
        path: String,
        value: PairedV2EditValue,
    },
    SetRadius {
        path: String,
        value: String,
    },
    ClearOptional {
        path: String,
    },
}

impl PairedV2Edit {
    pub fn path(&self) -> &str {
        match self {
            Self::SetColor { path, .. }
            | Self::SetTypography { path, .. }
            | Self::SetRadius { path, .. }
            | Self::ClearOptional { path } => path,
        }
    }

    pub fn kind(&self) -> PairedV2EditKind {
        match self {
            Self::SetColor { .. } => PairedV2EditKind::SetColor,
            Self::SetTypography { .. } => PairedV2EditKind::SetTypography,
            Self::SetRadius { .. } => PairedV2EditKind::SetRadius,
            Self::ClearOptional { .. } => PairedV2EditKind::ClearOptional,
        }
    }
}

struct PairedV2EditVisitor;

impl<'de> Visitor<'de> for PairedV2EditVisitor {
    type Value = PairedV2Edit;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a closed paired-v2 edit object")
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut kind = None;
        let mut path = None;
        let mut value = None;
        let mut value_present = false;

        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "kind" => {
                    if kind.is_some() {
                        return Err(de::Error::duplicate_field("kind"));
                    }
                    kind = Some(map.next_value::<PairedV2EditKind>()?);
                }
                "path" => {
                    if path.is_some() {
                        return Err(de::Error::duplicate_field("path"));
                    }
                    path = Some(map.next_value::<String>()?);
                }
                "value" => {
                    if value_present {
                        return Err(de::Error::duplicate_field("value"));
                    }
                    value_present = true;
                    value = Some(map.next_value::<PairedV2EditValue>()?);
                }
                _ => {
                    return Err(de::Error::unknown_field(&key, &["kind", "path", "value"]));
                }
            }
        }

        let kind = kind.ok_or_else(|| de::Error::missing_field("kind"))?;
        let path = path.ok_or_else(|| de::Error::missing_field("path"))?;
        match kind {
            PairedV2EditKind::SetColor => match value {
                Some(PairedV2EditValue::Text(value)) => Ok(PairedV2Edit::SetColor { path, value }),
                Some(PairedV2EditValue::Number(_)) => {
                    Err(de::Error::custom("set-color value must be a string"))
                }
                None => Err(de::Error::missing_field("value")),
            },
            PairedV2EditKind::SetTypography => match value {
                Some(value) => Ok(PairedV2Edit::SetTypography { path, value }),
                None => Err(de::Error::missing_field("value")),
            },
            PairedV2EditKind::SetRadius => match value {
                Some(PairedV2EditValue::Text(value)) => Ok(PairedV2Edit::SetRadius { path, value }),
                Some(PairedV2EditValue::Number(_)) => {
                    Err(de::Error::custom("set-radius value must be a string"))
                }
                None => Err(de::Error::missing_field("value")),
            },
            PairedV2EditKind::ClearOptional => {
                if value_present {
                    return Err(de::Error::custom("clear-optional must not contain value"));
                }
                Ok(PairedV2Edit::ClearOptional { path })
            }
        }
    }
}

impl<'de> Deserialize<'de> for PairedV2Edit {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_map(PairedV2EditVisitor)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppThemePairedCompileV2Source {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_source_base64: Option<String>,
    pub expected_raw_source_sha256: String,
    pub expected_canonical_digest: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppThemePairedCompileV2Request {
    pub source: AppThemePairedCompileV2Source,
    pub edits: Vec<PairedV2Edit>,
    pub ui_revision: u64,
    pub session_id: String,
}

/// Detached request projected by native custody into the fixed paired-v2
/// adapter entrypoint.  The adapter never resolves document IDs or reads
/// source files; native state supplies the exact custody bytes and claims.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairedV2AdapterCompileRequest {
    pub raw_source_base64: String,
    pub expected_raw_source_sha256: String,
    pub expected_canonical_digest: String,
    pub edits: Vec<PairedV2Edit>,
    pub ui_revision: u64,
    pub session_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PairedV2CompileStatus {
    Success,
    Partial,
    Stale,
    Cancelled,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PairedV2VerificationStatus {
    #[serde(rename = "verified")]
    Verified,
    #[serde(rename = "transformed")]
    Transformed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PairedV2SourceVerification {
    #[serde(rename = "source-bytes")]
    SourceBytes,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PairedV2MappingReportSchema {
    #[serde(rename = "tf-paired-mapping-report-v2")]
    TfPairedMappingReportV2,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PairedV2ApplicationMappingReportSchema {
    #[serde(rename = "theme-forge.application-appearance-extension.v1")]
    ThemeForgeApplicationAppearanceExtensionV1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PairedV2MappingClassification {
    Consumed,
    Normalized,
    Overridden,
    TargetSpecific,
    Unsupported,
    GeneratedDefault,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairedV2AdapterIdentity {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairedV2MappingEntry {
    pub source_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_value: Option<PairedV2JsonValue>,
    pub classification: PairedV2MappingClassification,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_value: Option<PairedV2JsonValue>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairedV2MappingGroup {
    pub group: String,
    pub applicable: bool,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairedV2MappingDefault {
    pub target_path: String,
    pub target_value: PairedV2JsonValue,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairedV2MappingSummary {
    pub total_semantic_leaves: u64,
    pub consumed: u64,
    pub normalized: u64,
    pub overridden: u64,
    pub target_specific: u64,
    pub unsupported: u64,
    pub generated_defaults_count: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairedV2MappingReport {
    pub schema: PairedV2MappingReportSchema,
    pub target: String,
    pub profile_name: String,
    pub profile_version: String,
    pub source_sha256: String,
    pub source_verification: PairedV2SourceVerification,
    pub canonical_digest: String,
    pub adapter: PairedV2AdapterIdentity,
    pub compiler: PairedV2AdapterIdentity,
    pub options: PairedV2JsonValue,
    pub entries: Vec<PairedV2MappingEntry>,
    pub groups: Vec<PairedV2MappingGroup>,
    pub defaults: Vec<PairedV2MappingDefault>,
    pub summary: PairedV2MappingSummary,
    pub digest: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairedV2ApplicationMappingEntry {
    pub source_path: String,
    pub target: String,
    pub value: PairedV2JsonValue,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairedV2ApplicationMappingReport {
    pub schema: PairedV2ApplicationMappingReportSchema,
    pub entries: Vec<PairedV2ApplicationMappingEntry>,
    pub scope: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairedV2TargetCompileResult {
    pub valid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compiled_css: Option<String>,
    pub diagnostics: Vec<ThemeDiagnosticDto>,
    pub mapping_report: PairedV2MappingReport,
    pub source_profile_sha256: String,
    pub canonical_digest: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairedV2ApplicationExtensionResult {
    pub valid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compiled_css: Option<String>,
    pub diagnostics: Vec<ThemeDiagnosticDto>,
    pub mapping_report: PairedV2ApplicationMappingReport,
    pub source_profile_sha256: String,
    pub canonical_digest: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairedV2ApplicationAppearanceResult {
    pub valid: bool,
    pub compiled_css: String,
    pub source_profile_sha256: String,
    pub canonical_digest: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairedV2Draft {
    pub profile: PairedProfileV2DocumentDto,
    pub source_bytes_base64: String,
    pub raw_source_sha256: String,
    pub canonical_digest: String,
    pub baseline_raw_source_sha256: String,
    pub baseline_canonical_digest: String,
    pub verification_status: PairedV2VerificationStatus,
    pub is_transformed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_source_sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairedV2Error {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PairedV2CompileResponseWire {
    pub status: PairedV2CompileStatus,
    pub valid: bool,
    pub ui_revision: u64,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub draft: Option<PairedV2Draft>,
    pub solar_sail: Option<PairedV2TargetCompileResult>,
    pub stellar_loom: Option<PairedV2TargetCompileResult>,
    pub application_appearance: Option<PairedV2ApplicationAppearanceResult>,
    pub application_extension: Option<PairedV2ApplicationExtensionResult>,
    pub diagnostics: Vec<ThemeDiagnosticDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<PairedV2Error>,
}

fn required_wire_field<T>(value: Option<T>, field: &str) -> Result<T, String> {
    value.ok_or_else(|| format!("compile response is missing {field}"))
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum AppThemePairedCompileV2Response {
    Success {
        #[serde(rename = "valid")]
        valid: bool,
        #[serde(rename = "uiRevision")]
        ui_revision: u64,
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "draft")]
        draft: PairedV2Draft,
        #[serde(rename = "solarSail")]
        solar_sail: PairedV2TargetCompileResult,
        #[serde(rename = "stellarLoom")]
        stellar_loom: PairedV2TargetCompileResult,
        #[serde(rename = "applicationAppearance")]
        application_appearance: PairedV2ApplicationAppearanceResult,
        #[serde(rename = "applicationExtension")]
        application_extension: PairedV2ApplicationExtensionResult,
        #[serde(rename = "diagnostics")]
        diagnostics: Vec<ThemeDiagnosticDto>,
    },
    Partial {
        #[serde(rename = "valid")]
        valid: bool,
        #[serde(rename = "uiRevision")]
        ui_revision: u64,
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "draft")]
        draft: PairedV2Draft,
        #[serde(rename = "solarSail")]
        solar_sail: PairedV2TargetCompileResult,
        #[serde(rename = "stellarLoom")]
        stellar_loom: PairedV2TargetCompileResult,
        #[serde(rename = "applicationAppearance")]
        application_appearance: PairedV2ApplicationAppearanceResult,
        #[serde(rename = "applicationExtension")]
        application_extension: PairedV2ApplicationExtensionResult,
        #[serde(rename = "diagnostics")]
        diagnostics: Vec<ThemeDiagnosticDto>,
    },
    Stale {
        #[serde(rename = "valid")]
        valid: bool,
        #[serde(rename = "uiRevision")]
        ui_revision: u64,
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "draft", skip_serializing_if = "Option::is_none")]
        draft: Option<PairedV2Draft>,
        #[serde(rename = "solarSail")]
        solar_sail: Option<PairedV2TargetCompileResult>,
        #[serde(rename = "stellarLoom")]
        stellar_loom: Option<PairedV2TargetCompileResult>,
        #[serde(rename = "applicationAppearance")]
        application_appearance: Option<PairedV2ApplicationAppearanceResult>,
        #[serde(rename = "applicationExtension")]
        application_extension: Option<PairedV2ApplicationExtensionResult>,
        #[serde(rename = "diagnostics")]
        diagnostics: Vec<ThemeDiagnosticDto>,
        #[serde(rename = "error", skip_serializing_if = "Option::is_none")]
        error: Option<PairedV2Error>,
    },
    Cancelled {
        #[serde(rename = "valid")]
        valid: bool,
        #[serde(rename = "uiRevision")]
        ui_revision: u64,
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "draft", skip_serializing_if = "Option::is_none")]
        draft: Option<PairedV2Draft>,
        #[serde(rename = "solarSail")]
        solar_sail: Option<PairedV2TargetCompileResult>,
        #[serde(rename = "stellarLoom")]
        stellar_loom: Option<PairedV2TargetCompileResult>,
        #[serde(rename = "applicationAppearance")]
        application_appearance: Option<PairedV2ApplicationAppearanceResult>,
        #[serde(rename = "applicationExtension")]
        application_extension: Option<PairedV2ApplicationExtensionResult>,
        #[serde(rename = "diagnostics")]
        diagnostics: Vec<ThemeDiagnosticDto>,
        #[serde(rename = "error", skip_serializing_if = "Option::is_none")]
        error: Option<PairedV2Error>,
    },
    Error {
        #[serde(rename = "valid")]
        valid: bool,
        #[serde(rename = "uiRevision")]
        ui_revision: u64,
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "draft", skip_serializing_if = "Option::is_none")]
        draft: Option<PairedV2Draft>,
        #[serde(rename = "solarSail")]
        solar_sail: Option<PairedV2TargetCompileResult>,
        #[serde(rename = "stellarLoom")]
        stellar_loom: Option<PairedV2TargetCompileResult>,
        #[serde(rename = "applicationAppearance")]
        application_appearance: Option<PairedV2ApplicationAppearanceResult>,
        #[serde(rename = "applicationExtension")]
        application_extension: Option<PairedV2ApplicationExtensionResult>,
        #[serde(rename = "diagnostics")]
        diagnostics: Vec<ThemeDiagnosticDto>,
        #[serde(rename = "error", skip_serializing_if = "Option::is_none")]
        error: Option<PairedV2Error>,
    },
}

impl<'de> Deserialize<'de> for AppThemePairedCompileV2Response {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = PairedV2CompileResponseWire::deserialize(deserializer)?;
        let PairedV2CompileResponseWire {
            status,
            valid,
            ui_revision,
            session_id,
            draft,
            solar_sail,
            stellar_loom,
            application_appearance,
            application_extension,
            diagnostics,
            error,
        } = wire;
        match status {
            PairedV2CompileStatus::Success | PairedV2CompileStatus::Partial => {
                if error.is_some() {
                    return Err(de::Error::custom(
                        "success and partial responses cannot contain error",
                    ));
                }
                let draft = required_wire_field(draft, "draft").map_err(de::Error::custom)?;
                let solar_sail =
                    required_wire_field(solar_sail, "solarSail").map_err(de::Error::custom)?;
                let stellar_loom =
                    required_wire_field(stellar_loom, "stellarLoom").map_err(de::Error::custom)?;
                let application_appearance =
                    required_wire_field(application_appearance, "applicationAppearance")
                        .map_err(de::Error::custom)?;
                let application_extension =
                    required_wire_field(application_extension, "applicationExtension")
                        .map_err(de::Error::custom)?;
                let success = status == PairedV2CompileStatus::Success;
                if success {
                    Ok(Self::Success {
                        valid,
                        ui_revision,
                        session_id,
                        draft,
                        solar_sail,
                        stellar_loom,
                        application_appearance,
                        application_extension,
                        diagnostics,
                    })
                } else {
                    Ok(Self::Partial {
                        valid,
                        ui_revision,
                        session_id,
                        draft,
                        solar_sail,
                        stellar_loom,
                        application_appearance,
                        application_extension,
                        diagnostics,
                    })
                }
            }
            PairedV2CompileStatus::Stale => Ok(Self::Stale {
                valid,
                ui_revision,
                session_id,
                draft,
                solar_sail,
                stellar_loom,
                application_appearance,
                application_extension,
                diagnostics,
                error,
            }),
            PairedV2CompileStatus::Cancelled => Ok(Self::Cancelled {
                valid,
                ui_revision,
                session_id,
                draft,
                solar_sail,
                stellar_loom,
                application_appearance,
                application_extension,
                diagnostics,
                error,
            }),
            PairedV2CompileStatus::Error => Ok(Self::Error {
                valid,
                ui_revision,
                session_id,
                draft,
                solar_sail,
                stellar_loom,
                application_appearance,
                application_extension,
                diagnostics,
                error,
            }),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PairedV2SaveMode {
    Edited,
    NewDocument,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppThemeSaveProfileV2Request {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_id: Option<String>,
    pub draft_source_base64: String,
    pub expected_draft_raw_source_sha256: String,
    pub expected_canonical_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_parent_source_sha256: Option<String>,
    pub expected_compile_raw_source_sha256: String,
    pub expected_compile_canonical_digest: String,
    pub expected_compile_ui_revision: u64,
    pub save_mode: PairedV2SaveMode,
    pub ui_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairedV2SavedDocument {
    pub document_id: String,
    pub raw_source_sha256: String,
    pub canonical_digest: String,
    pub display_name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppThemeSaveProfileV2Response {
    pub cancelled: bool,
    pub saved: bool,
    pub session_id: String,
    pub ui_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document: Option<PairedV2SavedDocument>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<PairedV2Error>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairedV2LatestCompileClaim {
    pub raw_source_sha256: String,
    pub canonical_digest: String,
    pub ui_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairedV2ActiveDocumentClaim {
    pub document_id: String,
    pub raw_source_sha256: String,
}

fn reject<T>(field: impl Into<String>, reason: impl Into<String>) -> PairedV2ContractResult<T> {
    Err(PairedV2ContractError::new(field, reason))
}

fn serialized_len<T: Serialize + ?Sized>(value: &T, field: &str) -> PairedV2ContractResult<usize> {
    serde_json::to_vec(value)
        .map(|bytes| bytes.len())
        .map_err(|_| PairedV2ContractError::new(field, "must be JSON-serializable"))
}

fn is_forbidden_untrusted_text_character(character: char) -> bool {
    let code = character as u32;
    code <= 0x1f
        || (0x7f..=0x9f).contains(&code)
        || code == 0x061c
        || code == 0x200e
        || code == 0x200f
        || (0x202a..=0x202e).contains(&code)
        || (0x2066..=0x2069).contains(&code)
}

fn validate_text(
    value: &str,
    max_chars: usize,
    field: &str,
    reject_css_delimiters: bool,
) -> PairedV2ContractResult<()> {
    if value.is_empty() {
        return reject(field, "must be non-empty");
    }
    if value.len() > max_chars {
        return reject(field, "exceeds its byte bound");
    }
    if value.chars().any(|character| {
        is_forbidden_untrusted_text_character(character)
            || (reject_css_delimiters && matches!(character, '{' | '}' | ';'))
    }) {
        return reject(field, "contains forbidden control or CSS delimiter bytes");
    }
    Ok(())
}

fn validate_untrusted_json_string(value: &str, field: &str) -> PairedV2ContractResult<()> {
    if value.chars().any(is_forbidden_untrusted_text_character) {
        return reject(field, "contains forbidden untrusted-text control bytes");
    }
    Ok(())
}

fn validate_identifier(value: &str, max_chars: usize, field: &str) -> PairedV2ContractResult<()> {
    validate_text(value, max_chars, field, false)
}

fn validate_sha256(value: &str, field: &str) -> PairedV2ContractResult<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return reject(field, "must be a lowercase SHA-256 digest");
    }
    Ok(())
}

fn validate_source_base64(value: &str, field: &str) -> PairedV2ContractResult<()> {
    if value.is_empty() || value.len() > PAIRED_V2_MAX_SOURCE_BASE64_CHARS {
        return reject(field, "exceeds its base64 transport bound");
    }
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(value.as_bytes())
        .map_err(|_| PairedV2ContractError::new(field, "must be standard padded base64"))?;
    if decoded.is_empty() || decoded.len() > PAIRED_V2_MAX_SOURCE_BYTES {
        return reject(field, "exceeds the 128 KiB decoded source bound");
    }
    if base64::engine::general_purpose::STANDARD.encode(decoded) != value {
        return reject(field, "must use canonical padded base64");
    }
    Ok(())
}

fn validate_source(source: &AppThemePairedCompileV2Source) -> PairedV2ContractResult<()> {
    let has_document = source.document_id.is_some();
    let has_detached = source.raw_source_base64.is_some();
    if has_document == has_detached {
        return reject(
            "source",
            "must contain exactly one of documentId or rawSourceBase64",
        );
    }
    if let Some(document_id) = source.document_id.as_deref() {
        validate_identifier(
            document_id,
            PAIRED_V2_MAX_DOCUMENT_ID_CHARS,
            "source.documentId",
        )?;
    }
    if let Some(raw_source_base64) = source.raw_source_base64.as_deref() {
        validate_source_base64(raw_source_base64, "source.rawSourceBase64")?;
    }
    validate_sha256(
        &source.expected_raw_source_sha256,
        "source.expectedRawSourceSha256",
    )?;
    validate_sha256(
        &source.expected_canonical_digest,
        "source.expectedCanonicalDigest",
    )?;
    Ok(())
}

fn is_color_path(path: &str) -> bool {
    let mut parts = path.split('.');
    matches!(parts.next(), Some("color"))
        && matches!(parts.next(), Some("light" | "dark"))
        && matches!(
            parts.next(),
            Some(
                "canvas"
                    | "canvasText"
                    | "surface"
                    | "surfaceText"
                    | "elevatedSurface"
                    | "elevatedSurfaceText"
                    | "primaryAction"
                    | "primaryActionText"
                    | "secondaryAction"
                    | "secondaryActionText"
                    | "mutedSurface"
                    | "mutedText"
                    | "highlight"
                    | "highlightText"
                    | "danger"
                    | "dangerText"
                    | "border"
                    | "fieldBorder"
                    | "focus"
                    | "hover"
                    | "active"
                    | "selection"
                    | "selectionText"
            )
        )
        && parts.next().is_none()
}

fn is_typography_path(path: &str) -> bool {
    let mut parts = path.split('.');
    matches!(parts.next(), Some("typography"))
        && matches!(parts.next(), Some("body" | "heading" | "ui" | "code"))
        && matches!(parts.next(), Some("family" | "size" | "lineHeight"))
        && parts.next().is_none()
}

fn is_radius_path(path: &str) -> bool {
    let mut parts = path.split('.');
    matches!(parts.next(), Some("radius"))
        && matches!(parts.next(), Some("control" | "surface" | "overlay"))
        && parts.next().is_none()
}

fn is_clear_optional_path(path: &str) -> bool {
    if matches!(path, "radius.control" | "radius.overlay") {
        return true;
    }
    let mut parts = path.split('.');
    matches!(
        (parts.next(), parts.next(), parts.next(), parts.next()),
        (
            Some("color"),
            Some("light" | "dark"),
            Some("hover" | "active"),
            None
        ) | (
            Some("typography"),
            Some("body" | "heading" | "ui" | "code"),
            Some("size" | "lineHeight"),
            None,
        )
    )
}

fn validate_edit_path(path: &str, field: &str) -> PairedV2ContractResult<()> {
    validate_text(path, PAIRED_V2_MAX_PATH_CHARS, field, false)?;
    if !(is_color_path(path) || is_typography_path(path) || is_radius_path(path)) {
        return reject(
            field,
            "is outside the closed color/typography/radius grammar",
        );
    }
    Ok(())
}

fn validate_font_stack(value: &str, field: &str) -> PairedV2ContractResult<()> {
    validate_text(value, PAIRED_V2_MAX_FONT_STACK_CHARS, field, true)?;
    if value
        .split(',')
        .any(|item| item.len() > PAIRED_V2_MAX_FONT_FAMILY_ITEM_CHARS)
    {
        return reject(field, "contains a font-stack item over its byte bound");
    }
    Ok(())
}

fn is_selection_path(path: &str) -> bool {
    is_color_path(path) && (path.ends_with(".selection") || path.ends_with(".selectionText"))
}

fn is_exact_rgb(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(|byte| byte.is_ascii_hexdigit())
}

fn is_nonnegative_unit_length(value: &str) -> bool {
    ["px", "rem", "em"].iter().any(|suffix| {
        let Some(number) = value.strip_suffix(suffix) else {
            return false;
        };
        let mut pieces = number.split('.');
        let Some(integer) = pieces.next() else {
            return false;
        };
        let fraction = pieces.next();
        !integer.is_empty()
            && integer.bytes().all(|byte| byte.is_ascii_digit())
            && fraction.is_none_or(|digits| {
                !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
            })
            && pieces.next().is_none()
    })
}

fn validate_edit_value(edit: &PairedV2Edit, field: &str) -> PairedV2ContractResult<()> {
    match edit {
        PairedV2Edit::SetColor { path, value } => {
            validate_edit_path(path, &format!("{field}.path"))?;
            if !is_color_path(path) {
                return reject(format!("{field}.path"), "set-color must use a color path");
            }
            validate_text(
                value,
                PAIRED_V2_MAX_HEX_VALUE_CHARS,
                &format!("{field}.value"),
                true,
            )?;
            if is_selection_path(path) && !is_exact_rgb(value) {
                return reject(
                    format!("{field}.value"),
                    "selection and selectionText require an exact #RRGGBB value",
                );
            }
            Ok(())
        }
        PairedV2Edit::SetTypography { path, value } => {
            validate_edit_path(path, &format!("{field}.path"))?;
            if !is_typography_path(path) {
                return reject(
                    format!("{field}.path"),
                    "set-typography must use a typography path",
                );
            }
            if path.ends_with(".family") {
                let PairedV2EditValue::Text(text) = value else {
                    return reject(
                        format!("{field}.value"),
                        "typography family must be a string",
                    );
                };
                if path == "typography.ui.family"
                    && !matches!(
                        text.as_str(),
                        "system-ui" | "monospace" | "sans-serif" | "serif"
                    )
                {
                    return reject(
                        format!("{field}.value"),
                        "typography.ui.family must use a closed system family",
                    );
                }
                return validate_font_stack(text, &format!("{field}.value"));
            }
            if path.ends_with(".size") {
                let PairedV2EditValue::Text(text) = value else {
                    return reject(format!("{field}.value"), "typography size must be a string");
                };
                return validate_text(
                    text,
                    PAIRED_V2_MAX_EXPLICIT_LENGTH_CHARS,
                    &format!("{field}.value"),
                    true,
                );
            }
            let PairedV2EditValue::Number(number) = value else {
                return reject(
                    format!("{field}.value"),
                    "typography lineHeight must be a number",
                );
            };
            if !number.is_finite()
                || *number <= 0.0
                || *number > PAIRED_V2_MAX_LINE_HEIGHT
                || number.abs() > PAIRED_V2_MAX_NUMERIC_EDIT_VALUE
            {
                return reject(
                    format!("{field}.value"),
                    "lineHeight must be finite, greater than zero, and at most ten",
                );
            }
            Ok(())
        }
        PairedV2Edit::SetRadius { path, value } => {
            validate_edit_path(path, &format!("{field}.path"))?;
            if !is_radius_path(path) {
                return reject(format!("{field}.path"), "set-radius must use a radius path");
            }
            validate_text(
                value,
                PAIRED_V2_MAX_EXPLICIT_LENGTH_CHARS,
                &format!("{field}.value"),
                true,
            )?;
            if path == "radius.surface" && !is_nonnegative_unit_length(value) {
                return reject(
                    format!("{field}.value"),
                    "radius.surface requires a non-negative px, rem, or em length",
                );
            }
            Ok(())
        }
        PairedV2Edit::ClearOptional { path } => {
            validate_edit_path(path, &format!("{field}.path"))?;
            if !is_clear_optional_path(path) {
                return reject(
                    format!("{field}.path"),
                    "clear-optional may only clear optional leaves",
                );
            }
            Ok(())
        }
    }
}

pub fn validate_edits(edits: &[PairedV2Edit]) -> PairedV2ContractResult<()> {
    if edits.len() > PAIRED_V2_MAX_EDIT_ENTRIES {
        return reject("edits", "exceeds the 64-entry bound");
    }
    let mut seen_paths = BTreeSet::new();
    let mut previous_path = None;
    for (index, edit) in edits.iter().enumerate() {
        let path = edit.path();
        let field = format!("edits[{index}]");
        validate_edit_path(path, &format!("{field}.path"))?;
        if let Some(previous_path) = previous_path
            && path <= previous_path
        {
            return reject(
                field,
                "must be strictly sorted by logical path with no duplicates",
            );
        }
        if !seen_paths.insert(path.to_owned()) {
            return reject(field, "contains a duplicate logical edit path");
        }
        validate_edit_value(edit, &field)?;
        previous_path = Some(path);
    }
    Ok(())
}

pub fn validate_compile_request_transport(
    request: &AppThemePairedCompileV2Request,
) -> PairedV2ContractResult<()> {
    validate_source(&request.source)?;
    validate_session_id(&request.session_id, "sessionId")?;
    validate_revision(request.ui_revision, "uiRevision")?;
    validate_edits(&request.edits)?;
    let size = serialized_len(request, "compileRequest")?;
    if size > PAIRED_V2_MAX_COMPILE_REQUEST_BYTES {
        return reject("compileRequest", "exceeds the 2 MiB transport bound");
    }
    Ok(())
}

pub fn validate_adapter_request_transport(
    request: &PairedV2AdapterCompileRequest,
) -> PairedV2ContractResult<()> {
    validate_source_base64(&request.raw_source_base64, "rawSourceBase64")?;
    validate_sha256(
        &request.expected_raw_source_sha256,
        "expectedRawSourceSha256",
    )?;
    validate_sha256(
        &request.expected_canonical_digest,
        "expectedCanonicalDigest",
    )?;
    validate_edits(&request.edits)?;
    validate_session_id(&request.session_id, "sessionId")?;
    validate_revision(request.ui_revision, "uiRevision")?;
    let size = serialized_len(request, "pairedV2Request")?;
    if size > PAIRED_V2_MAX_COMPILE_REQUEST_BYTES {
        return reject("pairedV2Request", "exceeds the 2 MiB transport bound");
    }
    Ok(())
}

pub fn validate_compile_request_for_session(
    request: &AppThemePairedCompileV2Request,
    expected_session_id: &str,
) -> PairedV2ContractResult<()> {
    validate_compile_request_transport(request)?;
    validate_session_id(expected_session_id, "expectedSessionId")?;
    if request.session_id != expected_session_id {
        return reject("sessionId", "does not match the active v2 session");
    }
    Ok(())
}

fn validate_session_id(value: &str, field: &str) -> PairedV2ContractResult<()> {
    validate_identifier(value, PAIRED_V2_MAX_SESSION_ID_CHARS, field)
}

fn validate_revision(value: u64, field: &str) -> PairedV2ContractResult<()> {
    if value > PAIRED_V2_MAX_REVISION {
        return reject(field, "exceeds the safe revision bound");
    }
    Ok(())
}

fn validate_diagnostic(diagnostic: &ThemeDiagnosticDto, field: &str) -> PairedV2ContractResult<()> {
    if !matches!(diagnostic.severity.as_str(), "error" | "warning" | "info") {
        return reject(format!("{field}.severity"), "is not a closed severity");
    }
    validate_text(
        &diagnostic.code,
        PAIRED_V2_MAX_DIAGNOSTIC_CODE_CHARS,
        &format!("{field}.code"),
        false,
    )?;
    validate_text(
        &diagnostic.message,
        PAIRED_V2_MAX_DIAGNOSTIC_MESSAGE_CHARS,
        &format!("{field}.message"),
        false,
    )?;
    if let Some(path) = diagnostic.path.as_deref() {
        validate_text(
            path,
            PAIRED_V2_MAX_PATH_CHARS,
            &format!("{field}.path"),
            false,
        )?;
    }
    Ok(())
}

fn validate_diagnostics(
    diagnostics: &[ThemeDiagnosticDto],
    field: &str,
) -> PairedV2ContractResult<()> {
    if diagnostics.len() > PAIRED_V2_MAX_DIAGNOSTIC_ENTRIES {
        return reject(field, "exceeds the diagnostic-entry bound");
    }
    for (index, diagnostic) in diagnostics.iter().enumerate() {
        validate_diagnostic(diagnostic, &format!("{field}[{index}]"))?;
    }
    if serialized_len(diagnostics, field)? > PAIRED_V2_MAX_DIAGNOSTICS_AND_FRAMING_BYTES {
        return reject(field, "exceeds the diagnostic allocation");
    }
    Ok(())
}

fn has_fatal_diagnostic(diagnostics: &[ThemeDiagnosticDto]) -> bool {
    diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == "error")
}

fn validate_adapter_identity(
    identity: &PairedV2AdapterIdentity,
    field: &str,
) -> PairedV2ContractResult<()> {
    validate_text(&identity.name, 256, &format!("{field}.name"), false)?;
    validate_text(&identity.version, 64, &format!("{field}.version"), false)?;
    Ok(())
}

fn validate_json_value(value: &PairedV2JsonValue, field: &str) -> PairedV2ContractResult<()> {
    if let PairedV2JsonValue::Number(number) = value {
        let finite = number.as_i64().is_some()
            || number.as_u64().is_some()
            || number.as_f64().is_some_and(f64::is_finite);
        if !finite {
            return reject(field, "contains a non-finite JSON number");
        }
    }
    match value {
        PairedV2JsonValue::String(text) => {
            validate_untrusted_json_string(text, field)?;
        }
        PairedV2JsonValue::Array(values) => {
            for (index, item) in values.iter().enumerate() {
                validate_json_value(item, &format!("{field}[{index}]"))?;
            }
        }
        PairedV2JsonValue::Object(values) => {
            for (key, item) in values {
                validate_text(key, PAIRED_V2_MAX_PATH_CHARS, field, false)?;
                validate_json_value(item, &format!("{field}.{key}"))?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn validate_mapping_report(
    report: &PairedV2MappingReport,
    field: &str,
) -> PairedV2ContractResult<()> {
    if report.schema != PairedV2MappingReportSchema::TfPairedMappingReportV2 {
        return reject(
            format!("{field}.schema"),
            "is not the v2 mapping report schema",
        );
    }
    if report.source_verification != PairedV2SourceVerification::SourceBytes {
        return reject(
            format!("{field}.sourceVerification"),
            "must be source-bytes",
        );
    }
    validate_text(&report.target, 64, &format!("{field}.target"), false)?;
    validate_text(
        &report.profile_name,
        PAIRED_V2_MAX_PROFILE_NAME_CHARS,
        &format!("{field}.profileName"),
        false,
    )?;
    validate_text(
        &report.profile_version,
        PAIRED_V2_MAX_PROFILE_VERSION_CHARS,
        &format!("{field}.profileVersion"),
        false,
    )?;
    validate_sha256(&report.source_sha256, &format!("{field}.sourceSha256"))?;
    validate_sha256(
        &report.canonical_digest,
        &format!("{field}.canonicalDigest"),
    )?;
    validate_adapter_identity(&report.adapter, &format!("{field}.adapter"))?;
    validate_adapter_identity(&report.compiler, &format!("{field}.compiler"))?;
    validate_json_value(&report.options, &format!("{field}.options"))?;
    if report.entries.len() > PAIRED_V2_MAX_MAPPING_ENTRIES {
        return reject(
            format!("{field}.entries"),
            "exceeds the mapping-entry bound",
        );
    }
    if report.groups.len() > PAIRED_V2_MAX_MAPPING_GROUPS {
        return reject(format!("{field}.groups"), "exceeds the mapping-group bound");
    }
    if report.defaults.len() > PAIRED_V2_MAX_MAPPING_DEFAULTS {
        return reject(
            format!("{field}.defaults"),
            "exceeds the mapping-default bound",
        );
    }
    for (index, entry) in report.entries.iter().enumerate() {
        let entry_field = format!("{field}.entries[{index}]");
        validate_text(
            &entry.source_path,
            PAIRED_V2_MAX_PATH_CHARS,
            &format!("{entry_field}.sourcePath"),
            false,
        )?;
        if let Some(reason) = entry.reason.as_deref() {
            validate_text(
                reason,
                PAIRED_V2_MAX_ERROR_MESSAGE_CHARS,
                &format!("{entry_field}.reason"),
                false,
            )?;
        }
        if let Some(target_path) = entry.target_path.as_deref() {
            validate_text(
                target_path,
                PAIRED_V2_MAX_PATH_CHARS,
                &format!("{entry_field}.targetPath"),
                false,
            )?;
        }
        if let Some(source_value) = entry.source_value.as_ref() {
            validate_json_value(source_value, &format!("{entry_field}.sourceValue"))?;
        }
        if let Some(target_value) = entry.target_value.as_ref() {
            validate_json_value(target_value, &format!("{entry_field}.targetValue"))?;
        }
    }
    for (index, group) in report.groups.iter().enumerate() {
        let group_field = format!("{field}.groups[{index}]");
        validate_text(&group.group, 128, &format!("{group_field}.group"), false)?;
        validate_text(
            &group.reason,
            PAIRED_V2_MAX_ERROR_MESSAGE_CHARS,
            &format!("{group_field}.reason"),
            false,
        )?;
    }
    for (index, default) in report.defaults.iter().enumerate() {
        let default_field = format!("{field}.defaults[{index}]");
        validate_text(
            &default.target_path,
            PAIRED_V2_MAX_PATH_CHARS,
            &format!("{default_field}.targetPath"),
            false,
        )?;
        validate_json_value(
            &default.target_value,
            &format!("{default_field}.targetValue"),
        )?;
        validate_text(
            &default.reason,
            PAIRED_V2_MAX_ERROR_MESSAGE_CHARS,
            &format!("{default_field}.reason"),
            false,
        )?;
    }
    for (name, count) in [
        ("totalSemanticLeaves", report.summary.total_semantic_leaves),
        ("consumed", report.summary.consumed),
        ("normalized", report.summary.normalized),
        ("overridden", report.summary.overridden),
        ("targetSpecific", report.summary.target_specific),
        ("unsupported", report.summary.unsupported),
        (
            "generatedDefaultsCount",
            report.summary.generated_defaults_count,
        ),
    ] {
        if count > MAX_SUMMARY_COUNT {
            return reject(
                format!("{field}.summary.{name}"),
                "exceeds the bounded summary count",
            );
        }
    }
    validate_sha256(&report.digest, &format!("{field}.digest"))?;
    if serialized_len(report, field)? > PAIRED_V2_MAX_MAPPING_REPORT_BYTES {
        return reject(field, "exceeds the mapping-report allocation");
    }
    Ok(())
}

fn mapping_report_has_partial_disposition(report: &PairedV2MappingReport) -> bool {
    report.entries.iter().any(|entry| {
        matches!(
            entry.classification,
            PairedV2MappingClassification::Normalized
                | PairedV2MappingClassification::TargetSpecific
                | PairedV2MappingClassification::Unsupported
        )
    }) || report.summary.normalized > 0
        || report.summary.target_specific > 0
        || report.summary.unsupported > 0
}

fn validate_application_mapping_report(
    report: &PairedV2ApplicationMappingReport,
    field: &str,
) -> PairedV2ContractResult<()> {
    if report.schema
        != PairedV2ApplicationMappingReportSchema::ThemeForgeApplicationAppearanceExtensionV1
    {
        return reject(
            format!("{field}.schema"),
            "is not the application extension schema",
        );
    }
    if report.entries.len() > PAIRED_V2_MAX_MAPPING_GROUPS {
        return reject(
            format!("{field}.entries"),
            "exceeds the application-entry bound",
        );
    }
    for (index, entry) in report.entries.iter().enumerate() {
        let entry_field = format!("{field}.entries[{index}]");
        validate_text(
            &entry.source_path,
            PAIRED_V2_MAX_PATH_CHARS,
            &format!("{entry_field}.sourcePath"),
            false,
        )?;
        validate_text(
            &entry.target,
            PAIRED_V2_MAX_PATH_CHARS,
            &format!("{entry_field}.target"),
            false,
        )?;
        validate_json_value(&entry.value, &format!("{entry_field}.value"))?;
    }
    validate_text(
        &report.scope,
        PAIRED_V2_MAX_ERROR_MESSAGE_CHARS,
        &format!("{field}.scope"),
        false,
    )?;
    if serialized_len(report, field)? > PAIRED_V2_MAX_MAPPING_REPORT_BYTES {
        return reject(field, "exceeds the mapping-report allocation");
    }
    Ok(())
}

fn validate_draft(draft: &PairedV2Draft) -> PairedV2ContractResult<()> {
    if draft.profile.schema_version != "tf-paired-profile-v2" {
        return reject(
            "draft.profile.schemaVersion",
            "must be tf-paired-profile-v2",
        );
    }
    validate_text(
        &draft.profile.name,
        PAIRED_V2_MAX_PROFILE_NAME_CHARS,
        "draft.profile.name",
        false,
    )?;
    validate_text(
        &draft.profile.version,
        PAIRED_V2_MAX_PROFILE_VERSION_CHARS,
        "draft.profile.version",
        false,
    )?;
    let profile_bytes = serde_json::to_vec(&draft.profile)
        .map_err(|_| PairedV2ContractError::new("draft.profile", "must be JSON-serializable"))?;
    let profile_json: PairedV2JsonValue = serde_json::from_slice(&profile_bytes).map_err(|_| {
        PairedV2ContractError::new("draft.profile", "must use bounded literal JSON")
    })?;
    validate_json_value(&profile_json, "draft.profile")?;
    validate_source_base64(&draft.source_bytes_base64, "draft.sourceBytesBase64")?;
    validate_sha256(&draft.raw_source_sha256, "draft.rawSourceSha256")?;
    validate_sha256(&draft.canonical_digest, "draft.canonicalDigest")?;
    validate_sha256(
        &draft.baseline_raw_source_sha256,
        "draft.baselineRawSourceSha256",
    )?;
    validate_sha256(
        &draft.baseline_canonical_digest,
        "draft.baselineCanonicalDigest",
    )?;
    if draft.is_transformed {
        if draft.verification_status != PairedV2VerificationStatus::Transformed {
            return reject(
                "draft.verificationStatus",
                "must be transformed for a transformed draft",
            );
        }
        let Some(parent) = draft.parent_source_sha256.as_deref() else {
            return reject(
                "draft.parentSourceSha256",
                "is required for a transformed draft",
            );
        };
        validate_sha256(parent, "draft.parentSourceSha256")?;
        if parent != draft.baseline_raw_source_sha256 {
            return reject(
                "draft.parentSourceSha256",
                "must equal the immutable baseline raw identity",
            );
        }
        if draft.raw_source_sha256.as_str() == parent {
            return reject(
                "draft.rawSourceSha256",
                "a transformed draft cannot self-parent the baseline",
            );
        }
    } else {
        if draft.verification_status != PairedV2VerificationStatus::Verified {
            return reject(
                "draft.verificationStatus",
                "must be verified for an untransformed draft",
            );
        }
        if draft.parent_source_sha256.is_some() {
            return reject(
                "draft.parentSourceSha256",
                "must be omitted for an untransformed draft",
            );
        }
        if draft.raw_source_sha256.as_str() != draft.baseline_raw_source_sha256.as_str()
            || draft.canonical_digest.as_str() != draft.baseline_canonical_digest.as_str()
        {
            return reject(
                "draft",
                "an untransformed draft must retain the exact immutable baseline identity",
            );
        }
    }
    if serialized_len(&draft.profile, "draft.profile")? > PAIRED_V2_MAX_PROFILE_JSON_BYTES {
        return reject("draft.profile", "exceeds the profile JSON allocation");
    }
    Ok(())
}

fn validate_target_result(
    result: &PairedV2TargetCompileResult,
    field: &str,
    css_limit: usize,
) -> PairedV2ContractResult<()> {
    validate_sha256(
        &result.source_profile_sha256,
        &format!("{field}.sourceProfileSha256"),
    )?;
    validate_sha256(
        &result.canonical_digest,
        &format!("{field}.canonicalDigest"),
    )?;
    validate_diagnostics(&result.diagnostics, &format!("{field}.diagnostics"))?;
    validate_mapping_report(&result.mapping_report, &format!("{field}.mappingReport"))?;
    let expected_target = match field {
        "solarSail" => Some("solar-sail"),
        "stellarLoom" => Some("stellar-loom"),
        _ => None,
    };
    if expected_target != Some(result.mapping_report.target.as_str()) {
        return reject(
            format!("{field}.mappingReport.target"),
            "does not match the target result",
        );
    }
    if result.mapping_report.source_sha256 != result.source_profile_sha256 {
        return reject(
            format!("{field}.mappingReport.sourceSha256"),
            "does not match the target source identity",
        );
    }
    if result.mapping_report.canonical_digest != result.canonical_digest {
        return reject(
            format!("{field}.mappingReport.canonicalDigest"),
            "does not match the target canonical identity",
        );
    }
    if let Some(css) = result.compiled_css.as_deref() {
        if css.is_empty() || css.len() > css_limit {
            return reject(
                format!("{field}.compiledCss"),
                "exceeds its CSS field allocation",
            );
        }
    } else if result.valid {
        return reject(
            format!("{field}.compiledCss"),
            "is required for a valid target result",
        );
    }
    Ok(())
}

fn validate_application_result(
    result: &PairedV2ApplicationExtensionResult,
) -> PairedV2ContractResult<()> {
    validate_sha256(
        &result.source_profile_sha256,
        "applicationExtension.sourceProfileSha256",
    )?;
    validate_sha256(
        &result.canonical_digest,
        "applicationExtension.canonicalDigest",
    )?;
    validate_diagnostics(&result.diagnostics, "applicationExtension.diagnostics")?;
    validate_application_mapping_report(
        &result.mapping_report,
        "applicationExtension.mappingReport",
    )?;
    if let Some(css) = result.compiled_css.as_deref() {
        if css.is_empty() {
            return reject(
                "applicationExtension.compiledCss",
                "must be non-empty when present",
            );
        }
    } else if result.valid {
        return reject(
            "applicationExtension.compiledCss",
            "is required for a valid application extension result",
        );
    }
    let css_bytes = result.compiled_css.as_deref().map_or(0, |css| css.len());
    let report_bytes =
        serialized_len(&result.mapping_report, "applicationExtension.mappingReport")?;
    if css_bytes + report_bytes > PAIRED_V2_MAX_APPLICATION_EXTENSION_BYTES {
        return reject(
            "applicationExtension",
            "exceeds the combined CSS and report allocation",
        );
    }
    Ok(())
}

fn validate_application_appearance_result(
    result: &PairedV2ApplicationAppearanceResult,
) -> PairedV2ContractResult<()> {
    validate_sha256(
        &result.source_profile_sha256,
        "applicationAppearance.sourceProfileSha256",
    )?;
    validate_sha256(
        &result.canonical_digest,
        "applicationAppearance.canonicalDigest",
    )?;
    if !result.valid
        || result.compiled_css.is_empty()
        || result.compiled_css.len() > PAIRED_V2_MAX_APPLICATION_APPEARANCE_CSS_BYTES
    {
        return reject(
            "applicationAppearance.compiledCss",
            "exceeds the application appearance CSS allocation",
        );
    }
    Ok(())
}

fn validate_error(error: &PairedV2Error, field: &str) -> PairedV2ContractResult<()> {
    validate_text(
        &error.code,
        PAIRED_V2_MAX_ERROR_CODE_CHARS,
        &format!("{field}.code"),
        false,
    )?;
    validate_text(
        &error.message,
        PAIRED_V2_MAX_ERROR_MESSAGE_CHARS,
        &format!("{field}.message"),
        false,
    )?;
    if let Some(path) = error.path.as_deref() {
        validate_text(
            path,
            PAIRED_V2_MAX_PATH_CHARS,
            &format!("{field}.path"),
            false,
        )?;
    }
    Ok(())
}

fn validate_shared_diagnostics(
    diagnostics: &[ThemeDiagnosticDto],
    solar: &[ThemeDiagnosticDto],
    loom: &[ThemeDiagnosticDto],
    application: &[ThemeDiagnosticDto],
) -> PairedV2ContractResult<()> {
    let value = (diagnostics, solar, loom, application);
    if serialized_len(&value, "compileResponse.diagnostics")?
        > PAIRED_V2_MAX_DIAGNOSTICS_AND_FRAMING_BYTES
    {
        return reject(
            "compileResponse.diagnostics",
            "exceeds the combined diagnostics allocation",
        );
    }
    Ok(())
}

#[derive(Debug)]
struct SuccessResponseFields<'a> {
    status: &'a str,
    valid: bool,
    ui_revision: u64,
    session_id: &'a str,
    draft: &'a PairedV2Draft,
    solar_sail: &'a PairedV2TargetCompileResult,
    stellar_loom: &'a PairedV2TargetCompileResult,
    application_appearance: &'a PairedV2ApplicationAppearanceResult,
    application_extension: &'a PairedV2ApplicationExtensionResult,
    diagnostics: &'a [ThemeDiagnosticDto],
}

fn validate_success_response_fields(
    fields: SuccessResponseFields<'_>,
) -> PairedV2ContractResult<()> {
    if !fields.valid {
        return reject(
            "valid",
            "success and partial responses must set valid to true",
        );
    }
    validate_session_id(fields.session_id, "sessionId")?;
    validate_revision(fields.ui_revision, "uiRevision")?;
    validate_draft(fields.draft)?;
    validate_target_result(
        fields.solar_sail,
        "solarSail",
        PAIRED_V2_MAX_SOLAR_CSS_BYTES,
    )?;
    validate_target_result(
        fields.stellar_loom,
        "stellarLoom",
        PAIRED_V2_MAX_LOOM_CSS_BYTES,
    )?;
    validate_application_appearance_result(fields.application_appearance)?;
    validate_application_result(fields.application_extension)?;
    validate_diagnostics(fields.diagnostics, "diagnostics")?;
    validate_shared_diagnostics(
        fields.diagnostics,
        &fields.solar_sail.diagnostics,
        &fields.stellar_loom.diagnostics,
        &fields.application_extension.diagnostics,
    )?;
    if !fields.solar_sail.valid
        || !fields.stellar_loom.valid
        || !fields.application_appearance.valid
        || !fields.application_extension.valid
    {
        return reject(
            "status",
            "success or partial requires all target results to be valid",
        );
    }
    for (field, report) in [
        ("solarSail", &fields.solar_sail.mapping_report),
        ("stellarLoom", &fields.stellar_loom.mapping_report),
    ] {
        if report.profile_name.as_str() != fields.draft.profile.name.as_str() {
            return reject(
                format!("{field}.mappingReport.profileName"),
                "does not match the returned draft profile",
            );
        }
        if report.profile_version.as_str() != fields.draft.profile.version.as_str() {
            return reject(
                format!("{field}.mappingReport.profileVersion"),
                "does not match the returned draft profile",
            );
        }
    }
    let has_partial_disposition =
        mapping_report_has_partial_disposition(&fields.solar_sail.mapping_report)
            || mapping_report_has_partial_disposition(&fields.stellar_loom.mapping_report);
    if (fields.status == "partial") != has_partial_disposition {
        return reject("status", "does not match the target mapping dispositions");
    }
    if has_fatal_diagnostic(fields.diagnostics)
        || has_fatal_diagnostic(&fields.solar_sail.diagnostics)
        || has_fatal_diagnostic(&fields.stellar_loom.diagnostics)
        || has_fatal_diagnostic(&fields.application_extension.diagnostics)
    {
        return reject(
            "status",
            "success or partial cannot contain fatal diagnostics",
        );
    }
    for (field, raw, canonical) in [
        (
            "solarSail",
            &fields.solar_sail.source_profile_sha256,
            &fields.solar_sail.canonical_digest,
        ),
        (
            "stellarLoom",
            &fields.stellar_loom.source_profile_sha256,
            &fields.stellar_loom.canonical_digest,
        ),
        (
            "applicationAppearance",
            &fields.application_appearance.source_profile_sha256,
            &fields.application_appearance.canonical_digest,
        ),
        (
            "applicationExtension",
            &fields.application_extension.source_profile_sha256,
            &fields.application_extension.canonical_digest,
        ),
    ] {
        if raw != &fields.draft.raw_source_sha256 {
            return reject(
                format!("{field}.sourceProfileSha256"),
                "does not match draft.rawSourceSha256",
            );
        }
        if canonical != &fields.draft.canonical_digest {
            return reject(
                format!("{field}.canonicalDigest"),
                "does not match draft.canonicalDigest",
            );
        }
    }
    if fields.status != "success" && fields.status != "partial" {
        return reject("status", "is not a success or partial response");
    }
    Ok(())
}

#[derive(Debug)]
struct FailureResponseFields<'a> {
    ui_revision: u64,
    valid: bool,
    session_id: &'a str,
    draft: &'a Option<PairedV2Draft>,
    solar_sail: &'a Option<PairedV2TargetCompileResult>,
    stellar_loom: &'a Option<PairedV2TargetCompileResult>,
    application_appearance: &'a Option<PairedV2ApplicationAppearanceResult>,
    application_extension: &'a Option<PairedV2ApplicationExtensionResult>,
    diagnostics: &'a [ThemeDiagnosticDto],
    error: &'a Option<PairedV2Error>,
}

fn validate_failure_response_fields(
    fields: FailureResponseFields<'_>,
) -> PairedV2ContractResult<()> {
    if fields.valid {
        return reject(
            "valid",
            "stale, cancelled, and error responses must set valid to false",
        );
    }
    validate_session_id(fields.session_id, "sessionId")?;
    validate_revision(fields.ui_revision, "uiRevision")?;
    if fields.draft.is_some() {
        return reject("draft", "failure responses cannot carry a draft");
    }
    if fields.solar_sail.is_some()
        || fields.stellar_loom.is_some()
        || fields.application_appearance.is_some()
        || fields.application_extension.is_some()
    {
        return reject(
            "targetResults",
            "failure responses must use null target results",
        );
    }
    validate_diagnostics(fields.diagnostics, "diagnostics")?;
    if let Some(error) = fields.error.as_ref() {
        validate_error(error, "error")?;
    }
    validate_shared_diagnostics(fields.diagnostics, &[], &[], &[])?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PairedV2AuxiliaryDraft<'a> {
    raw_source_sha256: &'a str,
    canonical_digest: &'a str,
    baseline_raw_source_sha256: &'a str,
    baseline_canonical_digest: &'a str,
    verification_status: PairedV2VerificationStatus,
    is_transformed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    parent_source_sha256: Option<&'a str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PairedV2AuxiliaryTarget<'a> {
    valid: bool,
    source_profile_sha256: &'a str,
    canonical_digest: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PairedV2AuxiliarySuccess<'a> {
    valid: bool,
    ui_revision: u64,
    session_id: &'a str,
    draft: PairedV2AuxiliaryDraft<'a>,
    solar_sail: PairedV2AuxiliaryTarget<'a>,
    stellar_loom: PairedV2AuxiliaryTarget<'a>,
    application_appearance: PairedV2AuxiliaryTarget<'a>,
    application_extension: PairedV2AuxiliaryTarget<'a>,
    diagnostics: &'a [ThemeDiagnosticDto],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PairedV2AuxiliaryFailure<'a> {
    valid: bool,
    ui_revision: u64,
    session_id: &'a str,
    diagnostics: &'a [ThemeDiagnosticDto],
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'a PairedV2Error>,
}

fn validate_response_auxiliary(
    response: &AppThemePairedCompileV2Response,
) -> PairedV2ContractResult<()> {
    let auxiliary_bytes = match response {
        AppThemePairedCompileV2Response::Success {
            valid,
            ui_revision,
            session_id,
            draft,
            solar_sail,
            stellar_loom,
            application_appearance,
            application_extension,
            diagnostics,
        }
        | AppThemePairedCompileV2Response::Partial {
            valid,
            ui_revision,
            session_id,
            draft,
            solar_sail,
            stellar_loom,
            application_appearance,
            application_extension,
            diagnostics,
        } => serialized_len(
            &PairedV2AuxiliarySuccess {
                valid: *valid,
                ui_revision: *ui_revision,
                session_id,
                draft: PairedV2AuxiliaryDraft {
                    raw_source_sha256: &draft.raw_source_sha256,
                    canonical_digest: &draft.canonical_digest,
                    baseline_raw_source_sha256: &draft.baseline_raw_source_sha256,
                    baseline_canonical_digest: &draft.baseline_canonical_digest,
                    verification_status: draft.verification_status,
                    is_transformed: draft.is_transformed,
                    parent_source_sha256: draft.parent_source_sha256.as_deref(),
                },
                solar_sail: PairedV2AuxiliaryTarget {
                    valid: solar_sail.valid,
                    source_profile_sha256: &solar_sail.source_profile_sha256,
                    canonical_digest: &solar_sail.canonical_digest,
                },
                stellar_loom: PairedV2AuxiliaryTarget {
                    valid: stellar_loom.valid,
                    source_profile_sha256: &stellar_loom.source_profile_sha256,
                    canonical_digest: &stellar_loom.canonical_digest,
                },
                application_appearance: PairedV2AuxiliaryTarget {
                    valid: application_appearance.valid,
                    source_profile_sha256: &application_appearance.source_profile_sha256,
                    canonical_digest: &application_appearance.canonical_digest,
                },
                application_extension: PairedV2AuxiliaryTarget {
                    valid: application_extension.valid,
                    source_profile_sha256: &application_extension.source_profile_sha256,
                    canonical_digest: &application_extension.canonical_digest,
                },
                diagnostics,
            },
            "compileResponse.auxiliary",
        )?,
        AppThemePairedCompileV2Response::Stale {
            valid,
            ui_revision,
            session_id,
            diagnostics,
            error,
            ..
        }
        | AppThemePairedCompileV2Response::Cancelled {
            valid,
            ui_revision,
            session_id,
            diagnostics,
            error,
            ..
        }
        | AppThemePairedCompileV2Response::Error {
            valid,
            ui_revision,
            session_id,
            diagnostics,
            error,
            ..
        } => serialized_len(
            &PairedV2AuxiliaryFailure {
                valid: *valid,
                ui_revision: *ui_revision,
                session_id,
                diagnostics,
                error: error.as_ref(),
            },
            "compileResponse.auxiliary",
        )?,
    };
    if auxiliary_bytes > PAIRED_V2_MAX_DIAGNOSTICS_AND_FRAMING_BYTES {
        return reject(
            "compileResponse.auxiliary",
            "exceeds the diagnostics/identity/error/framing allocation",
        );
    }
    Ok(())
}

pub fn validate_compile_response_transport(
    response: &AppThemePairedCompileV2Response,
) -> PairedV2ContractResult<()> {
    match response {
        AppThemePairedCompileV2Response::Success {
            valid,
            ui_revision,
            session_id,
            draft,
            solar_sail,
            stellar_loom,
            application_appearance,
            application_extension,
            diagnostics,
        } => validate_success_response_fields(SuccessResponseFields {
            status: "success",
            valid: *valid,
            ui_revision: *ui_revision,
            session_id,
            draft,
            solar_sail,
            stellar_loom,
            application_appearance,
            application_extension,
            diagnostics,
        })?,
        AppThemePairedCompileV2Response::Partial {
            valid,
            ui_revision,
            session_id,
            draft,
            solar_sail,
            stellar_loom,
            application_appearance,
            application_extension,
            diagnostics,
        } => validate_success_response_fields(SuccessResponseFields {
            status: "partial",
            valid: *valid,
            ui_revision: *ui_revision,
            session_id,
            draft,
            solar_sail,
            stellar_loom,
            application_appearance,
            application_extension,
            diagnostics,
        })?,
        AppThemePairedCompileV2Response::Stale {
            valid,
            ui_revision,
            session_id,
            draft,
            solar_sail,
            stellar_loom,
            application_appearance,
            application_extension,
            diagnostics,
            error,
            ..
        }
        | AppThemePairedCompileV2Response::Cancelled {
            valid,
            ui_revision,
            session_id,
            draft,
            solar_sail,
            stellar_loom,
            application_appearance,
            application_extension,
            diagnostics,
            error,
            ..
        }
        | AppThemePairedCompileV2Response::Error {
            valid,
            ui_revision,
            session_id,
            draft,
            solar_sail,
            stellar_loom,
            application_appearance,
            application_extension,
            diagnostics,
            error,
            ..
        } => validate_failure_response_fields(FailureResponseFields {
            ui_revision: *ui_revision,
            valid: *valid,
            session_id,
            draft,
            solar_sail,
            stellar_loom,
            application_appearance,
            application_extension,
            diagnostics,
            error,
        })?,
    }

    if let AppThemePairedCompileV2Response::Success {
        draft,
        solar_sail,
        stellar_loom,
        application_appearance,
        application_extension,
        ..
    }
    | AppThemePairedCompileV2Response::Partial {
        draft,
        solar_sail,
        stellar_loom,
        application_appearance,
        application_extension,
        ..
    } = response
    {
        if draft.source_bytes_base64.len() > PAIRED_V2_MAX_SOURCE_BASE64_CHARS {
            return reject("draft.sourceBytesBase64", "exceeds its response allocation");
        }
        let target_report_bytes =
            serialized_len(&solar_sail.mapping_report, "solarSail.mappingReport")?;
        if target_report_bytes > PAIRED_V2_MAX_MAPPING_REPORT_BYTES {
            return reject("solarSail.mappingReport", "exceeds its response allocation");
        }
        let loom_report_bytes =
            serialized_len(&stellar_loom.mapping_report, "stellarLoom.mappingReport")?;
        if loom_report_bytes > PAIRED_V2_MAX_MAPPING_REPORT_BYTES {
            return reject(
                "stellarLoom.mappingReport",
                "exceeds its response allocation",
            );
        }
        let profile_bytes = serialized_len(&draft.profile, "draft.profile")?;
        if profile_bytes > PAIRED_V2_MAX_PROFILE_JSON_BYTES {
            return reject("draft.profile", "exceeds its response allocation");
        }
        if application_appearance.compiled_css.len()
            > PAIRED_V2_MAX_APPLICATION_APPEARANCE_CSS_BYTES
        {
            return reject(
                "applicationAppearance.compiledCss",
                "exceeds its response allocation",
            );
        }
        let application_report_bytes = serialized_len(
            &application_extension.mapping_report,
            "applicationExtension.mappingReport",
        )?;
        let application_css_bytes = application_extension
            .compiled_css
            .as_deref()
            .map_or(0, |css| css.len());
        if application_report_bytes + application_css_bytes
            > PAIRED_V2_MAX_APPLICATION_EXTENSION_BYTES
        {
            return reject(
                "applicationExtension",
                "exceeds its combined CSS and report allocation",
            );
        }
    }
    let total = serialized_len(response, "compileResponse")?;
    if total > PAIRED_V2_MAX_RESPONSE_BYTES {
        return reject("compileResponse", "exceeds the 2 MiB response budget");
    }
    validate_response_auxiliary(response)
}

pub fn validate_compile_response_for_session(
    response: &AppThemePairedCompileV2Response,
    expected_session_id: &str,
    expected_ui_revision: u64,
) -> PairedV2ContractResult<()> {
    validate_compile_response_transport(response)?;
    let (session_id, ui_revision) = match response {
        AppThemePairedCompileV2Response::Success {
            session_id,
            ui_revision,
            ..
        }
        | AppThemePairedCompileV2Response::Partial {
            session_id,
            ui_revision,
            ..
        }
        | AppThemePairedCompileV2Response::Stale {
            session_id,
            ui_revision,
            ..
        }
        | AppThemePairedCompileV2Response::Cancelled {
            session_id,
            ui_revision,
            ..
        }
        | AppThemePairedCompileV2Response::Error {
            session_id,
            ui_revision,
            ..
        } => (session_id, *ui_revision),
    };
    validate_session_id(expected_session_id, "expectedSessionId")?;
    if session_id != expected_session_id {
        return reject("sessionId", "does not match the active v2 session");
    }
    if ui_revision != expected_ui_revision {
        return reject("uiRevision", "does not match the requested revision");
    }
    Ok(())
}

pub fn validate_save_request_transport(
    request: &AppThemeSaveProfileV2Request,
) -> PairedV2ContractResult<()> {
    validate_session_id(&request.session_id, "sessionId")?;
    if let Some(document_id) = request.document_id.as_deref() {
        validate_identifier(document_id, PAIRED_V2_MAX_DOCUMENT_ID_CHARS, "documentId")?;
    }
    validate_source_base64(&request.draft_source_base64, "draftSourceBase64")?;
    validate_sha256(
        &request.expected_draft_raw_source_sha256,
        "expectedDraftRawSourceSha256",
    )?;
    validate_sha256(
        &request.expected_canonical_digest,
        "expectedCanonicalDigest",
    )?;
    if let Some(parent) = request.expected_parent_source_sha256.as_deref() {
        validate_sha256(parent, "expectedParentSourceSha256")?;
    }
    validate_sha256(
        &request.expected_compile_raw_source_sha256,
        "expectedCompileRawSourceSha256",
    )?;
    validate_sha256(
        &request.expected_compile_canonical_digest,
        "expectedCompileCanonicalDigest",
    )?;
    validate_revision(
        request.expected_compile_ui_revision,
        "expectedCompileUiRevision",
    )?;
    validate_revision(request.ui_revision, "uiRevision")?;
    match request.save_mode {
        PairedV2SaveMode::Edited => {
            if request.document_id.is_none() || request.expected_parent_source_sha256.is_none() {
                return reject(
                    "saveMode",
                    "edited requires documentId and expectedParentSourceSha256",
                );
            }
        }
        PairedV2SaveMode::NewDocument => {
            if request.document_id.is_some() || request.expected_parent_source_sha256.is_some() {
                return reject(
                    "saveMode",
                    "new-document must omit documentId and expectedParentSourceSha256",
                );
            }
        }
    }
    let size = serialized_len(request, "saveRequest")?;
    if size > PAIRED_V2_MAX_COMPILE_REQUEST_BYTES {
        return reject("saveRequest", "exceeds the 2 MiB transport bound");
    }
    Ok(())
}

pub fn validate_save_request_against_latest(
    request: &AppThemeSaveProfileV2Request,
    latest: &PairedV2LatestCompileClaim,
) -> PairedV2ContractResult<()> {
    validate_save_request_transport(request)?;
    validate_revision(latest.ui_revision, "latest.uiRevision")?;
    validate_sha256(&latest.raw_source_sha256, "latest.rawSourceSha256")?;
    validate_sha256(&latest.canonical_digest, "latest.canonicalDigest")?;
    if request.expected_compile_raw_source_sha256 != latest.raw_source_sha256
        || request.expected_draft_raw_source_sha256 != latest.raw_source_sha256
    {
        return reject(
            "expectedCompileRawSourceSha256",
            "does not match the latest successful compile",
        );
    }
    if request.expected_compile_canonical_digest != latest.canonical_digest
        || request.expected_canonical_digest != latest.canonical_digest
    {
        return reject(
            "expectedCompileCanonicalDigest",
            "does not match the latest successful compile",
        );
    }
    if request.expected_compile_ui_revision != latest.ui_revision
        || request.ui_revision != latest.ui_revision
    {
        return reject("uiRevision", "does not match the latest successful compile");
    }
    Ok(())
}

pub fn validate_save_request_for_session(
    request: &AppThemeSaveProfileV2Request,
    expected_session_id: &str,
    latest: &PairedV2LatestCompileClaim,
    active_document: Option<&PairedV2ActiveDocumentClaim>,
) -> PairedV2ContractResult<()> {
    validate_save_request_against_latest(request, latest)?;
    validate_session_id(expected_session_id, "expectedSessionId")?;
    if request.session_id != expected_session_id {
        return reject("sessionId", "does not match the active v2 session");
    }
    if request.save_mode == PairedV2SaveMode::Edited {
        let Some(active_document) = active_document else {
            return reject(
                "documentId",
                "edited save requires an active custody document",
            );
        };
        validate_identifier(
            &active_document.document_id,
            PAIRED_V2_MAX_DOCUMENT_ID_CHARS,
            "activeDocument.documentId",
        )?;
        validate_sha256(
            &active_document.raw_source_sha256,
            "activeDocument.rawSourceSha256",
        )?;
        if request.document_id.as_deref() != Some(active_document.document_id.as_str()) {
            return reject("documentId", "does not match the active custody document");
        }
        if request.expected_parent_source_sha256.as_deref()
            != Some(active_document.raw_source_sha256.as_str())
        {
            return reject(
                "expectedParentSourceSha256",
                "does not match the active custody source",
            );
        }
    }
    Ok(())
}

fn validate_saved_document(document: &PairedV2SavedDocument) -> PairedV2ContractResult<()> {
    validate_identifier(
        &document.document_id,
        PAIRED_V2_MAX_DOCUMENT_ID_CHARS,
        "document.documentId",
    )?;
    validate_sha256(&document.raw_source_sha256, "document.rawSourceSha256")?;
    validate_sha256(&document.canonical_digest, "document.canonicalDigest")?;
    validate_identifier(
        &document.display_name,
        PAIRED_V2_MAX_DOCUMENT_ID_CHARS,
        "document.displayName",
    )
}

pub fn validate_save_response_transport(
    response: &AppThemeSaveProfileV2Response,
) -> PairedV2ContractResult<()> {
    validate_session_id(&response.session_id, "sessionId")?;
    validate_revision(response.ui_revision, "uiRevision")?;
    if let Some(document) = response.document.as_ref() {
        validate_saved_document(document)?;
    }
    if let Some(error) = response.error.as_ref() {
        validate_error(error, "error")?;
    }
    if response.saved && response.cancelled {
        return reject("saveResponse", "cannot be both saved and cancelled");
    }
    if response.saved {
        if response.document.is_none() || response.error.is_some() {
            return reject("saveResponse", "saved requires a document and no error");
        }
    } else if response.cancelled {
        if response.document.is_some() || response.error.is_some() {
            return reject(
                "saveResponse",
                "cancelled responses cannot contain a document or error",
            );
        }
    } else if response.error.is_none() {
        return reject(
            "saveResponse",
            "an unsaved non-cancelled response requires an error",
        );
    }
    if serialized_len(response, "saveResponse")? > PAIRED_V2_MAX_RESPONSE_BYTES {
        return reject("saveResponse", "exceeds the 2 MiB response budget");
    }
    Ok(())
}

pub fn validate_save_response_for_session(
    response: &AppThemeSaveProfileV2Response,
    expected_session_id: &str,
    expected_ui_revision: u64,
) -> PairedV2ContractResult<()> {
    validate_save_response_transport(response)?;
    validate_session_id(expected_session_id, "expectedSessionId")?;
    if response.session_id != expected_session_id {
        return reject("sessionId", "does not match the active v2 session");
    }
    if response.ui_revision != expected_ui_revision {
        return reject("uiRevision", "does not match the active save revision");
    }
    Ok(())
}

pub fn validate_paired_v2_authoring_capability(
    capability: &PairedV2AuthoringCapability,
) -> PairedV2ContractResult<()> {
    if !capability.supported {
        return reject(
            "pairedV2Authoring.supported",
            "must be true when the capability is advertised",
        );
    }
    validate_session_id(&capability.session_id, "pairedV2Authoring.sessionId")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hash(ch: char) -> String {
        std::iter::repeat_n(ch, 64).collect()
    }

    fn detached_source() -> AppThemePairedCompileV2Source {
        AppThemePairedCompileV2Source {
            document_id: None,
            raw_source_base64: Some("eA==".to_owned()),
            expected_raw_source_sha256: hash('a'),
            expected_canonical_digest: hash('b'),
        }
    }

    fn sample_request() -> AppThemePairedCompileV2Request {
        AppThemePairedCompileV2Request {
            source: detached_source(),
            edits: vec![PairedV2Edit::SetColor {
                path: "color.dark.primaryAction".to_owned(),
                value: "#123456".to_owned(),
            }],
            ui_revision: 3,
            session_id: "v2-session".to_owned(),
        }
    }

    fn sample_report() -> PairedV2MappingReport {
        PairedV2MappingReport {
            schema: PairedV2MappingReportSchema::TfPairedMappingReportV2,
            target: "solar-sail".to_owned(),
            profile_name: "developer".to_owned(),
            profile_version: "0.1.0".to_owned(),
            source_sha256: hash('a'),
            source_verification: PairedV2SourceVerification::SourceBytes,
            canonical_digest: hash('b'),
            adapter: PairedV2AdapterIdentity {
                name: "solar-adapter".to_owned(),
                version: "0.2.0".to_owned(),
            },
            compiler: PairedV2AdapterIdentity {
                name: "solar".to_owned(),
                version: "0.3.0".to_owned(),
            },
            options: PairedV2JsonValue::Object(BTreeMap::new()),
            entries: vec![],
            groups: vec![],
            defaults: vec![],
            summary: PairedV2MappingSummary {
                total_semantic_leaves: 1,
                unsupported: 1,
                ..PairedV2MappingSummary::default()
            },
            digest: hash('c'),
        }
    }

    fn sample_application_report() -> PairedV2ApplicationMappingReport {
        PairedV2ApplicationMappingReport {
            schema:
                PairedV2ApplicationMappingReportSchema::ThemeForgeApplicationAppearanceExtensionV1,
            entries: vec![],
            scope: "application-only".to_owned(),
        }
    }

    fn sample_success_response() -> AppThemePairedCompileV2Response {
        let profile = PairedProfileV2DocumentDto {
            schema_version: "tf-paired-profile-v2".to_owned(),
            name: "developer".to_owned(),
            version: "0.1.0".to_owned(),
            ..PairedProfileV2DocumentDto::default()
        };
        let target = PairedV2TargetCompileResult {
            valid: true,
            compiled_css: Some("body{}".to_owned()),
            diagnostics: vec![],
            mapping_report: PairedV2MappingReport {
                source_sha256: hash('c'),
                ..sample_report()
            },
            source_profile_sha256: hash('c'),
            canonical_digest: hash('b'),
        };
        let application = PairedV2ApplicationExtensionResult {
            valid: true,
            compiled_css: Some(":root{}".to_owned()),
            diagnostics: vec![],
            mapping_report: sample_application_report(),
            source_profile_sha256: hash('c'),
            canonical_digest: hash('b'),
        };
        let application_appearance = PairedV2ApplicationAppearanceResult {
            valid: true,
            compiled_css: ":root{}".to_owned(),
            source_profile_sha256: hash('c'),
            canonical_digest: hash('b'),
        };
        AppThemePairedCompileV2Response::Partial {
            valid: true,
            ui_revision: 3,
            session_id: "v2-session".to_owned(),
            draft: PairedV2Draft {
                profile,
                source_bytes_base64: "eA==".to_owned(),
                raw_source_sha256: hash('c'),
                canonical_digest: hash('b'),
                baseline_raw_source_sha256: hash('a'),
                baseline_canonical_digest: hash('b'),
                verification_status: PairedV2VerificationStatus::Transformed,
                is_transformed: true,
                parent_source_sha256: Some(hash('a')),
            },
            solar_sail: target.clone(),
            stellar_loom: PairedV2TargetCompileResult {
                mapping_report: PairedV2MappingReport {
                    target: "stellar-loom".to_owned(),
                    ..target.mapping_report.clone()
                },
                ..target
            },
            application_appearance,
            application_extension: application,
            diagnostics: vec![],
        }
    }

    #[test]
    fn source_form_is_strict_xor_and_claims_are_bounded() {
        let mut request = sample_request();
        request.source.document_id = Some("doc-1".to_owned());
        assert!(validate_compile_request_transport(&request).is_err());
        request.source.raw_source_base64 = None;
        assert!(validate_compile_request_transport(&request).is_ok());
        request.source.expected_raw_source_sha256 = "A".repeat(64);
        assert!(validate_compile_request_transport(&request).is_err());
        request.source.expected_raw_source_sha256 = hash('a');
        request.source.raw_source_base64 = Some("%%%%".to_owned());
        assert!(validate_compile_request_transport(&request).is_err());
    }

    #[test]
    fn edit_list_rejects_duplicates_overflow_unsorted_and_wrong_clear_modes() {
        let mut request = sample_request();
        request.edits = vec![
            PairedV2Edit::SetColor {
                path: "color.dark.primaryAction".to_owned(),
                value: "#123456".to_owned(),
            },
            PairedV2Edit::SetColor {
                path: "color.dark.primaryAction".to_owned(),
                value: "#654321".to_owned(),
            },
        ];
        assert!(validate_compile_request_transport(&request).is_err());

        request.edits = vec![
            PairedV2Edit::SetColor {
                path: "color.light.canvas".to_owned(),
                value: "#123456".to_owned(),
            },
            PairedV2Edit::SetColor {
                path: "color.dark.primaryAction".to_owned(),
                value: "#123456".to_owned(),
            },
        ];
        assert!(validate_compile_request_transport(&request).is_err());

        request.edits = (0..=PAIRED_V2_MAX_EDIT_ENTRIES)
            .map(|index| PairedV2Edit::SetColor {
                path: format!("color.dark.primaryAction{index}"),
                value: "#123456".to_owned(),
            })
            .collect();
        assert!(validate_compile_request_transport(&request).is_err());

        request.edits = vec![PairedV2Edit::ClearOptional {
            path: "color.dark.canvas".to_owned(),
        }];
        assert!(validate_compile_request_transport(&request).is_err());

        for path in [
            "color.dark.selection",
            "color.dark.selectionText",
            "radius.surface",
        ] {
            request.edits = vec![PairedV2Edit::ClearOptional {
                path: path.to_owned(),
            }];
            assert!(validate_compile_request_transport(&request).is_err());
        }
        for path in [
            "color.dark.hover",
            "color.dark.active",
            "radius.control",
            "radius.overlay",
            "typography.body.size",
        ] {
            request.edits = vec![PairedV2Edit::ClearOptional {
                path: path.to_owned(),
            }];
            assert!(validate_compile_request_transport(&request).is_ok());
        }
    }

    #[test]
    fn edit_values_are_typed_and_bounded_without_native_normalization() {
        let mut request = sample_request();
        request.edits = vec![PairedV2Edit::SetTypography {
            path: "typography.body.lineHeight".to_owned(),
            value: PairedV2EditValue::Number(0.0),
        }];
        assert!(validate_compile_request_transport(&request).is_err());
        request.edits = vec![PairedV2Edit::SetTypography {
            path: "typography.body.family".to_owned(),
            value: PairedV2EditValue::Text("Inter, sans-serif".to_owned()),
        }];
        assert!(validate_compile_request_transport(&request).is_ok());

        request.edits = vec![PairedV2Edit::SetTypography {
            path: "typography.ui.family".to_owned(),
            value: PairedV2EditValue::Text("Inter".to_owned()),
        }];
        assert!(validate_compile_request_transport(&request).is_err());
        request.edits = vec![PairedV2Edit::SetTypography {
            path: "typography.ui.family".to_owned(),
            value: PairedV2EditValue::Text("system-ui".to_owned()),
        }];
        assert!(validate_compile_request_transport(&request).is_ok());

        request.edits = vec![PairedV2Edit::SetRadius {
            path: "radius.surface".to_owned(),
            value: "1".to_owned(),
        }];
        assert!(validate_compile_request_transport(&request).is_err());
        request.edits = vec![PairedV2Edit::SetRadius {
            path: "radius.surface".to_owned(),
            value: "1.25rem".to_owned(),
        }];
        assert!(validate_compile_request_transport(&request).is_ok());

        request.edits = vec![PairedV2Edit::SetColor {
            path: "color.dark.selection".to_owned(),
            value: "red".to_owned(),
        }];
        assert!(validate_compile_request_transport(&request).is_err());
        request.edits = vec![PairedV2Edit::SetColor {
            path: "color.dark.selectionText".to_owned(),
            value: "#112233".to_owned(),
        }];
        assert!(validate_compile_request_transport(&request).is_ok());
    }

    #[test]
    fn serde_is_closed_for_requests_and_edits() -> Result<(), Box<dyn std::error::Error>> {
        let request = sample_request();
        let encoded = serde_json::to_string(&request)?;
        let mut object: BTreeMap<String, PairedV2JsonValue> = serde_json::from_str(&encoded)?;
        object.insert("unexpected".to_owned(), PairedV2JsonValue::Bool(true));
        let with_unknown = serde_json::to_string(&PairedV2JsonValue::Object(object))?;
        assert!(serde_json::from_str::<AppThemePairedCompileV2Request>(&with_unknown).is_err());
        let edit = r##"{
            "kind": "set-color",
            "path": "color.dark.primaryAction",
            "value": "#123456",
            "extra": true
        }"##;
        assert!(serde_json::from_str::<PairedV2Edit>(edit).is_err());

        let duplicate_json = r#"{"key": 1, "key": 2}"#;
        assert!(serde_json::from_str::<PairedV2JsonValue>(duplicate_json).is_err());
        Ok(())
    }

    #[test]
    fn literal_adapter_response_uses_wire_enum_names_and_optional_reason()
    -> Result<(), Box<dyn std::error::Error>> {
        let json = r##"
        {
          "status": "partial",
          "valid": true,
          "uiRevision": 3,
          "sessionId": "v2-session",
          "draft": {
            "profile": {
              "schemaVersion": "tf-paired-profile-v2",
              "name": "developer",
              "version": "0.1.0",
              "color": {
                "light": {
                  "canvas": "#000000", "canvasText": "#000000",
                  "surface": "#000000", "surfaceText": "#000000",
                  "elevatedSurface": "#000000", "elevatedSurfaceText": "#000000",
                  "primaryAction": "#000000", "primaryActionText": "#000000",
                  "secondaryAction": "#000000", "secondaryActionText": "#000000",
                  "mutedSurface": "#000000", "mutedText": "#000000",
                  "highlight": "#000000", "highlightText": "#000000",
                  "danger": "#000000", "dangerText": "#000000",
                  "border": "#000000", "fieldBorder": "#000000", "focus": "#000000"
                },
                "dark": {
                  "canvas": "#000000", "canvasText": "#000000",
                  "surface": "#000000", "surfaceText": "#000000",
                  "elevatedSurface": "#000000", "elevatedSurfaceText": "#000000",
                  "primaryAction": "#000000", "primaryActionText": "#000000",
                  "secondaryAction": "#000000", "secondaryActionText": "#000000",
                  "mutedSurface": "#000000", "mutedText": "#000000",
                  "highlight": "#000000", "highlightText": "#000000",
                  "danger": "#000000", "dangerText": "#000000",
                  "border": "#000000", "fieldBorder": "#000000", "focus": "#000000"
                }
              }
            },
            "sourceBytesBase64": "eA==",
            "rawSourceSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "canonicalDigest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "baselineRawSourceSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "baselineCanonicalDigest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "verificationStatus": "verified",
            "isTransformed": false
          },
          "solarSail": {
            "valid": true,
            "compiledCss": "body{}",
            "diagnostics": [],
            "mappingReport": {
              "schema": "tf-paired-mapping-report-v2",
              "target": "solar-sail",
              "profileName": "developer",
              "profileVersion": "0.1.0",
              "sourceSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "sourceVerification": "source-bytes",
              "canonicalDigest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              "adapter": {"name": "solar-adapter", "version": "0.2.0"},
              "compiler": {"name": "solar", "version": "0.3.0"},
              "options": {},
              "entries": [{"sourcePath": "color.dark.canvas", "classification": "consumed", "targetPath": "palette.dark.background"}],
              "groups": [],
              "defaults": [],
              "summary": {"totalSemanticLeaves": 1, "consumed": 0, "normalized": 0, "overridden": 0, "targetSpecific": 0, "unsupported": 1, "generatedDefaultsCount": 0},
              "digest": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
            },
            "sourceProfileSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "canonicalDigest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
          },
          "stellarLoom": {
            "valid": true,
            "compiledCss": "body{}",
            "diagnostics": [],
            "mappingReport": {
              "schema": "tf-paired-mapping-report-v2",
              "target": "stellar-loom",
              "profileName": "developer",
              "profileVersion": "0.1.0",
              "sourceSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "sourceVerification": "source-bytes",
              "canonicalDigest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              "adapter": {"name": "loom-adapter", "version": "0.2.0"},
              "compiler": {"name": "loom", "version": "0.3.0"},
              "options": {},
              "entries": [],
              "groups": [],
              "defaults": [],
              "summary": {"totalSemanticLeaves": 1, "consumed": 0, "normalized": 0, "overridden": 0, "targetSpecific": 0, "unsupported": 0, "generatedDefaultsCount": 0},
              "digest": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
            },
            "sourceProfileSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "canonicalDigest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
          },
          "applicationAppearance": {
            "valid": true,
            "compiledCss": ":root{}",
            "sourceProfileSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "canonicalDigest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
          },
          "applicationExtension": {
            "valid": true,
            "compiledCss": ":root{}",
            "diagnostics": [],
            "mappingReport": {
              "schema": "theme-forge.application-appearance-extension.v1",
              "entries": [],
              "scope": "application-only"
            },
            "sourceProfileSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "canonicalDigest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
          },
          "diagnostics": []
        }
        "##;
        let response: AppThemePairedCompileV2Response = serde_json::from_str(json)?;
        assert!(validate_compile_response_for_session(&response, "v2-session", 3).is_ok());
        let encoded = serde_json::to_string(&response)?;
        assert!(encoded.contains("\"verificationStatus\":\"verified\""));
        assert!(encoded.contains("\"sourceVerification\":\"source-bytes\""));
        assert!(encoded.contains("\"schema\":\"tf-paired-mapping-report-v2\""));
        assert!(encoded.contains("\"schema\":\"theme-forge.application-appearance-extension.v1\""));
        assert!(!encoded.contains("\"reason\""));
        Ok(())
    }

    #[test]
    fn shared_edit_fixture_matches_rust_grammar_and_semantic_boundary()
    -> Result<(), Box<dyn std::error::Error>> {
        #[derive(Deserialize)]
        struct EditFixture {
            schema: String,
            cases: Vec<EditFixtureCase>,
        }

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct EditFixtureCase {
            name: String,
            expected_allowed: bool,
            edit: PairedV2Edit,
        }

        let fixture: EditFixture = serde_json::from_str(include_str!(
            "../../../src/features/application-theme/test/fixtures/paired-v2-edit-contract.json"
        ))?;
        assert_eq!(fixture.schema, "tf-paired-v2-edit-contract-fixture-v1");
        for case in fixture.cases {
            let allowed = validate_edits(std::slice::from_ref(&case.edit)).is_ok();
            assert_eq!(allowed, case.expected_allowed, "{}", case.name);
        }
        Ok(())
    }

    #[test]
    fn untrusted_text_rejects_legacy_bidi_controls() -> Result<(), Box<dyn std::error::Error>> {
        for codepoint in [
            0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068,
            0x2069,
        ] {
            let Some(character) = char::from_u32(codepoint) else {
                return Err(format!("invalid bidi control codepoint: {codepoint:04X}").into());
            };
            let value = character.to_string();
            assert!(
                validate_text(&value, 32, "test", false).is_err(),
                "U+{codepoint:04X}"
            );
        }
        assert!(validate_text("plain text", 32, "test", false).is_ok());
        Ok(())
    }

    #[test]
    fn save_modes_and_latest_compile_guards_are_strict() {
        let base = AppThemeSaveProfileV2Request {
            session_id: "v2-session".to_owned(),
            document_id: None,
            draft_source_base64: "eA==".to_owned(),
            expected_draft_raw_source_sha256: hash('a'),
            expected_canonical_digest: hash('b'),
            expected_parent_source_sha256: None,
            expected_compile_raw_source_sha256: hash('a'),
            expected_compile_canonical_digest: hash('b'),
            expected_compile_ui_revision: 3,
            save_mode: PairedV2SaveMode::NewDocument,
            ui_revision: 3,
        };
        assert!(validate_save_request_transport(&base).is_ok());
        let mut edited = base.clone();
        edited.save_mode = PairedV2SaveMode::Edited;
        assert!(validate_save_request_transport(&edited).is_err());
        edited.document_id = Some("doc-1".to_owned());
        edited.expected_parent_source_sha256 = Some(hash('a'));
        let latest = PairedV2LatestCompileClaim {
            raw_source_sha256: hash('a'),
            canonical_digest: hash('b'),
            ui_revision: 3,
        };
        let active = PairedV2ActiveDocumentClaim {
            document_id: "doc-1".to_owned(),
            raw_source_sha256: hash('a'),
        };
        assert!(
            validate_save_request_for_session(&edited, "v2-session", &latest, Some(&active))
                .is_ok()
        );
        edited.ui_revision = 2;
        assert!(
            validate_save_request_for_session(&edited, "v2-session", &latest, Some(&active))
                .is_err()
        );
        let mut new_with_parent = base;
        new_with_parent.expected_parent_source_sha256 = Some(hash('a'));
        assert!(validate_save_request_transport(&new_with_parent).is_err());
    }

    #[test]
    fn response_union_requires_real_results_only_on_success_or_partial()
    -> Result<(), Box<dyn std::error::Error>> {
        let response = sample_success_response();
        assert!(validate_compile_response_for_session(&response, "v2-session", 3).is_ok());

        let mut status_mismatch = response.clone();
        if let AppThemePairedCompileV2Response::Partial {
            solar_sail,
            stellar_loom,
            ..
        } = &mut status_mismatch
        {
            solar_sail.mapping_report.summary.unsupported = 0;
            stellar_loom.mapping_report.summary.unsupported = 0;
        }
        assert!(validate_compile_response_transport(&status_mismatch).is_err());

        let failure = AppThemePairedCompileV2Response::Error {
            valid: false,
            ui_revision: 3,
            session_id: "v2-session".to_owned(),
            draft: None,
            solar_sail: None,
            stellar_loom: None,
            application_appearance: None,
            application_extension: None,
            diagnostics: vec![],
            error: Some(PairedV2Error {
                code: "BINDER_REJECTED".to_owned(),
                message: "native binder rejected the request".to_owned(),
                path: None,
            }),
        };
        assert!(validate_compile_response_transport(&failure).is_ok());
        let failure_json = serde_json::to_string(&failure)?;
        let failure_object: BTreeMap<String, PairedV2JsonValue> =
            serde_json::from_str(&failure_json)?;
        assert!(!failure_object.contains_key("draft"));
        for key in [
            "solarSail",
            "stellarLoom",
            "applicationAppearance",
            "applicationExtension",
        ] {
            assert_eq!(failure_object.get(key), Some(&PairedV2JsonValue::Null));
        }
        let failure_roundtrip = serde_json::to_string(&PairedV2JsonValue::Object(failure_object))?;
        let _: AppThemePairedCompileV2Response = serde_json::from_str(&failure_roundtrip)?;

        let mut oversized = response;
        if let AppThemePairedCompileV2Response::Partial { solar_sail, .. } = &mut oversized {
            solar_sail.compiled_css = Some("x".repeat(PAIRED_V2_MAX_SOLAR_CSS_BYTES + 1));
        }
        assert!(validate_compile_response_transport(&oversized).is_err());
        Ok(())
    }

    #[test]
    fn response_and_capability_unknown_fields_are_rejected()
    -> Result<(), Box<dyn std::error::Error>> {
        let response = sample_success_response();
        let encoded = serde_json::to_string(&response)?;
        let mut value: BTreeMap<String, PairedV2JsonValue> = serde_json::from_str(&encoded)?;
        value.insert("extra".to_owned(), PairedV2JsonValue::Bool(true));
        let with_unknown = serde_json::to_string(&PairedV2JsonValue::Object(value))?;
        assert!(serde_json::from_str::<AppThemePairedCompileV2Response>(&with_unknown).is_err());
        let capability = r#"{
            "sessionId": "v2-session",
            "supported": true,
            "extra": false
        }"#;
        assert!(serde_json::from_str::<PairedV2AuthoringCapability>(capability).is_err());
        Ok(())
    }

    #[test]
    fn transformed_drafts_cannot_self_parent_the_baseline() -> Result<(), Box<dyn std::error::Error>>
    {
        let mut response = sample_success_response();
        let AppThemePairedCompileV2Response::Partial { draft, .. } = &mut response else {
            return Err("sample response must be partial".into());
        };
        draft.raw_source_sha256 = hash('a');
        assert!(validate_draft(draft).is_err());
        Ok(())
    }

    #[test]
    fn committed_save_is_not_cancelled_and_cancelled_has_no_document() {
        let saved = AppThemeSaveProfileV2Response {
            cancelled: false,
            saved: true,
            session_id: "v2-session".to_owned(),
            ui_revision: 3,
            document: Some(PairedV2SavedDocument {
                document_id: "doc-1".to_owned(),
                raw_source_sha256: hash('a'),
                canonical_digest: hash('b'),
                display_name: "developer.profile.json".to_owned(),
            }),
            error: None,
        };
        assert!(validate_save_response_transport(&saved).is_ok());
        let mut cancelled = saved;
        cancelled.cancelled = true;
        cancelled.saved = false;
        cancelled.document = None;
        assert!(validate_save_response_transport(&cancelled).is_ok());
        let mut ambiguous = cancelled;
        ambiguous.saved = true;
        assert!(validate_save_response_transport(&ambiguous).is_err());
    }
}
