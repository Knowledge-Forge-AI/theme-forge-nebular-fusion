//! Pure portable paired-profile v2 packet authority.
//!
//! This module owns only the brief/candidate/review packet protocol. Profile
//! canonicalization and sourceCanonicalDigest authority remain with Solar's
//! paired-v2 binder/compile path. Packet self-digests establish only
//! self-consistency; they are not signatures, authorship, custody, or policy
//! approval.

use std::collections::BTreeSet;
use std::fmt;

use base64::Engine as _;
use serde::de::{self, DeserializeOwned, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use sha2::{Digest, Sha256};

use crate::errors::{StudioCommandError, StudioReasonCode, StudioResult};
use crate::sidecar::json_decoder::{canonical_sorted_pretty, canonical_sorted_projection};

pub const PAIRED_V2_PACKET_MAX_BYTES: usize = 2 * 1024 * 1024;
/// The transport cap bounds the schema probe so oversized paired packets are
/// fenced before the generic ThemeLab runner can see them. `parse_packet`
/// still applies the stricter canonical paired-packet cap above.
pub const PAIRED_V2_PACKET_PROBE_MAX_BYTES: usize = 16 * 1024 * 1024;
pub const PAIRED_V2_SOURCE_MAX_BYTES: usize = 128 * 1024;
pub const PAIRED_V2_SOURCE_BASE64_MAX_BYTES: usize = 175_104;
pub const PAIRED_V2_BRIEF_ID_MAX_BYTES: usize = 64;
pub const PAIRED_V2_CANDIDATE_ID_MAX_BYTES: usize = 64;
pub const PAIRED_V2_REVIEW_ID_MAX_BYTES: usize = 64;
pub const PAIRED_V2_TITLE_MAX_BYTES: usize = 120;
pub const PAIRED_V2_GOAL_MAX_BYTES: usize = 2_048;
pub const PAIRED_V2_RATIONALE_MAX_BYTES: usize = 2_048;
pub const PAIRED_V2_SUMMARY_MAX_BYTES: usize = 4_096;
pub const PAIRED_V2_CRITERION_MAX_BYTES: usize = 2_048;
pub const PAIRED_V2_PROHIBITED_CHANGE_MAX_BYTES: usize = 2_048;
pub const PAIRED_V2_COMMENT_MAX_BYTES: usize = 2_048;
pub const PAIRED_V2_EDITABLE_PATH_MAX_BYTES: usize = 256;
pub const PAIRED_V2_MAX_EDITABLE_PATHS: usize = 64;
pub const PAIRED_V2_MAX_CRITERIA: usize = 16;
pub const PAIRED_V2_MAX_PROHIBITED_CHANGES: usize = 16;
pub const PAIRED_V2_MAX_CANDIDATES: usize = 8;

pub const PAIRED_PROFILE_SCHEMA_PREFIX: &str = "tf-paired-profile-";
const PAIRED_V2_SCHEMA_VERSION: u32 = 1;

fn invalid<T>() -> StudioResult<T> {
    Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid))
}

fn too_large<T>() -> StudioResult<T> {
    Err(StudioCommandError::new(StudioReasonCode::ResultTooLarge))
}

