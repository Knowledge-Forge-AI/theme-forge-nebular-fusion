use serde::{Deserialize, Serialize};
use serde_json::value::Value as JsonNode;

use super::common::{Digest, Validate, invalid, ordered_unique, valid_id, valid_text};
use super::raster_plan_descriptor::QUALIFIED_RASTER_PLAN;
use crate::errors::StudioResult;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum BrandPlanMethod {
    #[serde(rename = "brand.derive.plan")]
    Derive,
    #[serde(rename = "brand.qa.baseline.plan")]
    QaBaseline,
    #[serde(rename = "brand.consumer.install.plan")]
    ConsumerInstall,
    #[serde(rename = "brand.consumer.sync.plan")]
    ConsumerSync,
    #[serde(rename = "brand.export.plan")]
    Export,
}

impl BrandPlanMethod {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Derive => "brand.derive.plan",
            Self::QaBaseline => "brand.qa.baseline.plan",
            Self::ConsumerInstall => "brand.consumer.install.plan",
            Self::ConsumerSync => "brand.consumer.sync.plan",
            Self::Export => "brand.export.plan",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BrandDeriveOperationSummary {
    recipe_id: String,
    target_asset_id: String,
    operations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BrandDeriveTargetSummary {
    target_asset_id: String,
    recipe_id: String,
    state: DeriveTargetState,
    #[serde(skip_serializing_if = "Option::is_none")]
    old_digest: Option<Digest>,
    new_digest: Digest,
    new_svg_digest: Digest,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum DeriveTargetState {
    Create,
    Update,
    Unchanged,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BrandDerivePlanSummary {
    selected_recipes: Vec<String>,
    transitive_recipes: Vec<String>,
    affected_targets: Vec<String>,
    created_count: u16,
    updated_count: u16,
    unchanged_count: u16,
    operation_summaries: Vec<BrandDeriveOperationSummary>,
    target_states: Vec<BrandDeriveTargetSummary>,
    token_digest: Digest,
    recipe_digest: Digest,
    brand_system_digest: Digest,
    warnings: Vec<String>,
    dry_run: bool,
}

impl Validate for BrandDerivePlanSummary {
    fn validate(&self) -> StudioResult<()> {
        if self.selected_recipes.is_empty()
            || self.selected_recipes.len() > 128
            || self.transitive_recipes.len() > 128
            || self.affected_targets.len() > 128
            || self.operation_summaries.len() > 128
            || self.target_states.len() > 128
            || self.warnings.len() > 128
            || !exact_count_total(
                &[self.created_count, self.updated_count, self.unchanged_count],
                self.target_states.len(),
            )
        {
            return invalid();
        }
        for values in [
            &self.selected_recipes,
            &self.transitive_recipes,
            &self.affected_targets,
        ] {
            if values.iter().any(|value| !valid_id(value)) {
                return invalid();
            }
            ordered_unique(values.iter().cloned())?;
        }
        ordered_unique(
            self.operation_summaries
                .iter()
                .map(|entry| entry.target_asset_id.clone()),
        )?;
        for entry in &self.operation_summaries {
            if !valid_id(&entry.recipe_id)
                || !valid_id(&entry.target_asset_id)
                || entry.operations.len() > 128
                || entry.operations.iter().any(|value| !valid_text(value, 128))
            {
                return invalid();
            }
        }
        ordered_unique(
            self.target_states
                .iter()
                .map(|entry| entry.target_asset_id.clone()),
        )?;
        for target in &self.target_states {
            if !valid_id(&target.target_asset_id)
                || !valid_id(&target.recipe_id)
                || matches!(target.state, DeriveTargetState::Create) && target.old_digest.is_some()
                || !matches!(target.state, DeriveTargetState::Create) && target.old_digest.is_none()
            {
                return invalid();
            }
            let _ = (&target.new_digest, &target.new_svg_digest);
        }
        if self
            .warnings
            .iter()
            .any(|warning| !valid_text(warning, 1_024))
        {
            return invalid();
        }
        let _ = (
            &self.token_digest,
            &self.recipe_digest,
            &self.brand_system_digest,
        );
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DigestPair {
    old: Digest,
    next: Digest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PlanRenderer {
    id: String,
    version: String,
    qualification_id: String,
    platform_claim: String,
    renderer_build_digest: Digest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RasterDifference {
    changed_pixels: Option<u64>,
    maximum_channel_delta: Option<u8>,
    changed_bounds: Option<ChangedBounds>,
    before_decoded_pixel_digest: Option<Digest>,
    after_decoded_pixel_digest: Digest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ChangedBounds {
    left: u32,
    top: u32,
    right: u32,
    bottom: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum BaselineState {
    Create,
    Update,
    Rebaseline,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BrandQaBaselinePlanSummary {
    profile_id: String,
    case_id: String,
    baseline_path: String,
    state: BaselineState,
    old_baseline_digest: Option<Digest>,
    new_baseline_digest: Digest,
    old_qa_digest: Digest,
    new_qa_digest: Digest,
    renderer: PlanRenderer,
    asset_digests: DigestPair,
    svg_digests: DigestPair,
    brand_system_digests: DigestPair,
    raster_difference: RasterDifference,
}

impl Validate for BrandQaBaselinePlanSummary {
    fn validate(&self) -> StudioResult<()> {
        let relative = !self.baseline_path.starts_with('/')
            && self.baseline_path.len() <= 4_096
            && !self
                .baseline_path
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
            && !self.baseline_path.contains('\\')
            && !self.baseline_path.chars().any(char::is_control);
        let renderer = &self.renderer;
        if !valid_id(&self.profile_id)
            || !valid_id(&self.case_id)
            || !relative
            || matches!(self.state, BaselineState::Create) != self.old_baseline_digest.is_none()
            || renderer.id != QUALIFIED_RASTER_PLAN.adapter_id
            || renderer.version != QUALIFIED_RASTER_PLAN.renderer_version
            || renderer.qualification_id != QUALIFIED_RASTER_PLAN.qualification_id
            || renderer.platform_claim != QUALIFIED_RASTER_PLAN.platform_claim
            || renderer.renderer_build_digest.as_str()
                != QUALIFIED_RASTER_PLAN.renderer_build_digest
            || self
                .raster_difference
                .changed_bounds
                .as_ref()
                .is_some_and(|bounds| bounds.left > bounds.right || bounds.top > bounds.bottom)
        {
            return invalid();
        }
        let _ = (
            &self.new_baseline_digest,
            &self.old_qa_digest,
            &self.new_qa_digest,
            &renderer.renderer_build_digest,
            &self.asset_digests.old,
            &self.asset_digests.next,
            &self.svg_digests.old,
            &self.svg_digests.next,
            &self.brand_system_digests.old,
            &self.brand_system_digests.next,
            &self.raster_difference.changed_pixels,
            &self.raster_difference.maximum_channel_delta,
            &self.raster_difference.before_decoded_pixel_digest,
            &self.raster_difference.after_decoded_pixel_digest,
        );
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ConsumerOperation {
    Install,
    Sync,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum ConsumerOutputKind {
    Asset,
    Companion,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConsumerPlanOutputSummary {
    kind: ConsumerOutputKind,
    package_id: String,
    source_id: String,
    destination: String,
    byte_digest: Digest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConsumerPlanSummary {
    operation: ConsumerOperation,
    packages: Vec<String>,
    profiles: Vec<String>,
    outputs: Vec<ConsumerPlanOutputSummary>,
    omitted_optional: Vec<String>,
    lock_digest: Digest,
}

impl ConsumerPlanSummary {
    fn validate_for(&self, method: BrandPlanMethod) -> StudioResult<()> {
        let expected = if method == BrandPlanMethod::ConsumerInstall {
            ConsumerOperation::Install
        } else {
            ConsumerOperation::Sync
        };
        if self.operation != expected
            || self.packages.is_empty()
            || self.packages.len() > 8
            || self.profiles.len() > 8
            || self.outputs.len() > 512
            || self.omitted_optional.len() > 512
            || self
                .packages
                .iter()
                .chain(self.profiles.iter())
                .chain(self.omitted_optional.iter())
                .any(|value| !valid_text(value, 512))
        {
            return invalid();
        }
        ordered_unique(self.packages.iter().cloned())?;
        ordered_unique(self.profiles.iter().cloned())?;
        ordered_unique(self.omitted_optional.iter().cloned())?;
        ordered_unique(self.outputs.iter().map(|entry| {
            format!(
                "{}\0{}\0{}",
                entry.package_id, entry.destination, entry.source_id
            )
        }))?;
        for output in &self.outputs {
            if !self.packages.contains(&output.package_id)
                || !valid_text(&output.source_id, 256)
                || !valid_relative(&output.destination)
            {
                return invalid();
            }
            let _ = (&output.kind, &output.byte_digest);
        }
        let _ = &self.lock_digest;
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RasterAdapterDescriptor {
    adapter_id: String,
    companion_package: String,
    companion_version: String,
    backend: RasterBackend,
    renderer_package: String,
    renderer_version: String,
    renderer_build_digest: Digest,
    node_major: u16,
    platform_claim: String,
    qualification_id: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum RasterBackend {
    Wasm,
    Native,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum RasterState {
    Create,
    Update,
    Unchanged,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RasterExportPlanOutputSummary {
    profile_id: String,
    output_id: String,
    asset_id: String,
    destination: String,
    state: RasterState,
    width: u16,
    height: u16,
    purpose: String,
    fit: String,
    background: String,
    alpha: String,
    canonical_asset_digest: Digest,
    svg_digest: Digest,
    profile_digest: Digest,
    output_config_digest: Digest,
    renderer_build_digest: Digest,
    png_digest: Digest,
    decoded_pixel_digest: Digest,
    receipt_digest: Digest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RasterCounts {
    create: u16,
    update: u16,
    unchanged: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BrandRasterExportPlanSummary {
    profile_id: String,
    adapter: RasterAdapterDescriptor,
    outputs: Vec<RasterExportPlanOutputSummary>,
    counts: RasterCounts,
    warnings: Vec<String>,
}

impl Validate for BrandRasterExportPlanSummary {
    fn validate(&self) -> StudioResult<()> {
        if !valid_id(&self.profile_id)
            || self.outputs.len() > 128
            || self.warnings.len() > 128
            || !exact_count_total(
                &[
                    self.counts.create,
                    self.counts.update,
                    self.counts.unchanged,
                ],
                self.outputs.len(),
            )
            || self.adapter.adapter_id != QUALIFIED_RASTER_PLAN.adapter_id
            || self.adapter.companion_package != QUALIFIED_RASTER_PLAN.companion_package
            || self.adapter.companion_version != QUALIFIED_RASTER_PLAN.companion_version
            || !matches!(self.adapter.backend, RasterBackend::Wasm)
            || QUALIFIED_RASTER_PLAN.backend != "wasm"
            || self.adapter.renderer_package != QUALIFIED_RASTER_PLAN.renderer_package
            || self.adapter.renderer_version != QUALIFIED_RASTER_PLAN.renderer_version
            || self.adapter.renderer_build_digest.as_str()
                != QUALIFIED_RASTER_PLAN.renderer_build_digest
            || self.adapter.node_major != QUALIFIED_RASTER_PLAN.node_major
            || self.adapter.platform_claim != QUALIFIED_RASTER_PLAN.platform_claim
            || self.adapter.qualification_id != QUALIFIED_RASTER_PLAN.qualification_id
            || self.warnings.iter().any(|value| !valid_text(value, 1_024))
        {
            return invalid();
        }
        ordered_unique(self.outputs.iter().map(|entry| entry.output_id.clone()))?;
        for output in &self.outputs {
            if output.profile_id != self.profile_id
                || !valid_id(&output.output_id)
                || !valid_id(&output.asset_id)
                || !valid_relative(&output.destination)
                || output.width == 0
                || output.height == 0
                || output.fit != "contain-pad"
                || !matches!(output.alpha.as_str(), "straight" | "opaque")
                || !valid_text(&output.purpose, 128)
                || !valid_text(&output.background, 256)
                || output.renderer_build_digest.as_str()
                    != QUALIFIED_RASTER_PLAN.renderer_build_digest
            {
                return invalid();
            }
            let _ = (
                &output.state,
                &output.canonical_asset_digest,
                &output.svg_digest,
                &output.profile_digest,
                &output.output_config_digest,
                &output.png_digest,
                &output.decoded_pixel_digest,
                &output.receipt_digest,
            );
        }
        for value in [
            &self.adapter.companion_version,
            &self.adapter.renderer_version,
            &self.adapter.platform_claim,
            &self.adapter.qualification_id,
        ] {
            if !valid_text(value, 256) {
                return invalid();
            }
        }
        let _ = (&self.adapter.backend, &self.adapter.renderer_build_digest);
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub(crate) enum StudioPlanSummary {
    Derive(Box<BrandDerivePlanSummary>),
    QaBaseline(Box<BrandQaBaselinePlanSummary>),
    Consumer(Box<ConsumerPlanSummary>),
    Export(Box<BrandRasterExportPlanSummary>),
}

impl StudioPlanSummary {
    pub(crate) fn decode(method: BrandPlanMethod, raw: JsonNode) -> StudioResult<Self> {
        match method {
            BrandPlanMethod::Derive => decode(raw).map(|value| Self::Derive(Box::new(value))),
            BrandPlanMethod::QaBaseline => {
                decode(raw).map(|value| Self::QaBaseline(Box::new(value)))
            }
            BrandPlanMethod::ConsumerInstall | BrandPlanMethod::ConsumerSync => {
                let summary: ConsumerPlanSummary = serde_json::from_value(raw).map_err(|_| {
                    crate::errors::StudioCommandError::new(
                        crate::errors::StudioReasonCode::ProtocolInvalid,
                    )
                })?;
                summary.validate_for(method)?;
                Ok(Self::Consumer(Box::new(summary)))
            }
            BrandPlanMethod::Export => decode(raw).map(|value| Self::Export(Box::new(value))),
        }
    }
}

fn decode<T>(raw: JsonNode) -> StudioResult<T>
where
    T: for<'de> Deserialize<'de> + Validate,
{
    let value: T = serde_json::from_value(raw).map_err(|_| {
        crate::errors::StudioCommandError::new(crate::errors::StudioReasonCode::ProtocolInvalid)
    })?;
    value.validate()?;
    Ok(value)
}

fn valid_relative(value: &str) -> bool {
    !value.starts_with('/')
        && value.len() <= 4_096
        && !value.contains('\\')
        && !value.chars().any(char::is_control)
        && !value
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
}

fn exact_count_total(counts: &[u16], actual: usize) -> bool {
    counts
        .iter()
        .map(|value| usize::from(*value))
        .sum::<usize>()
        == actual
}

#[cfg(test)]
mod tests {
    use serde_json::{Value as JsonNode, json};

    use super::{BrandPlanMethod, QUALIFIED_RASTER_PLAN, StudioPlanSummary, exact_count_total};

    const DIGEST: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn derive() -> JsonNode {
        json!({
            "selectedRecipes": ["recipe-one"], "transitiveRecipes": [],
            "affectedTargets": ["asset-one"], "createdCount": 1, "updatedCount": 0,
            "unchangedCount": 0,
            "operationSummaries": [{ "recipeId": "recipe-one", "targetAssetId": "asset-one", "operations": ["copy"] }],
            "targetStates": [{ "targetAssetId": "asset-one", "recipeId": "recipe-one", "state": "create", "newDigest": DIGEST, "newSvgDigest": DIGEST }],
            "tokenDigest": DIGEST, "recipeDigest": DIGEST, "brandSystemDigest": DIGEST,
            "warnings": [], "dryRun": true
        })
    }

    fn qa() -> JsonNode {
        json!({
            "profileId": "profile-one", "caseId": "case-one", "baselinePath": "brand/baseline.png",
            "state": "create", "oldBaselineDigest": null, "newBaselineDigest": DIGEST,
            "oldQaDigest": DIGEST, "newQaDigest": DIGEST,
            "renderer": { "id": QUALIFIED_RASTER_PLAN.adapter_id, "version": QUALIFIED_RASTER_PLAN.renderer_version, "qualificationId": QUALIFIED_RASTER_PLAN.qualification_id, "platformClaim": QUALIFIED_RASTER_PLAN.platform_claim, "rendererBuildDigest": QUALIFIED_RASTER_PLAN.renderer_build_digest },
            "assetDigests": { "old": DIGEST, "next": DIGEST }, "svgDigests": { "old": DIGEST, "next": DIGEST },
            "brandSystemDigests": { "old": DIGEST, "next": DIGEST },
            "rasterDifference": { "changedPixels": 0, "maximumChannelDelta": 0, "changedBounds": null, "beforeDecodedPixelDigest": null, "afterDecodedPixelDigest": DIGEST }
        })
    }

    fn consumer(operation: &str) -> JsonNode {
        json!({
            "operation": operation, "packages": ["package-one"], "profiles": ["package-one/profile-one"],
            "outputs": [{ "kind": "asset", "packageId": "package-one", "sourceId": "asset-one", "destination": "public/asset.svg", "byteDigest": DIGEST }],
            "omittedOptional": [], "lockDigest": DIGEST
        })
    }

    fn export() -> JsonNode {
        json!({
            "profileId": "profile-one",
            "adapter": { "adapterId": QUALIFIED_RASTER_PLAN.adapter_id, "companionPackage": QUALIFIED_RASTER_PLAN.companion_package, "companionVersion": QUALIFIED_RASTER_PLAN.companion_version, "backend": QUALIFIED_RASTER_PLAN.backend, "rendererPackage": QUALIFIED_RASTER_PLAN.renderer_package, "rendererVersion": QUALIFIED_RASTER_PLAN.renderer_version, "rendererBuildDigest": QUALIFIED_RASTER_PLAN.renderer_build_digest, "nodeMajor": QUALIFIED_RASTER_PLAN.node_major, "platformClaim": QUALIFIED_RASTER_PLAN.platform_claim, "qualificationId": QUALIFIED_RASTER_PLAN.qualification_id },
            "outputs": [{ "profileId": "profile-one", "outputId": "output-one", "assetId": "asset-one", "destination": "public/output.png", "state": "create", "width": 16, "height": 16, "purpose": "icon", "fit": "contain-pad", "background": "transparent", "alpha": "straight", "canonicalAssetDigest": DIGEST, "svgDigest": DIGEST, "profileDigest": DIGEST, "outputConfigDigest": DIGEST, "rendererBuildDigest": QUALIFIED_RASTER_PLAN.renderer_build_digest, "pngDigest": DIGEST, "decodedPixelDigest": DIGEST, "receiptDigest": DIGEST }],
            "counts": { "create": 1, "update": 0, "unchanged": 0 }, "warnings": []
        })
    }

    #[test]
    fn all_five_summary_variants_validate_exact_positive_vectors() {
        for (method, value) in [
            (BrandPlanMethod::Derive, derive()),
            (BrandPlanMethod::QaBaseline, qa()),
            (BrandPlanMethod::ConsumerInstall, consumer("install")),
            (BrandPlanMethod::ConsumerSync, consumer("sync")),
            (BrandPlanMethod::Export, export()),
        ] {
            assert!(
                StudioPlanSummary::decode(method, value).is_ok(),
                "{method:?}"
            );
        }
    }

    #[test]
    fn count_arithmetic_is_widened_and_exact_at_boundaries() {
        assert!(!exact_count_total(&[u16::MAX, u16::MAX, u16::MAX], 65_533));
        assert!(!exact_count_total(&[u16::MAX, 1, 0], 0));
        assert!(exact_count_total(&[128, 0, 0], 128));
        assert!(exact_count_total(&[0, 64, 64], 128));
    }

    #[test]
    fn raster_plan_summaries_reject_each_frozen_identity_field_independently() {
        for field in [
            "id",
            "version",
            "qualificationId",
            "platformClaim",
            "rendererBuildDigest",
        ] {
            let mut value = qa();
            value["renderer"][field] = json!(if field == "rendererBuildDigest" {
                DIGEST
            } else {
                "mismatch"
            });
            assert!(StudioPlanSummary::decode(BrandPlanMethod::QaBaseline, value).is_err());
        }

        for field in [
            "adapterId",
            "companionPackage",
            "companionVersion",
            "backend",
            "rendererPackage",
            "rendererVersion",
            "rendererBuildDigest",
            "nodeMajor",
            "platformClaim",
            "qualificationId",
        ] {
            let mut value = export();
            value["adapter"][field] = if field == "nodeMajor" {
                json!(21)
            } else if field == "rendererBuildDigest" {
                json!(DIGEST)
            } else {
                json!("mismatch")
            };
            assert!(StudioPlanSummary::decode(BrandPlanMethod::Export, value).is_err());
        }
        let mut output = export();
        output["outputs"][0]["rendererBuildDigest"] = json!(DIGEST);
        assert!(StudioPlanSummary::decode(BrandPlanMethod::Export, output).is_err());
    }

    #[test]
    fn summaries_reject_extra_keys_wrong_variants_private_paths_and_count_drift() {
        let mut extra = derive();
        extra
            .as_object_mut()
            .map(|value| value.insert("planToken".to_owned(), json!("secret")));
        assert!(StudioPlanSummary::decode(BrandPlanMethod::Derive, extra).is_err());
        assert!(
            StudioPlanSummary::decode(BrandPlanMethod::ConsumerSync, consumer("install")).is_err()
        );
        let mut private = qa();
        private
            .as_object_mut()
            .map(|value| value.insert("baselinePath".to_owned(), json!("/private/baseline.png")));
        assert!(StudioPlanSummary::decode(BrandPlanMethod::QaBaseline, private).is_err());
        let mut counts = export();
        counts
            .get_mut("counts")
            .and_then(JsonNode::as_object_mut)
            .map(|value| value.insert("create".to_owned(), json!(0)));
        assert!(StudioPlanSummary::decode(BrandPlanMethod::Export, counts).is_err());
    }

    #[test]
    fn summaries_reject_malformed_digests_duplicates_and_output_cross_link_drift() {
        let mut malformed = derive();
        malformed
            .as_object_mut()
            .map(|value| value.insert("tokenDigest".to_owned(), json!("bad")));
        assert!(StudioPlanSummary::decode(BrandPlanMethod::Derive, malformed).is_err());
        let mut duplicate = consumer("install");
        duplicate.as_object_mut().map(|value| {
            value.insert("packages".to_owned(), json!(["package-one", "package-one"]))
        });
        assert!(StudioPlanSummary::decode(BrandPlanMethod::ConsumerInstall, duplicate).is_err());
        let mut cross_link = export();
        cross_link
            .get_mut("outputs")
            .and_then(JsonNode::as_array_mut)
            .and_then(|values| values.first_mut())
            .and_then(JsonNode::as_object_mut)
            .map(|value| value.insert("profileId".to_owned(), json!("profile-two")));
        assert!(StudioPlanSummary::decode(BrandPlanMethod::Export, cross_link).is_err());
    }
}
