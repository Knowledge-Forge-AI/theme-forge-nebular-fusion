use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::value::Value as JsonNode;
use sha2::{Digest, Sha256};

use crate::errors::{StudioCommandError, StudioReasonCode, StudioResult};

const MAX_ARTIFACT_BYTES: usize = 6_291_456;
const MAX_AGGREGATE_ARTIFACT_BYTES: usize = 8_388_608;
const MAX_RESULT_BYTES: usize = 12_582_912;
const DIGEST_BASIS: &[u8] = b"tfsb.studio-visual-evidence-v1\n";
const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct VisualEvidenceResult {
    schema: String,
    schema_version: u8,
    kind: VisualEvidenceKind,
    project_digest: String,
    brand_system_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    qa_digest: Option<String>,
    target: VisualEvidenceTarget,
    configuration: VisualConfiguration,
    renderer: VisualRenderer,
    artifacts: Vec<VisualArtifact>,
    #[serde(skip_serializing_if = "Option::is_none")]
    difference: Option<VisualDifference>,
    evidence_digest: String,
}

impl VisualEvidenceResult {
    pub(crate) fn decoded_byte_total(&self) -> usize {
        self.artifacts
            .iter()
            .map(|artifact| artifact.byte_length)
            .sum()
    }

    pub(crate) fn evidence_digest(&self) -> &str {
        &self.evidence_digest
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum VisualEvidenceKind {
    ProjectRender,
    QaBaseline,
    BrandDiff,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VisualEvidenceTarget {
    asset_id: String,
    canonical_asset_digest: String,
    svg_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    binding: Option<VisualBinding>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct VisualBinding {
    family: String,
    role: String,
    variant: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct VisualConfiguration {
    width: u32,
    height: u32,
    background: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VisualRenderer {
    id: String,
    version: String,
    qualification_id: String,
    platform_claim: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VisualArtifact {
    role: VisualRole,
    media_type: String,
    encoding: String,
    width: u32,
    height: u32,
    byte_length: usize,
    png_digest: String,
    decoded_pixel_digest: String,
    bytes_base64: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum VisualRole {
    Current,
    Baseline,
    Before,
    After,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VisualDifference {
    changed_pixels: u32,
    maximum_channel_delta: u8,
    changed_bounds: Option<ChangedBounds>,
    claim: DifferenceClaim,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ChangedBounds {
    left: u32,
    top: u32,
    right: u32,
    bottom: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum DifferenceClaim {
    PixelEqualForThisRendererAndCaseOnly,
    PixelDifferentForThisRendererAndCaseOnly,
}

fn protocol_invalid<T>() -> StudioResult<T> {
    Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid))
}

fn valid_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn valid_public_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.is_ascii()
        && !value.contains(['\0', '/', '\\'])
}

fn valid_background(value: &str) -> bool {
    value == "transparent"
        || value.strip_prefix('#').is_some_and(|hex| {
            hex.len() == 8
                && hex
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_lowercase())
        })
        || value.strip_prefix("token:").is_some_and(|token| {
            valid_public_id(token)
                && token
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
}

fn sha256(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 24
        || &bytes[..8] != PNG_SIGNATURE
        || bytes[8..12] != 13_u32.to_be_bytes()
        || &bytes[12..16] != b"IHDR"
    {
        return None;
    }
    Some((
        u32::from_be_bytes(bytes[16..20].try_into().ok()?),
        u32::from_be_bytes(bytes[20..24].try_into().ok()?),
    ))
}

fn evidence_projection(result: &VisualEvidenceResult) -> StudioResult<Vec<u8>> {
    let mut value = serde_json::to_value(result)
        .map_err(|_| StudioCommandError::new(StudioReasonCode::ProtocolInvalid))?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| StudioCommandError::new(StudioReasonCode::ProtocolInvalid))?;
    object.remove("evidenceDigest");
    let artifacts = object
        .get_mut("artifacts")
        .and_then(JsonNode::as_array_mut)
        .ok_or_else(|| StudioCommandError::new(StudioReasonCode::ProtocolInvalid))?;
    for artifact in artifacts {
        artifact
            .as_object_mut()
            .and_then(|entry| entry.remove("bytesBase64"))
            .ok_or_else(|| StudioCommandError::new(StudioReasonCode::ProtocolInvalid))?;
    }
    let mut projection = DIGEST_BASIS.to_vec();
    projection.extend(
        serde_json::to_vec(&value)
            .map_err(|_| StudioCommandError::new(StudioReasonCode::ProtocolInvalid))?,
    );
    Ok(projection)
}

pub(crate) fn validate_visual_evidence(result: &VisualEvidenceResult) -> StudioResult<()> {
    if result.schema != "tfsb.studio-visual-evidence"
        || result.schema_version != 1
        || !valid_digest(&result.project_digest)
        || !valid_digest(&result.brand_system_digest)
        || result
            .source_digest
            .as_ref()
            .is_some_and(|value| !valid_digest(value))
        || result
            .qa_digest
            .as_ref()
            .is_some_and(|value| !valid_digest(value))
        || !valid_digest(&result.target.canonical_asset_digest)
        || !valid_digest(&result.target.svg_digest)
        || !valid_public_id(&result.target.asset_id)
        || result.target.binding.as_ref().is_some_and(|binding| {
            !valid_public_id(&binding.family)
                || !valid_public_id(&binding.role)
                || !valid_public_id(&binding.variant)
        })
        || result.configuration.width < 16
        || result.configuration.height < 16
        || result.configuration.width > 1_024
        || result.configuration.height > 1_024
        || result.configuration.width * result.configuration.height > 1_048_576
        || !valid_background(&result.configuration.background)
        || result.renderer.id != "resvg-png-v1"
        || result.renderer.version != "2.6.2"
        || result.renderer.qualification_id
            != "sha256:4bb08e677b87ef1ca74c35c5c22f547cebef4c22a1f98a08a9246fd9397d0f11"
        || result.renderer.platform_claim != "darwin-arm64"
        || !valid_digest(&result.evidence_digest)
    {
        return protocol_invalid();
    }
    let optional_shape = match result.kind {
        VisualEvidenceKind::ProjectRender => {
            result.source_digest.is_none()
                && result.qa_digest.is_none()
                && result.difference.is_none()
        }
        VisualEvidenceKind::QaBaseline => {
            result.source_digest.is_none()
                && result.qa_digest.is_some()
                && result.difference.is_some()
        }
        VisualEvidenceKind::BrandDiff => {
            result.source_digest.is_some()
                && result.qa_digest.is_none()
                && result.difference.is_some()
        }
    };
    let expected_roles: &[VisualRole] = match result.kind {
        VisualEvidenceKind::ProjectRender => &[VisualRole::Current],
        VisualEvidenceKind::QaBaseline => &[VisualRole::Baseline, VisualRole::Current],
        VisualEvidenceKind::BrandDiff => &[VisualRole::Before, VisualRole::After],
    };
    if !optional_shape || result.artifacts.len() != expected_roles.len() {
        return protocol_invalid();
    }
    let mut aggregate = 0_usize;
    for (artifact, expected_role) in result.artifacts.iter().zip(expected_roles) {
        if artifact.role != *expected_role
            || artifact.media_type != "image/png"
            || artifact.encoding != "base64"
            || artifact.width != result.configuration.width
            || artifact.height != result.configuration.height
            || artifact.byte_length > MAX_ARTIFACT_BYTES
            || !valid_digest(&artifact.png_digest)
            || !valid_digest(&artifact.decoded_pixel_digest)
        {
            return protocol_invalid();
        }
        let decoded = STANDARD
            .decode(&artifact.bytes_base64)
            .map_err(|_| StudioCommandError::new(StudioReasonCode::ProtocolInvalid))?;
        if STANDARD.encode(&decoded) != artifact.bytes_base64
            || decoded.len() != artifact.byte_length
            || sha256(&decoded) != artifact.png_digest
            || png_dimensions(&decoded) != Some((artifact.width, artifact.height))
        {
            return protocol_invalid();
        }
        aggregate = aggregate.saturating_add(decoded.len());
        drop(decoded);
    }
    if aggregate > MAX_AGGREGATE_ARTIFACT_BYTES {
        return protocol_invalid();
    }
    if let Some(difference) = &result.difference {
        let equal = difference.changed_pixels == 0;
        if equal != (difference.claim == DifferenceClaim::PixelEqualForThisRendererAndCaseOnly)
            || (equal
                && (difference.maximum_channel_delta != 0 || difference.changed_bounds.is_some()))
            || (!equal
                && (difference.maximum_channel_delta == 0 || difference.changed_bounds.is_none()))
            || difference.changed_pixels > result.configuration.width * result.configuration.height
            || difference.changed_bounds.as_ref().is_some_and(|bounds| {
                bounds.left > bounds.right
                    || bounds.top > bounds.bottom
                    || bounds.right >= result.configuration.width
                    || bounds.bottom >= result.configuration.height
            })
        {
            return protocol_invalid();
        }
    }
    if sha256(&evidence_projection(result)?) != result.evidence_digest
        || serde_json::to_vec(result)
            .map_err(|_| StudioCommandError::new(StudioReasonCode::ProtocolInvalid))?
            .len()
            > MAX_RESULT_BYTES
    {
        return protocol_invalid();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn malformed_and_noncanonical_visual_bytes_fail_closed() {
        let raw = include_str!("../../../protocol/tfsb-studio-v1/examples/1.2/results.json");
        let examples: JsonNode = serde_json::from_str(raw).unwrap_or(JsonNode::Null);
        let visual = examples
            .get("brand.visual.evidence.get")
            .cloned()
            .unwrap_or(JsonNode::Null);
        let parsed = serde_json::from_value(visual);
        assert!(parsed.is_ok());
        let mut result: VisualEvidenceResult = parsed.unwrap_or_else(|_| unreachable!());
        assert!(validate_visual_evidence(&result).is_ok());
        result.renderer.qualification_id = format!("sha256:{}", "0".repeat(64));
        assert!(validate_visual_evidence(&result).is_err());
        result.renderer.qualification_id =
            "sha256:4bb08e677b87ef1ca74c35c5c22f547cebef4c22a1f98a08a9246fd9397d0f11".to_owned();
        result.artifacts[0].bytes_base64.push('=');
        assert!(validate_visual_evidence(&result).is_err());
    }
}