fn bytes(value: &str) -> usize {
    value.len()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PairedV2PacketKind {
    #[serde(rename = "tf-paired-profile-v2-brief")]
    Brief,
    #[serde(rename = "tf-paired-profile-v2-candidate")]
    Candidate,
    #[serde(rename = "tf-paired-profile-v2-review")]
    Review,
}

impl PairedV2PacketKind {
    pub const fn schema(self) -> &'static str {
        match self {
            Self::Brief => "tf-paired-profile-v2-brief",
            Self::Candidate => "tf-paired-profile-v2-candidate",
            Self::Review => "tf-paired-profile-v2-review",
        }
    }

    pub const fn digest_field(self) -> &'static str {
        match self {
            Self::Brief => "briefDigest",
            Self::Candidate => "candidateDigest",
            Self::Review => "reviewDigest",
        }
    }

    pub fn from_schema(value: &str) -> Option<Self> {
        match value {
            "tf-paired-profile-v2-brief" => Some(Self::Brief),
            "tf-paired-profile-v2-candidate" => Some(Self::Candidate),
            "tf-paired-profile-v2-review" => Some(Self::Review),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairedV2PacketClassification {
    Paired { schema: String },
    NonPaired,
    Indeterminate,
}

/// The exact adjacent-tag request used by the
/// `studio_app_theme_paired_packet_create_v2` command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "input", deny_unknown_fields)]
pub enum PairedV2PacketCreateRequest {
    #[serde(rename = "tf-paired-profile-v2-brief")]
    Brief(PairedV2BriefCreateInput),
    #[serde(rename = "tf-paired-profile-v2-candidate")]
    Candidate(PairedV2CandidateCreateInput),
    #[serde(rename = "tf-paired-profile-v2-review")]
    Review(PairedV2ReviewCreateInput),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairedV2BriefCreateInput {
    pub schema: String,
    pub schema_version: u32,
    pub brief_id: String,
    pub title: String,
    pub goal: String,
    pub profile_name: String,
    pub profile_version: String,
    pub source_profile_sha256: String,
    pub source_canonical_digest: String,
    pub editable_paths: Vec<String>,
    pub allowed_modes: Vec<String>,
    pub acceptance_criteria: Vec<String>,
    pub prohibited_changes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairedV2CandidateCreateInput {
    pub schema: String,
    pub schema_version: u32,
    pub candidate_id: String,
    pub brief_digest: String,
    pub source_bytes_base64: String,
    pub source_profile_sha256: String,
    pub source_canonical_digest: String,
    pub rationale: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairedV2ReviewCreateInput {
    pub schema: String,
    pub schema_version: u32,
    pub review_id: String,
    pub brief_digest: String,
    pub candidate_digests: Vec<String>,
    pub dispositions: Vec<PairedV2ReviewDisposition>,
    pub overall_disposition: PairedV2ReviewDispositionKind,
    pub summary: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PairedV2ReviewDispositionKind {
    Approve,
    Revise,
    Reject,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedV2ReviewDisposition {
    pub candidate_digest: String,
    pub disposition: PairedV2ReviewDispositionKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

impl<'de> Deserialize<'de> for PairedV2ReviewDisposition {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct DispositionVisitor;

        impl<'de> Visitor<'de> for DispositionVisitor {
            type Value = PairedV2ReviewDisposition;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a closed paired-v2 review disposition object")
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                let mut candidate_digest = None;
                let mut disposition = None;
                let mut comment = None;
                let mut comment_present = false;

                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "candidateDigest" => {
                            if candidate_digest.is_some() {
                                return Err(de::Error::duplicate_field("candidateDigest"));
                            }
                            candidate_digest = Some(map.next_value::<String>()?);
                        }
                        "disposition" => {
                            if disposition.is_some() {
                                return Err(de::Error::duplicate_field("disposition"));
                            }
                            disposition = Some(map.next_value::<PairedV2ReviewDispositionKind>()?);
                        }
                        "comment" => {
                            if comment_present {
                                return Err(de::Error::duplicate_field("comment"));
                            }
                            comment_present = true;
                            // A present null is not the same as an omitted
                            // optional comment in the paired packet contract.
                            comment = Some(map.next_value::<String>()?);
                        }
                        _ => {
                            return Err(de::Error::unknown_field(
                                &key,
                                &["candidateDigest", "disposition", "comment"],
                            ));
                        }
                    }
                }

                Ok(PairedV2ReviewDisposition {
                    candidate_digest: candidate_digest
                        .ok_or_else(|| de::Error::missing_field("candidateDigest"))?,
                    disposition: disposition
                        .ok_or_else(|| de::Error::missing_field("disposition"))?,
                    comment,
                })
            }
        }

        deserializer.deserialize_map(DispositionVisitor)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairedV2BriefPacket {
    pub schema: String,
    pub schema_version: u32,
    pub brief_id: String,
    pub title: String,
    pub goal: String,
    pub profile_name: String,
    pub profile_version: String,
    pub source_profile_sha256: String,
    pub source_canonical_digest: String,
    pub editable_paths: Vec<String>,
    pub allowed_modes: Vec<String>,
    pub acceptance_criteria: Vec<String>,
    pub prohibited_changes: Vec<String>,
    pub brief_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairedV2CandidatePacket {
    pub schema: String,
    pub schema_version: u32,
    pub candidate_id: String,
    pub brief_digest: String,
    pub source_bytes_base64: String,
    pub source_profile_sha256: String,
    pub source_canonical_digest: String,
    pub rationale: String,
    pub candidate_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairedV2ReviewPacket {
    pub schema: String,
    pub schema_version: u32,
    pub review_id: String,
    pub brief_digest: String,
    pub candidate_digests: Vec<String>,
    pub dispositions: Vec<PairedV2ReviewDisposition>,
    pub overall_disposition: PairedV2ReviewDispositionKind,
    pub summary: String,
    pub review_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairedV2Packet {
    Brief(PairedV2BriefPacket),
    Candidate(PairedV2CandidatePacket),
    Review(PairedV2ReviewPacket),
}

impl PairedV2Packet {
    pub const fn kind(&self) -> PairedV2PacketKind {
        match self {
            Self::Brief(_) => PairedV2PacketKind::Brief,
            Self::Candidate(_) => PairedV2PacketKind::Candidate,
            Self::Review(_) => PairedV2PacketKind::Review,
        }
    }

    pub fn digest(&self) -> &str {
        match self {
            Self::Brief(packet) => &packet.brief_digest,
            Self::Candidate(packet) => &packet.candidate_digest,
            Self::Review(packet) => &packet.review_digest,
        }
    }

    fn set_digest(&mut self, digest: String) {
        match self {
            Self::Brief(packet) => packet.brief_digest = digest,
            Self::Candidate(packet) => packet.candidate_digest = digest,
            Self::Review(packet) => packet.review_digest = digest,
        }
    }
}

impl Serialize for PairedV2Packet {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Brief(packet) => packet.serialize(serializer),
            Self::Candidate(packet) => packet.serialize(serializer),
            Self::Review(packet) => packet.serialize(serializer),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedV2PacketEnvelope {
    pub kind: String,
    pub canonical_json: String,
    pub digest: String,
    pub packet_digest_verified: bool,
    pub packet: PairedV2Packet,
}

struct SchemaProbeValue(Option<String>);

impl<'de> Deserialize<'de> for SchemaProbeValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct ValueVisitor;

        impl<'de> Visitor<'de> for ValueVisitor {
            type Value = SchemaProbeValue;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("any JSON value for a bounded schema probe")
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(SchemaProbeValue(Some(value.to_owned())))
            }

            fn visit_string<E>(self, value: String) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(SchemaProbeValue(Some(value)))
            }

            fn visit_bool<E>(self, _value: bool) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(SchemaProbeValue(None))
            }

            fn visit_i64<E>(self, _value: i64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(SchemaProbeValue(None))
            }

            fn visit_u64<E>(self, _value: u64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(SchemaProbeValue(None))
            }

            fn visit_f64<E>(self, _value: f64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(SchemaProbeValue(None))
            }

            fn visit_none<E>(self) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(SchemaProbeValue(None))
            }

            fn visit_unit<E>(self) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(SchemaProbeValue(None))
            }

            fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                while sequence.next_element::<IgnoredAny>()?.is_some() {}
                Ok(SchemaProbeValue(None))
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
                Ok(SchemaProbeValue(None))
            }
        }

        deserializer.deserialize_any(ValueVisitor)
    }
}

struct SchemaProbeVisitor;

impl<'de> Visitor<'de> for SchemaProbeVisitor {
    type Value = Option<String>;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON object with an optional schema string")
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut paired_schema = None;
        while let Some(key) = map.next_key::<String>()? {
            let value = map.next_value::<SchemaProbeValue>()?.0;
            if key == "schema"
                && value
                    .as_deref()
                    .is_some_and(|schema| schema.starts_with(PAIRED_PROFILE_SCHEMA_PREFIX))
                && paired_schema.is_none()
            {
                paired_schema = value;
            }
        }
        Ok(paired_schema)
    }
}

/// Classify without routing nonpaired JSON through a paired parser. The
/// result is tri-state so malformed/deep/oversized input can fall through to
/// the existing generic route unless the caller explicitly requested paired.
pub fn classify_packet(bytes: &[u8]) -> PairedV2PacketClassification {
    if bytes.len() > PAIRED_V2_PACKET_PROBE_MAX_BYTES {
        return PairedV2PacketClassification::Indeterminate;
    }
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    let result = deserializer.deserialize_map(SchemaProbeVisitor);
    if result.is_err() || deserializer.end().is_err() {
        return PairedV2PacketClassification::Indeterminate;
    }
    match result.ok().flatten() {
        Some(schema) => PairedV2PacketClassification::Paired { schema },
        None => PairedV2PacketClassification::NonPaired,
    }
}

fn validate_schema(schema: &str, expected: PairedV2PacketKind) -> StudioResult<()> {
    if schema != expected.schema() {
        return invalid();
    }
    Ok(())
}

fn validate_version(schema_version: u32) -> StudioResult<()> {
    if schema_version != PAIRED_V2_SCHEMA_VERSION {
        return invalid();
    }
    Ok(())
}

fn validate_nonempty(value: &str, max_bytes: usize) -> StudioResult<()> {
    if value.is_empty() || bytes(value) > max_bytes {
        return invalid();
    }
    Ok(())
}

fn validate_hash(value: &str) -> StudioResult<()> {
    if bytes(value) != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return invalid();
    }
    Ok(())
}

