mod common;
mod consumer_export;
mod diff;
mod family;
mod plan_summaries;
mod qa;
mod raster_plan_descriptor;
mod status;
mod token_recipe;

use serde_json::value::Value as JsonNode;

pub(crate) use consumer_export::{
    ConsumerLockStatus, ConsumerProfilePage, ExportCapability, ExportStatusPage,
};
pub(crate) use diff::SemanticDiff;
pub(crate) use family::FamilyPage;
pub(crate) use plan_summaries::{BrandPlanMethod, StudioPlanSummary};
pub(crate) use qa::{QaProfile, QaProfilePage, QaResult};
pub(crate) use raster_plan_descriptor::{FrozenRasterPlanDescriptor, QUALIFIED_RASTER_PLAN};
pub(crate) use status::BrandStatus;
pub(crate) use token_recipe::{RecipeGraph, TokenPage};

use crate::errors::StudioResult;
use common::decode;

pub(crate) fn status(raw: JsonNode) -> StudioResult<BrandStatus> {
    decode(raw)
}
pub(crate) fn family_page(raw: JsonNode) -> StudioResult<FamilyPage> {
    decode(raw)
}
pub(crate) fn token_page(raw: JsonNode) -> StudioResult<TokenPage> {
    decode(raw)
}
pub(crate) fn recipe_graph(raw: JsonNode) -> StudioResult<RecipeGraph> {
    decode(raw)
}
pub(crate) fn qa_profile_page(raw: JsonNode) -> StudioResult<QaProfilePage> {
    decode(raw)
}
pub(crate) fn qa_profile(raw: JsonNode) -> StudioResult<QaProfile> {
    decode(raw)
}
pub(crate) fn qa_result(mut raw: JsonNode) -> StudioResult<QaResult> {
    strip_qa_private_fields(&mut raw);
    decode(raw)
}
pub(crate) fn semantic_diff(mut raw: JsonNode) -> StudioResult<SemanticDiff> {
    diff::expand_canonical_placeholder(&mut raw)?;
    decode(raw)
}
pub(crate) fn consumer_profile_page(raw: JsonNode) -> StudioResult<ConsumerProfilePage> {
    decode(raw)
}
pub(crate) fn consumer_lock_status(raw: JsonNode) -> StudioResult<ConsumerLockStatus> {
    decode(raw)
}
pub(crate) fn export_capability(raw: JsonNode) -> StudioResult<ExportCapability> {
    decode(raw)
}
pub(crate) fn export_status_page(raw: JsonNode) -> StudioResult<ExportStatusPage> {
    decode(raw)
}

fn strip_qa_private_fields(value: &mut JsonNode) {
    match value {
        JsonNode::Object(fields) => {
            fields.remove("baselinePath");
            fields.values_mut().for_each(strip_qa_private_fields);
        }
        JsonNode::Array(items) => items.iter_mut().for_each(strip_qa_private_fields),
        JsonNode::Null | JsonNode::Bool(_) | JsonNode::Number(_) | JsonNode::String(_) => {}
    }
}
