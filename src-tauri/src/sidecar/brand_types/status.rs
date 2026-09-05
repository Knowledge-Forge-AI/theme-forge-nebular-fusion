use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::common::{Digest, Validate, invalid, valid_id, valid_text, validate_count};
use crate::errors::StudioResult;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub(crate) enum BrandStatus {
    Missing(MissingBrandStatus),
    Present(Box<PresentBrandStatus>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MissingBrandStatus {
    present: Missing,
    raster: RasterStatus,
}

#[derive(Debug, Clone, Copy)]
struct Missing;

impl Serialize for Missing {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_bool(false)
    }
}
impl<'de> Deserialize<'de> for Missing {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        if bool::deserialize(deserializer)? {
            Err(serde::de::Error::custom("expected false"))
        } else {
            Ok(Self)
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RasterStatus {
    available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PresentBrandStatus {
    present: bool,
    schema_version: u8,
    brand_digest: Digest,
    brand_system_digest: Option<Digest>,
    domains: Vec<DomainStatus>,
    counts: BrandCounts,
    completeness: BrandCompleteness,
    derived: BTreeMap<String, u64>,
    consumer_lock: ConsumerSummary,
    export: ExportSummary,
    raster: RasterStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DomainStatus {
    domain: String,
    state: String,
    digest: Option<Digest>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrandCounts {
    families: u64,
    roles: u64,
    variants: u64,
    bindings: u64,
    requirements: u64,
    tokens: u64,
    recipes: u64,
    qa_profiles: u64,
    qa_cases: u64,
    qa_baselines: u64,
    consumer_profiles: u64,
    export_profiles: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrandCompleteness {
    satisfied: bool,
    family_count: u64,
    variant_count: u64,
    binding_count: u64,
    requirement_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConsumerSummary {
    present: bool,
    status: String,
    packages: u64,
    profiles: u64,
    mappings: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExportSummary {
    outputs: u64,
    receipts: u64,
}

impl Validate for BrandStatus {
    fn validate(&self) -> StudioResult<()> {
        let Self::Present(status) = self else {
            return Ok(());
        };
        if !status.present
            || status.schema_version != 1
            || status.domains.len() > 8
            || status.derived.len() > 16
        {
            return invalid();
        }
        if status
            .domains
            .iter()
            .any(|entry| !valid_text(&entry.domain, 64) || !valid_text(&entry.state, 64))
            || status.derived.keys().any(|key| !valid_id(key))
        {
            return invalid();
        }
        for (value, maximum) in [
            (status.counts.families, 32),
            (status.counts.roles, 64),
            (status.counts.variants, 256),
            (status.counts.bindings, 1_024),
            (status.counts.requirements, 256),
            (status.counts.tokens, 256),
            (status.counts.recipes, 128),
            (status.counts.qa_profiles, 32),
            (status.counts.qa_cases, 512),
            (status.counts.qa_baselines, 256),
            (status.counts.consumer_profiles, 32),
            (status.counts.export_profiles, 32),
            (status.completeness.family_count, 32),
            (status.completeness.variant_count, 256),
            (status.completeness.binding_count, 1_024),
            (status.completeness.requirement_count, 256),
            (status.consumer_lock.packages, 8),
            (status.consumer_lock.profiles, 8),
            (status.consumer_lock.mappings, 512),
            (status.export.outputs, 128),
            (status.export.receipts, 128),
        ] {
            validate_count(value, maximum)?;
        }
        if !valid_text(&status.consumer_lock.status, 64)
            || status.derived.values().any(|value| *value > 128)
        {
            return invalid();
        }
        let _ = (
            status.completeness.satisfied,
            status.consumer_lock.present,
            status.raster.available,
            status.brand_digest.as_str(),
            status.brand_system_digest.as_ref(),
        );
        Ok(())
    }
}
