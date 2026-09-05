use serde::{Deserialize, Serialize};

use super::common::{
    Digest, Page, Validate, invalid, ordered_unique, valid_id, valid_text, validate_page,
};
use crate::errors::StudioResult;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum BrandToken {
    Color {
        id: String,
        value: String,
        reference_count: u16,
        recipe_use_count: u16,
        unused: bool,
    },
    Gradient {
        id: String,
        kind: GradientKind,
        units: GradientUnits,
        x1: i64,
        y1: i64,
        x2: i64,
        y2: i64,
        stops: Vec<GradientStop>,
        reference_count: u16,
        recipe_use_count: u16,
        unused: bool,
    },
    Dimension {
        id: String,
        unit: DimensionUnit,
        value: i64,
        reference_count: u16,
        recipe_use_count: u16,
        unused: bool,
    },
    Opacity {
        id: String,
        value: u32,
        reference_count: u16,
        recipe_use_count: u16,
        unused: bool,
    },
}

pub(crate) type TokenPage = Page<BrandToken>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GradientStop {
    offset: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    color_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum GradientKind {
    Linear,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum GradientUnits {
    ObjectBoundingBoxMillionth,
    UserSpace,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum DimensionUnit {
    Px,
    PercentMillionth,
    ViewboxMillionth,
}

impl BrandToken {
    fn id(&self) -> &str {
        match self {
            Self::Color { id, .. }
            | Self::Gradient { id, .. }
            | Self::Dimension { id, .. }
            | Self::Opacity { id, .. } => id,
        }
    }
    fn counts(&self) -> (u16, u16, bool) {
        match self {
            Self::Color {
                reference_count,
                recipe_use_count,
                unused,
                ..
            }
            | Self::Gradient {
                reference_count,
                recipe_use_count,
                unused,
                ..
            }
            | Self::Dimension {
                reference_count,
                recipe_use_count,
                unused,
                ..
            }
            | Self::Opacity {
                reference_count,
                recipe_use_count,
                unused,
                ..
            } => (*reference_count, *recipe_use_count, *unused),
        }
    }
}

fn color(value: &str) -> bool {
    value.len() == 9
        && value.starts_with('#')
        && value[1..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'A'..=b'F').contains(&byte))
}

impl Validate for TokenPage {
    fn validate(&self) -> StudioResult<()> {
        validate_page(self, |entry| entry.id().to_owned())?;
        for token in &self.page.items {
            let (references, recipes, unused) = token.counts();
            if !valid_id(token.id())
                || references > 1_024
                || recipes > 128
                || unused != (references == 0 && recipes == 0)
            {
                return invalid();
            }
            match token {
                BrandToken::Color { value, .. } if !color(value) => return invalid(),
                BrandToken::Gradient {
                    x1,
                    y1,
                    x2,
                    y2,
                    stops,
                    ..
                } => {
                    if [x1, y1, x2, y2]
                        .iter()
                        .any(|value| !(-16_384_000_000..=16_384_000_000).contains(*value))
                        || !(2..=16).contains(&stops.len())
                    {
                        return invalid();
                    }
                    for stop in stops {
                        if stop.offset > 1_000_000
                            || (stop.color_token.is_some() == stop.color.is_some())
                            || stop
                                .color_token
                                .as_ref()
                                .is_some_and(|value| !valid_id(value))
                            || stop.color.as_ref().is_some_and(|value| !color(value))
                        {
                            return invalid();
                        }
                    }
                }
                BrandToken::Dimension { value, .. }
                    if !(-16_384_000_000..=16_384_000_000).contains(value) =>
                {
                    return invalid();
                }
                BrandToken::Opacity { value, .. } if *value > 1_000_000 => return invalid(),
                BrandToken::Color { .. }
                | BrandToken::Dimension { .. }
                | BrandToken::Opacity { .. } => {}
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecipeGraph {
    recipe_digest: Digest,
    graph_digest: Digest,
    nodes: Vec<RecipeNode>,
    affected_target_count: u16,
    ownership_conflicts: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecipeNode {
    recipe_id: String,
    source_asset: String,
    target_asset: String,
    dependencies: Vec<String>,
    dependents: Vec<String>,
    operations: Vec<String>,
    operation_digest: Digest,
    depth: u8,
    receipt_digest: Option<Digest>,
    target_state: String,
}

impl Validate for RecipeGraph {
    fn validate(&self) -> StudioResult<()> {
        if self.nodes.len() > 128
            || self.affected_target_count > 128
            || self.ownership_conflicts > 128
        {
            return invalid();
        }
        ordered_unique(self.nodes.iter().map(|entry| entry.recipe_id.clone()))?;
        for node in &self.nodes {
            if !valid_id(&node.recipe_id)
                || !valid_id(&node.source_asset)
                || !valid_id(&node.target_asset)
                || node.dependencies.len() > 128
                || node.dependents.len() > 128
                || node.operations.len() > 16
                || node.depth > 8
                || !valid_text(&node.target_state, 64)
                || node
                    .dependencies
                    .iter()
                    .chain(&node.dependents)
                    .any(|value| !valid_id(value))
                || node.operations.iter().any(|value| !valid_text(value, 64))
            {
                return invalid();
            }
            ordered_unique(node.dependencies.iter().cloned())?;
            ordered_unique(node.dependents.iter().cloned())?;
            let _ = (&node.operation_digest, &node.receipt_digest);
        }
        let _ = (&self.recipe_digest, &self.graph_digest);
        Ok(())
    }
}
