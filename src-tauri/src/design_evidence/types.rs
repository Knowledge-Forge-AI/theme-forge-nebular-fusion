use serde::{Deserialize, Serialize};

use crate::sidecar::visual_evidence::VisualEvidenceResult;

#[derive(Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub(crate) enum DesignEvidencePacket {
    Brief(DesignBriefPacket),
    Candidate(DesignCandidatePacket),
    Review(DesignReviewPacket),
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DesignBriefPacket {
    pub(crate) schema: String,
    pub(crate) schema_version: u8,
    pub(crate) brief_id: String,
    pub(crate) revision: u64,
    pub(crate) title: String,
    pub(crate) objective: String,
    pub(crate) context: DesignEvidenceContext,
    pub(crate) targets: Vec<DesignEvidenceTarget>,
    pub(crate) constraints: DesignEvidenceConstraints,
    pub(crate) materials: Vec<DesignEvidenceMaterial>,
    pub(crate) visual_evidence: Vec<VisualEvidenceResult>,
    pub(crate) brief_digest: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DesignEvidenceContext {
    pub(crate) core_package_version: String,
    pub(crate) studio_version: String,
    pub(crate) studio_protocol_version: String,
    pub(crate) project: DesignEvidenceProjectContext,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) source: Option<DesignEvidenceSourceContext>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DesignEvidenceProjectContext {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) label: Option<String>,
    pub(crate) canonical_digest: String,
    pub(crate) brand_system_digest: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DesignEvidenceSourceContext {
    pub(crate) package_id: String,
    pub(crate) brand_version: String,
    pub(crate) brand_system_digest: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DesignEvidenceTarget {
    pub(crate) target_id: String,
    pub(crate) selector: DesignEvidenceTargetSelector,
    pub(crate) canonical_asset_digest: String,
    pub(crate) svg_digest: String,
    pub(crate) purpose: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum DesignEvidenceTargetSelector {
    Asset {
        asset_id: String,
    },
    Binding {
        family: String,
        role: String,
        variant: String,
    },
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DesignEvidenceConstraints {
    pub(crate) allowed_proposal_kinds: Vec<ProposalKind>,
    pub(crate) required_token_ids: Vec<String>,
    pub(crate) required_recipe_ids: Vec<String>,
    pub(crate) qa_profile_ids: Vec<String>,
    pub(crate) render_tuples: Vec<DesignEvidenceRenderTuple>,
    pub(crate) acceptance_criteria: Vec<String>,
    pub(crate) prohibited_changes: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ProposalKind {
    EvidenceOnly,
    Derive,
    QaBaseline,
    ConsumerInstall,
    ConsumerSync,
    Export,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DesignEvidenceRenderTuple {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) background: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DesignEvidenceMaterial {
    pub(crate) kind: MaterialKind,
    pub(crate) identifier: String,
    pub(crate) digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) license_expression: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) notice_digest: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum MaterialKind {
    UserSupplied,
    TfsbRendered,
    ThirdParty,
    ExternalClaim,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DesignCandidatePacket {
    pub(crate) schema: String,
    pub(crate) schema_version: u8,
    pub(crate) brief_digest: String,
    pub(crate) candidate_id: String,
    pub(crate) revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) revision_of: Option<String>,
    pub(crate) author: CandidateAuthor,
    pub(crate) title: String,
    pub(crate) rationale: String,
    pub(crate) proposal: CandidateProposal,
    pub(crate) claims: Vec<CandidateClaim>,
    pub(crate) qa_summary: CandidateQaSummary,
    pub(crate) materials: Vec<DesignEvidenceMaterial>,
    pub(crate) visual_evidence: Vec<VisualEvidenceResult>,
    pub(crate) candidate_digest: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CandidateAuthor {
    pub(crate) kind: CandidateAuthorKind,
    pub(crate) label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) tool_version: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum CandidateAuthorKind {
    Human,
    Agent,
    Tool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum CandidateProposal {
    EvidenceOnly,
    Derive {
        selection: DeriveSelection,
    },
    QaBaseline {
        profile_id: String,
        case_id: String,
    },
    ConsumerInstall {
        source_packages: Vec<SourcePackageIntent>,
        profile_ids: Vec<String>,
        parameters: Vec<ConsumerParameterIntent>,
    },
    ConsumerSync {
        source_packages: Vec<SourcePackageIntent>,
        #[serde(skip_serializing_if = "Option::is_none")]
        profile_ids: Option<Vec<String>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        parameters: Option<Vec<ConsumerParameterIntent>>,
    },
    Export {
        profile_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        output_ids: Option<Vec<String>>,
    },
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum DeriveSelection {
    All,
    Recipes { recipe_ids: Vec<String> },
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourcePackageIntent {
    pub(crate) package_id: String,
    pub(crate) brand_version: String,
    pub(crate) brand_system_digest: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConsumerParameterIntent {
    pub(crate) profile_id: String,
    pub(crate) values: Vec<ConsumerParameterValue>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ConsumerParameterValue {
    pub(crate) parameter: String,
    pub(crate) value: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CandidateClaim {
    pub(crate) category: ClaimCategory,
    pub(crate) severity: ClaimSeverity,
    pub(crate) message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ClaimCategory {
    Composition,
    Alignment,
    Spacing,
    Legibility,
    Contrast,
    Color,
    BrandFit,
    Accessibility,
    SmallSize,
    Technical,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ClaimSeverity {
    Note,
    Minor,
    Substantive,
    Blocking,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CandidateQaSummary {
    pub(crate) status: CandidateQaStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) qa_result_digest: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum CandidateQaStatus {
    Pass,
    Fail,
    Skipped,
    Unavailable,
    Error,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DesignReviewPacket {
    pub(crate) schema: String,
    pub(crate) schema_version: u8,
    pub(crate) brief_digest: String,
    pub(crate) candidate_digests: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) previous_review_digest: Option<String>,
    pub(crate) annotations: Vec<ReviewAnnotation>,
    pub(crate) dispositions: Vec<CandidateDisposition>,
    pub(crate) overall_disposition: OverallDisposition,
    pub(crate) summary: String,
    pub(crate) review_digest: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReviewAnnotation {
    pub(crate) annotation_id: String,
    pub(crate) candidate_digest: String,
    pub(crate) visual_evidence_digest: String,
    pub(crate) artifact_role: ArtifactRole,
    pub(crate) png_digest: String,
    pub(crate) scope: ReviewAnnotationScope,
    pub(crate) category: ClaimCategory,
    pub(crate) severity: ClaimSeverity,
    pub(crate) comment: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) element_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ArtifactRole {
    Current,
    Baseline,
    Before,
    After,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum ReviewAnnotationScope {
    Artifact,
    Region {
        x_millionths: u32,
        y_millionths: u32,
        width_millionths: u32,
        height_millionths: u32,
    },
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CandidateDisposition {
    pub(crate) candidate_digest: String,
    pub(crate) disposition: CandidateDispositionValue,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum CandidateDispositionValue {
    Unreviewed,
    Preferred,
    Approved,
    Rejected,
    NeedsRevision,
    Deferred,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum OverallDisposition {
    NoDecision,
    Preferred { candidate_digest: String },
    Approved { candidate_digest: String },
    NeedsRevision { candidate_digest: String },
    RejectedAll,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ExpectedPacketKind {
    Any,
    Brief,
    Candidate,
    Review,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum PacketKind {
    Brief,
    Candidate,
    Review,
}

impl DesignEvidencePacket {
    pub(crate) fn kind(&self) -> PacketKind {
        match self {
            Self::Brief(_) => PacketKind::Brief,
            Self::Candidate(_) => PacketKind::Candidate,
            Self::Review(_) => PacketKind::Review,
        }
    }

    pub(crate) fn digest(&self) -> &str {
        match self {
            Self::Brief(packet) => &packet.brief_digest,
            Self::Candidate(packet) => &packet.candidate_digest,
            Self::Review(packet) => &packet.review_digest,
        }
    }

    pub(crate) fn public_id(&self) -> &str {
        match self {
            Self::Brief(packet) => &packet.brief_id,
            Self::Candidate(packet) => &packet.candidate_id,
            Self::Review(packet) => packet.review_digest.get(7..19).unwrap_or("review"),
        }
    }
}

impl ExpectedPacketKind {
    pub(crate) fn accepts(self, actual: PacketKind) -> bool {
        matches!(self, Self::Any)
            || matches!(
                (self, actual),
                (Self::Brief, PacketKind::Brief)
                    | (Self::Candidate, PacketKind::Candidate)
                    | (Self::Review, PacketKind::Review)
            )
    }
}
