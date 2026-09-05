use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::common::{
    Digest, DomainValue, Page, Validate, invalid, ordered_unique, valid_id, valid_role, valid_text,
    validate_page,
};
use crate::errors::StudioResult;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct QaProfileItem {
    id: String,
    renderer: RendererPolicy,
    formats: Vec<QaFormat>,
    case_count: u16,
    semantic_case_count: u16,
    visual_case_count: u16,
    baseline_case_count: u16,
    qa_digest: Digest,
    brand_system_digest: Digest,
}
pub(crate) type QaProfilePage = Page<QaProfileItem>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct QaProfile {
    profile: QaProfileDescriptor,
    cases: Vec<QaCase>,
    resolved_target_count: u32,
    evaluation_count: u16,
    qa_digest: Digest,
    brand_system_digest: Digest,
    baselines: Vec<BaselineSummary>,
    raster: RasterStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QaProfileDescriptor {
    id: String,
    renderer: RendererPolicy,
    formats: Vec<QaFormat>,
    cases: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BaselineSummary {
    case_id: String,
    digest: Option<Digest>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RasterStatus {
    available: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum RendererPolicy {
    Optional,
    Required,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum QaFormat {
    Html,
    Json,
    Markdown,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TargetSelector {
    #[serde(skip_serializing_if = "Option::is_none")]
    asset: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    variant: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum QaCase {
    Inventory {
        id: String,
        family: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        roles: Option<Vec<String>>,
    },
    Accessibility {
        id: String,
        require_consistent_labels: bool,
        #[serde(flatten)]
        target: TargetSelector,
    },
    Palette {
        id: String,
        allowed_tokens: Vec<String>,
        allow_literals: bool,
        #[serde(flatten)]
        target: TargetSelector,
    },
    ExternalReference {
        id: String,
        forbid_external_urls: bool,
        forbid_external_images: bool,
        forbid_external_uses: bool,
        forbid_external_styles: bool,
        forbid_external_fonts: bool,
        #[serde(flatten)]
        target: TargetSelector,
    },
    EmbeddedContent {
        id: String,
        forbid_embedded_raster: bool,
        forbid_embedded_fonts: bool,
        #[serde(flatten)]
        target: TargetSelector,
    },
    Recipe {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        recipe: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        family: Option<String>,
        verify_provenance: bool,
        verify_receipts: bool,
    },
    Canvas {
        id: String,
        require_viewbox: bool,
        enforce_minimum_size: bool,
        #[serde(flatten)]
        target: TargetSelector,
    },
    PixelBounds {
        id: String,
        sizes: Vec<(u16, u16)>,
        backgrounds: Vec<String>,
        alpha_threshold: u8,
        #[serde(flatten)]
        target: TargetSelector,
    },
    TransparentBounds {
        id: String,
        sizes: Vec<(u16, u16)>,
        backgrounds: Vec<String>,
        alpha_threshold: u8,
        #[serde(flatten)]
        target: TargetSelector,
    },
    Clipping {
        id: String,
        sizes: Vec<(u16, u16)>,
        backgrounds: Vec<String>,
        forbidden_edge_pixels: u16,
        #[serde(flatten)]
        target: TargetSelector,
    },
    VisiblePadding {
        id: String,
        sizes: Vec<(u16, u16)>,
        backgrounds: Vec<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        minimum_padding_px: Option<u16>,
        #[serde(skip_serializing_if = "Option::is_none")]
        minimum_padding_token: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        minimum_padding_ratio: Option<u32>,
        #[serde(flatten)]
        target: TargetSelector,
    },
    SmallSizeVisibility {
        id: String,
        sizes: Vec<(u16, u16)>,
        backgrounds: Vec<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        minimum_visible_pixels: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        minimum_visible_ratio: Option<u32>,
        #[serde(flatten)]
        target: TargetSelector,
    },
    Baseline {
        id: String,
        sizes: Vec<(u16, u16)>,
        backgrounds: Vec<String>,
        baseline_digest: Digest,
        renderer_id: String,
        renderer_version: String,
        platform_claim: String,
        canonical_asset_digest: Digest,
        svg_digest: Digest,
        #[serde(flatten)]
        target: TargetSelector,
    },
}

impl QaCase {
    fn id(&self) -> &str {
        match self {
            Self::Inventory { id, .. }
            | Self::Accessibility { id, .. }
            | Self::Palette { id, .. }
            | Self::ExternalReference { id, .. }
            | Self::EmbeddedContent { id, .. }
            | Self::Recipe { id, .. }
            | Self::Canvas { id, .. }
            | Self::PixelBounds { id, .. }
            | Self::TransparentBounds { id, .. }
            | Self::Clipping { id, .. }
            | Self::VisiblePadding { id, .. }
            | Self::SmallSizeVisibility { id, .. }
            | Self::Baseline { id, .. } => id,
        }
    }
}

fn valid_target(target: &TargetSelector) -> bool {
    target.asset.as_ref().is_none_or(|value| valid_id(value))
        && target.family.as_ref().is_none_or(|value| valid_id(value))
        && target.role.as_ref().is_none_or(|value| valid_role(value))
        && target.variant.as_ref().is_none_or(|value| valid_id(value))
}
fn valid_background(value: &str) -> bool {
    value == "transparent"
        || (value.len() == 9
            && value.starts_with('#')
            && value[1..]
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'A'..=b'F').contains(&byte)))
        || value.strip_prefix("token:").is_some_and(valid_id)
}
fn valid_visual(sizes: &[(u16, u16)], backgrounds: &[String], target: &TargetSelector) -> bool {
    sizes.len() <= 32
        && sizes.iter().all(|(width, height)| {
            *width > 0 && *height > 0 && *width <= 16_384 && *height <= 16_384
        })
        && backgrounds.len() <= 16
        && backgrounds.iter().all(|value| valid_background(value))
        && valid_target(target)
}

impl Validate for QaProfilePage {
    fn validate(&self) -> StudioResult<()> {
        validate_page(self, |entry| entry.id.clone())?;
        for item in &self.page.items {
            if !valid_id(&item.id)
                || item.formats.len() > 3
                || item.case_count > 512
                || item.semantic_case_count + item.visual_case_count != item.case_count
                || item.baseline_case_count > item.visual_case_count
            {
                return invalid();
            }
            let _ = (&item.renderer, &item.qa_digest, &item.brand_system_digest);
        }
        Ok(())
    }
}

impl Validate for QaProfile {
    fn validate(&self) -> StudioResult<()> {
        if !valid_id(&self.profile.id)
            || self.profile.formats.len() > 3
            || self.profile.cases.len() > 512
            || self.cases.len() > 512
            || self.baselines.len() > 256
            || self.evaluation_count > 4_096
            || self.resolved_target_count > 65_536
        {
            return invalid();
        }
        ordered_unique(self.profile.cases.iter().cloned())?;
        ordered_unique(self.cases.iter().map(|entry| entry.id().to_owned()))?;
        ordered_unique(self.baselines.iter().map(|entry| entry.case_id.clone()))?;
        for case in &self.cases {
            if !valid_id(case.id()) {
                return invalid();
            }
            let valid = match case {
                QaCase::Inventory { family, roles, .. } => {
                    valid_id(family)
                        && roles.as_ref().is_none_or(|values| {
                            values.len() <= 64 && values.iter().all(|value| valid_role(value))
                        })
                }
                QaCase::Accessibility { target, .. }
                | QaCase::ExternalReference { target, .. }
                | QaCase::EmbeddedContent { target, .. }
                | QaCase::Canvas { target, .. } => valid_target(target),
                QaCase::Palette {
                    allowed_tokens,
                    target,
                    ..
                } => {
                    allowed_tokens.len() <= 256
                        && allowed_tokens.iter().all(|value| valid_id(value))
                        && valid_target(target)
                }
                QaCase::Recipe { recipe, family, .. } => {
                    recipe.as_ref().is_none_or(|value| valid_id(value))
                        && family.as_ref().is_none_or(|value| valid_id(value))
                }
                QaCase::PixelBounds {
                    sizes,
                    backgrounds,
                    target,
                    ..
                }
                | QaCase::TransparentBounds {
                    sizes,
                    backgrounds,
                    target,
                    ..
                }
                | QaCase::Clipping {
                    sizes,
                    backgrounds,
                    target,
                    ..
                } => valid_visual(sizes, backgrounds, target),
                QaCase::VisiblePadding {
                    sizes,
                    backgrounds,
                    minimum_padding_token,
                    minimum_padding_ratio,
                    target,
                    ..
                } => {
                    valid_visual(sizes, backgrounds, target)
                        && minimum_padding_token
                            .as_ref()
                            .is_none_or(|value| valid_id(value))
                        && minimum_padding_ratio.is_none_or(|value| value <= 1_000_000)
                }
                QaCase::SmallSizeVisibility {
                    sizes,
                    backgrounds,
                    minimum_visible_pixels,
                    minimum_visible_ratio,
                    target,
                    ..
                } => {
                    valid_visual(sizes, backgrounds, target)
                        && minimum_visible_pixels.is_none_or(|value| value <= 16_777_216)
                        && minimum_visible_ratio.is_none_or(|value| value <= 1_000_000)
                }
                QaCase::Baseline {
                    sizes,
                    backgrounds,
                    renderer_id,
                    renderer_version,
                    platform_claim,
                    target,
                    ..
                } => {
                    valid_visual(sizes, backgrounds, target)
                        && valid_text(renderer_id, 256)
                        && valid_text(renderer_version, 64)
                        && valid_text(platform_claim, 64)
                }
            };
            if !valid {
                return invalid();
            }
        }
        if self.baselines.iter().any(|entry| !valid_id(&entry.case_id)) {
            return invalid();
        }
        let _ = (
            &self.profile.renderer,
            &self.qa_digest,
            &self.brand_system_digest,
            self.raster.available,
        );
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct QaResult {
    schema: QaSchema,
    schema_version: u8,
    profile_id: String,
    qa_digest: Digest,
    brand_system_digest: Digest,
    status: QaStatus,
    exit_code: u8,
    counts: QaCounts,
    #[serde(skip_serializing_if = "Option::is_none")]
    renderer: Option<QaRenderer>,
    results: Vec<QaCaseResult>,
    result_digest: Digest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
enum QaSchema {
    #[serde(rename = "tfsb.brand-qa-result")]
    Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum QaStatus {
    Pass,
    Fail,
    Skipped,
    Unavailable,
    Error,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QaCounts {
    pass: u16,
    fail: u16,
    skipped: u16,
    unavailable: u16,
    error: u16,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QaRenderer {
    id: String,
    version: String,
    qualification_id: String,
    platform_claim: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QaCaseResult {
    case_id: String,
    kind: String,
    status: QaStatus,
    capability: QaCapability,
    capability_required: bool,
    measurements: BTreeMap<String, DomainValue>,
    diagnostics: Vec<QaDiagnostic>,
    evaluations: Vec<QaEvaluation>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum QaCapability {
    SemanticCoreV1,
    Renderer,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QaDiagnostic {
    code: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    location: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QaEvaluation {
    target: QaEvaluationTarget,
    #[serde(skip_serializing_if = "Option::is_none")]
    width: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    height: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    background: Option<String>,
    status: QaStatus,
    measurements: BTreeMap<String, DomainValue>,
    diagnostics: Vec<QaDiagnostic>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QaEvaluationTarget {
    asset_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    variant: Option<String>,
}

fn valid_diagnostics(values: &[QaDiagnostic]) -> bool {
    values.len() <= 4_096
        && values.iter().all(|entry| {
            valid_text(&entry.code, 256)
                && valid_text(&entry.message, 4_096)
                && entry
                    .location
                    .as_ref()
                    .is_none_or(|value| valid_text(value, 1_024))
        })
}
fn valid_measurements(values: &BTreeMap<String, DomainValue>) -> StudioResult<()> {
    if values.len() > 512 {
        return invalid();
    }
    values.values().try_for_each(|value| value.validate(0))
}

impl Validate for QaResult {
    fn validate(&self) -> StudioResult<()> {
        if self.schema_version != 1
            || !valid_id(&self.profile_id)
            || self.exit_code > 3
            || self.results.len() > 512
        {
            return invalid();
        }
        let total = u32::from(self.counts.pass)
            + u32::from(self.counts.fail)
            + u32::from(self.counts.skipped)
            + u32::from(self.counts.unavailable)
            + u32::from(self.counts.error);
        if total != self.results.len() as u32 {
            return invalid();
        }
        ordered_unique(self.results.iter().map(|entry| entry.case_id.clone()))?;
        for result in &self.results {
            if !valid_id(&result.case_id)
                || !valid_text(&result.kind, 64)
                || result.evaluations.len() > 4_096
                || !valid_diagnostics(&result.diagnostics)
            {
                return invalid();
            }
            valid_measurements(&result.measurements)?;
            for evaluation in &result.evaluations {
                if !valid_id(&evaluation.target.asset_id)
                    || evaluation
                        .target
                        .family
                        .as_ref()
                        .is_some_and(|value| !valid_id(value))
                    || !valid_diagnostics(&evaluation.diagnostics)
                {
                    return invalid();
                }
                if evaluation
                    .target
                    .role
                    .as_ref()
                    .is_some_and(|value| !valid_role(value))
                    || evaluation
                        .target
                        .variant
                        .as_ref()
                        .is_some_and(|value| !valid_id(value))
                    || evaluation
                        .background
                        .as_ref()
                        .is_some_and(|value| !valid_background(value))
                {
                    return invalid();
                }
                valid_measurements(&evaluation.measurements)?;
                let _ = (&evaluation.status, evaluation.width, evaluation.height);
            }
            let _ = (
                &result.status,
                &result.capability,
                result.capability_required,
            );
        }
        if self.renderer.as_ref().is_some_and(|entry| {
            !valid_text(&entry.id, 256)
                || !valid_text(&entry.version, 64)
                || !valid_text(&entry.qualification_id, 256)
                || !valid_text(&entry.platform_claim, 64)
        }) {
            return invalid();
        }
        let _ = (
            &self.schema,
            &self.qa_digest,
            &self.brand_system_digest,
            &self.status,
            &self.result_digest,
        );
        Ok(())
    }
}
