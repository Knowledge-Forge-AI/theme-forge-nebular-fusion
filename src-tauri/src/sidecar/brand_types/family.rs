use serde::{Deserialize, Serialize};

use super::common::{
    Page, Validate, invalid, ordered_unique, valid_id, valid_role, valid_text, validate_page,
};
use crate::errors::StudioResult;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BrandFamily {
    id: String,
    name: String,
    required_roles: Vec<String>,
    optional_roles: Vec<String>,
    variants: Vec<BrandVariant>,
    bindings: Vec<BrandBinding>,
    requirements: Vec<BrandRequirement>,
    complete: bool,
}

pub(crate) type FamilyPage = Page<BrandFamily>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrandVariant {
    family: String,
    id: String,
    backgrounds: Vec<Background>,
    color_mode: ColorMode,
    scale: Scale,
    status: VariantStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    minimum_width_px: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    minimum_height_px: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    display_order: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrandBinding {
    family: String,
    role: String,
    variant: String,
    asset: String,
    authority: Authority,
    #[serde(skip_serializing_if = "Option::is_none")]
    derived_state: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrandRequirement {
    family: String,
    role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    background: Option<Background>,
    #[serde(skip_serializing_if = "Option::is_none")]
    color_mode: Option<ColorMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    scale: Option<Scale>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Background {
    Any,
    Light,
    Dark,
    Transparent,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum ColorMode {
    FullColor,
    Monochrome,
    Reversed,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Scale {
    Standard,
    Simplified,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum VariantStatus {
    Primary,
    Secondary,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Authority {
    Source,
    Derived,
}

impl Validate for FamilyPage {
    fn validate(&self) -> StudioResult<()> {
        validate_page(self, |entry| entry.id.clone())?;
        for family in &self.page.items {
            if !valid_id(&family.id)
                || !valid_text(&family.name, 256)
                || family.required_roles.len() > 64
                || family.optional_roles.len() > 64
                || family.variants.len() > 256
                || family.bindings.len() > 1_024
                || family.requirements.len() > 256
                || family
                    .required_roles
                    .iter()
                    .chain(&family.optional_roles)
                    .any(|role| !valid_role(role))
            {
                return invalid();
            }
            ordered_unique(family.required_roles.iter().cloned())?;
            ordered_unique(family.optional_roles.iter().cloned())?;
            ordered_unique(family.variants.iter().map(|entry| entry.id.clone()))?;
            ordered_unique(
                family
                    .bindings
                    .iter()
                    .map(|entry| format!("{}\0{}\0{}", entry.role, entry.variant, entry.asset)),
            )?;
            if family.variants.iter().any(|entry| {
                entry.family != family.id
                    || !valid_id(&entry.id)
                    || entry.backgrounds.len() > 4
                    || entry.minimum_width_px == Some(0)
                    || entry.minimum_height_px == Some(0)
            }) || family.bindings.iter().any(|entry| {
                entry.family != family.id
                    || !valid_role(&entry.role)
                    || !valid_id(&entry.variant)
                    || !valid_id(&entry.asset)
                    || entry
                        .derived_state
                        .as_ref()
                        .is_some_and(|state| !valid_text(state, 64))
            }) || family
                .requirements
                .iter()
                .any(|entry| entry.family != family.id || !valid_role(&entry.role))
            {
                return invalid();
            }
            let _ = family.complete;
        }
        Ok(())
    }
}
