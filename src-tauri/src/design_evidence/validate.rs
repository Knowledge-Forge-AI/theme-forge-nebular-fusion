use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

use crate::errors::{StudioCommandError, StudioReasonCode, StudioResult};
use crate::sidecar::json_decoder;
use crate::sidecar::visual_evidence::validate_visual_evidence;

use super::types::*;

pub(crate) const MAX_PACKET_BYTES: usize = 16_777_216;
const MAX_VISUAL_BYTES: usize = 8_388_608;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const BRIEF_DOMAIN: &[u8] = b"tfsb.design-brief-v1\n";
const CANDIDATE_DOMAIN: &[u8] = b"tfsb.design-candidate-v1\n";
const REVIEW_DOMAIN: &[u8] = b"tfsb.design-review-v1\n";

fn invalid<T>() -> StudioResult<T> {
    Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid))
}

fn valid_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn safe_text(value: &str, max: usize, multiline: bool) -> bool {
    if value.is_empty() || value.len() > max || !value.nfc().eq(value.chars()) {
        return false;
    }
    !value.chars().any(|character| {
        (character <= '\u{001f}' && !(multiline && character == '\n')) || character == '\u{007f}'
    })
}

fn public_id(value: &str) -> bool {
    if !safe_text(value, 128, false) || !value.is_ascii() {
        return false;
    }
    let mut bytes = value.bytes();
    if !bytes.next().is_some_and(|byte| byte.is_ascii_lowercase()) {
        return false;
    }
    let mut after_separator = false;
    for byte in bytes {
        if byte.is_ascii_lowercase() || byte.is_ascii_digit() {
            after_separator = false;
        } else if matches!(byte, b'-' | b'.') && !after_separator {
            after_separator = true;
        } else {
            return false;
        }
    }
    !after_separator
}

fn package_component(value: &str) -> bool {
    value
        .bytes()
        .next()
        .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
}

fn package_id(value: &str) -> bool {
    if !safe_text(value, 214, false) || !value.is_ascii() {
        return false;
    }
    if let Some(scoped) = value.strip_prefix('@') {
        let mut parts = scoped.split('/');
        return parts.next().is_some_and(package_component)
            && parts.next().is_some_and(package_component)
            && parts.next().is_none();
    }
    package_component(value)
}

fn valid_version(value: &str) -> bool {
    if !safe_text(value, 64, false) {
        return false;
    }
    let (main, suffix) = value
        .split_once('-')
        .map_or((value, None), |(left, right)| (left, Some(right)));
    let mut parts = main.split('.');
    let numbers = parts.by_ref().take(3).collect::<Vec<_>>();
    numbers.len() == 3
        && parts.next().is_none()
        && numbers
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
        && suffix.is_none_or(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
        })
}

fn sorted_unique(values: &[String]) -> bool {
    values.windows(2).all(|pair| pair[0] < pair[1])
}

fn sorted_public_ids(values: &[String], maximum: usize, minimum: usize) -> bool {
    values.len() >= minimum
        && values.len() <= maximum
        && values.iter().all(|value| public_id(value))
        && sorted_unique(values)
}

fn proposal_kind_name(value: ProposalKind) -> &'static str {
    match value {
        ProposalKind::EvidenceOnly => "evidence-only",
        ProposalKind::Derive => "derive",
        ProposalKind::QaBaseline => "qa-baseline",
        ProposalKind::ConsumerInstall => "consumer-install",
        ProposalKind::ConsumerSync => "consumer-sync",
        ProposalKind::Export => "export",
    }
}

fn valid_background(value: &str) -> bool {
    value == "transparent"
        || value.strip_prefix('#').is_some_and(|hex| {
            hex.len() == 8
                && hex
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || matches!(byte, b'A'..=b'F'))
        })
        || value.strip_prefix("token:").is_some_and(|token| {
            let mut parts = token.split('-');
            parts.next().is_some_and(|part| {
                !part.is_empty()
                    && part
                        .bytes()
                        .next()
                        .is_some_and(|byte| byte.is_ascii_lowercase())
                    && part
                        .bytes()
                        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
            }) && parts.all(|part| {
                !part.is_empty()
                    && part
                        .bytes()
                        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
            })
        })
}

fn validate_material(material: &DesignEvidenceMaterial) -> bool {
    public_id(&material.identifier)
        && valid_digest(&material.digest)
        && material
            .license_expression
            .as_ref()
            .is_none_or(|value| safe_text(value, 256, false))
        && material
            .notice_digest
            .as_ref()
            .is_none_or(|value| valid_digest(value))
}