fn validate_editable_path(value: &str) -> StudioResult<()> {
    validate_nonempty(value, PAIRED_V2_EDITABLE_PATH_MAX_BYTES)?;
    if matches!(value, "color.*" | "typography.*" | "radius.*") {
        return Ok(());
    }
    let mut parts = value.splitn(2, '.');
    let Some(group) = parts.next() else {
        return invalid();
    };
    let Some(leaf) = parts.next() else {
        return invalid();
    };
    if !matches!(group, "color" | "typography" | "radius") {
        return invalid();
    }
    let mut chars = leaf.chars();
    if !chars
        .next()
        .is_some_and(|character| character.is_ascii_alphabetic())
        || leaf.len() > 221
        || !chars.all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '-')
        })
    {
        return invalid();
    }
    Ok(())
}

fn validate_editable_paths(values: &[String]) -> StudioResult<()> {
    if values.len() > PAIRED_V2_MAX_EDITABLE_PATHS {
        return invalid();
    }
    let mut seen = BTreeSet::new();
    for value in values {
        validate_editable_path(value)?;
        if !seen.insert(value) {
            return invalid();
        }
    }
    Ok(())
}

fn validate_modes(values: &[String]) -> StudioResult<()> {
    if values.is_empty() || values.len() > 2 {
        return invalid();
    }
    let mut seen = BTreeSet::new();
    for value in values {
        if !matches!(value.as_str(), "light" | "dark") || !seen.insert(value) {
            return invalid();
        }
    }
    Ok(())
}

