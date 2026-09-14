use serde::{Deserialize, Serialize};

use super::types::{Artboard, SceneEditOperation, SceneProfile, VectorScene};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneExpected {
    pub session_id: String,
    pub revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub draft_input_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_snapshot_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine_identity: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneMetricsDto {
    pub expanded_element_count: usize,
    pub authored_element_count: usize,
    pub path_segment_count: usize,
    pub glyph_count: usize,
    pub max_nesting_depth: usize,
    pub gradient_stop_count: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneReceiptDto {
    pub schema: String,
    pub diagnostics: Vec<String>,
    pub source_snapshot_digest: String,
    pub scene_schema: String,
    pub scene_compatibility: u32,
    pub scene_compiler_level: u32,
    pub source_digest: String,
    pub svg_digest: String,
    pub profile: SceneProfile,
    pub artboard: Artboard,
    pub glyph_catalog_digest: String,
    pub token_digest: String,
    pub metrics: SceneMetricsDto,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneDiagnosticDto {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub severity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneCompiledPreview {
    pub svg: String,
    pub svg_digest: String,
    pub receipt: SceneReceiptDto,
    pub metrics: SceneMetricsDto,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneNewRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected: Option<SceneExpected>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replacement_intent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<SceneProfile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preset: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artboard: Option<Artboard>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneDraftResponse {
    pub session_id: String,
    pub revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    pub dirty: bool,
    pub scene: VectorScene,
    pub canonical_json: String,
    pub draft_input_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_snapshot_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compiled: Option<SceneCompiledPreview>,
    #[serde(default)]
    pub diagnostics: Vec<SceneDiagnosticDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneStatusRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected: Option<SceneExpected>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneStatusResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scene: Option<VectorScene>,
    pub session_id: String,
    pub revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_display_name: Option<String>,
    pub dirty: bool,
    pub disposed: bool,
    pub draft_input_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_snapshot_id: Option<String>,
    pub has_compiled_svg: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compiled_svg_digest: Option<String>,
    pub retained_save_plan: bool,
    pub retained_export_plan: bool,
    pub retained_packets_count: usize,
    #[serde(default)]
    pub diagnostics: Vec<SceneDiagnosticDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneDisposeRequest {
    pub expected: SceneExpected,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneDisposeResponse {
    pub session_id: String,
    pub disposed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneOpenRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected: Option<SceneExpected>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replacement_intent_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneSelectionResponse {
    pub cancelled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub draft: Option<SceneDraftResponse>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneImportSvgRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected: Option<SceneExpected>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replacement_intent_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneImportResponse {
    pub cancelled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub classification: Option<String>,
    #[serde(default)]
    pub reason_codes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub draft: Option<SceneDraftResponse>,
    #[serde(default)]
    pub normalizations: Vec<String>,
    #[serde(default)]
    pub diagnostics: Vec<SceneDiagnosticDto>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneEditRequest {
    pub expected: SceneExpected,
    pub operations: Vec<SceneEditOperation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneCompileRequest {
    pub expected: SceneExpected,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneCompileResponse {
    pub session_id: String,
    pub revision: u64,
    pub draft_input_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub svg: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub receipt: Option<SceneReceiptDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metrics: Option<SceneMetricsDto>,
    #[serde(default)]
    pub diagnostics: Vec<SceneDiagnosticDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneSavePlanRequest {
    pub expected: SceneExpected,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScenePlanResponse {
    pub cancelled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub byte_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canonical_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at_unix_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneApplyRequest {
    pub expected: SceneExpected,
    pub plan_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScenePublicationResponse {
    pub published: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub byte_count: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneExportPlanRequest {
    pub expected: SceneExpected,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneTokenBindRequest {
    pub expected: SceneExpected,
    pub project_handle: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneBriefRequest {
    pub expected: SceneExpected,
    pub title: String,
    pub objective: String,
    #[serde(default)]
    pub acceptance_criteria: Vec<String>,
    #[serde(default)]
    pub prohibited_changes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScenePacketResponse {
    pub cancelled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub packet_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub packet_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canonical_json: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub packet_digest: Option<String>,
    #[serde(default)]
    pub sender_claims: Vec<String>,
    #[serde(default)]
    pub diagnostics: Vec<SceneDiagnosticDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScenePacketImportRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected: Option<SceneExpected>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_kind: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScenePacketExportRequest {
    pub expected: SceneExpected,
    pub packet_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneReviewAnnotationDto {
    pub annotation_id: String,
    pub candidate_id: String,
    pub comment: String,
    pub severity: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub element_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneReviewRequest {
    pub expected: SceneExpected,
    pub brief_packet_id: String,
    pub candidate_packet_ids: Vec<String>,
    pub overall_disposition: String,
    pub summary: String,
    #[serde(default)]
    pub annotations: Vec<SceneReviewAnnotationDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneVerifyRequest {
    pub expected: SceneExpected,
    pub candidate_packet_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub brief_packet_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneVerificationResponse {
    pub valid: bool,
    pub candidate_packet_id: String,
    pub candidate_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compiled_svg_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metrics: Option<SceneMetricsDto>,
    #[serde(default)]
    pub diagnostics: Vec<SceneDiagnosticDto>,
    pub verification_handle: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneAdoptRequest {
    pub expected: SceneExpected,
    pub verification_handle: String,
}

pub(crate) fn validate_request_size<T: Serialize>(
    request: &T,
    limit: usize,
) -> crate::errors::StudioResult<()> {
    let bytes = serde_json::to_vec(request).map_err(|_| {
        crate::errors::StudioCommandError::new(crate::errors::StudioReasonCode::ProtocolInvalid)
    })?;
    if bytes.len() > limit {
        return Err(crate::errors::StudioCommandError::new(
            crate::errors::StudioReasonCode::ResultTooLarge,
        ));
    }
    Ok(())
}