fn material_kind_name(kind: MaterialKind) -> &'static str {
    match kind {
        MaterialKind::UserSupplied => "user-supplied",
        MaterialKind::TfsbRendered => "tfsb-rendered",
        MaterialKind::ThirdParty => "third-party",
        MaterialKind::ExternalClaim => "external-claim",
    }
}

fn sorted_materials(materials: &[DesignEvidenceMaterial]) -> bool {
    materials.windows(2).all(|pair| {
        (
            material_kind_name(pair[0].kind),
            pair[0].identifier.as_bytes(),
            pair[0].digest.as_bytes(),
        ) < (
            material_kind_name(pair[1].kind),
            pair[1].identifier.as_bytes(),
            pair[1].digest.as_bytes(),
        )
    })
}

fn validate_visuals(
    visuals: &[crate::sidecar::visual_evidence::VisualEvidenceResult],
    min: usize,
) -> StudioResult<()> {
    if visuals.len() < min || visuals.len() > 8 {
        return invalid();
    }
    let mut total = 0_usize;
    for visual in visuals {
        validate_visual_evidence(visual)?;
        total = total.saturating_add(visual.decoded_byte_total());
    }
    if total > MAX_VISUAL_BYTES
        || visuals.iter().enumerate().any(|(index, visual)| {
            visuals[..index]
                .iter()
                .any(|previous| previous.evidence_digest() == visual.evidence_digest())
        })
    {
        return invalid();
    }
    Ok(())
}

fn validate_context(context: &DesignEvidenceContext) -> bool {
    context.core_package_version == "0.4.0"
        && context.studio_version == "0.1.0"
        && context.studio_protocol_version == "1.2"
        && context
            .project
            .label
            .as_ref()
            .is_none_or(|label| safe_text(label, 256, false))
        && valid_digest(&context.project.canonical_digest)
        && valid_digest(&context.project.brand_system_digest)
        && context.source.as_ref().is_none_or(|source| {
            package_id(&source.package_id)
                && valid_version(&source.brand_version)
                && valid_digest(&source.brand_system_digest)
        })
}

fn validate_brief(packet: &DesignBriefPacket) -> StudioResult<()> {
    if packet.schema != "tfsb.design-brief"
        || packet.schema_version != 1
        || !public_id(&packet.brief_id)
        || packet.revision == 0
        || packet.revision > MAX_SAFE_INTEGER
        || !safe_text(&packet.title, 512, false)
        || !safe_text(&packet.objective, 4_096, true)
        || !validate_context(&packet.context)
        || packet.targets.is_empty()
        || packet.targets.len() > 32
        || !valid_digest(&packet.brief_digest)
        || packet.materials.len() > 64
        || !packet.materials.iter().all(validate_material)
        || !sorted_materials(&packet.materials)
    {
        return invalid();
    }
    let mut target_ids = Vec::with_capacity(packet.targets.len());
    for target in &packet.targets {
        if !public_id(&target.target_id)
            || !valid_digest(&target.canonical_asset_digest)
            || !valid_digest(&target.svg_digest)
            || !public_id(&target.purpose)
            || match &target.selector {
                DesignEvidenceTargetSelector::Asset { asset_id } => !public_id(asset_id),
                DesignEvidenceTargetSelector::Binding {
                    family,
                    role,
                    variant,
                } => !public_id(family) || !public_id(role) || !public_id(variant),
            }
        {
            return invalid();
        }
        target_ids.push(target.target_id.clone());
    }
    if !sorted_unique(&target_ids)
        || packet.constraints.allowed_proposal_kinds.is_empty()
        || packet.constraints.allowed_proposal_kinds.len() > 6
        || !packet
            .constraints
            .allowed_proposal_kinds
            .windows(2)
            .all(|pair| proposal_kind_name(pair[0]) < proposal_kind_name(pair[1]))
        || !sorted_public_ids(&packet.constraints.required_token_ids, 128, 0)
        || !sorted_public_ids(&packet.constraints.required_recipe_ids, 128, 0)
        || !sorted_public_ids(&packet.constraints.qa_profile_ids, 128, 0)
        || packet.constraints.render_tuples.is_empty()
        || packet.constraints.render_tuples.len() > 16
        || !packet.constraints.render_tuples.iter().all(|tuple| {
            (16..=1_024).contains(&tuple.width)
                && (16..=1_024).contains(&tuple.height)
                && valid_background(&tuple.background)
        })
        || packet.constraints.acceptance_criteria.is_empty()
        || packet.constraints.acceptance_criteria.len() > 64
        || packet.constraints.prohibited_changes.len() > 64
        || !packet
            .constraints
            .acceptance_criteria
            .iter()
            .chain(&packet.constraints.prohibited_changes)
            .all(|text| safe_text(text, 4_096, true))
    {
        return invalid();
    }
    validate_visuals(&packet.visual_evidence, 0)
}