fn validate_string_list(
    values: &[String],
    max_count: usize,
    max_item_bytes: usize,
) -> StudioResult<()> {
    if values.len() > max_count {
        return invalid();
    }
    for value in values {
        validate_nonempty(value, max_item_bytes)?;
    }
    Ok(())
}

fn decode_source(value: &str) -> StudioResult<Vec<u8>> {
    if value.is_empty() || bytes(value) > PAIRED_V2_SOURCE_BASE64_MAX_BYTES {
        return invalid();
    }
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(value.as_bytes())
        .map_err(|_| StudioCommandError::new(StudioReasonCode::ProtocolInvalid))?;
    if decoded.is_empty() || decoded.len() > PAIRED_V2_SOURCE_MAX_BYTES {
        return invalid();
    }
    if base64::engine::general_purpose::STANDARD.encode(&decoded) != value {
        return invalid();
    }
    Ok(decoded)
}

#[derive(Debug)]
struct BriefFields<'a> {
    schema: &'a str,
    schema_version: u32,
    brief_id: &'a str,
    title: &'a str,
    goal: &'a str,
    profile_name: &'a str,
    profile_version: &'a str,
    source_profile_sha256: &'a str,
    source_canonical_digest: &'a str,
    editable_paths: &'a [String],
    allowed_modes: &'a [String],
    acceptance_criteria: &'a [String],
    prohibited_changes: &'a [String],
    digest: Option<&'a str>,
}

