use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::common::{
    Digest, Page, Validate, invalid, ordered_unique, valid_id, valid_role, valid_text,
    validate_page,
};
use crate::errors::StudioResult;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConsumerProfileItem {
    qualified_profile_id: String,
    authority_kind: AuthorityKind,
    package_id: String,
    profile: ConsumerProfile,
    output_rule_count: u16,
    resolved_output_count: Option<u16>,
}
pub(crate) type ConsumerProfilePage = Page<ConsumerProfileItem>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConsumerProfile {
    id: String,
    qualified_id: String,
    version: u16,
    compatible_package: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    minimum_brand_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    maximum_brand_version_exclusive: Option<String>,
    composes: Vec<String>,
    parameters: Vec<ConsumerParameter>,
    outputs: Vec<ConsumerRule>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum AuthorityKind {
    ProducerProject,
    ProducerPackage,
    ConsumerLocal,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConsumerParameter {
    id: String,
    values: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConsumerRule {
    #[serde(skip_serializing_if = "Option::is_none")]
    asset: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    companion: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    variant: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    destination: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    destination_directory: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    filename_policy: Option<FilenamePolicy>,
    requirement: Requirement,
    collision: Collision,
    when: Vec<ConsumerCondition>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum FilenamePolicy {
    AssetIdSvg,
    SourceBasename,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Requirement {
    Required,
    Optional,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
enum Collision {
    #[serde(rename = "error")]
    Error,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConsumerCondition {
    parameter: String,
    equals: String,
}

impl Validate for ConsumerProfilePage {
    fn validate(&self) -> StudioResult<()> {
        validate_page(self, |entry| entry.qualified_profile_id.clone())?;
        for item in &self.page.items {
            let profile = &item.profile;
            if item.qualified_profile_id != profile.qualified_id
                || !valid_text(&item.qualified_profile_id, 256)
                || !valid_id(&item.package_id)
                || !valid_id(&profile.id)
                || !valid_text(&profile.qualified_id, 256)
                || profile.version == 0
                || !valid_id(&profile.compatible_package)
                || profile.composes.len() > 4
                || profile.parameters.len() > 16
                || profile.outputs.len() > 256
                || item.output_rule_count > 256
                || item.resolved_output_count.is_some_and(|value| value > 256)
                || profile
                    .minimum_brand_version
                    .as_ref()
                    .is_some_and(|value| !valid_text(value, 64))
                || profile
                    .maximum_brand_version_exclusive
                    .as_ref()
                    .is_some_and(|value| !valid_text(value, 64))
            {
                return invalid();
            }
            ordered_unique(profile.parameters.iter().map(|entry| entry.id.clone()))?;
            for parameter in &profile.parameters {
                if !valid_id(&parameter.id)
                    || parameter.values.len() > 16
                    || parameter.values.iter().any(|value| !valid_text(value, 64))
                {
                    return invalid();
                }
                ordered_unique(parameter.values.iter().cloned())?;
            }
            for output in &profile.outputs {
                if output.when.len() > 16
                    || output.asset.as_ref().is_some_and(|value| !valid_id(value))
                    || output
                        .companion
                        .as_ref()
                        .is_some_and(|value| !valid_id(value))
                    || output.family.as_ref().is_some_and(|value| !valid_id(value))
                    || output.role.as_ref().is_some_and(|value| !valid_role(value))
                    || output
                        .variant
                        .as_ref()
                        .is_some_and(|value| !valid_id(value))
                    || output
                        .destination
                        .as_ref()
                        .is_some_and(|value| !valid_text(value, 1_024))
                    || output
                        .destination_directory
                        .as_ref()
                        .is_some_and(|value| !valid_text(value, 1_024))
                    || output
                        .when
                        .iter()
                        .any(|entry| !valid_id(&entry.parameter) || !valid_text(&entry.equals, 64))
                {
                    return invalid();
                }
                let _ = (
                    &output.filename_policy,
                    &output.requirement,
                    &output.collision,
                );
            }
            let _ = &item.authority_kind;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConsumerLockStatus {
    status: LockStatus,
    exit_code: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    lock_digest: Option<Digest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    consumer_project_digest: Option<Digest>,
    packages: Vec<ConsumerPackage>,
    mappings: Vec<ConsumerMapping>,
    local_profiles: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum LockStatus {
    Ok,
    SourceUnavailable,
    Stale,
    Drift,
    Collision,
    Invalid,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConsumerPackage {
    package_id: String,
    brand_version: String,
    source_kind: SourceKind,
    profiles: Vec<LockedProfile>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum SourceKind {
    LocalBundle,
    NpmInstalled,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LockedProfile {
    id: String,
    version: u16,
    digest: Digest,
    parameters: BTreeMap<String, String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConsumerMapping {
    package_id: String,
    kind: MappingKind,
    source_id: String,
    destination: String,
    expected_digest: Digest,
    current: MappingState,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum MappingKind {
    Asset,
    Companion,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum MappingState {
    Exact,
    Missing,
    Different,
    Unsafe,
}

impl Validate for ConsumerLockStatus {
    fn validate(&self) -> StudioResult<()> {
        if self.exit_code > 2
            || self.packages.len() > 8
            || self.mappings.len() > 512
            || self.local_profiles.len() > 32
        {
            return invalid();
        }
        ordered_unique(self.packages.iter().map(|entry| entry.package_id.clone()))?;
        for package in &self.packages {
            if !valid_id(&package.package_id)
                || !valid_text(&package.brand_version, 64)
                || package.profiles.len() > 8
            {
                return invalid();
            }
            for profile in &package.profiles {
                if !valid_text(&profile.id, 256)
                    || profile.version == 0
                    || profile.parameters.len() > 16
                    || profile
                        .parameters
                        .iter()
                        .any(|(key, value)| !valid_id(key) || !valid_text(value, 64))
                {
                    return invalid();
                }
                let _ = &profile.digest;
            }
            let _ = &package.source_kind;
        }
        for mapping in &self.mappings {
            if !valid_id(&mapping.package_id)
                || !valid_id(&mapping.source_id)
                || !valid_text(&mapping.destination, 1_024)
            {
                return invalid();
            }
            let _ = (&mapping.kind, &mapping.expected_digest, &mapping.current);
        }
        if self
            .local_profiles
            .iter()
            .any(|value| !valid_text(value, 256))
        {
            return invalid();
        }
        let _ = (
            &self.status,
            &self.lock_digest,
            &self.consumer_project_digest,
        );
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub(crate) enum ExportCapability {
    Unavailable(UnavailableCapability),
    Available(AvailableCapability),
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UnavailableCapability {
    available: FalseValue,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AvailableCapability {
    available: TrueValue,
    adapter_id: AdapterId,
    renderer_package: String,
    renderer_version: String,
    renderer_build_digest: Digest,
    node_major: u8,
    platform_claim: PlatformClaim,
    qualification_id: Digest,
}
#[derive(Debug, Clone, Copy)]
struct FalseValue;
#[derive(Debug, Clone, Copy)]
struct TrueValue;
macro_rules! bool_value {
    ($name:ident, $value:literal) => {
        impl Serialize for $name {
            fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
            where
                S: serde::Serializer,
            {
                serializer.serialize_bool($value)
            }
        }
        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                if bool::deserialize(deserializer)? == $value {
                    Ok(Self)
                } else {
                    Err(serde::de::Error::custom("invalid capability boolean"))
                }
            }
        }
    };
}
bool_value!(FalseValue, false);
bool_value!(TrueValue, true);
#[derive(Debug, Clone, Serialize, Deserialize)]
enum AdapterId {
    #[serde(rename = "resvg-png-v1")]
    Resvg,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
enum PlatformClaim {
    #[serde(rename = "darwin-arm64")]
    DarwinArm64,
}
impl Validate for ExportCapability {
    fn validate(&self) -> StudioResult<()> {
        if let Self::Available(value) = self {
            if value.node_major != 22
                || !valid_text(&value.renderer_package, 256)
                || !valid_text(&value.renderer_version, 64)
            {
                return invalid();
            }
            let _ = (
                &value.available,
                &value.adapter_id,
                &value.renderer_build_digest,
                &value.platform_claim,
                &value.qualification_id,
            );
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExportStatus {
    profile_id: String,
    output_id: String,
    asset_id: Option<String>,
    binding: Option<ExportBinding>,
    destination: String,
    state: String,
    width: Option<u16>,
    height: Option<u16>,
    purpose: Option<ExportPurpose>,
    background: Option<String>,
    alpha: Option<Alpha>,
    canonical_asset_digest: Option<Digest>,
    svg_digest: Option<Digest>,
    profile_digest: Option<Digest>,
    output_config_digest: Option<Digest>,
    png_digest: Option<Digest>,
    decoded_pixel_digest: Option<Digest>,
    receipt_digest: Option<Digest>,
    capability_available: bool,
}
pub(crate) type ExportStatusPage = Page<ExportStatus>;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExportBinding {
    family: String,
    role: String,
    variant: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum ExportPurpose {
    Png,
    AppleTouchIcon,
    PwaIcon,
    Avatar,
    SocialCard,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Alpha {
    Straight,
    Opaque,
}

impl Validate for ExportStatusPage {
    fn validate(&self) -> StudioResult<()> {
        validate_page(self, |entry| {
            format!("{}\0{}", entry.profile_id, entry.output_id)
        })?;
        for output in &self.page.items {
            if !valid_id(&output.profile_id)
                || !valid_id(&output.output_id)
                || output
                    .asset_id
                    .as_ref()
                    .is_some_and(|value| !valid_id(value))
                || !valid_text(&output.destination, 1_024)
                || !valid_text(&output.state, 64)
                || output.width == Some(0)
                || output.height == Some(0)
                || output
                    .background
                    .as_ref()
                    .is_some_and(|value| !valid_text(value, 256))
            {
                return invalid();
            }
            if output.binding.as_ref().is_some_and(|value| {
                !valid_id(&value.family) || !valid_role(&value.role) || !valid_id(&value.variant)
            }) {
                return invalid();
            }
            let _ = (
                &output.purpose,
                &output.alpha,
                &output.canonical_asset_digest,
                &output.svg_digest,
                &output.profile_digest,
                &output.output_config_digest,
                &output.png_digest,
                &output.decoded_pixel_digest,
                &output.receipt_digest,
                output.capability_available,
            );
        }
        Ok(())
    }
}