fn validate_sources(sources: &[SourcePackageIntent]) -> bool {
    !sources.is_empty()
        && sources.len() <= 8
        && sources.iter().all(|source| {
            package_id(&source.package_id)
                && valid_version(&source.brand_version)
                && valid_digest(&source.brand_system_digest)
        })
        && sources
            .windows(2)
            .all(|pair| pair[0].package_id < pair[1].package_id)
}

fn validate_proposal(proposal: &CandidateProposal) -> bool {
    match proposal {
        CandidateProposal::EvidenceOnly => true,
        CandidateProposal::Derive { selection } => match selection {
            DeriveSelection::All => true,
            DeriveSelection::Recipes { recipe_ids } => sorted_public_ids(recipe_ids, 128, 1),
        },
        CandidateProposal::QaBaseline {
            profile_id,
            case_id,
        } => public_id(profile_id) && public_id(case_id),
        CandidateProposal::ConsumerInstall {
            source_packages,
            profile_ids,
            parameters,
        } => {
            validate_sources(source_packages)
                && sorted_public_ids(profile_ids, 32, 1)
                && parameters.len() <= 32
                && parameters
                    .windows(2)
                    .all(|pair| pair[0].profile_id < pair[1].profile_id)
                && parameters.iter().all(|parameter| {
                    public_id(&parameter.profile_id)
                        && parameter.values.len() <= 32
                        && parameter
                            .values
                            .windows(2)
                            .all(|pair| pair[0].parameter < pair[1].parameter)
                        && parameter.values.iter().all(|value| {
                            public_id(&value.parameter) && safe_text(&value.value, 512, false)
                        })
                })
        }
        CandidateProposal::ConsumerSync {
            source_packages,
            profile_ids,
            parameters,
        } => {
            validate_sources(source_packages)
                && profile_ids
                    .as_ref()
                    .is_none_or(|values| sorted_public_ids(values, 32, 1))
                && parameters.as_ref().is_none_or(|values| {
                    values.len() <= 32
                        && values
                            .windows(2)
                            .all(|pair| pair[0].profile_id < pair[1].profile_id)
                        && values.iter().all(|parameter| {
                            public_id(&parameter.profile_id)
                                && parameter.values.len() <= 32
                                && parameter
                                    .values
                                    .windows(2)
                                    .all(|pair| pair[0].parameter < pair[1].parameter)
                                && parameter.values.iter().all(|value| {
                                    public_id(&value.parameter)
                                        && safe_text(&value.value, 512, false)
                                })
                        })
                })
        }
        CandidateProposal::Export {
            profile_id,
            output_ids,
        } => {
            public_id(profile_id)
                && output_ids
                    .as_ref()
                    .is_none_or(|values| sorted_public_ids(values, 128, 1))
        }
    }
}

fn validate_candidate(packet: &DesignCandidatePacket) -> StudioResult<()> {
    if packet.schema != "tfsb.design-candidate"
        || packet.schema_version != 1
        || !valid_digest(&packet.brief_digest)
        || !public_id(&packet.candidate_id)
        || packet.revision == 0
        || packet.revision > MAX_SAFE_INTEGER
        || packet
            .revision_of
            .as_ref()
            .is_some_and(|value| !valid_digest(value))
        || !safe_text(&packet.author.label, 256, false)
        || packet
            .author
            .tool_name
            .as_ref()
            .is_some_and(|value| !safe_text(value, 256, false))
        || packet
            .author
            .tool_version
            .as_ref()
            .is_some_and(|value| !safe_text(value, 128, false))
        || !safe_text(&packet.title, 512, false)
        || !safe_text(&packet.rationale, 4_096, true)
        || !validate_proposal(&packet.proposal)
        || packet.claims.len() > 64
        || !packet
            .claims
            .iter()
            .all(|claim| safe_text(&claim.message, 4_096, true))
        || packet
            .qa_summary
            .qa_result_digest
            .as_ref()
            .is_some_and(|value| !valid_digest(value))
        || packet.materials.len() > 64
        || !packet.materials.iter().all(validate_material)
        || !sorted_materials(&packet.materials)
        || !valid_digest(&packet.candidate_digest)
    {
        return invalid();
    }
    validate_visuals(&packet.visual_evidence, 1)
}