fn validate_brief_common(fields: BriefFields<'_>) -> StudioResult<()> {
    validate_schema(fields.schema, PairedV2PacketKind::Brief)?;
    validate_version(fields.schema_version)?;
    validate_nonempty(fields.brief_id, PAIRED_V2_BRIEF_ID_MAX_BYTES)?;
    validate_nonempty(fields.title, PAIRED_V2_TITLE_MAX_BYTES)?;
    validate_nonempty(fields.goal, PAIRED_V2_GOAL_MAX_BYTES)?;
    validate_nonempty(fields.profile_name, 256)?;
    validate_nonempty(fields.profile_version, 64)?;
    validate_hash(fields.source_profile_sha256)?;
    validate_hash(fields.source_canonical_digest)?;
    validate_editable_paths(fields.editable_paths)?;
    validate_modes(fields.allowed_modes)?;
    validate_string_list(
        fields.acceptance_criteria,
        PAIRED_V2_MAX_CRITERIA,
        PAIRED_V2_CRITERION_MAX_BYTES,
    )?;
    validate_string_list(
        fields.prohibited_changes,
        PAIRED_V2_MAX_PROHIBITED_CHANGES,
        PAIRED_V2_PROHIBITED_CHANGE_MAX_BYTES,
    )?;
    if let Some(digest) = fields.digest {
        validate_hash(digest)?;
    }
    Ok(())
}

#[derive(Debug)]
struct CandidateFields<'a> {
    schema: &'a str,
    schema_version: u32,
    candidate_id: &'a str,
    brief_digest: &'a str,
    source_bytes_base64: &'a str,
    source_profile_sha256: &'a str,
    source_canonical_digest: &'a str,
    rationale: &'a str,
    digest: Option<&'a str>,
}

fn validate_candidate_common(fields: CandidateFields<'_>) -> StudioResult<Vec<u8>> {
    validate_schema(fields.schema, PairedV2PacketKind::Candidate)?;
    validate_version(fields.schema_version)?;
    validate_nonempty(fields.candidate_id, PAIRED_V2_CANDIDATE_ID_MAX_BYTES)?;
    validate_hash(fields.brief_digest)?;
    let source = decode_source(fields.source_bytes_base64)?;
    validate_hash(fields.source_profile_sha256)?;
    validate_hash(fields.source_canonical_digest)?;
    validate_nonempty(fields.rationale, PAIRED_V2_RATIONALE_MAX_BYTES)?;
    let actual_source_hash = format!("{:x}", Sha256::digest(&source));
    if actual_source_hash != fields.source_profile_sha256 {
        return invalid();
    }
    if let Some(digest) = fields.digest {
        validate_hash(digest)?;
    }
    Ok(source)
}

fn validate_disposition(value: &PairedV2ReviewDisposition) -> StudioResult<()> {
    validate_hash(&value.candidate_digest)?;
    if let Some(comment) = value.comment.as_deref() {
        validate_nonempty(comment, PAIRED_V2_COMMENT_MAX_BYTES)?;
    }
    Ok(())
}

#[derive(Debug)]
struct ReviewFields<'a> {
    schema: &'a str,
    schema_version: u32,
    review_id: &'a str,
    brief_digest: &'a str,
    candidate_digests: &'a [String],
    dispositions: &'a [PairedV2ReviewDisposition],
    summary: &'a str,
    digest: Option<&'a str>,
}

fn validate_review_common(fields: ReviewFields<'_>) -> StudioResult<()> {
    validate_schema(fields.schema, PairedV2PacketKind::Review)?;
    validate_version(fields.schema_version)?;
    validate_nonempty(fields.review_id, PAIRED_V2_REVIEW_ID_MAX_BYTES)?;
    validate_hash(fields.brief_digest)?;
    if fields.candidate_digests.len() > PAIRED_V2_MAX_CANDIDATES
        || fields.dispositions.len() != fields.candidate_digests.len()
    {
        return invalid();
    }
    let mut candidate_set = BTreeSet::new();
    for candidate_digest in fields.candidate_digests {
        validate_hash(candidate_digest)?;
        if !candidate_set.insert(candidate_digest.as_str()) {
            return invalid();
        }
    }
    let mut disposition_set = BTreeSet::new();
    for disposition in fields.dispositions {
        validate_disposition(disposition)?;
        if !disposition_set.insert(disposition.candidate_digest.as_str())
            || !candidate_set.contains(disposition.candidate_digest.as_str())
        {
            return invalid();
        }
    }
    if disposition_set.len() != candidate_set.len() {
        return invalid();
    }
    validate_nonempty(fields.summary, PAIRED_V2_SUMMARY_MAX_BYTES)?;
    if let Some(digest) = fields.digest {
        validate_hash(digest)?;
    }
    Ok(())
}

