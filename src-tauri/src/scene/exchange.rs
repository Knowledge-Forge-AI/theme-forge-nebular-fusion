use serde::{Deserialize, Serialize};

use super::protocol_dto::SceneReviewAnnotationDto;
use super::types::{
    Artboard, SCENE_COMPATIBILITY, SCENE_COMPILER_LEVEL, SCENE_SCHEMA, SceneProfile,
    SceneProvenance, VectorScene,
};
use crate::errors::{StudioCommandError, StudioReasonCode, StudioResult};

pub const BRIEF_SCHEMA: &str = "tfsb.scene-brief-v1";
pub const CANDIDATE_SCHEMA: &str = "tfsb.scene-candidate-v1";
pub const REVIEW_SCHEMA: &str = "tfsb.scene-review-v1";
pub const EXCHANGE_SCHEMA_VERSION: u32 = 1;

pub const MAX_TITLE_LEN: usize = 256;
pub const MAX_OBJECTIVE_LEN: usize = 4096;
pub const MAX_SUMMARY_LEN: usize = 4096;
pub const MAX_DISPOSITION_LEN: usize = 64;
pub const MAX_CRITERIA_COUNT: usize = 64;
pub const MAX_CRITERION_LEN: usize = 1024;
pub const MAX_PROHIBITED_COUNT: usize = 64;
pub const MAX_PROHIBITED_LEN: usize = 1024;
pub const MAX_ANNOTATIONS_COUNT: usize = 128;
pub const MAX_ANNOTATION_COMMENT_LEN: usize = 2048;
pub const MAX_ANNOTATION_ID_LEN: usize = 128;
pub const MAX_ANNOTATION_SEVERITY_LEN: usize = 32;
pub const MAX_CANDIDATE_IDS_COUNT: usize = 16;
pub const MAX_ID_LEN: usize = 128;
pub const MAX_DIGEST_LEN: usize = 128;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BriefPacketEnvelope {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_snapshot_id: Option<String>,
    pub schema: String,
    pub schema_version: u32,
    pub brief_id: String,
    pub title: String,
    pub objective: String,
    #[serde(default)]
    pub acceptance_criteria: Vec<String>,
    #[serde(default)]
    pub prohibited_changes: Vec<String>,
    pub scene: VectorScene,
    pub canonical_digest: String,
}