fn validate_review(packet: &DesignReviewPacket) -> StudioResult<()> {
    if packet.schema != "tfsb.design-review"
        || packet.schema_version != 1
        || !valid_digest(&packet.brief_digest)
        || packet.candidate_digests.is_empty()
        || packet.candidate_digests.len() > 8
        || !sorted_unique(&packet.candidate_digests)
        || !packet
            .candidate_digests
            .iter()
            .all(|value| valid_digest(value))
        || packet
            .previous_review_digest
            .as_ref()
            .is_some_and(|value| !valid_digest(value))
        || packet.annotations.len() > 128
        || packet.dispositions.len() != packet.candidate_digests.len()
        || !safe_text(&packet.summary, 4_096, true)
        || !valid_digest(&packet.review_digest)
    {
        return invalid();
    }
    if !packet
        .annotations
        .windows(2)
        .all(|pair| pair[0].annotation_id < pair[1].annotation_id)
    {
        return invalid();
    }
    for annotation in &packet.annotations {
        if !public_id(&annotation.annotation_id)
            || !packet
                .candidate_digests
                .contains(&annotation.candidate_digest)
            || !valid_digest(&annotation.visual_evidence_digest)
            || !valid_digest(&annotation.png_digest)
            || !safe_text(&annotation.comment, 2_048, true)
            || annotation
                .element_id
                .as_ref()
                .is_some_and(|value| !public_id(value))
            || match annotation.scope {
                ReviewAnnotationScope::Artifact => false,
                ReviewAnnotationScope::Region {
                    x_millionths,
                    y_millionths,
                    width_millionths,
                    height_millionths,
                } => {
                    width_millionths == 0
                        || height_millionths == 0
                        || x_millionths.saturating_add(width_millionths) > 1_000_000
                        || y_millionths.saturating_add(height_millionths) > 1_000_000
                }
            }
        {
            return invalid();
        }
    }
    let disposition_digests: Vec<String> = packet
        .dispositions
        .iter()
        .map(|item| item.candidate_digest.clone())
        .collect();
    if disposition_digests != packet.candidate_digests
        || packet
            .dispositions
            .iter()
            .any(|item| !packet.candidate_digests.contains(&item.candidate_digest))
        || packet
            .dispositions
            .iter()
            .filter(|item| {
                matches!(
                    item.disposition,
                    CandidateDispositionValue::Preferred | CandidateDispositionValue::Approved
                )
            })
            .count()
            > 1
        || packet
            .dispositions
            .iter()
            .all(|item| item.disposition == CandidateDispositionValue::Unreviewed)
    {
        return invalid();
    }
    let overall_ok = match &packet.overall_disposition {
        OverallDisposition::NoDecision => !packet.dispositions.iter().any(|item| {
            matches!(
                item.disposition,
                CandidateDispositionValue::Preferred | CandidateDispositionValue::Approved
            )
        }),
        OverallDisposition::RejectedAll => packet
            .dispositions
            .iter()
            .all(|item| item.disposition == CandidateDispositionValue::Rejected),
        OverallDisposition::Preferred { candidate_digest } => {
            packet.dispositions.iter().any(|item| {
                &item.candidate_digest == candidate_digest
                    && item.disposition == CandidateDispositionValue::Preferred
            })
        }
        OverallDisposition::Approved { candidate_digest } => {
            packet.dispositions.iter().any(|item| {
                &item.candidate_digest == candidate_digest
                    && item.disposition == CandidateDispositionValue::Approved
            })
        }
        OverallDisposition::NeedsRevision { candidate_digest } => {
            packet.dispositions.iter().any(|item| {
                &item.candidate_digest == candidate_digest
                    && item.disposition == CandidateDispositionValue::NeedsRevision
            })
        }
    };
    if !overall_ok {
        return invalid();
    }
    Ok(())
}

fn projection_and_domain(packet: &DesignEvidencePacket) -> StudioResult<(Vec<u8>, &'static [u8])> {
    match packet {
        DesignEvidencePacket::Brief(value) => Ok((
            json_decoder::canonical_projection(value, "briefDigest")?,
            BRIEF_DOMAIN,
        )),
        DesignEvidencePacket::Candidate(value) => Ok((
            json_decoder::canonical_projection(value, "candidateDigest")?,
            CANDIDATE_DOMAIN,
        )),
        DesignEvidencePacket::Review(value) => Ok((
            json_decoder::canonical_projection(value, "reviewDigest")?,
            REVIEW_DOMAIN,
        )),
    }
}