fn validate_packet(packet: &PairedV2Packet) -> StudioResult<()> {
    match packet {
        PairedV2Packet::Brief(value) => validate_brief_common(BriefFields {
            schema: &value.schema,
            schema_version: value.schema_version,
            brief_id: &value.brief_id,
            title: &value.title,
            goal: &value.goal,
            profile_name: &value.profile_name,
            profile_version: &value.profile_version,
            source_profile_sha256: &value.source_profile_sha256,
            source_canonical_digest: &value.source_canonical_digest,
            editable_paths: &value.editable_paths,
            allowed_modes: &value.allowed_modes,
            acceptance_criteria: &value.acceptance_criteria,
            prohibited_changes: &value.prohibited_changes,
            digest: Some(&value.brief_digest),
        }),
        PairedV2Packet::Candidate(value) => {
            validate_candidate_common(CandidateFields {
                schema: &value.schema,
                schema_version: value.schema_version,
                candidate_id: &value.candidate_id,
                brief_digest: &value.brief_digest,
                source_bytes_base64: &value.source_bytes_base64,
                source_profile_sha256: &value.source_profile_sha256,
                source_canonical_digest: &value.source_canonical_digest,
                rationale: &value.rationale,
                digest: Some(&value.candidate_digest),
            })?;
            Ok(())
        }
        PairedV2Packet::Review(value) => {
            validate_review_common(ReviewFields {
                schema: &value.schema,
                schema_version: value.schema_version,
                review_id: &value.review_id,
                brief_digest: &value.brief_digest,
                candidate_digests: &value.candidate_digests,
                dispositions: &value.dispositions,
                summary: &value.summary,
                digest: Some(&value.review_digest),
            })?;
            if !matches!(
                value.overall_disposition,
                PairedV2ReviewDispositionKind::Approve
                    | PairedV2ReviewDispositionKind::Revise
                    | PairedV2ReviewDispositionKind::Reject
            ) {
                return invalid();
            }
            Ok(())
        }
    }
}

fn packet_digest(packet: &PairedV2Packet) -> StudioResult<String> {
    let kind = packet.kind();
    let projection = canonical_sorted_projection(packet, kind.digest_field())?;
    let mut hasher = Sha256::new();
    hasher.update(kind.schema().as_bytes());
    hasher.update(b"\n");
    hasher.update(projection);
    Ok(format!("{:x}", hasher.finalize()))
}

fn envelope(packet: PairedV2Packet) -> StudioResult<PairedV2PacketEnvelope> {
    validate_packet(&packet)?;
    let digest = packet_digest(&packet)?;
    if packet.digest() != digest {
        return invalid();
    }
    let canonical = canonical_sorted_pretty(&packet)?;
    if canonical.len() > PAIRED_V2_PACKET_MAX_BYTES {
        return too_large();
    }
    let canonical_json = String::from_utf8(canonical)
        .map_err(|_| StudioCommandError::new(StudioReasonCode::ProtocolInvalid))?;
    Ok(PairedV2PacketEnvelope {
        kind: kind_schema(packet.kind()).to_owned(),
        canonical_json,
        digest,
        packet_digest_verified: true,
        packet,
    })
}

fn kind_schema(kind: PairedV2PacketKind) -> &'static str {
    kind.schema()
}

fn create_brief(input: PairedV2BriefCreateInput) -> StudioResult<PairedV2PacketEnvelope> {
    validate_brief_common(BriefFields {
        schema: &input.schema,
        schema_version: input.schema_version,
        brief_id: &input.brief_id,
        title: &input.title,
        goal: &input.goal,
        profile_name: &input.profile_name,
        profile_version: &input.profile_version,
        source_profile_sha256: &input.source_profile_sha256,
        source_canonical_digest: &input.source_canonical_digest,
        editable_paths: &input.editable_paths,
        allowed_modes: &input.allowed_modes,
        acceptance_criteria: &input.acceptance_criteria,
        prohibited_changes: &input.prohibited_changes,
        digest: None,
    })?;
    let mut packet = PairedV2Packet::Brief(PairedV2BriefPacket {
        schema: input.schema,
        schema_version: input.schema_version,
        brief_id: input.brief_id,
        title: input.title,
        goal: input.goal,
        profile_name: input.profile_name,
        profile_version: input.profile_version,
        source_profile_sha256: input.source_profile_sha256,
        source_canonical_digest: input.source_canonical_digest,
        editable_paths: input.editable_paths,
        allowed_modes: input.allowed_modes,
        acceptance_criteria: input.acceptance_criteria,
        prohibited_changes: input.prohibited_changes,
        brief_digest: String::new(),
    });
    let digest = packet_digest(&packet)?;
    packet.set_digest(digest);
    envelope(packet)
}