impl BriefPacketEnvelope {
    pub fn validate_bounds(&self) -> StudioResult<()> {
        if self.schema != BRIEF_SCHEMA || self.schema_version != EXCHANGE_SCHEMA_VERSION {
            return Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid));
        }
        if self.brief_id.is_empty() || self.brief_id.len() > MAX_ID_LEN {
            return Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid));
        }
        if self.title.len() > MAX_TITLE_LEN || self.objective.len() > MAX_OBJECTIVE_LEN {
            return Err(StudioCommandError::new(StudioReasonCode::ResultTooLarge));
        }
        if self.acceptance_criteria.len() > MAX_CRITERIA_COUNT
            || self
                .acceptance_criteria
                .iter()
                .any(|c| c.len() > MAX_CRITERION_LEN)
        {
            return Err(StudioCommandError::new(StudioReasonCode::ResultTooLarge));
        }
        if self.prohibited_changes.len() > MAX_PROHIBITED_COUNT
            || self
                .prohibited_changes
                .iter()
                .any(|p| p.len() > MAX_PROHIBITED_LEN)
        {
            return Err(StudioCommandError::new(StudioReasonCode::ResultTooLarge));
        }
        if self.canonical_digest.is_empty() || self.canonical_digest.len() > MAX_DIGEST_LEN {
            return Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CandidatePacketEnvelope {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_snapshot_id: Option<String>,
    pub schema: String,
    pub schema_version: u32,
    pub candidate_id: String,
    pub brief_id: String,
    pub brief_digest: String,
    pub canonical_scene_digest: String,
    pub svg_digest: String,
    pub profile: SceneProfile,
    pub artboard: Artboard,
    pub scene_schema: String,
    pub scene_compatibility: u32,
    pub scene_compiler_level: u32,
    pub glyph_catalog_digest: String,
    pub token_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sender_provenance: Option<SceneProvenance>,
    pub scene: VectorScene,
}

impl CandidatePacketEnvelope {
    pub fn validate_bounds(&self) -> StudioResult<()> {
        if self.schema != CANDIDATE_SCHEMA || self.schema_version != EXCHANGE_SCHEMA_VERSION {
            return Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid));
        }
        if self.candidate_id.is_empty() || self.candidate_id.len() > MAX_ID_LEN {
            return Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid));
        }
        if self.brief_id.is_empty() || self.brief_id.len() > MAX_ID_LEN {
            return Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid));
        }
        if self.brief_digest.is_empty() || self.brief_digest.len() > MAX_DIGEST_LEN {
            return Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid));
        }
        if self.canonical_scene_digest.is_empty()
            || self.canonical_scene_digest.len() > MAX_DIGEST_LEN
        {
            return Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid));
        }
        if self.svg_digest.is_empty() || self.svg_digest.len() > MAX_DIGEST_LEN {
            return Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid));
        }
        if self.scene_schema != SCENE_SCHEMA
            || self.scene_compatibility != SCENE_COMPATIBILITY
            || self.scene_compiler_level != SCENE_COMPILER_LEVEL
        {
            return Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewPacketEnvelope {
    pub schema: String,
    pub schema_version: u32,
    pub review_id: String,
    pub brief_packet_id: String,
    pub candidate_packet_ids: Vec<String>,
    pub overall_disposition: String,
    pub summary: String,
    #[serde(default)]
    pub annotations: Vec<SceneReviewAnnotationDto>,
}

impl ReviewPacketEnvelope {
    pub fn validate_bounds(&self) -> StudioResult<()> {
        if self.schema != REVIEW_SCHEMA || self.schema_version != EXCHANGE_SCHEMA_VERSION {
            return Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid));
        }
        if self.review_id.is_empty() || self.review_id.len() > MAX_ID_LEN {
            return Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid));
        }
        if self.brief_packet_id.is_empty() || self.brief_packet_id.len() > MAX_ID_LEN {
            return Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid));
        }
        if self.candidate_packet_ids.is_empty()
            || self.candidate_packet_ids.len() > MAX_CANDIDATE_IDS_COUNT
            || self
                .candidate_packet_ids
                .iter()
                .any(|c| c.is_empty() || c.len() > MAX_ID_LEN)
        {
            return Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid));
        }
        if self.overall_disposition.len() > MAX_DISPOSITION_LEN {
            return Err(StudioCommandError::new(StudioReasonCode::ResultTooLarge));
        }
        if self.summary.len() > MAX_SUMMARY_LEN {
            return Err(StudioCommandError::new(StudioReasonCode::ResultTooLarge));
        }
        if self.annotations.len() > MAX_ANNOTATIONS_COUNT {
            return Err(StudioCommandError::new(StudioReasonCode::ResultTooLarge));
        }
        for ann in &self.annotations {
            if ann.annotation_id.len() > MAX_ANNOTATION_ID_LEN
                || ann.candidate_id.len() > MAX_ID_LEN
                || ann.severity.len() > MAX_ANNOTATION_SEVERITY_LEN
                || ann.comment.len() > MAX_ANNOTATION_COMMENT_LEN
                || ann
                    .element_id
                    .as_ref()
                    .is_some_and(|e| e.len() > MAX_ID_LEN)
            {
                return Err(StudioCommandError::new(StudioReasonCode::ResultTooLarge));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum SceneExchangePacket {
    Brief(Box<BriefPacketEnvelope>),
    Candidate(Box<CandidatePacketEnvelope>),
    Review(Box<ReviewPacketEnvelope>),
}

impl SceneExchangePacket {
    pub fn packet_id(&self) -> &str {
        match self {
            Self::Brief(b) => &b.brief_id,
            Self::Candidate(c) => &c.candidate_id,
            Self::Review(r) => &r.review_id,
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Self::Brief(_) => "brief",
            Self::Candidate(_) => "candidate",
            Self::Review(_) => "review",
        }
    }

    pub fn schema(&self) -> &str {
        match self {
            Self::Brief(b) => &b.schema,
            Self::Candidate(c) => &c.schema,
            Self::Review(r) => &r.schema,
        }
    }

    pub fn to_canonical_json(&self) -> StudioResult<String> {
        serde_json::to_string(self)
            .map_err(|_| StudioCommandError::new(StudioReasonCode::DomainFailed))
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MinimalSchemaPeek {
    schema: String,
    schema_version: u32,
}

pub fn parse_exchange_packet(
    packet_str: &str,
    expected_kind: Option<&str>,
) -> StudioResult<SceneExchangePacket> {
    let peek: MinimalSchemaPeek = serde_json::from_str(packet_str)
        .map_err(|_| StudioCommandError::new(StudioReasonCode::ProtocolInvalid))?;

    if peek.schema_version != EXCHANGE_SCHEMA_VERSION {
        return Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid));
    }

    match peek.schema.as_str() {
        BRIEF_SCHEMA => {
            if let Some(expected) = expected_kind
                && expected != "brief"
                && expected != BRIEF_SCHEMA
            {
                return Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid));
            }
            let envelope: BriefPacketEnvelope = serde_json::from_str(packet_str)
                .map_err(|_| StudioCommandError::new(StudioReasonCode::ProtocolInvalid))?;
            envelope.validate_bounds()?;
            Ok(SceneExchangePacket::Brief(Box::new(envelope)))
        }
        CANDIDATE_SCHEMA => {
            if let Some(expected) = expected_kind
                && expected != "candidate"
                && expected != CANDIDATE_SCHEMA
            {
                return Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid));
            }
            let envelope: CandidatePacketEnvelope = serde_json::from_str(packet_str)
                .map_err(|_| StudioCommandError::new(StudioReasonCode::ProtocolInvalid))?;
            envelope.validate_bounds()?;
            Ok(SceneExchangePacket::Candidate(Box::new(envelope)))
        }
        REVIEW_SCHEMA => {
            if let Some(expected) = expected_kind
                && expected != "review"
                && expected != REVIEW_SCHEMA
            {
                return Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid));
            }
            let envelope: ReviewPacketEnvelope = serde_json::from_str(packet_str)
                .map_err(|_| StudioCommandError::new(StudioReasonCode::ProtocolInvalid))?;
            envelope.validate_bounds()?;
            Ok(SceneExchangePacket::Review(Box::new(envelope)))
        }
        _ => Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid)),
    }
}