pub(crate) fn validate_packet(packet: &DesignEvidencePacket) -> StudioResult<()> {
    match packet {
        DesignEvidencePacket::Brief(value) => validate_brief(value)?,
        DesignEvidencePacket::Candidate(value) => validate_candidate(value)?,
        DesignEvidencePacket::Review(value) => validate_review(value)?,
    }
    let (projection, domain) = projection_and_domain(packet)?;
    let mut hasher = Sha256::new();
    hasher.update(domain);
    hasher.update(projection);
    let expected = format!("sha256:{:x}", hasher.finalize());
    if expected != packet.digest() {
        return invalid();
    }
    Ok(())
}

pub(crate) fn canonical_packet_bytes(packet: &DesignEvidencePacket) -> StudioResult<Vec<u8>> {
    validate_packet(packet)?;
    canonical_validated_packet_bytes(packet)
}

fn canonical_validated_packet_bytes(packet: &DesignEvidencePacket) -> StudioResult<Vec<u8>> {
    json_decoder::canonical_pretty(packet)
}

pub(crate) fn parse_packet_bytes(bytes: &[u8]) -> StudioResult<DesignEvidencePacket> {
    if bytes.len() > MAX_PACKET_BYTES || bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        return invalid();
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|_| StudioCommandError::new(StudioReasonCode::ProtocolInvalid))?;
    let packet: DesignEvidencePacket = serde_json::from_str(text)
        .map_err(|_| StudioCommandError::new(StudioReasonCode::ProtocolInvalid))?;
    validate_packet(&packet)?;
    if canonical_validated_packet_bytes(&packet)? != bytes {
        return invalid();
    }
    Ok(packet)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::value::Value as JsonNode;

    #[test]
    fn golden_examples_parse_and_digest() {
        for bytes in [
            include_bytes!("../../../protocol/tfsb-design-evidence-v1/examples/brief.json")
                .as_slice(),
            include_bytes!("../../../protocol/tfsb-design-evidence-v1/examples/candidate-a.json")
                .as_slice(),
            include_bytes!("../../../protocol/tfsb-design-evidence-v1/examples/candidate-b.json")
                .as_slice(),
            include_bytes!("../../../protocol/tfsb-design-evidence-v1/examples/review.json")
                .as_slice(),
        ] {
            assert!(parse_packet_bytes(bytes).is_ok());
        }
    }

    #[test]
    fn noncanonical_and_duplicate_input_fail() {
        let bytes = include_bytes!("../../../protocol/tfsb-design-evidence-v1/examples/brief.json");
        let mut noncanonical = bytes.to_vec();
        noncanonical.pop();
        assert!(parse_packet_bytes(&noncanonical).is_err());
        let duplicate = if let Ok(text) = std::str::from_utf8(bytes) {
            text.replacen(
                "  \"title\": \"Terminal Nova Café mark review\",\n",
                "  \"title\": \"Terminal Nova Café mark review\",\n  \"title\": \"Terminal Nova Café mark review\",\n",
                1,
            )
        } else {
            String::new()
        };
        assert!(parse_packet_bytes(duplicate.as_bytes()).is_err());
    }

    #[test]
    fn shared_negative_corpus_is_rejected_independently() {
        let parsed: Result<JsonNode, _> = serde_json::from_slice(include_bytes!(
            "../../../protocol/tfsb-design-evidence-v1/negative-corpus.json"
        ));
        assert!(parsed.is_ok());
        if let Ok(corpus) = parsed {
            let cases = corpus.get("cases").and_then(JsonNode::as_array);
            assert!(cases.is_some_and(|items| items.len() >= 12));
            if let Some(cases) = cases {
                for case in cases {
                    let packet = case.get("packet").map(serde_json::to_vec);
                    assert!(packet.as_ref().is_some_and(Result::is_ok));
                    if let Some(Ok(packet)) = packet {
                        assert!(
                            parse_packet_bytes(&packet).is_err(),
                            "negative case accepted: {}",
                            case.get("id")
                                .and_then(JsonNode::as_str)
                                .map_or("unknown", |value| value)
                        );
                    }
                }
            }
        }
    }
}