fn create_candidate(input: PairedV2CandidateCreateInput) -> StudioResult<PairedV2PacketEnvelope> {
    validate_candidate_common(CandidateFields {
        schema: &input.schema,
        schema_version: input.schema_version,
        candidate_id: &input.candidate_id,
        brief_digest: &input.brief_digest,
        source_bytes_base64: &input.source_bytes_base64,
        source_profile_sha256: &input.source_profile_sha256,
        source_canonical_digest: &input.source_canonical_digest,
        rationale: &input.rationale,
        digest: None,
    })?;
    let mut packet = PairedV2Packet::Candidate(PairedV2CandidatePacket {
        schema: input.schema,
        schema_version: input.schema_version,
        candidate_id: input.candidate_id,
        brief_digest: input.brief_digest,
        source_bytes_base64: input.source_bytes_base64,
        source_profile_sha256: input.source_profile_sha256,
        source_canonical_digest: input.source_canonical_digest,
        rationale: input.rationale,
        candidate_digest: String::new(),
    });
    let digest = packet_digest(&packet)?;
    packet.set_digest(digest);
    envelope(packet)
}

fn create_review(input: PairedV2ReviewCreateInput) -> StudioResult<PairedV2PacketEnvelope> {
    validate_review_common(ReviewFields {
        schema: &input.schema,
        schema_version: input.schema_version,
        review_id: &input.review_id,
        brief_digest: &input.brief_digest,
        candidate_digests: &input.candidate_digests,
        dispositions: &input.dispositions,
        summary: &input.summary,
        digest: None,
    })?;
    let mut packet = PairedV2Packet::Review(PairedV2ReviewPacket {
        schema: input.schema,
        schema_version: input.schema_version,
        review_id: input.review_id,
        brief_digest: input.brief_digest,
        candidate_digests: input.candidate_digests,
        dispositions: input.dispositions,
        overall_disposition: input.overall_disposition,
        summary: input.summary,
        review_digest: String::new(),
    });
    let digest = packet_digest(&packet)?;
    packet.set_digest(digest);
    envelope(packet)
}

pub fn create_packet(request: PairedV2PacketCreateRequest) -> StudioResult<PairedV2PacketEnvelope> {
    match request {
        PairedV2PacketCreateRequest::Brief(input) => create_brief(input),
        PairedV2PacketCreateRequest::Candidate(input) => create_candidate(input),
        PairedV2PacketCreateRequest::Review(input) => create_review(input),
    }
}

fn parse_typed<T: DeserializeOwned>(bytes: &[u8]) -> StudioResult<T> {
    serde_json::from_slice(bytes)
        .map_err(|_| StudioCommandError::new(StudioReasonCode::ProtocolInvalid))
}

pub fn parse_packet(
    bytes: &[u8],
    expected_kind: Option<&str>,
) -> StudioResult<PairedV2PacketEnvelope> {
    if bytes.len() > PAIRED_V2_PACKET_MAX_BYTES {
        return too_large();
    }
    let PairedV2PacketClassification::Paired { schema } = classify_packet(bytes) else {
        return invalid();
    };
    let Some(expected_kind) = expected_kind else {
        return invalid();
    };
    if expected_kind != schema {
        return invalid();
    }
    let kind = PairedV2PacketKind::from_schema(&schema)
        .ok_or_else(|| StudioCommandError::new(StudioReasonCode::ProtocolInvalid))?;
    let packet = match kind {
        PairedV2PacketKind::Brief => PairedV2Packet::Brief(parse_typed(bytes)?),
        PairedV2PacketKind::Candidate => PairedV2Packet::Candidate(parse_typed(bytes)?),
        PairedV2PacketKind::Review => PairedV2Packet::Review(parse_typed(bytes)?),
    };
    envelope(packet)
}
