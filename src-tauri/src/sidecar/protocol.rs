use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum HostLifecycleState {
    NotStarted,
    Verifying,
    Starting,
    Initializing,
    Ready,
    Stopping,
    Stopped,
    Crashed,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StudioHostStateEvent {
    pub(crate) schema_version: u8,
    pub(crate) sequence: u64,
    pub(crate) state: HostLifecycleState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) reason_code: Option<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RasterStatus {
    pub(crate) available: bool,
    pub(crate) qualification_identity: Option<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StudioHostStatus {
    pub(crate) schema_version: u8,
    pub(crate) studio_version: &'static str,
    pub(crate) manifest_digest: Option<String>,
    pub(crate) state: HostLifecycleState,
    pub(crate) selected_protocol_version: Option<String>,
    pub(crate) server_version: Option<String>,
    pub(crate) methods: Vec<String>,
    pub(crate) capabilities: Option<PublicCapabilitySummary>,
    pub(crate) raster: RasterStatus,
    pub(crate) project_open_count: u32,
    pub(crate) source_open_count: u32,
    pub(crate) last_reason_code: Option<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublicCapabilitySummary {
    pub(crate) base_methods: Vec<&'static str>,
    pub(crate) brand_reads: Vec<&'static str>,
    pub(crate) brand_source_purposes: Vec<&'static str>,
    pub(crate) limits: PublicCapabilityLimits,
    pub(crate) plan_capabilities: PublicPlanCapabilities,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublicCapabilityLimits {
    pub(crate) asset_page_size_default: u64,
    pub(crate) asset_page_size_max: u64,
    pub(crate) asset_page_size_min: u64,
    pub(crate) brand_page_size_default: u64,
    pub(crate) brand_page_size_max: u64,
    pub(crate) brand_page_size_min: u64,
    pub(crate) max_diff_result_bytes: u64,
    pub(crate) max_frame_bytes: u64,
    pub(crate) max_qa_result_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublicPlanCapabilities {
    pub(crate) consumer_install: bool,
    pub(crate) consumer_sync: bool,
    pub(crate) derive: bool,
    pub(crate) export: bool,
    pub(crate) qa_baseline: bool,
}

#[derive(Debug, Serialize)]
pub(crate) struct RpcRequest<P> {
    pub(crate) jsonrpc: &'static str,
    pub(crate) id: u64,
    pub(crate) method: &'static str,
    pub(crate) params: P,
}

#[derive(Debug, Serialize)]
pub(crate) struct RpcNotification<P> {
    pub(crate) jsonrpc: &'static str,
    pub(crate) method: &'static str,
    pub(crate) params: P,
}

#[derive(Debug, Serialize)]
pub(crate) struct EmptyParams {}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub(crate) enum RpcResponse<T> {
    Success(RpcSuccess<T>),
    Failure(RpcFailure),
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RpcSuccess<T> {
    pub(crate) jsonrpc: String,
    pub(crate) id: u64,
    pub(crate) result: T,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RpcFailure {
    pub(crate) jsonrpc: String,
    pub(crate) id: u64,
    pub(crate) error: RpcError,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RpcError {
    pub(crate) code: i64,
    pub(crate) message: String,
    pub(crate) data: RpcErrorData,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RpcErrorData {
    pub(crate) code: String,
    pub(crate) message: String,
    pub(crate) retryable: bool,
    pub(crate) location: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProgressNotification {
    pub(crate) jsonrpc: String,
    pub(crate) method: String,
    pub(crate) params: ProgressParams,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProgressParams {
    pub(crate) request_id: u64,
    pub(crate) stage: String,
    pub(crate) completed: u64,
    pub(crate) total: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InitializeParams {
    pub(crate) protocol: &'static str,
    pub(crate) min_version: &'static str,
    pub(crate) max_version: &'static str,
    pub(crate) client: ClientIdentity,
    pub(crate) capabilities: ClientCapabilities,
}

#[derive(Debug, Serialize)]
pub(crate) struct ClientIdentity {
    pub(crate) name: &'static str,
    pub(crate) version: &'static str,
}

#[derive(Debug, Serialize)]
pub(crate) struct ClientCapabilities {
    pub(crate) progress: bool,
    pub(crate) cancellation: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InitializeResult {
    pub(crate) protocol: String,
    pub(crate) selected_version: String,
    pub(crate) server: ServerIdentity,
    pub(crate) session_nonce: String,
    pub(crate) capabilities: ServerCapabilities,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ServerIdentity {
    pub(crate) name: String,
    pub(crate) version: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ServerCapabilities {
    pub(crate) methods: BTreeMap<String, bool>,
    pub(crate) limits: BTreeMap<String, u64>,
    pub(crate) brand: BrandCapabilities,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BrandCapabilities {
    pub(crate) schema_version: u8,
    pub(crate) methods: BTreeMap<String, bool>,
    pub(crate) source_purposes: BTreeMap<String, bool>,
    pub(crate) raster: RasterCapability,
    pub(crate) limits: BTreeMap<String, u64>,
    pub(crate) visual_evidence: VisualEvidenceCapability,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub(crate) enum VisualEvidenceCapability {
    Unavailable(VisualEvidenceUnavailable),
    Available(VisualEvidenceAvailable),
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct VisualEvidenceUnavailable {
    pub(crate) available: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct VisualEvidenceAvailable {
    pub(crate) available: bool,
    pub(crate) media_types: Vec<String>,
    pub(crate) encoding: String,
    pub(crate) max_dimension: u64,
    pub(crate) max_pixels: u64,
    pub(crate) max_artifact_bytes: u64,
    pub(crate) max_aggregate_artifact_bytes: u64,
    pub(crate) max_result_bytes: u64,
    pub(crate) max_artifacts: u64,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub(crate) enum RasterCapability {
    Unavailable(RasterUnavailable),
    Available(RasterAvailable),
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RasterUnavailable {
    pub(crate) available: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RasterAvailable {
    pub(crate) adapter_id: String,
    pub(crate) available: bool,
    pub(crate) platform_claim: String,
    pub(crate) qualification_id: String,
    pub(crate) renderer_version: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionParams<'a> {
    pub(crate) session_nonce: &'a str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectOpenParams<'a> {
    pub(crate) session_nonce: &'a str,
    pub(crate) path: &'a str,
    pub(crate) mode: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceOpenParams<'a> {
    pub(crate) session_nonce: &'a str,
    pub(crate) path: &'a str,
    pub(crate) purpose: &'static str,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub(crate) enum ProjectOpenResponse {
    Existing(ExistingProjectOpen),
    Uninitialized(UninitializedProjectOpen),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExistingProjectOpen {
    pub(crate) asset_count: u32,
    pub(crate) canonical_digest: String,
    pub(crate) companion_count: u32,
    pub(crate) name: String,
    pub(crate) project_handle: String,
    pub(crate) root_kind: String,
    pub(crate) schema_version: u8,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UninitializedProjectOpen {
    pub(crate) project_handle: String,
    pub(crate) root_kind: String,
    pub(crate) state: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectOpenResult {
    pub(crate) project_handle: String,
    pub(crate) root_kind: String,
    pub(crate) schema_version: Option<u8>,
    pub(crate) name: Option<String>,
    pub(crate) canonical_digest: Option<String>,
    pub(crate) asset_count: Option<u32>,
    pub(crate) companion_count: Option<u32>,
    pub(crate) state: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub(crate) enum SourceOpenResponse {
    Content(ContentSourceOpen),
    Auxiliary(AuxiliarySourceOpen),
    BrandBundle(BrandBundleSourceOpen),
    NpmInstalledPackage(NpmInstalledPackageSourceOpen),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ContentSourceOpen {
    pub(crate) candidate_count: u32,
    pub(crate) capabilities: ContentCapabilities,
    pub(crate) digest: String,
    pub(crate) root_kind: String,
    pub(crate) source_handle: String,
    pub(crate) source_kind: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ContentCapabilities {
    pub(crate) analyze: bool,
    pub(crate) mutation: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AuxiliarySourceOpen {
    pub(crate) authority_kind: String,
    pub(crate) byte_digest: String,
    pub(crate) byte_length: u64,
    pub(crate) capabilities: AuxiliaryCapabilities,
    pub(crate) root_kind: String,
    pub(crate) semantic_digest: String,
    pub(crate) source_handle: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AuxiliaryCapabilities {
    pub(crate) analyze: bool,
    pub(crate) mutation_authority: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BrandBundleSourceOpen {
    pub(crate) asset_count: u32,
    pub(crate) authority_kind: String,
    pub(crate) brand_manifest_digest: String,
    pub(crate) brand_system_digest: String,
    pub(crate) brand_version: String,
    pub(crate) capabilities: BrandSourceCapabilities,
    pub(crate) companion_count: u32,
    pub(crate) consumer_profiles_digest: String,
    pub(crate) package_id: String,
    pub(crate) profile_count: u32,
    pub(crate) root_kind: String,
    pub(crate) source_handle: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NpmInstalledPackageSourceOpen {
    pub(crate) asset_count: u32,
    pub(crate) authority_kind: String,
    pub(crate) brand_manifest_digest: String,
    pub(crate) brand_system_digest: String,
    pub(crate) brand_version: String,
    pub(crate) capabilities: BrandSourceCapabilities,
    pub(crate) companion_count: u32,
    pub(crate) consumer_profiles_digest: String,
    pub(crate) npm_name: String,
    pub(crate) npm_version: String,
    pub(crate) package_id: String,
    pub(crate) profile_count: u32,
    pub(crate) root_kind: String,
    pub(crate) source_handle: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BrandSourceCapabilities {
    pub(crate) analyze: bool,
    pub(crate) brand_diff: bool,
    pub(crate) consumer_source: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublicProjectResult {
    pub(crate) cancelled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) project: Option<ProjectOpenResult>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublicSource {
    pub(crate) source_handle: String,
    pub(crate) root_kind: &'static str,
    pub(crate) source_kind: Option<String>,
    pub(crate) authority_kind: Option<String>,
    pub(crate) digest: Option<String>,
    pub(crate) package_id: Option<String>,
    pub(crate) brand_version: Option<String>,
    pub(crate) brand_system_digest: Option<String>,
    pub(crate) candidate_count: Option<u32>,
    pub(crate) profile_count: Option<u32>,
    pub(crate) asset_count: Option<u32>,
    pub(crate) companion_count: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublicSourceResult {
    pub(crate) cancelled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) source: Option<PublicSource>,
}

impl ProjectOpenResponse {
    pub(crate) fn into_public(self) -> Result<ProjectOpenResult, ()> {
        match self {
            Self::Existing(value) => {
                if !valid_handle(&value.project_handle, "project_")
                    || value.root_kind != "project"
                    || !matches!(value.schema_version, 1 | 2)
                    || !bounded_text(&value.name, 1, 256)
                    || !valid_digest(&value.canonical_digest)
                    || value.asset_count > 100_000
                    || value.companion_count > 1_024
                {
                    return Err(());
                }
                Ok(ProjectOpenResult {
                    project_handle: value.project_handle,
                    root_kind: value.root_kind,
                    schema_version: Some(value.schema_version),
                    name: Some(value.name),
                    canonical_digest: Some(value.canonical_digest),
                    asset_count: Some(value.asset_count),
                    companion_count: Some(value.companion_count),
                    state: None,
                })
            }
            Self::Uninitialized(value) => {
                if !valid_handle(&value.project_handle, "project_")
                    || value.root_kind != "project"
                    || value.state != "uninitialized"
                {
                    return Err(());
                }
                Ok(ProjectOpenResult {
                    project_handle: value.project_handle,
                    root_kind: value.root_kind,
                    schema_version: None,
                    name: None,
                    canonical_digest: None,
                    asset_count: None,
                    companion_count: None,
                    state: Some(value.state),
                })
            }
        }
    }
}

impl SourceOpenResponse {
    pub(crate) fn into_public(self) -> Result<PublicSource, ()> {
        match self {
            Self::Content(value) => {
                if !valid_source_common(&value.source_handle, &value.root_kind)
                    || !matches!(value.source_kind.as_str(), "directory" | "archive")
                    || !valid_digest(&value.digest)
                    || value.candidate_count > 100_000
                    || !value.capabilities.analyze
                    || value.capabilities.mutation
                {
                    return Err(());
                }
                Ok(PublicSource {
                    source_handle: value.source_handle,
                    root_kind: "source",
                    source_kind: Some(value.source_kind),
                    authority_kind: None,
                    digest: Some(value.digest),
                    package_id: None,
                    brand_version: None,
                    brand_system_digest: None,
                    candidate_count: Some(value.candidate_count),
                    profile_count: None,
                    asset_count: None,
                    companion_count: None,
                })
            }
            Self::Auxiliary(value) => {
                if !valid_source_common(&value.source_handle, &value.root_kind)
                    || !matches!(
                        value.authority_kind.as_str(),
                        "source-map" | "normalization-map" | "shard-manifest"
                    )
                    || !valid_digest(&value.byte_digest)
                    || !valid_digest(&value.semantic_digest)
                    || value.byte_length > 16_777_216
                    || value.capabilities.analyze
                    || !value.capabilities.mutation_authority
                {
                    return Err(());
                }
                Ok(PublicSource {
                    source_handle: value.source_handle,
                    root_kind: "source",
                    source_kind: None,
                    authority_kind: Some(value.authority_kind),
                    digest: Some(value.semantic_digest),
                    package_id: None,
                    brand_version: None,
                    brand_system_digest: None,
                    candidate_count: None,
                    profile_count: None,
                    asset_count: None,
                    companion_count: None,
                })
            }
            Self::BrandBundle(value) => brand_public(
                value.source_handle,
                value.root_kind,
                value.authority_kind,
                value.package_id,
                value.brand_version,
                value.brand_system_digest,
                value.brand_manifest_digest,
                value.consumer_profiles_digest,
                None,
                None,
                value.profile_count,
                value.asset_count,
                value.companion_count,
                value.capabilities,
                "brand-bundle",
            ),
            Self::NpmInstalledPackage(value) => brand_public(
                value.source_handle,
                value.root_kind,
                value.authority_kind,
                value.package_id,
                value.brand_version,
                value.brand_system_digest,
                value.brand_manifest_digest,
                value.consumer_profiles_digest,
                Some(value.npm_name),
                Some(value.npm_version),
                value.profile_count,
                value.asset_count,
                value.companion_count,
                value.capabilities,
                "npm-installed-package",
            ),
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn brand_public(
    source_handle: String,
    root_kind: String,
    authority_kind: String,
    package_id: String,
    brand_version: String,
    brand_system_digest: String,
    brand_manifest_digest: String,
    consumer_profiles_digest: String,
    npm_name: Option<String>,
    npm_version: Option<String>,
    profile_count: u32,
    asset_count: u32,
    companion_count: u32,
    capabilities: BrandSourceCapabilities,
    expected_authority: &str,
) -> Result<PublicSource, ()> {
    if !valid_source_common(&source_handle, &root_kind)
        || authority_kind != expected_authority
        || !bounded_text(&package_id, 1, 256)
        || !bounded_text(&brand_version, 1, 128)
        || !valid_digest(&brand_system_digest)
        || !valid_digest(&brand_manifest_digest)
        || !valid_digest(&consumer_profiles_digest)
        || npm_name
            .as_ref()
            .is_some_and(|value| !bounded_text(value, 1, 214))
        || npm_version
            .as_ref()
            .is_some_and(|value| !bounded_text(value, 1, 128))
        || (expected_authority == "npm-installed-package"
            && (npm_name.is_none() || npm_version.is_none()))
        || profile_count > 10_000
        || asset_count > 100_000
        || companion_count > 1_024
        || capabilities.analyze
        || !capabilities.brand_diff
        || !capabilities.consumer_source
    {
        return Err(());
    }
    Ok(PublicSource {
        source_handle,
        root_kind: "source",
        source_kind: None,
        authority_kind: Some(authority_kind),
        digest: None,
        package_id: Some(package_id),
        brand_version: Some(brand_version),
        brand_system_digest: Some(brand_system_digest),
        candidate_count: None,
        profile_count: Some(profile_count),
        asset_count: Some(asset_count),
        companion_count: Some(companion_count),
    })
}

fn valid_source_common(handle: &str, root_kind: &str) -> bool {
    valid_handle(handle, "source_") && root_kind == "source"
}

pub(crate) fn bounded_text(value: &str, minimum: usize, maximum: usize) -> bool {
    value.len() >= minimum && value.len() <= maximum && !value.chars().any(char::is_control)
}

pub(crate) fn valid_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

pub(crate) fn valid_handle(value: &str, prefix: &str) -> bool {
    value.len() > prefix.len()
        && value.len() <= 256
        && value.starts_with(prefix)
        && value[prefix.len()..]
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

#[cfg(test)]
mod tests {
    use super::{ProjectOpenResponse, RasterCapability, SourceOpenResponse, valid_handle};

    #[test]
    fn raster_capability_is_an_exact_available_or_unavailable_union() {
        assert!(matches!(
            serde_json::from_str::<RasterCapability>(r#"{"available":false}"#),
            Ok(RasterCapability::Unavailable(_))
        ));
        assert!(matches!(
            serde_json::from_str::<RasterCapability>(
                r#"{"adapterId":"resvg-png-v1","available":true,"platformClaim":"darwin-arm64","qualificationId":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","rendererVersion":"2.6.2"}"#
            ),
            Ok(RasterCapability::Available(_))
        ));
        for invalid in [
            r#"{"available":false,"platformClaim":"darwin-arm64"}"#,
            r#"{"adapterId":"resvg-png-v1","available":true,"platformClaim":"darwin-arm64","rendererVersion":"2.6.2"}"#,
        ] {
            assert!(serde_json::from_str::<RasterCapability>(invalid).is_err());
        }
    }

    #[test]
    fn project_union_and_handle_suffix_are_exact() {
        let existing = r#"{"assetCount":2,"canonicalDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","companionCount":0,"name":"Demo","projectHandle":"project_safe","rootKind":"project","schemaVersion":1}"#;
        let uninitialized =
            r#"{"projectHandle":"project_import","rootKind":"project","state":"uninitialized"}"#;
        assert!(matches!(
            serde_json::from_str::<ProjectOpenResponse>(existing),
            Ok(ProjectOpenResponse::Existing(_))
        ));
        assert!(matches!(
            serde_json::from_str::<ProjectOpenResponse>(uninitialized),
            Ok(ProjectOpenResponse::Uninitialized(_))
        ));
        let with_private_path = format!(
            "{},\"path\":\"/private\"}}",
            existing.strip_suffix('}').unwrap_or_default()
        );
        assert!(serde_json::from_str::<ProjectOpenResponse>(&with_private_path).is_err());
        assert!(!valid_handle("project_", "project_"));
        assert!(valid_handle("project_a", "project_"));
    }

    #[test]
    fn source_union_has_four_closed_variants_and_rejects_private_fields() {
        let variants = [
            r#"{"candidateCount":1,"capabilities":{"analyze":true,"mutation":false},"digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","rootKind":"source","sourceHandle":"source_content","sourceKind":"directory"}"#,
            r#"{"authorityKind":"source-map","byteDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","byteLength":10,"capabilities":{"analyze":false,"mutationAuthority":true},"rootKind":"source","semanticDigest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","sourceHandle":"source_aux"}"#,
            r#"{"assetCount":2,"authorityKind":"brand-bundle","brandManifestDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","brandSystemDigest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","brandVersion":"1.0.0","capabilities":{"analyze":false,"brandDiff":true,"consumerSource":true},"companionCount":0,"consumerProfilesDigest":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","packageId":"brand","profileCount":1,"rootKind":"source","sourceHandle":"source_brand"}"#,
            r#"{"assetCount":2,"authorityKind":"npm-installed-package","brandManifestDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","brandSystemDigest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","brandVersion":"1.0.0","capabilities":{"analyze":false,"brandDiff":true,"consumerSource":true},"companionCount":0,"consumerProfilesDigest":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","npmName":"@example/brand","npmVersion":"1.0.0","packageId":"brand","profileCount":1,"rootKind":"source","sourceHandle":"source_npm"}"#,
        ];
        for (index, vector) in variants.iter().enumerate() {
            let parsed = serde_json::from_str::<SourceOpenResponse>(vector);
            let right_variant = matches!(
                (index, parsed),
                (0, Ok(SourceOpenResponse::Content(_)))
                    | (1, Ok(SourceOpenResponse::Auxiliary(_)))
                    | (2, Ok(SourceOpenResponse::BrandBundle(_)))
                    | (3, Ok(SourceOpenResponse::NpmInstalledPackage(_)))
            );
            assert!(right_variant);
            let with_private_path = format!(
                "{},\"path\":\"/private\"}}",
                vector.strip_suffix('}').unwrap_or_default()
            );
            assert!(serde_json::from_str::<SourceOpenResponse>(&with_private_path).is_err());
        }
    }
}
